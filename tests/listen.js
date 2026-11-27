import net from "node:net";

import { postgres, options, delay } from "./setup.js";
import { t } from "./test.js";

// Polls one check at a time, each after the previous one and the pause that follows it.
const until = (fn, ms = 5000) => {
  const end = Date.now() + ms;
  const poll = async () => {
    if (await fn()) {
      return;
    }
    if (Date.now() > end) {
      throw new Error("Timed out waiting");
    }
    await delay(10);
    return poll();
  };
  return poll();
};

const ignore = () => {
  // The notifications don't matter to these tests, only the subscription.
};

t("listen and notify", async () => {
  const sql = postgres(options);
  const channel = "hello";
  const notified = Promise.withResolvers();
  await sql.listen(channel, notified.resolve);
  sql.notify(channel, "works");
  const result = await notified.promise;

  return ["works", result, sql.end()];
});

t("double listen", async () => {
  const sql = postgres(options);
  const channel = "hello";

  let count = 0;

  const first = Promise.withResolvers();
  sql
    .listen(channel, first.resolve)
    .then(() => sql.notify(channel, "world"))
    .catch(first.reject);
  await first.promise;
  count += 1;

  const second = Promise.withResolvers();
  sql
    .listen(channel, second.resolve)
    .then(() => sql.notify(channel, "world"))
    .catch(second.reject);
  await second.promise;
  count += 1;

  void sql.listen("weee", ignore).then(sql.end);

  return [2, count];
});

t("multiple listeners work after a reconnect", async () => {
  const sql = postgres(options);
  const xs = [];

  let listens = 0;
  try {
    const s1 = await sql.listen(
      "test",
      (x) => xs.push("1", x),
      () => {
        listens += 1;
      }
    );
    await sql.listen("test", (x) => xs.push("2", x));
    await sql.notify("test", "a");
    await until(() => xs.length === 4);
    await sql`select pg_terminate_backend(${s1.state.pid})`;
    await until(() => listens === 2);
    await sql.notify("test", "b");
    await until(() => xs.length === 8);
    return ["1a2a1b2b", xs.join("")];
  } finally {
    await sql.end();
  }
});

t("listen and notify with weird name", async () => {
  const sql = postgres(options);
  const channel = "wat-;.ø.§";
  const notified = Promise.withResolvers();
  const { unlisten } = await sql.listen(channel, notified.resolve);
  sql.notify(channel, "works");
  const result = await notified.promise;
  await unlisten();

  return ["works", result, sql.end()];
});

t("listen and notify with upper case", async () => {
  const sql = postgres(options);
  const channel = "withUpperChar";
  const notified = Promise.withResolvers();
  await sql.listen(channel, notified.resolve);
  sql.notify(channel, "works");
  const result = await notified.promise;

  return ["works", result, sql.end()];
});

t("listen reconnects", async () => {
  const sql = postgres(options);
  const a = Promise.withResolvers();
  const b = Promise.withResolvers();
  const resolvers = { a: a.resolve, b: b.resolve };

  let connects = 0;

  const {
    state: { pid },
  } = await sql.listen(
    "test",
    (x) => x in resolvers && resolvers[x](),
    () => {
      connects += 1;
    }
  );
  await sql.notify("test", "a");
  await a.promise;
  await sql`select pg_terminate_backend(${pid})`;
  await until(() => connects === 2);
  await sql.notify("test", "b");
  await b.promise;
  sql.end();
  return [connects, 2];
});

t(
  "listen keeps retrying when a reconnect attempt fails",
  { timeout: 20 },
  async () => {
    const admin = postgres({ ...options, max: 1, pass: "", user: "postgres" });
    await admin`drop role if exists postgres_js_test_listen`;
    await admin`create role postgres_js_test_listen login`;
    const sql = postgres({
      ...options,
      backoff: () => 0.1,
      host: process.env.PGSOCKET || "/tmp",
      pass: "",
      user: "postgres_js_test_listen",
    });
    const xs = [];

    let listens = 0;
    try {
      await sql.listen(
        "test",
        (x) => xs.push(x),
        () => {
          listens += 1;
        }
      );
      await admin`alter role postgres_js_test_listen nologin`;
      await admin`select pg_terminate_backend(pid) from pg_stat_activity where usename = 'postgres_js_test_listen'`;
      await delay(500);
      await admin`alter role postgres_js_test_listen login`;
      await until(() => listens === 2);
      await admin.notify("test", "a");
      await until(() => xs.length === 1);
      return ["2 a", `${listens} ${xs[0]}`];
    } finally {
      await sql.end();
      await admin`drop role postgres_js_test_listen`;
      await admin.end();
    }
  }
);

t(
  "listen keeps retrying while a restarting server refuses connections",
  { timeout: 20 },
  async () => {
    const sockets = new Set();
    let server = null;
    const open = (port) => {
      const listening = Promise.withResolvers();
      server = net
        .createServer((client) => {
          const upstream = net.connect(
            options.port || 5432,
            options.host || "localhost"
          );
          sockets.add(client).add(upstream);
          client.pipe(upstream).pipe(client);
          const drop = () => {
            client.destroy();
            upstream.destroy();
          };
          client.on("error", drop).on("close", drop);
          upstream.on("error", drop).on("close", drop);
        })
        .listen(port, "localhost", () =>
          listening.resolve(server.address().port)
        );
      return listening.promise;
    };
    const port = await open(0);
    const sql = postgres({
      ...options,
      backoff: () => 0.1,
      host: "localhost",
      port,
    });
    const xs = [];

    let listens = 0;
    await sql.listen(
      "restart",
      (x) => xs.push(x),
      () => {
        listens += 1;
      }
    );
    for (const x of sockets) {
      x.destroy();
    }
    const closed = Promise.withResolvers();
    server.close(closed.resolve);
    await closed.promise;
    await delay(400);
    await open(port);
    await until(() => listens === 2);
    await sql.notify("restart", "a");
    await until(() => xs.length === 1);
    const result = `${listens} ${xs[0]}`;
    await sql.end();
    for (const x of sockets) {
      x.destroy();
    }
    server.close();
    return ["2 a", result];
  }
);

