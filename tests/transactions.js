import net from "node:net";
import { setImmediate as immediate } from "node:timers/promises";

import { postgres, sql, options, delay, idle_timeout } from "./setup.js";
import { t } from "./test.js";

const noop = () => {
  // Deliberately empty: the test does not look at what it is given.
};

t("Throws on illegal transactions", async () => {
  const db = postgres({ ...options, fetch_types: false, max: 2 });
  const error = await db`begin`.catch((beginError) => beginError);
  return [error.code, "UNSAFE_TRANSACTION"];
});

t("Transaction throws", async () => {
  await sql`create table test (a int)`;
  return [
    "22P02",
    await sql
      .begin(async (tx) => {
        await tx`insert into test values(1)`;
        await tx`insert into test values('hej')`;
      })
      .catch((error) => error.code),
    await sql`drop table test`,
  ];
});

t("Transaction rolls back", async () => {
  await sql`create table test (a int)`;
  await sql
    .begin(async (tx) => {
      await tx`insert into test values(1)`;
      await tx`insert into test values('hej')`;
    })
    .catch(noop);
  const { count } = await sql`select a from test`;
  return [0, count, await sql`drop table test`];
});

t("Transaction throws on uncaught savepoint", async () => {
  await sql`create table test (a int)`;

  return [
    "fail",
    await sql
      .begin(async (tx) => {
        await tx`insert into test values(1)`;
        await tx.savepoint(async (inner) => {
          await inner`insert into test values(2)`;
          throw new Error("fail");
        });
      })
      .catch((error) => error.message),
    await sql`drop table test`,
  ];
});

t("Transaction throws on uncaught named savepoint", async () => {
  await sql`create table test (a int)`;

  return [
    "fail",
    await sql
      .begin(async (tx) => {
        await tx`insert into test values(1)`;
        await tx.savepoit("watpoint", async (inner) => {
          await inner`insert into test values(2)`;
          throw new Error("fail");
        });
      })
      .catch(() => "fail"),
    await sql`drop table test`,
  ];
});

t("Transaction succeeds on caught savepoint", async () => {
  await sql`create table test (a int)`;
  await sql.begin(async (tx) => {
    await tx`insert into test values(1)`;
    await tx
      .savepoint(async (inner) => {
        await inner`insert into test values(2)`;
        throw new Error("please rollback");
      })
      .catch(noop);
    await tx`insert into test values(3)`;
  });

  const [{ count }] = await sql`select count(1) from test`;
  return ["2", count, await sql`drop table test`];
});

t("Savepoint returns Result", async () => {
  let result;
  await sql.begin(async (tx) => {
    result = await tx.savepoint((inner) => inner`select 1 as x`);
  });

  return [1, result[0].x];
});

t("Prepared transaction", async () => {
  await sql`create table test (a int)`;

  await sql.begin(async (tx) => {
    await tx`insert into test values(1)`;
    await tx.prepare("tx1");
  });

  await sql`commit prepared 'tx1'`;

  const [{ count }] = await sql`select count(1) from test`;
  return ["1", count, await sql`drop table test`];
});

t("Transaction requests are executed implicitly", async () => {
  const db = postgres({ debug: true, fetch_types: false, idle_timeout: 1 });
  const [, [{ x }]] = await db.begin((tx) => [
    tx`select set_config('postgres_js.test', 'testing', true)`,
    tx`select current_setting('postgres_js.test') as x`,
  ]);
  return ["testing", x];
});

t("Uncaught transaction request errors bubbles to transaction", async () => [
  "42703",
  await sql
    .begin((tx) => [
      tx`select wat`,
      tx`select current_setting('postgres_js.test') as x, ${1} as a`,
    ])
    .catch((error) => error.code),
]);

t("Fragments in transactions", async () => {
  const [{ x }] = await sql.begin(
    (tx) => tx`select true as x where ${tx`1=1`}`
  );
  return [true, x];
});

t("Transaction rejects with rethrown error", async () => [
  "WAT",
  await sql
    .begin(async (tx) => {
      try {
        await tx`select exception`;
      } catch {
        throw new Error("WAT");
      }
    })
    .catch((error) => error.message),
]);

t("Parallel transactions", async () => {
  await sql`create table test (a int)`;
  const results = await Promise.all([
    sql.begin((tx) => tx`select 1`),
    sql.begin((tx) => tx`select 1`),
  ]);
  return [
    "11",
    results.map((x) => x.count).join(""),
    await sql`drop table test`,
  ];
});

t("Many transactions at beginning of connection", async () => {
  const db = postgres(options);
  const xs = await Promise.all(
    Array.from({ length: 100 }, () => db.begin((tx) => tx`select 1`))
  );
  return [100, xs.length];
});

t("Transactions array", async () => {
  await sql`create table test (a int)`;

  const results = await sql.begin((tx) => [
    tx`select 1`.then((x) => x),
    tx`select 1`,
  ]);
  return [
    "11",
    results.map((x) => x.count).join(""),
    await sql`drop table test`,
  ];
});

