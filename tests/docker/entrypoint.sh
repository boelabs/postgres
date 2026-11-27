#!/bin/sh
# Starts the test servers and runs the given command as the postgres user (initdb refuses root).
#
# localhost is made to mean 127.0.0.1 only, as on GitHub's runners. Without a global IPv6 address a
# container resolves localhost to 127.0.0.1 when connecting but to ::1 when listening, so the tests'
# own fake servers would be out of reach.
set -e
grep -v '^::1' /etc/hosts > /tmp/hosts && cat /tmp/hosts > /etc/hosts && rm /tmp/hosts
export PG_BIN="$(ls -d /usr/lib/postgresql/*/bin | tail -n 1)"
exec runuser -u postgres -- sh -c 'sh tests/setup.sh > /dev/null && exec "$@"' -- "$@"
