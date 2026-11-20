# RCA guide: ozwell-computer observability data

You are investigating incidents in ozwell-computer: an orchestrator (one MCP endpoint
that creates per-user remote Linux desktops, "computers", and proxies tool calls to them)
and the computers themselves. This server gives read-only Grafana access to their
metrics, logs and traces. Everything here may hold personal data (user emails, full
tool arguments, command lines, journal lines): quote only what the analysis needs.

## Datasources (use these uids)

| uid | What | Tools |
|---|---|---|
| `victoriametrics` | Metrics, PromQL (VictoriaMetrics: MetricsQL extensions work too) | `query_prometheus`, `list_prometheus_*` |
| `victorialogs` | Logs, **LogsQL, not LogQL** | `query_loki_logs`, `list_loki_label_*`, `query_loki_stats` |
| `victoriatraces-tempo` | Traces, TraceQL (VictoriaTraces' Tempo API) | `search_tempo_traces`, `get_tempo_trace`, `list_tempo_attribute_*` |

`victoriatraces` (Jaeger) and `victoriatraces-spans` (spans as LogsQL rows) are for the
dashboards; prefer the Tempo one for traces. Dashboards: Fleet, Instance drill-down
(`instance_id` variable), Operations, Tool calls, Orchestrator logs.

## Metrics

- Scrape jobs: `orchestrator`, `computers` (one target per running computer, through the
  orchestrator's scrape proxy), and the stack (`victoriametrics`, `victorialogs`,
  `victoriatraces`, `vmagent`). `up{job="computers", instance_id="…"}` is the computer's
  scrape status.
- Orchestrator, `ozwell_orchestrator_*`:
  - `tool_calls_total{tool, outcome, reason}`, `tool_call_duration_seconds{tool, outcome}`.
    `reason` is `none` (ok), the orchestrator's `invalid_request`, `target_unavailable`,
    `computer_stopped`, `quota_exceeded`, `unauthenticated`, `internal`, a computer's own
    reason (`path_not_found`, ...) or `other`. `internal` is a real failure; most others
    are agent mistakes.
  - Operations (`create`, `start`, `destroy`, `list`, `get`): `operations_total{provider,
    operation, outcome}`, `operation_duration_seconds`, `operation_phase_seconds{phase}`
    (`enqueue`, `provision`, `boot`), `operations_in_flight`,
    `time_to_ready_observed_seconds`.
  - Provider API: `provider_call_duration_seconds{provider, method, outcome}`.
  - Lookup cache: `computer_cache_total{result}`. Discovery: `sd_requests_total{outcome}`,
    `computer_listings_total{provider, outcome}`.
  - Log and span pullers: `log_pulls_total{outcome}`, `log_entries_shipped_total`,
    `log_pull_unsupported_instances`, `trace_pulls_total{outcome}`,
    `trace_spans_shipped_total`, `trace_spans_dropped_total`.
- Computers, `ozwell_*`: `ozwell_build_info{version}`, `ozwell_x_connected`,
  `ozwell_cgroup_cpu_seconds_total`, `ozwell_cgroup_memory_bytes{scope}` and
  `_limit_bytes`, `ozwell_cgroup_pressure_seconds_total{resource=cpu|memory|io,
  kind=some|full}` (PSI: take `rate()`; 0.1 means stalled 10% of the time),
  `ozwell_process_pss_bytes{command}`, `ozwell_http_request_duration_seconds{route}`,
  `ozwell_mcp_tool_calls_total{tool, outcome}`, `ozwell_screenshot_seconds`,
  `ozwell_vnc_sessions`, `ozwell_presence_participants{kind}`.
- Scraped computer series carry only `instance_id` and `provider`. Owner, display name
  and creation time come from joining the info metric:
  `max by (instance_id) (up{job="computers"}) * on (instance_id) group_left (user, display_name, created_at) max by (instance_id, user, display_name, created_at) (ozwell_orchestrator_computer_info)`.

## Logs (LogsQL)

- Syntax: `field:="exact"`, `field:~"regex"`, a bare `"word"` searches the message,
  `| fields a, b` keeps only those fields (do this: records are large),
  `| sort by (_time desc)`, `| limit N`. Not LogQL: no `{…} |=` pipelines.
- Orchestrator: OTLP records, `service.name:="ozwell-computer-orchestrator"` (the admin
  CLI: `ozwell-computer-admin`). Fields: `_msg`, `severity_text` (`info`, `warn`,
  `error`), `component` (`mcp`, `log-puller`, `admin`), `trace_id`, `span_id`. Tool
  calls are `_msg:="tool call"` with `tool`, `user` (email), `instance` (the computer
  id) and `args.*`; failures are `_msg:="tool failed"` with `err`.
  Example: `service.name:="ozwell-computer-orchestrator" severity_text:~"warn|error" | fields _time, _msg, component, err, instance, trace_id`.
- Computers: their journal, `OZWELL_INSTANCE_ID:="<id>"`, also tagged `OZWELL_USER`
  (email), `OZWELL_PROVIDER` and `_SYSTEMD_UNIT` (the server is
  `ozwell-computer.service`; updates `ozwell-computer-upgrade.service`). `PRIORITY` is
  syslog (0–7) and `level` its name. The server's lines are pino JSON in `_msg`, with
  `trace_id` inside the JSON: search for it as a word,
  `OZWELL_INSTANCE_ID:="<id>" "<trace_id>"`.
- Counting: `| stats by (field) count() n, max(_time) _time`. The `_time` result is
  required: rows without it are dropped by the tool. `query_loki_patterns` doesn't work
  here. `query_loki_stats` gives a total count (`entries`).

## Traces (TraceQL)

- **Always scope attributes** (`span.` or `resource.`): unscoped `.attr` matches nothing
  on VictoriaTraces. Intrinsics: `name`, `status` (`error`, `ok`, `unset`), `duration`,
  `kind`. Example: `{ span.ozwell.instance_id = "<id>" && status = error }`.
- Orchestrator spans (`resource.service.name = "ozwell-computer-orchestrator"`), under
  the HTTP span `request` (`POST /mcp`):
  - `mcp.tools/call <tool>`: `span.gen_ai.tool.name`, `span.ozwell.instance_id`,
    `span.ozwell.provider`, `span.enduser.id` (email), `span.ozwell.tool.arguments`
    (full JSON), `span.ozwell.ready`, `span.ozwell.cache`, `span.error.type` (the reason).
  - `provider.<method>` (provider API calls), `readiness.poll`, `instance.callTool` (the
    call to the computer).
  - `operation.<kind>` (`create`, `start`, `destroy`, `list`, `get`): **its own trace**,
    linked from the tool calls that started or observed it. `span.ozwell.kind =
    "operation"`, `span.ozwell.operation`, `span.ozwell.outcome`,
    `span.ozwell.final_phase`, `span.ozwell.phase_seconds`.
- Computer spans (`resource.service.name = "ozwell-computer"`, pulled by the orchestrator
  and tagged `resource.ozwell.instance_id`, `resource.ozwell.user`,
  `resource.ozwell.provider`) continue the same trace under `instance.callTool`:
  `POST /mcp` → `mcp.tool <tool>` → `screenshot` (`.capture`, `.cursor`, `.encode`,
  `.ocr`), `input.pointer`, `input.keyboard`, `exec` (`span.exec.job_id`,
  `span.exec.state`, `span.process.exit.code`, `span.exec.timed_out`; no command line),
  `a11y.tree` / `.find` / `.act`. A background command's `exec` span lasts until the
  command ends, after its tool call returned.
- `get_tempo_trace` with a `trace_id` from a log line or a search result shows the whole
  call, orchestrator and computer.
- `list_tempo_attribute_names`: call it **without** `scope` (with one, VictoriaTraces
  returns no names). `list_tempo_attribute_values` takes the scoped name, e.g.
  `span.gen_ai.tool.name`. Pass `start`/`end`: both default to the last hour.

## Recipe

1. From the alert or report, get the `instance_id` (computer id, `ozc-…`) and a time. If
   you only have a user's email, find their computers through
   `ozwell_orchestrator_computer_info{user="<email>"}`.
2. Look up the computer: metadata (the info metric), `up{job="computers"}`,
   `ozwell_build_info`, `ozwell_x_connected`, memory against its limit, pressure.
3. Read its journal and the orchestrator's logs around that time (`instance:="<id>"` on
   orchestrator records); look for `warn`/`error`, restarts and upgrades.
4. Follow `trace_id`s to the traces; for slow or failed calls, compare the
   orchestrator's `mcp.tools/call` span with the computer's spans under it.
5. State the root cause with the evidence (queries, trace ids, log lines), and what is
   still unknown.

## Pitfalls

- Creates and starts are rare: use long windows (days) for operation metrics, and
  `increase()` over the window rather than `rate()`.
- Computer series from before 2026-11-13 carried owner metadata as labels and split when
  it changed: aggregate with `max by (instance_id)` or `sum by (instance_id)`.
- `user` is an email address, not an id.
- Times are UTC. The tools default to the last hour: pass the incident's window.
- Traces are kept 7 days, logs 14, metrics 30. Traces become searchable about 20 s
  after they end; fetching by id is immediate.
- Computers only send journals, pressure and their version from 2026.11.3, and spans
  from 2026.11.4 (`ozwell_build_info`; no such series means older). A missing
  log or span stream is not evidence that nothing happened: check
  `ozwell_orchestrator_log_pulls_total` and `ozwell_orchestrator_trace_pulls_total`
  (`unsupported`).
- While the orchestrator is down nothing is scraped or pulled from computers, and their
  logs from that time are not backfilled.
