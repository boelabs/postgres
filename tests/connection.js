import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";

import {
  postgres,
  sql as shared,
  options,
  login,
  login_md5,
  login_scram,
  delay,
  idle_timeout,
  exec,
} from "./setup.js";
import { t } from "./test.js";

// Calls fn with each item in turn, each call after the previous one settles, as a for loop with
// an await in its body would.
const series = async (xs, fn, i = 0) => {
  if (i < xs.length) {
    await fn(xs[i], i);
    await series(xs, fn, i + 1);
  }
};

t("Connects with no options", async () => {
  const sql = postgres({ max: 1 });

  const [{ x: result }] = await sql`select 1 as x`;
  await sql.end();

  return [1, result];
});

t("Uses default database without slash", () => {
  const sql = postgres("postgres://localhost");
  return [sql.options.user, sql.options.database];
});

t("Uses default database with slash", () => {
  const sql = postgres("postgres://localhost/");
  return [sql.options.user, sql.options.database];
});

t("Connect using uri", async () => {
  const sql = postgres(
    `postgres://${login.user}:${login.pass || ""}@localhost:5432/${options.db}`,
    {
      idle_timeout,
    }
  );
  return [true, await sql`select 1`.then(() => true)];
});

t("Options from uri with special characters in user and pass", () => {
  const opt = postgres({ pass: "pass^word", user: "öla" }).options;
  return [[opt.user, opt.pass].toString(), "öla,pass^word"];
});

t("Fail with proper error on no host", async () => {
  const sql = postgres(`postgres://localhost:33333/${options.db}`, {
    idle_timeout,
  });
  const { code } = await sql`select 1`.then(
    (result) => {
      throw result;
    },
    (connectError) => connectError
  );
  return ["ECONNREFUSED", code];
});

t("Connect using SSL", async () => [
  true,
  await postgres({
    idle_timeout,
    ssl: { rejectUnauthorized: false },
  })`select 1`.then(() => true),
]);

t("Connect using SSL require", async () => [
  true,
  await postgres({
    idle_timeout,
    ssl: "require",
  })`select 1`.then(() => true),
]);

t("Connect using SSL direct", async () => {
  const [{ supported }] =
    await shared`select current_setting('server_version_num')::int >= 180000 as supported`;
  return [
    true,
    !supported ||
      (await postgres({
        idle_timeout,
        ssl: "require",
        sslnegotiation: "direct",
      })`select 1`.then(() => true)),
  ];
});

t("Connect using SSL prefer", async () => {
  await exec("psql", ["-c", "alter system set ssl=off"]);
  await exec("psql", ["-c", "select pg_reload_conf()"]);

  const sql = postgres({
    idle_timeout,
    ssl: "prefer",
  });

  const [{ x }] = await sql`select 1 as x`;
  return [
    1,
    x,
    await exec("psql", ["-c", "alter system set ssl=on"]),
    await exec("psql", ["-c", "select pg_reload_conf()"]),
  ];
});

t("Reconnect using SSL", async () => {
  const sql = postgres({
    idle_timeout: 0.1,
    ssl: "require",
  });

  await sql`select 1`;
  await delay(200);

  const [{ x }] = await sql`select 1 as x`;
  return [1, x];
});

t(
  "An ssl object without a ca builds a TLS context per connection, and with one a context its connections share until a value changes",
  async () => {
    if (globalThis.Bun || globalThis.Deno) {
      return [true, true];
    }

    const create = tls.createSecureContext;
    const ssl = { rejectUnauthorized: false };
    const sql = postgres({ ...options, max: 6, ssl });
    let built = 0;
    tls.createSecureContext = (...xs) => {
      built += 1;
      return create(...xs);
    };
    try {
      const reserved = [
        await sql.reserve(),
        await sql.reserve(),
        await sql.reserve(),
      ];
      const without = built;
      ssl.ca = tls.rootCertificates;
      reserved.push(await sql.reserve(), await sql.reserve());
      const withCa = built;
      ssl.ca = [...tls.rootCertificates];
      reserved.push(await sql.reserve());
      for (const x of reserved) {
        x.release();
      }
      return ["3 4 5", [without, withCa, built].join(" ")];
    } finally {
      tls.createSecureContext = create;
      await sql.end({ timeout: 0 });
    }
  }
);

t("Login without password", async () => {
  const [{ x }] = await postgres({ ...options, ...login })`select true as x`;
  return [true, x];
});

t("Login using MD5", async () => {
  const [{ x }] = await postgres({
    ...options,
    ...login_md5,
  })`select true as x`;
  return [true, x];
});

t("Login using scram-sha-256", async () => {
  const [{ x }] = await postgres({
    ...options,
    ...login_scram,
  })`select true as x`;
  return [true, x];
});

t(
  "Parallel connections using scram-sha-256",
  {
    timeout: 2,
  },
  async () => {
    const sql = postgres({ ...options, ...login_scram });
    const [[{ x }]] = await Promise.all([
      sql`select true as x, pg_sleep(0.01)`,
      sql`select true as x, pg_sleep(0.01)`,
      sql`select true as x, pg_sleep(0.01)`,
    ]);
    return [true, x];
  }
);

t("Support dynamic password function", async () => {
  const [{ x }] = await postgres({
    ...options,
    ...login_scram,
    pass: () => "postgres_js_test_scram",
  })`select true as x`;
  return [true, x];
});

t("Support dynamic async password function", async () => {
  const [{ x }] = await postgres({
    ...options,
    ...login_scram,
    pass: () => Promise.resolve("postgres_js_test_scram"),
  })`select true as x`;
  return [true, x];
});

t("Connection ended promise", async () => {
  const sql = postgres(options);

  await sql.end();

  return [undefined, await sql.end()];
});

t("Connection ended timeout", async () => {
  const sql = postgres(options);

  await sql.end({ timeout: 10 });

  return [undefined, await sql.end()];
});

t("Connection ended error", async () => {
  const sql = postgres(options);
  await sql.end();
  return ["CONNECTION_ENDED", await sql``.catch((error) => error.code)];
});

t("Connection end does not cancel query", async () => {
  const sql = postgres(options);

  const promise = sql`select 1 as x`.execute();

  await sql.end();

  const [{ x }] = await promise;
  return [1, x];
});

t("Connection destroyed", async () => {
  const sql = postgres(options);
  process.nextTick(() => sql.end({ timeout: 0 }));
  return ["CONNECTION_DESTROYED", await sql``.catch((error) => error.code)];
});

t("Connection destroyed with query before", async () => {
  const sql = postgres(options);
  const code = sql`select pg_sleep(0.2)`.catch(
    (destroyedError) => destroyedError.code
  );

  sql.end({ timeout: 0 });
  return ["CONNECTION_DESTROYED", await code];
});

t("responds with server parameters (application_name)", async () => {
  const { promise, resolve, reject } = Promise.withResolvers();
  postgres({
    ...options,
    onparameter: (k, v) => k === "application_name" && resolve(v),
  })`select 1`.catch(reject);
  return ["@boelabs/postgres", await promise];
});

t("has server parameters", async () => [
  "@boelabs/postgres",
  await shared`select 1`.then(() => shared.parameters.application_name),
]);

t("connection parameters", async () => {
  const sql = postgres({
    ...options,
    connection: {
      "some.var": "yay",
    },
  });

  const [{ x }] = await sql`select current_setting('some.var') as x`;
  return ["yay", x];
});

t("Unix socket", async () => {
  const sql = postgres({
    ...options,
    host: process.env.PGSOCKET || "/tmp",
  });

  const [{ x }] = await sql`select 1 as x`;
  return [1, x];
});

t("connect_timeout", { timeout: 20 }, async () => {
  const connect_timeout = 0.2;
  const server = net.createServer();
  await listening(server);
  const sql = postgres({
    connect_timeout,
    host: "127.0.0.1",
    port: server.address().port,
  });
  const start = Date.now();
  let end;
  await sql`select 1`.catch((error) => {
    if (error.code !== "CONNECT_TIMEOUT") {
      throw error;
    }
    end = Date.now();
  });
  server.close();
  return [connect_timeout, Math.round((end - start) / 100) / 10];
});

t("connect_timeout throws proper error", async () => [
  "CONNECT_TIMEOUT",
  await postgres({
    ...options,
    ...login_scram,
    connect_timeout: 0.001,
  })`select 1`.catch((error) => error.code),
]);

t(
  "connect_timeout error message includes host:port",
  { timeout: 20 },
  async () => {
    const connect_timeout = 0.2;
    const server = net.createServer();
    await listening(server);
    const sql = postgres({
      connect_timeout,
      host: "127.0.0.1",
      port: server.address().port,
    });
    const { port } = server.address();
    let err;
    await sql`select 1`.catch((error) => {
      if (error.code !== "CONNECT_TIMEOUT") {
        throw error;
      }
      err = error.message;
    });
    server.close();
    return [["write CONNECT_TIMEOUT 127.0.0.1:", port].join(""), err];
  }
);

