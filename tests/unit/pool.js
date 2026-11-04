import v8 from "node:v8";
import vm from "node:vm";

import { Queue } from "../../src/pool.js";
import { t } from "../test.js";

const gc = globalThis.Bun
  ? () => globalThis.Bun.gc(true)
  : (v8.setFlagsFromString("--expose-gc"), vm.runInNewContext("gc"));

t("Queue hands items back in order across compaction", () => {
  const q = Queue();
  const out = [];
  for (let i = 0; i < 5000; i += 1) {
    q.push(i);
    if (i % 3 === 0) {
      out.push(q.shift());
    }
  }
  while (q.length) {
    out.push(q.shift());
  }
  return [true, out.length === 5000 && out.every((x, i) => x === i)];
});

t("Queue removes, peeks and takes what is left", () => {
  const q = Queue();
  for (const x of [1, 2, 3, 4]) {
    q.push(x);
  }
  q.shift();
  const removed = q.remove((x) => x === 3);
  const missing = q.remove((x) => x === 9);
  return [
    "true false 2 2,4 0",
    [removed, missing, q.peek(), q.take().join(","), q.length].join(" "),
  ];
});

const time = (n) => {
  const q = Queue();
  for (let i = 0; i < n; i += 1) {
    q.push({ i });
  }
  const start = performance.now();
  while (q.length) {
    q.shift();
  }
  return performance.now() - start;
};

t("Queue shifts a long queue in linear time", () => {
  const best = (n) => Math.min(...[1, 2, 3, 4, 5].map(() => time(n)));
  time(50_000);
  const small = Math.max(best(50_000), 1);
  const large = best(400_000);
  return [true, large < small * 30];
});

t(
  "Queue stays small when items cycle through it without it ever draining (#747)",
  () => {
    const q = Queue();
    for (const x of ["a", "b", "c"]) {
      q.push(x);
    }
    for (let i = 0; i < 1_000_000; i += 1) {
      q.push(q.shift());
    }
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 1_000_000; i += 1) {
      q.push(q.shift());
    }
    gc();
    return [
      "3 true",
      `${q.length} ${process.memoryUsage().heapUsed - before < 1024 * 1024}`,
    ];
  }
);
