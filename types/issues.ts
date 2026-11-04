// oxlint-disable-next-line max-classes-per-file -- the helper is checked with an instance of one class that holds another
import postgres, { PostgresError } from "./index.js";
import type { ISql, ReservedSql } from "./index.js";

const sql = postgres({
  connect_timeout: 0,
  idle_timeout: null,
  max_lifetime: null,
  sslnegotiation: "postgres",
});

const i1163 = async (db: ISql = sql) => await db`select 1`;
await sql.begin((tx) => i1163(tx));

await sql.begin(async (tx) => {
  await tx`insert into ${tx("t")} values (${1})`;
  await tx`select ${tx(["a", "b"])} from t`;
});

const i713 = (r: ReservedSql) => {
  // @ts-expect-error a reserved connection has no begin
  void r.begin;
  // @ts-expect-error a reserved connection has no end
  void r.end;
  r.release();
};
void i713;

const e703 = new PostgresError("message");
e703.message satisfies string;
new PostgresError({ code: "23505", message: "x" }).code satisfies string;
try {
  await sql`select 1`;
} catch (error) {
  if (error instanceof PostgresError) {
    error.code satisfies string;
  }
}

await sql`select * from (values ${sql([[1, 2, null, 4]])}) as v(a, b, c, d)`;

const users = [
  { age: 68, garbage: "ignore", name: "Murray" },
  { age: 80, garbage: "x", name: "Walter" },
];
const [inserted] = await sql<
  { id: number }[]
>`insert into users ${sql(users, "name", "age")} returning id`;
inserted.id satisfies number;

interface UpdateCourse {
  name?: string;
  price?: number;
}
const i916 = (course: UpdateCourse, keys: string[]) =>
  sql`update courses set ${sql(course, keys)} where id = 1`;
void i916;

const i625 = (contact: object, owner: string) =>
  sql`insert into account (owner, contact) values (${owner}, ${sql.json(contact as postgres.JSONValue)})`;
void i625;

class Inner {
  aProp = 5;
}
class Outer {
  inner = new Inner();
}
await sql`insert into t ${sql(new Outer())}`;

const one = async <T extends object>(
  strings: TemplateStringsArray,
  ...values: postgres.ParameterOrFragment<never>[]
): Promise<T | null> => {
  const [row] = await sql<T[]>(strings, ...values);
  return row ?? null;
};
const u = await one<{ id: number }>`select 1 as id`;
u satisfies { id: number } | null;

const user = { age: 68, name: "Murray" };
// @ts-expect-error a column that is not a key of the object is still caught
await sql`insert into users ${sql(user, "nme")}`;
// @ts-expect-error a column that is not a key of the objects is still caught
await sql`insert into users ${sql([user], "nme")}`;
await sql`insert into users ${sql(user, "name", "age")}`;

const rotating = postgres({
  min: 2,
  unref_sockets: true,
  user: () => Promise.resolve("u"),
});
rotating.options.min satisfies number;
await rotating`select make_interval(${rotating({ days: 1 })})`;
const disposable = async () => {
  const reserved = await rotating.reserve();
  reserved[Symbol.dispose]();
  await rotating[Symbol.asyncDispose]();
};
void disposable;

const named = postgres({
  queue_timeout: 5,
  types: {
    vector: {
      from: ["vector"],
      parse: (x: string) => JSON.parse(x) as number[],
      serialize: (x: number[]) => `[${x}]`,
      to: "vector",
    },
  },
});
const where = named` and `.join([
  named`a = ${1}`,
  users.length > 1 && named`b = 2`,
]);
where.length satisfies number;
await named`select * from t ${where.length ? named`where ${where}` : named``}`.signal(
  AbortSignal.timeout(1000)
);
await named.begin((tx) =>
  tx.begin((inner) => inner`select ${named.typed.vector([1, 2])}`)
);
