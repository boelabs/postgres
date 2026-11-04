import crypto from "node:crypto";
import fs from "node:fs";

import { channels, active, start, finish, userName } from "./diagnostics.js";
import { Errors } from "./errors.js";
import * as p from "./protocol.js";
import { Socket, secured, secureOptions } from "./socket.js";

const noop = () => {
  // Stands in for a handler that has nothing left to do.
};

const R = 82;
const S = 83;
const K = 75;
const E = 69;
const N = 78;
const D = 68;
const Z = 90;

// A fresh signal for each call that is not given the pool's.
const unsignalled = () => ({ aborted: false, sockets: new Set() });

const fits = (want, { readOnly, standby }) =>
  want === "any" ||
  (want === "read-write" && !readOnly) ||
  (want === "read-only" && readOnly) ||
  (want === "primary" && !standby) ||
  (want === "standby" && standby);

const unbound = (reason) =>
  Errors.generic(
    "CHANNEL_BINDING_REQUIRED",
    `channel_binding is require, but ${reason}`
  );

const unsupported = (type) => {
  throw Errors.generic(
    "AUTH_TYPE_NOT_IMPLEMENTED",
    `Authentication type ${type} is not supported`
  );
};

const md5 = (x) => crypto.createHash("md5").update(x).digest("hex");

const hmac = (key, x) => crypto.createHmac("sha256", key).update(x).digest();

const sha256 = (x) => crypto.createHash("sha256").update(x).digest();

const xor = (a, b) => {
  const x = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i += 1) {
    x[i] = a[i] ^ b[i];
  }
  return x;
};

const negotiate = async (socket, options) => {
  if (!secured(options) || socket.negotiated) {
    return;
  }

  const { ssl } = options;
  const tls = secureOptions(options);

  if (options.sslnegotiation === "direct") {
    return socket.upgrade({ ...tls, ALPNProtocols: ["postgresql"] });
  }

  const { promise: answer, resolve } = Promise.withResolvers();
  socket.ondata = (x) => resolve(x[0]);
  socket.write(p.SSLRequest());

  if ((await answer) === S) {
    return socket.upgrade(tls);
  }

  if (ssl !== "prefer" && ssl !== "allow") {
    throw Errors.generic(
      "SSL_NOT_SUPPORTED",
      "The server does not support SSL connections"
    );
  }
};

const cancel = (options, host, port, { pid, secret }) => {
  const { setTimeout, clearTimeout } = options.timers;
  const { promise, resolve, reject } = Promise.withResolvers();

  let socket = null;
  let raw = null;
  let written = false;
  let settled = false;
  let timer;

  const conclude = (error) => {
    if (settled) {
      return;
    }

    settled = true;
    if (timer) {
      clearTimeout(timer);
    }
    if (socket) {
      socket.destroy();
    } else if (raw) {
      raw.destroy();
    }
    if (error) {
      reject(error);
    } else {
      resolve();
    }
  };

  const send = async (x) => {
    socket = x;
    if (settled) {
      return socket.destroy();
    }

    await negotiate(socket, options);
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the Socket of socket.js is no EventTarget: onclose is its one handler
    socket.onclose = () => conclude();
    written = true;
    socket.end(p.Cancel(pid, secret));
  };

  // As a Promise executor would, a synchronous throw rejects.
  try {
    const limit = options.cancel_timeout || options.connect_timeout;
    timer =
      limit &&
      setTimeout(
        () =>
          conclude(
            !written &&
              Errors.connection("CONNECT_TIMEOUT", options, host, port)
          ),
        limit * 1000
      );

    Socket(options, host, port, (x) => (raw = x))
      .then(send)
      .catch(conclude);
  } catch (error) {
    reject(error);
  }

  return promise;
};

