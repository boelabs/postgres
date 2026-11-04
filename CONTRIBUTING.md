# Contributing to @boelabs/postgres

Thanks for your interest! This document describes how the project takes contributions, how to run it locally, and what a change needs before it is merged.

## Code of Conduct

By participating in this project you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## How contributions work

Pull requests are opened and merged by the project's collaborators only. A pull request from outside the team is closed automatically, with a note pointing here. Everyone is welcome to take part through issues:

- **Bugs:** open a [bug report](https://github.com/boelabs/postgres/issues/new?template=bug_report.yml) with the smallest code that shows it, the runtime and PostgreSQL versions, and what you expected. A failing test is the best report there is.
- **Ideas:** open a [feature request](https://github.com/boelabs/postgres/issues/new?template=feature_request.yml) describing the problem first, then the API you have in mind.
- **Security issues:** never in public. Follow [SECURITY.md](SECURITY.md).

## Requirements

- Node.js 24 or later (`.nvmrc`), and Bun 1.4 or later for the Bun suite
- pnpm, at the version `packageManager` in `package.json` names (pnpm switches to it on its own)
- PostgreSQL 14 or later with `pg_ctl` and `psql` on `PATH`, **or** Docker

The library itself has no dependencies; `pnpm install` only brings [Ultracite](https://www.ultracite.ai) (Oxlint and Oxfmt) and TypeScript.

## Running the tests

The integration tests need two PostgreSQL servers configured in a particular way (TLS, logical replication, prepared transactions, several users). Either start them yourself:

```bash
pnpm install
sh tests/setup.sh
PGHOST=localhost PGUSER=postgres pnpm test
```

or run everything in Docker, which works the same on Linux, macOS and Windows:

```bash
pnpm run test:docker
```

Any command runs in the same image, against other versions too:

```bash
sh tests/docker/run.sh bun tests/index.js
PG=17 NODE=26 sh tests/docker/run.sh
```

A single area runs with a filter on the test names, as in `node tests/index.js "sql.lock"`.

| Command | What it checks |
| --- | --- |
| `pnpm run check` | Ultracite: Oxfmt formatting and Oxlint rules (`pnpm run fix` applies both) |
| `pnpm run check:docs` | Every link between the Markdown files leads somewhere |
| `pnpm run test:types` | The TypeScript types against `types/test.ts` |
| `pnpm run test:unit` | Unit tests, no database needed |
| `pnpm run test:integration` | Everything against real servers |
| `pnpm run test:simulate` | Randomised fault injection against a simulated server |
| `pnpm run test:bun` | The same suites on Bun |
| `pnpm run test:cf` | The Cloudflare Workers build in `workerd` (see `tests/cf/README.md`) |

## Conventions

- **Language:** code, comments, identifiers, commit messages and documentation are in **English**.
- **No dependencies.** The published package is `src/*.js` and `types/index.d.ts`, nothing else.
- **Style:** [Ultracite](https://www.ultracite.ai)'s core rules on Oxlint, formatted by Oxfmt; `pnpm run check` is the reference and `pnpm run fix` applies it. `oxlint.config.ts` lists the few departures from the preset, each with its reason; a rule that cannot apply at one place is disabled on that line, with the reason beside it. Comments say why, not what. Coding agents have the Ultracite skill in `.agents/skills`.
- **Every runtime:** a change must hold on Node.js, Bun and Cloudflare Workers. A Node.js-only API needs a guard or a fallback.
- **Tests:** every fix comes with a test that fails without it; every option or behaviour with tests that run on Node.js and Bun.
- **Docs:** the reference lives in `docs/`, one page per topic; `README.md` is the front page and stays short. User-facing changes update their page in `docs/`, `types/index.d.ts` (with a case in `types/test.ts`) and `CHANGELOG.md` under the next version. `pnpm run check:docs` checks the links.

## Releases

Maintainers release by raising `version` in `package.json` and adding its section to `CHANGELOG.md` in a pull request. Once it is merged, pushing the tag `v<version>` on that commit of `main` publishes it to npm with provenance, waits until npm serves it and then creates the GitHub release (see `.github/workflows/release.yml`).
