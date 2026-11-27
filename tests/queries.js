import crypto from "node:crypto";
import fs from "node:fs";

import { postgres, sql, options, rel } from "./setup.js";
import { t } from "./test.js";

t("Result is array", async () => [true, Array.isArray(await sql`select 1`)]);

t("Result has count", async () => {
  const { count } = await sql`select 1`;
  return [1, count];
});

t("Result has command", async () => {
  const { command } = await sql`select 1`;
  return ["SELECT", command];
});

t("Create table", async () => {
  const { command } = await sql`create table test(int int)`;
  return ["CREATE TABLE", command, await sql`drop table test`];
});

t("Drop table", async () => {
  await sql`create table test(int int)`;
  const { command } = await sql`drop table test`;
  return ["DROP TABLE", command];
});

t("Big result", async () => {
  const { count } = await sql`select * from generate_series(1, 100000)`;
  return [100_000, count];
});

t("Result has columns spec", async () => {
  const { columns } = await sql`select 1 as x`;
  return ["x", columns[0].name];
});

t("Result as arrays", async () => {
  const db = postgres({
    ...options,
    transform: {
      row: (x) => Object.values(x),
    },
  });

  const [row] = await db`select 1 as a, 2 as b`;
  return ["1,2", row.join(",")];
});

t("Raw method returns rows as arrays", async () => {
  const [x] = await sql`select 1`.raw();
  return [Array.isArray(x), true];
});

t("Array returns rows as arrays of columns", async () => {
  const [[value]] = await sql`select 1`.values();
  return [value, 1];
});

t("Execute", async () => {
  const debugged = Promise.withResolvers();
  const db = postgres({
    ...options,
    debug: (id, query) => debugged.resolve(query),
    fetch_types: false,
  });
  db`select 1`.execute();
  const result = await debugged.promise;

  return [result, "select 1"];
});

t("Cancel running query", async () => {
  const query = sql`select pg_sleep(2)`;
  setTimeout(() => query.cancel(), 500);
  const error = await query.catch((queryError) => queryError);
  return ["57014", error.code];
});

t("Cancel piped query", { timeout: 5 }, async () => {
  await sql`select 1`;
  const last = sql`select pg_sleep(1)`.execute();
  const query = sql`select pg_sleep(2) as dig`;
  setTimeout(() => query.cancel(), 500);
  const error = await query.catch((queryError) => queryError);
  await last;
  return ["57014", error.code];
});

t("Cancel queued query", async () => {
  const query = sql`select pg_sleep(2) as nej`;
  const tx = sql.begin((transaction) => {
    query.cancel();
    return transaction`select pg_sleep(0.5) as hej, 'hejsa'`;
  });
  const error = await query.catch((queryError) => queryError);
  await tx;
  return ["57014", error.code];
});

t("Result becomes array", async () => {
  const result = await sql`select 1`;
  // oxlint-disable-next-line unicorn/prefer-spread -- the test is about what slice returns
  return [true, Array.isArray(result.slice())];
});

t("Include table oid and column number in column details", async () => {
  await sql`create table tester (name text, age int)`;
  const r =
    await sql`select name, age from tester where name like $1 and age > $2`.describe();
  const [{ oid }] =
    await sql`select oid from pg_class where relname = 'tester'`;

  return [
    `table:${oid},number:1|table:${oid},number:2`,
    `${r.columns.map((c) => `table:${c.table},number:${c.number}`).join("|")}`,
    await sql`drop table tester`,
  ];
});

t("Large object", async () => {
  const file = rel("index.js");
  const md5 = crypto
    .createHash("md5")
    .update(fs.readFileSync(file))
    .digest("hex");

  const lo = await sql.largeObject();
  const written = Promise.withResolvers();
  const source = fs.createReadStream(file);
  source.pipe(await lo.writable()).on("finish", written.resolve);
  await written.promise;
  await lo.seek(0);

  const out = crypto.createHash("md5");
  const ended = Promise.withResolvers();
  const readable = await lo.readable();
  readable.on("data", (x) => out.update(x)).on("end", ended.resolve);
  await ended.promise;

  return [md5, out.digest("hex"), await lo.close()];
});

