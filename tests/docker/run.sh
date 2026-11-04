#!/bin/sh
# Runs a test command inside the Docker test image, against fresh servers.
#
#   sh tests/docker/run.sh                          the whole suite on Node
#   sh tests/docker/run.sh bun tests/index.js       the integration tests on Bun
#   PG=17 NODE=26 sh tests/docker/run.sh            other PostgreSQL and Node.js versions
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
pg=${PG:-18}
node=${NODE:-24}
bun=${BUN:-1.4}
image="boelabs-postgres-test:pg$pg-node$node-bun$bun"
docker build -q -t "$image" --build-arg "PG=$pg" --build-arg "NODE=$node" --build-arg "BUN=$bun" "$here" > /dev/null
[ $# -gt 0 ] || set -- sh -c 'node tests/unit && node tests/index.js && node tests/simulate.js'
# MSYS_NO_PATHCONV keeps Git Bash on Windows from rewriting /work into a Windows path.
MSYS_NO_PATHCONV=1 exec docker run --rm -i -v "$root:/work" "$image" "$@"
