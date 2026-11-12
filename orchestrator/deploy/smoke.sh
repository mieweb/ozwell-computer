#!/bin/sh
# Check the stack end to end: a trace, a metric series and a log line arrive.
# Start it first (docker compose up -d). Extra arguments go to docker compose, e.g.
#   deploy/smoke.sh -f compose.yml -f compose.docker.yml
set -eu
cd "$(dirname "$0")/.."   # orchestrator/, where compose.yml is
exec docker compose "$@" exec -T orchestrator node --input-type=module - < deploy/smoke.mjs
