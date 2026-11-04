import net from "node:net";

import { postgres, sql, options, delay } from "./setup.js";
import { t } from "./test.js";

const noop = () => {
  // Deliberately empty: the test does not look at what it is given.
};

t("unsafe describe", async () => {
  const q = "insert into test values (1)";
  await sql`create table test(a int unique)`;
  await sql.unsafe(q).describe();
  const x = await sql.unsafe(q).describe();
  return [q, x.string, await sql`drop table test`];
});

t("Automatically creates prepared statements", async () => {
  const db = postgres(options);
  const result = await db`select * from pg_prepared_statements`;
  return [true, result.some((x) => (x.name = result.statement.name))];
});

t("no_prepare: true disables prepared statements (deprecated)", async () => {
  const db = postgres({ ...options, no_prepare: true });
  const result = await db`select * from pg_prepared_statements`;
  return [false, result.some((x) => (x.name = result.statement.name))];
});

t("prepare: false disables prepared statements", async () => {
  const db = postgres({ ...options, prepare: false });
  const result = await db`select * from pg_prepared_statements`;
  return [false, result.some((x) => (x.name = result.statement.name))];
});

t("prepare: true enables prepared statements", async () => {
  const db = postgres({ ...options, prepare: true });
  const result = await db`select * from pg_prepared_statements`;
  return [true, result.some((x) => (x.name = result.statement.name))];
});

t('prepares unsafe query when "prepare" option is true', async () => {
  const db = postgres({ ...options, prepare: true });
  const result = await db.unsafe(
    "select * from pg_prepared_statements where name <> $1",
    ["bla"],
    { prepare: true }
  );
  return [true, result.some((x) => (x.name = result.statement.name))];
});

t("does not prepare unsafe query by default", async () => {
  const db = postgres({ ...options, prepare: true });
  const result = await db.unsafe(
    "select * from pg_prepared_statements where name <> $1",
    ["bla"]
  );
  return [false, result.some((x) => (x.name = result.statement.name))];
});

const insertName = () =>
  sql`insert into test (name) values (${"1"}) returning name`;

t("Recreate prepared statements on transformAssignedExpr error", async () => {
  await sql`create table test (name text)`;
  await insertName();
  await sql`alter table test alter column name type int using name::integer`;
  const [{ name }] = await insertName();
  return [1, name, await sql`drop table test`];
});

const selectName = () => sql`select name from test`;

t("Recreate prepared statements on RevalidateCachedQuery error", async () => {
  await sql`create table test (name text)`;
  await sql`insert into test values ('1')`;
  await selectName();
  await sql`alter table test alter column name type int using name::integer`;
  const [{ name }] = await selectName();
  return [1, name, await sql`drop table test`];
});

const updateJsonConfig = () =>
  // oxlint-disable-next-line sort-keys -- the JSON text sent keeps the key order it had
  sql`update test set config = ${sql.json({ warmup: 2_100_000_000, ticksLimit: 5000 })} returning *`;

t(
  "Does not re-serialize json parameters when retrying on RevalidateCachedQuery error",
  async () => {
    await sql`create table test (id int, config jsonb)`;
    await sql`insert into test values (1, '{}')`;
    await updateJsonConfig();
    await sql`alter table test add column extra int`;
    await updateJsonConfig();
    const [{ type }] = await sql`select jsonb_typeof(config) as type from test`;
    return ["object", type, await sql`drop table test`];
  }
);

const insertJsonConfig = () =>
  sql`insert into test (config) values (${sql.json({ warmup: 2_100_000_000 })})`;

t(
  "Does not re-serialize json parameters when retrying on FetchPreparedStatement error",
  async () => {
    await sql`create table test (config jsonb)`;
    await insertJsonConfig();
    await sql`deallocate all`;
    await insertJsonConfig();
    const types = await sql`select jsonb_typeof(config) as type from test`;
    return [
      "object,object",
      types.map((x) => x.type).join(","),
      await sql`drop table test`,
    ];
  }
);

