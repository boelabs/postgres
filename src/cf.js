import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";

import { connect } from "cloudflare:sockets";

import { Errors } from "./errors.js";
import postgres from "./index.js";
import { secured, direct } from "./socket.js";

export { PostgresError } from "./index.js";

export default function Postgres(a, b) {
  return typeof a === "string" || !a
    ? postgres(a, { socket, ...b })
    : postgres({ socket, ...a });
}

Object.assign(Postgres, postgres);

export const socket = async (options, host, port) => {
  if (direct(options)) {
    throw Errors.generic(
      "SSL_NEGOTIATION_NOT_SUPPORTED",
      "sslnegotiation: direct needs ALPN, which Cloudflare Workers sockets do not offer"
    );
  }

  const tls = secured(options);
  let raw = connect(
    { hostname: host, port },
    { allowHalfOpen: false, secureTransport: tls ? "starttls" : "off" }
  );
  await raw.opened;

  let secure = false;
  if (tls) {
    const writer = raw.writable.getWriter();
    const reader = raw.readable.getReader();
    await writer.write(sslRequest);
    const { value, done } = await reader.read();
    writer.releaseLock();
    reader.releaseLock();

    if (done) {
      throw Errors.connection("CONNECTION_CLOSED", options, host, port);
    }

    if (value[0] === 83) {
      raw = raw.startTls();
      await raw.opened;
      secure = true;
    } else if (options.ssl !== "prefer" && options.ssl !== "allow") {
      raw.close();
      throw Errors.generic(
        "SSL_NOT_SUPPORTED",
        "The server does not support SSL connections"
      );
    }
  }

  return Stream(raw, secure, host, port);
};

const sslRequest = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
const chunk = 16_384;

const Stream = (raw, secure, host, port) => {
  // oxlint-disable-next-line unicorn/prefer-event-target -- the connection drives this like a node:net socket, with on() and emit()
  const x = new EventEmitter();
  const writer = raw.writable.getWriter();
  const reader = raw.readable.getReader();

  let paused = false;
  let wake = null;
  let closed = false;
  let pending = 0;
  let answered = !secure;

  const written = () => {
    pending -= 1;
    if (pending === 0) {
      x.emit("drain");
    }
  };

  Object.assign(x, {
    destroy() {
      x.destroyed = true;
      raw.close().catch(() => {
        // Ignored on purpose: the socket is being destroyed.
      });
      finish();
    },
    destroyed: false,
    end(data) {
      if (data) {
        x.write(data);
      }
      writer.close().catch(() => {
        // Ignored on purpose: the read loop reports a stream that failed.
      });
    },
    negotiated: true,
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      if (wake) {
        wake();
        wake = null;
      }
    },
    secure,
    setKeepAlive() {
      // Workers sockets have no keep alive setting; the connection calls this as on node:net.
    },
    setNoDelay() {
      // Workers sockets have no Nagle setting; the connection calls this as on node:net.
    },
    write(data) {
      if (closed) {
        return false;
      }

      for (let i = 0; i < data.length; i += chunk) {
        pending += 1;
        // oxlint-disable-next-line promise/prefer-catch, promise/catch-or-return -- fail must run on the same tick as the rejection and must not catch a throw from a drain listener
        writer.write(data.subarray(i, i + chunk)).then(written, fail);
      }
      return pending < 16;
    },
  });

  const resumed = () => {
    const { promise, resolve } = Promise.withResolvers();
    wake = resolve;
    return promise;
  };

  const read = async () => {
    try {
      while (true) {
        if (paused) {
          // oxlint-disable-next-line no-await-in-loop -- reads are sequential: the next read waits for resume()
          await resumed();
        }
        // oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk after another
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        answered = true;
        x.emit(
          "data",
          Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        );
      }
    } catch (error) {
      if (!closed) {
        x.emit("error", handshake(error));
      }
    }
    finish();
  };

  const fail = (error) => {
    if (!closed) {
      x.emit("error", handshake(error));
    }
    x.destroy();
  };

  const finish = () => {
    if (closed) {
      return;
    }

    if (!answered && !x.destroyed) {
      x.emit("error", handshake());
    }
    closed = true;
    x.emit("close");
  };

  const handshake = (error) => {
    if (answered) {
      return error;
    }

    answered = true;

    return Object.assign(
      Errors.generic(
        "TLS_HANDSHAKE_FAILED",
        `The TLS connection to ${host}:${
          port
        } was lost before the server answered. ` +
          `Workers could not complete the TLS handshake, most often because the server certificate is not trusted by a public CA`
      ),
      { cause: error }
    );
  };

  read();
  return x;
};
