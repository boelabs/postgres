import crypto from "node:crypto";
import fs from "node:fs";
import stream from "node:stream";
import { pipeline } from "node:stream/promises";

import { postgres, sql, options, delay, rel } from "./setup.js";
import { t } from "./test.js";

t("Copy read", async () => {
  const result = [];

  await sql`create table test (x int)`;
  await sql`insert into test select * from generate_series(1,10)`;
  const readable = await sql`copy test to stdout`.readable();
  readable.on("data", (x) => result.push(x));
  const ended = Promise.withResolvers();
  readable.on("end", ended.resolve);
  await ended.promise;

  return [result.length, 10, await sql`drop table test`];
});

t("Copy write", async () => {
  await sql`create table test (x int)`;
  const writable = await sql`copy test from stdin`.writable();

  writable.write("1\n");
  writable.write("1\n");
  writable.end();

  const finished = Promise.withResolvers();
  writable.on("finish", finished.resolve);
  await finished.promise;

  const { length } = await sql`select 1 from test`;
  return [length, 2, await sql`drop table test`];
});

t("Copy write as first", async () => {
  await sql`create table test (x int)`;
  const first = postgres(options);
  const writable =
    await first`COPY test FROM STDIN WITH(FORMAT csv, HEADER false, DELIMITER ',')`.writable();
  writable.write("1\n");
  writable.write("1\n");
  writable.end();

  const finished = Promise.withResolvers();
  writable.on("finish", finished.resolve);
  await finished.promise;

  const { length } = await sql`select 1 from test`;
  return [length, 2, await sql`drop table test`];
});

t("Copy from file", async () => {
  await sql`create table test (x int, y int, z int)`;
  const finished = Promise.withResolvers();
  const source = fs.createReadStream(rel("copy.csv"));
  source
    .pipe(await sql`copy test from stdin`.writable())
    .on("finish", finished.resolve);
  await finished.promise;

  return [
    JSON.stringify(await sql`select * from test`),
    '[{"x":1,"y":2,"z":3},{"x":4,"y":5,"z":6}]',
    await sql`drop table test`,
  ];
});

t("Copy from works in transaction", async () => {
  await sql`create table test(x int)`;
  const xs = await sql.begin(async (tx) => {
    const writable = await tx`copy test from stdin`.writable();
    writable.end("1\n2");
    await delay(20);
    return tx`select 1 from test`;
  });

  return [xs.length, 2, await sql`drop table test`];
});

t("Copy from abort", async () => {
  const db = postgres(options);
  const readable = fs.createReadStream(rel("copy.csv"));

  await db`create table test (x int, y int, z int)`;
  await db`TRUNCATE TABLE test`;

  const writable = await db`COPY test FROM STDIN`.writable();

  let aborted;

  readable.pipe(writable).on("error", (error) => (aborted = error));

  writable.destroy(new Error("abort"));
  await db.end();

  return ["abort", aborted.message, await postgres(options)`drop table test`];
});

t("query during copy error", async () => {
  const db = postgres(options);
  await db`create table test (id serial primary key, name text)`;
  const copy = await db`copy test from stdin`.writable();
  const error = await db`select 1`.catch((queryError) => queryError);
  await copy.end();

  return ["COPY_IN_PROGRESS", error.code, await db`drop table test`];
});

t(
  "Copy from settles instead of hanging when the server rejects the data",
  async () => {
    await sql`create table test (x int, y int)`;

    const error = await sql
      .begin(async (tx) => {
        const writable = await tx`copy test from stdin`.writable();
        const finished = Promise.withResolvers();
        writable.on("error", finished.reject);
        writable.on("finish", finished.resolve);
        writable.end("1\t2\t3\n");
        await finished.promise;
      })
      .catch((beginError) => beginError);

    const [{ count }] = await sql`
    select count(*)::int as count from pg_stat_activity
    where state = 'idle in transaction (aborted)'
  `;

    return ["22P04,0", `${error.code},${count}`, await sql`drop table test`];
  }
);

