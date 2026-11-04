import { postgres, options, delay } from "./setup.js";

const seconds = +process.argv[2] || +process.env.SOAK_SECONDS || 60;
const started = Date.now();
const deadline = started + seconds * 1000;
const app = `soak-${process.pid}`;
const sql = postgres({
  ...options,
  connection: { application_name: app },
  idle_timeout: 2,
  max: 10,
  max_lifetime: 30,
});
const admin = postgres({ ...options, max: 1 });
const pending = new Map();
const samples = [];
const failures = [];
const counts = {};

let next = 0;
let notified = 0;

const noop = () => {
  // The error is one the soak expects.
};

await sql`create table if not exists soak (id serial primary key, x int, s text)`;
await sql`truncate soak`;
await sql.listen("soak", () => {
  notified += 1;
});

// oxlint-disable-next-line sort-keys -- operations take turns in this order (Object.keys below)
const kinds = {
  select: () => sql`select ${next}::int as x`,
  shape: () => sql.unsafe(`select $1::int as x_${next % 500}`, [next]),
  rows: () => sql`select generate_series(1, 2000) as n`,
  insert: () =>
    sql`insert into soak (x, s) values (${next}, ${"x".repeat(next % 100)})`,
  begin: () =>
    sql
      .begin(async (tx) => {
        await tx`insert into soak (x) values (${next})`;
        await tx`select count(*) from soak`;
        if (next % 7 === 0) {
          tx`select 1/0`.catch(noop);
        }
      })
      .catch(
        (beginError) =>
          ["22012", "25P02", "TRANSACTION_ROLLED_BACK"].includes(
            beginError.code
          ) || Promise.reject(beginError)
      ),
  cursor: async () => {
    for await (const _rows of sql`select generate_series(1, 300) as n`.cursor(
      50
    )) {
      // Read every batch, nothing more.
    }
  },
  copy: async () => {
    let bytes = 0;
    for await (const x of await sql`copy (select generate_series(1, 5000)) to stdout`.readable()) {
      bytes += x.length;
    }
    return bytes;
  },
  notify: () => sql.notify("soak", `x${next}`),
  cancel: () => {
    const q = sql`select pg_sleep(0.2)`;
    setTimeout(() => q.cancel().catch(noop), Math.random() * 100);
    return q.catch(
      (cancelError) =>
        cancelError.code === "57014" || Promise.reject(cancelError)
    );
  },
  reserve: async () => {
    const reserved = await sql.reserve();
    try {
      await reserved`select 1`;
    } finally {
      reserved.release();
    }
  },
};

const expected = new Set([
  "57P01",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "ECONNRESET",
  "57014",
  "25P02",
  "40P01",
  "08006",
]);

const operation = () => {
  const id = next;
  next += 1;
  const names = Object.keys(kinds);
  const name = names[id % names.length];
  const at = Date.now();
  // oxlint-disable-next-line sort-keys -- printed with JSON.stringify in the report, name first
  pending.set(id, { name, at });
  return Promise.resolve()
    .then(kinds[name])
    .then(
      () => (counts[name] = (counts[name] || 0) + 1),
      (operationError) =>
        expected.has(operationError.code) ||
        failures.push(
          `${name}: ${operationError.code || ""} ${operationError.message}`
        )
    )
    .finally(() => pending.delete(id));
};

const worker = async () => {
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- a worker runs one operation after another
    await operation();
  }
};

const fault = async () => {
  await delay(500 + Math.random() * 2500);
  await (Math.random() < 0.8
    ? admin`
        select pg_terminate_backend(pid) from pg_stat_activity
        where application_name = ${app} and pid in (
          select pid from pg_stat_activity where application_name = ${app} order by random() limit 1
        )
      `.catch(noop)
    : sql.close());
};

const faults = async () => {
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- one fault after another
    await fault();
  }
};

const takeSample = async () => {
  await delay(Math.max(1000, seconds * 10));
  if (global.gc) {
    global.gc();
  }
  const [{ n }] =
    await admin`select count(*)::int as n from pg_stat_activity where application_name = ${app}`;
  const oldest = Math.max(
    0,
    ...[...pending.values()].map((x) => Date.now() - x.at)
  );
  const time = (Date.now() - started) / 1000;
  const heap = process.memoryUsage().heapUsed / 1024 / 1024;
  const handles = process.getActiveResourcesInfo().length;
  samples.push({
    connections: n,
    handles,
    heap,
    oldest,
    pending: pending.size,
    t: time,
  });
  if (oldest > 30_000) {
    failures.push(
      `an operation has been pending for ${oldest}ms: ${JSON.stringify(
        [...pending.values()][0]
      )}`
    );
  }
  const s = samples.at(-1);
  console.log(
    `${s.t.toFixed(0).padStart(6)}s heap ${s.heap.toFixed(1)}MB handles ${
      s.handles
    } connections ${s.connections} pending ${s.pending} oldest ${s.oldest}ms`
  );
};

const sample = async () => {
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- one sample after another
    await takeSample();
  }
};

await Promise.all([...Array.from({ length: 30 }, worker), faults(), sample()]);

const ended = await Promise.race([
  sql.end({ timeout: 5 }).then(() => true),
  delay(15_000).then(() => false),
]);
if (!ended) {
  failures.push("end() did not resolve");
}
await admin`drop table soak`;
await admin.end();
await delay(100);

const settled = samples.slice(Math.floor(samples.length / 5));
const fifth = Math.max(1, Math.floor(settled.length / 4));
const mean = (xs) => xs.reduce((a, b) => a + b.heap, 0) / xs.length;
const early = mean(settled.slice(0, fifth));
const late = mean(settled.slice(-fifth));
if (settled.length >= 4 && late > early * 1.5 + 5) {
  failures.push(`heap grew from ${early.toFixed(1)}MB to ${late.toFixed(1)}MB`);
}
if (Math.max(...samples.map((x) => x.connections)) > 11) {
  failures.push("more than max connections and the listener at once");
}

const left = process
  .getActiveResourcesInfo()
  .filter((x) => x !== "TTYWrap" && x !== "Timeout");
if (left.length > 2) {
  failures.push(`handles left after end(): ${left.join(",")}`);
}

console.log(
  `\n${Object.entries(counts)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ")}, notifications ${notified}`
);
console.log(
  failures.length
    ? `⚠️ ${failures.length} problems\n${[...new Set(failures)]
        .slice(0, 20)
        .join("\n")}`
    : `🎉 ${seconds}s soak`
);
process.exitCode = failures.length ? 1 : 0;