t("requests works after single connect_timeout", async () => {
  let first = true;

  const sql = postgres({
    ...options,
    ...login_scram,
    connect_timeout: {
      valueOf() {
        return first ? ((first = false), 0.0001) : 1;
      },
    },
  });

  const firstAttempt = await sql`select 1 as x`.then(
    () => "success",
    (error) => error.code
  );
  const waited = await delay(10);
  const [{ x }] = await sql`select 1 as x`;
  return ["CONNECT_TIMEOUT,,1", [firstAttempt, waited, x].join(",")];
});

t("Catches connection config errors", async () => {
  const sql = postgres({
    ...options,
    database: "prut",
    user: {
      toString: () => {
        throw new Error("wat");
      },
    },
  });

  return ["wat", await sql`select 1`.catch((error) => error.message)];
});

t("Catches connection config errors with end", async () => {
  const sql = postgres({
    ...options,
    database: "prut",
    user: {
      toString: () => {
        throw new Error("wat");
      },
    },
  });

  return [
    "wat",
    await sql`select 1`.catch((error) => error.message),
    await sql.end(),
  ];
});

t(
  "Multiple hosts",
  {
    timeout: 1,
  },
  async () => {
    const s1 = postgres({ idle_timeout });
    const s2 = postgres({ idle_timeout, port: 5433 });
    const sql = postgres("postgres://localhost:5432,localhost:5433", {
      idle_timeout,
      max: 1,
    });
    const result = [];

    const [{ x: id1 }] =
      await s1`select system_identifier as x from pg_control_system()`;
    const [{ x: id2 }] =
      await s2`select system_identifier as x from pg_control_system()`;

    const x1 = await sql`select 1`;
    const [{ x: first }] =
      await sql`select system_identifier as x from pg_control_system()`;
    result.push(first);
    await s1`select pg_terminate_backend(${x1.state.pid}::int)`;
    await delay(50);

    const x2 = await sql`select 1`;
    const [{ x: second }] =
      await sql`select system_identifier as x from pg_control_system()`;
    result.push(second);
    await s2`select pg_terminate_backend(${x2.state.pid}::int)`;
    await delay(50);

    const [{ x: third }] =
      await sql`select system_identifier as x from pg_control_system()`;
    result.push(third);

    return [[id1, id2, id1].join(","), result.join(",")];
  }
);

t("multiple queries before connect", async () => {
  const sql = postgres({ ...options, max: 2 });
  const xs = await Promise.all([
    sql`select 1 as x`,
    sql`select 2 as x`,
    sql`select 3 as x`,
    sql`select 4 as x`,
  ]);

  return ["1,2,3,4", xs.map((x) => x[0].x).join(",")];
});

t("Custom socket", {}, async () => {
  let result;
  const sql = postgres({
    idle_timeout,
    socket: () => {
      const { promise, resolve, reject } = Promise.withResolvers();
      const socket = new net.Socket();
      socket.connect(5432);
      socket.once("data", ([first]) => (result = first));
      socket.on("error", reject);
      socket.on("connect", () => resolve(socket));
      return promise;
    },
  });

  await sql`select 1`;

  return [result, 82];
});

t("Ensure drain only dequeues if ready", async () => {
  const sql = postgres(options);

  const res = await Promise.all([
    sql.unsafe(`SELECT 0+$1 --${".".repeat(100_000)}`, [1]),
    sql.unsafe("SELECT 0+$1+$2+$3", [1, 2, 3]),
  ]);

  return [res.length, 2];
});

t("max: undefined uses the default", async () => {
  const sql = postgres({ ...options, max: undefined });
  return [10, sql.options.max, await sql.end()];
});

t("onnotice: false silences notices", async () => {
  const sql = postgres({ ...options, onnotice: false });
  const { log } = console;
  let logged = false;
  console.log = () => (logged = true);
  try {
    await sql`do $$ begin raise notice 'hi'; end $$`;
  } finally {
    console.log = log;
  }
  return [false, logged, await sql.end()];
});

t(
  "Multiple hosts errors when all hosts are down",
  { timeout: 10 },
  async () => {
    const sql = postgres({
      ...options,
      connect_timeout: 1,
      host: ["localhost", "localhost"],
      port: [1, 2],
    });
    return ["ECONNREFUSED", await sql`select 1`.catch((error) => error.code)];
  }
);

t(
  "Multiple hosts continues to next host after connect timeout",
  { timeout: 10 },
  async () => {
    const server = net.createServer();
    await listening(server);
    const sql = postgres({
      ...options,
      connect_timeout: 1,
      host: ["127.0.0.1", "localhost"],
      port: [server.address().port, 5432],
    });
    const [{ x }] = await sql`select 1 as x`;
    server.close();
    await sql.end();
    return [1, x];
  }
);

t(
  "prefer-standby connects to the primary when the standby host is down",
  { timeout: 10 },
  async () => {
    const sql = postgres({
      ...options,
      connect_timeout: 1,
      host: ["localhost", "localhost"],
      port: [1, 5432],
      target_session_attrs: "prefer-standby",
    });
    const [{ x }] = await sql`select 1 as x`;
    await sql.end();
    return [1, x];
  }
);

t(
  "prefer-standby connects to a primary when no host is a standby",
  { timeout: 10 },
  async () => {
    const sql = postgres({
      host: ["localhost", "localhost"],
      idle_timeout,
      max: 1,
      port: [5432, 5433],
      target_session_attrs: "prefer-standby",
    });
    const [{ x }] = await sql`select 1 as x`;
    await sql.end();
    return [1, x];
  }
);

t(
  "target_session_attrs standby errors when no host is a standby",
  { timeout: 10 },
  async () => {
    const sql = postgres({
      host: ["localhost", "localhost"],
      idle_timeout,
      max: 1,
      port: [5432, 5433],
      target_session_attrs: "standby",
    });
    return [
      "CONNECTION_DESTROYED",
      await sql`select 1`.catch((error) => error.code),
    ];
  }
);

t(
  "Multiple hosts rejects within connect_timeout × hosts when every host times out",
  { timeout: 10 },
  async () => {
    const connect_timeout = 0.3;
    const a = await listening(net.createServer());
    const b = await listening(net.createServer());
    const host = ["127.0.0.1", "127.0.0.1"];
    const port = [a.address().port, b.address().port];
    const sql = postgres({ ...options, connect_timeout, host, port });

    const start = Date.now();
    const code = await sql`select 1`.catch((error) => error.code);
    const elapsed = (Date.now() - start) / 1000;

    a.close();
    b.close();
    await sql.end();

    return [
      "CONNECT_TIMEOUT,true",
      `${code},${elapsed < connect_timeout * host.length + 1}`,
    ];
  }
);

t(
  "prefer-standby tries every host for a standby before accepting a primary",
  { timeout: 10 },
  async () => {
    let probe = 0;
    const server = await listening(
      net.createServer((socket) => {
        probe += 1;
        socket.destroy();
      })
    );
    const sql = postgres({
      ...options,
      host: ["localhost", "127.0.0.1"],
      port: [5432, server.address().port],
      target_session_attrs: "prefer-standby",
    });

    const [{ x }] = await sql`select 1 as x`;
    server.close();
    await sql.end();

    return ["1,1", [x, probe].join(",")];
  }
);

const backendMessage = (type, body) => {
  const header = Buffer.alloc(5);
  header.write(type);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};

const errorResponse = (severity, code, localizedOnly) =>
  backendMessage(
    "E",
    Buffer.from(
      `S${severity}\0${localizedOnly ? "" : `V${severity}\0`}C${code}\0M${
        code
      }\0\0`
    )
  );

const userTypeColumn = backendMessage(
  "T",
  Buffer.concat([
    Buffer.from([0, 1]),
    Buffer.from("x\0"),
    Buffer.from([
      0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0x74, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0,
      0,
    ]),
  ])
);

const authenticated = Buffer.concat([
  backendMessage("R", Buffer.alloc(4)),
  backendMessage("Z", Buffer.from("I")),
]);

t(
  "A transaction runs on a new connection if the backend dies while fetching array types",
  async () => {
    let killed = false;
    let unhandled = 0;

    const onunhandled = () => {
      unhandled += 1;
    };
    process.on("unhandledRejection", onunhandled);

    const proxy = net.createServer((client) => {
      const server = net.connect(5432, "localhost");
      client.on("data", (x) => {
        if (!killed && x.includes("pg_type")) {
          killed = true;
          server.destroy();
          return client.end(errorResponse("FATAL", "57P01"));
        }
        server.write(x);
      });
      server.on("data", (x) => client.writable && client.write(x));
      client.on("error", () => server.destroy());
      server.on("error", () => client.destroy());
      client.on("close", () => server.destroy());
    });

    await listening(proxy, "localhost");
    const sql = postgres({
      ...options,
      eager_types: true,
      host: "localhost",
      port: proxy.address().port,
    });
    const x = await sql
      .begin((tx) => tx`select 1 as x`)
      .then(
        ([row]) => row.x,
        (error) => error.code
      );
    await sql.end();
    proxy.close();
    process.off("unhandledRejection", onunhandled);

    return ["1,0,true", [x, unhandled, killed].join(",")];
  }
);

