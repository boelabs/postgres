import { AsyncLocalStorage } from "node:async_hooks";
import dc from "node:diagnostics_channel";

import { postgres, options, delay } from "./setup.js";
import { t } from "./test.js";

const noop = () => {
  // The rejection is expected; its trace is what is tested.
};

const record = (name) => {
  const events = [];
  const channel = dc.tracingChannel(name);
  const handlers = Object.fromEntries(
    ["start", "end", "asyncStart", "asyncEnd", "error"].map((event) => [
      event,
      (context) => events.push({ context, event, snapshot: { ...context } }),
    ])
  );
  channel.subscribe(handlers);
  return { events, stop: () => channel.unsubscribe(handlers) };
};

const listen = (name) => {
  const messages = [];
  const fn = (message) => messages.push(message);
  dc.subscribe(name, fn);
  return { messages, stop: () => dc.unsubscribe(name, fn) };
};

t(
  "Tracing: a query publishes start, end, asyncStart and asyncEnd with what it ran",
  async () => {
    const sql = postgres({ ...options, max: 1 });
    await sql`select 1`;
    const { events, stop } = record("postgres:query");
    const [{ x }] = await sql`select ${1}::int as x`;
    stop();
    const order = events.map((entry) => entry.event).join(",");
    const c = events.at(-1).context;
    return [
      `start,end,asyncStart,asyncEnd|select $1::int as x|SELECT|1|${
        sql.options.database
      }|true|true|true|1`,
      [
        order,
        c.query,
        c.command,
        c.count,
        c.database,
        typeof c.connection === "number" &&
          c.port === (options.port || 5432) &&
          typeof c.host === "string",
        c.queued <= c.sent &&
          c.sent <= c.firstByte &&
          c.firstByte <= c.complete,
        c.parameters === undefined,
        x,
      ].join("|"),
      await sql.end(),
    ];
  }
);

t("Tracing: parameters are only in the context with debug", async () => {
  const sql = postgres({ ...options, debug: true, max: 1 });
  const { events, stop } = record("postgres:query");
  await sql`select ${"secret"}::text as x`;
  stop();
  return ["secret", events[0].context.parameters.join(","), await sql.end()];
});

t(
  "Tracing: a failing query publishes error with the error, then asyncStart and asyncEnd",
  async () => {
    const sql = postgres({ ...options, max: 1 });
    const { events, stop } = record("postgres:query");
    await sql`select wat`.catch(noop);
    stop();
    return [
      "start,end,error,asyncStart,asyncEnd 42703",
      `${events.map((x) => x.event).join(",")} ${
        events.find((x) => x.event === "error").context.error.code
      }`,
      await sql.end(),
    ];
  }
);

t(
  "Tracing: start runs in the context of the code that made the query",
  async () => {
    const sql = postgres({ ...options, max: 1 });
    const store = new AsyncLocalStorage();
    const seen = [];
    const start = (context) =>
      seen.push(`${store.getStore()}:${context.query}`);
    dc.subscribe("tracing:postgres:query:start", start);
    await Promise.all([
      store.run("a", async () => await sql`select 1 as a`),
      store.run("b", async () => await sql`select 2 as b`),
    ]);
    dc.unsubscribe("tracing:postgres:query:start", start);
    return [
      "a:select 1 as a,b:select 2 as b",
      seen.toSorted().join(","),
      await sql.end(),
    ];
  }
);

t(
  "Tracing: a store bound to start is current while the query is dispatched",
  async () => {
    const sql = postgres({ ...options, max: 1 });
    const store = new AsyncLocalStorage();
    const channel = dc.tracingChannel("postgres:query");
    const seen = [];
    const end = () => seen.push(store.getStore());
    channel.start.bindStore(
      store,
      (context) => `span for ${context.queued.toFixed(0).length}`
    );
    dc.subscribe("tracing:postgres:query:end", end);
    await sql`select 1`;
    channel.start.unbindStore(store);
    dc.unsubscribe("tracing:postgres:query:end", end);
    return [
      true,
      seen.length === 1 && seen[0].startsWith("span for"),
      await sql.end(),
    ];
  }
);

t("Tracing: cursors and copy streams finish their trace", async () => {
  const sql = postgres({ ...options, max: 1 });
  const { events, stop } = record("postgres:query");
  for await (const [_row] of sql`select generate_series(1, 3) as x`.cursor()) {
    // Read every row, nothing more.
  }
  await sql`select generate_series(1, 3) as x`.cursor(2, () => {
    // Read every batch, nothing more.
  });
  const readable = await sql`copy (select 1) to stdout`.readable();
  for await (const _chunk of readable) {
    // Read every chunk, nothing more.
  }
  await delay(10);
  stop();
  const done = events.filter((x) => x.event === "asyncEnd").length;
  const started = events.filter((x) => x.event === "start").length;
  return [true, done === started && started === 3, await sql.end()];
});

t(
  "Tracing: connect publishes per attempt, with the backend pid or the error",
  async () => {
    const { events, stop } = record("postgres:connect");
    const sql = postgres({ ...options, max: 1 });
    await sql`select 1`;
    const bad = postgres({
      ...options,
      connect_timeout: 1,
      max: 1,
      port: 5434,
    });
    await bad`select 1`.catch(noop);
    stop();
    const ok = events.find((x) => x.event === "asyncEnd" && !x.context.error);
    const failed = events.find((x) => x.event === "error");
    return [
      `number ${options.port || 5432} ECONNREFUSED 5434`,
      [
        typeof ok.context.result.pid,
        ok.context.port,
        failed.context.error.code,
        failed.context.port,
      ].join(" "),
      await sql.end(),
      await bad.end(),
    ];
  }
);

t("Tracing: a transaction publishes its outcome", async () => {
  const sql = postgres({ ...options, max: 1 });
  const { events, stop } = record("postgres:transaction");
  await sql.begin((tx) => tx`select 1`);
  await sql
    .begin("read only", async (tx) => {
      await tx`select 1`;
      throw new Error("no");
    })
    .catch(noop);
  stop();
  const done = events
    .filter((x) => x.event === "asyncEnd")
    .map((x) => x.context);
  return [
    "commit,rollback read only no true",
    [
      done.map((x) => x.outcome).join(","),
      done[1].mode,
      done[1].error.message,
      typeof done[0].connection === "number",
    ].join(" "),
    await sql.end(),
  ];
});

t(
  "Tracing: the pool publishes open, lease, release, idle and close",
  async () => {
    const { messages, stop } = listen("postgres:pool");
    const sql = postgres({ ...options, max: 1 });
    await sql`select 1`;
    const reserved = await sql.reserve();
    reserved.release();
    await sql.end();
    stop();
    const kinds = new Set(messages.map((x) => x.event));
    return [
      "open,idle,lease,release,close true",
      `${["open", "idle", "lease", "release", "close"]
        .filter((x) => kinds.has(x))
        .join(",")} ${messages.every(
        (x) => typeof x.stats.connections === "number"
      )}`,
    ];
  }
);

t("Tracing: notices are published with their connection", async () => {
  const { messages, stop } = listen("postgres:notice");
  const sql = postgres({ ...options, max: 1, onnotice: false });
  await sql`do $$ begin raise notice 'hello'; end $$`;
  stop();
  return [
    "hello true",
    `${messages[0].notice.message} ${
      typeof messages[0].connection === "number"
    }`,
    await sql.end(),
  ];
});

t("Tracing: without subscribers a query carries no trace", async () => {
  const sql = postgres({ ...options, max: 1 });
  const q = sql`select 1`;
  await q;
  return [null, q.trace, await sql.end()];
});
