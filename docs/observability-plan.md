# Observability plan: orchestrator and instances

Status: plan with decisions recorded. Phases 0–6 are implemented (`telemetry.ts`, `metrics.ts`, `operations.ts`,
`instrument-provider.ts`, `internal-server.ts`, `log-puller.ts` in `orchestrator/src/`; `journal.ts`, `routes/logs.ts`,
`trace-context.ts` in the instance's `src/`; `orchestrator/Dockerfile` and `orchestrator/deploy/`).
The "Later" items are not.

## Goals

1. **Operation timing.** Measure each provider operation end to end, from the first
   request until the result is usable. That means create (enqueue to `/health` 204),
   start (request to ready), destroy (request to gone), and list/get.
2. **Instance metrics.** Scrape every known instance's existing Prometheus endpoint.
3. **Logs** from every known instance and the orchestrator, pulled so that instances
   don't need to know where logs go.
4. **Distributed tracing** for every MCP tool call, rooted in the orchestrator.

## Decisions

| Topic | Decision |
|---|---|
| Packaging | New `orchestrator/Dockerfile` + `orchestrator/compose.yml` (its config files in `orchestrator/deploy/`), which always runs the observability services on one default network. The docker:// provider is an optional override, `orchestrator/compose.docker.yml`. |
| Host | The stack runs on the same host as the orchestrator. |
| Backends | VictoriaMetrics, VictoriaLogs, VictoriaTraces, vmagent, Grafana. |
| OTel Collector | None. The SDK exports OTLP directly to VictoriaLogs and VictoriaTraces. |
| Metrics transport | All metrics are pulled by vmagent. The orchestrator exposes `/metrics`, and there is no OTLP metrics push. |
| Instance scrape auth | An orchestrator scrape proxy adds the instance token. |
| Operation completion | A background readiness watcher. |
| Computer lookups | Desktop tools use a cached lookup (running computers only), revalidated when a call fails without reaching the computer (refused, 503, 401) and after 1 h. Real lookups stay `get` operations; `ozwell_orchestrator_computer_cache_total{result}` counts hits, misses and revalidations. Management tools always ask the provider. |
| Operation persistence | In memory only. In-flight operations are lost on orchestrator restart. |
| Operation ↔ trace | Operation spans are separate traces; tool-call spans link to them. |
| Phase timing | Yes: enqueue, provision, boot. |
| Observed time-to-ready | Yes. |
| Operation timeout | 10 minutes, configurable. |
| Instance logs | Pulled through a new `/api/v1/logs/entries`, a gatewayd-compatible subset implemented with `journalctl` (not the gatewayd package, not `sd-journal`). Journal Export Format forwarded to VictoriaLogs `/insert/journald/upload`. Polling only. Older instances without the route are skipped and re-checked. |
| Journal access | `ozwell-computer.service` gets `SupplementaryGroups=systemd-journal`, in the image and the `.deb` alike. The `desktop` user's processes (agent commands, the terminal) can read the whole journal as a result, including on bare metal: accepted. |
| Log units | All journald units are collected. Dashboards filter to `ozwell-computer.service` by default. |
| Cursor on restart | Resume from "now". A small gap is acceptable. |
| Drain before destroy | No. |
| Logs as an MCP tool | No. |
| Orchestrator logs | stdout and OTLP to VictoriaLogs, with trace ids. |
| Instance tracing | v1 is log correlation only: `traceparent` is propagated and `trace_id` added to instance logs. |
| Propagation | `traceparent` HTTP header plus `params._meta.traceparent`. |
| Sampling | 100%, configurable. |
| Tool argument capture | Full arguments. PHI handling and anonymization are a later layer. |
| User identity | Email (`X-Ozwell-User-Email`, or the computer's stored owner email); the user id only when there is no email. Access is still enforced by user id. |
| `/internal/*` security | A separate port and listener (`ORCHESTRATOR_INTERNAL_PORT`), not exposed publicly. Off loopback it requires a bearer token (`ORCHESTRATOR_INTERNAL_TOKEN`), which vmagent sends. |
| Compose networks | `compose.yml` has only its default network, with no computers on it. `compose.docker.yml` puts docker:// computers on their own `ozwell-computers` network, shared only with the orchestrator. |
| opensource-server pull path | Same path as MCP traffic: public HTTPS unless `internal=ip`. |
| Metric cardinality | No limits for now. Revisit if series growth becomes a problem. |
| Grafana auth | Local admin only, with credentials set in compose. Dashboards are committed to the repo and read-only in the UI. |
| Grafana access | Grafana publishes its own dedicated port (`GRAFANA_PORT`, default 3000). The existing external reverse proxy handles routing and TLS. The orchestrator does not proxy Grafana. |
| Alerting | Later phase. |
| Replicas | A single orchestrator replica. |
| Retention | Metrics 30 days, logs 14 days, traces 7 days. |

## Current state (summary)

- The orchestrator (`orchestrator/src/cli.ts`, `server.ts`, `mcp.ts`) runs on Fastify 5
  with pino JSON logs to stdout. It has no metrics and no OpenTelemetry, and it is
  deployed as a systemd unit.
- Per-tool-call logging (`mcp.ts:163`, `:213`) uses `deps.log`, which `cli.ts` never
  sets, so it is never emitted.
- Readiness is decided only by the orchestrator: `isReady` / `waitReady`
  (`mcp.ts:86-112`) poll `GET {internalUrl}/health`.
- Instances expose `prom-client` metrics at `GET /api/v1/metrics` on port 8080. The
  endpoint needs the per-instance token.
- Instances run systemd as PID 1 and log to journald. No HTTP endpoint exposes logs.

## Architecture

```
┌───────────────────────────── orchestrator host (compose) ─────────────────────────────┐
│ orchestrator                                                                          │
│  public :8090   POST /mcp, GET /health                                                │
│  internal :8091 GET /metrics, /sd, /instances/:id/metrics                             │
│  OTel SDK ──OTLP traces──► VictoriaTraces                                             │
│           ──OTLP logs────► VictoriaLogs                                               │
│  log puller ──GET instance /api/v1/logs/entries──► VictoriaLogs (journald/upload)     │
│                                                                                       │
│ vmagent ──scrape──► :8091/metrics, :8091/instances/*/metrics (via http_sd :8091/sd)   │
│         ──remote write──► VictoriaMetrics                                             │
│ Grafana :3000 (published; external reverse proxy routes + terminates TLS)            │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Everything is opt-in. With no OTLP endpoints set, no internal port and no log-ship URL,
the orchestrator behaves as it does today.

## Configuration

| Var | Purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | VictoriaTraces OTLP endpoint. Unset disables tracing export. |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | VictoriaLogs OTLP endpoint. Unset disables orchestrator log export. |
| `OTEL_SERVICE_NAME` | Default `ozwell-computer-orchestrator`. |
| `OTEL_TRACES_SAMPLER` / `_ARG` | Default `parentbased_traceidratio` / `1.0`. |
| `ORCHESTRATOR_INTERNAL_HOST` / `_PORT` | Internal listener. Default `127.0.0.1` / unset (disabled). The compose file sets `0.0.0.0:8091` on its network. |
| `ORCHESTRATOR_INTERNAL_TOKEN` | Bearer token the internal listener requires. Required unless it is on loopback; required by `compose.yml`, which gives vmagent the same value. |
| `ORCHESTRATOR_SD_ADDRESS` | `host:port` vmagent reaches the internal listener at, used as `__address__` in `/sd` targets. Default: the internal host and port. Compose sets `orchestrator:8091`. |
| `ORCHESTRATOR_LOG_SHIP_URL` | VictoriaLogs journald ingest (`…/insert/journald/upload`). Unset disables the instance log puller. |
| `ORCHESTRATOR_LOG_POLL_MS` | Default 5000. |
| `ORCHESTRATOR_OP_TIMEOUT_MS` | Default 600000. |

## Workstream 1: Operation timing

### Model

An **operation** is one logical intent (`create`, `start`, `destroy`, `list` or `get`)
whose lifetime is independent of the tool calls that observe it.

- An operation starts when the provider call is issued.
- It completes when its terminal condition is first observed:
  - create and start: `/health` returns 204.
  - destroy: `get` returns not-found.
  - list and get: the call returns.
- Failure means a provider error, a failed or dead status, or the timeout.

### Implementation

1. **`orchestrator/src/operations.ts`: `OperationTracker`.**
   - Keeps an in-memory map `instanceId → {op, provider, startedAt, phase, span}`. On
     orchestrator restart, in-flight operations are dropped, by decision.
   - `begin()` opens an `operation.<op>` span **as its own root trace**. The tool-call
     spans that start or observe the operation carry a **span link** to it. That way a
     tool-call trace stays short, and the operation trace shows the full
     create-to-ready duration.
   - Metrics, using the Prometheus registry served on `/metrics`:
     - `ozwell_orchestrator_operation_duration_seconds{provider,operation,outcome}`,
       a histogram from 0.1 s to 900 s with exemplars carrying the operation trace id.
     - `ozwell_orchestrator_operation_phase_seconds{provider,operation,phase}`, where
       phase is one of:
       - `enqueue`: the provider API call.
       - `provision`: until the provider reports running or online.
       - `boot`: until `/health` returns 204.
     - `ozwell_orchestrator_operations_total{provider,operation,outcome}`.
     - `ozwell_orchestrator_operations_in_flight{provider,operation}`.
     - `ozwell_orchestrator_time_to_ready_observed_seconds{provider}`, measured from
       create until the first tool call that returns `ready:true`. This helps tune
       `CREATE_WAIT_MS`.
2. **Background readiness watcher.** Every in-flight create and start is polled by the
   tracker every 1.5 s, using the existing `isReady`, with capped concurrency. It
   records the provision → boot transition and completion, independently of client
   polling. It gives up at `ORCHESTRATOR_OP_TIMEOUT_MS`.
3. **Hook points.**
   - The `mcp.ts` management tool handlers call `begin` and `observe`.
   - The opensource-server `starting` dedupe map reuses the existing operation, so a
     repeated start doesn't create a second one.
   - `instrumentProvider(provider)` wraps every provider method with a span and times
     list and get. No per-provider changes are needed.

## Workstream 2: Instance metrics scrape

All scrape routes are served **only on the internal listener**.

1. **Service discovery.** `GET /sd` returns Prometheus `http_sd` JSON built from
   `provider.list()`, cached for about 15 s. It returns one target per running instance,
   with labels:
   - `instance_id`, `provider`, `user` (the owner's email)
   - `__metrics_path__=/instances/<id>/metrics`
   - `__address__=orchestrator:8091`
2. **Scrape proxy.** `GET /instances/:id/metrics` fetches
   `{internalUrl}/api/v1/metrics` with the instance bearer token (timeout 10 s) and
   streams the response back. It returns 404 for an unknown instance and 503 for a
   stopped or unreachable one.
   - It uses the same URL as MCP traffic: the public HTTPS URL for opensource-server
     unless `internal=ip` is set.
3. **Orchestrator metrics.** `GET /metrics` uses `prom-client`, or the OTel Prometheus
   exporter if that is simpler with the SDK. It includes the default process metrics,
   the operation metrics and the tool-call metrics.
4. **vmagent.** One `http_sd_configs` job against `/sd`, plus a static job for
   `/metrics`. It runs with no `sample_limit` for now.

## Workstream 3: Logs

### Orchestrator

- Wire `deps.log` in `cli.ts` (`app.log.child({component:'mcp'})`).
- Tool-call log lines include the tool name and the **full arguments**, by decision.
  - Exception: screenshot and image payloads in *results* are replaced by their size,
    to keep log volume sane.
  - Tokens are still redacted: auth headers, the instance token, and the viewer
    `?token=` URLs.
- pino keeps writing to stdout. `@opentelemetry/instrumentation-pino` adds
  `trace_id`/`span_id` and sends records over OTLP to VictoriaLogs.

### Instances (pull)

1. **New instance route: `GET /api/v1/logs/entries`, a gatewayd-compatible subset.**
   It speaks the [`systemd-journal-gatewayd`](https://www.freedesktop.org/software/systemd/man/latest/systemd-journal-gatewayd.service.html)
   `/entries` API rather than a custom protocol, implemented by running `journalctl` with
   `execFile`. Options considered and rejected:
   - Running the real gatewayd behind a proxy. The package (`systemd-journal-remote`)
     pins `libsystemd-shared`, so installing it upgrades systemd on live computers. It
     also needs enable-on-upgrade logic in both `postinst` and `make install`.
   - `sd-journal` through a native addon. That means a C++ addon to maintain, an
     in-process crash risk, and producing the formats ourselves. journald has no D-Bus or
     varlink API for reading entries.

   The supported subset (anything else gets 400 or 416, never an approximation):
   - **`Accept`:** `application/vnd.fdo.journal` (Journal Export Format, the default for
     the puller) or `application/json` (Journal JSON Format). The output is
     `journalctl -o export|json` byte for byte.
   - **`Range: entries=<cursor>[:<skip>:<n>]`** and **`Range: realtime=<since>:[<until>][:<skip>:<n>]`**.
     Every entry carries `__CURSOR`, so there is no custom cursor header.
   - **Query:** `KEY=match` field matches, with journalctl's AND/OR semantics, and
     `boot`. `follow` may be added later.
   - **Default** (no `Range`): the last entries of the current boot.
   - Token-auth'd like every other route. Not exposed as an MCP tool.

   Security requirements:
   - **No option injection.** `KEY` must match `^[A-Z0-9_]+$`. Cursors are
     format-checked and passed as one `--after-cursor=…` argument. Every flag is set by
     the route, and matches go after `--`. No shell.
   - **Bounded.** `n` is capped (default 1000, max 5000). Concurrent requests per
     instance are limited. Each request has a wall-clock timeout, and `journalctl` is
     killed when the client disconnects.
   - **No scope restriction.** The route serves whatever the `systemd-journal` group can
     read; there is no unit or field allow-list.
   - **Access.** `ozwell-computer.service` gets `SupplementaryGroups=systemd-journal`.
     Child processes (`run_command`, the terminal) inherit it, so they can read the
     whole journal too. That is accepted, including on bare-metal `.deb` installs (in
     the container image `desktop` already has root through sudo).
   - **Conformance test.** An integration test runs the real `systemd-journal-gatewayd`
     in the test container only and compares its responses with the route's for the
     same requests.
2. **Orchestrator puller: `orchestrator/src/log-puller.ts`.**
   - One loop per running instance (from the same discovery as `/sd`) with a global
     concurrency cap on calls in flight.
   - The first pull for an instance, including after an orchestrator restart, uses
     `Range: realtime=<now>:`. Logs from while the orchestrator was down are not
     backfilled, by decision. After that it uses the last `__CURSOR` with `skip` 1.
   - It requests the export format and forwards it to VictoriaLogs `/insert/journald/upload`
     (native journald ingestion: `PRIORITY` becomes the level, `__REALTIME_TIMESTAMP`
     the time). It adds `OZWELL_INSTANCE_ID`, `OZWELL_USER` and `OZWELL_PROVIDER` lines
     to each entry (the format is `KEY=value` lines per entry), so it parses nothing
     else.
   - Stops when the instance stops or disappears. There is no drain before destroy.
   - **Mixed versions degrade gracefully.** Instances update independently of the
     orchestrator, and older ones lack the route. Their not-found handler returns a
     JSON 404 regardless of token, which the puller can tell apart from other failures:
     - **404:** marked unsupported. It is re-checked every 10 minutes and when the
       instance restarts, and logged once per instance, not per poll.
     - **401:** backed off the same way, with a warning (a token problem, not a
       version one).
     - **5xx, timeout or refused connection:** exponential backoff up to a cap.
     - One instance never delays another.
     - **VictoriaLogs refuses a batch:** the cursor doesn't advance, and the same range
       is pulled again after a backoff.
     - **The instance no longer knows the cursor (400):** start again from now.
     - Metrics: `ozwell_orchestrator_log_pulls_total{outcome}` (`ok`, `unsupported`,
       `unauthorized`, `unavailable`, `ship_error`, `error`),
       `ozwell_orchestrator_log_entries_shipped_total` and
       `ozwell_orchestrator_log_pull_unsupported_instances`.
3. **Correlation.** The instance's request logger binds `trace_id`/`span_id` from an
   incoming `traceparent` header or `_meta.traceparent`.

## Workstream 4: Distributed tracing

1. **`orchestrator/src/telemetry.ts`.** Loaded with `node --import` in `npm start`, the
   Dockerfile and the systemd unit.
   - `NodeSDK` with an OTLP HTTP trace exporter and log exporter.
   - Instrumentations: `@fastify/otel`, `instrumentation-undici` (`fetch`),
     `instrumentation-http` (the docker socket), and `instrumentation-pino`.
2. **Span structure for one tool call:**
   ```
   POST /mcp                               (fastify server span)
   └─ mcp.tools/call <tool>                (manual)
      ├─ provider.<method>                 (instrumentProvider)
      │  └─ HTTP client spans              (docker / opensource-server API)
      ├─ readiness.poll                     (waitReady; event per attempt)
      └─ instance.callTool
         └─ HTTP POST {internalUrl}/mcp    (traceparent + _meta.traceparent)
   link → operation.<op> trace
   ```
   Attributes:
   - `mcp.method.name`, `gen_ai.tool.name`, `mcp.session.id`
   - `ozwell.instance_id`, `ozwell.provider`, `enduser.id` (the user's email)
   - `ozwell.ready`, `error.type`
   - the full tool arguments as `ozwell.tool.arguments`, with large binary result
     payloads summarised by size
3. **Tool-call metrics:** `ozwell_orchestrator_tool_call_duration_seconds{tool,outcome}`
   (with exemplars) and `ozwell_orchestrator_tool_calls_total{tool,outcome}`.
4. **Later:** an instance OTel SDK exporting through an orchestrator relay. Out of scope
   for v1.

## Grafana

- **Auth:** local admin only. The username and password come from compose env
  (`GF_SECURITY_ADMIN_USER`/`_PASSWORD`). Anonymous access, sign-up and other users
  are disabled.
- **Access:** Grafana is the only observability service with a published port:
  `${GRAFANA_BIND:-127.0.0.1}:${GRAFANA_PORT:-3000}:3000`.
  - The existing reverse proxy in front of the stack routes a hostname or path to that
    port and terminates TLS.
  - Set `GF_SERVER_ROOT_URL` to the public URL. If the proxy uses a sub-path, also set
    `GF_SERVER_SERVE_FROM_SUB_PATH=true`.
  - The proxy must forward websockets (Grafana Live).
  - VictoriaMetrics, VictoriaLogs, VictoriaTraces and vmagent publish no ports.
- **Provisioning:** under `orchestrator/deploy/grafana/provisioning/`.
  - Datasources: VictoriaMetrics, VictoriaLogs (plugin), and VictoriaTraces (Jaeger
    type).
  - Correlations: trace → logs on `trace_id`, and logs → trace via a derived field.
    Metrics → trace via exemplars is **not available**: vmagent and VictoriaMetrics
    (v1.156) drop exemplars. The orchestrator still exposes them on `/metrics`; the
    Operations and Tool calls dashboards have recent-trace panels instead.
- **Read-only dashboards:** JSON files in `orchestrator/deploy/grafana/dashboards/`,
  provisioned with `allowUiUpdates: false` and `editable: false`. Changes are made in the
  repo only.
- Dashboards:
  - **Operations:** p50/p95/p99 by provider and operation, phase breakdown, in-flight
    count, failure rate, observed vs actual time-to-ready.
  - **Tool calls:** RED metrics per tool, slowest traces.
  - **Fleet:** instance count by state, scrape `up`, instance memory and CPU, instance
    HTTP and MCP metrics.
  - **Instance drill-down:** variables for `instance_id` and `unit`. The `unit` variable
    defaults to `ozwell-computer.service`.
  - **Orchestrator logs.**
- Alerting comes in a later phase.

## Retention

- VictoriaMetrics: `-retentionPeriod=30d`
- VictoriaLogs: `-retentionPeriod=14d`
- VictoriaTraces: `-retentionPeriod=7d`

## Delivery phases

| Phase | Scope | Verify |
|---|---|---|
| 0 | Wire `deps.log`; `telemetry.ts` (no-op without endpoints); `instrumentProvider` | `orchestrator`: typecheck + `npm test` |
| 1 | Internal listener; `/metrics`; tool-call spans + metrics; propagation (header + `_meta`) | in-memory span exporter; assert traceparent reaches fake instance |
| 2 | `OperationTracker` + readiness watcher + phases + observed time-to-ready | fake provider + fake timers: create→ready over 3 tool calls = 1 operation, correct phases, links present; timeout path |
| 3 | `/sd` + scrape proxy | fake instance serving metrics; 404/503 cases |
| 4 | Instance `GET /api/v1/logs/entries` (gatewayd subset), journal group, trace_id log binding | root `typecheck` + `test:unit` (argument building, `Range` parsing, rejection of unsupported requests); `docker compose up -d --build`; new `test/integration/logs.test.ts` (route coverage, conformance against the real gatewayd in the test container) |
| 5 | Log puller | fake instance + fake VictoriaLogs |
| 6 | Dockerfile, compose (plus a docker:// override), vmagent config, Grafana provisioning + dashboards | manual bring-up; smoke script asserting a trace, a metric series and a log line arrive |
| Later | Alerts; PHI/anonymization layer; instance SDK via relay; cardinality limits | — |

If computer MCP tools change, regenerate the catalog: `make build && npm run mcp-tools`.

## New dependencies (orchestrator)

- `@opentelemetry/api` and `@opentelemetry/sdk-node`
- `@opentelemetry/exporter-trace-otlp-proto` and `@opentelemetry/exporter-logs-otlp-proto` (OTLP over HTTP
  with protobuf: VictoriaLogs rejects the JSON encoding)
- `@opentelemetry/instrumentation-undici`, `-http` and `-pino`
- `@fastify/otel`
- `prom-client`

The instance gets no new runtime dependencies; it uses the existing `journalctl`.

## Known trade-offs from the decisions

- Restarting the orchestrator loses in-flight operation timings, and instance logs
  emitted while it was down are not backfilled.
- Full arguments and user emails in logs and traces mean the observability stack holds
  PHI. Access is limited to the Grafana admin on the same host until the anonymization
  layer lands.
- Having no cardinality limit means a large fleet can grow VictoriaMetrics series
  quickly. Watch `vm_cache_entries` and the active-series metrics.