const updateEnabled = () => sql`update test set enabled = ${true} returning *`;

t(
  "Does not re-serialize boolean parameters when retrying on RevalidateCachedQuery error",
  async () => {
    await sql`create table test (id int, enabled bool)`;
    await sql`insert into test values (1, false)`;
    await updateEnabled();
    await sql`alter table test add column extra int`;
    await updateEnabled();
    const [{ enabled }] = await sql`select enabled from test`;
    return [true, enabled, await sql`drop table test`];
  }
);

const insertEnabled = () => sql`insert into test (enabled) values (${true})`;

t(
  "Does not re-serialize boolean parameters when retrying on FetchPreparedStatement error",
  async () => {
    await sql`create table test (enabled bool)`;
    await insertEnabled();
    await sql`deallocate all`;
    await insertEnabled();
    const rows = await sql`select enabled from test`;
    return [
      "true,true",
      rows.map((x) => x.enabled).join(","),
      await sql`drop table test`,
    ];
  }
);

const updateData = () =>
  sql`update test set data = ${Buffer.from("hello")} returning *`;

t(
  "Does not re-serialize bytea parameters when retrying on RevalidateCachedQuery error",
  async () => {
    await sql`create table test (id int, data bytea)`;
    await sql`insert into test values (1, null)`;
    await updateData();
    await sql`alter table test add column extra int`;
    await updateData();
    const [{ data }] = await sql`select data from test`;
    return ["hello", data.toString(), await sql`drop table test`];
  }
);

const insertData = () =>
  sql`insert into test (data) values (${Buffer.from("hello")})`;

t(
  "Does not re-serialize bytea parameters when retrying on FetchPreparedStatement error",
  async () => {
    await sql`create table test (data bytea)`;
    await insertData();
    await sql`deallocate all`;
    await insertData();
    const rows = await sql`select data from test`;
    return [
      "hello,hello",
      rows.map((x) => x.data.toString()).join(","),
      await sql`drop table test`,
    ];
  }
);

t("Properly throws routine error on not prepared statements", async () => {
  await sql`create table x (x text[])`;
  const { routine } = await sql
    .unsafe(`
    insert into x(x) values (('a', 'b'))
  `)
    .catch((error) => error);

  return ["transformAssignedExpr", routine, await sql`drop table x`];
});

t(
  "Properly throws routine error on not prepared statements using file",
  async () => {
    const { routine } = await sql
      .unsafe(
        `
    create table x (x text[]);
    insert into x(x) values (('a', 'b'));
  `,
        { prepare: true }
      )
      .catch((error) => error);

    return ["transformAssignedExpr", routine];
  }
);

t("Describe", async () => {
  const { types } = await sql`select ${1}::int as x`.describe();
  const [type] = types;
  return [23, type];
});

t("Describe a statement", async () => {
  await sql`create table tester (name text, age int)`;
  const r =
    await sql`select name, age from tester where name like $1 and age > $2`.describe();
  return [
    "25,23/name:25,age:23",
    `${r.types.join(",")}/${r.columns.map((c) => `${c.name}:${c.type}`).join(",")}`,
    await sql`drop table tester`,
  ];
});

t("Describe a statement without parameters", async () => {
  await sql`create table tester (name text, age int)`;
  const r = await sql`select name, age from tester`.describe();
  return [
    "0,2",
    `${r.types.length},${r.columns.length}`,
    await sql`drop table tester`,
  ];
});

t("Describe a statement without columns", async () => {
  await sql`create table tester (name text, age int)`;
  const r =
    await sql`insert into tester (name, age) values ($1, $2)`.describe();
  return [
    "2,0",
    `${r.types.length},${r.columns.length}`,
    await sql`drop table tester`,
  ];
});

t(
  "Fails a stale prepared statement once when a query is piped behind it",
  async () => {
    const db = postgres(options);
    const piped = () => Promise.all([db`select 1 as x`, db`select 2 as x`]);
    await piped();
    await db`deallocate all`;
    const error = await piped().catch((pipedError) => pipedError);
    const results = await piped();
    return [
      "26000,12",
      `${error.code},${results.map(([{ x }]) => x).join("")}`,
      await db.end(),
    ];
  }
);

