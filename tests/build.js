import { postgres, sql, options, delay, rel } from "./setup.js";
import { t } from "./test.js";

t("Escapes", async () => {
  const [row] = await sql`select 1 as ${sql('hej"hej')}`;
  return ['hej"hej', Object.keys(row)[0]];
});

t("sql file", async () => {
  const [row] = await sql.file(rel("select.sql"));
  return [1, row.x];
});

t("sql file has forEach", async () => {
  let result;
  await sql
    .file(rel("select.sql"), { cache: false })
    .forEach(({ x }) => (result = x));

  return [1, result];
});

t("sql file cached", async () => {
  await sql.file(rel("select.sql"));
  await delay(20);

  const [row] = await sql.file(rel("select.sql"));
  return [1, row.x];
});

t("Parameters in file", async () => {
  const result = await sql.file(rel("select-param.sql"), ["hello"]);
  return ["hello", result[0].x];
});

t("unsafe", async () => {
  await sql`create table test (x int)`;
  const [row] = await sql.unsafe(
    "insert into test values ($1) returning *",
    [1]
  );
  return [1, row.x, await sql`drop table test`];
});

t("unsafe simple", async () => {
  const [row] = await sql.unsafe("select 1 as x");
  return [1, row.x];
});

t("unsafe simple includes columns", async () => {
  const { columns } = await sql.unsafe("select 1 as x").values();
  return ["x", columns[0].name];
});

t("simple query using unsafe with multiple statements", async () => {
  const results = await sql.unsafe("select 1 as x;select 2 as x");
  return ["1,2", results.map((x) => x[0].x).join(",")];
});

t("simple query using simple() with multiple statements", async () => {
  const results = await sql`select 1 as x;select 2 as x`.simple();
  return ["1,2", results.map((x) => x[0].x).join(",")];
});

t("big query body", async () => {
  await sql`create table test (x int)`;
  const { count } = await sql`insert into test ${sql(
    Array.from({ length: 50_000 }, (_, x) => ({ x }))
  )}`;
  return [50_000, count, await sql`drop table test`];
});

t("let postgres do implicit cast of unknown types", async () => {
  await sql`create table test (x timestamp with time zone)`;
  const [{ x }] =
    await sql`insert into test values (${new Date().toISOString()}) returning *`;
  return [true, x instanceof Date, await sql`drop table test`];
});

t("only allows one statement", async () => [
  "42601",
  await sql`select 1; select 2`.catch((error) => error.code),
]);

t("dynamic table name", async () => {
  await sql`create table test(a int)`;
  const { count } = await sql`select * from ${sql("test")}`;
  return [0, count, await sql`drop table test`];
});

t("dynamic schema name", async () => {
  await sql`create table test(a int)`;
  const { count } = await sql`select * from ${sql("public")}.test`;
  return [0, count, await sql`drop table test`];
});

t("dynamic schema and table name", async () => {
  await sql`create table test(a int)`;
  const { count } = await sql`select * from ${sql("public.test")}`;
  return [0, count, await sql`drop table test`];
});

t("dynamic column name", async () => {
  const [row] = await sql`select 1 as ${sql("!not_valid")}`;
  return ["!not_valid", Object.keys(row)[0]];
});

t("dynamic select as", async () => {
  const [row] = await sql`select ${sql({ a: 1, b: 2 })}`;
  return ["2", row.b];
});

t("dynamic select as pluck", async () => {
  const [row] = await sql`select ${sql({ a: 1, b: 2 }, "a")}`;
  return [undefined, row.b];
});

t("dynamic insert", async () => {
  await sql`create table test (a int, b text)`;
  const x = { a: 42, b: "the answer" };

  const [row] = await sql`insert into test ${sql(x)} returning *`;
  return ["the answer", row.b, await sql`drop table test`];
});

t("dynamic insert pluck", async () => {
  await sql`create table test (a int, b text)`;
  const x = { a: 42, b: "the answer" };

  const [row] = await sql`insert into test ${sql(x, "a")} returning *`;
  return [null, row.b, await sql`drop table test`];
});

t("dynamic in with empty array", async () => {
  await sql`create table test (a int)`;
  await sql`insert into test values (1)`;
  const { count } = await sql`select * from test where null in ${sql([])}`;
  return [count, 0, await sql`drop table test`];
});

t("dynamic in after insert", async () => {
  await sql`create table test (a int, b text)`;
  const [{ x }] = await sql`
    with x as (
      insert into test values (1, 'hej')
      returning *
    )
    select 1 in ${sql([1, 2, 3])} as x from x
  `;
  return [true, x, await sql`drop table test`];
});

t("array insert", async () => {
  await sql`create table test (a int, b int)`;
  const [row] =
    await sql`insert into test (a, b) values ${sql([1, 2])} returning *`;
  return [2, row.b, await sql`drop table test`];
});

t("where parameters in()", async () => {
  await sql`create table test (x text)`;
  await sql`insert into test values ('a')`;
  const [row] =
    await sql`select * from test where x in ${sql(["a", "b", "c"])}`;
  return [row.x, "a", await sql`drop table test`];
});

t("where parameters in() values before", async () => {
  const { count } = await sql`
    with rows as (
      select * from (values (1), (2), (3), (4)) as x(a)
    )
    select * from rows where a in ${sql([3, 4])}
  `;
  return [2, count];
});