t(
  "listen result reports correct connection state after reconnection",
  async () => {
    const sql = postgres(options);
    const xs = [];

    const result = await sql.listen("test", (x) => xs.push(x));
    const initialPid = result.state.pid;
    await sql.notify("test", "a");
    await sql`select pg_terminate_backend(${initialPid})`;
    await until(() => result.state.pid && result.state.pid !== initialPid);
    sql.end();

    return [result.state.pid !== initialPid, true];
  }
);

t("unlisten removes subscription", async () => {
  const sql = postgres(options);
  const xs = [];

  const { unlisten } = await sql.listen("test", (x) => xs.push(x));
  await sql.notify("test", "a");
  await until(() => xs.length === 1);
  await unlisten();
  await sql.notify("test", "b");
  await delay(50);
  sql.end();

  return ["a", xs.join("")];
});

t("listen after unlisten", async () => {
  const sql = postgres(options);
  const xs = [];

  const { unlisten } = await sql.listen("test", (x) => xs.push(x));
  await sql.notify("test", "a");
  await until(() => xs.length === 1);
  await unlisten();
  await sql.notify("test", "b");
  await delay(50);
  await sql.listen("test", (x) => xs.push(x));
  await sql.notify("test", "c");
  await until(() => xs.length === 2);
  sql.end();

  return ["ac", xs.join("")];
});

t("multiple listeners and unlisten one", async () => {
  const sql = postgres(options);
  const xs = [];

  await sql.listen("test", (x) => xs.push("1", x));
  const s2 = await sql.listen("test", (x) => xs.push("2", x));
  await sql.notify("test", "a");
  await until(() => xs.length === 4);
  await s2.unlisten();
  await sql.notify("test", "b");
  await until(() => xs.length === 6);
  await delay(50);
  sql.end();

  return ["1a2a1b", xs.join("")];
});

t("Listen connection closes after the last unlisten", async () => {
  const sql = postgres(options);
  const {
    state: { pid },
    unlisten,
  } = await sql.listen("test", ignore);
  await unlisten();
  const gone = async () => {
    const [{ n }] =
      await sql`select count(*)::int as n from pg_stat_activity where pid = ${pid}`;
    return n === 0;
  };
  await until(gone);
  return [true, await gone(), await sql.end()];
});

t("Original listen handles unsubscribe after a reconnect", async () => {
  const sql = postgres(options);
  const xs = [];
  const a = Promise.withResolvers();
  const b = Promise.withResolvers();
  const c = Promise.withResolvers();
  const arrivals = { a: a.resolve, b: b.resolve, c: c.resolve };
  let registrations = 0;

  const reconnected = Promise.withResolvers();

  try {
    const s1 = await sql.listen(
      "test",
      (x) => xs.push("1", x),
      () => {
        registrations += 1;
        if (registrations === 2) {
          reconnected.resolve();
        }
      }
    );
    const s2 = await sql.listen("test", (x) => {
      xs.push("2", x);
      arrivals[x]();
    });
    await sql.notify("test", "a");
    await a.promise;
    await sql`select pg_terminate_backend(${s1.state.pid})`;
    await reconnected.promise;
    await sql.notify("test", "b");
    await b.promise;
    await s1.unlisten();
    await sql.notify("test", "c");
    await c.promise;
    await s2.unlisten();
    const [{ available }] = await sql`select 1 as available`;
    const [{ retained }] = await sql`
      select count(*)::int as retained from pg_stat_activity
      where pid = ${s2.state.pid} and query ilike 'listen %'
    `;
    return ["1a2a1b2b2c:1:0", `${xs.join("")}:${available}:${retained}`];
  } finally {
    await sql.end();
  }
});

t("Unlisten while reconnecting keeps only the other listener", async () => {
  const sql = postgres(options);
  const callbacks = [];
  let first = 0;
  let second = 0;

  const unlistened = Promise.withResolvers();
  const arrived = Promise.withResolvers();

  try {
    await sql.listen(
      "test",
      () => {
        callbacks.push("first");
        arrived.resolve();
      },
      () => {
        first += 1;
        if (first === 2) {
          return b.unlisten().then(unlistened.resolve);
        }
      }
    );
    const b = await sql.listen(
      "test",
      () => callbacks.push("second"),
      () => {
        second += 1;
      }
    );
    await sql`select pg_terminate_backend(${b.state.pid})`;
    await unlistened.promise;
    await sql.notify("test", "after");
    await arrived.promise;
    return ["first:1", `${callbacks.join(",")}:${second}`];
  } finally {
    await sql.end();
  }
});

t(
  "A listener that throws keeps its connection and gets the next notification",
  async () => {
    const sql = postgres(options);
    const got = [];
    let onlisten = 0;
    await sql.listen(
      "throwing",
      (x) => {
        got.push(x);
        if (x === "throw") {
          throw new Error("listener throws");
        }
      },
      () => {
        onlisten += 1;
      }
    );
    await sql.notify("throwing", "throw");
    await until(() => got.length === 1);
    await sql.notify("throwing", "after");
    await until(() => got.length === 2);
    return ["1 throw,after", `${onlisten} ${got.join(",")}`, await sql.end()];
  }
);

t("unlisten after end resolves without a query", async () => {
  const sql = postgres(options);
  const { unlisten } = await sql.listen("after_end", ignore);
  await sql.end();
  return ["done", await unlisten().then(() => "done")];
});
