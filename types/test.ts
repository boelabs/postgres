import dc from "node:diagnostics_channel";

import postgres from "./index.js";
import type {
  Sql,
  TransactionSql,
  Row,
  PendingQuery,
  ReplicationEvent,
  QueryTrace,
  PoolEvent,
} from "./index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const expect = <_T extends true>() => {
  // Only the type argument is checked, by the compiler.
};

interface User {
  id: number;
  name: string;
  age: number | null;
}

const sql = postgres({
  connection: { application_name: "test", statement_timeout: 1000 },
  host: ["a", "b"],
  idle_timeout: 20,
  infer: false,
  max: 10,
  max_lifetime: () => 60,
  max_pipeline: 50,
  onnotice: false,
  onread: false,
  password: () => Promise.resolve("secret"),
  port: 5432,
  slot: "my_slot",
  ssl: "require",
  sslnegotiation: "direct",
  transform: postgres.camel,
  types: { bigint: postgres.BigInt },
});

postgres("postgres://user@host/db", { ssl: { rejectUnauthorized: false } });
postgres();

// @ts-expect-error not an sslnegotiation
postgres({ sslnegotiation: "eventually" });
// @ts-expect-error not an ssl mode
postgres({ ssl: "sometimes" });

const queries = async () => {
  const users = await sql<
    User[]
  >`select * from users where id = ${1} and name = ${"a"}`;
  expect<Equal<(typeof users)[number], User>>();
  void users.count;
  void users.command;
  void users.columns[0].name;
  for (const user of users) {
    expect<Equal<typeof user, User>>();
  }

  const [first] = await sql<[User?]>`select * from users limit 1`;
  expect<Equal<typeof first, User | undefined>>();

  const rows = await sql`select 1 as x`;
  expect<Equal<(typeof rows)[number], Row>>();

  const big = await sql`select ${sql.typed.bigint(10n)} as x`;
  void big[0].x;

  const q = sql`select ${new Date()} as d`;
  q.text satisfies string;
  q.parameters satisfies unknown[];
  expect<Equal<typeof q, PendingQuery<Row[]>>>();

  await sql`insert into users ${sql({ age: 1, name: "a" }, "name", "age")}`;
  await sql`insert into users ${sql([
    { age: 1, name: "a" },
    { age: 2, name: "b" },
  ])}`;
  await sql`update users set ${sql({ name: "b" })} where id = 1`;
  await sql`select * from ${sql("users")} where id in ${sql([1, 2, 3])}`;
  await sql`select * from users ${users.length > 0 ? sql`where id = ${1}` : sql``}`;
  await sql`select ${sql.json({ a: [1, 2] })}::json`;
  await sql`select ${[1, 2, 3]}::int[]`;

  await sql.unsafe("select 1", [], { prepare: true });
  await sql.unsafe<User[]>("select * from users where id = $1", [1]);
  await sql.unsafe("select 1; select 2", { simple: true });

  const values = await sql`select 1 as x`.values();
  // oxlint-disable-next-line typescript/no-explicit-any -- the type under test is any[]
  expect<Equal<(typeof values)[number], any[]>>();
  const raw = await sql`select 1 as x`.raw();
  void raw[0][0];

  const statement = await sql`select ${1}::int as x`.describe();
  statement.types.map((x) => x + 1);

  // oxlint-disable-next-line unicorn/no-array-for-each -- the forEach of a query, not of an array
  await sql<User[]>`select * from users`.forEach((user) => {
    expect<Equal<typeof user, User>>();
  });

  for await (const batch of sql<User[]>`select * from users`.cursor(10)) {
    expect<Equal<typeof batch, User[]>>();
  }

  await sql<User[]>`select * from users`.cursor(10, (batch) => {
    expect<Equal<typeof batch, User[]>>();
    return sql.CLOSE;
  });

  const pending = sql`select pg_sleep(1)`.execute();
  await pending.cancel();

  const readable = await sql`copy users to stdout`.readable();
  readable.pipe(process.stdout);
  const writable = await sql`copy users from stdin`.writable();
  writable.end("1\ta\n");

  // @ts-expect-error a helper is not a query
  await sql("users");
  // @ts-expect-error removed in v4
  void sql.array([1, 2]).value;
};