t(
  "Large object tell, size, truncate, and ranges for readable and writable",
  async () => {
    const lo = await sql.largeObject();
    const read = async (o) => {
      let s = "";
      for await (const x of await lo.readable(o)) {
        s += x;
      }
      return s;
    };
    await lo.write(Buffer.from("0123456789"));
    const [tell] = await lo.tell();
    const [size] = await lo.size();
    await lo.seek(0);
    const range = await read({ end: 6, start: 2 });
    const rest = await read({ highWaterMark: 4 });
    const writable = await lo.writable({ start: 3 });
    const ended = Promise.withResolvers();
    writable.end("abc", ended.resolve);
    await ended.promise;
    await lo.seek(0);
    const all = await read();
    await lo.truncate(4);
    const [truncated] = await lo.size();
    return [
      "10 10 10 2345 6789 012abc6789 4",
      [
        tell.lo_tell64,
        size.position,
        size.size,
        range,
        rest,
        all,
        truncated.size,
      ].join(" "),
      await lo.close(),
    ];
  }
);

t("Multiple statements give one result each", async () => {
  await sql`create table test (x int)`;
  const xs = await sql.unsafe(
    "update test set x = 1; delete from test; select 1 as a"
  );
  return [
    "3:UPDATE,DELETE,SELECT",
    `${xs.length}:${xs.map((x) => x.command).join(",")}`,
    await sql`drop table test`,
  ];
});

t("Error mid-result does not offset rows of next query", async () => {
  const db = postgres({ ...options, max: 1 });
  await db`select 1 / (g - 3) from generate_series(1, 5) g`.catch(
    (error) => error
  );
  const result = await db`select 1 as x`;
  await db.end();
  return [1, result.length];
});

t("Result is not sparse after a query errors mid row-stream", async () => {
  const db = postgres({ ...options, max: 1 });
  await db`select n, 1 / (3 - n) as boom from generate_series(1, 5) n`.catch(
    () => {
      // The error is expected, the next query is what is tested.
    }
  );
  const result = await db`select x from generate_series(1, 3) x`;
  await db.end();
  return ["3:1,2,3", `${result.length}:${result.map((r) => r.x).join(",")}`];
});

t("Undefined value in a pipelined query rejects only that query", async () => {
  const db = postgres(options);
  await db`select 1`;
  const results = await Promise.all(
    [
      db`select pg_sleep(0.1), 1 as x`,
      db`select ${undefined} as x`,
      db`select 3 as x`,
    ].map((x) =>
      x.then(
        ([row]) => row.x,
        (error) => error.code
      )
    )
  );
  const [{ x: after }] = await db`select 4 as x`;
  await db.end();
  return ["1,UNDEFINED_VALUE,3,4", [...results, after].join(",")];
});

t("Undefined value in a pipelined cursor rejects only that query", async () => {
  const db = postgres(options);
  await db`select 1`;
  const results = await Promise.all(
    [
      db`select pg_sleep(0.1), 1 as x`,
      db`select ${undefined} as x`.cursor(() => {
        // The query rejects before a row arrives.
      }),
      db`select 3 as x`,
    ].map((x) =>
      x.then(
        (result) => (result.length ? result[0].x : result.command),
        (error) => error.code
      )
    )
  );
  const [{ x: after }] = await db`select 4 as x`;
  await db.end();
  return ["1,UNDEFINED_VALUE,3,4", [...results, after].join(",")];
});

t(
  "Too many parameters in a pipelined query rejects only that query",
  async () => {
    const db = postgres(options);
    await db`select 1`;
    const results = await Promise.all(
      [
        db`select pg_sleep(0.1), 1 as x`,
        db.unsafe(
          "select 2 as x",
          Array.from({ length: 65_535 }, (_, i) => i)
        ),
        db`select 3 as x`,
        db`select 4 as x`,
      ].map((x) =>
        x.then(
          ([row]) => row.x,
          (error) => error.code
        )
      )
    );
    const [{ x: after }] = await db`select 5 as x`;
    await db.end();
    return ["1,MAX_PARAMETERS_EXCEEDED,3,4,5", [...results, after].join(",")];
  }
);