t("Transaction waits", async () => {
  await sql`create table test (a int)`;
  await sql.begin(async (tx) => {
    await tx`insert into test values(1)`;
    await tx
      .savepoint(async (inner) => {
        await inner`insert into test values(2)`;
        throw new Error("please rollback");
      })
      .catch(noop);
    await tx`insert into test values(3)`;
  });

  const results = await Promise.all([
    sql.begin((tx) => tx`select 1`),
    sql.begin((tx) => tx`select 1`),
  ]);
  return [
    "11",
    results.map((x) => x.count).join(""),
    await sql`drop table test`,
  ];
});

t("Helpers in Transaction", async () => {
  const [{ x }] = await sql.begin(
    async (tx) => await tx`select ${tx({ x: 1 })}`
  );
  return ["1", x];
});

t(
  "Connection errors are caught using begin()",
  {
    timeout: 2,
  },
  async () => {
    let error;
    try {
      const db = postgres({ host: "localhost", port: 1 });

      await db.begin(async (tx) => {
        await tx`insert into test (label, value) values (${1}, ${2})`;
      });
    } catch (connectError) {
      error = connectError;
    }

    return [
      true,
      error.code === "ECONNREFUSED" ||
        error.message === "Connection refused (os error 61)",
    ];
  }
);

t("Throws correct error when retrying in transactions", async () => {
  await sql`create table test(x int)`;
  const error = await sql
    .begin((tx) => tx`insert into test (x) values (${tx.typed(false, 16)})`)
    .catch((insertError) => insertError);
  return [error.code, "42804", sql`drop table test`];
});

t(
  "Properly throws routine error on not prepared statements in transaction",
  async () => {
    const { routine } = await sql
      .begin((tx) => [
        tx`create table x (x text[])`,
        tx`insert into x(x) values (('a', 'b'))`,
      ])
      .catch((error) => error);

    return ["transformAssignedExpr", routine];
  }
);

t("Catches type serialize errors in transactions", async () => {
  const db = postgres({
    idle_timeout,
    types: {
      text: {
        from: 25,
        parse: (x) => x,
        serialize: () => {
          throw new Error("watSerialize");
        },
        to: 25,
      },
    },
  });

  return [
    "watSerialize",
    await db
      .begin((tx) => {
        void tx`select 1`;
        return tx`select ${"wat"}`;
      })
      .catch((error) => error.message),
  ];
});

t("Catches type parse errors in transactions", async () => {
  const db = postgres({
    idle_timeout,
    types: {
      text: {
        from: 25,
        parse: () => {
          throw new Error("watParse");
        },
        serialize: (x) => x,
        to: 25,
      },
    },
  });

  return [
    "watParse",
    await db
      .begin((tx) => {
        void tx`select 1`;
        return tx`select 'wat'`;
      })
      .catch((error) => error.message),
  ];
});

t("Prevent premature end of connection in transaction", async () => {
  const db = postgres({ idle_timeout, max_lifetime: 0.01 });
  const result = await db.begin(async (tx) => {
    await tx`select 1`;
    await delay(20);
    await tx`select 1`;
    return "yay";
  });

  return ["yay", result];
});

t(
  "Ensure reconnect after max_lifetime with transactions",
  { timeout: 5 },
  async () => {
    const db = postgres({
      idle_timeout,
      max: 1,
      max_lifetime: 0.01,
    });

    for (let x = 0; x < 10; x += 1) {
      await db.begin((tx) => tx`select 1 as x`);
    }

    return [true, true];
  }
);

t(
  "Ensure transactions throw if connection is closed dwhile there is no query",
  async () => {
    const db = postgres(options);
    const x = await db
      .begin(async () => {
        setTimeout(() => db.end({ timeout: 0 }), 10);
        await delay(200);
        return db`select 1`;
      })
      .catch((error) => error);
    return ["CONNECTION_CLOSED", x.code];
  }
);

t("Does not try rollback when commit errors", async () => {
  let notice = null;
  const db = postgres({ ...options, onnotice: (x) => (notice = x) });
  await db`create table test(x int constraint test_constraint unique deferrable initially deferred)`;

  await db
    .begin("isolation level serializable", async (tx) => {
      await tx`insert into test values(1)`;
      await tx`insert into test values(1)`;
    })
    .catch((error) => error);

  return [notice, null, await db`drop table test`];
});

t("Transaction rejects when the server rolls back the commit", async () => {
  const db = postgres({ ...options, max: 1 });
  let xid;
  const result = await db
    .begin(async (tx) => {
      [{ xid }] = await tx`select pg_current_xact_id()::text as xid`;
      await tx`savepoint parent_marker`;
      await tx
        .savepoint(async (inner) => {
          await inner`rollback to savepoint parent_marker`;
          throw new Error("force");
        })
        .catch(noop);
      return "committed";
    })
    .then(
      (x) => x,
      () => "rejected"
    );
  const [{ status }] = await db`select pg_xact_status(${xid}::xid8) as status`;
  return ["rejected,aborted", `${result},${status}`, await db.end()];
});

