import {
  postgres,
  sql,
  options,
  login_md5,
  rel,
  idle_timeout,
  delay,
} from "./setup.js";
import { t } from "./test.js";

t("Undefined values throws", async () => {
  let error;

  await sql`
    select ${undefined} as x
  `.catch((queryError) => (error = queryError.code));

  return ["UNDEFINED_VALUE", error];
});

t("Throw syntax error", async () => {
  const { code } = await sql`wat 1`.catch((error) => error);
  return ["42601", code];
});

t("Proper handling of non object Errors", async () => {
  const db = postgres({
    socket: () => {
      // oxlint-disable-next-line no-throw-literal -- the test is about a thrown value that is not an Error
      throw "wat";
    },
  });

  return ["wat", await db`select 1 as x`.catch((error) => error.message)];
});

t("Proper handling of null Errors", async () => {
  const db = postgres({
    socket: () => {
      // oxlint-disable-next-line no-throw-literal -- the test is about a thrown null
      throw null;
    },
  });

  return ["null", await db`select 1 as x`.catch((error) => error.message)];
});

t("sql file throws", async () => [
  "ENOENT",
  await sql.file(rel("selectomondo.sql")).catch((error) => error.code),
]);

t("Throws if more than 65534 parameters", async () => {
  await sql`create table test (x int)`;
  return [
    "MAX_PARAMETERS_EXCEEDED",
    await sql`insert into test ${sql(
      Array.from({ length: 65_535 }, (_, x) => ({ x }))
    )}`.catch((error) => error.code),
    await sql`drop table test`,
  ];
});

t("await sql() throws not tagged error", async () => {
  let error;
  try {
    await sql("select 1");
  } catch (callError) {
    error = callError.code;
  }
  return ["NOT_TAGGED_CALL", error];
});

const noop = () => {
  // Never called: the call before it throws.
};

t("sql().then throws not tagged error", () => {
  let error;
  try {
    // oxlint-disable-next-line promise/catch-or-return -- then throws before there is a promise, which is what is tested
    sql("select 1").then(noop);
  } catch (callError) {
    error = callError.code;
  }
  return ["NOT_TAGGED_CALL", error];
});

t("sql().catch throws not tagged error", () => {
  let error;
  try {
    sql("select 1").catch(noop);
  } catch (callError) {
    error = callError.code;
  }
  return ["NOT_TAGGED_CALL", error];
});

t("sql().finally throws not tagged error", () => {
  let error;
  try {
    // oxlint-disable-next-line promise/catch-or-return -- finally throws before there is a promise, which is what is tested
    sql("select 1").finally(noop);
  } catch (callError) {
    error = callError.code;
  }
  return ["NOT_TAGGED_CALL", error];
});

t("little bobby tables", async () => {
  const name = "Robert'); DROP TABLE students;--";

  await sql`create table students (name text, age int)`;
  await sql`insert into students (name) values (${name})`;

  const [row] = await sql`select name from students`;
  return [name, row.name, await sql`drop table students`];
});

t("throws correct error when authentication fails", async () => {
  const db = postgres({
    ...options,
    ...login_md5,
    pass: "wrong",
  });
  return ["28P01", await db`select 1`.catch((error) => error.code)];
});

t("notice", async () => {
  let notice;
  const { log } = console;
  console.log = (x) => {
    notice = x;
  };

  const db = postgres(options);

  await db`create table if not exists users()`;
  await db`create table if not exists users()`;

  console.log = log;

  return ["NOTICE", notice.severity];
});

t("notice hook", async () => {
  let notice;
  const db = postgres({
    ...options,
    onnotice: (x) => (notice = x),
  });

  await db`create table if not exists users()`;
  await db`create table if not exists users()`;

  return ["NOTICE", notice.severity];
});

t("Debug", async () => {
  let result;
  const db = postgres({
    ...options,
    debug: (connection_id, str) => (result = str),
  });

  await db`select 1`;

  return ["select 1", result];
});

// The line number in the frame at index i of a stack.
const stackLine = (stack, i) =>
  Number(
    stack
      .split("\n")
      .at(i)
      .match(/:(?<line>\d+):/u).groups.line
  );

