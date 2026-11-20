#!/bin/sh
# Check the stack end to end: a trace, a metric series and a log line arrive, and can be
# read back through grafana-mcp.
# Start it first (docker compose up -d). Extra arguments go to docker compose, e.g.
#   deploy/smoke.sh -f compose.yml -f compose.docker.yml
set -eu
cd "$(dirname "$0")/.."   # orchestrator/, where compose.yml is
# grafana-mcp's caller token: from the environment, else from .env.
MCP_GRAFANA_SERVER_TOKEN=${MCP_GRAFANA_SERVER_TOKEN:-$(sed -n 's/^MCP_GRAFANA_SERVER_TOKEN=//p' .env 2>/dev/null | tail -n 1)}
export MCP_GRAFANA_SERVER_TOKEN
exec docker compose "$@" exec -T -e MCP_GRAFANA_SERVER_TOKEN orchestrator node --input-type=module - < deploy/smoke.mjs
