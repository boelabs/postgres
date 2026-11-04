import dc from "node:diagnostics_channel";

import postgres from "../../src/cf.js";

const base = {
  database: "postgres_js_test",
  host: "127.0.0.1",
  idle_timeout: 1,
  max: 4,
  port: 5432,
  user: "postgres_js_test",
};

const configs = {
  direct: { ...base, ssl: "require", sslnegotiation: "direct" },
  md5: { ...base, pass: "postgres_js_test_md5", user: "postgres_js_test_md5" },
  scram: {
    ...base,
    pass: "postgres_js_test_scram",
    user: "postgres_js_test_scram",
  },
  scramtls: {
    ...base,
    host: "localhost",
    pass: "postgres_js_test_scram",
    ssl: "require",
    user: "postgres_js_test_scram",
  },
  tls: { ...base, host: "localhost", ssl: "require" },
  trust: base,
};

const checks = {
  async begin(sql) {
    const [x] = await sql.begin(async (tx) => {
      await tx`create temp table t (x int)`;
      await tx`insert into t values (1)`;
      return tx`select count(*)::int as c from t`;
    });
    return x.c === 1;
  },
  async cancel(sql) {
    const q = sql`select pg_sleep(2)`;
    setTimeout(() => q.cancel(), 200);
    return (await q.catch((error) => error.code)) === "57014";
  },
  async copy(sql) {
    let bytes = 0;
    for await (const x of await sql`copy (select generate_series(1, 10000)) to stdout`.readable()) {
      bytes += x.length;
    }
    return bytes === 48_894;
  },
  async cursor(sql) {
    let n = 0;
    await sql`select generate_series(1, 1000) as x`.cursor(
      100,
      (rows) => (n += rows.length)
    );
    return n === 1000;
  },
  error: async (sql) =>
    (await sql`select wat`.catch((error) => error.code)) === "42703",
  async large(sql) {
    const text = "x".repeat(300_000);
    const [x] = await sql`select length(${text}) as n`;
    const [y] = await sql.begin((tx) => tx`select length(${text}) as n`);
    return x.n === 300_000 && y.n === 300_000;
  },
  async listen(sql) {
    let got;
    await sql.listen("cf", (x) => (got = x));
    await sql.notify("cf", "hi");
    const waited = Promise.withResolvers();
    setTimeout(waited.resolve, 200);
    await waited.promise;
    return got === "hi";
  },
  async params(sql) {
    const [x] = await sql`
      select
        (${5}::int + 1)::text || ${"a"} as y,
        ${new Date(0)}::timestamptz as d,
        ${[1, 2]}::int[] as a,
        ${sql.json({ a: 1 })}::json as j
    `;
    return x.y === "6a" && x.d.getTime() === 0 && x.a[1] === 2 && x.j.a === 1;
  },
  async pipeline(sql) {
    const xs = await Promise.all(
      Array.from({ length: 200 }, (_, i) => sql`select ${i}::int as i`)
    );
    return xs.every((x, i) => x[0].i === i);
  },
  async prepared(sql) {
    const xs = await Promise.all(
      Array.from(
        { length: 50 },
        (_, i) => sql`select ${i}::int as i, ${`x${i}`} as s`
      )
    );
    return xs.every((x, i) => x[0].i === i && x[0].s === `x${i}`);
  },
  rows: async (sql) => {
    const { length } =
      await sql`select generate_series(1, 100000) as n, md5(random()::text) as m`;
    return length === 100_000;
  },
  select: async (sql) => {
    const [row] = await sql`select 1 as x`;
    return row.x === 1;
  },
  async tracing(sql) {
    const seen = [];
    const channel = dc.tracingChannel("postgres:query");
    const handlers = {
      asyncEnd: (x) => seen.push(`${x.command}:${x.query}`),
      asyncStart() {
        // Only asyncEnd is checked.
      },
      end() {
        // Only asyncEnd is checked.
      },
      error() {
        // Only asyncEnd is checked.
      },
      start() {
        // Only asyncEnd is checked.
      },
    };
    channel.subscribe(handlers);
    try {
      await sql`select ${1}::int as x`;
    } finally {
      channel.unsubscribe(handlers);
    }
    return seen.join(",") === "SELECT:select $1::int as x";
  },
  async unnamed(sql) {
    const xs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        sql.unsafe("select $1::int as i", [i])
      )
    );
    return xs.every((x, i) => x[0].i === i);
  },
};

const everywhere = new Set(["select", "params", "rows", "copy"]);

const check = async (o, fn) => {
  const sql =
    typeof o === "string"
      ? postgres(o, { idle_timeout: 1, max: 4 })
      : postgres(o);
  const start = Date.now();
  try {
    const timeout = Promise.withResolvers();
    setTimeout(() => timeout.reject(new Error("timeout")), 8000);
    return `${await Promise.race([fn(sql), timeout.promise])} ${Date.now() - start}ms`;
  } catch (error) {
    return `ERROR ${error.code || ""} ${(error.stack || error.message || error)
      .toString()
      .split("\n")
      .slice(0, 4)
      .join(" | ")}`;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {
      // The report already has the outcome of the check.
    });
  }
};

const report = (out) => {
  const failed = Object.entries(out).filter(([k, v]) =>
    k.startsWith("direct")
      ? !v.includes("SSL_NEGOTIATION_NOT_SUPPORTED")
      : !v.startsWith("true")
  ).length;
  return Response.json({ failed, ...out }, { status: failed ? 500 : 200 });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const only = url.searchParams.get("only");
    const out = {};

    if (env.TOKEN && request.headers.get("x-token") !== env.TOKEN) {
      return new Response("Forbidden", { status: 403 });
    }

    if (url.pathname === "/hyperdrive") {
      if (!env.HYPERDRIVE) {
        return Response.json(
          { error: "No HYPERDRIVE binding", failed: 1 },
          { status: 500 }
        );
      }

      for (const [name, fn] of Object.entries(checks).filter(
        ([x]) => x !== "listen" && (!only || x.startsWith(only))
      )) {
        out[`hyperdrive ${name}`] = await check(
          env.HYPERDRIVE.connectionString,
          fn
        );
      }
      return report(out);
    }

    for (const [name, o] of Object.entries(configs).filter(
      ([key]) => !only || key.startsWith(only)
    )) {
      for (const [name2, fn] of Object.entries(checks).filter(
        ([x]) => name === "trust" || everywhere.has(x)
      )) {
        out[`${name} ${name2}`] = await check(o, fn);
      }
    }
    return report(out);
  },
};
