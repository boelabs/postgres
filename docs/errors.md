# Error handling

Errors are all thrown to related queries and never globally. Errors coming from database itself are always in the [native Postgres format](https://www.postgresql.org/docs/current/errcodes-appendix.html), and the same goes for any [Node.js errors](https://nodejs.org/api/errors.html#errors_common_system_errors) eg. coming from the underlying connection.

The stack of a query error leads to the line in your code that made the query, not into @boelabs/postgres, even when the error comes back long after it was sent.

Query errors will also contain the `query` string and the `parameters`. These are not enumerable to avoid accidentally leaking confidential information in logs. To log these it is required to specifically access `error.query` and `error.parameters`, or set `debug: true` in options.

An error from the server is a `PostgresError`, with the fields of the server's [error message](https://www.postgresql.org/docs/current/protocol-error-fields.html) as properties:

```js
import postgres, { PostgresError } from "@boelabs/postgres";

try {
  await sql`insert into users ${sql(user)}`;
} catch (error) {
  if (error instanceof PostgresError && error.code === "23505")
    return { taken: error.constraint_name };
  throw error;
}
```

| Property |  |
| --- | --- |
| `code` | The [SQLSTATE](https://www.postgresql.org/docs/current/errcodes-appendix.html), such as `'23505'` for a unique violation |
| `message`, `severity`, `severity_local` | Always there |
| `detail`, `hint`, `position`, `where` | When the server sends them |
| `schema_name`, `table_name`, `column_name`, `data_type_name`, `constraint_name` | For errors about a specific object |
| `file`, `line`, `routine` | Where in the server it happened |
| `query`, `parameters`, `types` | The query that failed; not enumerable unless `debug` is on |

`JSON.stringify(error)` includes the message and every enumerable field.

Errors from the connection are Node.js errors such as `ECONNREFUSED`, or one with a `code` from the list below. Every error @boelabs/postgres throws has a `code`.

## Error codes

The errors specific to this library, by `code`.

### UNSAFE_TRANSACTION

> Only use sql.begin, sql.reserved or max: 1

To ensure statements in a transaction runs on the same connection (which is required for them to run inside the transaction), you must use [`sql.begin(...)`](transactions.md#transactions), a [reserved connection](transactions.md#reserving-connections) or only allow a single connection in options (`max: 1`). A query on the pool that leaves its connection in a transaction is rolled back and rejected with this error. A query that looks like it may start a transaction runs alone on its connection, so no other query ends up in it, and one that opens and closes its own transaction, such as a migration file with `BEGIN` and `COMMIT`, runs as it is.

### UNDEFINED_VALUE

> Undefined values are not allowed

@boelabs/postgres won't accept `undefined` as values in tagged template queries since it becomes ambiguous what to do with the value. If you want to set something to null, use `null` explicitly.

### MESSAGE_NOT_SUPPORTED

> X (X) is not supported

Whenever a message is received from Postgres which is not supported by this library. Feel free to file an issue if you think something is missing.

### PROTOCOL_ERROR

> The server sent a message with an invalid length (-1)

The server, or something between it and @boelabs/postgres, sent a message whose length is below 4 bytes or above 1 GiB. The connection is closed, and its queries reject with this error or with a connection error caused by it.

### NUL_CHARACTER

> The connection parameter database contains a NUL character

A connection parameter such as `database`, `user` or `application_name` contains `\0`. The startup message separates parameters with NUL, so the rest would be read as more parameters; the connection is refused instead.

### MAX_PARAMETERS_EXCEEDED

> Max number of parameters (65534) exceeded

The postgres protocol doesn't allow more than 65534 (16bit) parameters. If you run into this issue there are various workarounds such as using `sql([...])` to escape values instead of passing them as parameters.

### SASL_SIGNATURE_MISMATCH

> Message type X not supported

When using SASL authentication the server responds with a signature at the end of the authentication flow which needs to match the one on the client. This is to avoid [man-in-the-middle attacks](https://en.wikipedia.org/wiki/Man-in-the-middle_attack). If you receive this error the connection was canceled because the server did not reply with the expected signature.

### NOT_TAGGED_CALL

> Query not called as a tagged template literal

Making queries has to be done using the sql function as a [tagged template](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Template_literals#Tagged_templates). This is to ensure parameters are serialized and passed to Postgres as query parameters with correct types and to avoid SQL injection.

### AUTH_TYPE_NOT_IMPLEMENTED

> Authentication type X is not supported

Postgres supports many different authentication types. This one is not supported. Cleartext, MD5, SCRAM-SHA-256 and SCRAM-SHA-256-PLUS are.

### SASL_MECHANISM_NOT_SUPPORTED / SASL_NONCE_MISMATCH

The server offered no SASL mechanism @boelabs/postgres supports (SCRAM-SHA-256 or, over TLS, SCRAM-SHA-256-PLUS), or its answer did not continue the client's nonce, which means something between them interfered.

### CHANNEL_BINDING_REQUIRED

> channel_binding is require, but the server did not offer it

`channel_binding` is `'require'`, and the connection could not be bound to the server's certificate: it is not over TLS, the server did not offer SCRAM-SHA-256-PLUS, asked for a cleartext or MD5 password (which is then not sent) or authenticated without SCRAM, or the certificate could not be hashed for it.

### SSL_NOT_SUPPORTED

> The server does not support SSL connections

`ssl` was `require` or stricter and the server has no TLS.

### SSL_NEGOTIATION_NOT_SUPPORTED

`sslnegotiation: 'direct'` was asked for in Cloudflare Workers, which cannot do it.

### TRANSACTION_ROLLED_BACK

> The server rolled back the transaction instead of committing it

`sql.begin` sent COMMIT and the server answered that it rolled back instead, so nothing in the transaction was saved.

> The query was not sent, the transaction was rolled back with sql.rollback()

A query, savepoint or nested `sql.begin` was made after `sql.rollback()` in the same transaction or savepoint.

### ARRAY_REMOVED

> sql.array() is removed, pass the array as it is

Arrays are typed from what they hold, so they need no helper. Add a cast where the server should treat it as something else, like `${ ids }::int[]`.

### CONNECTION_CLOSED

> write CONNECTION_CLOSED host:port

This error is thrown if the connection was closed without an error. This should not happen during normal operations, so please create an issue if this was unexpected.

### CONNECTION_ENDED

> write CONNECTION_ENDED host:port

This error is thrown if the user has called [`sql.end()`](connection.md#teardown--cleanup) and performed a query afterward.

### CONNECTION_DESTROYED

> write CONNECTION_DESTROYED host:port

This error is thrown for any queries that were pending when the timeout to [`sql.end({ timeout: X })`](connection.md#teardown--cleanup) was reached.

### QUEUE_TIMEOUT

> Waited more than 5 seconds for a connection

A query, transaction or reserve waited longer than `queue_timeout` for a connection. It was never sent.

### QUERY_TIMEOUT

> The query did not finish within query_timeout (5 seconds)

A query took longer than `query_timeout`, waiting and running together, and was canceled. Its `cause` is the `57014` it was canceled with, or `CANCEL_UNANSWERED` when the server didn't answer the cancel, in which case whether the query ran is unknown.

### CANCEL_UNANSWERED

> The server did not answer within cancel_timeout (5 seconds) after a query was canceled, so whether it ran is unknown

The `cause` of `CONNECTION_DESTROYED` or `QUERY_TIMEOUT` for the queries on a connection that was closed because a cancel request got no answer within `cancel_timeout`. Whether those queries ran is unknown, as when a connection is lost.

### TYPE_NOT_FOUND

> The type vector does not exist

A custom type given by name was not found when the pool looked it up.

### NESTED_TRANSACTION_MODE

> A nested transaction runs in a savepoint, which can not change the transaction mode

A nested `sql.begin` was given a mode other than its transaction's, or called `sql.prepare()`.

### LOCK_KEY

> An advisory lock key is an integer, a bigint or a non-empty string

`sql.lock` was given a key it can't use. No connection was taken.

### LOCK_NO_FUNCTION

> sql.lock takes a key and a function to run while it holds the lock

### LOCK_NOT_AVAILABLE

> The advisory lock key is held by another session

`sql.lock` with `wait: false` found the lock held. Nothing ran.

### TLS_HANDSHAKE_FAILED

> The TLS connection to host:port was lost before the server answered

On Cloudflare Workers: the TLS handshake could not be completed, most often because the server's certificate is not signed by a publicly trusted CA. Workers always verify the certificate; Hyperdrive connects to such servers for you.

### NO_COLUMNS

> The insert helper got no columns

An insert or update helper was given an empty object or an empty list of columns, which would make invalid SQL.

### CONNECT_TIMEOUT

> write CONNECT_TIMEOUT host:port

This error is thrown if the startup phase of the connection (tcp, protocol negotiation, and auth) took more than the default 30 seconds or what was specified using `connect_timeout` or `PGCONNECT_TIMEOUT`.

### COPY_IN_PROGRESS

> You cannot execute queries during copy

This error is thrown if trying to run a query during a copy operation (writable / readable).
