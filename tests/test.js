import { inspect } from "node:util";

let done = 0;
let only = false;
let ignored = 0;
let skipped = 0;
let current = null;
let promise = Promise.resolve();
const tests = {};
const filter = (process.argv[2] || "").toLowerCase();

const stray = (error) => {
  if (current && !current.succeeded && !current.failed) {
    current.stray(error);
  } else {
    console.error("\n⚠️", "Stray error outside a test", "\n", inspect(error));
  }
};

process.on("unhandledRejection", stray);
process.on("uncaughtException", stray);

const exit = () => {
  const failures = Object.values(tests).filter((x) => !x.succeeded);

  console.log("");
  for (const x of failures) {
    console.error(
      "⛔️",
      x.name,
      "at",
      x.line,
      x.failed ? "failed" : "never finished",
      x.error ? `\n${inspect(x.error)}` : ""
    );
  }

  if (only || skipped) {
    console.error("⚠️", "Not all tests were run");
  } else if (ignored) {
    console.error("⚠️", ignored, `ignored test${ignored === 1 ? "" : "s"}`);
  } else if (failures.length) {
    console.error("⚠️", failures.length, "of", done, "failed");
  } else {
    console.log("🎉");
  }

  if (!process.exitCode && (failures.length || only || ignored)) {
    process.exitCode = 1;
  }
};

// Run the test's own chain apart from the runner's chain, so the two stay flat.
const settle = (x, resolve, reject) =>
  Promise.resolve().then(t.before).then(x.fn).then(resolve, reject);

// Exit once the last registered test is done and whatever the runner waits for is ready.
const exitWhenReady = () =>
  t.ready.then(() => done === Object.keys(tests).length && exit());

const test = async (o, name, options, fn) => {
  let body = fn;
  let settings = options;
  if (typeof options !== "object") {
    body = options;
    settings = {};
  }
  const at = new Error("Where the test is").stack
    .split("\n")
    .map((x) => x.match(/[/\\](?<file>[^/\\]+\.js):(?<line>[0-9]+):/u))
    .find((x) => x && x.groups.file !== "test.js");
  const line = at ? `${at.groups.file}:${at.groups.line}` : "?";

  // Wait a tick, so every test of a file is registered before the first one runs.
  // oxlint-disable-next-line unicorn/no-unnecessary-await -- the tick is the point
  await 1;

  if (only && !o) {
    return;
  }

  if (filter && !name.toLowerCase().includes(filter)) {
    skipped += 1;
    return;
  }

  const x = { fn: body, line, name };
  tests[`${line} ${name}`] = x;
  promise = promise
    // oxlint-disable-next-line require-await -- an async callback keeps the ticks between tests as they were
    .then(async () => {
      current = x;
      const timeout = Promise.withResolvers();
      const run = Promise.withResolvers();
      x.timer = setTimeout(
        () => timeout.reject("Timed out"),
        (settings.timeout || t.timeout) * 1000
      );
      x.stray = run.reject;
      settle(x, run.resolve, run.reject);
      return Promise.race([timeout.promise, run.promise]);
    })
    .then(async (result) => {
      if (!Array.isArray(result)) {
        // oxlint-disable-next-line unicorn/prefer-type-error -- the runner's report keeps its Error
        throw new Error("Test should return result array");
      }

      const [expected, got] = await Promise.all(result);
      if (expected !== got) {
        throw new Error(`${inspect(expected)} != ${inspect(got)}`);
      }

      x.succeeded = true;
      process.stdout.write("✅");
      return x;
    })
    .catch((testError) => {
      x.failed = true;
      x.error =
        testError instanceof Error ? testError : new Error(inspect(testError));
      process.stdout.write("⛔️");
    })
    .then(() => {
      clearTimeout(x.timer);
      current = null;
      done += 1;
      if (done === Object.keys(tests).length) {
        exitWhenReady();
      }
      return x;
    });
};

export const nt = () => {
  ignored += 1;
};
export const ot = (...rest) => {
  only = true;
  return test(true, ...rest);
};
export const t = (...rest) => test(false, ...rest);
t.timeout = 5;
t.before = null;
t.ready = Promise.resolve();
