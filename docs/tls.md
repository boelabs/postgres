# TLS

Connections are unencrypted unless `ssl`, the url or `PGSSLMODE` asks for TLS.

## sslmode

`ssl` takes the modes of libpq's `sslmode`, and a connection url or `PGSSLMODE` can set them as well, so a url that works with `psql` works here:

| Mode | Encrypts | Checks the certificate authority | Checks the host name |
| --- | --- | --- | --- |
| `false` or `'disable'` (the default) | no |  |  |
| `'allow'`, `'prefer'` | when the server has TLS | no | no |
| `'require'` | yes | only when `sslrootcert` is given | no |
| `'verify-ca'` | yes | yes | no |
| `'verify-full'` or `true` | yes | yes | yes |

The certificate authorities are the runtime's trusted ones, or those in the file `sslrootcert` names. `sslrootcert=system` uses the operating system's as well and means `verify-full`. `sslcert` and `sslkey` are the files of a client certificate, with `sslpassword` for an encrypted key. Each can be an option, a url parameter or, but for `sslpassword`, the environment variable libpq reads (`PGSSLROOTCERT`, `PGSSLCERT`, `PGSSLKEY`). The files are read when the pool first connects.

```js
// A server with a certificate of its own authority, reached by an internal address
const sql = postgres(
  "postgres://user@10.0.0.5/db?sslmode=verify-ca&sslrootcert=/etc/ssl/db-ca.pem"
);
```

As in libpq, TLS is never asked for over a Unix socket, and libpq's own url parameters, such as `sslrootcert` or `keepalives`, are not sent to the server as run-time parameters. An unknown mode throws. Cloudflare Workers always check the certificate and its host name.

## Your own tls.connect options

`ssl` also takes an object, given to [`tls.connect`](https://nodejs.org/api/tls.html#tlsconnectoptions-callback) as it is, which then verifies as `verify-full` unless it says otherwise.

Although [vulnerable to MITM attacks](https://security.stackexchange.com/a/229297/174913), a common configuration for the `ssl` option for some cloud providers is to set `rejectUnauthorized` to `false` (if `NODE_ENV` is `production`):

```js
const sql =
  process.env.NODE_ENV === "production"
    ? // "Unless you're using a Private or Shield Heroku Postgres database, Heroku Postgres does not currently support verifiable certificates"
      // https://help.heroku.com/3DELT3RK/why-can-t-my-third-party-utility-connect-to-heroku-postgres-with-ssl
      postgres({ ssl: { rejectUnauthorized: false } })
    : postgres();
```

For more information regarding `ssl` with `postgres`, check out the [Node.js documentation for tls](https://nodejs.org/api/tls.html#tlsconnectoptions-callback).

On Node.js an `ssl` object with a `ca` is made into one TLS context, which every connection made with that object shares, so a long `ca` list is parsed once rather than for each connection. Replacing one of its values, as with a renewed `cert`, makes a new context for the connections opened after that, but a change inside a value, such as a push onto the same `ca` array, is not seen. A `secureContext` given in the object is used as it is.

## Direct TLS

PostgreSQL 17 and later can start TLS on the first byte instead of being asked first, which saves a round trip when connecting:

```js
const sql = postgres(
  "postgres://host/db?sslmode=require&sslnegotiation=direct"
);
// or
const sql = postgres({ ssl: "require", sslnegotiation: "direct" });
```

On Node.js this is also the fastest encrypted connection, as it reads into the same shared buffer as a plain one. It needs a server that supports it, and is not available in Cloudflare Workers, whose sockets cannot send the ALPN it requires.

## Channel binding

Over TLS, SCRAM authentication is bound to the server's certificate with SCRAM-SHA-256-PLUS (`tls-server-end-point`) when the server offers it, so a man in the middle holding some other certificate that looks valid can't relay the login. `channel_binding` works as in libpq, and can also be given in the url or as `PGCHANNELBINDING`:

- `'prefer'` (the default) binds when the server offers it, and authenticates as before when it doesn't.
- `'require'` refuses any connection that isn't bound, so a server that isn't reached over TLS, doesn't offer it or authenticates without SCRAM is rejected with `CHANNEL_BINDING_REQUIRED`.
- `'disable'` never binds.

```js
const sql = postgres(
  "postgres://host/db?sslmode=verify-full&channel_binding=require"
);
```

Certificates signed with Ed25519, for which binding isn't defined, are not bound. Cloudflare Workers sockets don't expose the server certificate, so there `'prefer'` doesn't bind and `'require'` is rejected.
