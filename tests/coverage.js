import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const spans = (xs) => {
  const out = [];
  for (const x of xs) {
    const last = out.at(-1);
    if (last && last[1] === x - 1) {
      last[1] = x;
    } else {
      out.push([x, x]);
    }
  }
  return out.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(",");
};

const root = path.join(import.meta.dirname, "..");
const src = path.join(root, "src") + path.sep;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-"));
const suites = process.argv.slice(2).filter((x) => !x.startsWith("--"));
const lines = process.argv.includes("--lines");
const minimum = +process.env.COVERAGE_MIN || 0;

const failed = (
  suites.length ? suites : ["tests/unit", "tests/index.js", "tests/simulate.js"]
).filter(
  (suite) =>
    spawnSync(process.execPath, [path.join(root, suite)], {
      env: { ...process.env, NODE_V8_COVERAGE: dir },
      stdio: "inherit",
    }).status !== 0
);

const files = {};

for (const name of fs.readdirSync(dir)) {
  for (const script of JSON.parse(
    fs.readFileSync(path.join(dir, name), "utf-8")
  ).result) {
    const file = script.url.startsWith("file://") && fileURLToPath(script.url);
    if (!file || !file.startsWith(src)) {
      continue;
    }

    const code = fs.readFileSync(file, "utf-8");
    const counts = new Int32Array(code.length);
    const ranges = script.functions
      .flatMap((fn) => fn.ranges)
      .toSorted(
        (a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset)
      );
    for (const { startOffset, endOffset, count } of ranges) {
      counts.fill(count, startOffset, endOffset);
    }
    files[file] ||= {
      code,
      covered: new Uint8Array(code.length),
    };
    const seen = files[file];
    for (const [i, count] of counts.entries()) {
      if (count > 0) {
        seen.covered[i] = 1;
      }
    }
  }
}

fs.rmSync(dir, { force: true, recursive: true });

let total = 0;
let hit = 0;

const rows = Object.entries(files)
  .toSorted(([a], [b]) => a.localeCompare(b))
  .map(([file, { code, covered }]) => {
    const missing = [];
    let offset = 0;
    let count = 0;
    let ok = 0;
    for (const [i, line] of code.split("\n").entries()) {
      const start = offset;
      offset += line.length + 1;
      if (!line.trim()) {
        continue;
      }

      count += 1;
      let used = false;
      for (let j = start; j < start + line.length && !used; j += 1) {
        used = covered[j] === 1 && line[j - start] !== " ";
      }
      if (used) {
        ok += 1;
      } else {
        missing.push(i + 1);
      }
    }
    total += count;
    hit += ok;
    return {
      file: path.relative(root, file),
      missing,
      percent: (ok / count) * 100,
    };
  });

console.log("\nCoverage of src by line");
for (const { file, percent, missing } of rows) {
  console.log(
    `${file.padEnd(22) + percent.toFixed(2).padStart(7)}%${
      lines && missing.length ? `  ${spans(missing)}` : ""
    }`
  );
}

const percent = (hit / total) * 100;
console.log(`${"total".padEnd(22) + percent.toFixed(2).padStart(7)}%`);

if (process.env.GITHUB_ACTIONS) {
  console.log(
    `::${
      minimum && percent < minimum ? "error" : "notice"
    } title=Coverage::${percent.toFixed(2)}% of lines in src${
      minimum ? `, minimum ${minimum}%` : ""
    }`
  );
}

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      "| File | Lines | Not covered |",
      "| --- | ---: | --- |",
      ...rows.map(
        (x) => `| ${x.file} | ${x.percent.toFixed(2)}% | ${spans(x.missing)} |`
      ),
      `| **total** | **${percent.toFixed(2)}%** | |`,
      "",
    ].join("\n")
  );
}

if (failed.length) {
  console.log(`Failed: ${failed.join(", ")}`);
}
if (minimum && percent < minimum) {
  console.log(`Coverage is below ${minimum}%`);
}

process.exitCode = failed.length || (minimum && percent < minimum) ? 1 : 0;