const attempt = (options, host, port, signal) => {
  const { setTimeout, clearTimeout } = options.timers;
  const fail = (code) => Errors.connection(code, options, host, port);
  const { promise, resolve, reject } = Promise.withResolvers();

  let timer;
  let socket = null;
  let raw = null;
  let settled = false;

  const conclude = (failed, error, ready) => {
    if (settled) {
      return;
    }

    settled = true;
    if (timer) {
      clearTimeout(timer);
    }
    if (socket) {
      signal.sockets.delete(socket);
    }
    let lost = failed;
    let reason = error;
    if (signal.aborted && !failed) {
      lost = true;
      reason = fail("CONNECTION_DESTROYED");
    }

    if (lost) {
      if (socket) {
        socket.destroy();
      } else if (raw) {
        raw.destroy();
      }
      return reject(reason);
    }

    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the Socket of socket.js is no EventTarget: onclose is its one handler
    ready.socket.onclose = noop;
    resolve(ready);
  };

  const closed = (error) => {
    if (signal.aborted) {
      return fail("CONNECTION_DESTROYED");
    }
    if (error && error.code) {
      return error;
    }
    return fail("CONNECTION_CLOSED");
  };

  const startup = (user, database) => {
    const handshake = Promise.withResolvers();

    // As a Promise executor would, a synchronous throw rejects.
    try {
      const abort = (error) => {
        handshake.reject(error);
        socket.destroy();
      };

      const stored = () =>
        pgpass(
          options.passfile,
          options.path ? "localhost" : host,
          port,
          database,
          user
        ) || "";
      const auth = Auth({
        binding: options.channel_binding,
        pass: options.pass || stored,
        socket,
        user,
      });
      const parameters = {};
      const backend = { pid: null, secret: null };
      const rows = [];

      let probing = false;
      let status = null;
      let authing = Promise.resolve();

      const notice = (x) => {
        try {
          if (options.onnotice) {
            options.onnotice(x);
          } else if (options.onnotice !== false) {
            console.log(x);
          }
        } catch (error) {
          noop(error);
        }
      };

      const authenticate = (x) => {
        authing = authing
          .then(() => auth(x))
          .then((reply) => reply && socket.write(reply));
        authing.catch(abort);
      };

      const ready = (x, rest) => {
        if (!auth.authenticated) {
          return handshake.reject(
            Errors.generic(
              "AUTHENTICATION_INCOMPLETE",
              "The server was ready before it accepted the authentication"
            )
          );
        }

        status = x;
        const known =
          "in_hot_standby" in parameters &&
          "default_transaction_read_only" in parameters;

        if (options.target_session_attrs && !known && !probing) {
          probing = true;
          return socket.write(
            p.Query(
              "show transaction_read_only; select pg_catalog.pg_is_in_recovery()"
            )
          );
        }

        frames.pause();
        socket.ondata = noop;
        socket.pause();
        handshake.resolve({
          attributes: {
            readOnly:
              (known ? parameters.default_transaction_read_only : rows[0]) ===
              "on",
            standby: known
              ? parameters.in_hot_standby === "on"
              : rows[1] === "t",
          },
          backend,
          cancel: () => cancel(options, host, port, backend),
          host,
          parameters,
          port,
          rest,
          socket,
          status,
        });
      };

      // authing is a chain of native promises, so awaiting it resumes on the tick then() would.
      const afterAuth = async (x, rest) => {
        try {
          await authing;
        } catch {
          return;
        }
        ready(x, rest);
      };

      const frame = (type, x, at, end) => {
        try {
          if (type === R) {
            authenticate(Buffer.from(x.subarray(at, end)));
          } else if (type === S) {
            const [k, v] = p.parameterStatus(x, at);
            parameters[k] = v;
          } else if (type === K) {
            Object.assign(backend, p.backendKeyData(x, at));
          } else if (type === E) {
            handshake.reject(Errors.postgres(p.error(x, at, end)));
          } else if (type === N) {
            notice(p.error(x, at, end));
          } else if (type === D) {
            rows.push(
              x.toString("utf-8", at + 11, at + 11 + x.readInt32BE(at + 7))
            );
          } else if (type === Z) {
            afterAuth(p.readyForQuery(x, at), Buffer.from(x.subarray(end)));
          }
        } catch (error) {
          handshake.reject(error);
        }
      };

      const frames = p.Frames(frame, false, abort);

      socket.ondata = (x) => frames.push(x);
      socket.write(
        // oxlint-disable-next-line sort-keys -- the startup packet sends its parameters in this order
        p.Startup({
          user,
          database,
          client_encoding: "utf-8",
          ...options.connection,
        })
      );
    } catch (error) {
      handshake.reject(error);
    }

    return handshake.promise;
  };

  const session = async () => {
    socket = await Socket(options, host, port, (x) => (raw = x));
    if (settled || signal.aborted) {
      socket.destroy();
      return conclude(true, fail("CONNECTION_DESTROYED"));
    }

    signal.sockets.add(socket);
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the Socket of socket.js is no EventTarget: onclose is its one handler
    socket.onclose = (error) => conclude(true, closed(error));
    socket.keepAlive(options.keep_alive);
    await negotiate(socket, options);
    const user =
      typeof options.user === "function" ? await options.user() : options.user;
    return startup(user, options.database || user);
  };

  const accept = (ready) => conclude(false, null, ready);
  const refuse = (error) => conclude(true, error);

  // As a Promise executor would, a synchronous throw rejects.
  try {
    timer =
      options.connect_timeout &&
      setTimeout(
        () => conclude(true, fail("CONNECT_TIMEOUT")),
        options.connect_timeout * 1000
      );

    session().then(accept, refuse);
  } catch (error) {
    reject(error);
  }

  return promise;
};

