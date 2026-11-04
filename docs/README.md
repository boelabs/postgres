# Documentation

The reference for @boelabs/postgres. New to it? Start with [Getting started](getting-started.md).

## Guides

| | |
| --- | --- |
| [Getting started](getting-started.md) | The `sql` instance, a first query, a first insert |
| [Queries](queries.md) | Parameters and their types, dynamic inserts, updates and `where in`, fragments and identifiers |
| [Advanced query methods](advanced-queries.md) | Cursors, iteration, `COPY` streams, cancelling, `simple`, `unsafe` and queries in files |
| [Transactions](transactions.md) | `sql.begin`, savepoints, `sql.batch`, reserved connections and advisory locks |
| [Types and data](types.md) | Custom types, numbers and `bigint`, transforms, the result array |
| [Listen, notify and subscribe](realtime.md) | `LISTEN`/`NOTIFY` and realtime changes through logical replication |

## Running it

| | |
| --- | --- |
| [Connection](connection.md) | Every option, environment variables, the pool, timeouts, multiple hosts, poolers, shutdown |
| [TLS](tls.md) | `sslmode` as in libpq, client certificates, direct TLS and channel binding |
| [Runtimes](runtimes.md) | Node.js, Bun, CommonJS and Cloudflare Workers with Hyperdrive |
| [Tracing](tracing.md) | Diagnostics channels, OpenTelemetry and metrics |
| [Error handling](errors.md) | Server and connection errors, and every error code |
| [TypeScript](typescript.md) | Typed results, helpers and the types to accept a pool, a transaction or a reserved connection |

## Moving

- [Migrating from postgres](migrating.md): from `postgres` (Postgres.js) 4 and 3.
- [Changelog](../CHANGELOG.md)

## Schema migrations

Migrations are out of scope for a client. These tools run them on top of it:

- https://github.com/porsager/postgres-shift
- https://github.com/lukeed/ley
- https://github.com/JAForbes/pgmg

Or keep your own SQL files and run them under [`sql.lock`](transactions.md#advisory-locks), so that only one process migrates at a time.