t("Holds the connection while retrying a prepared statement", async () => {
  let builds = 0;
  let other;
  const db = postgres({
    ...options,
    debug: (_, x) =>
      x === "select * from test where id = $1" &&
      (builds += 1) === 3 &&
      (other = get(2).execute()),
  });
  const read = (id) => db`select * from test where id = ${id}`;
  const get = (id) =>
    db`select id, name, null::int as extra from test where id = ${id}`;
  await db`create table test (id int, name text)`;
  await db`insert into test values (1, 'a'), (2, 'b')`;
  await read(1);
  await get(2);
  await db`alter table test add column extra int`;
  const [x] = await read(1);
  const [y] = await other;
  return [
    "1a2b",
    x.id + x.name + y.id + y.name,
    await db`drop table test`,
    await db.end(),
  ];
});

t("Answers two stale prepared statements piped together", async () => {
  const db = postgres(options);
  const read = (id) => db`select * from test where id = ${id}`;
  await db`create table test (id int, name text)`;
  await db`insert into test values (1, 'a'), (2, 'b')`;
  await read(1);
  await db`alter table test add column extra int`;
  const [error, [x]] = await Promise.all([
    read(1).catch((readError) => readError),
    read(2),
  ]);
  const [y] = await db`select 3 as id, 'c' as name`;
  const [z] = await read(1);
  return [
    "0A000,2b,3c,1a",
    [error.code, x.id + x.name, y.id + y.name, z.id + z.name].join(","),
    await db`drop table test`,
    await db.end(),
  ];
});

t(
  "A stale prepared statement retried with a transaction queued behind it stays outside the transaction",
  async () => {
    const db = postgres(options);
    const insert = (x) => db`insert into test (name) values (${x}) returning *`;
    await db`create table test (id serial primary key, name text)`;
    await insert("a");
    await db`alter table test add column extra int`;
    await Promise.all([
      insert("b"),
      db
        .begin(async (tx) => {
          await tx`select 1`;
          throw new Error("rollback");
        })
        .catch(() => null),
    ]);
    const rows = await db`select name from test order by id`;
    return [
      "a,b",
      rows.map((x) => x.name).join(","),
      await db`drop table test`,
      await db.end(),
    ];
  }
);

t(
  "Does not give a stale prepared statement the answer of a statement piped behind it",
  async () => {
    const db = postgres(options);
    const select = () => db`select * from test order by id`;
    const get = (id) => db`select name from test where id = ${id}`;
    await db`create table test (id int, name text)`;
    await db`insert into test values (1, 'a'), (2, 'b')`;
    await select();
    await db`alter table test add column extra int`;
    const [error, [x]] = await Promise.all([
      select().catch((selectError) => selectError),
      get(2),
    ]);
    const [y] = await get(2);
    return [
      "0A000,b,b",
      [error.code, x.name, y.name].join(","),
      await db`drop table test`,
      await db.end(),
    ];
  }
);

t(
  "Does not reorder writes on a reserved connection when retrying a stale prepared statement",
  async () => {
    const db = postgres(options);
    const reserved = await db.reserve();
    await reserved`create table test (id int primary key, name text)`;
    await reserved`insert into test values (1, 'a')`;
    await reserved`delete from test`;
    await reserved`deallocate all`;
    const [error] = await Promise.all([
      reserved`insert into test values (1, 'a')`.catch(
        (insertError) => insertError
      ),
      reserved`update test set name = 'b' where id = 1`,
    ]);
    reserved.release();
    const rows = await db`select name from test`;
    return [
      "26000,",
      `${error.code},${rows.map((x) => x.name).join(",")}`,
      await db`drop table test`,
      await db.end(),
    ];
  }
);

