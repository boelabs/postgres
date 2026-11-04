import { postgres, sql, options, delay } from "./setup.js";
import { t } from "./test.js";

t("null", async () => {
  const [{ x }] = await sql`select ${null} as x`;
  return [null, x];
});

t("Integer", async () => {
  const [{ x }] = await sql`select ${1} as x`;
  return ["1", x];
});

t("String", async () => {
  const [{ x }] = await sql`select ${"hello"} as x`;
  return ["hello", x];
});

t("Boolean false", async () => {
  const [{ x }] = await sql`select ${false}::bool as x`;
  return [false, x];
});

t("Boolean true", async () => {
  const [{ x }] = await sql`select ${true}::bool as x`;
  return [true, x];
});

t("Date", async () => {
  const now = new Date();
  const [{ x }] = await sql`select ${now}::timestamptz as x`;
  return [0, now - x];
});

t(
  "infer: true types booleans, dates and arrays of them without a cast, as v3 did",
  async () => {
    const db = postgres({ ...options, infer: true });
    const now = new Date();
    const [x] =
      await db`select ${true} as a, ${false} as b, ${now} as c, ${[now, now]} as d, ${[true, false]} as e`;
    return [
      "true false 0 0 true,false",
      [x.a, x.b, now - x.c, now - x.d[1], x.e.join(",")].join(" "),
      await db.end(),
    ];
  }
);

t(
  "infer: false leaves untyped parameters to the server, so they come back as text without a cast",
  async () => {
    const db = postgres({ ...options, infer: false });
    const [x] = await db`select ${true} as a, ${new Date(0)} as b`;
    return ["string string", `${typeof x.a} ${typeof x.b}`, await db.end()];
  }
);

t("Json", async () => {
  const [{ x }] = await sql`select ${sql.json({ a: "hello", b: 42 })} as x`;
  return ["hello,42", [x.a, x.b].join(",")];
});

t("implicit json", async () => {
  const [{ x }] = await sql`select ${{ a: "hello", b: 42 }}::json as x`;
  return ["hello,42", [x.a, x.b].join(",")];
});

t("implicit jsonb", async () => {
  const [{ x }] = await sql`select ${{ a: "hello", b: 42 }}::jsonb as x`;
  return ["hello,42", [x.a, x.b].join(",")];
});

t("Empty array", async () => {
  const [{ x }] = await sql`select ${[]}::text[] as x`;
  return [true, Array.isArray(x)];
});

t("String array", async () => {
  const [{ x }] = await sql`select ${"{1,2,3}"}::int[] as x`;
  return ["123", x.join("")];
});

t("Array of Integer", async () => {
  const [{ x }] = await sql`select ${[1, 2, 3]}::int[] as x`;
  return [3, x[2]];
});

t("Array of String", async () => {
  const [{ x }] = await sql`select ${["a", "b", "c"]}::text[] as x`;
  return ["c", x[2]];
});

t("Array of Date", async () => {
  const now = new Date();
  const time = now.getTime();
  const [{ x }] = await sql`select ${[now, now, now]}::timestamptz[] as x`;
  return [time, x[2].getTime()];
});

t("Array of Box", async () => {
  const [{ x }] = await sql`select ${"{(1,2),(3,4);(4,5),(6,7)}"}::box[] as x`;
  return ["(3,4),(1,2);(6,7),(4,5)", x.join(";")];
});

t("Nested array n2", async () => {
  const [{ x }] = await sql`select ${[
    [1, 2],
    [3, 4],
  ]}::int[] as x`;
  return [4, x[1][1]];
});

t("Nested array n3", async () => {
  const [{ x }] =
    await sql`select ${[[[1, 2]], [[3, 4]], [[5, 6]]]}::int[] as x`;
  return [6, x[2][0][1]];
});

t("Escape in arrays", async () => {
  const [{ x }] =
    await sql`select ${['Hello "you"', "c:\\windows"]}::text[] as x`;
  return ['Hello "you",c:\\windows', x.join(",")];
});

t("null for int", async () => {
  await sql`create table test (x int)`;
  const { count } = await sql`insert into test values(${null})`;
  return [1, count, await sql`drop table test`];
});

