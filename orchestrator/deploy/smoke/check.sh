#!/bin/sh
# Runs in the compose network (the `smoke` service). Sends one traced request to the
# orchestrator, then waits for its trace in VictoriaTraces, the orchestrator's metrics in
# VictoriaMetrics, and its log line (with the same trace id) in VictoriaLogs.
set -u
TRACE=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
fail() { echo "FAIL: $*" >&2; exit 1; }
# wait_for <what> <seconds> <command...>: retry until the command succeeds.
wait_for() {
  what=$1 secs=$2; shift 2
  end=$(( $(date +%s) + secs ))
  until "$@" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$end" ] || fail "no $what after ${secs}s"
    sleep 3
  done
  echo "ok: $what"
}

curl -sf -o /dev/null http://orchestrator:8090/health || fail "orchestrator /health"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://orchestrator:8090/mcp \
  -H "authorization: Bearer ${ORCHESTRATOR_TOKEN}" -H 'x-ozwell-user-id: smoke-test' \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "traceparent: 00-${TRACE}-00f067aa0ba902b7-01" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
[ "$code" = 200 ] || fail "POST /mcp answered $code (is ORCHESTRATOR_TOKEN in .env?)"
echo "sent request with trace $TRACE"

trace() { curl -sf "http://victoriatraces:10428/select/jaeger/api/traces/${TRACE}" | grep -q '"traceID":"'"$TRACE"'"'; }
metric() { curl -sf 'http://victoriametrics:8428/api/v1/query?query=up%7Bjob%3D%22orchestrator%22%7D%3D%3D1' | grep -q '"value"'; }
logline() { curl -sf "http://victorialogs:9428/select/logsql/query" --data-urlencode "query=trace_id:=\"${TRACE}\"" | grep -q "$TRACE"; }

wait_for "trace in VictoriaTraces" 90 trace
wait_for "orchestrator metrics in VictoriaMetrics" 90 metric
wait_for "orchestrator log line in VictoriaLogs" 90 logline
echo "smoke test passed"
