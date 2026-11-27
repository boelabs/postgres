# Connection

## `postgres([url], [options])`

You can use either a `postgres://` url connection string or the options to define your database connection properties. Options in the object will override any present in the url. Options will fall back to the same environment variables as psql.

```js
const sql = postgres('postgres://username:password@host:port/database', {
  host                 : '',            // Postgres ip address[s] or domain name[s]
  port                 : 5432,          // Postgres server port[s]
  database             : '',            // Name of database to connect to
  username             : '',            // Username of database user
  password             : '',            // Password of database user
  ...and more
})
```

More options can be found in the [Connection details section](#all-postgres-options).

## All Postgres options

```js
const sql = postgres('postgres://username:password@host:port/database', {
  host                 : '',            // Postgres ip address[es] or domain name[s]
  port                 : 5432,          // Postgres server port[s]
  path                 : '',            // unix socket path (usually '/tmp')
  database             : '',            // Name of database to connect to
  username             : '',            // Username of database user, or a function returning it
  password             : '',            // Password of database user, or a function returning it
  ssl                  : false,         // an sslmode: prefer, require, verify-ca, verify-full; or tls.connect options
  sslrootcert          : null,          // file of trusted certificate authorities, or 'system'
  sslcert              : null,          // file of the client certificate
  sslkey               : null,          // file of the client certificate's key
  sslpassword          : null,          // passphrase of sslkey
  sslnegotiation       : null,          // 'direct' for TLS from the first byte (PostgreSQL 17+)
  channel_binding      : 'prefer',      // SCRAM-SHA-256-PLUS over TLS: 'disable', 'prefer' or 'require'
  max                  : 10,            // Max number of connections
  min                  : 0,             // Connections kept open once the pool is used
  max_pipeline         : 100,           // Max number of queries pipelined on one connection
  scheduler            : true,          // Pipeline where a query should be done soonest (more info below)
  max_lifetime         : null,          // Max lifetime in seconds (more info below)
  idle_timeout         : 0,             // Idle connection timeout in seconds
  connect_timeout      : 30,            // Connect timeout in seconds
  queue_timeout        : 0,             // Seconds a query may wait for a connection, 0 for no limit
  query_timeout        : 0,             // Seconds a query may wait and run, 0 for no limit
  cancel_timeout       : 5,             // Seconds to wait for a canceled query before closing its connection
  keep_alive           : 60,            // TCP keep-alive in seconds, 0 or null for none
  backoff              : fn,            // Seconds to wait before reconnecting, given the attempt
  prepare              : true,          // Automatic creation of prepared statements
  infer                : false,         // true types parameters from JS values, as postgres v3 did
  types                : [],            // Array of custom types, see more below
  onnotice             : fn,            // Default console.log, set false to silence NOTICE
  onnotify             : fn,            // (channel, payload, pid) for every notification
  onparameter          : fn,            // (key, value) when server param change
  onclose              : fn,            // (connection id) when a connection closes
  debug                : false,         // true, or a function called with (connection, query, params, types)
  socket               : fn,            // (options, host, port) returning a custom socket to use
  transform            : {
    undefined          : undefined,     // Transforms undefined values (eg. to null)
    column             : fn,            // Transforms incoming column names
    value              : fn,            // Transforms incoming row values
    row                : fn             // Transforms entire rows
  },
  connection           : {
    application_name   : 'postgres.js', // Default application_name
    ...                                 // Other connection parameters, see https://www.postgresql.org/docs/current/runtime-config-client.html
  },
  target_session_attrs : null,          // Use 'read-write' with multiple hosts to
                                        // ensure only connecting to primary
  fetch_types          : true,          // Fetches array types and other types it does not know
  eager_types          : false,         // Fetches them when the pool starts instead of when first needed
  publications         : 'alltables',   // Publications for sql.subscribe
  slot                 : null,          // A permanent replication slot for sql.subscribe
  onread               : true,          // Read into one shared buffer per connection (Node.js, Bun)
  unref_sockets        : false          // Idle connections don't keep the process alive
})
```

Note that `max_lifetime = 60 * (30 + Math.random() * 30)` by default. This resolves to an interval between 30 and 60 minutes to optimize for the benefits of prepared statements **and** working nicely with Linux's OOM killer.

## Dynamic passwords

When clients need to use alternative authentication schemes such as access tokens or connections to databases with rotating passwords, provide either a synchronous or asynchronous function that will resolve the dynamic password value at connection time.

```js
const sql = postgres(url, {
  // Other connection config
  ...
  // Password function for the database user
  password : async () => await signer.getAuthToken(),
})
```

The user can be a function as well, for credentials that rotate both, such as those from a secrets manager. It is called each time a connection opens, before the password. Give `database` too, since it can no longer default to the user name.

```js
const sql = postgres({
  database: "app",
  username: async () => (await secrets.get()).username,
  password: async () => (await secrets.get()).password,
});
```

## Password file

With no password given, @boelabs/postgres reads one from the file in `PGPASSFILE`, or `~/.pgpass` (`%APPDATA%\postgresql\pgpass.conf` on Windows), as libpq does: lines of `host:port:database:user:password`, where `*` matches anything and `\` escapes a `:` or `\`. On Unix the file is ignored unless only its owner can read it (`chmod 600`).

## Multi-host connections - High Availability (HA)

Multiple connection strings can be passed to `postgres()` in the form of `postgres('postgres://localhost:5432,localhost:5433', ...)`. This works the same as native the `psql` command. Read more at [multiple host URIs](https://www.postgresql.org/docs/13/libpq-connect.html#LIBPQ-MULTIPLE-HOSTS).

Connections will be attempted in order of the specified hosts/ports. On a successful connection, all retries will be reset. This ensures that hosts can come up and down seamlessly.

If you specify `target_session_attrs: 'primary'` or `PGTARGETSESSIONATTRS=primary` @boelabs/postgres will only connect to the primary host, allowing for zero downtime failovers.

## The Connection Pool

Connections are created lazily once a query is created. This means that simply doing const `sql = postgres(...)` won't have any effect other than instantiating a new `sql` instance.

> No connection will be made until a query is made.

For example:

```js
const sql = postgres(); // no connections are opened

await sql`...`; // one connection is now opened
await sql`...`; // previous opened connection is reused

// two connections are opened now
await Promise.all([sql`...`, sql`...`]);
```

> When there are high amount of concurrent queries, `postgres` will open as many connections as needed up until `max` number of connections is reached. By default `max` is 10. This can be changed by setting `max` in the `postgres()` call. Example - `postgres('connectionURL', { max: 20 })`.

This means that we get a much simpler story for error handling and reconnections. Queries will be sent over the wire immediately on the next available connection in the pool. Connections are automatically taken out of the pool if you start a transaction using `sql.begin()`, and automatically returned to the pool once your transaction is done.

Any query which was already sent over the wire will be rejected if the connection is lost. It'll automatically defer to the error handling you have for that query, and since connections are lazy it'll automatically try to reconnect the next time a query is made. The benefit of this is no weird generic "onerror" handler that tries to get things back to normal, and also simpler application code since you don't have to handle errors out of context.

There are no guarantees about queries executing in order unless using a transaction with `sql.begin()` or setting `max: 1`. Of course doing a series of queries, one awaiting the other will work as expected, but that's just due to the nature of js async/promise handling, so it's not necessary for this library to be concerned with ordering.

Since this library automatically creates prepared statements, it also has a default max lifetime for connections to prevent memory bloat on the database itself. This is a random interval for each connection between 30 and 60 minutes. This allows multiple connections to independently come up and down without affecting the service.

What a statement takes and returns is learned once for the whole pool, not once per connection, so a new connection never has to ask about a query the pool already knows. Each connection still prepares a statement itself the first time it runs it.

Up to `max_pipeline` queries (100 by default) are sent on one connection before the answers come back, which is what makes many small queries fast. A query that waits on a lock holds up those behind it on the same connection; lower `max_pipeline` if that matters more to you than throughput.

### Scheduling

A query goes to an idle connection when there is one. When every connection is busy, the pool pipelines it on the connection where it should be done soonest, from how long each statement has taken before and how long what is in flight has been running, so a quick query doesn't wait behind a slow one when another connection is about to be free. Slow queries (around 100 ms or more) are kept together on the connections that already run slow work, within twice their own time, once the rest of the pool is needed for quick work; how many connections that is follows how much quick and slow work has come in over the last few seconds. Nothing has to be configured, and while nothing slow is in flight the pool places queries as before. `scheduler: false` turns it off: a busy pool then pipelines on the connection with the fewest queries in flight. With `max: 1` there is only one connection to choose, so the scheduler is off.

### Pool stats

`sql.stats` tells what the pool is doing right now:

```js
sql.stats;
// { connections: 3, opening: 0, idle: 1, leased: 1, waiting: 0 }
```

## Connection timeout

By default, connections will not close until `.end()` is called. However, it may be useful to have them close automatically when:

- re-instantiating multiple ` sql`` ` instances
- using @boelabs/postgres in a Serverless environment (Lambda, etc.)
- using @boelabs/postgres with a database service that automatically closes connections after some time (see [`ECONNRESET` issue](https://github.com/porsager/postgres/issues/179))

This can be done using the `idle_timeout` or `max_lifetime` options. These configuration options specify the number of seconds to wait before automatically closing an idle connection and the maximum time a connection can exist, respectively.

For example, to close a connection that has either been idle for 20 seconds or existed for more than 30 minutes:

```js
const sql = postgres({
  idle_timeout: 20,
  max_lifetime: 60 * 30,
});
```

## Auto fetching of array types

The built-in types and their arrays are known without asking the server. The first time a query meets a type the pool doesn't know, the pool asks once for the array types and domains that the database has besides those, so an array of an enum or a domain over a built-in type is read and written like its base type; that connection waits for the answer, which is read on another connection. A type made after that, and any type that is neither, is read and written as text, as in postgres v3. With custom types by name, or `eager_types: true`, they are read when the pool starts instead.

If the connection reading them fails, the read is tried again after `backoff`, and once `connect_timeout` has passed the connections waiting for it are closed and their queries reject.

If you have revoked access to `pg_catalog` this feature will no longer work and will need to be disabled.

You can disable this feature by setting `fetch_types` to `false`.

## Environmental variables

It is also possible to connect to the database without a connection string or any options. @boelabs/postgres will fall back to the common environment variables used by `psql` as in the table below:

```js
const sql = postgres();
```

| Option             | Environment Variables    |
| ------------------ | ------------------------ |
| `host`             | `PGHOST`                 |
| `port`             | `PGPORT`                 |
| `database`         | `PGDATABASE`             |
| `username`         | `PGUSERNAME` or `PGUSER` |
| `password`         | `PGPASSWORD`             |
| `application_name` | `PGAPPNAME`              |
| `ssl`              | `PGSSLMODE`              |
| `sslrootcert`      | `PGSSLROOTCERT`          |
| `sslcert`          | `PGSSLCERT`              |
| `sslkey`           | `PGSSLKEY`               |
| `channel_binding`  | `PGCHANNELBINDING`       |
| `idle_timeout`     | `PGIDLE_TIMEOUT`         |
| `connect_timeout`  | `PGCONNECT_TIMEOUT`      |

## Prepared statements

Prepared statements will automatically be created for any queries where it can be inferred that the query is static. This can be disabled by using the `prepare: false` option, which is what a pooler in transaction mode without support for prepared statements needs (see below). With `prepare: false` a query with parameters is described before it runs, as in postgres v3, which costs a round trip, but always uses the types the server has now. A prepared statement keeps the parameter types it was prepared with, on the server and here, and each connection reads rows and writes values only by what its own server described. If a column changes type so that a query no longer fits them, the query fails before it runs; @boelabs/postgres then runs the query once more with a fresh description and prepares the statement again with the new types, unless it was sent in a transaction or on a reserved connection, where the error is returned and the next query is prepared afresh. Once any connection sees a statement describe differently, the other connections prepare it again before they next use it. Where the server can still cast the old parameter type to the new one, such as `json` to `text`, on a connection that has not yet seen the change, there is no error to act on, and the value is stored as that cast gives it; use `prepare: false` if columns change type while the application runs.

## Connection poolers

@boelabs/postgres is tested through PgBouncer in session mode and in transaction mode, with and without its support for prepared statements.

| Pooler mode | Options | What does not work |
| --- | --- | --- |
| Session | none | Nothing, apart from what the pooler itself refuses |
| Transaction, with [`max_prepared_statements`](https://www.pgbouncer.org/config.html#max_prepared_statements) (PgBouncer 1.21+) | none | `LISTEN`, and `DEALLOCATE` sent as SQL |
| Transaction, without | `prepare: false` | `LISTEN`, and named prepared statements |

In both transaction modes a session belongs to a client only for the length of a transaction, so anything that has to outlive one, like `SET`, `LISTEN` or a temporary table, only works inside `sql.begin` or not at all. Use a direct connection, or a pooler in session mode, for `sql.listen` and `sql.subscribe`.

With `max_prepared_statements`, PgBouncer keeps one prepared statement on each server connection for every query text and set of parameter types, shared by all its clients. After a column changes type, a connection may be handed the statement prepared before the change, which still describes the old parameter types; where the server can cast the old type to the new one, there is no error to act on. Use `prepare: false` through PgBouncer if columns change type while the application runs.

PgBouncer refuses startup parameters it does not know, so a `connection` option like `{ 'some.var': 1 }` needs [`ignore_startup_parameters`](https://www.pgbouncer.org/config.html#ignore_startup_parameters) or `SET` inside a transaction instead. The pid in `state` is the pooler's, not the server's, so `pg_terminate_backend(state.pid)` does not end the session.

## Custom socket

Easily do in-process ssh tunneling to your database by providing a custom socket for @boelabs/postgres to use. The function (optionally async) is called with the options and the host and port to connect to, and must return a socket-like duplex stream. If the socket has done TLS itself, set `negotiated: true` on it so @boelabs/postgres does not ask the server for TLS again.

Here's a sample using [ssh2](https://github.com/mscdex/ssh2)

```js
import ssh2 from "ssh2";

const sql = postgres({
  ...options,
  socket: ({ host: [host], port: [port] }) =>
    new Promise((resolve, reject) => {
      const ssh = new ssh2.Client();
      ssh
        .on("error", reject)
        .on("ready", () =>
          ssh.forwardOut("127.0.0.1", 12345, host, port, (err, socket) =>
            err ? reject(err) : resolve(socket)
          )
        )
        .connect(sshOptions);
    }),
});
```

## Teardown / Cleanup

To ensure proper teardown and cleanup on server restarts use `await sql.end()` before `process.exit()`.

`await sql.close()` closes every connection once the queries on it have finished, but leaves the pool usable: the next query opens a connection again.

Calling `sql.end()` will reject new queries and return a Promise which resolves when all queries are finished and the underlying connections are closed. If a `{ timeout }` option is provided any pending queries will be rejected once the timeout (in seconds) is reached and the connections will be destroyed.

`await using` ends the pool when it goes out of scope:

```js
{
  await using sql = postgres();
  await sql`select 1`;
} // sql.end() has been awaited here
```

For scripts that should exit when their work is done, without calling `sql.end()`, `unref_sockets: true` stops idle connections from keeping the process alive, like `allowExitOnIdle` in node-postgres. Connections with queries in flight still do.

With `min`, the pool keeps that many connections open once it has been used, and `idle_timeout` closes connections only above that number. `sql.close()` lets them close; the next query opens them again.

### Sample shutdown using [Prexit](https://github.com/porsager/prexit)

```js
import prexit from "prexit";

prexit(async () => {
  await sql.end({ timeout: 5 });
  await new Promise((r) => server.close(r));
});
```