t("Caught error inside a transaction still rejects it", async () => {
  await sql`create table test (x int)`;
  const result = await sql
    .begin(async (tx) => {
      await tx`insert into test values (1)`;
      await tx`select 1/0`.catch(noop);
      return "committed";
    })
    .then(
      (x) => x,
      () => "rejected"
    );
  const [{ count }] = await sql`select count(*)::int from test`;
  return ["rejected,0", `${result},${count}`, await sql`drop table test`];
});

t("Notify inside a transaction with max 1", async () => {
  const db = postgres({ ...options, max: 1 });
  return [
    "ok",
    await db.begin((tx) => tx.notify("test", "x")).then(() => "ok"),
    await db.end(),
  ];
});

t("Transaction at pipeline boundary is reserved", async () => {
  const db = postgres({
    ...options,
    fetch_types: false,
    max: 2,
    max_pipeline: 1,
  });
  await Promise.all([db`select 1`, db`select 1`]);
  const inflight = [
    db`select pg_sleep(0.1)`.execute(),
    db`select pg_sleep(0.1)`.execute(),
  ];
  const x = await db
    .begin((tx) => tx`select 1 as x`)
    .then(
      (rows) => rows[0].x,
      (error) => error.code
    );
  await Promise.all(inflight);
  return [1, x, await db.end()];
});

t("Transaction is reserved with pipelining disabled", async () => {
  const db = postgres({
    ...options,
    fetch_types: false,
    max: 2,
    max_pipeline: 0,
  });
  const x = await db
    .begin((tx) => tx`select 1 as x`)
    .then(
      (rows) => rows[0].x,
      (error) => error.code
    );
  return [1, x, await db.end()];
});

t(
  "Query issued while BEGIN is in flight does not join the transaction",
  async () => {
    const db = postgres({ ...options, fetch_types: false, max: 1 });
    await db`create table test (a int)`;
    const transaction = db
      .begin(async (tx) => {
        await tx`select 1`;
        throw new Error("rollback");
      })
      .catch(noop);
    const insert = db`insert into test values (1)`;
    await Promise.all([transaction, insert]);
    const [{ n }] = await db`select count(*)::int as n from test`;
    return [1, n, await db`drop table test`, await db.end()];
  }
);

t("Transaction with sequential queries works with max_pipeline 0", async () => {
  const db = postgres({ ...options, max: 4, max_pipeline: 0 });
  return [
    "testing",
    await db.begin(async (tx) => {
      await tx`select set_config('postgres_js.test', 'testing', true)`;
      const [{ x }] = await tx`select current_setting('postgres_js.test') as x`;
      return x;
    }),
    await db.end(),
  ];
});

t("Transaction with concurrent queries works with max_pipeline 0", async () => {
  const db = postgres({ ...options, max: 4, max_pipeline: 0 });
  const [, [{ x }]] = await db.begin((tx) => [
    tx`select set_config('postgres_js.test', 'testing', true)`,
    tx`select current_setting('postgres_js.test') as x`,
  ]);
  return ["testing", x, await db.end()];
});

t(
  "Undefined value in a transaction returning an array of queries rejects",
  async () => {
    const db = postgres(options);
    await db`create table test (x int)`;
    const error = await db
      .begin((tx) => [
        tx`insert into test values (1)`,
        tx`select ${undefined} as x`,
      ])
      .catch((queryError) => queryError.code);
    const [{ count }] = await db`select count(*)::int from test`;
    await db`drop table test`;
    await db.end();
    return ["UNDEFINED_VALUE,0", [error, count].join(",")];
  }
);

t(
  "Undefined value aborts a pipelined transaction on a reserved connection",
  async () => {
    const db = postgres(options);
    await db`create table test (x int)`;
    const reserved = await db.reserve();
    const results = await Promise.all(
      [
        reserved`begin`,
        reserved`insert into test values (1)`,
        reserved`select ${undefined} as x`,
        reserved`insert into test values (2)`,
        reserved`commit`,
      ].map((x) =>
        x.then(
          (result) => result.command,
          (error) => error.code
        )
      )
    );
    reserved.release();
    const [{ count }] = await db`select count(*)::int from test`;
    await db`drop table test`;
    await db.end();
    return [
      "BEGIN,INSERT,UNDEFINED_VALUE,25P02,ROLLBACK,0",
      [...results, count].join(","),
    ];
  }
);

t(
  "Parameter failing to serialize aborts a pipelined transaction on a reserved connection",
  async () => {
    const db = postgres(options);
    await db`create table test (x int)`;
    const reserved = await db.reserve();
    const results = await Promise.all(
      [
        reserved`begin`,
        reserved`insert into test values (1)`,
        reserved`select ${new Date(Number.NaN)}::timestamptz as x`,
        reserved`insert into test values (2)`,
        reserved`commit`,
      ].map((x) =>
        x.then(
          (result) => result.command,
          (error) => error.code || error.name
        )
      )
    );
    reserved.release();
    const [{ count }] = await db`select count(*)::int from test`;
    await db`drop table test`;
    await db.end();
    return [
      "BEGIN,INSERT,RangeError,25P02,ROLLBACK,0",
      [...results, count].join(","),
    ];
  }
);

