# Listen, notify and subscribe

## Listen & notify

When you call `.listen`, a dedicated connection will be created to ensure that you receive notifications instantly. This connection will be used for any further calls to `.listen`. The connection will automatically reconnect according to a backoff reconnection pattern to not overload the database server.

### Listen `await sql.listen(channel, onnotify, [onlisten]) -> { state }`
`.listen` takes the channel name, a function to handle each notify, and an optional function to run every time listen is registered and ready (happens on initial connect and reconnects). It returns a promise which resolves once the `LISTEN` query to Postgres completes, or if there is already a listener active.

```js
await sql.listen('news', payload => {
  const json = JSON.parse(payload)
  console.log(json.this) // logs 'is'
})
```

The optional `onlisten` method is great to use for a very simply queue mechanism:

```js
await sql.listen(
  'jobs',
  (x) => run(JSON.parse(x)),
  ( ) => sql`select unfinished_jobs()`.forEach(run)
)

function run(job) {
  // And here you do the work you please
}
```
### Notify `await sql.notify(channel, payload) -> Result[]`
Notify can be done as usual in SQL, or by using the `sql.notify` method.
```js
sql.notify('news', JSON.stringify({ no: 'this', is: 'news' }))
```

## Realtime subscribe

@boelabs/postgres implements the logical replication protocol of PostgreSQL to support subscription to real-time updates of `insert`, `update`, `delete` and `truncate` operations.

> **NOTE** To make this work you must [create the proper publications in your database](https://www.postgresql.org/docs/current/sql-createpublication.html), enable logical replication by setting `wal_level = logical` in `postgresql.conf` and connect using either a replication or superuser.

### Quick start

#### Create a publication (eg. in migration)
```sql
CREATE PUBLICATION alltables FOR ALL TABLES
```

#### Subscribe to updates
```js
const sql = postgres({ publications: 'alltables' })

const { unsubscribe } = await sql.subscribe(
  'insert:events',
  (row, { command, relation, key, old, lsn, time, xid }) => {
    // Callback function for each row change
    // tell about new event row over eg. websockets or do something else
  },
  () => {
    // Callback on initial connect and potential reconnects
  },
  error => {
    // A handler failed, or the stream had an error
  }
)
```

Besides the row, each change comes with the transaction it was part of: its `lsn` (like `'0/1A2B3C4'`), its commit `time` and its `xid`. An `update` also has `old` when the table's replica identity sends it, and a `truncate` has no row but `cascade` and `restartIdentity`.

### Handlers that return promises

A handler may be async. Changes are then handled one after the other, in the order they were committed, and the stream waits while a handler is busy instead of piling changes up in memory:

```js
await sql.subscribe('insert:orders', async row => {
  await queue.publish('order', row)
})
```

### Persistent slots

By default a subscription uses a temporary replication slot, which the server drops when the connection closes, so changes made while the subscriber is away are not seen.

Give the slot a name to keep it. It is created if it does not exist, and streaming starts where it was last confirmed, so nothing committed while the subscriber was down is missed:

```js
const sql = postgres({ publications: 'alltables', slot: 'orders_worker' })

await sql.subscribe('*:orders', async(row, info) => {
  await handle(row, info)
})
```

With a slot, a transaction is confirmed to the server only after every handler for it has finished. If a handler throws or rejects, the transaction is not confirmed: `onerror` is called, the stream restarts and the transaction is delivered again. Delivery is at least once, so a handler should cope with seeing a transaction twice, for instance by remembering the `lsn` it handled last.

While nothing is in flight, the slot is also confirmed as far as the server has got, so a quiet slot does not keep the server holding WAL.

A persistent slot keeps WAL on the server until it is confirmed, so drop it when it is no longer used:

```sql
select pg_drop_replication_slot('orders_worker')
```

### Subscribe pattern

You can subscribe to specific operations, tables, or even rows with primary keys.

#### `operation`      `:` `schema` `.` `table` `=` `primary_key`

**`operation`** is one of ``` * | insert | update | delete | truncate ``` and defaults to `*`

**`schema`** defaults to `public`

**`table`** is a specific table name and defaults to `*`

**`primary_key`** can be used to only subscribe to specific rows

### Examples

```js
sql.subscribe('*',                () => /* everything */ )
sql.subscribe('insert',           () => /* all inserts */ )
sql.subscribe('*:users',          () => /* all operations on the public.users table */ )
sql.subscribe('delete:users',     () => /* all deletes on the public.users table */ )
sql.subscribe('update:users=1',   () => /* all updates on the users row with a primary key = 1 */ )
sql.subscribe('truncate:users',   () => /* the public.users table was truncated */ )
```
