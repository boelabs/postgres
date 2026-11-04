import { fileURLToPath } from "node:url";

import { PostgresError, queryError, withOrigin } from "../../src/errors.js";
import postgres from "../../src/index.js";
import { t } from "../test.js";

// Node writes this file as a url in stack traces, Bun as a path (C:\... with backslashes on Windows).
const places = [
  import.meta.url,
  new URL(import.meta.url).pathname,
  fileURLToPath(import.meta.url),
];
const mentionsHere = (stack) => places.some((x) => String(stack).includes(x));
const offline = () =>
  postgres({ host: "localhost", port: 1, connect_timeout: 1, max: 1 });

t("PostgresError from server fields", async () => {
  const e = new PostgresError({
    message: "division by zero",
    code: "22012",
    severity: "ERROR",
  });
  return [
    "true|PostgresError|division by zero|22012|ERROR",
    [e instanceof Error, e.name, e.message, e.code, e.severity].join("|"),
  ];
});

t("PostgresError from a message string", async () => {
  const e = new PostgresError("Error message.");
  return ["Error message.|false", `${e.message}|${"0" in e}`];
});

t("PostgresError is exported from the package", async () => [
  true,
  postgres.PostgresError === PostgresError,
]);

t("Connection error stack is writable and configurable", async () => {
  const sql = offline();
  const e = await sql`select 1`.catch((x) => x);
  await sql.end();
  const d = Object.getOwnPropertyDescriptor(e, "stack");
  e.stack = "y";
  return [
    "true,true,y",
    [
      d ? d.writable !== false || !!d.set : true,
      d ? d.configurable : true,
      e.stack,
    ].join(),
  ];
});

t("Connection error stack includes the calling line", async () => {
  const sql = offline();
  const e = await sql`select 1`.catch((x) => x);
  await sql.end();
  return [true, mentionsHere(e.stack)];
});

t("Undefined value error stack includes the calling line", async () => {
  const sql = offline();
  const e = await sql`select ${undefined}`.catch((x) => x);
  await sql.end();
  return ["UNDEFINED_VALUE|true", `${e.code}|${mentionsHere(e.stack)}`];
});

t("Not tagged error has a code", async () => {
  const sql = offline();
  const e = await Promise.resolve()
    .then(() => sql("select 1"))
    .catch((x) => x);
  await sql.end();
  return ["NOT_TAGGED_CALL", e.code];
});

// Bun raises some connection errors without a stack, such as the DNSException of a failed lookup.
// Building the query's error from one used to throw a TypeError, and the query never settled.
const caller = ["Error", "    at caller (/app/x.js:1:1)"].join("\n");

function stackless(message) {
  const error = Object.assign(new Error(message), { code: "ENOTFOUND" });
  Object.defineProperty(error, "stack", {
    value: undefined,
    writable: true,
    configurable: true,
  });
  return error;
}

t("withOrigin gives an error without a stack the calling stack", async () => {
  const e = withOrigin(stackless("getaddrinfo ENOTFOUND db"), caller);
  return [
    ["Error: getaddrinfo ENOTFOUND db", "    at caller (/app/x.js:1:1)"].join(
      "\n"
    ),
    e.stack,
  ];
});

t("withOrigin leaves a frozen error as it is", async () => {
  const error = Object.freeze(new Error("frozen"));
  return [error, withOrigin(error, caller)];
});

t("queryError passes on a non-extensible error", async () => {
  const error = Object.preventExtensions(stackless("sealed"));
  return [
    error,
    queryError(
      error,
      { strings: ["select 1"], args: [], origin: caller },
      false
    ),
  ];
});

t("queryError takes a value that is not an object", async () => {
  const e = queryError(
    undefined,
    { strings: ["select 1"], args: [], origin: "" },
    false
  );
  return ["true|select 1", `${e instanceof Error}|${e.query}`];
});

t("A connection error without a stack rejects the query", async () => {
  const sql = postgres({
    max: 1,
    connect_timeout: 1,
    socket: () =>
      Promise.reject(stackless("getaddrinfo ENOTFOUND nonexistent-host")),
  });
  const e = await Promise.race([
    sql`select 1`.catch((x) => x),
    new Promise((r) => setTimeout(r, 3000, { code: "PENDING" })),
  ]);
  await sql.end({ timeout: 0 });
  return ["ENOTFOUND|true", `${e.code}|${mentionsHere(e.stack)}`];
});
