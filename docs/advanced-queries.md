# Advanced query methods

## Cursors

### ```await sql``.cursor([rows = 1], [fn])```

Use cursors if you need to throttle the amount of rows being returned from a query. You can use a cursor either as an [async iterable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for-await...of) or with a callback function. For a callback function new results won't be requested until the promise / async callback function has resolved.

Inside `sql.begin` or on a reserved connection every cursor has a portal of its own, so several can be open at once and other queries can run between their batches.

#### callback function
```js
await sql`
  select
    *
  from generate_series(1,4) as x
`.cursor(async([row]) => {
  // row = { x: 1 }
  await http.request('https://example.com/wat', { row })
})
```

#### for await...of
```js
// for await...of
const cursor = sql`select * from generate_series(1,4) as x`.cursor()

for await (const [row] of cursor) {
  // row = { x: 1 }
  await http.request('https://example.com/wat', { row })
}
```

A single row will be returned by default, but you can also request batches by setting the number of rows desired in each batch as the first argument to `.cursor`:
```js
await sql`
  select
    *
  from generate_series(1,1000) as x
`.cursor(10, async rows => {
  // rows = [{ x: 1 }, { x: 2 }, ... ]
  await Promise.all(rows.map(row =>
    http.request('https://example.com/wat', { row })
  ))
})
```

If an error is thrown inside the callback function no more rows will be requested and the outer promise will reject with the thrown error.

You can close the cursor early either by calling `break` in the `for await...of` loop, or by returning the token `sql.CLOSE` from the callback function.

```js
await sql`
  select * from generate_series(1,1000) as x
`.cursor(row => {
  return Math.random() > 0.9 && sql.CLOSE // or sql.END
})
```

## Instant iteration

### ```await sql``.forEach(fn)```

If you want to handle rows returned by a query one by one, you can use `.forEach` which returns a promise that resolves once there are no more rows.
```js
await sql`
  select created_at, name from events
`.forEach(row => {
  // row = { created_at: '2019-11-22T14:22:00Z', name: 'connected' }
})

// No more rows
```

## Query Descriptions
### ```await sql``.describe() -> Result[]```

Rather than executing a given query, `.describe` will return information utilized in the query process. This information can include the query identifier, column types, etc.

This is useful for debugging and analyzing your Postgres queries. Furthermore, **`.describe` will give you access to the final generated query string that would be executed.**

## Rows as Array of Values
### ```sql``.values()```

Using `.values` will return rows as an array of values for each column, instead of objects.

This can be useful to receive identically named columns, or for specific performance/transformation reasons. The column definitions are still included on the result array, plus access to parsers for each column.

## Rows as Raw Array of Buffers
### ```sql``.raw()```

Using `.raw` will return rows as an array with `Buffer` values for each column, instead of objects.

This can be useful for specific performance/transformation reasons. The column definitions are still included on the result array, plus access to parsers for each column.

## Queries in Files
### `await sql.file(path, [args], [options]) -> Result[]`

Using a file for a query is also supported with optional parameters to use if the file includes `$1, $2, etc`

```js
const result = await sql.file('query.sql', ['Murray', 68])
```

## Multiple statements in one query
### ```await sql``.simple()```

