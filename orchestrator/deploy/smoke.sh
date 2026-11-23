#!/bin/sh
# Check the stack end to end: a trace, a metric series and a log line arrive, and can be
# read back through grafana-mcp.
# Start it first (docker compose up -d). Extra arguments go to docker compose, e.g.
#   deploy/smoke.sh -f compose.yml -f compose.docker.yml
set -eu
cd "$(dirname "$0")/.."   # orchestrator/, where compose.yml is
# grafana-mcp's caller token and published port, as Compose resolved them (dotenv quoting,
# --env-file, ...): asked from the running stack with the same arguments.
MCP_GRAFANA_SERVER_TOKEN=$(docker compose "$@" exec -T grafana-mcp printenv MCP_GRAFANA_SERVER_TOKEN)
published=$(docker compose "$@" port grafana-mcp 8000)
GRAFANA_MCP_PORT=${published##*:}
export MCP_GRAFANA_SERVER_TOKEN GRAFANA_MCP_PORT
exec docker compose "$@" exec -T -e MCP_GRAFANA_SERVER_TOKEN -e GRAFANA_MCP_PORT orchestrator node --input-type=module - < deploy/smoke.mjs
