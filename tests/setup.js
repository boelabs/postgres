import { setTimeout as sleep } from "node:timers/promises";

import { t } from "./test.js";

export { exec } from "./bootstrap.js";

const { default: postgres } = await import(
  process.env.POSTGRES_JS || "../src/index.js"
);

export { postgres };

const { log } = console;
const notice = (x) =>
  x &&
  typeof x === "object" &&
  "severity_local" in x &&
  !/^(?:ERROR|FATAL|PANIC)$/u.test(x.severity);
console.log = (...xs) =>
  xs.length === 1 && notice(xs[0]) ? undefined : log(...xs);

export const delay = (ms) => sleep(ms);
export const rel = (x) => new URL(x, import.meta.url);
export const idle_timeout = 1;

export const login = {
  user: "postgres_js_test",
};

export const login_md5 = {
  pass: "postgres_js_test_md5",
  user: "postgres_js_test_md5",
};

export const login_scram = {
  pass: "postgres_js_test_scram",
  user: "postgres_js_test_scram",
};

export const options = {
  connect_timeout: 1,
  db: "postgres_js_test",
  idle_timeout,
  max: 1,
  pass: login.pass,
  user: login.user,
  ...(process.env.POOLER_PORT
    ? { host: "localhost", port: +process.env.POOLER_PORT }
    : {}),
  ...(process.env.PREPARE === "false" ? { prepare: false } : {}),
  ...(process.env.INFER === "true" ? { infer: true } : {}),
};

export const sql = postgres(options);

const reset = postgres({
  ...options,
  onnotice: () => {
    // The notice of dropping a table that does not exist is expected.
  },
});
t.before = () =>
  reset`drop table if exists test cascade`.catch(() => {
    // Best effort: a failed reset must not fail the test that runs next.
  });