t("Null sets to null", async () => {
  const [{ x }] = await sql`select ${null} as x`;
  return [null, x];
});

t("Point type", async () => {
  const db = postgres({
    ...options,
    types: {
      point: {
        from: [600],
        parse: (x) =>
          x
            .slice(1, -1)
            .split(",")
            .map((part) => +part),
        serialize: ([x, y]) => `(${x},${y})`,
        to: 600,
      },
    },
  });

  await db`create table test (x point)`;
  await db`insert into test (x) values (${db.types.point([10, 20])})`;
  const [row] = await db`select x from test`;
  return [20, row.x[1], await db`drop table test`];
});

t("Point type array", async () => {
  const db = postgres({
    ...options,
    types: {
      point: {
        from: [600],
        parse: (x) =>
          x
            .slice(1, -1)
            .split(",")
            .map((part) => +part),
        serialize: ([x, y]) => `(${x},${y})`,
        to: 600,
      },
    },
  });

  await db`create table test (x point[])`;
  await db`insert into test (x) values (${[db.types.point([10, 20]), db.types.point([20, 30])]})`;
  const [row] = await db`select x from test`;
  return [30, row.x[1][1], await db`drop table test`];
});

t("bytea serializes and parses", async () => {
  const buf = Buffer.from("wat");

  await sql`create table test (x bytea)`;
  await sql`insert into test values (${buf})`;

  const expected = buf.toString();
  const [{ x }] = await sql`select x from test`;
  return [expected, x.toString(), await sql`drop table test`];
});

t("bigint is returned as String", async () => {
  const [{ x }] = await sql`select 9223372036854777 as x`;
  return ["string", typeof x];
});

t("int is returned as Number", async () => {
  const [{ x }] = await sql`select 123 as x`;
  return ["number", typeof x];
});

t("numeric is returned as string", async () => {
  const [{ x }] = await sql`select 1.2 as x`;
  return ["string", typeof x];
});

const show = (x) => {
  if (Array.isArray(x)) {
    return `[${x.map(show)}]`;
  }
  if (x === null) {
    return "null";
  }
  if (x instanceof Date) {
    return `date:${x.getTime()}`;
  }
  return `${typeof x}:${x}`;
};

t("Null in text array", async () => {
  const [{ x }] = await sql`select array['a', null, 'b']::text[] as x`;
  return ["[string:a,null,string:b]", show(x)];
});

t("Null in arrays of other types", async () => {
  const [x] = await sql`
    select
      array[1, null]::int2[] as int2,
      array[null, 2]::int4[] as int4,
      array[1, null]::bigint[] as bigint,
      array[1.5, null]::numeric[] as numeric,
      array[true, null, false]::bool[] as bool,
      array['1970-01-01 00:00:00+00'::timestamptz, null] as timestamptz
  `;

  return [
    "[number:1,null],[null,number:2],[string:1,null],[string:1.5,null],[boolean:true,null,boolean:false],[date:0,null]",
    [x.int2, x.int4, x.bigint, x.numeric, x.bool, x.timestamptz]
      .map(show)
      .join(","),
  ];
});

t("Null in json array", async () => {
  const [{ x }] = await sql`select array['{"a":1}'::json, null] as x`;
  return ["[object:[object Object],null]", show(x)];
});

t("Null in array_agg", async () => {
  const [{ x }] =
    await sql`select array_agg(y) as x from (values ('a'), (null), ('b')) as v(y)`;
  return ["[string:a,null,string:b]", show(x)];
});

t("Null in nested arrays", async () => {
  const [x] = await sql`
    select
      array[[1, null], [null, 4]]::int[] as ints,
      array[[['a', null]], [[null, 'd e']]]::text[] as strings
  `;

  return [
    "[[number:1,null],[null,number:4]],[[[string:a,null]],[[null,string:d e]]]",
    [x.ints, x.strings].map(show).join(","),
  ];
});

t("Null in array of only nulls", async () => {
  const [{ x }] = await sql`select array[null, null]::text[] as x`;
  return ["[null,null]", show(x)];
});

