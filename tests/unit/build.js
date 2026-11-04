import { setTimeout as sleep } from "node:timers/promises";
import { inspect } from "node:util";

import postgres from "../../src/index.js";
import { t } from "../test.js";
import cases from "./build.cases.js";

const sql = postgres({ host: "localhost", max: 1, port: 1 });
const show = (q) => JSON.stringify([q.text, q.parameters]);

// The code of the error that building the query throws, undefined when it builds.
const buildError = (fn) => {
  try {
    void fn().text;
  } catch (error) {
    return error.code;
  }
};

for (const [name, fn, text, parameters] of cases) {
  t(name, () => [JSON.stringify([text, parameters]), show(fn(sql))]);
}

t("Insert and update helpers with no columns throw (#644)", () => [
  "NO_COLUMNS NO_COLUMNS NO_COLUMNS",
  [
    () => sql`insert into x ${sql({})}`,
    () => sql`insert into x ${sql({ a: 1 }, [])}`,
    () => sql`update x set ${sql({})}`,
  ]
    .map(buildError)
    .join(" "),
]);

t(
  "Undefined values in any row of a multi row insert throw, whatever the order (#889)",
  () => [
    "UNDEFINED_VALUE UNDEFINED_VALUE",
    [
      () =>
        sql`insert into x ${sql([
          { a: 1, b: 1 },
          { a: 2, b: undefined },
        ])}`,
      () =>
        sql`insert into x ${sql([
          { a: 2, b: undefined },
          { a: 1, b: 1 },
        ])}`,
    ]
      .map(buildError)
      .join(" "),
  ]
);

t("A join has the length of the items it kept", () => [
  "2 0",
  `${sql`and`.join([sql`a`, false, sql`b`]).length} ${
    sql`and`.join([]).length
  }`,
]);

t("Transform column names in helpers", () => {
  const db = postgres({
    host: "localhost",
    port: 1,
    transform: postgres.camel,
  });
  return [
    JSON.stringify(['insert into x ("foo_bar")values($1)', [1]]),
    show(db`insert into x ${db({ fooBar: 1 })}`),
  ];
});

t("Transform undefined to null", () => {
  const db = postgres({
    host: "localhost",
    port: 1,
    transform: { undefined: null },
  });
  return [JSON.stringify(["select $1", [null]]), show(db`select ${undefined}`)];
});

t("Inspect hides text and parameters without debug", () => {
  const x = inspect(sql`select ${"secret"} as x`);
  return [false, x.includes("secret") || x.includes("select $1")];
});

t("Inspect shows text and parameters with debug", () => {
  const db = postgres({ debug: true, host: "localhost", port: 1 });
  const x = inspect(db`select ${"secret"} as x`);
  return [true, x.includes("secret") && x.includes("select $1 as x")];
});

t("Building does not run the query", async () => {
  let ran = false;
  const db = postgres({
    debug: () => (ran = true),
    host: "localhost",
    port: 1,
  });
  void db`select 1`.text;
  await sleep(10);
  return [false, ran];
});
