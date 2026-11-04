import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";

const noop = () => {
  // Does nothing: the default callback, and checkServerIdentity when the host is not checked.
};
const agent = (globalThis.navigator && globalThis.navigator.userAgent) || "";
const workers = agent.startsWith("Cloudflare-Workers");
const onreadSafe =
  !agent ||
  agent.startsWith("Node.js") ||
  agent.startsWith("Bun") ||
  agent.startsWith("Deno");
const node = !agent || agent.startsWith("Node.js");
const contexts = new WeakMap();
const modes = new WeakMap();

export const Socket = async (options, host, port, track = noop) => {
  const raw = options.socket
    ? await options.socket(options, host, port)
    : await connect(options, host, port, track);

  return wrap(raw, host);
};

// The options for tls.connect: an ssl object as it is, or those of a libpq sslmode with the
// sslrootcert, sslcert and sslkey files, read on the first connection and kept for the pool.
export const secureOptions = (options) => {
  const { ssl } = options;
  if (ssl && typeof ssl === "object") {
    return context(ssl);
  }

  let x = modes.get(options);
  if (!x) {
    x = mode(options);
    modes.set(options, x);
  }
  return context(x);
};

const mode = ({ ssl, sslrootcert, sslcert, sslkey, sslpassword }) => {
  const system = sslrootcert === "system";
  let ca = null;
  if (sslrootcert && !system) {
    ca = fs.readFileSync(sslrootcert);
  } else if (system) {
    ca = systemCertificates();
  }
  const x = {};

  if (ca) {
    x.ca = ca;
  }
  if (sslcert) {
    x.cert = fs.readFileSync(sslcert);
  }
  if (sslkey) {
    x.key = fs.readFileSync(sslkey);
  }
  if (sslpassword) {
    x.passphrase = sslpassword;
  }

  if (workers) {
    return x;
  }

  // As in libpq: require checks the certificate authority only when sslrootcert names one.
  const verify =
    ssl === "verify-full" ||
    ssl === true ||
    ssl === "verify-ca" ||
    (ssl === "require" && !!x.ca);
  if (!verify) {
    x.rejectUnauthorized = false;
  }
  if (verify && ssl !== "verify-full" && ssl !== true) {
    x.checkServerIdentity = noop;
  }
  return x;
};

// sslrootcert=system: the certificate authorities of the operating system, as well as the ones the
// runtime trusts by default, where the runtime can list them (Node.js 22.15 and later).
const systemCertificates = () => {
  try {
    return typeof tls.getCACertificates === "function"
      ? [
          ...new Set([
            ...tls.getCACertificates("default"),
            ...tls.getCACertificates("system"),
          ]),
        ]
      : null;
  } catch {
    return null;
  }
};

const context = (ssl) => {
  if (!node || ssl.secureContext || !ssl.ca) {
    return ssl;
  }

  const values = { ...ssl };
  let last = contexts.get(ssl);
  if (!last || !same(values, last.values)) {
    last = { secureContext: tls.createSecureContext(values), values };
    contexts.set(ssl, last);
  }
  return { ...values, secureContext: last.secureContext };
};

const same = (a, b) =>
  [...Object.keys(a), ...Object.keys(b)].every((k) => a[k] === b[k]);

// TLS over a Unix socket is never asked for, whatever ssl says, as in libpq.
export const secured = (options) =>
  !!options.ssl && options.ssl !== "disable" && !options.path;

export const direct = (options) =>
  secured(options) && options.sslnegotiation === "direct";

const connect = (options, host, port, track) => {
  const { promise, resolve, reject } = Promise.withResolvers();
  // As in a Promise executor, a synchronous throw (a missing sslrootcert file, say) rejects.
  try {
    const tlsNow = direct(options);
    const plain = !secured(options);
    const reads = (plain || tlsNow) &&
      onreadSafe &&
      options.onread !== false && {
        buffer: Buffer.allocUnsafe(65_536),
        callback: (n, b) => socket.ondata(b.subarray(0, n)),
      };
    const target = options.path ? { path: options.path } : { host, port };
    const socket = tlsNow
      ? tls.connect({
          ...target,
          servername: net.isIP(host || "") || options.path ? undefined : host,
          ...secureOptions(options),
          ALPNProtocols: ["postgresql"],
          ...(reads ? { onread: reads } : {}),
        })
      : net.connect({ ...target, ...(reads ? { onread: reads } : {}) });
    track(socket);
    socket.shared = !!reads;
    socket.secure = tlsNow;
    socket.ondata = noop;
    socket.once("error", reject);
    socket.once(tlsNow ? "secureConnect" : "connect", () => {
      socket.off("error", reject);
      socket.setNoDelay(true);
      resolve(socket);
    });
  } catch (error) {
    reject(error);
  }
  return promise;
};

const wrap = (raw, host) => {
  // upgrade() swaps in the TLS socket that wraps this one.
  let socket = raw;
  let closed = false;
  let failure = null;

  const listen = () => {
    socket.on("data", data);
    socket.on("drain", drain);
    socket.on("error", error);
    socket.on("close", close);
  };

  const unlisten = () => {
    socket.off("data", data);
    socket.off("drain", drain);
    socket.off("error", error);
    socket.off("close", close);
  };

  const data = (buffer) => {
    x.ondata(buffer);
  };
  const drain = () => {
    x.ondrain();
  };
  const error = (err) => {
    failure ||= err;
    socket.destroy();
    close();
  };

  const close = () => {
    if (closed) {
      return;
    }

    closed = true;
    x.onclose(failure);
  };

  const upgrade = (options = {}) => {
    const { promise, resolve, reject } = Promise.withResolvers();
    // As in a Promise executor, a synchronous throw from tls.connect rejects.
    try {
      unlisten();
      // host as well as servername: without it Node checks the certificate of a server reached by
      // its IP address against 'localhost' instead of that address.
      const secure = tls.connect({
        host,
        servername: net.isIP(host || "") ? undefined : host,
        socket,
        ...options,
      });
      const fail = (err) => {
        secure.off("secureConnect", ready);
        reject(err);
      };
      const ready = () => {
        secure.off("error", fail);
        socket = secure;
        listen();
        resolve(x);
      };
      secure.once("secureConnect", ready);
      secure.once("error", fail);
    } catch (tlsError) {
      reject(tlsError);
    }
    return promise;
  };

  if (socket.shared) {
    socket.ondata = data;
  }

  const x = {
    certificate() {
      const cert =
        typeof socket.getPeerCertificate === "function" &&
        socket.getPeerCertificate();
      return (cert && cert.raw) || null;
    },
    get closed() {
      return closed;
    },
    destroy(reason) {
      if (reason && !failure) {
        failure = reason;
      }
      socket.destroy();
    },
    end(chunk) {
      if (!closed) {
        if (chunk) {
          socket.end(chunk);
        } else {
          socket.end();
        }
      }
    },
    keepAlive(seconds) {
      if (seconds && socket.setKeepAlive) {
        socket.setKeepAlive(true, 1000 * seconds);
      }
    },
    get negotiated() {
      return !!socket.secure || !!socket.negotiated;
    },
    onclose: noop,
    ondata: noop,
    ondrain: noop,
    pause: () => socket.pause(),
    get raw() {
      return socket;
    },
    ref: () => socket.ref && socket.ref(),
    resume: () => socket.resume(),
    get shared() {
      return !!socket.shared;
    },
    unref: () => socket.unref && socket.unref(),
    upgrade,
    write: (chunk) => !closed && socket.write(chunk),
  };

  listen();
  return x;
};
