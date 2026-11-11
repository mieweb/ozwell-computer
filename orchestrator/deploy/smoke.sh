#!/bin/sh
# Check the observability stack end to end: a trace, a metric series and a log line arrive.
# Start it first: docker compose --profile observability up -d
set -eu
cd "$(dirname "$0")"
exec docker compose --profile observability --profile smoke run --rm smoke