t(
  "Clean closes during startup reject queries and reserves instead of reconnecting forever",
  async () => {
    let attempts = 0;

    const server = net.createServer((socket) => {
      attempts += 1;
      socket.end();
    });
    await listening(server, "localhost");
    const sql = postgres({
      ...options,
      host: "localhost",
      max: 2,
      port: server.address().port,
    });
    const codes = await Promise.all([
      sql`select 1`.catch((error) => error.code),
      sql`select 2`.catch((error) => error.code),
      sql.reserve().catch((error) => error.code),
    ]);
    await sql.end();
    server.close();

    return [
      "CONNECTION_CLOSED,CONNECTION_CLOSED,CONNECTION_CLOSED,true",
      [...codes, attempts < 10].join(","),
    ];
  }
);

t(
  "Clean closes while fetching array types reject transactions once connect_timeout has passed",
  { timeout: 10 },
  async () => {
    let attempts = 0;

    const proxy = net.createServer((client) => {
      const server = net.connect(5432, "localhost");
      attempts += 1;
      client.on("data", (x) =>
        x.includes("pg_type")
          ? (server.destroy(), client.end())
          : server.write(x)
      );
      server.on("data", (x) => client.writable && client.write(x));
      client.on("error", () => server.destroy());
      server.on("error", () => client.destroy());
      client.on("close", () => server.destroy());
    });

    await listening(proxy, "localhost");
    const sql = postgres({
      ...options,
      connect_timeout: 0.5,
      eager_types: true,
      host: "localhost",
      port: proxy.address().port,
    });
    const start = Date.now();
    const error = await sql
      .begin((tx) => tx`select ${1}::int as x`)
      .catch((beginError) => beginError);
    const waited = Date.now() - start;
    await sql.end();
    proxy.close();

    return [
      "CONNECTION_CLOSED true true",
      [error.code, waited >= 500, attempts < 10].join(" "),
    ];
  }
);

t(
  "A transaction waiting for array types is retried after a clean close when connect_timeout is disabled",
  async () => {
    let attempts = 0;
    let closed = false;

    const proxy = net.createServer((client) => {
      const server = net.connect(5432, "localhost");
      attempts += 1;
      client.on("data", (x) =>
        !closed && x.includes("pg_type")
          ? ((closed = true), server.destroy(), client.end())
          : server.write(x)
      );
      server.on("data", (x) => client.writable && client.write(x));
      client.on("error", () => server.destroy());
      server.on("error", () => client.destroy());
      client.on("close", () => server.destroy());
    });

    await listening(proxy, "localhost");
    const sql = postgres({
      ...options,
      connect_timeout: 0,
      eager_types: true,
      host: "localhost",
      port: proxy.address().port,
    });
    const x = await sql
      .begin((tx) => tx`select 1 as x`)
      .then(
        ([row]) => row.x,
        (error) => error.code
      );
    await sql.end();
    proxy.close();

    return [
      "1 true true",
      [x, closed, attempts >= 2 && attempts < 10].join(" "),
    ];
  }
);

const closingTypes = async (times) => {
  let closes = 0;
  const proxy = net.createServer((client) => {
    const server = net.connect(
      options.port || 5432,
      options.host || "localhost"
    );
    client.on("data", (x) =>
      closes < times && x.includes("pg_catalog.pg_type")
        ? ((closes += 1), server.destroy(), client.end())
        : server.write(x)
    );
    server.on("data", (x) => client.writable && client.write(x));
    client.on("error", () => server.destroy());
    server.on("error", () => client.destroy());
    client.on("close", () => server.destroy());
  });
  await listening(proxy, "localhost");
  return {
    close: () => proxy.close(),
    closes: () => closes,
    port: proxy.address().port,
  };
};

t(
  "A lazy read of array types whose connection closes is retried after backoff",
  { timeout: 10 },
  async () => {
    await shared`create type test_mood as enum ('ok', 'sad')`;
    const proxy = await closingTypes(1);
    const lazy = postgres({
      ...options,
      backoff: () => 0.1,
      host: "localhost",
      max: 1,
      port: proxy.port,
    });
    const [{ m }] = await lazy`select '{ok,sad}'::test_mood[] as m`;
    await lazy.end();
    proxy.close();
    return [
      "ok,sad 1",
      `${m.join(",")} ${proxy.closes()}`,
      await shared`drop type test_mood`,
    ];
  }
);

t(
  "A lazy read of array types that keeps failing rejects the query once connect_timeout has passed",
  { timeout: 10 },
  async () => {
    await shared`create type test_mood as enum ('ok', 'sad')`;
    const proxy = await closingTypes(Infinity);
    const lazy = postgres({
      ...options,
      backoff: () => 0.1,
      connect_timeout: 0.5,
      host: "localhost",
      max: 1,
      port: proxy.port,
    });
    const start = Date.now();
    const error = await lazy`select '{ok,sad}'::test_mood[] as m`.catch(
      (queryError) => queryError
    );
    const waited = Date.now() - start;
    const [{ x }] = await lazy`select 1 as x`;
    await lazy.end();
    proxy.close();
    return [
      "CONNECTION_DESTROYED CONNECTION_CLOSED true true 1",
      [
        error.code,
        error.cause && error.cause.code,
        waited >= 500,
        proxy.closes() < 20,
        x,
      ].join(" "),
      await shared`drop type test_mood`,
    ];
  }
);

t(
  "A query refused with a FATAL error rejects with the peer error instead of reconnecting forever",
  async () => {
    let attempts = 0;
    let unhandled = 0;

    const onunhandled = () => {
      unhandled += 1;
    };
    process.on("unhandledRejection", onunhandled);

    const server = net.createServer((socket) => {
      let started = false;
      attempts += 1;
      socket.on("error", () => socket.destroy());
      socket.on("data", () =>
        started
          ? socket.end(errorResponse("FATAL", "08P01"))
          : ((started = true), socket.write(authenticated))
      );
    });

    await listening(server, "localhost");
    const sql = postgres({
      ...options,
      host: "localhost",
      port: server.address().port,
    });
    const code = await sql`select 1`.catch((error) => error.code);
    await sql.end();
    server.close();
    process.off("unhandledRejection", onunhandled);

    return ["08P01,true,0", [code, attempts < 10, unhandled].join(",")];
  }
);

t(
  "A FATAL with the severity only in the S field rejects the query and sql.begin with it",
  async () => {
    const server = await listening(
      net.createServer((socket) => {
        let started = false;
        socket.on("error", () => socket.destroy());
        socket.on("data", () =>
          started
            ? socket.end(errorResponse("FATAL", "08P01", true))
            : ((started = true), socket.write(authenticated))
        );
      })
    );

    const sql = postgres({
      ...options,
      host: "127.0.0.1",
      port: server.address().port,
    });
    const query = await sql`select 1`.catch((error) => error.code);
    const begin = await sql
      .begin((tx) => tx`select 1`)
      .catch((error) => error.code);
    await sql.end();
    server.close();

    return ["08P01,08P01", [query, begin].join(",")];
  }
);

t(
  "Failed array type fetch on a live connection is not an unhandled rejection",
  async () => {
    let unhandled = 0;
    let fetched = 0;

    const onunhandled = () => {
      unhandled += 1;
    };
    process.on("unhandledRejection", onunhandled);

    const server = net.createServer((socket) => {
      let started = false;
      socket.on("error", () => socket.destroy());
      socket.on("data", (x) => {
        if (!started) {
          return ((started = true), socket.write(authenticated));
        }

        const out = [];
        for (let i = 0; i < x.length; i += 1 + x.readInt32BE(i + 1)) {
          const body = x.subarray(i + 5, i + 1 + x.readInt32BE(i + 1));
          if (x[i] === 88) {
            socket.end();
          }
          if (x[i] === 81) {
            if (body.includes("pg_type")) {
              fetched += 1;
              out.push(errorResponse("ERROR", "57014"));
            } else {
              out.push(
                userTypeColumn,
                backendMessage("D", Buffer.from([0, 1, 0, 0, 0, 1, 120])),
                backendMessage("C", Buffer.from("SELECT 1\0"))
              );
            }
            out.push(backendMessage("Z", Buffer.from("I")));
          }
        }
        if (out.length) {
          socket.write(Buffer.concat(out));
        }
      });
    });

    await listening(server, "localhost");
    const sql = postgres({
      ...options,
      host: "localhost",
      port: server.address().port,
    });
    const [{ x }] = await sql.unsafe("select x");
    await sql.end();
    server.close();
    process.off("unhandledRejection", onunhandled);

    return ["1 0 x", `${fetched} ${unhandled} ${x}`];
  }
);