t("Does not retry a cancelled stale prepared statement", async () => {
  const db = postgres(options);
  await db`select 1 as x`;
  await db`deallocate all`;
  db`select pg_sleep(0.5)`.execute();
  const query = db`select 1 as x`.execute();
  setTimeout(() => query.cancel(), 100);
  const error = await query.catch((queryError) => queryError);
  return ["26000", error.code, await db.end()];
});

t(
  "Stale prepared statements in a transaction returning an array of queries reject and release the connection",
  async () => {
    const other = postgres(options);
    await sql`create table test (id int, a int)`;
    await sql`insert into test values (1, 1)`;
    await other`select * from test where id = ${1}`;
    await other`select id from test where id = ${1} and a > ${0}`;
    await sql`alter table test add column b int`;
    const error = await other
      .begin((tx) => [
        tx`select * from test where id = ${1}`,
        tx`select id from test where id = ${1} and a > ${0}`,
      ])
      .catch((beginError) => beginError.code);
    const [row] = await other`select * from test where id = ${1}`;
    await sql`drop table test`;
    await other.end();
    return ["0A000,true", [error, "b" in row].join(",")];
  }
);

t(
  "Stale prepared statement is not retried after the transaction it was pipelined in ends",
  async () => {
    const other = postgres(options);
    await sql`create table test (id int, a int)`;
    await sql`insert into test values (1, 1)`;
    await other`update test set a = a + ${1} where id = 1 returning *`;
    await sql`alter table test add column b int`;
    const reserved = await other.reserve();
    const results = await Promise.all(
      [
        reserved`begin`,
        reserved`insert into test values (2, 2)`,
        reserved`update test set a = a + ${1} where id = 1 returning *`,
        reserved`commit`,
      ].map((x) =>
        x.then(
          (result) => result.command,
          (error) => error.code
        )
      )
    );
    reserved.release();
    const after = await sql`select id, a from test order by id`;
    const rows = after.map((x) => `${x.id}:${x.a}`);
    await sql`drop table test`;
    await other.end();
    return ["BEGIN,INSERT,0A000,ROLLBACK,1:2", [...results, ...rows].join(",")];
  }
);

t(
  "prepare: false describes every time, so a changed column type is seen at once, as in v3",
  async () => {
    const db = postgres({ ...options, max: 1, prepare: false });
    const insert = (x) =>
      db`insert into test values (${x}) returning x::text as x`;
    await db`create table test (x boolean)`;
    const [a] = await insert(true);
    await db`alter table test alter column x type int using x::int`;
    const [b] = await insert(1);
    await db`alter table test alter column x type json using to_json(x)`;
    const [c] = await insert({ a: 1 });
    return [
      'true 1 {"a":1}',
      [a.x, b.x, c.x].join(" "),
      await db`drop table test`,
      await db.end(),
    ];
  }
);

t(
  "A prepared statement that a changed column type no longer fits is prepared again and the query re-run",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const insert = (x) =>
      db`insert into test values (${x}) returning x::text as x`;
    await db`create table test (x int)`;
    await insert(1);
    await db`alter table test alter column x type uuid using null`;
    const id = "6f1c2c43-6f6b-4a40-9a39-2d8f4a1f3b11";
    const rows = [];
    for (let i = 0; i < 3; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each insert runs after the one before
      const [{ x }] = await insert(id);
      rows.push(x);
    }
    return [
      [id, id, id].join(","),
      rows.join(","),
      await db`drop table test`,
      await db.end(),
    ];
  }
);

t(
  "A value the learned types cannot write is written for a fresh description",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const insert = (x) =>
      db`insert into test values (${x}) returning x::text as x`;
    await db`create table test (x bytea)`;
    await insert(Buffer.from("hi"));
    await db`alter table test alter column x type int using null`;
    const [{ x }] = await insert(7);
    return ["7", x, await db`drop table test`, await db.end()];
  }
);

