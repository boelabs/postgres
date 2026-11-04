import path from "node:path";

import { Clock, Random } from "./sim/net.js";
import { Server } from "./sim/server.js";

const single = process.env.SEED !== undefined;
const first = single ? +process.env.SEED : 1;
const runs = single ? 1 : +process.env.RUNS || 2000;
const modulePath = process.env.MODULE || "../src/index.js";
const globals = !!process.env.GLOBALS;

const { default: postgres } = await import(
  modulePath.startsWith(".")
    ? new URL(modulePath, import.meta.url)
    : path.resolve(modulePath)
);

// oxlint-disable-next-line sort-keys -- a seed picks its scenario by position in Object.keys, so the order is what makes a seed reproduce
const scenarios = {
  split: { faults: [] },
  errors: {
    faults: [],
    kinds: [
      "query",
      "rows",
      "fail",
      "syntax",
      "begin",
      "cursor",
      "unsafe",
      "batch",
    ],
  },
  close: { faults: ["close", "reset"] },
  terminate: { faults: ["kill"] },
  stale: { faults: ["stale", "deallocate"] },
  shapes: { faults: ["retype"] },
  commit: { faults: ["commitRollback"], kinds: ["begin", "query"] },
  startup: { faults: ["outage"] },
  mixed: {
    faults: [
      "kill",
      "close",
      "reset",
      "stale",
      "deallocate",
      "retype",
      "commitRollback",
      "outage",
    ],
  },
};

const batchQuery = (db, part, id, scope, k) => {
  if (part === "rows") {
    return db`select ${id}::int as id, ${scope}::int as scope from rows(${k}::int)`;
  }
  if (part === "fail") {
    return db`select ${id}::int as id, ${scope}::int as scope from rows(${k}::int) fail(${0}::int)`;
  }
  if (part === "syntax") {
    return db`selec ${id}::int as id, ${scope}::int as scope`;
  }
  return db`select ${id}::int as id, ${scope}::int as scope`;
};

const fakeGlobals = (clock) => {
  const saved = [
    "setTimeout",
    "clearTimeout",
    "setImmediate",
    "clearImmediate",
  ].map((k) => [k, globalThis[k]]);
  const { now } = performance;
  for (const [k] of saved) {
    globalThis[k] = clock.timers[k];
  }
  performance.now = clock.timers.now;
  return () => {
    for (const [k, v] of saved) {
      globalThis[k] = v;
    }
    performance.now = now;
  };
};