t(
  "end() completes after the backend is terminated mid-query",
  { timeout: 5 },
  async () => {
    const sql = postgres({ ...options, max: 1 });
    const killer = postgres(options);
    const [{ pid }] = await sql`select pg_backend_pid() as pid`;
    const query = sql`select pg_sleep(1)`.catch((queryError) => queryError);
    await delay(10);
    await killer`select pg_terminate_backend(${pid})`;
    await killer.end();
    const error = await query;
    const start = Date.now();
    await sql.end();
    return [
      "true,true",
      [error instanceof Error, Date.now() - start < 1000].join(","),
    ];
  }
);

t("Connection end cancels a pending socket factory", async () => {
  let release;
  let closes = 0;

  const { promise: connecting, resolve: started } = Promise.withResolvers();
  const socket = new net.Socket();
  const application_name = `postgres.js end socket factory ${crypto.randomBytes(4).toString("hex")}`;
  const client = postgres({
    ...options,
    connection: { application_name },
    onclose: () => {
      closes += 1;
    },
    socket: ({ port, host }) => {
      const { promise, resolve, reject } = Promise.withResolvers();
      release = resolve;
      socket.on("error", reject);
      socket.connect(port[0], host[0], started);
      return promise;
    },
  });
  const query = client`select 1`.catch((queryError) => queryError.code);

  try {
    await connecting;
    await client.end({ timeout: 0 });
    release(socket);
    await delay(200);
    const [{ count }] =
      await shared`select count(*)::int as count from pg_stat_activity where application_name = ${application_name}`;
    return [
      "CONNECTION_DESTROYED,0,true,0",
      [await query, count, socket.destroyed, closes].join(","),
    ];
  } finally {
    socket.destroy();
    await client.end({ timeout: 0 });
    await shared`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${application_name}`;
  }
});

t("Connection end stops a listen connection that is reconnecting", async () => {
  const application_name = `postgres.js end reconnect ${crypto.randomBytes(4).toString("hex")}`;
  const client = postgres({ ...options, connection: { application_name } });

  try {
    const {
      state: { pid },
    } = await client.listen("end_reconnect", () => 0);
    await shared`select pg_terminate_backend(${pid})`;
    await delay(0);
    await client.end();
    await delay(400);
    const [{ count }] =
      await shared`select count(*)::int as count from pg_stat_activity where application_name = ${application_name}`;
    return [0, count];
  } finally {
    await client.end({ timeout: 0 });
    await shared`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${application_name}`;
  }
});

t("Connection end cancels the first listen attempt", async () => {
  const server = net.createServer((socket) => socket.resume());
  await listening(server);
  const socket = new net.Socket();
  const { promise: closed, resolve: onclose } = Promise.withResolvers();
  socket.once("close", onclose);
  const sql = postgres({
    ...options,
    connect_timeout: 30,
    socket: () => socket.connect(server.address().port, "127.0.0.1"),
  });
  const listened = sql
    .listen("end_connecting", () => {
      // No notification arrives: the listen is ended before it connects.
    })
    .catch((listenError) => listenError.code);
  await sql.end();
  await closed;
  server.close();
  return ["CONNECTION_DESTROYED", await listened];
});

t("Cancel query while its connection is opening", async () => {
  const { promise: opened, resolve: open } = Promise.withResolvers();
  const sql = postgres({
    ...options,
    socket: async ({ host: [host], port: [port] }) => {
      await opened;
      const { promise, resolve, reject } = Promise.withResolvers();
      const socket = new net.Socket();
      socket.connect(port, host);
      socket.on("error", reject);
      socket.on("connect", () => resolve(socket));
      return promise;
    },
  });
  const query = sql`select 1 as x`;
  const error = query.catch((cancelError) => cancelError);
  await delay(10);
  query.cancel();
  const next = sql`select 2 as x`.execute();
  open();
  const [{ x }] = await next;
  const { code } = await error;
  return ["57014,2", `${code},${x}`, await sql.end()];
});

t(
  "A query cancelled while its connection starts up leaves the connection in the pool (#1266)",
  { timeout: 10 },
  async () => {
    const results = [];
    await series(
      [
        ["auth", {}],
        ["types", {}],
        ["auth", { fetch_types: false }],
      ],
      async ([phase, o]) => {
        const held = [];
        let holding = phase === "auth";

        const proxy = net.createServer((client) => {
          const server = net.connect(options.port || 5432, "localhost");
          client.on("data", (x) => {
            if (phase === "types" && x.includes("pg_type")) {
              holding = true;
            }
            server.write(x);
          });
          server.on("data", (x) => (holding ? held.push(x) : client.write(x)));
          client.on("error", () => server.destroy());
          server.on("error", () => client.destroy());
          client.on("close", () => server.destroy());
          server.on("close", () => client.destroy());
          proxy.release = () => {
            holding = false;
            for (const x of held.splice(0)) {
              client.write(x);
            }
          };
        });

        await listening(proxy, "localhost");
        const sql = postgres({
          ...options,
          ...o,
          host: "localhost",
          max: 1,
          port: proxy.address().port,
        });
        const query = sql`select 1 as x`;
        const outcome = query.then(
          () => "ran",
          (cancelError) => cancelError.code
        );

        await delay(100);
        await query.cancel();
        proxy.release();
        const started = performance.now();
        const [{ x }] = await sql`select 2 as x`;
        results.push(
          [
            phase,
            ["57014", "ran"].includes(await outcome),
            x,
            performance.now() - started < 2000,
          ].join(" ")
        );
        await sql.end({ timeout: 0 });
        proxy.close();
      }
    );
    return [
      "auth true 2 true,types true 2 true,auth true 2 true",
      results.join(","),
    ];
  }
);

t("sql.begin works with max_pipeline: 0 and max: 1 (#1264)", async () => {
  const sql = postgres({ ...options, max: 1, max_pipeline: 0 });
  const x = await sql
    .begin((tx) => tx`select 1 as x`)
    .then(
      (rows) => rows[0].x,
      (error) => error.code
    );
  const y = await sql
    .begin(async (tx) => {
      await tx`select 1`;
      const [row] = await tx`select 2 as y`;
      return row.y;
    })
    .then(
      (value) => value,
      (error) => error.code
    );
  return ["1 2", `${x} ${y}`, await sql.end()];
});

t(
  "onread: false reads through the socket stream instead of a shared buffer",
  async () => {
    const sql = postgres({ ...options, max: 1, onread: false });
    const [{ x }] = await sql`select 1 as x`;
    const rows = await sql`select generate_series(1, 20000) as n`;
    return ["1,20000", [x, rows.length].join(","), await sql.end()];
  }
);

t("sql.stats is current, not a snapshot from creation", async () => {
  const sql = postgres({ ...options, max: 2 });
  const before = sql.stats.connections;
  const queries = Promise.all([
    sql`select pg_sleep(0.2)`,
    sql`select pg_sleep(0.2)`,
  ]);
  await delay(100);
  const during = sql.stats;
  await queries;
  const after = sql.stats;
  return [
    "0 2 0 2",
    [before, during.connections, during.idle, after.idle].join(" "),
    await sql.end(),
  ];
});

t(
  "A socket error without a close rejects the query in flight instead of hanging (#1246, #1089)",
  { timeout: 5 },
  async () => {
    let raw;
    const sql = postgres({
      ...options,
      max: 1,
      socket: () =>
        (raw = net.connect(options.port || 5432, options.host || "localhost")),
    });
    await sql`select 1`;
    const q = sql`select pg_sleep(2)`.then(
      () => "done",
      (queryError) => queryError.code
    );
    await delay(100);
    raw.emit("error", new Error("half open"));
    const start = Date.now();
    const result = await q;
    const fast = Date.now() - start < 1000;
    const [{ x }] = await sql`select 1 as x`;
    return [
      "CONNECTION_CLOSED true 1",
      `${result} ${fast} ${x}`,
      await sql.end(),
    ];
  }
);

t(
  "Queries keep working after the backend dies under a burst of pipelined writes (#1250)",
  { timeout: 10 },
  async () => {
    const sql = postgres({ ...options, max: 1 });
    const [{ pid }] = await sql`select pg_backend_pid() as pid`;
    const burst = Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        sql`select ${i}::int as x`.then(
          () => "ok",
          (queryError) => queryError.code
        )
      )
    );
    const other = postgres({ ...options, max: 1 });
    await other`select pg_terminate_backend(${pid})`;
    const settled = await burst;
    const gone = async () => {
      const rows =
        await other`select 1 from pg_stat_activity where pid = ${pid}`;
      if (rows.length) {
        await delay(10);
        await gone();
      }
    };
    await gone();
    await delay(50);
    await other.end();
    const [{ x }] = await sql`select 1 as x`;
    return [true, settled.length === 200 && x === 1, await sql.end()];
  }
);

const i32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const msg = (type, body) =>
  Buffer.concat([Buffer.from(type), i32(body.length + 4), body]);
const z = (x) => Buffer.from(`${x}\0`);

