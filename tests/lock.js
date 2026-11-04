import { postgres, options, delay } from "./setup.js";
import { t } from "./test.js";

const pool = (extra = {}) => postgres({ ...options, max: 3, ...extra });

// The advisory locks the server holds right now, seen from a connection of their own.
async function held(sql) {
  const [{ n }] =
    await sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted`;
  return n;
}

t(
  "sql.lock runs the function while holding the lock, and lets it go after",
  async () => {
    const sql = pool();
    const during = await sql.lock(918_273_645, () => held(sql));
    const after = await held(sql);
    await sql.end();
    return ["1 0", `${during} ${after}`];
  }
);

t("sql.lock resolves with what the function returns", async () => {
  const sql = pool();
  const x = await sql.lock(1, async () => "done");
  await sql.end();
  return ["done", x];
});

t(
  "sql.lock gives the function the connection that holds the lock",
  async () => {
    const sql = pool();
    const same = await sql.lock(2, async (locked) => {
      const [{ pid }] = await locked`select pg_backend_pid() as pid`;
      const [{ holder }] =
        await sql`select pid as holder from pg_locks where locktype = 'advisory' and granted`;
      return pid === holder;
    });
    await sql.end();
    return [true, same];
  }
);

t("sql.lock runs callers of the same key one after the other", async () => {
  const sql = pool({ max: 4 });
  const events = [];
  const run = (name) =>
    sql.lock("migrations", async () => {
      events.push(`${name} in`);
      await delay(50);
      events.push(`${name} out`);
    });
  await Promise.all([run("a"), run("b")]);
  await sql.end();
  return [
    true,
    events.join() === "a in,a out,b in,b out" ||
      events.join() === "b in,b out,a in,a out",
  ];
});

t(
  "sql.lock with wait: false rejects with LOCK_NOT_AVAILABLE while another session holds it",
  async () => {
    const sql = pool();
    let release;
    const first = sql.lock(3, () => new Promise((r) => (release = r)));
    await delay(50);
    const code = await sql
      .lock(3, () => "never", { wait: false })
      .catch((e) => e.code);
    release();
    await first;
    const later = await sql.lock(3, () => "free", { wait: false });
    await sql.end();
    return ["LOCK_NOT_AVAILABLE free", `${code} ${later}`];
  }
);

t(
  "sql.lock lets the lock go when the function throws, and rejects with its error",
  async () => {
    const sql = pool();
    const message = await sql
      .lock(4, () => {
        throw new Error("boom");
      })
      .catch((e) => e.message);
    const after = await held(sql);
    await sql.end();
    return ["boom 0", `${message} ${after}`];
  }
);

t("sql.lock takes a bigint and a string as key", async () => {
  const sql = pool();
  const a = await sql.lock(9_007_199_254_740_993n, () => held(sql));
  const b = await sql.lock("jobs:nightly", () => held(sql));
  await sql.end();
  return ["1 1", `${a} ${b}`];
});

t(
  "sql.lock rejects a key it can not use without taking a connection",
  async () => {
    const sql = pool();
    const codes = await Promise.all(
      [1.5, "", null, {}].map((x) => sql.lock(x, () => 1).catch((e) => e.code))
    );
    const leased = sql.stats.leased;
    await sql.end();
    return [
      "LOCK_KEY,LOCK_KEY,LOCK_KEY,LOCK_KEY 0",
      `${codes.join()} ${leased}`,
    ];
  }
);

t("sql.lock without a function rejects with LOCK_NO_FUNCTION", async () => {
  const sql = pool();
  const code = await sql.lock(5).catch((e) => e.code);
  await sql.end();
  return ["LOCK_NO_FUNCTION", code];
});

t(
  "sql.lock stops waiting when its signal aborts, and the connection goes back to the pool",
  async () => {
    const sql = pool();
    let release;
    const first = sql.lock(6, () => new Promise((r) => (release = r)));
    await delay(50);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const code = await sql
      .lock(6, () => "never", { signal: controller.signal })
      .catch((e) => e.code);
    release();
    await first;
    const after = await held(sql);
    await sql.end();
    return ["57014 0", `${code} ${after}`];
  }
);

t(
  "sql.lock on a pool of one connection runs queries through the sql it gives the function",
  async () => {
    const sql = pool({ max: 1 });
    const x = await sql.lock(
      7,
      async (locked) => (await locked`select 1 as x`)[0].x
    );
    await sql.end();
    return [1, x];
  }
);
