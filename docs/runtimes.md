# Runtimes

@boelabs/postgres runs on Node.js 24 or later, Bun 1.4 or later and Cloudflare Workers, from the same package and the same import. CI runs the whole suite on each of them.

## Bun

Nothing to configure: install it with `bun add @boelabs/postgres` and import it as anywhere else. Errors Bun raises without a stack, such as the `DNSException` of a failed lookup, reject the query like any other connection error.

## Dynamic imports and CommonJS

```js
const { default: postgres } = await import("@boelabs/postgres");
```

From CommonJS, `require` loads it as well:

```js
const postgres = require("@boelabs/postgres").default;
```

## Cloudflare Workers support

@boelabs/postgres runs in Cloudflare Workers on the [TCP socket API](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/). Bundlers pick the Workers build through the `workerd` export condition, so the import is the same as anywhere else.

You can use @boelabs/postgres directly in a Worker, or to benefit from connection pooling and query caching, via the [Hyperdrive](https://developers.cloudflare.com/hyperdrive/learning/connect-to-postgres/#driver-examples) service available to Workers by passing the Hyperdrive `connectionString` when creating a new `postgres` client as follows:

```ts
import postgres from "@boelabs/postgres";

interface Env {
  HYPERDRIVE: Hyperdrive;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const sql = postgres(env.HYPERDRIVE.connectionString);
    const results = await sql`SELECT * FROM users LIMIT 10`;
    ctx.waitUntil(sql.end());
    return Response.json(results);
  },
};
```

@boelabs/postgres uses `Buffer`, `crypto` and `events` from the Node.js compatibility of Workers, which is on by default from the compatibility date 2026-08-04. For an earlier date, enable it in `wrangler.toml`:

```toml
compatibility_flags = ["nodejs_compat"]
```

A few things differ in Workers:

- The server certificate is always checked, whatever `ssl` is set to.
- `sslnegotiation: 'direct'` is refused with `SSL_NEGOTIATION_NOT_SUPPORTED`, as Workers sockets cannot send ALPN.
- Channel binding isn't available, as Workers sockets don't expose the server certificate, so `channel_binding: 'require'` is rejected with `CHANNEL_BINDING_REQUIRED`.
- A connection belongs to the request that opened it, so a client made outside `fetch` cannot be shared between requests.