const lyingServer = (final) => {
  const salt = Buffer.from("saltsalt").toString("base64");
  const server = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    let started = false;
    let nonce = null;
    s.on("error", () => {
      // The client may drop the connection mid-handshake: these tests provoke exactly that.
    });
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      let more = true;
      while (more) {
        more = started ? message() : startup();
      }
    });

    const startup = () => {
      if (buf.length < 8 || buf.length < buf.readInt32BE(0)) {
        return false;
      }

      const code = buf.readInt32BE(4);
      buf = buf.subarray(buf.readInt32BE(0));
      if (code === 80_877_103) {
        s.write("N");
      } else {
        started = true;
        s.write(msg("R", Buffer.concat([i32(10), z("SCRAM-SHA-256"), z("")])));
      }
      return true;
    };

    const message = () => {
      if (buf.length < 5 || buf.length < buf.readInt32BE(1) + 1) {
        return false;
      }

      const type = String.fromCodePoint(buf[0]);
      const body = buf.subarray(5, buf.readInt32BE(1) + 1);
      buf = buf.subarray(buf.readInt32BE(1) + 1);
      if (type === "p" && !nonce) {
        ({ nonce } = /r=(?<nonce>[^,\0]+)/u.exec(body.toString()).groups);
        s.write(
          msg(
            "R",
            Buffer.concat([
              i32(11),
              Buffer.from(`r=${nonce}srv,s=${salt},i=4096`),
            ])
          )
        );
      } else if (type === "p") {
        s.write(
          Buffer.concat([
            ...(final
              ? [
                  msg(
                    "R",
                    Buffer.concat([
                      i32(12),
                      Buffer.from(
                        `v=${Buffer.from("not the signature").toString(
                          "base64"
                        )}`
                      ),
                    ])
                  ),
                ]
              : []),
            msg("R", i32(0)),
            msg("K", Buffer.concat([i32(1), i32(2)])),
            msg("Z", Buffer.from("I")),
          ])
        );
      } else if (type === "X") {
        s.end();
      }
      return true;
    };
  });
  return listening(server);
};

t("A server whose SCRAM signature is wrong is not trusted", async () => {
  const server = await lyingServer(true);
  const sql = postgres({
    db: "d",
    fetch_types: false,
    host: "127.0.0.1",
    max: 1,
    pass: "p",
    port: server.address().port,
    user: "u",
  });
  const code = await sql`select 1`.then(
    () => "connected",
    (error) => error.code
  );
  await sql.end({ timeout: 0 });
  server.close();
  return ["SASL_SIGNATURE_MISMATCH", code];
});

t("A server that ends SCRAM without its signature is not trusted", async () => {
  const server = await lyingServer(false);
  const sql = postgres({
    db: "d",
    fetch_types: false,
    host: "127.0.0.1",
    max: 1,
    pass: "p",
    port: server.address().port,
    user: "u",
  });
  const code = await sql`select 1`.then(
    () => "connected",
    (error) => error.code
  );
  await sql.end({ timeout: 0 });
  server.close();
  return ["SASL_SIGNATURE_MISMATCH", code];
});

t(
  "A cancel request on a TLS connection is sent over TLS",
  { timeout: 10 },
  async () => {
    const firsts = [];
    const server = net.createServer((c) => {
      const up = net.connect(options.port || 5432, options.host || "localhost");
      let first = true;
      c.on("data", (d) => {
        if (first) {
          firsts.push(d.readInt32BE(4));
        }
        first = false;
        up.write(d);
      });
      up.on("data", (d) => c.write(d));
      up.on("error", () => c.destroy());
      c.on("error", () => up.destroy());
      up.on("close", () => c.destroy());
      c.on("close", () => up.destroy());
    });
    await listening(server, "localhost");
    const sql = postgres({
      ...options,
      host: "localhost",
      max: 1,
      port: server.address().port,
      ssl: "require",
    });
    await sql`select 1`;
    const q = sql`select pg_sleep(2)`;
    setTimeout(() => q.cancel(), 200);
    const code = await q.then(
      () => "not cancelled",
      (cancelError) => cancelError.code
    );
    await sql.end();
    server.close();
    return ["57014 80877103,80877103", `${code} ${firsts.join(",")}`];
  }
);

t(
  "sql.close() lets a running transaction and a reserved connection finish first",
  async () => {
    const sql = postgres(options);
    await sql`create table test (a int)`;
    const tx = sql
      .begin(async (transaction) => {
        await transaction`insert into test values (1)`;
        await delay(200);
        await transaction`insert into test values (2)`;
        return "committed";
      })
      .catch((beginError) => beginError.code);
    await delay(50);
    const closed = sql.close();
    const result = await tx;
    await closed;
    const [{ n }] = await sql`select count(*)::int as n from test`;
    const reserved = await sql.reserve();
    await reserved`select 1`;
    const closing = sql.close();
    const after = await reserved`select 1 as x`.then(
      (x) => x[0].x,
      (error) => error.code
    );
    reserved.release();
    await closing;
    return [
      "committed 2 1",
      `${result} ${n} ${after}`,
      await sql`drop table test`,
      await sql.end(),
    ];
  }
);

t(
  "With several hosts every new connection tries the first host first, as in v3",
  async () => {
    const hosts = `localhost:${options.port || 5432},localhost:5433`;
    const sql = postgres({
      ...options,
      db: "postgres",
      host: hosts,
      max: 3,
      pass: "",
      user: "postgres",
    });
    const ports = [];
    const reserved = [];
    await series([0, 1, 2], async () => {
      const r = await sql.reserve();
      reserved.push(r);
      const [{ p }] = await r`select inet_server_port() as p`;
      ports.push(p);
    });
    for (const r of reserved) {
      r.release();
    }
    const first = options.port || 5432;
    return [[first, first, first].join(","), ports.join(","), await sql.end()];
  }
);

t(
  "A query waiting while new connections fail and the only one is reserved is rejected instead of waiting forever",
  { timeout: 10 },
  async () => {
    const admin = postgres({ ...options, max: 1, pass: "", user: "postgres" });
    await admin`drop role if exists postgres_js_test_limit`;
    await admin`create role postgres_js_test_limit login connection limit 1`;
    const sql = postgres({
      ...options,
      connect_timeout: 1,
      host: process.env.PGSOCKET || "/tmp",
      max: 2,
      pass: "",
      user: "postgres_js_test_limit",
    });
    const reserved = await sql.reserve();
    const code = await sql`select 1`.then(
      () => "ran",
      (error) => error.code
    );
    reserved.release();
    await sql.end();
    await admin`drop role postgres_js_test_limit`;
    return ["53300", code, await admin.end()];
  }
);

t(
  "Falsy connection parameters are left out of the startup message, as in v3",
  async () => {
    const sql = postgres({ ...options, connection: { search_path: "" } });
    const [{ search_path }] = await sql`show search_path`;
    return ['"$user", public', search_path, await sql.end()];
  }
);

t(
  "sql.options.parsers and sql.options.serializers are objects keyed by oid",
  async () => {
    const sql = postgres(options);
    const { parsers, serializers } = sql.options;
    return [
      "5 true true",
      [
        parsers[23]("5"),
        Object.keys(parsers).length > 0,
        typeof serializers[23] === "function",
      ].join(" "),
      await sql.end(),
    ];
  }
);

t(
  "Queries and transactions fail fast with the connection error while connections keep failing",
  async () => {
    const sql = postgres({ ...options, max: 2, port: 1 });
    const times = [];
    await series([0, 1, 2, 3], async () => {
      const start = Date.now();
      times.push(
        await sql`select 1`.catch((error) => error.code),
        Date.now() - start
      );
    });
    await series([0, 1, 2], async () => {
      const start = Date.now();
      times.push(
        await sql.begin((tx) => tx`select 1`).catch((error) => error.code),
        Date.now() - start
      );
    });
    const codes = times.filter((x, i) => i % 2 === 0);
    const slow = times.filter((x, i) => i % 2 === 1 && i > 3 && x > 200);
    await sql.end();
    return [
      "true x7, slow 0",
      `${codes.every((x) => x === "ECONNREFUSED")} x${codes.length}, slow ${
        slow.length
      }`,
    ];
  }
);

t("Errors from fast failures are separate objects for each query", async () => {
  const sql = postgres({ ...options, port: 1 });
  const errors = [];
  await series([0, 1, 2, 3], async (i) => {
    errors.push(await sql.unsafe(`select ${i}`).catch((error) => error));
  });
  await sql.end();
  return [
    "true",
    String(
      new Set(errors).size === errors.length &&
        errors.every(
          (e, i) =>
            e.query === `select ${i}` &&
            typeof e.stack === "string" &&
            e.code === "ECONNREFUSED"
        )
    ),
  ];
});

t(
  "A failed connection attempt does not give up on queries a connection still loading types will serve",
  { timeout: 10 },
  async () => {
    const admin = postgres({ ...options, max: 1, pass: "", user: "postgres" });
    await admin`drop role if exists postgres_js_test_loading`;
    await admin`create role postgres_js_test_loading login connection limit 1`;
    const sql = postgres({
      ...options,
      connect_timeout: 1,
      host: process.env.PGSOCKET || "/tmp",
      max: 2,
      pass: "",
      user: "postgres_js_test_loading",
    });
    const results = await Promise.all([
      sql`select 1 as x`.then(
        (x) => x[0].x,
        (error) => error.code
      ),
      sql.reserve().then(
        (r) => {
          r.release();
          return "reserved";
        },
        (error) => error.code
      ),
    ]);
    await sql.end();
    await admin`drop role postgres_js_test_loading`;
    return ["1,reserved", results.join(","), await admin.end()];
  }
);

