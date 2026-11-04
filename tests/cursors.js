import { postgres, sql, options, delay } from "./setup.js";
import { t } from "./test.js";

const noop = () => {
  // Deliberately empty: the test does not look at what it is given.
};

const until = async (fn) => {
  while (!fn()) {
    await delay(5);
  }
};

t("forEach", async () => {
  let result;
  await sql`select 1 as x`.forEach(({ x }) => (result = x));
  return [1, result];
});

t("forEach returns empty array", async () => {
  const rows = await sql`select 1 as x`.forEach(noop);
  return [0, rows.length];
});

t("Cursor", async () => {
  const order = [];
  await sql`select 1 as x union select 2 as x`.cursor(async ([x]) => {
    order.push(`${x.x}a`);
    await delay(100);
    order.push(`${x.x}b`);
  });
  return ["1a1b2a2b", order.join("")];
});

t("Unsafe cursor", async () => {
  const order = [];
  await sql.unsafe("select 1 as x union select 2 as x").cursor(async ([x]) => {
    order.push(`${x.x}a`);
    await delay(100);
    order.push(`${x.x}b`);
  });
  return ["1a1b2a2b", order.join("")];
});

t("Cursor custom n", async () => {
  const order = [];
  // oxlint-disable-next-line require-await -- the cursor is given a promise to wait on, as before
  await sql`select * from generate_series(1,20)`.cursor(10, async (x) => {
    order.push(x.length);
  });
  return ["10,10", order.join(",")];
});

t("Cursor custom with rest n", async () => {
  const order = [];
  // oxlint-disable-next-line require-await -- the cursor is given a promise to wait on, as before
  await sql`select * from generate_series(1,20)`.cursor(11, async (x) => {
    order.push(x.length);
  });
  return ["11,9", order.join(",")];
});

t("Cursor custom with less results than batch size", async () => {
  const order = [];
  // oxlint-disable-next-line require-await -- the cursor is given a promise to wait on, as before
  await sql`select * from generate_series(1,20)`.cursor(21, async (x) => {
    order.push(x.length);
  });
  return ["20", order.join(",")];
});

t("Cursor cancel", async () => {
  let result;
  await sql`select * from generate_series(1,10) as x`.cursor(
    // oxlint-disable-next-line require-await -- CLOSE comes back in a promise, as before
    async ([{ x }]) => {
      result = x;
      return sql.CLOSE;
    }
  );
  return [1, result];
});

t("Cursor throw", async () => {
  const order = [];
  await sql`select 1 as x union select 2 as x`
    .cursor(async ([x]) => {
      order.push(`${x.x}a`);
      await delay(100);
      throw new Error("watty");
    })
    .catch(() => order.push("err"));
  return ["1aerr", order.join("")];
});

t("Cursor error", async () => [
  "42601",
  await sql`wat`.cursor(noop).catch((error) => error.code),
]);

t("Multiple Cursors", async () => {
  const result = [];
  await sql.begin(async (tx) => [
    await tx`select 1 as cursor, x from generate_series(1,4) as x`.cursor(
      async ([row]) => {
        result.push(row.x);
        await delay(20);
      }
    ),
    await tx`select 2 as cursor, x from generate_series(101,104) as x`.cursor(
      async ([row]) => {
        result.push(row.x);
        await delay(10);
      }
    ),
  ]);

  return ["1,2,3,4,101,102,103,104", result.join(",")];
});

t("Cursor as async iterator", async () => {
  const order = [];
  for await (const [x] of sql`select generate_series(1,2) as x;`.cursor()) {
    order.push(`${x.x}a`);
    await delay(10);
    order.push(`${x.x}b`);
  }

  return ["1a1b2a2b", order.join("")];
});

t("Cursor as async iterator with break", async () => {
  const order = [];
  // oxlint-disable-next-line no-unreachable-loop -- the test is breaking out of the cursor after its first batch
  for await (const xs of sql`select generate_series(1,2) as x;`.cursor()) {
    order.push(`${xs[0].x}a`);
    await delay(10);
    order.push(`${xs[0].x}b`);
    break;
  }

  return ["1a1b", order.join("")];
});

t("Async Iterator Unsafe cursor", async () => {
  const order = [];
  for await (const [x] of sql
    .unsafe("select 1 as x union select 2 as x")
    .cursor()) {
    order.push(`${x.x}a`);
    await delay(10);
    order.push(`${x.x}b`);
  }
  return ["1a1b2a2b", order.join("")];
});

