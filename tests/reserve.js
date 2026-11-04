import net from "node:net";

import { postgres, sql, options, delay, idle_timeout } from "./setup.js";
import { t } from "./test.js";

const noop = () => {
  // The rejection is expected; what follows it is tested.
};

t("Ensure reserve on connection throws proper error", async () => {
  const db = postgres({
    idle_timeout,
    socket: () => {
      // oxlint-disable-next-line no-throw-literal -- the test is about a thrown value that is not an Error
      throw "wat";
    },
  });

  return ["wat", await db.reserve().catch((error) => error)];
});

t("reserve connection", async () => {
  const reserved = await sql.reserve();

  setTimeout(() => reserved.release(), 510);

  const xs = await Promise.all([
    reserved`select 1 as x`.then(([{ x }]) => ({ time: Date.now(), x })),
    sql`select 2 as x`.then(([{ x }]) => ({ time: Date.now(), x })),
    reserved`select 3 as x`.then(([{ x }]) => ({ time: Date.now(), x })),
  ]);

  if (xs[1].time - xs[2].time < 500) {
    throw new Error("Wrong time");
  }

  return ["123", xs.map((x) => x.x).join("")];
});

t("arrays in reserved connection", async () => {
  const reserved = await sql.reserve();
  const [{ x }] = await reserved`select array[1, 2, 3] as x`;
  reserved.release();

  return ["123", x.join("")];
});

t("Ensure reserve on query throws proper error", async () => {
  const db = postgres({ idle_timeout });
  const reserved = await db.reserve();
  const [{ x }] = await reserved`select 'wat' as x`;

  return ["wat", x, reserved.release()];
});

t("reserve with fetch_types: false on a cold pool", async () => {
  const db = postgres({ ...options, fetch_types: false });
  const reserved = await db.reserve();
  const [{ x }] = await reserved`select 1 as x`;
  reserved.release();
  await db.end();
  return [1, x];
});

t("end() resolves after reserve and release", async () => {
  const db = postgres(options);
  const reserved = await db.reserve();
  reserved.release();
  return ["ended", await db.end().then(() => "ended")];
});

t(
  "end() resolves when a reserved connection is released after end was called (#1262)",
  async () => {
    const db = postgres({ ...options, max: 2 });
    const reserved = await db.reserve();
    await reserved`select 1`;
    const ended = db.end();
    await delay(10);
    reserved.release();
    return [
      "ended 0",
      `${await ended.then(() => "ended")} ${db.stats.connections}`,
    ];
  }
);

t("reserve queued behind a terminated connection", async () => {
  const pool = postgres(options);
  const reserved = await pool.reserve();
  const [{ pid }] = await reserved`select pg_backend_pid() as pid`;
  const pending = pool.reserve();

  await sql`select pg_terminate_backend(${pid})`;

  const next = await pending;
  const [{ x }] = await next`select 1 as x`;
  next.release();
  await pool.end();

  return [1, x];
});

t("reserve after a terminated query", async () => {
  const pool = postgres(options);
  const reserved = await pool.reserve();
  const [{ pid }] = await reserved`select pg_backend_pid() as pid`;
  const query = reserved`select pg_sleep(30)`.catch((queryError) => queryError);
  const isSleeping = async () => {
    const [{ sleeping }] =
      await sql`select wait_event = 'PgSleep' as sleeping from pg_stat_activity where pid = ${pid}`;
    return sleeping;
  };

  // oxlint-disable-next-line no-await-in-loop -- polling: each check waits for the one before
  while (!(await isSleeping())) {
    // oxlint-disable-next-line no-await-in-loop -- polling: each check waits for the one before
    await delay(1);
  }

  await sql`select pg_terminate_backend(${pid})`;
  await query;

  const next = await pool.reserve();
  const [{ x }] = await next`select 1 as x`;
  next.release();
  await pool.end();

  return [1, x];
});