t(
  "Connections refused for too many connections are retried until connect_timeout",
  { timeout: 10 },
  async () => {
    const admin = postgres({ ...options, max: 1, pass: "", user: "postgres" });
    await admin`drop role if exists postgres_js_test_burst`;
    await admin`create role postgres_js_test_burst login connection limit 0`;
    const sql = postgres({
      ...options,
      connect_timeout: 5,
      host: process.env.PGSOCKET || "/tmp",
      max: 4,
      pass: "",
      user: "postgres_js_test_burst",
    });
    const results = Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        sql`select ${i}::int as x`.then(
          (x) => x[0].x,
          (queryError) => queryError.code
        )
      )
    );
    await delay(300);
    await admin`alter role postgres_js_test_burst connection limit 1`;
    const values = await results;
    const got = values.join(",");
    await sql.end();
    await admin`drop role postgres_js_test_burst`;
    return ["0,1,2,3", got, await admin.end()];
  }
);

t(
  "Connections refused for too many connections reject once connect_timeout has passed",
  { timeout: 10 },
  async () => {
    const admin = postgres({ ...options, max: 1, pass: "", user: "postgres" });
    await admin`drop role if exists postgres_js_test_none`;
    await admin`create role postgres_js_test_none login connection limit 0`;
    const sql = postgres({
      ...options,
      connect_timeout: 0.5,
      host: process.env.PGSOCKET || "/tmp",
      max: 2,
      pass: "",
      user: "postgres_js_test_none",
    });
    const start = Date.now();
    const code = await sql`select 1`.then(
      () => "ran",
      (error) => error.code
    );
    const waited = Date.now() - start;
    await sql.end();
    await admin`drop role postgres_js_test_none`;
    return [
      "53300 true",
      `${code} ${waited >= 400 && waited < 4000}`,
      await admin.end(),
    ];
  }
);

const unrefScript = (idle) =>
  [
    `const postgres = (await import(${JSON.stringify(
      new URL("../src/index.js", import.meta.url).href
    )})).default`,
    `const sql = postgres(${JSON.stringify({
      ...options,
      idle_timeout: 60,
      unref_sockets: idle,
    })})`,
    "await sql`select 1`",
    "await sql.begin(sql => sql`select 2`)",
    'console.log("done")',
  ].join("\n");

t(
  "unref_sockets lets the process exit while connections are idle",
  { timeout: 20 },
  async () => {
    const [unref, kept] = await Promise.all([
      exits(unrefScript(true)),
      exits(unrefScript(false)),
    ]);
    return ["done true false", `${unref.out} ${unref.exited} ${kept.exited}`];
  }
);

t("sql and reserved connections are async disposable", async () => {
  const sql = postgres(options);
  const reserved = await sql.reserve();
  await reserved`select 1`;
  await reserved[Symbol.asyncDispose]();
  const released = await reserved`select 1`.then(
    () => "ran",
    (error) => error.code
  );
  await sql[Symbol.asyncDispose]();
  return [
    "UNSAFE_TRANSACTION CONNECTION_ENDED",
    `${released} ${await sql`select 1`.then(
      () => "ran",
      (error) => error.code
    )}`,
  ];
});

const exits = async (source) => {
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { default: path } = await import("node:path");
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "unref-")),
    "x.mjs"
  );
  fs.writeFileSync(file, source);
  const child = spawn(
    process.execPath,
    typeof Deno === "undefined" ? [file] : ["run", "-A", file],
    { env: process.env }
  );
  let out = "";
  child.stdout.on("data", (x) => (out += x));
  const { promise: exit, resolve } = Promise.withResolvers();
  const timer = setTimeout(() => {
    child.kill();
    resolve(false);
  }, 5000);
  child.on("exit", () => {
    clearTimeout(timer);
    resolve(true);
  });
  const exited = await exit;
  fs.rmSync(path.dirname(file), { force: true, recursive: true });
  return { exited, out: out.trim() };
};

const listening = (server, host = "127.0.0.1") => {
  const { promise, resolve } = Promise.withResolvers();
  server.listen(0, host, () => resolve(server));
  return promise;
};

t("user can be a function, called for each connection", async () => {
  let calls = 0;
  const sql = postgres({
    ...options,
    max: 2,
    user: () => {
      calls += 1;
      return Promise.resolve(login.user);
    },
  });
  const users = await Promise.all([
    sql`select current_user as u, pg_sleep(0.05)`,
    sql`select current_user as u, pg_sleep(0.05)`,
  ]);
  return [
    `${login.user} ${login.user} 2`,
    `${users.map((x) => x[0].u).join(" ")} ${calls}`,
    await sql.end(),
  ];
});

t(
  "min keeps that many connections open once the pool is used",
  { timeout: 10 },
  async () => {
    const sql = postgres({ ...options, idle_timeout: 0.2, max: 4, min: 2 });
    const before = sql.stats.connections;
    await sql`select 1`;
    await delay(100);
    const opened = sql.stats.connections;
    await Promise.all([1, 2, 3, 4].map(() => sql`select pg_sleep(0.1)`));
    const busy = sql.stats.connections;
    await delay(800);
    return [
      "0 2 4 2",
      [before, opened, busy, sql.stats.connections].join(" "),
      await sql.end(),
    ];
  }
);

t("One query on a cold pool opens one connection", async () => {
  const sql = postgres({ ...options, max: 4 });
  await sql`select 1`;
  await delay(100);
  return [1, sql.stats.connections, await sql.end()];
});

t("A password from PGPASSFILE, as libpq reads it (#964)", async () => {
  const lines = [
    "# comment",
    "otherhost:*:*:*:wrong",
    `*:*:*:${login_md5.user}:${login_md5.pass.replaceAll(":", "\\:")}`,
  ];
  return [
    "1",
    await passfile(lines.join("\n"), 0o600, (sql) =>
      sql`select 1 as x`.then((x) => String(x[0].x))
    ),
  ];
});

t("A password file readable by others is ignored, as in libpq", async () => [
  "28P01",
  await passfile(`*:*:*:${login_md5.user}:${login_md5.pass}`, 0o644, (sql) =>
    sql`select 1`.then(
      () => "ran",
      (error) => error.code
    )
  ),
]);

const passfile = async (content, mode, fn) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { default: path } = await import("node:path");
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "pgpass-")),
    "pgpass"
  );
  const before = process.env.PGPASSFILE;
  fs.writeFileSync(file, content);
  fs.chmodSync(file, mode);
  process.env.PGPASSFILE = file;
  const sql = postgres({ ...options, pass: undefined, user: login_md5.user });
  try {
    return await fn(sql);
  } finally {
    if (before === undefined) {
      delete process.env.PGPASSFILE;
    } else {
      process.env.PGPASSFILE = before;
    }
    await sql.end();
    fs.rmSync(path.dirname(file), { force: true, recursive: true });
  }
};

t(
  "queue_timeout rejects a query that waits too long for a connection, without sending it",
  { timeout: 10 },
  async () => {
    const sql = postgres({ ...options, max: 1, queue_timeout: 0.2 });
    const reserved = await sql.reserve();
    const start = Date.now();
    const code = await sql`select 1`.then(
      () => "ran",
      (error) => error.code
    );
    const waited = Date.now() - start;
    reserved.release();
    const after = await sql`select 1 as x`;
    return [
      "QUEUE_TIMEOUT true 1",
      `${code} ${waited >= 150 && waited < 500} ${after[0].x}`,
      await sql.end(),
    ];
  }
);

t(
  "queue_timeout applies to transactions and reserves waiting for a connection",
  { timeout: 10 },
  async () => {
    const sql = postgres({ ...options, max: 1, queue_timeout: 0.2 });
    const reserved = await sql.reserve();
    const codes = [
      await sql
        .begin((tx) => tx`select 1`)
        .then(
          () => "ran",
          (error) => error.code
        ),
      await sql.reserve().then(
        () => "reserved",
        (error) => error.code
      ),
    ];
    reserved.release();
    return ["QUEUE_TIMEOUT QUEUE_TIMEOUT", codes.join(" "), await sql.end()];
  }
);

t(
  "A query that waits less than queue_timeout runs",
  { timeout: 10 },
  async () => {
    const sql = postgres({ ...options, max: 1, queue_timeout: 1 });
    const reserved = await sql.reserve();
    const query = sql`select 1 as x`;
    setTimeout(() => reserved.release(), 200);
    const [{ x }] = await query;
    return [1, x, await sql.end()];
  }
);