t("String NULL in array is not null", async () => {
  const [{ x }] =
    await sql`select array['NULL', null, 'null', 'Null']::text[] as x`;
  return ["[string:NULL,null,string:null,string:Null]", show(x)];
});

t("String NULL in nested array is not null", async () => {
  const [{ x }] =
    await sql`select array[['NULL', null], [null, 'NULL']]::text[] as x`;
  return ["[[string:NULL,null],[null,string:NULL]]", show(x)];
});

t("String NULL in array round trips", async () => {
  const [{ x }] = await sql`select ${["NULL", null, "a"]}::text[] as x`;
  return ["[string:NULL,null,string:a]", show(x)];
});

t("Null in array does not reach custom type parser", async () => {
  const parsed = [];
  const db = postgres({
    ...options,
    types: {
      text: {
        from: [25],
        parse: (x) => {
          parsed.push(x);
          return x.toUpperCase();
        },
        serialize: (x) => x,
        to: 25,
      },
    },
  });

  const [{ x }] = await db`select array['a', null, 'NULL']::text[] as x`;
  await db.end();
  return [
    "[string:A,null,string:NULL]/a,NULL",
    `${show(x)}/${parsed.join(",")}`,
  ];
});

t("Infinity timestamp parses to Infinity", async () => {
  const [{ x }] = await sql`select 'infinity'::timestamptz as x`;
  return [Infinity, x];
});

t("-Infinity timestamp parses to -Infinity", async () => {
  const [{ x }] = await sql`select '-infinity'::timestamptz as x`;
  return [-Infinity, x];
});

t("Infinity timestamp round-trips", async () => {
  const [{ x }] = await sql`select ${sql.typed(Infinity, 1184)} as x`;
  return [Infinity, x];
});

t("-Infinity timestamp round-trips", async () => {
  const [{ x }] = await sql`select ${sql.typed(-Infinity, 1184)} as x`;
  return [-Infinity, x];
});

t("Date before year 100", async () => {
  const db = postgres({ ...options, connection: { TimeZone: "UTC" } });
  const [{ x }] = await db`select '0050-06-15 12:30:00+00'::timestamptz as x`;
  return ["0050-06-15T12:30:00.000Z", x.toISOString(), await db.end()];
});

t("Date with an offset in seconds", async () => {
  const db = postgres({
    ...options,
    connection: { TimeZone: "Europe/Copenhagen" },
  });
  const [{ x, y }] = await db`
    select '1850-06-15 12:30:00+00'::timestamptz as x, '0050-06-15 12:30:00+00'::timestamptz as y
  `;
  return [
    "1850-06-15T12:30:00.000Z,0050-06-15T12:30:00.000Z",
    `${x.toISOString()},${y.toISOString()}`,
    await db.end(),
  ];
});

t(
  "Domain type wrapping an array resolves to the base type serializer, for a domain made before the pool starts",
  async () => {
    await sql`drop domain if exists pg_test_domain_array cascade`;
    await sql`create domain pg_test_domain_array as text[]`;
    await sql`create table test (x pg_test_domain_array)`;
    const fresh = postgres(options);
    const [{ x }] =
      await fresh`insert into test values (${["a", "b"]}) returning x`;
    return [
      "a,b",
      x.join(","),
      await fresh.end(),
      await sql`drop table test`,
      await sql`drop domain pg_test_domain_array`,
    ];
  }
);

t(
  "Nested domain types resolve through to their base type serializer, for a domain made before the pool starts",
  async () => {
    await sql`drop domain if exists pg_test_domain_nested_child cascade`;
    await sql`drop domain if exists pg_test_domain_nested_parent cascade`;
    await sql`create domain pg_test_domain_nested_parent as text[]`;
    await sql`create domain pg_test_domain_nested_child as pg_test_domain_nested_parent`;
    await sql`create table test (x pg_test_domain_nested_child)`;
    const fresh = postgres(options);
    const [{ x }] =
      await fresh`insert into test values (${["a", "b"]}) returning x`;
    return [
      "a,b",
      x.join(","),
      await fresh.end(),
      await sql`drop table test`,
      await sql`drop domain pg_test_domain_nested_child`,
      await sql`drop domain pg_test_domain_nested_parent`,
    ];
  }
);