t("Does not reject leftover begin onclose after commit", async () => {
  const db = postgres({ ...options, max: 1 });
  const rejections = [];
  const onUnhandled = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await db.begin((tx) => tx`select 1`);
    await db.end({ timeout: 0 });
    await delay(50);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return [0, rejections.length];
});

t(
  "idle_in_transaction_session_timeout rejects the transaction",
  { timeout: 5 },
  async () => {
    const db = postgres(options);
    const error = await db
      .begin(async (tx) => {
        await tx`set local idle_in_transaction_session_timeout = '1s'`;
        await delay(1500);
        await tx`select 1`;
      })
      .catch((timeoutError) => timeoutError);
    await db.end();
    return ["25P03", error.code];
  }
);

t(
  "Transaction queries fail after its connection is gone even if the callback continues",
  { timeout: 5 },
  async () => {
    const db = postgres({ ...options, max: 1 });
    setTimeout(() => db`select 1`.catch(noop), 1200);
    let code;
    await db
      .begin(async (tx) => {
        await tx`set local idle_in_transaction_session_timeout = '1s'`;
        await delay(1500);
        code = await tx`select 'should fail'`.then(
          () => "ran",
          (error) => error.code
        );
      })
      .catch(noop);
    await delay(1000);
    await db.end();
    return ["CONNECTION_CLOSED", code];
  }
);

t(
  "Disconnect rejects queued transaction queries and allows reconnect",
  async () => {
    const db = postgres({ ...options, fetch_types: false, max_pipeline: 1 });
    let queries;

    try {
      const error = await db
        .begin((tx) => {
          queries = [
            tx`select pg_terminate_backend(pg_backend_pid())`.execute(),
            tx`select 1`.execute(),
            tx`select 2`.execute(),
          ];
          return Promise.allSettled(queries);
        })
        .catch((beginError) => beginError);

      const results = await Promise.allSettled(queries);
      const [{ x }] = await db`select 1 as x`;
      return [
        "57P01,rejected,rejected,rejected,1",
        [error.code, ...results.map((result) => result.status), x].join(","),
      ];
    } finally {
      await db.end({ timeout: 0 });
    }
  }
);

t("Disconnected transaction cannot query a reused connection", () =>
  withDisconnectedTransaction(({ pool, disconnected }) =>
    pool.begin(async (tx) => {
      await tx`select set_config('postgres_js.test', 'replacement', true)`;
      const result =
        await disconnected`select current_setting('postgres_js.test') as x`.catch(
          (error) => error
        );
      return ["CONNECTION_CLOSED", result.code];
    })
  )
);

t("Disconnected transaction cannot commit a reused connection", () =>
  finishDisconnectedTransaction()
);

t("Disconnected transaction cannot roll back a reused connection", () =>
  finishDisconnectedTransaction(new Error("original callback failed"))
);

const finishDisconnectedTransaction = (error) =>
  withDisconnectedTransaction(({ pool, finish }) =>
    pool.begin(async (tx) => {
      const [{ x: before }] = await tx`select txid_current()::text as x`;
      finish(error);
      await immediate();
      const [{ x: after }] = await tx`select txid_current()::text as x`;
      return [before, after];
    })
  );

const withDisconnectedTransaction = async (fn) => {
  const pool = postgres({ ...options, fetch_types: false });
  const gate = Promise.withResolvers();
  const finish = (error) => (error ? gate.reject(error) : gate.resolve());
  const connected = Promise.withResolvers();
  const failed = pool
    .begin(async (tx) => {
      const [{ pid }] = await tx`select pg_backend_pid() as pid`;
      connected.resolve({ disconnected: tx, pid });
      await gate.promise;
    })
    .catch((beginError) => beginError);

  try {
    const { disconnected, pid } = await Promise.race([
      connected.promise,
      failed.then((beginError) => {
        throw beginError;
      }),
    ]);
    await sql`select pg_terminate_backend(${pid}::int)`;
    await failed;
    return await fn({ disconnected, finish, pool });
  } finally {
    finish();
    await immediate();
    await pool.end({ timeout: 0 });
  }
};

t("Savepoint names are quoted", async () => {
  await sql`create table test (a int)`;
  await sql.begin(async (tx) => {
    await tx.savepoint(
      "with space",
      (inner) => inner`insert into test values (1)`
    );
    await tx.savepoint(
      'a";create table test_injected (a int);--',
      (inner) => inner`insert into test values (2)`
    );
  });
  const [{ injected }] =
    await sql`select to_regclass('test_injected') is not null as injected`;
  const [{ n }] = await sql`select count(*)::int as n from test`;
  return ["2 false", `${n} ${injected}`, await sql`drop table test`];
});

