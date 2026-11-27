# AGENTS.md

A guide for coding agents in this repository. People start with [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md). Read this file before the first change: its rules take precedence over your defaults.

## Rules

- **Language:** code, identifiers, comments, commits and documentation in English. In conversation, answer in the user's language.
- **No dependencies.** The package is `src/*.js` and `types/index.d.ts`; nothing may be added to `dependencies`. Development tools go in `devDependencies` only when a script needs them.
- **Plain JavaScript, no build.** What is published is what the tests run. Types are written by hand in `types/index.d.ts` and checked by `types/test.ts`.
- **Three runtimes.** Node.js 24+, Bun 1.4+ and Cloudflare Workers (`src/cf.js`, the `workerd` export condition). A Node.js-only API needs a guard; Workers have no `fs`, `net` or `tls` of their own.
- **Never let a query hang.** Every path that rejects a query goes through `queryError`, which must not throw. A runtime may hand over errors without a `stack`, frozen or non-extensible.
- **Behave like libpq** where libpq defines it: url parameters, environment variables, `sslmode`, `target_session_attrs`, `.pgpass`. Say so in the docs where we differ.
- **Don't weaken a check** to make it pass: Oxlint rules (`oxlint.config.ts`), type tests, test assertions or CI steps. A rule that cannot apply at one place is disabled on that line, with the reason: `// oxlint-disable-next-line <rule> -- <why>`.
- **Stay in scope.** Fix what was asked and note adjacent problems in the pull request.

## Map

- `src/index.js` options and the `sql` instance (`begin`, `reserve`, `lock`, `listen`, ...).
- `src/pool.js` connections, leases, scheduling, retries; `src/connection.js` one connection's protocol state; `src/startup.js` authentication and TLS negotiation; `src/socket.js` sockets and TLS options; `src/protocol.js` the wire format; `src/query.js`, `src/build.js` queries and helpers; `src/errors.js` errors and stack traces; `src/cf.js` the Workers socket.
- `tests/unit` needs no database. `tests/*.js` run against the two servers of `tests/setup.sh`. `tests/simulate.js` injects faults into a simulated server. `tests/cf` runs in workerd.

## Checks

Run before every pull request, as CI does:

```bash
pnpm run check
pnpm run test:types
pnpm run test:docker
sh tests/docker/run.sh sh -c 'bun tests/unit/index.js && bun tests/index.js'
```

A fix comes with a test that fails without it. A change to options, errors or the API updates its page in `docs/`, `types/index.d.ts`, `types/test.ts` and `CHANGELOG.md`; `README.md` stays a short front page.