t("Built-in array types without fetch_types", async () => {
  const db = postgres({ ...options, fetch_types: false });
  const [{ x, y }] =
    await db`select array['a', 'b']::text[] as x, array[1, 2]::int4[] as y`;
  const [{ z }] = await db`select ${["c", "d"]}::text[] as z`;
  return ["b,2,d", [x[1], y[1], z[1]].join(","), await db.end()];
});

t("Object with a type key in a jsonb array", async () => {
  await sql`create table test (nodes jsonb[])`;
  await sql`insert into test ${sql({ nodes: [{ type: "a", v: 1 }] })}`;
  const [{ nodes }] = await sql`select nodes from test`;
  return ["a,1", `${nodes[0].type},${nodes[0].v}`, await sql`drop table test`];
});

t("infer: false sends a boolean to a jsonb parameter", async () => {
  const db = postgres({ ...options, infer: false });
  const [{ x }] = await db`select ${true}::jsonb as x`;
  return [true, x, await db.end()];
});

t("infer: false sends a boolean array", async () => {
  const db = postgres({ ...options, infer: false });
  const [{ x }] = await db`select ${[true, false]}::bool[] as x`;
  return ["true,false", x.join(","), await db.end()];
});

t(
  "infer: false sends strings to boolean, bytea and date parameters as text",
  async () => {
    const db = postgres({ ...options, infer: false, max: 1 });
    await db`create temp table shapes (a boolean, b bytea, c timestamptz, d boolean[])`;
    await db`insert into shapes values (${"yes"}, ${"\\x4142"}, ${"2026-10-17T12:00:00Z"}, ${["t", false]})`;
    const [x] = await db`select a, encode(b, 'escape') as b, c, d from shapes`;
    return [
      "true AB 2026-10-17T12:00:00.000Z true,false",
      [x.a, x.b, x.c.toISOString(), x.d].join(" "),
      await db.end(),
    ];
  }
);

t(
  "infer: false writes a Date to a timestamp column as the instant it is, not in the session time zone",
  async () => {
    const db = postgres({
      ...options,
      connection: { TimeZone: "America/New_York" },
      infer: false,
      max: 1,
    });
    await db`create temp table stamps (at timestamp)`;
    await db`insert into stamps values (${new Date("2026-10-17T12:00:00Z")})`;
    const [{ at }] = await db`select at::text from stamps`;
    return ["2026-10-17 12:00:00", at, await db.end()];
  }
);

t(
  "infer: false reads a timestamp column back as the instant that was written",
  async () => {
    const db = postgres({
      ...options,
      connection: { TimeZone: "America/New_York" },
      infer: false,
      max: 1,
    });
    await db`create table test (at timestamp, ats timestamp[])`;
    const date = new Date("2026-06-01T12:00:00.123Z");
    await db`insert into test values (${date}, ${[date]})`;
    const [{ at, ats }] = await db`select at, ats from test`;
    return [
      `${date.toISOString()} ${date.toISOString()}`,
      `${at.toISOString()} ${ats[0].toISOString()}`,
      await db`drop table test`,
      await db.end(),
    ];
  }
);

t(
  "Custom type serializes values the server says are of a type in its from (#1129)",
  async () => {
    const db = postgres({
      ...options,
      max: 1,
      types: {
        point: {
          from: [600],
          parse: (x) => x.slice(1, -1).split(",").map(Number),
          serialize: ([x, y]) => `(${x},${y})`,
          to: 600,
        },
      },
    });
    await db`create temp table points (p point)`;
    await db`insert into points values (${[1, 2]})`;
    const [{ p }] = await db`select p from points`;
    return ["1,2", p.join(","), await db.end()];
  }
);