t("A prepared transaction name cannot close its quote", async () => {
  const name = "tx'; create table test_injected (a int); --";
  await sql.begin((tx) => {
    tx.prepare(name);
    return tx`select 1`;
  });
  const [{ gid }] =
    await sql`select gid from pg_prepared_xacts where gid like 'tx%'`;
  await sql.unsafe(`rollback prepared '${gid.replaceAll("'", "''")}'`);
  const [{ injected }] =
    await sql`select to_regclass('test_injected') is not null as injected`;
  return ["false", String(injected)];
});

t(
  "An unsafe begin is rejected and rolled back, and the queries behind it get their own answers",
  async () => {
    const db = postgres({ ...options, max: 2 });
    await db`create table test (a int)`;
    const results = await Promise.all([
      db`begin`.then(
        (x) => x.command,
        (error) => error.code
      ),
      db`insert into test values (1) returning a`.then(
        (x) => `${x.command}:${x[0].a}`,
        (error) => error.code
      ),
      db`select 'third' as x`.then(
        (x) => `${x.command}:${x[0].x}`,
        (error) => error.code
      ),
    ]);
    const [{ n }] = await db`select count(*)::int as n from test`;
    return [
      "UNSAFE_TRANSACTION,INSERT:1,SELECT:third 1",
      `${results.join(",")} ${n}`,
      await db`drop table test`,
      await db.end(),
    ];
  }
);

t(
  "A begin hidden behind a comment runs alone, rolls back and leaves the queries pipelined behind it alone",
  async () => {
    const db = postgres({ ...options, max: 2 });
    await db`create table test (a int)`;
    const reserved = await db.reserve();
    const results = await Promise.all([
      db`/* hidden */ begin`.then(
        (x) => x.command,
        (error) => error.code
      ),
      db`insert into test values (1) returning a`.then(
        (x) => x.command,
        (error) => error.code
      ),
      db`select 'third' as x`.then(
        (x) => x.command,
        (error) => error.code
      ),
    ]);
    reserved.release();
    const [{ n }] = await db`select count(*)::int as n from test`;
    const after = await Promise.all([
      db`select 1 as x`,
      db`select 2 as x`,
    ]).then((x) => x.map((r) => r[0].x).join(","));
    return [
      "UNSAFE_TRANSACTION,INSERT,SELECT 1 1,2",
      `${results.join(",")} ${n} ${after}`,
      await db`drop table test`,
      await db.end(),
    ];
  }
);

t(
  "A begin used again runs alone again, whether tagged, unsafe, prepared or not",
  async () => {
    const db = postgres({ ...options, max: 2 });
    await db`create table test (a int)`;
    const begins = [
      () => db`begin`,
      () => db.unsafe("begin"),
      () => db.unsafe("begin", [], { simple: false }),
      () => db.unsafe("begin", [], { prepare: true, simple: false }),
    ];
    const results = [];
    for (let i = 0; i < 2; i += 1) {
      for (const begin of begins) {
        const commands = await Promise.all([
          begin().then(
            (x) => x.command,
            (error) => error.code
          ),
          db`insert into test values (1) returning a`.then(
            (x) => x.command,
            (error) => error.code
          ),
        ]);
        results.push(commands.join(":"));
      }
    }
    const [{ n }] = await db`select count(*)::int as n from test`;
    return [
      `${Array.from({ length: 8 }, () => "UNSAFE_TRANSACTION:INSERT").join(",")} 8`,
      `${results.join(",")} ${n}`,
      await db`drop table test`,
      await db.end(),
    ];
  }
);

t(
  "A script with its own BEGIN and COMMIT in one simple query runs on the pool",
  async () => {
    const db = postgres({ ...options, max: 2 });
    await db`create table test (a int)`;
    const commands = await db
      .unsafe("begin; insert into test values (1); commit;")
      .then((x) => x.map((r) => r.command).join(","));
    const after = await db
      .unsafe("select 1; begin; insert into test values (2); commit")
      .then((x) => x.map((r) => r.command).join(","));
    const [{ n }] = await db`select count(*)::int as n from test`;
    return [
      "BEGIN,INSERT,COMMIT SELECT,BEGIN,INSERT,COMMIT 2",
      `${commands} ${after} ${n}`,
      await db`drop table test`,
      await db.end(),
    ];
  }
);

t(
  "A query that leaves a transaction open on the pool is rejected and rolled back",
  async () => {
    const db = postgres({ ...options, max: 2 });
    await db`create table test (a int)`;
    const opened = await db.unsafe("select 1; start transaction").then(
      () => "ok",
      (error) => error.code
    );
    for (let i = 0; i < 4; i += 1) {
      await db`insert into test values (${i})`;
    }
    await db.end();
    const check = postgres(options);
    const [{ n }] = await check`select count(*)::int as n from test`;
    return [
      "UNSAFE_TRANSACTION 4",
      `${opened} ${n}`,
      await check`drop table test`,
      await check.end(),
    ];
  }
);

