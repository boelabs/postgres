# Cloudflare Workers tests

`worker.js` is a Worker that runs a set of checks with @boelabs/postgres (`../../src/cf.js`) and answers with
the result of each as JSON, with `failed` counting the ones that did not pass. It runs in three ways.

## 1. workerd, direct to PostgreSQL (every commit)

```sh
sh tests/cf/run.sh
```

`wrangler dev` runs the Worker in workerd on this machine, and it connects straight to the test
server on localhost: plain, md5, scram, TLS through `startTls`, and that `sslnegotiation: 'direct'`
is refused. Workers always verify certificates, so the TLS checks need the server to have a
certificate for `localhost` that `NODE_EXTRA_CA_CERTS` trusts, as tests/setup.sh makes. The test users must exist first (`node tests/bootstrap.js`, which the Node.js suite also runs). In Docker, as CI runs it:

```sh
sh tests/docker/run.sh sh -c 'NODE_EXTRA_CA_CERTS=$PGTEST_DIR/5432/server.crt node tests/bootstrap.js && sh tests/cf/run.sh'
```

`ONLY=trust` runs the checks of one configuration.

## 2. workerd, through the Hyperdrive binding (every commit)

```sh
CHECK=hyperdrive sh tests/cf/run.sh
```

The same checks through `env.HYPERDRIVE.connectionString`, as a Worker using Hyperdrive would.
In `wrangler dev` the binding connects straight to `localConnectionString` in `wrangler.toml` (or the
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` variable), so this checks the code path
but not Hyperdrive itself: no pooling and no caching.

## 3. Through a real Hyperdrive, by hand

`wrangler dev --remote`, with the id of a Hyperdrive configuration in `wrangler.toml`, runs the Worker on
Cloudflare through the real Hyperdrive without deploying, which is how to try a change against it.
The checks create only temporary tables, so a user that can only connect and use temporary tables is
enough.
