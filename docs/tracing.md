# Tracing

@boelabs/postgres publishes what it does on Node.js [diagnostics channels](https://nodejs.org/api/diagnostics_channel.html), so a tracer or a metrics library can follow every query without an option or a wrapper. Nothing is published while nobody subscribes, and a query costs nothing measurable then. Diagnostics channels are there on Node.js, Bun and Cloudflare Workers.

| Channel | Kind | Published for |
| ------- | ---- | ------------- |
| `postgres:query` | [tracing channel](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel) | Every query, from when it is sent off until it settles |
| `postgres:connect` | tracing channel | Every attempt to connect to a host, up to a ready connection or an error |
| `postgres:transaction` | tracing channel | Every `sql.begin`, up to its commit or rollback |
| `postgres:pool` | channel | Connections opening, going idle, being leased and released, closing, and queries waiting |
| `postgres:notice` | channel | Every notice from the server |

A tracing channel publishes `start` and `end` around the sending of the query, `error` if it fails, and `asyncStart` and `asyncEnd` when it settles, all with the same context object, which fills in as the query goes along. `start` runs in the async context of the code that made the query, so a span started there gets the right parent.

## `postgres:query`

| Field | |
| ----- | - |
| `query` | The text sent, with `$1`, `$2` for the parameters |
| `parameters` | The values, only with `debug: true` |
| `statement` | The name it is prepared as, `''` if unnamed |
| `database`, `user` | As connected with |
| `connection`, `host`, `port` | The connection it ran on, once sent |
| `command`, `count` | The command tag and the number of rows, once done |
| `queued`, `sent`, `firstByte`, `complete` | Times in milliseconds from `performance.now()` |
| `result`, `error` | What it resolved or rejected with |

## `postgres:connect`

`host`, `port`, `path`, `database`, `user`, `ssl` and `sslnegotiation`, then `result` with the backend `pid`, `status`, `readOnly` and `standby`, or `error`.

## `postgres:transaction`

`mode`, `database`, `user`, `connection`, `host`, `port`, and `outcome`: `'commit'`, `'rollback'` or `'prepare'`.

## `postgres:pool` and `postgres:notice`

Pool messages have an `event` (`open`, `idle`, `wait`, `lease`, `release` or `close`), the `connection`, `host`, `port` and `database`, and the pool's `stats` at that moment. `lease` and `release` also have the `kind` of lease and `lease` how many milliseconds it `waited`; `close` has the `error`. Notices come as `{ notice, connection, host, port, database }`.

## OpenTelemetry

Spans following the [semantic conventions for PostgreSQL](https://opentelemetry.io/docs/specs/semconv/db/postgresql/) take a few lines:

```js
import dc from 'node:diagnostics_channel'
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api'

const tracer = trace.getTracer('postgres.js')
const spans = new WeakMap()

dc.tracingChannel('postgres:query').subscribe({
  start(x) {
    spans.set(x, tracer.startSpan(x.database, {
      kind: SpanKind.CLIENT,
      attributes: {
        'db.system.name': 'postgresql',
        'db.namespace': x.database,
        'db.query.text': x.query ?? undefined
      }
    }))
  },
  error(x) {
    const span = spans.get(x)
    span.recordException(x.error)
    span.setStatus({ code: SpanStatusCode.ERROR, message: x.error.message })
    span.setAttribute('error.type', x.error.code || x.error.name)
    x.error.severity && span.setAttribute('db.response.status_code', x.error.code)
  },
  asyncEnd(x) {
    const span = spans.get(x)
    span.setAttributes({
      'db.query.text': x.query ?? undefined,
      'db.operation.name': x.command ?? undefined,
      'db.response.returned_rows': x.count ?? undefined,
      'server.address': x.host ?? undefined,
      'server.port': x.port ?? undefined
    })
    x.command && span.updateName(x.command + ' ' + x.database)
    span.end()
  },
  end() {},
  asyncStart() {}
})
```

## Metrics

```js
import dc from 'node:diagnostics_channel'

dc.subscribe('tracing:postgres:query:asyncEnd', x => {
  histogram.record(x.complete - x.queued, { command: x.command, error: !!x.error })
})

dc.subscribe('postgres:pool', x => {
  gauge.record(x.stats.waiting)
})
```