t(
  "A prepared statement made on a new connection has the types the pool writes values for",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const insert = (x) =>
      db`insert into test values (${x}) returning x::text as x`;
    await db`create table test (x text)`;
    await insert("123");
    await db.close();
    await db`alter table test alter column x type json using null`;
    const [{ x }] = await insert("123");
    return ['"123"', x, await db`drop table test`, await db.end()];
  }
);

t(
  "A query waiting on another query's description of the same statement does not get that query's error",
  async () => {
    const db = postgres({ ...options, max: 4 });
    await Promise.all([1, 2, 3].map(() => db`select pg_sleep(0.02)`));
    const out = [];
    await db
      .begin(async (tx) => {
        await tx`select 1/0`.catch(noop);
        const a = tx`select ${1}::int as shared_describe_shape`.then(
          () => "ok",
          (error) => error.code
        );
        for (let i = 0; i < 5; i += 1) {
          // oxlint-disable-next-line no-await-in-loop -- waits exactly five microtask ticks
          await Promise.resolve();
        }
        const b = db`select ${2}::int as shared_describe_shape`.then(
          (x) => x[0].shared_describe_shape,
          (error) => error.code
        );
        out.push(...(await Promise.all([a, b])));
      })
      .catch(noop);
    return ["25P02,2", out.join(","), await db.end()];
  }
);

t(
  "An invalid value for a prepared statement keeps the statement and leaves nothing behind on the server",
  async () => {
    const db = postgres({ ...options, max: 4 });
    await db`create table test (id uuid)`;
    const q = (id) => db`select * from test where id = ${id}`;
    const zero = "00000000-0000-0000-0000-000000000000";
    const counts = async () => {
      const reserved = await Promise.all([1, 2, 3, 4].map(() => db.reserve()));
      const n = await Promise.all(
        reserved.map((r) =>
          r`select count(*)::int as n from pg_prepared_statements`.then(
            (x) => x[0].n
          )
        )
      );
      for (const r of reserved) {
        r.release();
      }
      return Math.max(...n);
    };
    await Promise.all(Array.from({ length: 40 }, () => q(zero)));
    const before = await counts();
    const codes = new Set();
    for (let i = 0; i < 50; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each round runs after the one before
      await Promise.all([
        q("not-a-uuid").catch((error) => codes.add(error.code)),
        q(zero),
        q(zero),
        q(zero),
      ]);
    }
    const after = await counts();
    return [
      "22P02 true",
      `${[...codes].join(",")} ${after <= before + 1}`,
      await db`drop table test`,
      await db.end(),
    ];
  }
);

const selectIdOne = (conn) => conn`select * from test where id = ${1}`;

t(
  "A connection that prepares a statement for the first time reads the columns it has now, not those another connection learned",
  async () => {
    const db = postgres({ ...options, max: 2 });
    await db`create table test (id int, v int)`;
    await db`insert into test values (1, 10)`;
    const reserved = await db.reserve();
    const before = await selectIdOne(reserved);
    await db`alter table test alter column v type text using '0' || v::text`;
    await db`alter table test add column w text default 'new'`;
    const after = await selectIdOne(db);
    reserved.release();
    return [
      '[{"id":1,"v":10}] [{"id":1,"v":"010","w":"new"}]',
      `${JSON.stringify(before)} ${JSON.stringify(after)}`,
      await db`drop table test`,
      await db.end(),
    ];
  }
);

const insertValue = (conn, id, v) =>
  conn`insert into test values (${id}, ${v})`;

t(
  "A connection that prepares a statement for the first time writes values for the parameter types it has now",
  async () => {
    const db = postgres({ ...options, max: 2 });
    await db`create table test (id int, v boolean)`;
    const reserved = await db.reserve();
    await insertValue(reserved, 1, "false");
    await db`alter table test alter column v type text`;
    await insertValue(db, 2, "yes");
    await insertValue(reserved, 3, "no");
    reserved.release();
    const rows = await db`select v from test order by id`;
    return [
      "false,yes,no",
      rows.map((x) => x.v).join(","),
      await db`drop table test`,
      await db.end(),
    ];
  }
);

