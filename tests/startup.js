import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { Query, Frames } from "../src/protocol.js";
import { open } from "../src/startup.js";
import { postgres, login, login_md5, login_scram, delay } from "./setup.js";
import { t } from "./test.js";

const base = {
  connect_timeout: 3,
  database: "postgres_js_test",
  host: ["localhost"],
  port: [5432],
  timers: { clearTimeout, setTimeout },
  ...login,
};

const session = async (options) => {
  const ready = await open({ ...base, ...options });
  ready.socket.end();
  return ready;
};

const server = (fn) => {
  const listening = Promise.withResolvers();
  const x = net
    .createServer(fn)
    .listen(0, "localhost", () => listening.resolve(x));
  return listening.promise;
};

const ignore = () => {
  // A fake server leaves a connection unanswered, or a socket error to the client under test.
};

t("Startup reaches ReadyForQuery", async () => {
  const { status, backend, parameters, rest } = await session();
  return [
    "I,true,UTF8,0",
    [status, backend.pid > 0, parameters.client_encoding, rest.length].join(
      ","
    ),
  ];
});

t("Startup with md5", async () => {
  const { status } = await session(login_md5);
  return ["I", status];
});

t("Startup with SCRAM", async () => {
  const { status } = await session(login_scram);
  return ["I", status];
});

t("Startup with a wrong SCRAM password", async () => [
  "28P01",
  await session({ ...login_scram, pass: "nope" }).catch((error) => error.code),
]);

t("Startup with ssl: require", async () => {
  const { status } = await session({ ssl: "require" });
  return ["I", status];
});

t("Startup with ssl: prefer", async () => {
  const { status } = await session({ ssl: "prefer" });
  return ["I", status];
});

t("Startup rejects with the server error", async () => {
  const error = await session({ database: "nope" }).catch(
    (sessionError) => sessionError
  );
  return ["PostgresError,FATAL", `${error.name},${error.severity}`];
});

t("Startup rejects with the socket error", async () => [
  "ECONNREFUSED",
  await session({ port: [1] }).catch((error) => error.code),
]);

t("Startup tries the next host", async () => {
  const { status } = await session({
    host: ["localhost", "localhost"],
    port: [1, 5432],
  });
  return ["I", status];
});

t("Startup rejects after connect_timeout", async () => {
  const x = await server(ignore);
  const start = Date.now();
  const code = await session({
    connect_timeout: 0.2,
    port: [x.address().port],
  }).catch((error) => error.code);
  x.close();
  return ["CONNECT_TIMEOUT,true", `${code},${Date.now() - start < 1000}`];
});

t("Startup rejects on a clean close", async () => {
  const x = await server((socket) => socket.end());
  const code = await session({ port: [x.address().port] }).catch(
    (error) => error.code
  );
  x.close();
  return ["CONNECTION_CLOSED", code];
});

t("Startup with target_session_attrs read-write", async () => {
  const { status } = await session({ target_session_attrs: "read-write" });
  return ["I", status];
});

t("Startup with target_session_attrs standby and no standby", async () => [
  "CONNECTION_DESTROYED",
  await session({ target_session_attrs: "standby" }).catch(
    (error) => error.code
  ),
]);

t("Cancel reaches the backend", async () => {
  const ready = await open(base);
  const types = [];
  const frames = Frames((type) => types.push(String.fromCodePoint(type)));
  ready.socket.ondata = (x) => frames.push(x);
  ready.socket.resume();
  ready.socket.write(Query("select pg_sleep(5)"));
  await delay(100);
  await ready.cancel();
  await delay(100);
  ready.socket.end();
  return ["TEZ", types.join("")];
});

const message = (type, body) => {
  const head = Buffer.alloc(5);
  head[0] = type.codePointAt(0);
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
};

const int32 = (x) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(x);
  return b;
};