const transactions = async () => {
  const [a, b] = await sql.begin((tx) => [
    tx`select 1 as x`,
    tx<User[]>`select * from users`,
  ]);
  expect<Equal<(typeof a)[number], Row>>();
  expect<Equal<(typeof b)[number], User>>();

  const result = await sql.begin("read write", async (tx) => {
    tx satisfies TransactionSql<{ bigint: bigint }>;
    await tx.savepoint(async (sp) => await sp`select 1`);
    await tx.savepoint("named", (sp) => sp`select 1`);
    expect<Equal<ReturnType<typeof tx.prepare>, string>>();
    tx.prepare("tx1");
    expect<Equal<ReturnType<typeof tx.rollback>, Promise<void>>>();
    await tx.savepoint((sp) => sp.rollback());
    return 42;
  });
  expect<Equal<typeof result, number>>();

  const reserved = await sql.reserve();
  await reserved`select 1`;
  reserved.release();
  // @ts-expect-error a reserved connection cannot end the pool
  reserved.end();
};

const rest = async () => {
  const listened = await sql.listen("news", (payload) => {
    expect<Equal<typeof payload, string>>();
  });
  expect<Equal<keyof typeof listened, "state" | "unlisten">>();
  const { unlisten } = listened;
  await unlisten();
  await sql.notify("news", "hi");

  const { unsubscribe } = await sql.subscribe(
    "*:users",
    (row, info, _event) => {
      expect<Equal<typeof info, ReplicationEvent>>();
      void info.lsn;
      void info.time;
      if (info.command === "update") {
        void info.old;
      }
      if (info.command === "truncate") {
        void info.restartIdentity;
      }
    },
    () => {
      // Nothing to do once subscribed.
    },
    (error) => error.message
  );
  unsubscribe();

  const lo = await sql.largeObject();
  await lo.close();

  void sql.stats.waiting;
  void sql.options.max;
  void sql.parameters.TimeZone;

  await sql.close();
  await sql.end({ timeout: 5 });

  try {
    await sql`select`;
  } catch (error) {
    if (error instanceof postgres.PostgresError) {
      void error.code;
    }
  }
};

const pass = (db: Sql) => db`select 1`;
pass(postgres());

const named: string = postgres.toCamel("a_b");
postgres.fromCamel(named);

dc.subscribe("tracing:postgres:query:asyncEnd", (message) => {
  const x = message as QueryTrace;
  const ms: number | null = x.complete && x.complete - x.queued;
  x.command?.toLowerCase();
  void ms;
});
dc.subscribe(
  "postgres:pool",
  (message) => (message as PoolEvent).stats.waiting
);

void queries;
void transactions;
void rest;

const batched = async () => {
  const [a, b] = await sql.batch([
    sql<{ id: number }[]>`select 1 as id`,
    sql<{ name: string }[]>`select 'a' as name`,
  ]);
  a[0].id satisfies number;
  b[0].name satisfies string;
  const none: [] = await sql.batch([]);
  void none;
  await sql
    .batch([sql`select 1`])
    .catch(
      (error: postgres.PostgresError) =>
        error.index satisfies number | undefined
    );
};
void batched;

// TLS as libpq's sslmode, with the files it reads
postgres({
  ssl: "verify-ca",
  sslcert: "client.crt",
  sslkey: "client.key",
  sslpassword: "x",
  sslrootcert: "/etc/ssl/ca.pem",
});
postgres({ ssl: "verify-full", sslrootcert: "system" });
// @ts-expect-error not an sslmode
postgres({ ssl: "verify_full" });

// Advisory locks
const locks = async () => {
  const n: number = await sql.lock(918_273_645, async (locked) => {
    const [x] = await locked<{ n: number }[]>`select 1 as n`;
    return x.n;
  });
  await sql.lock(
    "migrations",
    () => {
      // Holding the lock is all this checks.
    },
    {
      signal: AbortSignal.timeout(1000),
      wait: false,
    }
  );
  await sql.lock(1n, () => "x");
  // @ts-expect-error a lock key is a number, a bigint or a string
  await sql.lock({}, () => 1);
  // @ts-expect-error the function comes second
  await sql.lock(1);
  return n;
};
void locks;
