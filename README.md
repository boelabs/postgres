<div align="center">

# @boelabs/postgres

**PostgreSQL for Node.js, Bun and Cloudflare Workers. No dependencies.**

A fast, full-featured PostgreSQL client, built and maintained by [Boelabs](https://boelabs.com) from [Postgres.js](https://github.com/porsager/postgres).

[Documentation](https://github.com/boelabs/postgres/blob/main/docs/README.md) · [Getting started](https://github.com/boelabs/postgres/blob/main/docs/getting-started.md) · [Migrating from postgres](https://github.com/boelabs/postgres/blob/main/docs/migrating.md) · [Changelog](https://github.com/boelabs/postgres/blob/main/CHANGELOG.md)

[![npm](https://img.shields.io/npm/v/@boelabs/postgres)](https://www.npmjs.com/package/@boelabs/postgres) [![CI](https://github.com/boelabs/postgres/actions/workflows/ci.yml/badge.svg)](https://github.com/boelabs/postgres/actions/workflows/ci.yml)

</div>

---

Queries are tagged template literals: what you write is the SQL that runs, and every `${ value }` in it travels to the server as a parameter, never spliced into the text. Around that sits a pool that pipelines, prepares and schedules queries, and a connection layer that follows libpq wherever libpq defines the behaviour, from connection urls to `sslmode`.

We built it as the database client of our own products, and we run it in production on Node.js and Bun. The package is plain JavaScript with hand-written types: what is published is what the tests run.

## Why it

| Without | With @boelabs/postgres |
| --- | --- |
| SQL built from strings, and the injections that come with it | Tagged templates: every value is a parameter, identifiers and fragments have helpers |
| A slow report blocks the quick lookups queued behind it | A scheduler pipelines each query on the connection where it finishes soonest |
| A DNS hiccup or a silent server leaves queries hanging | Every query settles: timeouts, cancellation, and errors a runtime raises without a stack |
| `sslmode` parsed by hand in every project | libpq's `sslmode`, `sslrootcert`, client certificates and channel binding |
| Wrappers around `reserve()` to hold an advisory lock | `sql.lock()` holds it on a connection of its own and always lets it go |
| A driver per runtime | One package for Node.js, Bun and Cloudflare Workers, tested on each |

## Capabilities

- **Queries** — parameters typed by the server, dynamic inserts, updates and `where in`, composable fragments, `sql.batch` in one round trip, queries from files.
- **Transactions** — `sql.begin` with savepoints and nested transactions, `sql.rollback`, prepared transactions, reserved connections and advisory locks.
- **Streaming** — cursors, async iteration, `COPY` to and from Node.js streams, cancellation with `AbortSignal`.
- **Realtime** — `LISTEN`/`NOTIFY` that survives reconnects, and inserts, updates and deletes through logical replication with persistent slots.
- **Connections** — `min`/`max` pool with scheduling, `query_timeout` and `queue_timeout`, multiple hosts with `target_session_attrs`, PgBouncer and Hyperdrive, `.pgpass` and rotating credentials.
- **Security** — TLS as libpq's `sslmode`, SCRAM-SHA-256 with channel binding, direct TLS on PostgreSQL 17+.
- **Observability** — diagnostics channels for queries, connections, transactions and the pool, ready for OpenTelemetry, at no cost while nobody listens.
- **Types** — custom types by name (pgvector and friends), `bigint`, transforms such as camelCase, and TypeScript types included.

## Quickstart

Requirements: Node.js 24+, Bun 1.4+ or Cloudflare Workers, and PostgreSQL.

```bash
npm install @boelabs/postgres
```

```js
// db.js
import postgres from "@boelabs/postgres";

// The url, or the libpq environment variables (PGHOST, PGUSER, ...) when there is none
const sql = postgres(process.env.DATABASE_URL);

export default sql;
```

```js
import sql from "./db.js";

const users = await sql`
  select name, age
  from users
  where age > ${age}
`;

await sql`insert into users ${sql({ name: "Murray", age: 68 })}`;

await sql.begin(async (sql) => {
  const [user] =
    await sql`insert into users (name) values ('Walter') returning id`;
  await sql`insert into accounts (user_id) values (${user.id})`;
});

await sql.lock("migrations", () => migrate());
```

From here, [Getting started](https://github.com/boelabs/postgres/blob/main/docs/getting-started.md) walks through the `sql` instance, and [Connection](https://github.com/boelabs/postgres/blob/main/docs/connection.md) lists every option.

## Documentation

Everything beyond this page lives in [`docs/`](https://github.com/boelabs/postgres/blob/main/docs/README.md): [queries](https://github.com/boelabs/postgres/blob/main/docs/queries.md), [transactions](https://github.com/boelabs/postgres/blob/main/docs/transactions.md), [TLS](https://github.com/boelabs/postgres/blob/main/docs/tls.md), [runtimes](https://github.com/boelabs/postgres/blob/main/docs/runtimes.md), [tracing](https://github.com/boelabs/postgres/blob/main/docs/tracing.md), [errors](https://github.com/boelabs/postgres/blob/main/docs/errors.md) and the rest.

Coming from `postgres` (Postgres.js)? The API is the same: [Migrating from postgres](https://github.com/boelabs/postgres/blob/main/docs/migrating.md) lists what differs, which from v4 is mostly the import.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the tests (`pnpm run test:docker` runs everything on any OS) and the checks CI runs. Coding agents start with [AGENTS.md](AGENTS.md). Pull requests are opened by the maintainers; everyone else is welcome through issues.

Report vulnerabilities through [SECURITY.md](SECURITY.md), never in a public issue.

## License

[MIT](LICENSE) · © Boelabs
