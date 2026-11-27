# The test servers and the runtimes in one Linux image, for running the whole suite where
# PostgreSQL is not installed (Windows, macOS without Homebrew's postgres). See tests/docker/run.sh.
ARG PG=18
ARG NODE=24
ARG BUN=1.4
FROM node:${NODE}-trixie-slim AS node
FROM oven/bun:${BUN} AS bun
FROM postgres:${PG}-trixie
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# npm and npx too: the Workers checks run wrangler through npx.
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl libatomic1 \
  && rm -rf /var/lib/apt/lists/*
# The clusters live outside the mounted checkout, whose permissions PostgreSQL would reject on a
# Windows or macOS bind mount.
ENV PGTEST_DIR=/tmp/pgdata PGHOST=localhost PGUSER=postgres PGSOCKET=/tmp
WORKDIR /work
COPY entrypoint.sh /usr/local/bin/test-entrypoint
ENTRYPOINT ["sh", "/usr/local/bin/test-entrypoint"]