const enumTable = async (name, rows) => {
  await sql.unsafe(
    [
      `drop table if exists ${name}`,
      `drop type if exists ${name}_mood`,
      `create type ${name}_mood as enum ('a', 'b')`,
      `create table ${name} (m ${name}_mood)`,
      ...(rows ? [`insert into ${name} values ${rows}`] : []),
    ].join(";")
  );
  return () => sql.unsafe(`drop table ${name}; drop type ${name}_mood`);
};

t(
  "A column of a type Postgres.js does not know returns its rows as text, empty or not",
  async () => {
    const drop = await enumTable("test_enum_rows");
    const fresh = postgres(options);
    const empty = await fresh`select m from test_enum_rows`;
    await sql`insert into test_enum_rows values ('a'), ('b')`;
    const tagged = await fresh`select m from test_enum_rows order by m`;
    const simple = await fresh.unsafe(
      "select m from test_enum_rows order by m"
    );
    const many = await fresh.unsafe(
      "select m from test_enum_rows order by m; select 1 as n"
    );
    await fresh.end();
    await drop();
    return [
      "0 a,b a,b a,b 1",
      [
        empty.length,
        tagged.map((x) => x.m),
        simple.map((x) => x.m),
        many[0].map((x) => x.m),
        many[1][0].n,
      ].join(" "),
    ];
  }
);

t(
  "forEach and cursors get every row of a column of a type Postgres.js does not know",
  async () => {
    const drop = await enumTable("test_enum_each", "('a'), ('b'), ('a')");
    const fresh = postgres(options);
    const seen = [];
    const batches = [];
    await fresh`select m from test_enum_each`.forEach((row) =>
      seen.push(row.m)
    );
    await fresh`select m from test_enum_each`.cursor(2, (rows) => {
      batches.push(rows.length);
    });
    await fresh.end();
    await drop();
    return ["3 2,1", `${seen.length} ${batches.join(",")}`];
  }
);

t(
  "A parameter of a type Postgres.js does not know keeps its place among the queries after it",
  async () => {
    const drop = await enumTable("test_enum_order");
    const fresh = postgres({ ...options, max: 1 });
    await fresh`select 1`;
    const [, select] = await fresh.begin((tx) => [
      tx`insert into test_enum_order values (${"a"})`,
      tx`select count(*)::int as n from test_enum_order`,
    ]);
    const commands = await Promise.all([
      fresh`begin`,
      fresh`insert into test_enum_order values (${"b"})`,
      fresh`rollback`,
    ]).then((results) => results.map((x) => x.command));
    const [{ n }] = await fresh`select count(*)::int as n from test_enum_order`;
    await fresh.end();
    await drop();
    return [
      "1 BEGIN,INSERT,ROLLBACK 1",
      `${select[0].n} ${commands.join(",")} ${n}`,
    ];
  }
);

t(
  "infer: false writes a Date for a text parameter as an ISO timestamp",
  async () => {
    const db = postgres({ ...options, infer: false, max: 1 });
    const [{ x }] =
      await db`select ${new Date("2026-06-01T12:00:00.123Z")}::text as x`;
    return ["2026-06-01T12:00:00.123Z", x, await db.end()];
  }
);

t(
  "An array in a values list is written as an array for a cast (#741)",
  async () => {
    const [{ r }] =
      await sql`select (v.r)::real[] as r from (values ${sql([[1, [1.25, 3.5]]])}) as v(id, r)`;
    return ["1.25,3.5", r.join(",")];
  }
);

t(
  "An object in a values list is written as json for a cast (#872, #765)",
  async () => {
    const [{ j }] =
      await sql`select (v.j)::jsonb as j from (values ${sql([[1, { a: 1, b: [true, null] }]])}) as v(id, j)`;
    return ['{"a":1,"b":[true,null]}', JSON.stringify(j)];
  }
);

t(
  "infer: false writes a boolean array to a jsonb parameter and a bigint to numeric (#931, #874)",
  async () => {
    const db = postgres({ ...options, infer: false });
    const [{ j, n }] =
      await db`select ${[true, false]}::jsonb as j, ${1n << 255n}::numeric(78,0)::text as n`;
    return [
      `[true,false] ${1n << 255n}`,
      `${JSON.stringify(j)} ${n}`,
      await db.end(),
    ];
  }
);