t(
  "A query issued before sql.begin runs before the transaction with max: 1",
  async () => {
    const db = postgres({ ...options, max: 1 });
    await db`create table test (a int)`;
    const first = db`select count(*)::int as n from test`.execute();
    const transaction = db.begin((tx) => tx`insert into test values (1)`);
    const [{ n }] = await first;
    await transaction;
    return [0, n, await db`drop table test`, await db.end()];
  }
);

t(
  "A caught query that cannot be built aborts a transaction opened by hand on a reserved connection",
  async () => {
    const db = postgres(options);
    await db`create table test (a int)`;
    const reserved = await db.reserve();
    await reserved`begin`;
    await reserved`insert into test values (1)`;
    const bad = await reserved`select ${undefined} as x`.catch(
      (error) => error.code
    );
    const commit = await reserved`commit`;
    reserved.release();
    const [{ n }] = await db`select count(*)::int as n from test`;
    return [
      "UNDEFINED_VALUE ROLLBACK 0",
      `${bad} ${commit.command} ${n}`,
      await db`drop table test`,
      await db.end(),
    ];
  }
);

t(
  "A query that cannot be built on a reserved connection outside a transaction leaves the connection usable",
  async () => {
    const db = postgres(options);
    const reserved = await db.reserve();
    const bad = await reserved`select ${undefined} as x`.catch(
      (error) => error.code
    );
    const [{ x }] = await reserved`select 1 as x`;
    reserved.release();
    return ["UNDEFINED_VALUE 1", `${bad} ${x}`, await db.end()];
  }
);

t("sql.begin inside a transaction runs in a savepoint", async () => {
  await sql`create table test (x int)`;
  const result = await sql.begin(async (tx) => {
    await tx`insert into test values (1)`;
    await tx.begin((inner) => inner`insert into test values (2)`);
    await tx
      .begin(async (inner) => {
        await inner`insert into test values (3)`;
        throw new Error("undo 3");
      })
      .catch(noop);
    return tx`select array_agg(x order by x)::text as xs from test`;
  });
  return ["{1,2}", result[0].xs, await sql`drop table test`];
});

t(
  "A nested sql.begin with a different mode throws, the same mode is allowed",
  async () => {
    const codes = await sql.begin("read write", async (tx) => [
      await tx
        .begin("read only", (inner) => inner`select 1`)
        .then(
          () => "ran",
          (error) => error.code
        ),
      await tx
        .begin("READ  write", (inner) => inner`select 1`)
        .then(
          () => "ran",
          (error) => error.code
        ),
    ]);
    return ["NESTED_TRANSACTION_MODE,ran", codes.join(",")];
  }
);

t("A nested sql.begin can not be prepared", async () => {
  // oxlint-disable-next-line require-await -- the transaction is given a promise, as before
  const code = await sql.begin(async (tx) =>
    tx
      // oxlint-disable-next-line require-await -- the throw becomes a rejection here, as before
      .begin(async (inner) => inner.prepare("x"))
      .then(
        () => "ran",
        (error) => error.code
      )
  );
  return ["NESTED_TRANSACTION_MODE", code];
});

t("A tagged savepoint runs its query in a savepoint", async () => {
  const [x] = await sql.begin((tx) => tx.savepoint`select 1 as x`);
  return [1, x.x];
});

t(
  "Queries in a Promise.all inside a transaction are pipelined in the order they were made (#951)",
  { timeout: 10 },
  async () => {
    const nodeNet = await import("node:net");
    const proxy = nodeNet.createServer((client) => {
      const server = nodeNet.connect(5432, "127.0.0.1");
      client.on("data", (x) => setTimeout(() => server.write(x), 50));
      server.on("data", (x) => setTimeout(() => client.write(x), 50));
      client.on("close", () => server.destroy());
      server.on("close", () => client.destroy());
      client.on("error", noop);
      server.on("error", noop);
    });
    const listening = Promise.withResolvers();
    proxy.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const db = postgres({
      ...options,
      fetch_types: false,
      host: "127.0.0.1",
      max: 1,
      port: proxy.address().port,
    });
    const result = await db.begin(async (tx) => {
      await tx`create table test (x int)`;
      let start = Date.now();
      for (let i = 0; i < 5; i += 1) {
        await tx`select ${i}::int`;
      }
      const sequential = Date.now() - start;
      start = Date.now();
      const [, counted, , summed] = await Promise.all([
        tx`insert into test values (1)`,
        tx`select count(*)::int as n from test`,
        tx`insert into test values (2)`,
        tx`select sum(x)::int as n from test`,
        tx`select 1`,
      ]);
      return [
        Date.now() - start < sequential / 2,
        counted[0].n,
        summed[0].n,
      ].join(" ");
    });
    await db.end();
    proxy.close();
    return ["true 1 3", result];
  }
);

t(
  "sql.rollback() rolls back without throwing, and begin resolves with the result (#500)",
  async () => {
    await sql`create table test (x int)`;
    const result = await sql.begin(async (tx) => {
      await tx`insert into test values (1)`;
      await tx.rollback();
      return "value";
    });
    const [{ n }] = await sql`select count(*)::int as n from test`;
    return ["value 0", `${result} ${n}`, await sql`drop table test`];
  }
);

