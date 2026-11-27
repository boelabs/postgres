import { spawn } from "node:child_process";
import fs from "node:fs";

const mode = process.argv.at(2);
const port = process.env.POOLER_PORT || "6432";
const expected = JSON.parse(
  fs.readFileSync(new URL("pooler.json", import.meta.url), "utf-8")
);
const allowed = new Set([
  ...expected.always,
  ...expected.flaky,
  ...(expected[mode] || []),
]);

if (!expected[mode]) {
  throw new Error(
    `usage: node tests/pooler.js <${Object.keys(expected)
      .filter((x) => x !== "always" && x !== "flaky")
      .join("|")}>`
  );
}

const child = spawn(
  process.execPath,
  [new URL("index.js", import.meta.url).pathname],
  {
    env: {
      ...process.env,
      POOLER_PORT: port,
      ...(mode === "transaction" ? { PREPARE: "false" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  }
);

let output = "";
child.stdout.on("data", (x) => {
  output += x;
  process.stdout.write(x);
});
child.stderr.on("data", (x) => (output += x));

const done = setInterval(
  () =>
    /\d+ of \d+ failed|🎉/u.test(output.slice(-3000)) &&
    setTimeout(finish, 2000),
  1000
);

let finished = false;
const finish = () => {
  if (finished) {
    return;
  }

  finished = true;
  clearInterval(done);
  child.kill();
  const failed = [
    ...output.matchAll(/⛔️ (?<name>.+?) at (?<file>[a-z]+\.js):\d+ failed/gu),
  ].map((x) => `${x.groups.file}: ${x.groups.name}`);
  const unexpected = failed.filter((x) => !allowed.has(x));
  const fixed = [...allowed].filter(
    (x) => !failed.includes(x) && (expected[mode] || []).includes(x)
  );
  console.log(
    `\n${failed.length} failed through the pooler in ${mode} mode, ${
      failed.length - unexpected.length
    } of them expected`
  );
  if (fixed.length) {
    console.log(
      `Expected to fail but passed, so no longer needs to be listed:\n  ${fixed.join(
        "\n  "
      )}`
    );
  }
  if (unexpected.length) {
    console.log(`⚠️ Unexpected failures:\n  ${unexpected.join("\n  ")}`);
  }
  process.exitCode = unexpected.length ? 1 : 0;
};
child.on("close", finish);