t("Async stack trace", async () => {
  const db = postgres({ ...options, debug: false });
  // The query is made on the line right after `here`, whatever the formatter does to the rest.
  const here = new Error("here");
  const query = db`error`;
  const error = await query.catch((queryError) => queryError);
  return [stackLine(here.stack, 1) + 1, stackLine(error.stack, -1)];
});

t("Debug has long async stack trace", async () => {
  const db = postgres({ ...options, debug: true });

  const wat = () => db`error`;
  const yo = () => wat();

  const inlines = typeof Bun !== "undefined";
  return [
    inlines ? "true" : "watyo",
    await yo().catch((error) =>
      inlines
        ? String(error.stack.includes("errors.js"))
        : error.stack.match(/wat|yo/gu).join("")
    ),
  ];
});

t("Error contains query string", async () => [
  "selec 1",
  await sql`selec 1`.catch((error) => error.query),
]);

t("Error contains query serialized parameters", async () => [
  1,
  await sql`selec ${1}`.catch((error) => error.parameters[0]),
]);

t("Error contains query raw parameters", async () => [
  1,
  await sql`selec ${1}`.catch((error) => error.args[0]),
]);

t(
  "Query and parameters on errorare not enumerable if debug is not set",
  async () => {
    const db = postgres({ ...options, debug: false });

    return [
      false,
      await db`selec ${1}`.catch(
        (error) =>
          Object.prototype.propertyIsEnumerable.call(error, "parameters") ||
          Object.prototype.propertyIsEnumerable.call(error, "query")
      ),
    ];
  }
);

t("Query and parameters are enumerable if debug is set", async () => {
  const db = postgres({ ...options, debug: true });

  return [
    true,
    await db`selec ${1}`.catch(
      (error) =>
        Object.prototype.propertyIsEnumerable.call(error, "parameters") &&
        Object.prototype.propertyIsEnumerable.call(error, "query")
    ),
  ];
});

t("Postgres errors are of type PostgresError", async () => {
  const error = await sql`bad keyword`.catch((queryError) => queryError);
  return [true, error instanceof sql.PostgresError];
});

t("Catches query format errors", async () => [
  "wat",
  await sql
    .unsafe({
      toString: () => {
        throw new Error("wat");
      },
    })
    .catch((error) => error.message),
]);

t("A query that fails to encode leaves the connection usable", async () => {
  const db = postgres({ ...options, max: 1 });
  const error = await db
    .unsafe({
      toString: () => {
        throw new Error("wat");
      },
    })
    .catch((encodeError) => encodeError.message);
  const huge = await db`select ${{
    toJSON() {
      throw new Error("json");
    },
  }}::json`.catch((encodeError) => encodeError.message);
  const [{ x }] = await db`select 1 as x`;
  return ["wat,json,1", [error, huge, x].join(","), await db.end()];
});

t("Catches type serialize errors", async () => {
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
    await db`select ${"wat"}`.catch((error) => error.message),
  ];
});

t("Catches type parse errors", async () => {
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

  return ["watParse", await db`select 'wat'`.catch((error) => error.message)];
});

t("Insert array with undefined throws", async () => {
  await sql`create table test (x int[])`;
  return [
    "UNDEFINED_VALUE",
    await sql`insert into test ${sql({ x: [1, undefined, 3] })}`.catch(
      (error) => error.code
    ),
    await sql`drop table test`,
  ];
});

t("A PostgresError has its fields and its message in JSON (#767)", async () => {
  await sql`create table test (x int check (x > 0))`;
  const error = await sql`insert into test values (-1)`.catch(
    (queryError) => queryError
  );
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- the test is about the error's JSON
  const json = JSON.parse(JSON.stringify(error));
  return [
    "PostgresError 23514 test_x_check test true",
    [
      json.name,
      json.code,
      json.constraint_name,
      json.table_name,
      json.message.includes("check constraint"),
    ].join(" "),
    await sql`drop table test`,
  ];
});

const holding = (refs) => {
  const big = { data: Buffer.alloc(1e6) };
  refs.push(new WeakRef(big));
  return (function inner() {
    return sql`select ${big.data.length} as n`;
  })();
};

t(
  "The cached origin of a query does not keep the closure that made it alive (#1274)",
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

    const refs = [];
    await holding(refs);

    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each collection runs after a pause
      await delay(10);
      gc();
    }

    return [true, refs[0].deref() === undefined];
  }
);