t("Async Iterator Cursor custom n", async () => {
  const order = [];
  for await (const x of sql`select * from generate_series(1,20)`.cursor(10)) {
    order.push(x.length);
  }

  return ["10,10", order.join(",")];
});

t("Async Iterator Cursor custom with rest n", async () => {
  const order = [];
  for await (const x of sql`select * from generate_series(1,20)`.cursor(11)) {
    order.push(x.length);
  }

  return ["11,9", order.join(",")];
});

t(
  "Async Iterator Cursor custom with less results than batch size",
  async () => {
    const order = [];
    for await (const x of sql`select * from generate_series(1,20)`.cursor(21)) {
      order.push(x.length);
    }
    return ["20", order.join(",")];
  }
);

t("forEach has result as second argument", async () => {
  let x;
  await sql`select 1 as x`.forEach((_, result) => (x = result));
  return ["x", x.columns[0].name];
});

t("concurrent cursors", async () => {
  const xs = [];

  await Promise.all(
    Array.from({ length: 7 }).flatMap((x, i) => [
      sql`select ${i}::int as a, generate_series(1, 2) as x`.cursor(([row]) =>
        xs.push(row.a + row.x)
      ),
    ])
  );

  return ["12233445566778", xs.join("")];
});

t("concurrent cursors multiple connections", async () => {
  const db = postgres({ ...options, max: 2 });
  const xs = [];

  await Promise.all(
    Array.from({ length: 7 }).flatMap((x, i) => [
      db`select ${i}::int as a, generate_series(1, 2) as x`.cursor(([row]) =>
        xs.push(row.a + row.x)
      ),
    ])
  );

  return ["12233445566778", xs.toSorted().join("")];
});

t(
  "Async iterator cursor surfaces an error arriving between batches",
  async () => {
    const cursor =
      sql`select 1 / (3 - x) as x from generate_series(1, 5) as x`.cursor(1);
    const iterator = cursor[Symbol.asyncIterator]();
    await iterator.next();
    const code = await iterator
      .next()
      .then(() => iterator.next())
      .then(
        () => "no error",
        (error) => error.code
      );
    await iterator.return();
    return ["22012", code];
  }
);

t(
  "A cursor in a transaction that resumes while another query waits on its description gives each its own answer",
  { timeout: 10 },
  async () => {
    const db = postgres(options);
    const out = [];
    await db.begin(async (tx) => {
      let release;
      const batches = [];
      const cursor = tx`select generate_series(1, 6) as x`.cursor(2, (rows) => {
        batches.push(rows.map((r) => r.x));
        const batch = Promise.withResolvers();
        release = batch.resolve;
        return batch.promise;
      });
      const done = cursor.then(() => JSON.stringify(batches));
      const step = async () => {
        const before = release;
        before();
        await until(() => release !== before || batches.length === 3);
      };
      await until(() => release);
      const q = tx`select ${"value"}::text as a, ${Math.random()}::float8 as cursor_order_shape`;
      q.catch(noop);
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
      await step();
      await step();
      release();
      const [{ a }] = await q;
      out.push(a, await done);
    });
    return ["value [[1,2],[3,4],[5,6]]", out.join(" "), await db.end()];
  }
);

t(
  "A cursor on a reserved connection keeps its rows from a query made while it runs",
  { timeout: 10 },
  async () => {
    const db = postgres(options);
    const reserved = await db.reserve();
    const batches = [];
    const cursor = reserved`select generate_series(1, 6) as x`.cursor(
      2,
      async (rows) => {
        batches.push(rows.map((r) => r.x));
        await delay(50);
      }
    );
    cursor.catch(noop);
    while (!batches.length) {
      await delay(2);
    }
    const [{ a }] = await reserved`select 'q1' as a`;
    await cursor;
    reserved.release();
    return [
      "q1 [[1,2],[3,4],[5,6]]",
      `${a} ${JSON.stringify(batches)}`,
      await db.end(),
    ];
  }
);