t("A bigint array is written to an int8[] column (#837)", async () => {
  const [{ x }] =
    await sql`select ${[9_007_199_254_740_994n, 1n]}::int8[]::text as x`;
  return ["{9007199254740994,1}", x];
});

t(
  "A custom type given by name is looked up, with its array type (#1115)",
  async () => {
    await sql`drop type if exists pair_t cascade`;
    await sql`create type pair_t as (a int, b int)`;
    const sql2 = postgres({
      ...options,
      types: {
        pair: {
          from: ["pair_t"],
          parse: (x) => x.slice(1, -1).split(",").map(Number),
          serialize: (x) => `(${x.join(",")})`,
          to: "pair_t",
        },
      },
    });
    const [{ x, xs, sum }] = await sql2`
    select
      ${sql2.typed.pair([1, 2])}::pair_t as x,
      array[${sql2.typed.pair([3, 4])}::pair_t] as xs,
      (${sql2.typed.pair([5, 6])}::pair_t).a as sum
  `;
    await sql2.end();
    await sql`drop type pair_t`;
    return ["1,2 3,4 5", `${x.join(",")} ${xs[0].join(",")} ${sum}`];
  }
);

t(
  "Several custom type names that do not exist are named in one TYPE_NOT_FOUND",
  async () => {
    const sql2 = postgres({
      ...options,
      types: {
        a: { serialize: String, to: "no_such_a" },
        b: { serialize: String, to: "no_such_b" },
      },
    });
    const message = await sql2`select 1`.then(
      () => "ran",
      (error) => `${error.code} ${error.message}`
    );
    await sql2.end();
    return [
      "TYPE_NOT_FOUND TYPE_NOT_FOUND: The types no_such_a, no_such_b do not exist",
      message,
    ];
  }
);

t(
  "A custom type name that does not exist rejects with TYPE_NOT_FOUND",
  async () => {
    const sql2 = postgres({
      ...options,
      types: {
        nope: {
          from: ["no_such_type"],
          parse: String,
          serialize: String,
          to: "no_such_type",
        },
      },
    });
    const codes = [
      await sql2`select 1`.then(
        () => "ran",
        (error) => error.code
      ),
      await sql2
        .begin((tx) => tx`select 1`)
        .then(
          () => "ran",
          (error) => error.code
        ),
    ];
    await sql2.end();
    return ["TYPE_NOT_FOUND TYPE_NOT_FOUND", codes.join(" ")];
  }
);

t(
  "A custom type created after a failed lookup is found on a later query",
  { timeout: 10 },
  async () => {
    await sql`drop type if exists later_t cascade`;
    const sql2 = postgres({
      ...options,
      types: {
        later: {
          from: ["later_t"],
          parse: (x) => `parsed ${x}`,
          serialize: String,
          to: "later_t",
        },
      },
    });
    const first = await sql2`select 1`.then(
      () => "ran",
      (error) => error.code
    );
    await sql`create type later_t as enum ('a')`;
    await delay(1100);
    const [{ x }] = await sql2`select 'a'::later_t as x`;
    await sql2.end();
    await sql`drop type later_t`;
    return ["TYPE_NOT_FOUND parsed a", `${first} ${x}`];
  }
);

t("Custom types by name need fetch_types", () => {
  let code;
  try {
    postgres({
      ...options,
      fetch_types: false,
      types: { x: { from: ["x"], parse: String, serialize: String, to: "x" } },
    });
  } catch (error) {
    ({ code } = error);
  }
  return ["TYPE_NOT_FOUND", code];
});

t(
  "A value typed as a domain on a new pool is written for the domain base type",
  async () => {
    await sql`create domain test_doc as jsonb`;
    const [{ oid }] = await sql`select 'test_doc'::regtype::oid::int as oid`;
    const fresh = postgres({ ...options, max: 2 });
    const [{ x }] = await fresh`select ${fresh.typed("text", oid)} as x`;
    return [
      '"text"',
      JSON.stringify(x),
      await fresh.end(),
      await sql`drop domain test_doc`,
    ];
  }
);