const fake = (respond) =>
  server((socket) => {
    let buffer = Buffer.alloc(0);
    let started = false;
    socket.on("error", ignore);
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      // Each call consumes one whole message, until only a partial one is left.
      let more = true;
      while (more) {
        more = started ? one() : first();
      }
    });

    const first = () => {
      if (buffer.length < 8 || buffer.length < buffer.readInt32BE(0)) {
        return false;
      }

      const code = buffer.readInt32BE(4);
      buffer = buffer.subarray(buffer.readInt32BE(0));
      if (code === 80_877_103) {
        socket.write("N");
      } else {
        started = true;
        respond(socket, "startup");
      }
      return true;
    };

    const one = () => {
      if (buffer.length < 5 || buffer.length < buffer.readInt32BE(1) + 1) {
        return false;
      }

      const type = String.fromCodePoint(buffer[0]);
      const body = buffer.subarray(5, buffer.readInt32BE(1) + 1);
      buffer = buffer.subarray(buffer.readInt32BE(1) + 1);
      respond(socket, type, body);
      return true;
    };
  });

const ready = Buffer.concat([
  message("K", Buffer.concat([int32(1), int32(2)])),
  message("Z", Buffer.from("I")),
]);

const row = (x) =>
  message(
    "D",
    Buffer.concat([Buffer.from([0, 1]), int32(x.length), Buffer.from(x)])
  );

t(
  "Startup rejects a server that is ready before it accepted the authentication",
  async () => {
    const x = await fake((socket, type) => {
      if (type === "startup") {
        socket.write(
          message(
            "R",
            Buffer.concat([int32(10), Buffer.from("SCRAM-SHA-256\0\0")])
          )
        );
      }
      if (type === "p") {
        socket.write(ready);
      }
    });
    const code = await session({
      pass: "p",
      port: [x.address().port],
      user: "u",
    }).catch((error) => error.code);
    x.close();
    return ["AUTHENTICATION_INCOMPLETE", code];
  }
);

t(
  "Startup rejects a server that sends ReadyForQuery without any authentication",
  async () => {
    const x = await fake(
      (socket, type) => type === "startup" && socket.write(ready)
    );
    const code = await session({ port: [x.address().port] }).catch(
      (error) => error.code
    );
    x.close();
    return ["AUTHENTICATION_INCOMPLETE", code];
  }
);

t("Startup with a throwing onnotice still connects", async () => {
  const notice = message("N", Buffer.from("SNOTICE\0Mhello\0\0"));
  const x = await fake(
    (socket, type) =>
      type === "startup" &&
      socket.write(Buffer.concat([message("R", int32(0)), notice, ready]))
  );
  const status = await session({
    onnotice: () => {
      throw new Error("nope");
    },
    port: [x.address().port],
  }).then(
    (connected) => connected.status,
    (error) => error.message
  );
  x.close();
  return ["I", status];
});

t(
  "Startup destroys a TCP connection still in progress when connect_timeout passes",
  async () => {
    const { connect } = net;
    const sockets = [];
    net.connect = (...xs) => {
      const socket = connect(...xs);
      sockets.push(socket);
      return socket;
    };
    const code = await session({
      connect_timeout: 0.2,
      host: ["10.255.255.1"],
      port: [5432],
    }).catch((error) => error.code);
    net.connect = connect;
    return [
      "CONNECT_TIMEOUT 1 true",
      `${code} ${sockets.length} ${sockets.every((x) => x.destroyed)}`,
    ];
  }
);

const refused = async (auth, options) => {
  const x = await fake((socket, type) => {
    if (type === "startup") {
      socket.write(message("R", auth));
    }
    if (type === "p") {
      socket.write(
        message(
          "R",
          Buffer.concat([int32(11), Buffer.from("r=other,s=c2FsdA==,i=4096")])
        )
      );
    }
  });
  const code = await session({
    pass: "p",
    port: [x.address().port],
    user: "u",
    ...options,
  }).catch((error) => error.code);
  x.close();
  return code;
};

