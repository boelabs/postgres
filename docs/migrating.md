# Migrating from postgres

@boelabs/postgres started from [Postgres.js](https://github.com/porsager/postgres) (the `postgres` package) after its 4.0.0, so the API is the same. The [changelog](../CHANGELOG.md) lists every difference.

## From postgres 4

Change the import, and check the few behaviours that differ:

```diff
- import postgres from 'postgres'
+ import postgres from '@boelabs/postgres'
```

- **Errors without a stack**, such as Bun's `DNSException` for a failed lookup, reject the query. On postgres 4.0.0 they threw a `TypeError` inside the pool and the query never settled.
- **`sslmode` as in libpq.** `verify-ca` no longer checks the host name, `require` checks the certificate authority when `sslrootcert` names one, the `sslrootcert`, `sslcert` and `sslkey` files are read instead of being sent to the server (which refused the connection), `PGSSLMODE` is read, TLS is not asked for over a Unix socket, and an unknown mode throws. With `verify-full`, a server reached by its IP address is checked against that address; postgres checked it against `localhost`.
- **Everything in postgres 4.1.0** as it stood when this started: `query_timeout`, `cancel_timeout`, `sql.batch`, `eager_types` and the fixes listed in the changelog.
- **`application_name`** is `@boelabs/postgres` unless you set one.
- **New:** [`sql.lock`](transactions.md#advisory-locks).

Code that read `sslmode` from the url to set `ssl` itself, because of how postgres treated `verify-ca` or `sslrootcert`, can pass the url as it is.

## From postgres 3

The API is the same as postgres v3's, and most code runs unchanged. Check these, and the list above, before moving.

### Parameter types are decided by the server

v3 typed a `Date` as `timestamptz`, a boolean as `boolean`, a `Buffer` as `bytea`, a `bigint` as `int8` and arrays of these by their first element. @boelabs/postgres sends them without a type and the server decides from the query (see [Parameter types](queries.md#parameter-types)). `infer: true` keeps v3's behaviour:

```js
const sql = postgres({ infer: true })
```

Nothing changes for `timestamptz` columns, for values written to a column of their own type, for strings and numbers, or for anything with a cast. What does change:

**Dates and times outside UTC.** When the session's `TimeZone` or the Node.js process isn't UTC:

- A `Date` written to a `timestamp` column, or compared with one, is taken as UTC instead of the session's local time.
- A `Date` written to a `date` column, compared with one or cast with `::date`, takes the day in UTC instead of in the session's time zone, so near midnight it can be a day off.
- A `timestamp` column is read as UTC instead of the process's local time, so rows v3 wrote as local time are read back shifted by the UTC offset.

This query shows whether that concerns you:

```sql
select current_setting('TimeZone') as session_time_zone,
       table_schema, table_name, column_name, data_type
from information_schema.columns
where data_type in ('timestamp without time zone', 'date', 'time without time zone')
  and table_schema not in ('pg_catalog', 'information_schema')
```

If it returns no columns, or the time zone is `UTC` and so is your Node.js process (`TZ=UTC`, the default in most containers), nothing changes. Otherwise use `infer: true`, or move those columns to `timestamptz`, or cast the parameters (`${ date }::timestamptz`).

**Errors that need a cast.** A `Date` given where the query doesn't decide its type is now an error from the server, with the fix in the query:

| Query | Error | With a cast |
| ----- | ----- | ----------- |
| ``date_trunc('day', ${ date })``, `extract`, `to_char`, `to_json`, `jsonb_build_object` | `42725` function is not unique, or `42P18` / `42804` could not determine the type | `${ date }::timestamptz` |
| ``${ date } + interval '1 day'`` | `22007` invalid input syntax for type interval | `${ date }::timestamptz + interval '1 day'` |
| A `Date` written to a `time` column | `22007` invalid input syntax for type time | `${ date }::timestamptz::time` |
| ``${ 2n ** 60n } + 1`` | `22003` out of range for type integer | `${ n }::int8 + 1` |

**Values that come back as text.** A boolean, `Date`, `Buffer` or array that is only selected back, as in ``select ${ true } as x``, comes back as a string, since the server reads it as text; cast it to get the type back. A `Buffer` written to a `text` column is stored as its text instead of `\x` hex, a `Date` written to a `text` column as an ISO string ending in `Z`, and `${ 10n } + 1` gives the number `11` instead of the string `'11'`. A string such as `'yes'` or `'t'` for a `boolean` is now read by the server as `true`; v3 wrote any string for a `boolean` as `false`.

**One more round trip.** A query whose parameters are all dates, booleans, `bigint`s, `Buffer`s or arrays of these is described before its first run on each connection, as queries with strings and numbers already were.

### Everything else

- **Runtimes.** Node.js 24 or later, Bun 1.4 or later and Cloudflare Workers. It is an ES module; `require('@boelabs/postgres').default` works too.
- **`sql.array()` is removed.** Pass the array as it is, with a cast where the query doesn't decide its type: `${ ids }::int[]`.
- **Transactions are stricter.** A `COMMIT` the server answers with `ROLLBACK` rejects with `TRANSACTION_ROLLED_BACK`, a query on a transaction or reserved connection after it ended rejects, a query that can't be built inside a transaction aborts it, and a `begin` sent outside `sql.begin`, a reserved connection or `max: 1` rejects with `UNSAFE_TRANSACTION` and is rolled back.
- **Domains** are read and written as their base type, so a domain over `int[]` comes back as an array of numbers.
- **`infinity` timestamps** are `Infinity` and `-Infinity` instead of an invalid `Date`.
- **TypeScript.** The types are an ES module with a default export and named types: `import postgres, { type Sql } from '@boelabs/postgres'`.