The postgres wire protocol supports ["simple"](https://www.postgresql.org/docs/current/protocol-flow.html#id-1.10.6.7.4) and ["extended"](https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY) queries. "simple" queries supports multiple statements, but does not support any dynamic parameters. "extended" queries support parameters but only one statement. To use "simple" queries you can use
```sql``.simple()```. That will create it as a simple query.

```js
await sql`select 1; select 2;`.simple()
```

## Copy to/from as Streams

@boelabs/postgres supports [`COPY ...`](https://www.postgresql.org/docs/14/sql-copy.html) queries, which are exposed as [Node.js streams](https://nodejs.org/api/stream.html).

### ```await sql`copy ... from stdin`.writable() -> Writable```

```js
import { pipeline } from 'node:stream/promises'

// Stream of users with the default tab delimitated cells and new-line delimitated rows
const userStream = Readable.from([
  'Murray\t68\n',
  'Walter\t80\n'
])

const query = await sql`copy users (name, age) from stdin`.writable()
await pipeline(userStream, query);
query.count // 2, the number of rows copied, once the stream has finished
```

### ```await sql`copy ... to stdout`.readable() -> Readable```

#### Using Stream Pipeline
```js
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'

const readableStream = await sql`copy users (name, age) to stdout`.readable()
await pipeline(readableStream, createWriteStream('output.tsv'))
// output.tsv content: `Murray\t68\nWalter\t80\n`
```

#### Using `for await...of`
```js
const readableStream = await sql`
  copy (
    select name, age
    from users
    where age = 68
  ) to stdout
`.readable()
for await (const chunk of readableStream) {
  // chunk.toString() === `Murray\t68\n`
}
```

> **NOTE** This is a low-level API which does not provide any type safety. To make this work, you must match your [`copy query` parameters](https://www.postgresql.org/docs/14/sql-copy.html) correctly to your [Node.js stream read or write](https://nodejs.org/api/stream.html) code. Ensure [Node.js stream backpressure](https://nodejs.org/en/learn/modules/backpressuring-in-streams) is handled correctly to avoid memory exhaustion.

## Canceling Queries in Progress

@boelabs/postgres supports, [canceling queries in progress](https://www.postgresql.org/docs/7.1/protocol-protocol.html#AEN39000). It works by opening a new connection with a protocol level startup message to cancel the current query running on a specific connection. That means there is no guarantee that the query will be canceled, and due to the possible race conditions it might even result in canceling another query. This is fine for long running queries, but in the case of high load and fast queries it might be better to simply ignore results instead of canceling.

```js
const query = sql`select pg_sleep 100`.execute()
setTimeout(() => query.cancel(), 100)
const result = await query
```

`.signal()` cancels the query when an [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) aborts: one still waiting for a connection is rejected without being sent, and a running one gets a cancel request. A cursor canceled while its callback runs, or while an async iterator over it is between batches, is stopped by the client instead: it fetches no more rows, closes its portal and rejects with `57014`, with no cancel request sent.

```js
await sql`select * from report()`.signal(AbortSignal.timeout(5000))
```

A query waits for a connection when every connection is reserved, in a transaction or has `max_pipeline` queries in flight. `queue_timeout` (in seconds) rejects it with `QUEUE_TIMEOUT` if it waits longer, without ever sending it, and the same goes for `sql.begin` and `sql.reserve`. Once a query is sent, PostgreSQL's own `statement_timeout` is the limit.

`query_timeout` (in seconds) limits each query, waiting for a connection and running together; inside `sql.begin` or a reserved connection the clock starts when the query is sent on it. A query that runs out of time is canceled as `.cancel()` would, and rejects with `QUERY_TIMEOUT`, with the `57014` it was canceled with as its `cause`. The `begin`, `commit` and savepoint queries of a transaction and `forEach` are limited too; cursors, streams and `sql.listen` are not.

`statement_timeout` is the better limit while the server answers, since the server enforces it and the outcome is known. `query_timeout` is the backstop for when it does not: a server or network that goes silent leaves a query waiting for as long as TCP takes to notice, which is many minutes with default keepalive settings. When a cancel request, from `.cancel()`, `.signal()` or `query_timeout`, gets no answer within `cancel_timeout` (5 seconds by default), the connection is closed and the pool connects again for the next query. As nobody knows whether the queries on that connection ran, they reject with `CONNECTION_DESTROYED`, or a timed out one with `QUERY_TIMEOUT`, whose `cause` is `CANCEL_UNANSWERED`. `cancel_timeout: 0` waits for the answer as long as it takes.

PostgreSQL cancels whatever the connection is running when the request arrives, so a cancel sent just as a query finishes can cancel the query pipelined after it instead. @boelabs/postgres doesn't send it for a query whose result has already arrived, and a query that runs out of time while it waits behind another one on its connection gets its own `query_timeout` once its turn comes before it is canceled, so a quick query just finishes. If the server sends nothing for `cancel_timeout` while such a query waits, the connection is closed.

## Execute

### ```await sql``.execute()```

The lazy Promise implementation in @boelabs/postgres is what allows it to distinguish [Nested Fragments](queries.md#building-queries) from the main outer query. This also means that queries are always executed at the earliest in the following tick. If you have a specific need to execute the query in the same tick, you can call `.execute()`

## Inspecting a query

`query.text` is the text sent to the server, with `$1`, `$2` for the parameters, and `query.parameters` their values. Both work before the query is sent, without a connection:

```js
const query = sql`select * from users where id = ${ 1 } and name = ${ 'Murray' }`
query.text       // 'select * from users where id = $1 and name = $2'
query.parameters // [1, 'Murray']
```

## Unsafe raw string queries

<details>
<summary>Advanced unsafe use cases</summary>

## `await sql.unsafe(query, [args], [options]) -> Result[]`

If you know what you're doing, you can use `unsafe` to pass any string you'd like to postgres. Please note that this can lead to SQL injection if you're not careful.

```js
sql.unsafe('select ' + danger + ' from users where id = ' + dragons)
```

Values go in `args` and are referred to as `$1`, `$2` and so on, so they are never part of the string itself:

```js
sql.unsafe('select * from users where id = $1 and age > $2', [id, age])
```

`options` takes:

| Option | Default | |
| --- | --- | --- |
| `prepare` | `false` | Prepare the query as a named statement. Off by default because a string built at run time may be different every time, and each would stay prepared on the server. |
| `simple` | `true` without `args` | Send it with the simple protocol, which allows several statements in one string but no `args`. |

You can also nest `sql.unsafe` within a safe `sql` expression.  This is useful if only part of your fraction has unsafe elements.

```js
const triggerName = 'friend_created'
const triggerFnName = 'on_friend_created'
const eventType = 'insert'
const schema_name = 'app'
const table_name = 'friends'

await sql`
  create or replace trigger ${sql(triggerName)}
  after ${sql.unsafe(eventType)} on ${sql.unsafe(`${schema_name}.${table_name}`)}
  for each row
  execute function ${sql(triggerFnName)}()
`

await sql`
  create role friend_service with login password ${sql.unsafe(`'${password}'`)}
`
```

</details>