const simulate = async (seed) => {
  const name =
    process.env.SCENARIO ||
    Object.keys(scenarios)[seed % Object.keys(scenarios).length];
  const scenario = scenarios[name];
  const violations = [];
  const trace = [];
  const log = (x) => trace.push(`${String(clock.now).padStart(6)} ${x}`);
  const random = Random(seed);
  const clock = Clock((e) =>
    violations.push(`uncaught in a timer: ${(e && e.stack) || e}`)
  );
  const clients = [];
  // oxlint-disable-next-line sort-keys -- the values are drawn from the seed's random numbers in this order, and the trace prints them in it
  const config = {
    max: random.pick([1, 2, 3, 5]),
    prepare: random.chance(0.8),
    delay: random.pick([0, 1, 5, 20]),
    split: random.pick([0, 0.2, 0.8]),
    scenario: name,
    faults: scenario.faults.length ? random.pick([2, 6, 15]) : 0,
    ops: random.int(5, 60),
  };
  const wire = single && process.env.WIRE && ((x) => log(`wire ${x}`));
  const server = Server({
    clock,
    delay: config.delay,
    log: wire,
    random,
    split: config.split,
  });
  const stray = (x) => violations.push(`unhandled: ${(x && x.stack) || x}`);
  const restore = globals && fakeGlobals(clock);

  log(`config ${JSON.stringify(config)}`);
  process.on("unhandledRejection", stray);
  process.on("uncaughtException", stray);

  const sql = postgres({
    backoff: (n) => (0.5 + random.next() / 2) * Math.min(3 ** n / 100, 20),
    connect_timeout: 2,
    database: "sim",
    fetch_types: false,
    host: "sim",
    idle_timeout: random.pick([0, 1]),
    max: config.max,
    max_lifetime: random.pick([0, 2, 60 * 30]),
    onnotice: () => {
      // Notices are not something the simulator checks.
    },
    port: 5432,
    prepare: config.prepare,
    socket: () => {
      const x = server.socket();
      clients.push(x);
      return x;
    },
    timers: clock.timers,
    user: "sim",
  });

  const settled = [];
  let next = 1;

  const takeId = () => {
    const taken = next;
    next += 1;
    return taken;
  };

  const expect = (label, id, scope, rows) => (xs) => {
    if (rows !== undefined && xs.length !== rows) {
      violations.push(`${label} ${id} got ${xs.length} rows, expected ${rows}`);
    }
    for (const x of xs) {
      if (x.id !== id || x.scope !== scope) {
        violations.push(
          `${label} ${id} of scope ${scope} got the answer of query ${
            x.id
          } of scope ${x.scope}`
        );
      }
    }
    for (const x of xs) {
      if (x.shape !== 1 && x.shape !== "b") {
        violations.push(
          `${label} ${
            id
          } read its row by another description: shape ${JSON.stringify(
            x.shape
          )}`
        );
      }
    }
    return xs;
  };

  const settle = (label, id, promise) => {
    log(`start ${label} ${id}`);
    const x = Promise.resolve(promise)
      .then(
        () => log(`done ${label} ${id}`),
        (opError) => {
          log(
            `fail ${label} ${id} ${opError && (opError.code || opError.message)}`
          );
          if (
            !opError ||
            !opError.code ||
            opError instanceof TypeError ||
            opError instanceof RangeError ||
            opError.code === "STATEMENT_PENDING"
          ) {
            violations.push(
              `${label} ${id} failed inside the client: ${
                (opError && opError.stack) || opError
              }`
            );
          }
        }
      )
      .then(() => (x.done = true));
    return x;
  };

  const query = (db, kind, scope) => {
    const id = takeId();
    const k = random.int(1, 5);
    if (kind === "rows") {
      return db`select ${id}::int as id, ${scope}::int as scope from rows(${k}::int)`.then(
        expect(kind, id, scope, k)
      );
    }

    if (kind === "fail") {
      const at = random.int(0, k - 1);
      return db`select ${id}::int as id, ${scope}::int as scope from rows(${k}::int) fail(${at}::int)`.then(
        () => violations.push(`query ${id} should have failed`),
        (failError) => {
          if (failError.code !== "22012") {
            throw failError;
          }
        }
      );
    }
    if (kind === "syntax") {
      return db`selec ${id}::int as id, ${scope}::int as scope`.then(
        () => violations.push(`query ${id} should have failed to parse`),
        (parseError) => {
          if (parseError.code !== "42601") {
            throw parseError;
          }
        }
      );
    }

    if (kind === "sleep") {
      const q = db`select ${id}::int as id, ${scope}::int as scope sleep(${random.int(1, 500)}::int)`;
      if (random.chance(0.3)) {
        clock.timers.setTimeout(
          () =>
            Promise.resolve(q.cancel()).catch(() => {
              // A cancel that does not arrive is fine: the query is checked on its own.
            }),
          random.int(0, 300)
        );
      }
      return q.then(expect(kind, id, scope, 1));
    }
    if (kind === "batch") {
      const parts = Array.from({ length: random.int(1, 4) }, () =>
        random.pick(["query", "query", "rows", "fail", "syntax"])
      );
      const ids = parts.map(() => takeId());
      const bad = parts.findIndex((x) => x === "fail" || x === "syntax");
      const queries = parts.map((x, i) => batchQuery(db, x, ids[i], scope, k));
      const checkAll = (results) => {
        for (const [i, x] of results.entries()) {
          expect("batch", ids[i], scope, parts[i] === "rows" ? k : 1)(x);
        }
      };
      return db.batch(queries).then(
        (results) =>
          bad === -1
            ? checkAll(results)
            : violations.push(`batch ${id} should have failed at ${bad}`),
        (batchError) => {
          if (
            bad === -1 ||
            batchError.index !== bad ||
            batchError.code !== (parts[bad] === "fail" ? "22012" : "42601")
          ) {
            throw batchError;
          }
        }
      );
    }
    if (kind === "unsafe") {
      return db
        .unsafe(`select ${id} as id, ${scope} as scope`)
        .then(expect(kind, id, scope, 1));
    }

    if (kind === "cursor") {
      const check = expect(kind, id, scope);
      let n = 0;
      return db`select ${id}::int as id, ${scope}::int as scope from rows(${k}::int)`
        .cursor(random.int(1, 3), (rows) => {
          n += rows.length;
          check(rows);
          const wait = random.chance(0.5);
          if (!wait) {
            return wait;
          }
          const { promise, resolve } = Promise.withResolvers();
          clock.timers.setTimeout(resolve, random.int(0, 50));
          return promise;
        })
        .then(
          () =>
            n !== k &&
            violations.push(
              `cursor ${id} of scope ${scope} got ${n} rows, expected ${k}`
            )
        );
    }
    return db`select ${id}::int as id, ${scope}::int as scope`.then(
      expect(kind, id, scope, 1)
    );
  };

  const scoped = (db, scope) => {
    const picked = Array.from({ length: random.int(1, 4) }, () =>
      random.pick([
        "query",
        "rows",
        "fail",
        "syntax",
        "sleep",
        "unsafe",
        "cursor",
        "batch",
      ])
    );
    if (random.chance(0.5)) {
      return Promise.all(picked.map((k) => query(db, k, scope)));
    }
    let chain = Promise.resolve();
    for (const k of picked) {
      chain = chain.then(() => query(db, k, scope));
    }
    return chain;
  };

  const useReserved = async (reserved, scope) => {
    try {
      await query(reserved, "query", scope);
      await scoped(reserved, scope);
    } finally {
      reserved.release();
    }
  };

  const operation = (kind) => {
    let scope = 0;
    if (kind === "begin") {
      scope = 1000 + takeId();
    } else if (kind === "reserve") {
      scope = 2000 + takeId();
    }
    if (kind === "begin") {
      const ok = random.chance(0.8);
      const tx = sql.begin(async (transaction) => {
        await query(transaction, "query", scope);
        await scoped(transaction, scope);
        if (!ok) {
          throw Object.assign(new Error("rollback"), { code: "SIM_ROLLBACK" });
        }
      });
      return settle(
        "begin",
        scope,
        tx.then(
          () =>
            clock.timers.setTimeout(() => {
              if (server.outcomes.get(scope) !== "commit") {
                violations.push(
                  `transaction ${scope} resolved but the server did ${
                    server.outcomes.get(scope) || "nothing"
                  }`
                );
              }
            }, 0),
          (txError) => {
            const lost =
              /^(?:CONNECTION_|ECONNRESET)/u.test(txError.code) ||
              txError.severity === "FATAL";
            if (!lost && server.outcomes.get(scope) === "commit") {
              violations.push(
                `transaction ${scope} rejected (${
                  txError.message
                }) but the server committed it`
              );
            }
            throw txError;
          }
        )
      );
    }
    if (kind === "reserve") {
      return settle(
        "reserve",
        scope,
        sql.reserve().then((reserved) => useReserved(reserved, scope))
      );
    }

    if (kind === "cursor") {
      const id = takeId();
      const k = random.int(1, 9);
      const check = expect("cursor", id, 0);
      let n = 0;
      return settle(
        "cursor",
        id,
        sql`select ${id}::int as id, ${0}::int as scope from rows(${k}::int)`
          .cursor(random.int(1, 3), (rows) => {
            n += rows.length;
            return check(rows);
          })
          .then(
            () =>
              n !== k &&
              violations.push(`cursor ${id} got ${n} rows, expected ${k}`)
          )
      );
    }
    const id = next;
    return settle(kind, id, query(sql, kind, 0));
  };

  const fault = () => {
    const sessions = [...server.sessions];
    const x = sessions.length && random.pick(sessions);
    const kind = random.pick(scenario.faults);
    if (kind === "outage") {
      const mode = random.pick(["close", "error", "hang"]);
      const ms = random.int(10, 3000);
      log(`fault outage ${mode} ${ms}ms`);
      server.startup[0] = mode;
      return clock.timers.setTimeout(() => {
        server.startup[0] = "ready";
      }, ms);
    }
    if (!x) {
      return;
    }

    log(`fault ${kind} session ${x.id}`);
    if (kind === "kill") {
      server.kill(x);
    } else if (kind === "close") {
      server.close(x, false);
    } else if (kind === "reset") {
      server.close(x, true);
    } else {
      server[kind](x);
    }
  };

  const kinds = scenario.kinds || [
    "query",
    "query",
    "rows",
    "fail",
    "syntax",
    "sleep",
    "unsafe",
    "begin",
    "reserve",
    "cursor",
    "batch",
  ];
  for (let i = 0; i < config.ops; i += 1) {
    clock.timers.setTimeout(
      () => settled.push(operation(random.pick(kinds))),
      random.int(0, 3000)
    );
  }

  for (let i = 0; i < config.faults; i += 1) {
    clock.timers.setTimeout(fault, random.int(0, 3000));
  }

  let ended = false;
  try {
    await clock.run(10_000);
    sql.end({ timeout: 1 }).then(
      () => (ended = true),
      (endError) => violations.push(`end() rejected: ${endError.message}`)
    );
    await clock.run(70_000);
  } catch (error) {
    process.off("unhandledRejection", stray);
    process.off("uncaughtException", stray);
    if (restore) {
      restore();
    }
    violations.push(error.message);
    return { scenario: name, trace, violations };
  }

  const open = settled.filter((x) => !x.done).length;
  if (open) {
    violations.push(`${open} of ${settled.length} operations never settled`);
  }
  if (!ended) {
    violations.push("end() did not resolve");
  }

  violations.push(...server.violations);

  if (server.peak > config.max) {
    violations.push(`peak of ${server.peak} sessions with max ${config.max}`);
  }
  const burst = Math.max(
    0,
    ...server.attempts.map(
      (t) => server.attempts.filter((x) => x >= t && x < t + 1000).length
    )
  );
  if (burst > 2 * config.max + 4) {
    violations.push(`${burst} failed connection attempts within one second`);
  }

  if (clock.pending) {
    violations.push(
      `${clock.pending} timers left after end(), due at ${clock
        .pendingTimers()
        .map((x) => `${Math.round(x.at)}ms`)
        .join(", ")}`
    );
  }
  const sockets = clients.filter((x) => !x.destroyed).length;
  if (sockets) {
    violations.push(`${sockets} sockets left open after end()`);
  }

  process.off("unhandledRejection", stray);
  process.off("uncaughtException", stray);
  if (restore) {
    restore();
  }

  return { scenario: name, trace, violations };
};

let failed = 0;
for (let seed = first; seed < first + runs; seed += 1) {
  const result = await simulate(seed);
  if (result.violations.length) {
    failed += 1;
    console.log(
      `\n⛔️ SEED=${seed} (${result.scenario})\n  ${result.violations.join(
        "\n  "
      )}`
    );
    if (single) {
      console.log(`\n${result.trace.join("\n")}`);
    }
    if (failed >= (+process.env.MAXFAIL || 10) && !single) {
      break;
    }
  } else if (single) {
    console.log(result.trace.join("\n"));
  }
  if (!single && seed % 100 === 0) {
    process.stdout.write(".");
  }
}

console.log(
  failed
    ? `\n⚠️ ${failed} failing seed${failed === 1 ? "" : "s"}`
    : `\n🎉 ${runs} seeds`
);
process.exitCode = failed ? 1 : 0;