t(
  "Parameter failing to serialize in a pipelined cursor rejects only that query",
  async () => {
    const db = postgres(options);
    await db`select 1`;
    const results = await Promise.all(
      [
        db`select pg_sleep(0.1), 1 as x`,
        db`select ${new Date(Number.NaN)}::timestamptz as x`.cursor(() => {
          // The query rejects before a row arrives.
        }),
        db`select 3 as x`,
      ].map((x) =>
        x.then(
          (result) => (result.length ? result[0].x : result.command),
          (error) => error.name
        )
      )
    );
    const [{ x: after }] = await db`select 4 as x`;
    await db.end();
    return ["1,RangeError,3,4", [...results, after].join(",")];
  }
);

t("Cancel piped query with a query piped behind it", async () => {
  await sql`select 1`;
  const last = sql`select pg_sleep(0.5)`.execute();
  const query = sql`select pg_sleep(2) as dig`;
  setTimeout(() => query.cancel(), 100);
  const [error, [{ x }]] = await Promise.all([
    query.catch((queryError) => queryError),
    sql`select 1 as x`,
  ]);
  await last;
  return ["57014,1", `${error.code},${x}`];
});

t("Cancel returns a promise", async () => {
  const query = sql`select pg_sleep(1)`.execute();
  const cancelled = query.cancel();
  const error = await query.catch((queryError) => queryError);
  return ["true,57014", `${cancelled instanceof Promise},${error.code}`];
});

t(
  "result.statement and query.statement have the documented name, string, types and columns",
  async () => {
    const q = sql`select ${1}::int as a`;
    const r = await q;
    const s = await sql.unsafe("select 1 as b");
    return [
      "select $1::int as a|23|a|true||select 1 as b|b",
      [
        r.statement.string,
        r.statement.types.join(","),
        r.statement.columns.map((x) => x.name).join(","),
        q.statement.string === r.statement.string,
        s.statement.name,
        s.statement.string,
        s.statement.columns.map((x) => x.name).join(","),
      ].join("|"),
    ];
  }
);

t(
  "debug gets the values as sent and the parameter types, also on first use",
  async () => {
    const calls = [];
    const db = postgres({
      ...options,
      debug: (id, query, values, types) =>
        calls.push(JSON.stringify([values, types])),
      max: 1,
    });
    await db`select ${1}::int as x`;
    await db`select ${1}::int as x`;
    return [
      '[["1"],[23]] [["1"],[23]]',
      calls.slice(-2).join(" "),
      await db.end(),
    ];
  }
);

t("Inspecting a query with debug shows why it can not be built", async () => {
  const { inspect } = await import("node:util");
  const db = postgres({ ...options, debug: true });
  return [
    "Query { UNDEFINED_VALUE: Undefined values are not allowed }",
    inspect(db`select ${undefined}`),
    await db.end(),
  ];
});

t(".stream() says it is now .forEach()", () => [
  ".stream has been renamed to .forEach",
  (() => {
    try {
      sql`select 1`.stream();
    } catch (error) {
      return error.message;
    }
  })(),
]);

t(".finally() runs the query", async () => {
  let ran = false;
  const [x] = await sql`select 1 as x`.finally(() => (ran = true));
  return ["1 true", `${x.x} ${ran}`];
});

t(
  "A deferred constraint failing at the end of an implicit transaction rejects the query (#1117, #1090)",
  async () => {
    await sql`create table test (x int constraint test_unique unique deferrable initially deferred)`;
    await sql`insert into test values (1)`;
    const codes = [
      await sql`insert into test ${sql({ x: 1 })}`.then(
        () => "ran",
        (error) => error.code
      ),
      await sql.unsafe("insert into test values (1)").then(
        () => "ran",
        (error) => error.code
      ),
      await sql`select count(*)::int as n from test`.then(([x]) => x.n),
    ];
    return ["23505 23505 1", codes.join(" "), await sql`drop table test`];
  }
);