t("dynamic multi row insert", async () => {
  await sql`create table test (a int, b text)`;
  const x = { a: 42, b: "the answer" };

  const [, row] = await sql`insert into test ${sql([x, x])} returning *`;
  return ["the answer", row.b, await sql`drop table test`];
});

t("dynamic update", async () => {
  await sql`create table test (a int, b text)`;
  await sql`insert into test (a, b) values (17, 'wrong')`;

  const [row] =
    await sql`update test set ${sql({ a: 42, b: "the answer" })} returning *`;
  return ["the answer", row.b, await sql`drop table test`];
});

t("dynamic update pluck", async () => {
  await sql`create table test (a int, b text)`;
  await sql`insert into test (a, b) values (17, 'wrong')`;

  const [row] =
    await sql`update test set ${sql({ a: 42, b: "the answer" }, "a")} returning *`;
  return ["wrong", row.b, await sql`drop table test`];
});

t("dynamic select array", async () => {
  await sql`create table test (a int, b text)`;
  await sql`insert into test (a, b) values (42, 'yay')`;
  const [row] = await sql`select ${sql(["a", "b"])} from test`;
  return ["yay", row.b, await sql`drop table test`];
});

t("dynamic returning array", async () => {
  await sql`create table test (a int, b text)`;
  const [row] =
    await sql`insert into test (a, b) values (42, 'yay') returning ${sql(["a", "b"])}`;
  return ["yay", row.b, await sql`drop table test`];
});

t("dynamic select args", async () => {
  await sql`create table test (a int, b text)`;
  await sql`insert into test (a, b) values (42, 'yay')`;
  const [row] = await sql`select ${sql("a", "b")} from test`;
  return ["yay", row.b, await sql`drop table test`];
});

t("dynamic values single row", async () => {
  const [{ b }] = await sql`
    select * from (values ${sql(["a", "b", "c"])}) as x(a, b, c)
  `;

  return ["b", b];
});

t("dynamic values multi row", async () => {
  const [, { b }] = await sql`
    select * from (values ${sql([
      ["a", "b", "c"],
      ["a", "b", "c"],
    ])}) as x(a, b, c)
  `;

  return ["b", b];
});

t("Multiple queries", async () => {
  const db = postgres(options);

  const { length } = await Promise.all([
    db`select 1`,
    db`select 2`,
    db`select 3`,
    db`select 4`,
  ]);
  return [4, length];
});

t("Multiple statements", async () => [
  2,
  await sql
    .unsafe(`
    select 1 as x;
    select 2 as a;
  `)
    .then(([, [x]]) => x.a),
]);

t("Insert empty array", async () => {
  await sql`create table tester (ints int[])`;
  const [row] = await sql`insert into tester (ints) values (${[]}) returning *`;
  return [Array.isArray(row.ints), true, await sql`drop table tester`];
});

t("Insert array in sql()", async () => {
  await sql`create table tester (ints int[])`;
  const [row] = await sql`insert into tester ${sql({ ints: [] })} returning *`;
  return [Array.isArray(row.ints), true, await sql`drop table tester`];
});

t("Escaping supports schemas and tables", async () => {
  await sql`create schema a`;
  await sql`create table a.b (c int)`;
  await sql`insert into a.b (c) values (1)`;
  const [row] = await sql`select ${sql("a.b.c")} from a.b`;
  return [1, row.c, await sql`drop table a.b`, await sql`drop schema a`];
});

t("Raw method returns values unparsed as Buffer", async () => {
  const [[x]] = await sql`select 1`.raw();
  return [x instanceof Uint8Array, true];
});

t("Fragments", async () => {
  const [row] = await sql`
    ${sql`select`} 1 as x
  `;
  return [1, row.x];
});

t("Supports fragments as dynamic parameters", async () => {
  await sql`create table test (a int, b bool)`;
  await sql`insert into test values(1, true)`;
  await sql`insert into test ${sql({
    a: 2,
    b: sql`exists(select 1 from test where b = ${true})`,
  })}`;

  const rows = await sql`select * from test`.raw();
  return ["1,t2,t", rows.join(""), await sql`drop table test`];
});

t("Supports nested fragments with parameters", async () => {
  await sql`create table test ${sql`(${sql("a")} ${sql`int`})`}`;
  await sql`insert into test values(1)`;
  const [row] = await sql`select a from test`;
  return [1, row.a, await sql`drop table test`];
});

t("Supports multiple nested fragments with parameters", async () => {
  const [{ b }] =
    await sql`select * ${sql`from ${sql`(values (2, ${1}::int)) as x(${sql(["a", "b"])})`}`}`;
  return [1, b];
});

t("Supports arrays of fragments", async () => {
  const [{ x }] = await sql`
    ${[sql`select`, sql`1`, sql`as`, sql`x`]}
  `;

  return [1, x];
});

t("Last keyword used even with duplicate keywords", async () => {
  await sql`create table test (x int)`;
  await sql`insert into test values(1)`;
  const [{ x }] = await sql`
    select
      1 in (1) as x
    from test
    where x in ${sql([1, 2])}
  `;

  return [x, true, await sql`drop table test`];
});

t("Insert array with null", async () => {
  await sql`create table test (x int[])`;
  await sql`insert into test ${sql({ x: [1, null, 3] })}`;
  const [row] = await sql`select x from test`;
  return [1, row.x[0], await sql`drop table test`];
});

t("Named arguments in a function call (#1040)", async () => {
  const [{ x }] =
    await sql`select make_interval(${sql({ days: 1, hours: 2 })})::text as x`;
  return ["1 day 02:00:00", x];
});