const traced = (options, host, port, signal) => {
  if (!active(channels.connect)) {
    return attempt(options, host, port, signal);
  }

  // oxlint-disable-next-line sort-keys -- tracers see this context, with its keys in the documented order
  const context = {
    host: options.path ? null : host,
    port: options.path ? null : port,
    path: options.path || null,
    database: options.database,
    user: userName(options),
    ssl: secured(options),
    sslnegotiation: options.sslnegotiation || "postgres",
  };
  let promise;
  start(
    channels.connect,
    context,
    () => (promise = attempt(options, host, port, signal))
  );

  return promise.then(
    (ready) => {
      // oxlint-disable-next-line sort-keys -- tracers see this result, with its keys in the documented order
      finish(channels.connect, context, null, {
        pid: ready.backend.pid,
        status: ready.status,
        readOnly: ready.attributes.readOnly,
        standby: ready.attributes.standby,
      });
      return ready;
    },
    (error) => {
      finish(channels.connect, context, error);
      throw error;
    }
  );
};

export const open = async (options, signal = unsignalled(), first = 0) => {
  const hosts = options.path ? [null] : options.host;
  const wanted = options.target_session_attrs;
  const passes =
    wanted === "prefer-standby" ? ["standby", "any"] : [wanted || "any"];

  let last;

  for (const want of passes) {
    for (let n = 0; n < hosts.length; n += 1) {
      const i = (first + n) % hosts.length;
      const host = hosts[i];
      const port = options.port[i] || options.port[0];
      const [failed, error, ready] = await traced(
        options,
        host,
        port,
        signal
      ).then(
        (x) => [false, null, x],
        (attemptError) => [true, attemptError]
      );
      if (!failed && fits(want, ready.attributes)) {
        ready.index = i;
        return ready;
      }
      if (!failed) {
        ready.socket.end(p.Terminate());
      }
      last = failed
        ? error
        : Errors.connection("CONNECTION_DESTROYED", options, host, port);
      if (signal.aborted) {
        throw last;
      }
    }
  }

  throw last;
};

const salted = new Map();

const Auth = ({ user, pass, binding = "prefer", socket }) => {
  let nonce;
  let serverSignature;
  let verified = true;
  let bound = false;
  let header = "n,,";

  const password = () =>
    Promise.resolve(typeof pass === "function" ? pass() : pass);

  const ok = () => {
    if (!verified) {
      throw Errors.generic(
        "SASL_SIGNATURE_MISMATCH",
        "The server ended SCRAM authentication without proving it knows the password"
      );
    }

    if (binding === "require" && !bound) {
      throw unbound("the server authenticated without it");
    }

    respond.authenticated = true;
    return null;
  };

  const begin = (x) => {
    const offered = x.toString("utf-8", 9).split("\0");
    const certificate =
      binding !== "disable" &&
      socket &&
      socket.certificate &&
      socket.certificate();
    const hash = certificate && endpoint(certificate);
    const plus = !!hash && offered.includes("SCRAM-SHA-256-PLUS");

    if (binding === "require" && !plus) {
      throw unbound(
        offered.includes("SCRAM-SHA-256-PLUS")
          ? "the server certificate could not be hashed for it"
          : "the server did not offer it"
      );
    }

    if (!plus && !offered.includes("SCRAM-SHA-256")) {
      throw Errors.generic(
        "SASL_MECHANISM_NOT_SUPPORTED",
        "The server offered no supported SASL mechanism"
      );
    }

    if (plus) {
      header = "p=tls-server-end-point,,";
    } else if (hash) {
      header = "y,,";
    } else {
      header = "n,,";
    }
    bound = plus ? hash : false;
    nonce = crypto.randomBytes(18).toString("base64");
    verified = false;
    return p.SASL(
      plus ? "SCRAM-SHA-256-PLUS" : "SCRAM-SHA-256",
      `${header}n=*,r=${nonce}`
    );
  };

  const proceed = (x, secret) => {
    const res = {};
    for (const field of x.toString("utf-8", 9).split(",")) {
      res[field[0]] = field.slice(2);
    }
    const key = sha256(`${secret}\0${res.s}\0${res.i}`).toString("base64");

    if (!res.r.startsWith(nonce)) {
      throw Errors.generic(
        "SASL_NONCE_MISMATCH",
        "The server nonce does not start with the client nonce"
      );
    }

    if (!salted.has(key)) {
      if (salted.size >= 64) {
        salted.delete(salted.keys().next().value);
      }
      salted.set(
        key,
        crypto.pbkdf2Sync(
          secret,
          Buffer.from(res.s, "base64"),
          +res.i,
          32,
          "sha256"
        )
      );
    }

    const saltedPassword = salted.get(key);
    const clientKey = hmac(saltedPassword, "Client Key");
    const channel = (
      bound ? Buffer.concat([Buffer.from(header), bound]) : Buffer.from(header)
    ).toString("base64");
    const auth = `n=*,r=${nonce},r=${res.r},s=${res.s},i=${res.i},c=${channel},r=${
      res.r
    }`;

    serverSignature = hmac(hmac(saltedPassword, "Server Key"), auth).toString(
      "base64"
    );
    return p.SASLResponse(
      `c=${channel},r=${res.r},p=${xor(
        clientKey,
        hmac(sha256(clientKey), auth)
      ).toString("base64")}`
    );
  };

  const complete = (x) => {
    if (
      !serverSignature ||
      x.toString("utf-8", 9).split("\0", 1)[0].slice(2) !== serverSignature
    ) {
      throw Errors.generic(
        "SASL_SIGNATURE_MISMATCH",
        "The server did not return the correct signature"
      );
    }

    verified = true;
    return null;
  };

  const respond = async (x) => {
    const type = x.readInt32BE(5);
    if ((type === 3 || type === 5) && binding === "require") {
      throw unbound(
        `the server asked for ${type === 3 ? "a cleartext" : "an MD5"} password`
      );
    }

    if (type === 0) {
      return ok();
    }
    if (type === 3) {
      return p.Password(await password());
    }
    if (type === 5) {
      return p.Password(
        `md5${md5(
          Buffer.concat([
            Buffer.from(md5((await password()) + user)),
            x.subarray(9, 13),
          ])
        )}`
      );
    }
    if (type === 10) {
      return begin(x);
    }
    if (type === 11) {
      return proceed(x, await password());
    }
    if (type === 12) {
      return complete(x);
    }
    return unsupported(type);
  };

  respond.authenticated = false;
  return respond;
};