t(
  "Reserved connection rejects queries after its backend is terminated",
  async () => {
    const db = postgres({ ...options, max: 2 });
    const reserved = await db.reserve();
    const [{ pid }] = await reserved`select pg_backend_pid() as pid`;
    await db`select pg_terminate_backend(${pid})`;
    await delay(100);
    const first = await reserved`select 1`.catch((error) => error.code);
    const second = await reserved`select 2`.catch((error) => error.code);
    reserved.release();
    await db.end();
    return ["CONNECTION_CLOSED,CONNECTION_CLOSED", `${first},${second}`];
  }
);

t(
  "Releasing a terminated reserved connection does not return it to the pool",
  async () => {
    const db = postgres({ ...options, max: 1 });
    const killer = postgres(options);
    const reserved = await db.reserve();
    const [{ pid }] = await reserved`select pg_backend_pid() as pid`;
    await killer`select pg_terminate_backend(${pid})`;
    await delay(100);
    await reserved`select 1`.catch(noop);
    reserved.release();
    const [{ x }] = await Promise.race([
      db`select 1 as x`,
      delay(2000).then(() => [{ x: "hung" }]),
    ]);
    await Promise.all([db.end(), killer.end()]);
    return [1, x];
  }
);

t(
  "Writing to a closed reserved connection rejects instead of crashing",
  async () => {
    let downstream;
    const proxy = net.createServer((x) => {
      downstream = x;
      const upstream = net.connect(5432, "127.0.0.1");
      x.pipe(upstream).pipe(x);
      x.on("error", () => upstream.destroy());
      upstream.on("error", () => x.destroy());
    });

    const listening = Promise.withResolvers();
    proxy.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;

    const db = postgres({
      ...options,
      host: "127.0.0.1",
      max: 1,
      port: proxy.address().port,
    });
    const reserved = await db.reserve();

    await reserved`select 1`;
    downstream.end();
    await delay(50);

    const code = await reserved`select 1`.catch((error) => error.code);
    reserved.release();
    proxy.close();

    return ["CONNECTION_CLOSED", code];
  }
);

t(
  "A reserved connection released while its BEGIN is still unanswered is not handed to the next query in that transaction",
  async () => {
    const db = postgres({ ...options, max: 1 });
    await db`create table test (a int)`;
    const reserved = await db.reserve();
    const begin = reserved`begin`.execute();
    const insert = reserved`insert into test values (1)`.execute();
    begin.catch(noop);
    insert.catch(noop);
    const tick = Promise.withResolvers();
    setTimeout(tick.resolve, 0);
    await tick.promise;
    reserved.release();
    const pooled = await db`insert into test values (2)`.then(
      (x) => x.command,
      (error) => error.code
    );
    const leased = [
      await begin.then(
        (x) => x.command,
        (error) => error.code
      ),
      await insert.then(
        (x) => x.command,
        (error) => error.code
      ),
    ];
    const [{ a: rows }] =
      await db`select array_agg(a order by a) as a from test`;
    return [
      "INSERT BEGIN,INSERT [2]",
      `${pooled} ${leased.join(",")} ${JSON.stringify(rows)}`,
      await db`drop table test`,
      await db.end(),
    ];
  }
);

t("reserve and begin after end reject with CONNECTION_ENDED", async () => {
  const db = postgres({ ...options });
  await db`select 1`;
  await db.end();
  const codes = [
    await db.reserve().then(
      () => "ok",
      (error) => error.code
    ),
    await db
      .begin(() => 1)
      .then(
        () => "ok",
        (error) => error.code
      ),
  ];
  return ["CONNECTION_ENDED CONNECTION_ENDED", codes.join(" ")];
});

t("Releasing a reserved connection twice releases it once", async () => {
  const db = postgres({ ...options, max: 1 });
  const reserved = await db.reserve();
  reserved.release();
  reserved.release();
  const [[a], [b]] = await Promise.all([
    db`select 1 as x`,
    db.reserve().then((r) => r`select 2 as x`.finally(r.release)),
  ]);
  return ["1 2", `${a.x} ${b.x}`, await db.end()];
});
