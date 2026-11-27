import { setTimeout as sleep } from "node:timers/promises";

import { PostgresError, queryError, withOrigin } from "../../src/errors.js";
import postgres from "../../src/index.js";
import { t } from "../test.js";

// Node writes this file as a url in stack traces, Bun as a path (C:\... with backslashes on Windows).
const places = [
  import.meta.url,
  new URL(import.meta.url).pathname,
  import.meta.filename,
];
const mentionsHere = (stack) => places.some((x) => String(stack).includes(x));
const offline = () =>
  postgres({ connect_timeout: 1, host: "localhost", max: 1, port: 1 });

t("PostgresError from server fields", () => {
  const e = new PostgresError({
    code: "22012",
    message: "division by zero",
    severity: "ERROR",
  });
  return [
    "true|PostgresError|division by zero|22012|ERROR",
    [e instanceof Error, e.name, e.message, e.code, e.severity].join("|"),
  ];
});

t("PostgresError from a message string", () => {
  const e = new PostgresError("Error message.");
  return ["Error message.|false", `${e.message}|${"0" in e}`];
});

t("PostgresError is exported from the package", () => [
  true,
  // oxlint-disable-next-line import/no-named-as-default-member -- that the default export carries it is what this tests
  postgres.PostgresError === PostgresError,
]);

t("Connection error stack is writable and configurable", async () => {
  const sql = offline();
  const e = await sql`select 1`.catch((error) => error);
  await sql.end();
  const d = Object.getOwnPropertyDescriptor(e, "stack");
  e.stack = "y";
  return [
    "true,true,y",
    [
      d ? d.writable !== false || !!d.set : true,
      d ? d.configurable : true,
      e.stack,
    ].join(","),
  ];
});

t("Connection error stack includes the calling line", async () => {
  const sql = offline();
  const e = await sql`select 1`.catch((error) => error);
  await sql.end();
  return [true, mentionsHere(e.stack)];
});

t("Undefined value error stack includes the calling line", async () => {
  const sql = offline();
  const e = await sql`select ${undefined}`.catch((error) => error);
  await sql.end();
  return ["UNDEFINED_VALUE|true", `${e.code}|${mentionsHere(e.stack)}`];
});

t("Not tagged error has a code", async () => {
  const sql = offline();
  const e = await Promise.resolve()
    .then(() => sql("select 1"))
    .catch((error) => error);
  await sql.end();
  return ["NOT_TAGGED_CALL", e.code];
});

// Bun raises some connection errors without a stack, such as the DNSException of a failed lookup.
// Building the query's error from one used to throw a TypeError, and the query never settled.
const caller = ["Error", "    at caller (/app/x.js:1:1)"].join("\n");

const stackless = (message) => {
  const error = Object.assign(new Error(message), { code: "ENOTFOUND" });
  Object.defineProperty(error, "stack", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  return error;
};

t("withOrigin gives an error without a stack the calling stack", () => {
  const e = withOrigin(stackless("getaddrinfo ENOTFOUND db"), caller);
  return [
    ["Error: getaddrinfo ENOTFOUND db", "    at caller (/app/x.js:1:1)"].join(
      "\n"
    ),
    e.stack,
  ];
});

t("withOrigin leaves a frozen error as it is", () => {
  const error = Object.freeze(new Error("frozen"));
  return [error, withOrigin(error, caller)];
});

t("queryError passes on a non-extensible error", () => {
  const error = Object.preventExtensions(stackless("sealed"));
  return [
    error,
    queryError(
      error,
      { args: [], origin: caller, strings: ["select 1"] },
      false
    ),
  ];
});

t("queryError takes a value that is not an object", () => {
  const e = queryError(
    undefined,
    { args: [], origin: "", strings: ["select 1"] },
    false
  );
  return ["true|select 1", `${e instanceof Error}|${e.query}`];
});

t("A connection error without a stack rejects the query", async () => {
  const sql = postgres({
    connect_timeout: 1,
    max: 1,
    socket: () =>
      Promise.reject(stackless("getaddrinfo ENOTFOUND nonexistent-host")),
  });
  const e = await Promise.race([
    sql`select 1`.catch((error) => error),
    sleep(3000, { code: "PENDING" }),
  ]);
  await sql.end({ timeout: 0 });
  return ["ENOTFOUND|true", `${e.code}|${mentionsHere(e.stack)}`];
});