t(
  "A cursor that outlives its transaction is rejected instead of running in the next one",
  { timeout: 10 },
  async () => {
    const db = postgres({ ...options, max: 1 });
    await db`create table test (a int)`;
    let cursor;
    const first = await db
      .begin((tx) => {
        cursor = tx`select generate_series(1, 6) as x`.cursor(2, () =>
          delay(100)
        );
        return Promise.all([cursor, tx`select 1/0`]);
      })
      .catch((error) => error.code);
    const second = await db
      .begin(async (tx) => {
        await tx`insert into test values (1)`;
        await delay(300);
        await tx`insert into test values (2)`;
        return "committed";
      })
      .catch((error) => error.code);
    const outlived = await cursor.catch((error) => error.code);
    const [{ n }] = await db`select count(*)::int as n from test`;
    return [
      "22012 committed 2 true",
      [first, second, n, outlived !== undefined].join(" "),
      await db`drop table test`,
      await db.end(),
    ];
  }
);

t(
  "A pool cursor whose parameter serializer returns a number rejects and frees the connection",
  async () => {
    const db = postgres({
      ...options,
      max: 1,
      types: { ms: { from: [], serialize: (x) => x.getTime(), to: 20 } },
    });
    const run = () =>
      db`select ${db.types.ms(new Date(0))}::int8 as x`.cursor(10, noop).then(
        () => "ok",
        (serializeError) => serializeError.name
      );
    const first = await run();
    const second = await run();
    const [{ x }] = await db`select 1 as x`;
    return [
      "TypeError,TypeError,1",
      [first, second, x].join(","),
      await db.end(),
    ];
  }
);

t(
  "A transaction waits for a cursor it did not await before it commits",
  async () => {
    const batches = [];
    let cursor;
    await sql.begin(async (tx) => {
      cursor = tx`select generate_series(1, 4) as x`.cursor(
        1,
        async ([row]) => {
          batches.push(row.x);
          await delay(20);
        }
      );
      cursor.catch(noop);
      await delay(10);
    });
    return [
      "ok 1,2,3,4",
      `${await cursor.then(
        () => "ok",
        (error) => error.code
      )} ${batches.join(",")}`,
    ];
  }
);

t(
  "A transaction that returns right after starting a cursor still lets the cursor finish",
  async () => {
    const batches = [];
    let cursor;
    await sql.begin((tx) => {
      cursor = tx`select generate_series(1, 3) as x`.cursor(1, ([row]) => {
        batches.push(row.x);
      });
      cursor.catch(noop);
    });
    return [
      "ok 1,2,3",
      `${await cursor.then(
        () => "ok",
        (error) => error.code
      )} ${batches.join(",")}`,
    ];
  }
);

t(
  "A pool cursor whose callback throws on the last batch rejects and frees the connection",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const error = await db`select generate_series(1, 3) as x`
      .cursor(2, (rows) => {
        if (rows[0].x === 3) {
          throw new Error("last");
        }
      })
      .then(
        () => "resolved",
        (cursorError) => cursorError.message
      );
    const [{ x }] = await db`select 1 as x`;
    return ["last 1", `${error} ${x}`, await db.end()];
  }
);

t(
  "A pool cursor whose column parser throws rejects and frees the connection",
  async () => {
    const db = postgres({
      ...options,
      max: 1,
      types: {
        bad: {
          from: [23],
          parse: (x) => {
            if (x === "3") {
              throw new Error("parser");
            }
            return +x;
          },
          to: 0,
        },
      },
    });
    const error = await db`select generate_series(1, 6)::int as x`
      .cursor(2, noop)
      .then(
        () => "resolved",
        (cursorError) => cursorError.message
      );
    const [{ x }] = await db`select 1 as x`;
    return ["parser 1", `${error} ${x}`, await db.end()];
  }
);

t(
  "A reserved cursor whose callback throws on the last batch rejects and leaves the connection usable",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const reserved = await db.reserve();
    const error = await reserved`select generate_series(1, 3) as x`
      .cursor(2, (rows) => {
        if (rows[0].x === 3) {
          throw new Error("last");
        }
      })
      .then(
        () => "resolved",
        (cursorError) => cursorError.message
      );
    const [{ x }] = await reserved`select 1 as x`;
    reserved.release();
    return ["last 1", `${error} ${x}`, await db.end()];
  }
);

