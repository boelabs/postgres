# Transactions

## BEGIN / COMMIT `await sql.begin([options = ''], fn) -> fn()`

Use `sql.begin` to start a new transaction. @boelabs/postgres will reserve a connection for the transaction and supply a scoped `sql` instance for all transaction uses in the callback function. `sql.begin` will resolve with the returned value from the callback function.

`BEGIN` is automatically sent with the optional options, and if anything fails `ROLLBACK` will be called so the connection can be released and execution can continue.

A query that fails in a transaction aborts it, whether the server rejected it or @boelabs/postgres could not build it (an `undefined` value, say), as PostgreSQL does: catching the error does not let the rest commit, and a later `COMMIT` answers `ROLLBACK`. The transaction commits only once its cursors have finished, also those the callback did not await.

```js
const [user, account] = await sql.begin(async (sql) => {
  const [user] = await sql`
    insert into users (
      name
    ) values (
      'Murray'
    )
    returning *
  `;

  const [account] = await sql`
    insert into accounts (
      user_id
    ) values (
      ${user.user_id}
    )
    returning *
  `;

  return [user, account];
});
```

Do note that you can often achieve the same result using [`WITH` queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html) instead of using transactions.

It's also possible to pipeline the requests in a transaction if needed by returning an array with queries from the callback function like this:

```js
const result = await sql.begin((sql) => [
  sql`update ...`,
  sql`update ...`,
  sql`insert ...`,
]);
```

Queries that are not awaited one by one are pipelined anywhere in the transaction, so `Promise.all` pipelines a group of them between other queries. They run in the order they were made, so a later query sees what an earlier one in the group did:

```js
await sql.begin(async (sql) => {
  const [movie] = await sql`select * from movie where name = 'Star Wars'`;

  await Promise.all([
    sql`insert into movie_actor ...${movie.id}`,
    sql`insert into movie_release ...${movie.id}`,
  ]);

  await sql`select ...`;
});
```

## SAVEPOINT `await sql.savepoint([name], fn) -> fn()`

```js
sql
  .begin("read write", async (sql) => {
    const [user] = await sql`
    insert into users (
      name
    ) values (
      'Murray'
    )
  `;

    const [account] =
      (await sql
        .savepoint(
          (sql) =>
            sql`
      insert into accounts (
        user_id
      ) values (
        ${user.user_id}
      )
    `
        )
        .catch((err) => {
          // Account could not be created. ROLLBACK SAVEPOINT is called because we caught the rejection.
        })) || [];

    return [user, account];
  })
  .then(([user, account]) => {
    // great success - COMMIT succeeded
  })
  .catch(() => {
    // not so good - ROLLBACK was called
  });
```

## Nested `sql.begin`

Inside a transaction, `sql.begin(fn)` runs `fn` in a savepoint, so code that opens a transaction works the same whether it is given the pool or a transaction. Nothing it does is committed until the outer transaction commits. A mode other than the transaction's own, such as `'read only'` inside a `'read write'` transaction, throws `NESTED_TRANSACTION_MODE`, since a savepoint can't change it, and so does `sql.prepare()` inside a nested `begin`. A savepoint with a name is still `sql.savepoint(name, fn)`.

```js
async function transfer(sql, from, to, amount) {
  return sql.begin(async (sql) => {
    await sql`update accounts set balance = balance - ${amount} where id = ${from}`;
    await sql`update accounts set balance = balance + ${amount} where id = ${to}`;
  });
}

await transfer(sql, 1, 2, 10); // its own transaction
await sql.begin((sql) => transfer(sql, 1, 2, 10)); // a savepoint in this one
```

## ROLLBACK `await sql.rollback()`