const signatures = {
  "2a864886f70d010104": "sha256",
  "2a864886f70d010105": "sha256",
  "2a864886f70d01010b": "sha256",
  "2a864886f70d01010c": "sha384",
  "2a864886f70d01010d": "sha512",
  "2a864886f70d01010e": "sha224",
  "2a8648ce380403": "sha256",
  "2a8648ce3d0401": "sha256",
  "2a8648ce3d040301": "sha224",
  "2a8648ce3d040302": "sha256",
  "2a8648ce3d040303": "sha384",
  "2a8648ce3d040304": "sha512",
  "608648016503040302": "sha256",
};

const digests = {
  "2b0e03021a": "sha256",
  "608648016503040201": "sha256",
  "608648016503040202": "sha384",
  "608648016503040203": "sha512",
  "608648016503040204": "sha224",
};

const der = (x, at) => {
  let length = x[at + 1];
  let body = at + 2;

  if (length & 0x80) {
    const n = length & 0x7f;
    length = 0;
    for (let i = 0; i < n; i += 1) {
      length = length * 256 + x[body + i];
    }
    body += n;
  }

  if (body + length > x.length) {
    throw new Error("Truncated certificate");
  }

  return { body, end: body + length, start: at };
};

const signature = (x) => {
  const certificate = der(x, 0);
  const tbs = der(x, certificate.body);
  const algorithm = der(x, tbs.end);
  const oid = der(x, algorithm.body);
  const name = x[oid.start] === 0x06 && x.toString("hex", oid.body, oid.end);

  if (name !== "2a864886f70d01010a") {
    return signatures[name];
  }

  if (oid.end >= algorithm.end) {
    return "sha256";
  }

  const params = der(x, oid.end);
  const first = params.body < params.end && der(x, params.body);

  if (!first || x[first.start] !== 0xa0) {
    return "sha256";
  }

  const hash = der(x, der(x, first.body).body);
  return digests[x.toString("hex", hash.body, hash.end)];
};

const endpoint = (certificate) => {
  try {
    const x = Buffer.from(certificate);
    const algorithm = signature(x);
    return algorithm ? crypto.createHash(algorithm).update(x).digest() : null;
  } catch {
    return null;
  }
};

const split = (line) => {
  const fields = [];
  let field = "";
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) {
      i += 1;
      field += line[i];
    } else if (c === ":" && fields.length < 4) {
      fields.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  fields.push(field);
  return fields;
};

const pgpass = (file, host, port, database, user) => {
  if (!file) {
    return null;
  }

  let text;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || (process.platform !== "win32" && stat.mode & 0o077)) {
      return null;
    }
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const wanted = [host, String(port), database, user];
  for (const line of text.split(/\r?\n/u)) {
    const fields = line && line[0] !== "#" ? split(line) : [];
    if (
      fields.length === 5 &&
      wanted.every((x, i) => fields[i] === "*" || fields[i] === x)
    ) {
      return fields[4];
    }
  }
  return null;
};