t(
  "sql.rollback() in a savepoint or nested begin rolls back only that, and the outer transaction commits",
  async () => {
    await sql`create table test (x int)`;
    await sql.begin(async (tx) => {
      await tx`insert into test values (1)`;
      await tx.savepoint(async (inner) => {
        await inner`insert into test values (2)`;
        return inner.rollback();
      });
      await tx.begin(async (inner) => {
        await inner`insert into test values (3)`;
        return inner.rollback();
      });
      await tx`insert into test values (4)`;
    });
    const [{ xs }] =
      await sql`select string_agg(x::text, ',' order by x) as xs from test`;
    return ["1,4", xs, await sql`drop table test`];
  }
);

t(
  "Queries, savepoints and nested begins after sql.rollback() are not sent and reject with TRANSACTION_ROLLED_BACK",
  async () => {
    await sql`create table test (x int)`;
    const codes = [];
    const outcome = await sql
      .begin(async (tx) => {
        await tx.rollback();
        const inserted = await tx`insert into test values (1)`.catch(
          (error) => error.code
        );
        const savepointed = await tx
          .savepoint((inner) => inner`select 1`)
          .catch((error) => error.code);
        const nested = await tx
          .begin((inner) => inner`select 1`)
          .catch((error) => error.code);
        codes.push(inserted, savepointed, nested);
      })
      .catch((error) => error.code);
    const [{ n }] = await sql`select count(*)::int as n from test`;
    return [
      "TRANSACTION_ROLLED_BACK,TRANSACTION_ROLLED_BACK,TRANSACTION_ROLLED_BACK TRANSACTION_ROLLED_BACK 0",
      `${codes.join(",")} ${outcome} ${n}`,
      await sql`drop table test`,
    ];
  }
);

t(
  "sql.rollback() comes after the queries already made, and the connection is left idle",
  async () => {
    const db = postgres({ ...options, max: 1 });
    await db`create table test (x int)`;
    let same;
    await db.begin((tx) => {
      void tx`insert into test values (1)`;
      const a = tx.rollback();
      same = a === tx.rollback();
      return a;
    });
    const [{ n }] = await db`select count(*)::int as n from test`;
    const [{ status }] =
      await db`select state as status from pg_stat_activity where pid = pg_backend_pid()`;
    return [
      "true 0 active",
      `${same} ${n} ${status}`,
      await db`drop table test`,
      await db.end(),
    ];
  }
);

t(
  "A transaction ended by transaction_timeout rejects with the FATAL error instead of CONNECTION_CLOSED (#1283)",
  async () => {
    const [{ supported }] =
      await sql`select current_setting('server_version_num')::int >= 170000 as supported`;
    if (!supported) {
      return [true, true];
    }

    const timed = postgres({ ...options, max: 1 });
    const error = await timed
      .begin(async (tx) => {
        await tx`select set_config('transaction_timeout', '200', true)`;
        await tx`select pg_sleep(2)`;
      })
      .catch((timeoutError) => timeoutError);
    return [
      "25P04 FATAL",
      `${error.code} ${error.severity}`,
      await timed.end(),
    ];
  }
);

t(
  "A transaction whose backend is terminated mid-query rejects with the FATAL error (#1283)",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const killer = postgres({ ...options, max: 1 });
    const error = await db
      .begin(async (tx) => {
        const [{ pid }] = await tx`select pg_backend_pid() as pid`;
        const query = tx`select pg_sleep(2)`.execute();
        for (;;) {
          const [{ sleeping }] =
            await killer`select wait_event = 'PgSleep' as sleeping from pg_stat_activity where pid = ${pid}`;
          if (sleeping) {
            break;
          }
          await delay(1);
        }
        await killer`select pg_terminate_backend(${pid})`;
        await query;
      })
      .catch((beginError) => beginError);
    return [
      "57P01 FATAL",
      `${error.code} ${error.severity}`,
      await killer.end(),
      await db.end(),
    ];
  }
);

t(
  "A transaction terminated between statements rejects with the FATAL error, and its next query has it as cause (#1283)",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const killer = postgres({ ...options, max: 1 });
    const next = Promise.withResolvers();
    const error = await db
      .begin(async (tx) => {
        const [{ pid }] = await tx`select pg_backend_pid() as pid`;
        await killer`select pg_terminate_backend(${pid})`;
        await delay(100);
        next.resolve(await tx`select 1`.catch((queryError) => queryError));
      })
      .catch((beginError) => beginError);
    const later = await next.promise;
    return [
      "57P01 FATAL CONNECTION_CLOSED 57P01",
      [
        error.code,
        error.severity,
        later.code,
        later.cause && later.cause.code,
      ].join(" "),
      await killer.end(),
      await db.end(),
    ];
  }
);

