#!/bin/sh
# Check the stack end to end: a trace, a metric series and a log line arrive, and can be
# read back through grafana-mcp.
# Start it first (docker compose up -d). Extra arguments go to docker compose, e.g.
#   deploy/smoke.sh -f compose.yml -f compose.docker.yml
set -eu
cd "$(dirname "$0")/.."   # orchestrator/, where compose.yml is
# grafana-mcp's caller token and published port: from the environment, else from .env.
dotenv() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1; }
MCP_GRAFANA_SERVER_TOKEN=${MCP_GRAFANA_SERVER_TOKEN:-$(dotenv MCP_GRAFANA_SERVER_TOKEN)}
GRAFANA_MCP_PORT=${GRAFANA_MCP_PORT:-$(dotenv GRAFANA_MCP_PORT)}
export MCP_GRAFANA_SERVER_TOKEN GRAFANA_MCP_PORT
exec docker compose "$@" exec -T -e MCP_GRAFANA_SERVER_TOKEN -e GRAFANA_MCP_PORT orchestrator node --input-type=module - < deploy/smoke.mjs