t("Copy read with back-pressure", async () => {
  await sql`create table test (x int)`;

  const bufferSize = Math.ceil(stream.getDefaultHighWaterMark(false) / 6);
  await sql`insert into test select * from generate_series(10000, ${9999 + bufferSize})`;

  let result = 0;
  const readable = await sql`copy test to stdout`.readable();
  readable.on("data", () => {
    result += 1;
  });
  readable.pause();

  const ended = Promise.withResolvers();
  const buffered = Promise.withResolvers();
  readable.on("end", ended.resolve);
  readable.on("readable", () => {
    if (readable.readableBuffer.length === bufferSize) {
      readable.removeAllListeners("readable");
      buffered.resolve();
    }
  });
  await Promise.all([ended.promise, buffered.promise]);

  await sql`select 1`;

  return [bufferSize, result, await sql`drop table test`];
});

t(
  "Copy read through a slow pipeline keeps every byte and never stalls",
  { timeout: 30 },
  () => slowCopy(sql)
);

t(
  "Copy read through a slow pipeline over direct TLS keeps every byte",
  { timeout: 30 },
  async () => {
    const [{ supported }] =
      await sql`select current_setting('server_version_num')::int >= 170000 as supported`;
    if (!supported) {
      return [true, true];
    }

    const tls = postgres({
      ...options,
      max: 1,
      ssl: "require",
      sslnegotiation: "direct",
    });
    const [{ ssl }] =
      await tls`select ssl from pg_stat_ssl where pid = pg_backend_pid()`;
    const [expected, got] = await slowCopy(tls);
    await tls.end();
    return [`${expected} true`, `${got} ${ssl}`];
  }
);

const slowCopy = async (db) => {
  const query =
    "select i, md5(i::text) || repeat(chr(65 + i % 26), i % 300) from generate_series(1, 50000) i";
  const [{ expected }] = await db.unsafe(
    `select md5(string_agg(i || E'\\t' || x || E'\\n', '' order by i)) as expected from (${query}) t(i, x)`
  );
  const hash = crypto.createHash("md5");
  let n = 0;
  await pipeline(
    await db.unsafe(`copy (${query}) to stdout`).readable(),
    new stream.Writable({
      highWaterMark: 1024,
      write(chunk, encoding, done) {
        hash.update(chunk);
        const count = n;
        n += 1;
        if (count % 500 === 0) {
          setTimeout(done, 1);
        } else if (n % 3) {
          done();
        } else {
          setImmediate(done);
        }
      },
    })
  );
  return [expected, hash.digest("hex")];
};

t(
  "A query on a reserved connection during its COPY is rejected and the COPY completes",
  async () => {
    await sql`create table test (a int)`;
    const reserved = await sql.reserve();
    const writable = await reserved`copy test from stdin`.writable();
    writable.write("1\n");
    const code = await reserved`select 1`.then(
      () => "ran",
      (error) => error.code
    );
    const finished = Promise.withResolvers();
    writable.on("finish", finished.resolve);
    writable.on("error", finished.reject);
    writable.end("2\n");
    await finished.promise;
    const [{ n }] = await reserved`select count(*)::int as n from test`;
    reserved.release();
    return ["COPY_IN_PROGRESS 2", `${code} ${n}`, await sql`drop table test`];
  }
);

t(
  "A copy from stdin writable has the count of rows copied once it finishes (#465)",
  async () => {
    await sql`create table test (x int)`;
    const writable = await sql`copy test from stdin`.writable();
    const finished = Promise.withResolvers();
    writable.on("finish", finished.resolve);
    writable.on("error", finished.reject);
    writable.write("1\n2\n");
    writable.end("3\n");
    await finished.promise;
    return [
      "3 COPY",
      `${writable.count} ${writable.command}`,
      await sql`drop table test`,
    ];
  }
);

t(
  "Copy write waits for the socket to drain between large chunks",
  { timeout: 10 },
  async () => {
    await sql`create table test (x text)`;
    const line = `${"x".repeat(1024 * 1024 - 1)}\n`;
    const writable = await sql`copy test from stdin`.writable();
    await pipeline(
      stream.Readable.from(Array.from({ length: 8 }, () => line)),
      writable
    );
    const [{ n }] = await sql`select count(*)::int as n from test`;
    return ["8 8", `${writable.count} ${n}`, await sql`drop table test`];
  }
);