const binaries = (
  db
) => db`select ${1}::int as k, '\\x00ff10'::bytea as b, array[1, -2, null, 2147483647, -2147483648]::int4[] as i4,
  array[[1, 2], [3, -32768]]::int2[] as i2, array['9223372036854775807', null]::int8[] as i8, array[true, false, null]::bool[] as bo,
  '{}'::int[] as e, '[0:1]={5,6}'::int[] as lb, null::int[] as n`;

t(
  "bytea and integer and boolean arrays read the same before and after the statement is prepared",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const results = [
      await binaries(db),
      await binaries(db),
      await binaries(db),
    ].map((x) => JSON.stringify(x));
    return [results[0] + results[0], results[1] + results[2], await db.end()];
  }
);

t(
  "A custom parser for an integer array still gets the text after the statement is prepared",
  async () => {
    const db = postgres({
      ...options,
      max: 1,
      types: {
        ints: {
          from: [1007],
          parse: (x) => `text ${x}`,
          serialize: (x) => x,
          to: 1007,
        },
      },
    });
    const query = () =>
      db`select array[1, 2]::int4[] as x, ${1}::int as k`.then(([x]) => x.x);
    return [
      "text {1,2} text {1,2}",
      `${await query()} ${await query()}`,
      await db.end(),
    ];
  }
);

t(
  "A custom parser for the elements of an integer array still gets the text after the statement is prepared",
  async () => {
    const db = postgres({
      ...options,
      max: 1,
      types: {
        int: {
          from: [23],
          parse: (x) => `n${x}`,
          serialize: (x) => `${x}`,
          to: 23,
        },
      },
    });
    const query = () =>
      db`select array[1, 2]::int4[] as x, ${1}::int8 as k`.then(([x]) =>
        x.x.join(",")
      );
    return ["n1,n2 n1,n2", `${await query()} ${await query()}`, await db.end()];
  }
);

t(
  "raw() gets the text of bytea and arrays after the statement is prepared",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const query = () =>
      db`select '\\x01'::bytea as b, array[1]::int[] as a, ${1}::int as k`
        .raw()
        .then(([x]) => x.map(String).join(","));
    return [
      "\\x01,{1},1 \\x01,{1},1",
      `${await query()} ${await query()}`,
      await db.end(),
    ];
  }
);

t("Timestamps read the same in time zones with odd offsets", async () => {
  const db = postgres({ ...options, max: 1 });
  const at = "2026-03-29 01:59:59.999999+00";
  const read = async (zone) => {
    await db`select set_config('timezone', ${zone}, false)`;
    const [x] = await db`
      select ${at}::timestamptz as a, '1890-01-01 12:00:00+00'::timestamptz as b,
        '0044-03-15 12:00:00+00 BC'::timestamptz as c, 'infinity'::timestamptz as d
    `;
    return [x.a.toISOString(), x.b.toISOString(), x.c.getTime(), x.d].join(",");
  };
  const results = [
    await read("UTC"),
    await read("Asia/Kolkata"),
    await read("America/St_Johns"),
    await read("Europe/Amsterdam"),
  ];
  return [results[0].repeat(4), results.join(""), await db.end()];
});

t(
  "A pool reads array types and domains only once a query meets a type it does not know",
  async () => {
    await sql`create type test_mood as enum ('ok', 'sad')`;
    const texts = [];
    const fresh = postgres({
      ...options,
      debug: (id, text) => texts.push(text),
      max: 1,
    });
    const fetches = () =>
      texts.filter((x) => x.includes("pg_catalog.pg_type")).length;
    await fresh`select 1 as x`;
    await fresh`select now() as x, array[1]::int[] as y`;
    const before = fetches();
    const [{ m }] = await fresh`select '{ok,sad}'::test_mood[] as m`;
    const [{ n }] = await fresh`select '{sad}'::test_mood[] as n`;
    return [
      "0 ok,sad 1 sad",
      [before, m.join(","), fetches(), n.join(",")].join(" "),
      await fresh.end(),
      await sql`drop type test_mood`,
    ];
  }
);