t("Startup rejects an authentication type it does not implement", async () => [
  "AUTH_TYPE_NOT_IMPLEMENTED",
  await refused(int32(7)),
]);

t("Startup rejects SASL without SCRAM-SHA-256", async () => [
  "SASL_MECHANISM_NOT_SUPPORTED",
  await refused(
    Buffer.concat([int32(10), Buffer.from("SCRAM-SHA-256-PLUS\0\0")])
  ),
]);

t(
  "Startup rejects a SCRAM server nonce that does not extend the client nonce",
  async () => [
    "SASL_NONCE_MISMATCH",
    await refused(Buffer.concat([int32(10), Buffer.from("SCRAM-SHA-256\0\0")])),
  ]
);

t("Startup with ssl: require rejects a server without SSL", async () => [
  "SSL_NOT_SUPPORTED",
  await refused(int32(0), { ssl: "require" }),
]);

t(
  "Startup asks the server for its state when it does not report it, for target_session_attrs",
  async () => {
    const x = await fake((socket, type) => {
      if (type === "startup") {
        socket.write(Buffer.concat([message("R", int32(0)), ready]));
      }
      if (type === "Q") {
        socket.write(
          Buffer.concat([row("on"), row("t"), message("Z", Buffer.from("I"))])
        );
      }
    });
    const { attributes } = await session({
      port: [x.address().port],
      target_session_attrs: "standby",
    });
    x.close();
    return ["true true", `${attributes.readOnly} ${attributes.standby}`];
  }
);

t(
  "Startup reads the password file as libpq does, and ignores what it can not use",
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgpass-"));
    const file = path.join(dir, "pgpass");
    const sent = [];
    const x = await fake((socket, type, body) => {
      if (type === "startup") {
        socket.write(message("R", int32(3)));
      }
      if (type === "p") {
        sent.push(body.toString("utf-8", 0, body.length - 1));
        socket.write(Buffer.concat([message("R", int32(0)), ready]));
      }
    });
    const { port } = x.address();
    const loginWith = (passfile) =>
      session({
        database: "db",
        host: ["localhost"],
        pass: undefined,
        passfile,
        port: [port],
        user: "u",
      });
    fs.writeFileSync(
      file,
      [
        "# localhost:*:*:u:comment",
        "localhost:*:*",
        `localhost:${port}:other:u:wrong`,
        `localhost:${port}:db:u:a\\:b\\\\c:d`,
      ].join("\n")
    );
    fs.chmodSync(file, 0o600);
    await loginWith(file);
    await loginWith(dir);
    await loginWith(path.join(dir, "missing"));
    await loginWith(null);
    x.close();
    fs.rmSync(dir, { force: true, recursive: true });
    return [JSON.stringify(["a:b\\c:d", "", "", ""]), JSON.stringify(sent)];
  }
);

t(
  "A message the client does not support rejects the query with MESSAGE_NOT_SUPPORTED",
  async () => {
    const x = await fake((socket, type) => {
      if (type === "startup") {
        socket.write(Buffer.concat([message("R", int32(0)), ready]));
      }
      if (type === "Q") {
        socket.write(
          Buffer.concat([
            message("V", int32(0)),
            message("Z", Buffer.from("I")),
          ])
        );
      }
    });
    const sql = postgres({
      fetch_types: false,
      host: "localhost",
      max: 1,
      port: x.address().port,
      user: "u",
    });
    const error = await sql
      .unsafe("select 1")
      .catch((queryError) => `${queryError.code} ${queryError.name}`);
    await sql.end({ timeout: 0 });
    x.close();
    return ["MESSAGE_NOT_SUPPORTED FunctionCallResponse", error];
  }
);

t(
  "Startup with SCRAM-SHA-256-PLUS over TLS when channel_binding is require",
  async () => {
    const { status } = await session({
      ...login_scram,
      channel_binding: "require",
      ssl: "require",
    });
    return ["I", status];
  }
);