t(
  "A FATAL in answer to COMMIT rejects with CONNECTION_CLOSED, with the FATAL as cause",
  { timeout: 10 },
  async () => {
    const db = postgres({ ...options, max: 1 });
    await db`create table test (id int)`;
    await db`
    create function test_kill() returns trigger language plpgsql
    as $$ begin perform pg_terminate_backend(pg_backend_pid()); return null; end $$
  `;
    await db`create constraint trigger test_kill after insert on test deferrable initially deferred for each row execute function test_kill()`;
    const error = await db
      .begin((tx) => tx`insert into test values (1)`)
      .catch((commitError) => commitError);
    const [{ n }] = await db`select count(*)::int as n from test`;
    return [
      "CONNECTION_CLOSED 57P01 0",
      [error.code, error.cause && error.cause.code, n].join(" "),
      await db`drop table test`,
      await db`drop function test_kill`,
      await db.end(),
    ];
  }
);

t(
  "A savepoint or nested begin rejects when the connection is lost while its callback runs (#1281)",
  { timeout: 10 },
  async () => {
    const outcomes = [];
    for (const method of ["savepoint", "begin"]) {
      const db = postgres({ ...options, max: 1 });
      const killer = postgres({ ...options, max: 1 });
      const pid = Promise.withResolvers();
      const gate = Promise.withResolvers();
      const child = Promise.withResolvers();
      const root = db
        .begin((tx) =>
          tx[method](async (inner) => {
            const [x] = await inner`select pg_backend_pid() as pid`;
            pid.resolve(x.pid);
            await gate.promise;
            return "child";
          })
            .then(
              () => "fulfilled",
              (childError) => childError.code
            )
            .then((x) => {
              child.resolve(x);
              return x;
            })
        )
        .catch((beginError) => beginError.code);
      await killer`select pg_terminate_backend(${await pid.promise})`;
      const outer = await root;
      gate.resolve();
      outcomes.push(`${outer} ${await child.promise}`);
      await killer.end();
      await db.end();
    }
    return ["57P01 57P01,57P01 57P01", outcomes.join(",")];
  }
);

const writes = async (fn) => {
  let count = 0;
  const server = net.createServer((client) => {
    const upstream = net.connect(
      options.port || 5432,
      options.host || "localhost"
    );
    client.on("data", (x) => {
      count += 1;
      upstream.write(x);
    });
    upstream.on("data", (x) => client.write(x));
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  const listening = Promise.withResolvers();
  server.listen(0, "localhost", listening.resolve);
  await listening.promise;
  const db = postgres({
    ...options,
    host: "localhost",
    max: 1,
    port: server.address().port,
  });
  await db`select ${1}::int as x`;
  try {
    count = 0;
    const result = await fn(db);
    return `${count} ${result}`;
  } finally {
    await db.end();
    server.close();
  }
};

t("begin waits for BEGIN before the first statement", async () => [
  "3 1",
  await writes((db) =>
    db.begin((tx) => tx`select ${1}::int as x`).then(([x]) => x.x)
  ),
]);

t(
  "begin with a transaction mode waits for BEGIN before the first statement",
  async () => [
    "3 1",
    await writes((db) =>
      db
        .begin("read write", (tx) => tx`select ${1}::int as x`)
        .then(([x]) => x.x)
    ),
  ]
);

t(
  "begin with a mode the server refuses runs none of the statements",
  async () => {
    await sql`create table test (x int)`;
    const error = await sql
      .begin(
        "isolation level nonsense",
        (tx) => tx`insert into test values (1)`
      )
      .catch((beginError) => beginError.code);
    const [{ n }] = await sql`select count(*)::int as n from test`;
    return ["42601 0", `${error} ${n}`, await sql`drop table test`];
  }
);

t(
  "A transaction whose BEGIN is canceled writes nothing",
  { timeout: 30 },
  async () => {
    const victim = postgres({
      ...options,
      connection: { application_name: "begin_cancel" },
      max: 1,
    });
    const other = postgres({ ...options, max: 1 });
    await other`create table test (i int)`;
    const spraying = { on: true };
    const spray = (async () => {
      while (spraying.on) {
        await other`select pg_cancel_backend(pid) from pg_stat_activity where application_name = 'begin_cancel'`;
      }
    })();
    let wrong = 0;
    let canceled = 0;
    for (let i = 0; i < 500; i += 1) {
      const failed = await victim
        .begin(async (tx) => {
          await tx`insert into test values (${i})`;
          await tx`insert into test values (${i})`;
        })
        .then(
          () => false,
          (error) => error.code === "57014" || Promise.reject(error)
        );
      const [{ n }] =
        await other`select count(*)::int as n from test where i = ${i}`;
      if (failed) {
        canceled += 1;
      }
      if (failed ? n !== 0 : n !== 2) {
        wrong += 1;
      }
    }
    spraying.on = false;
    await spray;
    return [
      "0 true",
      `${wrong} ${canceled > 0}`,
      await other`drop table test`,
      await victim.end(),
      await other.end(),
    ];
  }
);