t(
  "The same query in schemas of different shape gets the rows of its own schema on every connection",
  async () => {
    const db = postgres({ ...options, max: 2 });
    await db.unsafe(`
    create schema tenant_a; create schema tenant_b;
    create table tenant_a.t (id int, val int); insert into tenant_a.t values (1, 42);
    create table tenant_b.t (id int, label text); insert into tenant_b.t values (1, 'hello')
  `);
    const tenant = (schema, hold) =>
      db.begin(async (tx) => {
        await tx`select set_config('search_path', ${schema}, true)`;
        const [row] = await tx`select * from t where id = ${1}`;
        await delay(hold);
        return JSON.stringify(row);
      });
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(
        // oxlint-disable-next-line no-await-in-loop -- each pair of transactions runs after the one before
        ...(await Promise.all([tenant("tenant_a", 20), tenant("tenant_b", 10)]))
      );
    }
    const counts = {};
    for (const x of results) {
      counts[x] = (counts[x] || 0) + 1;
    }
    return [
      '{"{\\"id\\":1,\\"val\\":42}":5,"{\\"id\\":1,\\"label\\":\\"hello\\"}":5}',
      JSON.stringify(counts),
      await db.unsafe(
        "drop schema tenant_a cascade; drop schema tenant_b cascade"
      ),
      await db.end(),
    ];
  }
);

const outcomeOf = (x) =>
  x.then(
    () => "ok",
    (queryError) => queryError.code
  );

t(
  "A late 26000 does not make the connection forget a statement prepared again behind it",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const query = () => db`select ${1}::int as x`;
    await query();
    const deallocated = db.unsafe("deallocate all").execute();
    let third;
    const first = query().catch((queryError) => {
      third = outcomeOf(query());
      return queryError.code;
    });
    const sleep = db.unsafe("select pg_sleep(0.1)").execute();
    const second = query().execute();
    const before = [
      await outcomeOf(deallocated),
      await first,
      await outcomeOf(sleep),
      await outcomeOf(second),
      await third,
    ];
    const after = [];
    for (let i = 0; i < 3; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each query runs after the one before
      after.push(await outcomeOf(query()));
    }
    return [
      "ok,26000,ok,26000,ok ok,ok,ok",
      `${before.join(",")} ${after.join(",")}`,
      await db.end(),
    ];
  }
);

t("Stale statements pipelined on the pool are all run again", async () => {
  const db = postgres({ ...options, max: 2 });
  await db`create table test (id int, v int)`;
  await db`insert into test values (1, 10)`;
  const query = () => db`select v from test where id = ${1}`;
  await Promise.all([query(), query(), query(), query()]);
  await db`alter table test alter column v type text`;
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      query().then(
        (x) => x[0].v,
        (error) => error.code
      )
    )
  );
  return [
    "10,10,10,10,10,10",
    results.join(","),
    await db`drop table test`,
    await db.end(),
  ];
});

t(
  "A statement name the server already has on a connection is prepared under a new name (#960)",
  { timeout: 5 },
  async () => {
    const db = postgres({ ...options, max: 2, prepare: true });
    const one = await db.reserve();
    const two = await db.reserve();
    const first = await one`select ${1}::int as x`;
    await two.unsafe(
      `prepare "${first.statement.name}" as select $1::int as x`
    );
    const [{ x }] = await two`select ${3}::int as x`;
    const [{ x: y }] = await two`select ${4}::int as x`;
    one.release();
    two.release();
    return ["3 4", `${x} ${y}`, await db.end()];
  }
);

t(
  "Statements past the connection and pool limits are closed and prepared again when used",
  { timeout: 30 },
  async () => {
    const db = postgres({ ...options, max: 1, prepare: true });
    const run = (i) =>
      db.unsafe(`select $1::int + ${i} as x`, [1], { prepare: true });
    for (let i = 0; i < 2100; i += 100) {
      // oxlint-disable-next-line no-await-in-loop -- each hundred statements run after the hundred before
      await Promise.all(Array.from({ length: 100 }, (_, j) => run(i + j)));
    }
    const [{ n }] =
      await db`select count(*)::int as n from pg_prepared_statements`;
    const [{ x }] = await run(0);
    return ["true 1", `${n <= 1001} ${x}`, await db.end()];
  }
);

