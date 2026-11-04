# Changelog

## 1.0.0

The first release of @boelabs/postgres. It starts from [Postgres.js](https://github.com/porsager/postgres) after its 4.0.0, with the work its 4.1.0 had then, and keeps its API. Coming from `postgres`, read [Migrating from postgres](./docs/migrating.md).

### Changed from postgres 4

#### Fixed

- **A connection error without a stack rejects the query instead of hanging it.** Under Bun a failed DNS lookup is a `DNSException` whose `stack` is undefined, and a failed TLS verification goes the same way. Giving such an error the caller's stack threw a `TypeError` inside the pool, so the query never settled, as on every database restart where the host name briefly doesn't resolve. Building a query's error can no longer throw, whatever the runtime hands over: an error without a stack, a frozen one or one that can't be extended.
- **`verify-full` checks a server reached by its IP address against that address.** When TLS was started on the open connection, Node.js was not told the host, and checked the certificate against `localhost`: a certificate for `localhost` passed and one for the address failed.
- **`sslmode=verify-ca` checks the certificate authority but not the host name**, as in libpq; it checked both.
- **`sslrootcert`, `sslcert` and `sslkey` in a url are read as files** instead of being sent to the server as run-time parameters, which made it refuse the connection. So are libpq's other client parameters, such as `keepalives` or `sslsni`, which are no longer sent.
- **Error stacks on Bun under Windows** leave out the library's own frames, which were recognised only by `/` paths.

#### New

- **`sql.lock(key, fn, { wait, signal })`** runs `fn` while holding a session advisory lock on a connection kept for it, and lets the lock go when `fn` settles. A string key is hashed by the server; `wait: false` rejects with `LOCK_NOT_AVAILABLE` instead of waiting.
- **libpq's `sslmode` in full**: `sslrootcert` (a file, or `system`), `sslcert`, `sslkey` and `sslpassword` as options and url parameters, `PGSSLMODE`, `PGSSLROOTCERT`, `PGSSLCERT` and `PGSSLKEY`. `require` checks the certificate authority when `sslrootcert` names one. TLS is not asked for over a Unix socket. An unknown mode throws.

#### Changed

- Node.js 24 or later, Bun 1.4 or later, and Cloudflare Workers.
- `application_name` is `@boelabs/postgres` unless one is set.
- MIT license.

### From postgres 4.1.0, unreleased

#### New

- **`query_timeout`**. Seconds a query may take, waiting for a connection and running together, before it is canceled and rejects with `QUERY_TIMEOUT`. Off by default. Unlike `statement_timeout` it also ends a query whose server or network has gone silent, which TCP alone takes many minutes to notice. Transaction control queries and `forEach` are limited too; cursors, streams and `sql.listen` are not.
- **`cancel_timeout`**, 5 seconds by default: how long a canceled query may take to end before its connection is closed.
- **`sql.batch([queries])`** sends queries in one round trip with a single Sync: outside a transaction they commit or roll back together, and the batch rejects with the failing query's position in `error.index`.
- **`json` on a transform**. The built-in transforms rename the keys of JSON values in results but send JSON values as they are. `json: false` leaves JSON values as they are both ways, and `json: true` renames their keys when sending too, with the transform's `column.to`. Without it nothing changes.
- **`eager_types`**: `true` reads array types and domains when the pool starts instead of when a query first meets one.

#### Fixed

- **`sql.listen` keeps reconnecting when its first reconnect fails**. After the listen connection closed, it was reopened once, and if that attempt failed, as it does while a restarting server still refuses connections, nothing tried again, so `onlisten` was never called and notifications were lost. A failed reconnect is now retried after `backoff`, until it succeeds, the channel is unlistened or the pool ends.
- **A canceled query whose server never answers no longer waits forever.** `.cancel()`, `.signal()` and now `query_timeout` send a cancel request and waited for the server to end the query, so a server or network gone silent left both the query and the promise `.cancel()` returns pending until TCP gave up. This applies to every cancel, also without `query_timeout`: when the server doesn't answer within `cancel_timeout`, the connection is closed and the pool connects again. Whether the queries on it ran is unknown, so they reject with `CONNECTION_DESTROYED` (a timed out one with `QUERY_TIMEOUT`) whose `cause` is `CANCEL_UNANSWERED`, not with `57014`. The cancel request's own connection is limited by `cancel_timeout` too, and a cancel is no longer sent for a query whose result has already arrived, where it could only hit the query after it. A cancel request whose own connection fails, as over TLS to a server gone silent, no longer crashes the process with an unhandled rejection. A query that times out while it waits behind another one on its connection is canceled only after it has had its own `query_timeout` once its turn comes, instead of the moment its turn comes, when it had usually finished and the cancel stopped the next query; if the server sends nothing for `cancel_timeout` while it waits, the connection is closed. A query waiting for types to be read rejects with `QUERY_TIMEOUT` without closing its connection, and the read of array types and domains is limited by `query_timeout` too.
- **A transaction the server ends rejects with the server's error**. When a `transaction_timeout` (`25P04`), an `idle_in_transaction_session_timeout` (`25P03`) or `pg_terminate_backend` (`57P01`) ended the session, `sql.begin` rejected with `CONNECTION_CLOSED`, so a timeout or a termination looked the same as a network drop; it now rejects with the FATAL error the server sent before closing, as a query in flight already did, and a later query on that connection rejects with `CONNECTION_CLOSED` that has it as `cause`. A server restart or failover ends sessions with `57P01`, so code that retries a transaction on `CONNECTION_CLOSED` should retry on that code too. A FATAL in answer to `COMMIT` rejects with `CONNECTION_CLOSED` that has it as `cause`, as the outcome is unknown, as it is when the connection is lost during `COMMIT`.
- **A savepoint or nested `begin` rejects when its transaction's connection is lost**. One whose callback was still running when the connection went resolved with the callback's result after the transaction had already rejected; it now rejects with the transaction's error.
- **A connection closed while the pool reads its array and domain types counts as a failed connection attempt**. Reconnecting follows `backoff` and waiting queries reject once `connect_timeout` has passed, instead of reconnecting as fast as the server accepts for as long as it keeps closing. With `connect_timeout` set to 0, null or false the pool now keeps trying for as long as it takes, as the option says, also after a refused or closed startup, which used to reject the waiting queries at once.
- A query failed by a `FATAL` error gives that error to the queries pipelined behind it as well, instead of `CONNECTION_CLOSED`.
- **A FATAL error with the severity only in the `S` field is recognised as one.** The non-localized `V` field is optional in the protocol: PostgreSQL sends it since 9.6, and a pooler that builds its own errors, such as PgBouncer, may send only the localized `S`. Such an error was not seen as FATAL, so the query, a `sql.begin` and the queries pipelined behind it rejected with `CONNECTION_CLOSED` without a `cause` instead of with the error. `error.severity` now falls back to `severity_local` when `V` is missing.
- **Each query on a connection that closes gets its own error.** They shared one error object, so every query pipelined on the connection reported the first one's `query` and `parameters`.
- **A cached prepared statement no longer keeps the query that prepared it**. Each connection's entry for a prepared statement kept that query's values and rows for as long as the statement stayed cached, up to 1,000 statements per connection, so an app with many distinct statements grew by their results until every cache was full: about 1.1 GB with 10 connections and 50-row results. They are let go once the query settles. On postgres 4.0.0, `prepare: false` avoids it.

#### Performance

- **An `ssl` object with a `ca` builds its TLS context once**. The connections made with it share one context instead of each parsing the whole `ca` list again, so with a provider's CA bundle a new connection takes about half the time and CPU, and a burst of them no longer blocks the event loop. Replacing one of the object's values, as with a renewed `cert`, builds a new context for the connections after it.
- A new statement whose untyped values are all numbers or `null` is prepared, described and run in one round trip, as one whose parameter types are all known is, since those values are written the same for any type the server picks; one with other values only the server can type is still described first, once per connection.
- Array types and domains are read when a query first meets a type the pool does not know (an oid from 16384 up), instead of when the pool starts: a pool that only uses built-in types never sends that query, and a new pool's first query costs no more than any other. The connection that met the type waits for it, read on another connection. With custom types given by name they are still read at startup, as their oids are needed before the first query. Leases and values typed as a type the pool hasn't read yet still wait for it. A read whose connection fails is retried after `backoff`, and once `connect_timeout` has passed the connections waiting for it are closed and their queries reject, as for a failed startup. `eager_types: true` reads them when the pool starts, as before.
- `timestamptz`, and `timestamp` and `date` read as UTC, are decoded straight from the bytes when they use the built-in parsers, with the text parser for anything else (BC, `infinity`, years before 1000); about 20% more rows per second for rows with timestamps.
- `bytea` and arrays of `int2`, `int4`, `int8` and `bool` are fetched in binary once a prepared statement's columns are known on the connection, when they use the built-in parsers: the values are the same as from the text, about 4.5 times faster to read for `bytea` and 3 times for an `int4[]`. A custom parser for the type or its elements, and `raw()`, still get the text.
- A connection that becomes ready while others are still opening no longer takes the queries meant for those; 50 connections opened at once each run one of 50 queries.

### From postgres 4.0.0

v4 rewrites everything below the public API: the pool, the connection, the protocol, startup and the socket layer. Queries, helpers, transactions, cursors, COPY, listen, subscribe, large objects and the options work as in 3.4.9, apart from the changes below.

#### Security

- **A NUL character in a connection parameter can no longer add parameters**. A `database`, `user` or `connection` value such as `'db\0user\0postgres'` was sent as further startup parameters, so an app that put untrusted input there, as with a database per tenant, could be made to log in as another user where that user needs no password, or with `replication` or `options` set. A NUL in any protocol string, also in query text and identifiers, now rejects with `NUL_CHARACTER`.
- **A column named `__proto__` is an own property**. It became the prototype of the row, so a JSON value in it, for instance from a column alias built from user input, made the row inherit its properties (`row.isAdmin`), in query results and in `sql.subscribe` rows alike.

#### Upgrading from v3

The docs have a [migration guide](./docs/migrating.md), with a query that shows whether the change in parameter types concerns you.

- **The server decides the type of every parameter (`infer: false` by default)**. v3 typed a `Date` as `timestamptz`, a boolean, a `Buffer`, a `bigint` and arrays of these from JavaScript; v4 sends them without a type and writes each value for the type the server asks for, as libpq does. `timestamptz` columns, values written to a column of their own type, strings, numbers and anything cast work as before. Outside UTC, a `Date` written to or compared with a `timestamp` or `date` column is taken as UTC instead of the session's local time, and a `timestamp` is read as UTC, so it comes back as the instant that was written whatever the time zone. A `Date` where the query doesn't decide its type, such as in `date_trunc('day', ${ date })`, needs a cast (`${ date }::timestamptz`). `infer: true` keeps v3's behaviour.
- **Runtimes.** Node.js 20 or later, Bun, and Cloudflare Workers; Deno through its Node.js compatibility. The CommonJS and Deno builds are gone: Postgres.js is an ES module, which `require` can load on Node.js 20.19 and 22.12 and later (`require('postgres').default`).
- **`sql.array()` is removed.** Pass the array as it is, with a cast where the query doesn't decide its type: `${ ids }::int[]`. Calling `sql.array()` throws `ARRAY_REMOVED`.
- **A transaction the server rolled back rejects.** When the server answers COMMIT with ROLLBACK, `sql.begin` rejects with `TRANSACTION_ROLLED_BACK`; v3 took it as a commit.
- **A released connection stays released.** A query on a reserved `sql` after `release()`, or on a transaction's `sql` after it has committed or rolled back, rejects; v3 ran it on whatever connection it then had. Releasing a reserved connection while its own `BEGIN` is still open closes it instead of returning an open transaction to the pool.
- **An unsafe `begin`** outside `sql.begin`, a reserved connection or `max: 1` rejects with `UNSAFE_TRANSACTION` and is rolled back. A query that looks like it may open a transaction runs alone on its connection, so nothing else lands in it, and any query that leaves its connection in a transaction is rolled back and rejected. v3 rejected `BEGIN` but left the transaction open. A script that opens and closes its own transaction in one query, such as a migration file with `BEGIN` and `COMMIT`, runs; v3 ran it and still rejected it.
- **A query that cannot be built or serialized inside a transaction aborts the transaction**, in `sql.begin` or one opened by hand on a reserved connection, just as a server error would: the queries after it fail with `25P02` and a later `COMMIT` answers `ROLLBACK`. v3 skipped the query and let the rest commit.
- **Domains** that exist when the pool starts are read and written as their base type, so a domain over `int[]` comes back as an array of numbers; v3 returned the text.
- **A connection refused for too many connections (`53300`) is retried** with `backoff` until `connect_timeout` has passed, and the waiting queries reject with that error only then. Such a refusal is often momentary: connections opened at the same time against a connection limit can all be refused while the server counts them. v3 rejected the queries of the refused connection at once.
- **No host matching `target_session_attrs`** rejects with `CONNECTION_DESTROYED` instead of retrying forever.
- **An unknown authentication type rejects** with `AUTH_TYPE_NOT_IMPLEMENTED` instead of waiting for the connect timeout.
- **A replication error with no `onerror` is logged.** When the `sql.subscribe` stream fails and none of its subscriptions has an `onerror`, the error goes to `console.error` before the stream reconnects; v3 dropped it. Pass `onerror` to handle or silence it.
- **`infinity` timestamps** are `Infinity` and `-Infinity`, both ways, instead of an invalid `Date`.
- **TypeScript:** the types are an ES module with a default export and named types (`import postgres, { type Sql } from 'postgres'`). A reserved connection is no longer typed as having `begin` and `end`, which it never had.

#### New

- **Scheduling across connections:** when every connection is busy, a query is pipelined on the connection where it should be done soonest, from how long each statement took before and how long what is in flight has run, and slow queries are kept together once the rest of the pool is needed for quick ones. In simulations of mixed workloads, the p99 of quick queries fell 2 to 100 times; on PostgreSQL, a 1 ms lookup no longer waits behind a report on a busy pool (p99.9 from 792 ms to 5 ms). `scheduler: false` pipelines on the busy connection with the fewest queries in flight instead; v3 went round-robin over the busy connections. With `max: 1` it is off, as there is only one connection.
- **`queue_timeout`:** seconds a query, transaction or reserve may wait for a connection before it rejects with `QUEUE_TIMEOUT`, unsent.
- **`.signal(abortSignal)`** on a query: aborting rejects it if it is still waiting, or cancels it if it is running.
- **Canceling a cursor between batches stops it.** `.cancel()` or an aborted `.signal()` while the cursor's callback runs, or while an async iterator over it is between batches, fetches no more rows, closes the portal and rejects with `57014`. v3 sent a cancel request that the idle server ignored, so the cursor ran on to the end (or, arriving late, could cancel the next query).
- **``sql` and `.join(items)``** joins fragments and values with a fragment as separator, leaving out falsy items and adding spaces where missing.
- **Nested `sql.begin`** inside a transaction runs in a savepoint.
- **`sql.rollback()`** rolls back a transaction, or the savepoint it is called in, without throwing; `sql.begin` resolves with the callback's result.
- **Pipelining anywhere in a transaction** is documented and tested: queries in a `Promise.all` between awaited ones are sent together and run in the order they were made.
- **Custom types by name:** `to` and `from` can be type names, looked up when the pool starts, with array types, for extension types such as pgvector.
- **`using` and `await using`:** `sql` ends the pool and a reserved connection is released when it goes out of scope.
- **`unref_sockets: true`** lets the process exit while connections are idle, like `allowExitOnIdle` in node-postgres.
- **`min`:** connections kept open once the pool is used; `idle_timeout` closes only those above it.
- **`user` as a function**, called each time a connection opens, like `password`, for credentials that rotate.
- **Password file:** with no password given, `PGPASSFILE` or `~/.pgpass` is read as libpq reads it.
- **Named arguments:** an object in the parentheses of a function call becomes `name => value` arguments, `make_interval(${ sql({ days: 1 }) })`.
- **Errors** are documented with their fields and how to tell them apart.
- **COPY row count:** a `copy ... from stdin` writable has `count` and `command` once it has finished, with the number of rows the server copied.
- **Persistent replication slots:** `slot: 'name'` keeps the slot of `sql.subscribe` across restarts and streams from where it was last confirmed. A transaction is confirmed only once its handlers have finished, a handler that fails gets its transaction delivered again, and handlers may be async: they run one after the other in commit order while the stream waits.
- **More from `sql.subscribe`:** `truncate` events, and the `lsn`, `time` and `xid` of the transaction on every change. Reconnecting retries with backoff.
- **Channel binding:** over TLS, SCRAM authenticates with SCRAM-SHA-256-PLUS (`tls-server-end-point`) when the server offers it, binding the login to the server certificate. `channel_binding` is `'prefer'` by default, `'require'` or `'disable'` as in libpq, also from the url or `PGCHANNELBINDING`; `'require'` rejects an unbound connection with `CHANNEL_BINDING_REQUIRED`.
- **Direct TLS on Node.js** with `sslnegotiation: 'direct'` (PostgreSQL 17+) is opened as TLS from the first byte and is the fastest encrypted connection.
- **Cloudflare Workers** through the `workerd` export condition, on `cloudflare:sockets`, with TLS by `startTls`.
- **`query.text` and `query.parameters`** show the text and values a query will be sent with, before it is sent.
- **`sql.stats`**: connections, opening, idle, leased and waiting, right now.
- **Tracing channels:** `postgres:query`, `postgres:connect` and `postgres:transaction` as diagnostics tracing channels, and `postgres:pool` and `postgres:notice` as plain channels, for OpenTelemetry and other tracers without an option or a wrapper. Nothing is published, and nothing costs, without a subscriber. See [Tracing](./docs/tracing.md).
- **Prepared statements are prepared again when a column changes type.** A query that the statement's parameter types no longer fit fails before it runs; it is now run once more with a fresh description and the statement prepared again, outside a transaction or reserved connection. On a pool of more than one connection that holds also while other queries are in flight; with `max: 1` only for a query that is alone on the connection, so queries keep their order. v3 kept failing until the connection was replaced. Each connection reads rows and writes values only by what its own server described for the statement. When one connection sees a statement describe differently, the others prepare it again before their next use instead of trusting what they learned before.
- **`sql.close()`** closes the connections once their queries are done and leaves the pool usable.
- **Named cursors:** in a transaction or on a reserved connection every cursor has a portal of its own, so several can be open at once.
- **Stack traces** of query errors lead to the line that made the query. Only the text of that line is kept, once per place in the code, so the function that made the query is not kept alive with it.
- **`options.socket`** is also called with the host and port, and a socket can say it has done TLS itself (`negotiated: true`).
- **`onread: false`** reads through the socket stream instead of a shared buffer, should a runtime ever misbehave with it.

#### Fixed

The open issues and pull requests were triaged into 33 correctness bugs, each with a regression test in the v4 suite. Among them:

- **One query on a cold pool opens one connection**, not one more for each connection that opens while the first loads types.
- **Errors:** the server's data type field is `data_type_name`; v3 set it as `'data type_name'`, with a space, and typed it as `type_name`. `JSON.stringify` of a `PostgresError` includes its message.
- **Cursors:** the callback of the last batch is awaited before the cursor resolves, and a rejection from it rejects the cursor; v3 resolved without waiting and left the rejection unhandled. A callback that throws synchronously on a cursor in a transaction or on a reserved connection rejects the cursor and leaves the connection as it was; v3 gave the next query a malformed result.
- **Large objects:** `readable({ start, end })` stops at `end`; v3 ignored it and read to the end of the object.
- **Bun:** error stacks point at the calling line, as on Node; library frames were recognised only as `file://` urls.
- **Cloudflare Workers:** a TLS handshake that Workers cannot complete, most often a certificate not signed by a public CA, rejects with `TLS_HANDSHAKE_FAILED` instead of `CONNECTION_CLOSED` or `CONNECT_TIMEOUT`, and `perf_hooks` is no longer imported. Writes are split into 16 KiB pieces, as Workers were reported to drop a plain connection on a larger write.
- **A statement name the server already has**, which a pooler that moves connections between clients can cause, is prepared again under a new name instead of failing with `42P05`.
- **TypeScript:** `ISql` is exported for functions that take the pool, a transaction or a reserved connection; `PostgresError` is exported by name as a value as well as a type; nested arrays with `null` and other values in helpers; a typed query with a helper inside; column lists that are `string[]`, while unknown literal columns are still caught; class instances and `object` as JSON; `null` and `false` for the timer options.
- **Helpers follow the clause they are in**, not the last keyword anywhere before them: `update t as x set ${ sql(o) }`, `insert into t as x ${ sql(o) }`, `grant update on ${ sql(tables) }`, rows in `in (${ sql(rows) })`, a column list for `insert into t ${ sql(columns) } select ...`, objects in a `values` helper with picked columns, also inside a fragment, and fragments among the columns of `select ${ sql([...]) }`. An insert or update helper without columns throws `NO_COLUMNS` instead of sending invalid SQL. Several names outside a clause, `order by ${ sql('a', 'b') }`, become a list of identifiers; v3 threw a `TypeError`.
- **An array or a plain object written as text**, such as in a `values` list cast afterwards, is written as an array literal or as JSON instead of `1,2` or `[object Object]`.
- **Connection urls:** bracketed IPv6 hosts, percent-encoded socket directories as hosts, `?host=` and `?port=` as libpq reads them, and passwords with characters that are not percent-encoded, which are used as written.
- Answers can no longer reach the wrong query: after a cancel, a query that could not be built or serialized, or an error in the middle of a result, every query still gets its own answer. (A cancel that reaches the server just as its query finishes can still stop the next query on that connection; that is the protocol.)
- A transaction whose connection is lost rejects, and nothing it queued reaches the connection's next user.
- A cursor started in `sql.begin` and not awaited finishes before the transaction commits.
- Queries and transactions start in the order they were made: with `max: 1`, a query made before `sql.begin` runs before the transaction.
- While connections keep failing, queries and transactions reject at once with the connection error, each with its own error object, instead of waiting for the next attempt.
- A failed connection attempt only rejects the waiting queries when no other attempt is under way and no connection can still serve them, so a connection that is still loading types is waited for.
- A reserved connection released while its own queries are still in flight goes back to the pool only once they are answered and it is outside a transaction; otherwise it is closed.
- `connect_timeout` destroys a TCP connection that is still being opened, so the process can exit.
- A server that is ready before it has accepted the authentication is rejected with `AUTHENTICATION_INCOMPLETE`, so SCRAM cannot be skipped.
- An `onnotice` that throws during startup no longer fails the connection.
- `sql.subscribe` parses custom array types and domains like queries do.
- A custom serializer that returns something other than a string or a `Buffer` rejects its query, also in a cursor, instead of hanging the connection.
- A cursor on the pool or a reserved connection whose callback throws on the last batch, or whose column parser throws, rejects and frees its connection instead of hanging it.
- After `DEALLOCATE ALL`, a statement prepared again is not forgotten because of an older query's error.
- The same query text in schemas of different shape (a `search_path` per tenant, say) gets the rows of its own schema on every connection.
- `debug` gets the values as they are sent and the parameter types, also on the first use of a statement.
- The types of `sql.listen()` (`{ state, unlisten }`) and `sql.prepare()` (returns the name) match what they return.
- `notify` inside a transaction uses the transaction.
- `null` in arrays, `Infinity`, years below 100 and offsets in seconds.
- `PostgresError` from a plain message and writable stacks.
- Keywords next to helpers and fragments.
- `end()` stops connection attempts under way and settles every query; a reserved connection is never stranded.
- Array and domain types are fetched once per pool, on its first connection; if that query fails with a server error the pool carries on without them instead of asking again for every query.
- COPY under back-pressure no longer stalls, and COPY TO STDOUT to a slow consumer is no slower with the shared read buffer than without it.

#### Performance

- A statement whose parameter types are all known is prepared, described and run in one round trip; one with parameters only the server can type is described first, once per connection, as in v3.
- `int2`, `int4`, `oid` and `bool` columns are decoded straight from the bytes when they use the built-in parsers; a custom parser still gets the text.
- A query on its way to a free connection goes straight to it, without the waiting queue.
- Queries hold no more per-query state than they need, so almost nothing outlives a scavenge.
- One growing buffer per connection, encoded in place and written once at the end of the tick.
- Plain and direct TLS connections read into one buffer per connection (`onread`) instead of a buffer per chunk, on Node, Bun and Deno.
- Rows, column descriptions and command tags are decoded by hand.
- Once a result shape has delivered 16 rows, its rows are read by a function compiled for that shape, which builds each row as one object literal with every column already in place (about half the CPU per row at 20 columns, about 12% less at 5). Where code generation is not allowed, rows are built as before.

#### Testing

- Unit tests for the protocol, types, query building and errors (`node tests/unit`).
- A simulation that runs the real client against a fake server on a fake clock, with faults, checking that every query settles with its own answer (`node tests/simulate.js`).
- The integration suite in one file per area; CI runs it on PostgreSQL 14 to 18 and Node.js 20, 22 and 24.
- A test worker for Cloudflare Workers (`sh tests/cf/run.sh`) and a TypeScript test for the types (`cd types && npm test`).
- CI runs the unit, integration and simulation tests on Bun and Deno as well as Node.
- `npm run coverage` (`node tests/coverage.js`, `--lines` for the lines not run) runs the tests with Node's own V8 coverage and reports it per file in `src`, with no dependency; CI fails below `COVERAGE_MIN`.