t(
  "channel_binding: require rejects a connection without TLS, or authenticated without SCRAM",
  async () => [
    "CHANNEL_BINDING_REQUIRED CHANNEL_BINDING_REQUIRED",
    [
      await session({ ...login_scram, channel_binding: "require" }).catch(
        (error) => error.code
      ),
      await session({
        ...login_md5,
        channel_binding: "require",
        ssl: "require",
      }).catch((error) => error.code),
    ].join(" "),
  ]
);

t(
  "channel_binding: disable and prefer connect over TLS and without it",
  async () => {
    const statuses = [];
    for (const channel_binding of ["disable", "prefer"]) {
      for (const ssl of [false, "require"]) {
        // oxlint-disable-next-line no-await-in-loop -- one connection after another, as the test intends
        const { status } = await session({
          ...login_scram,
          channel_binding,
          ssl,
        });
        statuses.push(status);
      }
    }
    return ["I,I,I,I", statuses.join(",")];
  }
);

const header = (type, length) => {
  const x = Buffer.alloc(5);
  x[0] = type.codePointAt(0);
  x.writeInt32BE(length, 1);
  return x;
};

t(
  "A message with an invalid length during startup rejects with PROTOCOL_ERROR",
  async () => {
    const codes = [];
    for (const length of [-1, 0, 3, 0x40_00_00_01]) {
      // oxlint-disable-next-line no-await-in-loop -- one fake server after another, each closed before the next
      const x = await fake(
        (socket, type) =>
          type === "startup" &&
          socket.write(Buffer.concat([header("R", length), Buffer.alloc(8)]))
      );
      // oxlint-disable-next-line no-await-in-loop -- one fake server after another, each closed before the next
      const code = await session({ port: [x.address().port] }).catch(
        (error) => error.code
      );
      codes.push(code);
      x.close();
    }
    return [
      "PROTOCOL_ERROR,PROTOCOL_ERROR,PROTOCOL_ERROR,PROTOCOL_ERROR",
      codes.join(","),
    ];
  }
);

t(
  "A message with an invalid length after startup rejects the query and closes the connection",
  async () => {
    const x = await fake((socket, type) => {
      if (type === "startup") {
        socket.write(Buffer.concat([message("R", int32(0)), ready]));
      }
      if (type === "Q") {
        socket.write(Buffer.concat([header("Z", -1), Buffer.alloc(8)]));
      }
    });
    const sql = postgres({
      fetch_types: false,
      host: "localhost",
      max: 1,
      port: x.address().port,
      user: "u",
    });
    const error = await sql
      .unsafe("select 1")
      .catch(
        (queryError) =>
          `${queryError.code} ${queryError.cause && queryError.cause.code}`
      );
    await sql.end({ timeout: 0 });
    x.close();
    return [true, /PROTOCOL_ERROR/u.test(error)];
  }
);

t(
  "channel_binding: require sends no password when the server asks for cleartext or MD5",
  async () => {
    const received = [];
    const codes = [];
    for (const kind of [3, 5]) {
      // oxlint-disable-next-line no-await-in-loop -- one fake server after another, each closed before the next
      const x = await fake((socket, type) => {
        if (type === "startup") {
          socket.write(
            message(
              "R",
              Buffer.concat([int32(kind), Buffer.alloc(kind === 5 ? 4 : 0)])
            )
          );
        }
        if (type === "p") {
          received.push(kind);
        }
      });
      // oxlint-disable-next-line no-await-in-loop -- one fake server after another, each closed before the next
      const code = await session({
        channel_binding: "require",
        pass: "secret",
        port: [x.address().port],
        user: "u",
      }).catch((error) => error.code);
      codes.push(code);
      x.close();
    }
    return [
      "CHANNEL_BINDING_REQUIRED,CHANNEL_BINDING_REQUIRED 0",
      `${codes.join(",")} ${received.length}`,
    ];
  }
);