const outlives = async (fn) => {
  const db = postgres({ ...options, max: 1 });
  let cursor;
  await db
    .begin((tx) => {
      cursor = tx`select generate_series(1, 6) as x`.cursor(2, () =>
        delay(100).then(() => fn(tx))
      );
      return Promise.all([cursor, tx`select 1/0`]);
    })
    .catch(noop);
  const second = await db.begin(async () => {
    await delay(300);
    return "committed";
  });
  const outcome = await cursor.then(
    (x) => `resolved ${x.length}`,
    (error) => error.code || error.message
  );
  return [second, outcome, await db.end()];
};

t(
  "A cursor that throws in its failed transaction rejects with its own error, and the next transaction commits",
  { timeout: 10 },
  async () => {
    const [second, outcome] = await outlives(() => {
      throw new Error("late");
    });
    return ["committed late", `${second} ${outcome}`];
  }
);

t(
  "A cursor that closes in its failed transaction rejects with 25P02, and the next transaction commits",
  { timeout: 10 },
  async () => {
    const [second, outcome] = await outlives((tx) => tx.CLOSE);
    return ["committed 25P02", `${second} ${outcome}`];
  }
);

const aborted = async (conn, how) => {
  const controller = new AbortController();
  const query = conn`select generate_series(1, 10) as x`;
  let calls = 0;
  if (how === "signal") {
    query.signal(controller.signal);
  }
  const outcome = await query
    .cursor(2, async () => {
      calls += 1;
      if (how === "signal") {
        controller.abort();
      } else {
        query.cancel();
      }
      await delay(20);
    })
    .then(
      () => "resolved",
      (error) => error.code
    );
  return `${outcome} ${calls}`;
};

t(
  "Aborting a pool cursor while its callback runs stops it with 57014",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const signalled = await aborted(db, "signal");
    const cancelled = await aborted(db, "cancel");
    const [{ x }] = await db`select 1 as x`;
    const outcomes = [signalled, cancelled, x];
    return ["57014 1 57014 1 1", outcomes.join(" "), await db.end()];
  }
);

t(
  "Cancelling a reserved cursor while its callback runs stops it with 57014",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const reserved = await db.reserve();
    const outcome = await aborted(reserved, "cancel");
    const [{ x }] = await reserved`select 1 as x`;
    reserved.release();
    return ["57014 1 1", `${outcome} ${x}`, await db.end()];
  }
);

t(
  "Aborting a cursor in a transaction stops it with 57014, which rejects the transaction",
  async () => {
    const db = postgres({ ...options, max: 1 });
    let inside;
    const outcome = await db
      .begin(async (tx) => (inside = await aborted(tx, "signal")))
      .catch((error) => error.code);
    return ["57014 1 57014", `${inside} ${outcome}`, await db.end()];
  }
);

t(
  "Aborting a cursor used as an async iterator stops it with 57014",
  async () => {
    const controller = new AbortController();
    let batches = 0;
    let outcome = "done";
    try {
      for await (const rows of sql`select generate_series(1, 10) as x`
        .signal(controller.signal)
        .cursor(2)) {
        batches += rows.length / 2;
        controller.abort();
      }
    } catch (error) {
      outcome = error.code;
    }
    return ["57014 1", `${outcome} ${batches}`];
  }
);

const last = async (conn, fail) => {
  const seen = [];
  const outcome = await conn`select generate_series(1, 3) as x`
    .cursor(2, async (rows) => {
      await delay(20);
      seen.push(rows[0].x);
      if (fail && rows[0].x === 3) {
        throw new Error("last");
      }
    })
    .then(
      () => "resolved",
      (error) => error.message
    );
  return `${seen.join(",")} ${outcome}`;
};

t(
  "A cursor waits for the callback of its last batch, and rejects if it does",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const outcomes = [await last(db), await last(db, true)];
    const reserved = await db.reserve();
    outcomes.push(await last(reserved), await last(reserved, true));
    reserved.release();
    return [
      "1,3 resolved|1,3 last|1,3 resolved|1,3 last",
      outcomes.join("|"),
      await db.end(),
    ];
  }
);

t(
  "A reserved cursor whose callback throws at once rejects and leaves the connection open",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const reserved = await db.reserve();
    const error = await reserved`select generate_series(1, 10) as x`
      .cursor(2, () => {
        throw new Error("at once");
      })
      .catch((cursorError) => cursorError.message);
    const [{ x }] = await reserved`select 1 as x`;
    reserved.release();
    return ["at once 1", `${error} ${x}`, await db.end()];
  }
);
