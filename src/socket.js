import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";

const noop = () => {},
  agent = (globalThis.navigator && globalThis.navigator.userAgent) || "",
  workers = agent.startsWith("Cloudflare-Workers"),
  onreadSafe =
    !agent ||
    agent.startsWith("Node.js") ||
    agent.startsWith("Bun") ||
    agent.startsWith("Deno"),
  node = !agent || agent.startsWith("Node.js"),
  contexts = new WeakMap(),
  modes = new WeakMap();

export async function Socket(options, host, port, track = noop) {
  const raw = options.socket
    ? await options.socket(options, host, port)
    : await connect(options, host, port, track);

  return wrap(raw, host);
}

// The options for tls.connect: an ssl object as it is, or those of a libpq sslmode with the
// sslrootcert, sslcert and sslkey files, read on the first connection and kept for the pool.
export function secureOptions(options) {
  const ssl = options.ssl;
  if (ssl && typeof ssl === "object") {
    return context(ssl);
  }

  let x = modes.get(options);
  x || modes.set(options, (x = mode(options)));
  return context(x);
}

function mode({ ssl, sslrootcert, sslcert, sslkey, sslpassword }) {
  const system = sslrootcert === "system",
    ca =
      sslrootcert && !system
        ? fs.readFileSync(sslrootcert)
        : system
          ? systemCertificates()
          : null,
    x = {};

  ca && (x.ca = ca);
  sslcert && (x.cert = fs.readFileSync(sslcert));
  sslkey && (x.key = fs.readFileSync(sslkey));
  sslpassword && (x.passphrase = sslpassword);

  if (workers) {
    return x;
  }

  // As in libpq: require checks the certificate authority only when sslrootcert names one.
  const verify =
    ssl === "verify-full" ||
    ssl === true ||
    ssl === "verify-ca" ||
    (ssl === "require" && !!x.ca);
  verify || (x.rejectUnauthorized = false);
  verify &&
    ssl !== "verify-full" &&
    ssl !== true &&
    (x.checkServerIdentity = noop);
  return x;
}

// sslrootcert=system: the certificate authorities of the operating system, as well as the ones the
// runtime trusts by default, where the runtime can list them (Node.js 22.15 and later).
function systemCertificates() {
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
}

function context(ssl) {
  if (!node || ssl.secureContext || !ssl.ca) {
    return ssl;
  }

  const values = { ...ssl };
  let last = contexts.get(ssl);
  (last && same(values, last.values)) ||
    contexts.set(
      ssl,
      (last = { values, secureContext: tls.createSecureContext(values) })
    );
  return { ...values, secureContext: last.secureContext };
}

function same(a, b) {
  return [...Object.keys(a), ...Object.keys(b)].every((k) => a[k] === b[k]);
}

// TLS over a Unix socket is never asked for, whatever ssl says, as in libpq.
export const secured = (options) =>
  !!options.ssl && options.ssl !== "disable" && !options.path;

export const direct = (options) =>
  secured(options) && options.sslnegotiation === "direct";

function connect(options, host, port, track) {
  return new Promise((resolve, reject) => {
    const tlsNow = direct(options),
      plain = !secured(options),
      reads = (plain || tlsNow) &&
        onreadSafe &&
        options.onread !== false && {
          buffer: Buffer.allocUnsafe(65_536),
          callback: (n, b) => socket.ondata(b.subarray(0, n)),
        },
      target = options.path ? { path: options.path } : { port, host },
      socket = tlsNow
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
  });
}

function wrap(socket, host) {
  let closed = false,
    failure = null;

  socket.shared && (socket.ondata = data);

  const x = {
    ondata: noop,
    ondrain: noop,
    onclose: noop,
    get raw() {
      return socket;
    },
    get closed() {
      return closed;
    },
    get shared() {
      return !!socket.shared;
    },
    get negotiated() {
      return !!socket.secure || !!socket.negotiated;
    },
    certificate() {
      const x =
        typeof socket.getPeerCertificate === "function" &&
        socket.getPeerCertificate();
      return (x && x.raw) || null;
    },
    write: (data) => !closed && socket.write(data),
    upgrade,
    pause: () => socket.pause(),
    resume: () => socket.resume(),
    ref: () => socket.ref && socket.ref(),
    unref: () => socket.unref && socket.unref(),
    end(data) {
      closed || (data ? socket.end(data) : socket.end());
    },
    destroy(error) {
      error && !failure && (failure = error);
      socket.destroy();
    },
    keepAlive(seconds) {
      seconds &&
        socket.setKeepAlive &&
        socket.setKeepAlive(true, 1000 * seconds);
    },
  };

  listen();
  return x;

  function listen() {
    socket.on("data", data);
    socket.on("drain", drain);
    socket.on("error", error);
    socket.on("close", close);
  }

  function unlisten() {
    socket.off("data", data);
    socket.off("drain", drain);
    socket.off("error", error);
    socket.off("close", close);
  }

  function data(buffer) {
    x.ondata(buffer);
  }
  function drain() {
    x.ondrain();
  }
  function error(err) {
    failure ||= err;
    socket.destroy();
    close();
  }

  function close() {
    if (closed) {
      return;
    }

    closed = true;
    x.onclose(failure);
  }

  function upgrade(options = {}) {
    return new Promise((resolve, reject) => {
      unlisten();
      // host as well as servername: without it Node checks the certificate of a server reached by
      // its IP address against 'localhost' instead of that address.
      const secure = tls.connect({
        socket,
        host,
        servername: net.isIP(host || "") ? undefined : host,
        ...options,
      });
      const fail = (err) => {
        secure.off("secureConnect", ready);
        reject(err);
      };
      function ready() {
        secure.off("error", fail);
        socket = secure;
        listen();
        resolve(x);
      }
      secure.once("secureConnect", ready);
      secure.once("error", fail);
    });
  }
}