Rolls back the transaction without throwing, and `sql.begin` resolves with what the callback returns (#500). Called in a savepoint or a nested `sql.begin`, it rolls back only that savepoint, and the outer transaction goes on. The rollback is sent at once, after any queries already made. Queries made after it in the same scope are not sent and reject with `TRANSACTION_ROLLED_BACK`, and so does the `sql.begin` they were made in.

```js
const result = await sql.begin(async (sql) => {
  const [order] = await sql`insert into orders ${sql(input)} returning *`;
  if (!(await inStock(sql, order)))
    return (await sql.rollback(), { saved: false });
  return { saved: true, order };
});
```

## PREPARE TRANSACTION `await sql.prepare([name]) -> fn()`

Indicates that the transactions should be prepared using the [`PREPARE TRANSACTION [NAME]`](https://www.postgresql.org/docs/current/sql-prepare-transaction.html) statement instead of being committed.

```js
sql.begin("read write", async (sql) => {
  const [user] = await sql`
    insert into users (
      name
    ) values (
      'Murray'
    )
  `;

  await sql.prepare("tx1");
});
```

## Batches

### `await sql.batch([queries]) -> Result[]`

`sql.batch` sends several queries in one round trip and ends them with a single Sync, so the server answers them all at once. It resolves with their results in order.

```js
const [, [{ count }]] = await sql.batch([
  sql`update users set name = ${name} where id = ${id}`,
  sql`select count(*)::int from users`,
]);
```

Outside a transaction the queries are one implicit transaction, as PostgreSQL makes everything before a Sync: they commit together, and if one fails, none of them is committed and the ones after it are not run. The batch rejects with the error of the query that failed, with its position in `error.index`; the other queries in it reject with a copy marked `skipped`. A query that can not be built or written fails the batch the same way, and nothing of it is committed.

```js
try {
  await sql.batch([
    sql`insert into accounts ${sql(account)}`,
    sql`insert into audit ${sql(entry)}`,
  ]);
} catch (error) {
  error.index; // -> 1 if the audit insert failed, and the account insert was rolled back
}
```

Inside `sql.begin` a batch is part of the transaction, and a failure aborts the transaction as any failing query does. On a reserved connection it runs on that connection.

The queries are sent without waiting for each other, so none of them can use another's result, and queries from elsewhere that share the connection keep their own Sync, outside the batch. Cursors, streams, `forEach` and `describe` can not be part of a batch.

`Promise.all` pipelines queries as well, but gives each its own Sync, so each commits, or fails, on its own; with a batch the server finishes one transaction instead of one per query.

## Reserving connections

### `await sql.reserve()`

The `reserve` method pulls out a connection from the pool, and returns a client that wraps the single connection. This can be used for running queries on an isolated connection.

```ts
const reserved = await sql.reserve();
await reserved`select * from users`;
await reserved.release();
```

### `reserved.release()`

Once you have finished with the reserved connection, call `release` to add it back to the pool. `using reserved = await sql.reserve()` releases it when it goes out of scope.

## Advisory locks

### `await sql.lock(key, fn, [options]) -> Result`

Runs `fn` while this process holds the [session advisory lock](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS) `key`, and lets it go when `fn` settles, whether it resolved or threw. The lock is held on a connection kept for it alone, since a session lock belongs to the connection that took it and the pool would otherwise send the unlock to another one. `sql.lock` resolves with what `fn` returns.

```js
// Every replica migrates on boot: the first one runs the migrations, the others wait and then find nothing to do
await sql.lock("migrations", () => migrate());
```

The key is an integer, a `bigint` or a string, which the server hashes into one with `hashtextextended`. `fn` gets the `sql` of the connection that holds the lock, for queries that should run in the session that holds it; on a pool of `max: 1` it is the only way to query while holding the lock, as that connection is the pool's only one.

```js
await sql.lock(918273645, async (locked) => {
  await locked`update jobs set state = 'running' where id = ${id}`;
});
```

Options:

- `wait: false` doesn't wait for another session to let the lock go: it rejects with `LOCK_NOT_AVAILABLE` at once, for work only one process should do, like a scheduled job.
- `signal` stops waiting for the lock when it is aborted, rejecting with `57014`, such as `AbortSignal.timeout(5000)`.

```js
try {
  await sql.lock("nightly-report", () => report(), { wait: false });
} catch (error) {
  if (error.code !== "LOCK_NOT_AVAILABLE") throw error;
}
```

Should the connection be lost while `fn` runs, the server lets the lock go with it. A connection whose unlock fails is closed rather than handed back to the pool, so a lock is never left behind on a pooled connection. Inside a transaction, `pg_advisory_xact_lock` holds a lock until the transaction ends, without any of this.