const counted = async (fn) => {
  let writes = 0;
  const server = net.createServer((client) => {
    const upstream = net.connect(
      options.port || 5432,
      options.host || "localhost"
    );
    client.on("data", (x) => {
      writes += 1;
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
  await db`select 1`;
  try {
    writes = 0;
    const result = await fn(db);
    return [writes, result];
  } finally {
    await db.end();
    server.close();
  }
};

t(
  "A new query with only numbers and nulls as untyped values is sent in one write",
  async () => {
    const [writes, rows] = await counted(
      (db) => db`select ${1}::int + ${2.5}::float8 as x, ${null}::text as y`
    );
    return ["1 3.5 null", `${writes} ${rows[0].x} ${rows[0].y}`];
  }
);

t(
  "A new query with a string value still learns the parameter types before writing values",
  async () => {
    const [writes, rows] = await counted(
      (db) => db`select ${'{"a":1}'}::jsonb as x, ${1}::jsonb as y`
    );
    return ["2 string 1", `${writes} ${typeof rows[0].x} ${rows[0].y}`];
  }
);

t(
  "Numbers sent before the parameter types are known are written as the types would write them",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const [{ a, b, c, d }] =
      await db`select ${1}::jsonb as a, ${0}::bool as b, ${-1.5e-7}::numeric as c, ${7}::int8 as d`;
    return ["1,false,-0.00000015,7", [a, b, c, d].join(","), await db.end()];
  }
);

t(
  "The same new query with a number and then a string on one connection gives each its own value",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const query = (x) => db`select ${x}::jsonb as x`;
    const [[a], [b], [c]] = await Promise.all([
      query(1),
      query("one"),
      query(2),
    ]);
    return [
      '1 "one" 2',
      [a.x, JSON.stringify(b.x), c.x].join(" "),
      await db.end(),
    ];
  }
);

t(
  "The same new query failing to parse with a number and then a string rejects both",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const query = (x) =>
      db`select ${x}::jsonb + nope as x`.catch((parseError) => parseError.code);
    const codes = await Promise.all([query(1), query("one"), query(2)]);
    const [{ x }] = await db`select 1 as x`;
    return ["42703,42703,42703,1", [...codes, x].join(","), await db.end()];
  }
);

t(
  "A cached prepared statement does not keep the rows of the query that prepared it",
  async () => {
    const v8 = await import("node:v8");
    const vm = await import("node:vm");
    let gc;
    try {
      v8.setFlagsFromString("--expose-gc");
      gc = vm.runInNewContext("gc");
    } catch {
      return [true, true];
    }

    const db = postgres({ ...options, max: 1 });
    const refs = [];
    await selectLargeRows(db, refs);

    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each collection runs after a pause
      await delay(10);
      gc();
    }

    const [{ n }] =
      await db`select count(*)::int as n from pg_prepared_statements where statement like 'select repeat%'`;
    return [
      `${true} ${options.prepare === false ? 0 : 1}`,
      `${refs[0].deref() === undefined} ${n}`,
      await db.end(),
    ];
  }
);

const selectLargeRows = async (db, refs) => {
  const rows = await db`select repeat('x', ${1e6}) as x`;
  refs.push(new WeakRef(rows));
};

const selectTen = (conn) =>
  Promise.all(
    Array.from({ length: 10 }, (_, i) => conn`select ${i}::int as x`)
  );

t(
  "The same new query with numbers fired many times at once on one connection is prepared once",
  async () => {
    const [writes, rows] = await counted(async (db) => {
      await selectTen(db);
      return selectTen(db);
    });
    return [
      `${options.prepare === false ? 2 : 3} 9`,
      `${writes} ${rows[9][0].x}`,
    ];
  }
);