const hushable = async () => {
  const sockets = new Set();
  let hushed = false;
  const server = net.createServer((client) => {
    sockets.add(client);
    const upstream = net.connect(
      options.port || 5432,
      options.host || "localhost"
    );
    sockets.add(upstream);
    client.on("data", (x) => hushed === true || upstream.write(x));
    upstream.on("data", (x) => hushed || client.write(x));
    client.on("error", () => null);
    upstream.on("error", () => null);
    client.on("close", () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
  });
  await listening(server, "localhost");
  return {
    close: () => {
      for (const x of sockets) {
        x.destroy();
      }
      server.close();
    },
    hush: (x) => (hushed = x),
    port: server.address().port,
  };
};

t(
  "query_timeout cancels a query that runs too long and keeps the connection",
  { timeout: 10 },
  async () => {
    const sql = postgres({ ...options, max: 1, query_timeout: 0.2 });
    const [{ pid }] = await sql`select pg_backend_pid() as pid`;
    const start = Date.now();
    const error = await sql`select pg_sleep(2)`.catch(
      (queryError) => queryError
    );
    const took = Date.now() - start;
    const [after] = await sql`select pg_backend_pid() as pid`;
    return [
      "QUERY_TIMEOUT 57014 true true",
      [
        error.code,
        error.cause && error.cause.code,
        took < 1000,
        after.pid === pid,
      ].join(" "),
      await sql.end(),
    ];
  }
);

t(
  "query_timeout rejects a query whose server stops answering, and the next query gets a new connection",
  { timeout: 10 },
  async () => {
    const relay = await hushable();
    const sql = postgres({
      ...options,
      cancel_timeout: 0.3,
      host: "localhost",
      max: 1,
      port: relay.port,
      query_timeout: 0.2,
    });
    await sql`select 1`;
    relay.hush(true);
    const start = Date.now();
    const [error, other] = await Promise.all([
      sql`select 1`.catch((queryError) => queryError),
      sql`select 2`.catch((queryError) => queryError),
    ]);
    const took = Date.now() - start;
    relay.hush(false);
    const [after] = await sql`select 1 as x`;
    relay.close();
    return [
      "QUERY_TIMEOUT CANCEL_UNANSWERED QUERY_TIMEOUT true 1",
      [
        error.code,
        error.cause && error.cause.code,
        other.code,
        took >= 400 && took < 2000,
        after.x,
      ].join(" "),
      await sql.end(),
    ];
  }
);

t(
  "An AbortSignal rejects a query whose server stops answering",
  { timeout: 10 },
  async () => {
    const relay = await hushable();
    const sql = postgres({
      ...options,
      cancel_timeout: 0.3,
      host: "localhost",
      max: 1,
      port: relay.port,
    });
    await sql`select 1`;
    relay.hush(true);
    const start = Date.now();
    const error = await sql`select 1`
      .signal(AbortSignal.timeout(200))
      .catch((queryError) => queryError);
    const took = Date.now() - start;
    relay.hush(false);
    const [after] = await sql`select 1 as x`;
    relay.close();
    return [
      "CONNECTION_DESTROYED CANCEL_UNANSWERED true 1",
      [error.code, error.cause && error.cause.code, took < 2000, after.x].join(
        " "
      ),
      await sql.end(),
    ];
  }
);

t(
  "Cancelling a query whose server stops answering settles both the query and the cancel",
  { timeout: 10 },
  async () => {
    const relay = await hushable();
    const sql = postgres({
      ...options,
      cancel_timeout: 0.3,
      host: "localhost",
      max: 1,
      port: relay.port,
    });
    await sql`select 1`;
    relay.hush(true);
    const head = sql`select 1`;
    const next = sql`select 2`;
    const codes = Promise.all(
      [head, next].map((q) =>
        q.then(
          () => "ran",
          (queryError) => queryError.code
        )
      )
    );
    await delay(50);
    await Promise.all([head.cancel(), next.cancel()]);
    const result = await codes;
    relay.hush(false);
    const [after] = await sql`select 1 as x`;
    relay.close();
    return [
      "CONNECTION_DESTROYED CONNECTION_DESTROYED 1",
      [...result, after.x].join(" "),
      await sql.end(),
    ];
  }
);

t(
  "A timed out query whose answer is lost rejects as unknown, not as canceled",
  { timeout: 10 },
  async () => {
    const relay = await hushable();
    const sql = postgres({
      ...options,
      cancel_timeout: 0.3,
      host: "localhost",
      max: 1,
      port: relay.port,
      query_timeout: 0.2,
    });
    await sql`create table test (id int)`;
    relay.hush("answers");
    const error = await sql`insert into test values (1)`.catch(
      (queryError) => queryError
    );
    relay.hush(false);
    const [{ n }] = await sql`select count(*)::int as n from test`;
    await sql`drop table test`;
    await sql.end();
    relay.close();
    return [
      "QUERY_TIMEOUT CANCEL_UNANSWERED 1",
      [error.code, error.cause && error.cause.code, n].join(" "),
    ];
  }
);

t(
  "query_timeout ends a transaction whose server stops answering at COMMIT, and the pool goes on",
  { timeout: 10 },
  async () => {
    const relay = await hushable();
    const sql = postgres({
      ...options,
      cancel_timeout: 0.3,
      connect_timeout: 0,
      host: "localhost",
      max: 1,
      port: relay.port,
      query_timeout: 0.2,
    });
    await sql`select 1`;
    const error = await sql
      .begin(async (tx) => {
        await tx`select 1`;
        relay.hush(true);
      })
      .catch((beginError) => beginError);
    relay.hush(false);
    const [after] = await sql`select 1 as x`;
    relay.close();
    return [
      "CONNECTION_CLOSED 1",
      [error.code, after.x].join(" "),
      await sql.end(),
    ];
  }
);

t(
  "query_timeout rejects a describe whose server stops answering",
  { timeout: 10 },
  async () => {
    const relay = await hushable();
    const sql = postgres({
      ...options,
      cancel_timeout: 0.3,
      host: "localhost",
      max: 1,
      port: relay.port,
      query_timeout: 0.2,
    });
    await sql`select 1`;
    relay.hush(true);
    const error = await sql`select ${1}::int as x`
      .describe()
      .catch((queryError) => queryError);
    relay.hush(false);
    const [after] = await sql`select 1 as x`;
    relay.close();
    return [
      "QUERY_TIMEOUT 1",
      [error.code, after.x].join(" "),
      await sql.end(),
    ];
  }
);

t(
  "query_timeout cancels a batch that runs too long",
  { timeout: 10 },
  async () => {
    const sql = postgres({ ...options, max: 1, query_timeout: 0.2 });
    const error = await sql
      .batch([sql`select 1`, sql`select pg_sleep(2)`])
      .catch((queryError) => queryError);
    const [after] = await sql`select 1 as x`;
    return [
      "QUERY_TIMEOUT 1",
      [error.code, after.x].join(" "),
      await sql.end(),
    ];
  }
);

t(
  "query_timeout rejects a batch whose server stops answering",
  { timeout: 10 },
  async () => {
    const relay = await hushable();
    const sql = postgres({
      ...options,
      cancel_timeout: 0.3,
      host: "localhost",
      max: 1,
      port: relay.port,
      query_timeout: 0.2,
    });
    await sql`select 1`;
    relay.hush(true);
    const error = await sql
      .batch([sql`select 1`, sql`select 2`])
      .catch((queryError) => queryError);
    relay.hush(false);
    const [after] = await sql`select 1 as x`;
    relay.close();
    return [
      "QUERY_TIMEOUT CANCEL_UNANSWERED 1",
      [error.code, error.cause && error.cause.code, after.x].join(" "),
      await sql.end(),
    ];
  }
);

t(
  "A cancel request that fails over TLS does not crash the process, for query_timeout and signal",
  { timeout: 15 },
  async () => {
    const relay = await hushable();
    const connect = (extra) =>
      postgres({
        ...options,
        cancel_timeout: 0.5,
        host: "localhost",
        max: 1,
        port: relay.port,
        ssl: "require",
        ...extra,
      });
    const timed = connect({ query_timeout: 0.2 });
    const signalled = connect();
    await Promise.all([timed`select 1`, signalled`select 1`]);
    relay.hush(true);
    const result = await Promise.all([
      timed`select 1`.catch(
        (error) => `${error.code} ${error.cause && error.cause.code}`
      ),
      signalled`select 1`
        .signal(AbortSignal.timeout(200))
        .catch((error) => `${error.code} ${error.cause && error.cause.code}`),
    ]);
    relay.hush(false);
    relay.close();
    return [
      "QUERY_TIMEOUT CANCEL_UNANSWERED,CONNECTION_DESTROYED CANCEL_UNANSWERED",
      result.join(","),
      await timed.end({ timeout: 0 }),
      await signalled.end({ timeout: 0 }),
    ];
  }
);

t(
  "A query that times out while pipelined does not cancel the query after it",
  { timeout: 20 },
  async () => {
    const sql = postgres({ ...options, max: 1, query_timeout: 0.3 });
    await sql`select 1`;
    const outcomes = [];
    await series([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], async (i) => {
      const slow = sql`select pg_sleep(0.4)`.then(
        () => "ok",
        (queryError) => queryError.code
      );
      const fast = sql`select ${i}::int as x`.then(
        () => "ok",
        (queryError) => queryError.code
      );
      await delay(150);
      const third = sql`select pg_sleep(0.1), ${i}::int as y`.then(
        () => "ok",
        (queryError) => queryError.code
      );
      outcomes.push([await slow, await fast, await third].join("/"));
    });
    return [
      "QUERY_TIMEOUT/ok/ok",
      [...new Set(outcomes)].join(","),
      await sql.end(),
    ];
  }
);

t(
  "A timed out query waiting behind an untimed one is ended when the server goes silent",
  { timeout: 15 },
  async () => {
    const relay = await hushable();
    const sql = postgres({
      ...options,
      cancel_timeout: 0.4,
      host: "localhost",
      max: 1,
      port: relay.port,
      query_timeout: 0.3,
    });
    let behind = null;
    const start = Date.now();
    const error = await sql
      .begin(async (tx) => {
        await tx`select x from generate_series(1, 2) x`.cursor(async () => {
          if (behind) {
            return;
          }
          relay.hush(true);
          behind = tx`select 1`.catch((queryError) => queryError);
          await behind;
        });
      })
      .catch((queryError) => queryError);
    const timed = await behind;
    const took = Date.now() - start;
    relay.hush(false);
    const [{ x }] = await sql`select 1 as x`;
    relay.close();
    return [
      "QUERY_TIMEOUT CANCEL_UNANSWERED true true 1",
      [
        timed.code,
        timed.cause && timed.cause.code,
        !!error,
        took < 5000,
        x,
      ].join(" "),
      await sql.end(),
    ];
  }
);

t(
  "A query waiting for types that times out rejects without closing its connection, and the type read is bounded",
  { timeout: 15 },
  async () => {
    await shared`create type test_mood as enum ('ok', 'sad')`;
    const proxy = net.createServer((client) => {
      const server = net.connect(
        options.port || 5432,
        options.host || "localhost"
      );
      client.on(
        "data",
        (x) => x.includes("pg_catalog.pg_type") || server.write(x)
      );
      server.on("data", (x) => client.writable && client.write(x));
      client.on("error", () => server.destroy());
      server.on("error", () => client.destroy());
      client.on("close", () => server.destroy());
    });
    await listening(proxy, "localhost");
    const lazy = postgres({
      ...options,
      cancel_timeout: 0.3,
      connect_timeout: 1,
      host: "localhost",
      max: 1,
      port: proxy.address().port,
      query_timeout: 0.3,
    });
    const [{ pid }] = await lazy`select pg_backend_pid() as pid`;
    const error = await lazy`select '{ok,sad}'::test_mood[] as m`.catch(
      (queryError) => queryError
    );
    const [after] = await lazy`select pg_backend_pid() as pid`;
    await lazy.end({ timeout: 0 });
    proxy.close();
    return [
      "QUERY_TIMEOUT true",
      `${error.code} ${after.pid === pid}`,
      await shared`drop type test_mood`,
    ];
  }
);

t(
  "query_timeout counts the time a query waits for a connection",
  { timeout: 10 },
  async () => {
    const sql = postgres({ ...options, max: 1, query_timeout: 0.2 });
    const reserved = await sql.reserve();
    const error = await sql`select 1`.catch((queryError) => queryError);
    reserved.release();
    const [after] = await sql`select 1 as x`;
    return [
      "QUERY_TIMEOUT 57014 1",
      [error.code, error.cause && error.cause.code, after.x].join(" "),
      await sql.end(),
    ];
  }
);

t(
  "query_timeout times each query in a transaction, not the transaction",
  { timeout: 10 },
  async () => {
    const sql = postgres({ ...options, max: 1, query_timeout: 0.3 });
    const result = await sql.begin(async (tx) => {
      await tx`select pg_sleep(0.1)`;
      await delay(200);
      await tx`select pg_sleep(0.1)`;
      await delay(200);
      const [{ x }] = await tx`select 1 as x`;
      return x;
    });
    return [1, result, await sql.end()];
  }
);

t(
  "query_timeout does not time cursors or listen",
  { timeout: 10 },
  async () => {
    const sql = postgres({ ...options, max: 2, query_timeout: 0.2 });
    let rows = 0;
    await sql`select x from generate_series(1, 3) x`.cursor(async () => {
      rows += 1;
      await delay(150);
    });
    let got = null;
    const { unlisten } = await sql.listen("qt", (x) => (got = x));
    await delay(300);
    await sql.notify("qt", "hi");
    await delay(100);
    await unlisten();
    return ["3 hi", `${rows} ${got}`, await sql.end()];
  }
);

t(
  "An AbortSignal removes a waiting query and cancels a running one",
  { timeout: 10 },
  async () => {
    const sql = postgres({ ...options, max: 1 });
    const reserved = await sql.reserve();
    const waiting = sql`select 1`.signal(AbortSignal.timeout(100)).then(
      () => "ran",
      (queryError) => queryError.code
    );
    await delay(150);
    reserved.release();
    const running = sql`select pg_sleep(2)`
      .signal(AbortSignal.timeout(200))
      .then(
        () => "ran",
        (queryError) => queryError.code
      );
    const aborted = new AbortController();
    aborted.abort();
    const before = await sql`select 1`.signal(aborted.signal).then(
      () => "ran",
      (error) => error.code
    );
    const ran = await running;
    const waited = await waiting;
    const [{ x }] = await sql`select 1 as x`;
    return [
      "57014 57014 57014 1",
      [ran, waited, before, x].join(" "),
      await sql.end(),
    ];
  }
);

t(
  "A parameter the server reports after startup reaches onparameter and sql.parameters",
  async () => {
    const seen = [];
    const sql = postgres({
      ...options,
      onparameter: (k, v) => k === "application_name" && seen.push(v),
    });
    await sql`set application_name = 'renamed'`;
    return [
      "@boelabs/postgres,renamed renamed",
      `${seen.join(",")} ${sql.parameters.application_name}`,
      await sql.end(),
    ];
  }
);

t("An empty query gives an empty result, simple or prepared", async () => {
  const xs = [
    await shared.unsafe(""),
    await shared.unsafe("", [], { prepare: true }),
    await shared.unsafe(" ; "),
  ];
  return [
    "0:null,0:null,0:null",
    xs.map((x) => `${x.length}:${x.command}`).join(","),
  ];
});

const shortQueryWait = async (scheduler) => {
  const sql = postgres({ ...options, idle_timeout: 0, max: 2, scheduler });
  const slow = () => sql`select pg_sleep(1) as slow`;
  const quick = () => sql`select pg_sleep(0.1) as quick`;
  const short = () => sql`select 1 as short`;
  await Promise.all([slow(), slow()]);
  await Promise.all([quick(), short()]);
  const s = slow().execute();
  await delay(20);
  const q = quick().execute();
  await delay(20);
  const start = Date.now();
  await short();
  const ms = Date.now() - start;
  await Promise.all([s, q]);
  await sql.end();
  return ms;
};

t(
  "A query is pipelined behind the work that should finish first, not behind a long query, unless the scheduler is off",
  { timeout: 20 },
  async () => {
    const [on, off] = [await shortQueryWait(true), await shortQueryWait(false)];
    return ["true true", `${on < 500} ${off > 800}`];
  }
);

t(
  "An identifier that looks like many comments after start does not stall the event loop",
  async () => {
    const sql = postgres({ ...options, max: 2 });
    const column = `start${"/**/".repeat(40)}x`;
    const started = performance.now();
    const code = await sql`select 1 as x order by ${sql(column)}`.then(
      () => "ran",
      (error) => error.code
    );
    return [
      "42703 true",
      `${code} ${performance.now() - started < 1000}`,
      await sql.end(),
    ];
  }
);

t(
  "A NUL character in a startup parameter rejects instead of adding parameters (as another user)",
  async () => {
    const codes = [];
    const attempts = [
      { database: `${options.db}\0user\0postgres` },
      { user: `${login.user}\0database\0postgres` },
      { connection: { application_name: "x\0replication\0database" } },
    ];
    await series(attempts, async (o) => {
      const sql = postgres({ ...options, ...o });
      codes.push(
        await sql`select current_user`.then(
          (x) => x[0].current_user,
          (error) => error.code
        )
      );
      await sql.end({ timeout: 0 });
    });
    return ["NUL_CHARACTER,NUL_CHARACTER,NUL_CHARACTER", codes.join(",")];
  }
);

t(
  "A NUL character in query text is rejected by the server and leaves the connection usable",
  async () => {
    const sql = postgres({ ...options, max: 1 });
    const codes = [
      await sql`select 1 as ${sql("x\0y")}`.then(
        () => "ran",
        (error) => error.code
      ),
      await sql.unsafe("select 1 \0").then(
        () => "ran",
        (error) => error.code
      ),
    ];
    const [{ x }] = await sql`select 1 as x`;
    return ["08P01 08P01 1", `${codes.join(" ")} ${x}`, await sql.end()];
  }
);
