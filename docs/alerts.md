# ozwell-computer alerts

What each alert email means and what to check first. The rules are in
`orchestrator/deploy/grafana/provisioning/alerting/rules.yml`; keep this page in sync with
them (a test checks that every rule is listed here).

## How the emails work

- **Subject:** `[FIRING:n] ozwell-computer: <alert name> (<provider>)`, or `[RESOLVED]`.
  The provider (`docker`, `opensource-server`) is shown when the alert has one.
- **Grouping:** one email per alert name and provider. If ten computers are unreachable,
  that's one email listing all ten, not ten emails. A group's first email waits 30 s to
  collect alerts that start together; changes to it (another computer, a resolved one) are
  sent at most every 5 minutes; a group still firing is re-sent every 4 hours.
- **Resolved emails** are sent when the condition clears: the alert is listed under
  "Resolved" with its start and end time.
- **Content:** computers are identified by their id only, never the owner's email or what
  the agent was doing. A computer's alert links to its Instance drill-down dashboard;
  others link to the most useful dashboard. "Alert rules" at the bottom opens them all in
  Grafana.
- **Severity:** `critical` means users are affected now; `warning` means something is
  degraded or will be. Both are email only (no paging).
- **While the orchestrator is down,** computers can't be checked (they are reached through
  it). You get one "Orchestrator down" email; computer alerts neither fire nor resolve
  until it is back, and then carry on where they were.
- **If Grafana or the host is down, no alerts are sent at all.** Nothing watches that yet.

Thresholds are first guesses and may be tuned.

## Summary

| Alert | Severity | In short |
|---|---|---|
| [Orchestrator down](#orchestrator-down) | critical | No orchestrator is answering. |
| [Creates/starts failing broadly](#createsstarts-failing-broadly) | critical | Most new computers or starts fail. |
| [Tool calls failing internally](#tool-calls-failing-internally) | critical | Tool calls fail for reasons that aren't the agent's fault. |
| [Provider API failing](#provider-api-failing) | critical | The Docker / opensource-server API returns errors. |
| [Service discovery failing](#service-discovery-failing) | warning | The orchestrator can't list computers; new ones aren't monitored. |
| [New computers slow to become ready](#new-computers-slow-to-become-ready) | warning | Creating a computer takes too long. |
| [Logs not reaching VictoriaLogs](#logs-not-reaching-victorialogs) | warning | Computers' logs are delayed, and at risk of being lost. |
| [Orchestrator logging errors](#orchestrator-logging-errors) | warning | The orchestrator logged several errors. |
| [Running computer unreachable](#running-computer-unreachable) | warning | A running computer doesn't answer. |
| [Computer stalled on memory/CPU/I/O](#computer-stalled-on-memorycpuio) | warning | A computer is starved of a resource. |
| [Computer near its memory limit](#computer-near-its-memory-limit) | warning | A computer is close to running out of memory. |
| [Stack component down](#stack-component-down) | warning | A monitoring service is down. |
| [Stack storage low or read-only](#stack-storage-low-or-read-only) | warning | A monitoring database is running out of disk. |
| [Stack ingestion errors](#stack-ingestion-errors) | warning | Monitoring data is being dropped. |
| [vmagent remote-write backlog](#vmagent-remote-write-backlog) | warning | Metrics are queuing up instead of being stored. |

Dashboards are in Grafana's `ozwell-computer` folder. Logs are on "Orchestrator logs", or
Explore → VictoriaLogs. Run `docker compose` commands in `orchestrator/` on the host.

## The orchestrator

### Orchestrator down

`ozwell-orchestrator-down` · critical

- **Means:** no orchestrator replica has answered for 2 minutes. MCP calls from Ozwell fail
  and computers can't be monitored.
- **Fires when:** vmagent can't scrape any orchestrator for 2 minutes (also when none
  exists, or when VictoriaMetrics itself can't be queried).
- **Likely causes:** the container crashed or is restarting, a bad deploy, the host is
  out of memory, VictoriaMetrics or vmagent is down (then the other stack alerts say so).
- **First:** `docker compose ps` and `docker compose logs --tail 200 orchestrator`;
  try `deploy/smoke.sh`. Fleet dashboard once it's back.

### Creates/starts failing broadly

`ozwell-operations-failing` · critical

- **Means:** users can't get a working computer.
- **Fires when:** more than half of the creates (or of the starts) failed over 30 minutes,
  with at least 3 failures, for 5 minutes. Failures are provider errors, computers that
  reported a failure, and computers not ready within the timeout (10 min).
- **Likely causes:** the provider is out of capacity or its API is failing (see
  "Provider API failing"), a broken computer image, network problems between the
  orchestrator and new computers.
- **First:** Operations dashboard (failures by outcome, the phase they stop in, recent
  traces); orchestrator logs for the provider's error message.

### Tool calls failing internally

`ozwell-tool-calls-internal` · critical

- **Means:** agents' tool calls fail because something is broken, not because of the
  agent. Agent mistakes (bad arguments, missing files, stopped computers, quota) are not
  counted.
- **Fires when:** more than 10% of all tool calls in 15 minutes failed with reason
  `internal`, at least 5 of them, for 5 minutes.
- **Likely causes:** a bug in the orchestrator or the computer, a computer erroring on
  every call, the provider failing during lookups.
- **First:** Tool calls dashboard (which tools, error rate); orchestrator logs, search
  `tool failed`; open a recent failing trace.

### Provider API failing

`ozwell-provider-api-failing` · critical

- **Means:** calls to the Docker daemon or the opensource-server manager return errors.
  Listing, creating, starting and looking up computers are affected.
- **Fires when:** more than a quarter of the calls of one kind (list, get, create, ...)
  failed over 10 minutes, for 10 minutes.
- **Likely causes:** the manager is down or rejects the API key, the Docker daemon is
  unavailable, network or DNS problems.
- **First:** orchestrator logs for the error; check the provider directly (opensource-server
  status, `docker info` on the host). Operations dashboard for which calls fail.

### Service discovery failing

`ozwell-service-discovery-failing` · warning

- **Means:** the orchestrator can't list all computers. Monitoring keeps the last list, so
  new computers aren't scraped and computer details on dashboards go stale.
- **Fires when:** more than half of the listings failed over 10 minutes, for 10 minutes.
- **Likely causes:** the same as "Provider API failing" (often fires with it).
- **First:** orchestrator logs, search `service discovery failed`.

### New computers slow to become ready

`ozwell-create-slow` · warning

- **Means:** creating a computer works but takes too long; agents may time out waiting.
- **Fires when:** the 95th percentile of successful creates over the last hour is above
  3 minutes, with at least 3 creates, for 15 minutes.
- **Likely causes:** a busy or slow provider host, slow image pulls, slow boot.
- **First:** Operations dashboard: the phase breakdown shows whether time goes to the
  provider (enqueue, provision) or the computer's boot.

### Logs not reaching VictoriaLogs

`ozwell-log-shipping-failing` · warning

- **Means:** the orchestrator pulls computers' logs but can't store them. A failed batch
  is retried from the same position, so logs are delayed, not lost, as long as it
  recovers in time. They are lost if a computer's journal rotates past the retried
  position, or if the orchestrator restarts meanwhile (it keeps positions in memory and
  resumes from "now").
- **Fires when:** any pulled batch failed to be stored, in every 15-minute window, for
  15 minutes.
- **Likely causes:** VictoriaLogs is down, out of disk, or rejecting data (see the stack
  alerts).
- **First:** `docker compose logs --tail 100 victorialogs`; Fleet dashboard, log pulls panel.

### Orchestrator logging errors

`ozwell-orchestrator-log-errors` · warning

- **Means:** the orchestrator logged errors (level error or fatal). A catch-all for
  problems the other alerts don't cover.
- **Fires when:** at least 5 error records in 15 minutes.
- **Likely causes:** anything; the log messages say.
- **First:** Orchestrator logs dashboard; filter on errors and follow the trace link.

## Computers

These only fire while the orchestrator is up (see "How the emails work").

### Running computer unreachable

`ozwell-computer-unreachable` · warning

- **Means:** a computer the provider reports as running doesn't answer; its user's tool
  calls likely fail. Stopped computers never fire this.
- **Fires when:** the orchestrator couldn't reach the computer for 10 minutes.
- **Likely causes:** the computer's server crashed or is restarting, its network or URL
  changed, the computer is overloaded. If its X display (desktop) dies, the server stops
  with it, so that shows here too: there is no separate X display alert, because a
  computer without X can't be reached to report it.
- **First:** the Instance drill-down link in the email (its logs, last metrics); restart
  the computer if it doesn't recover.

### Computer stalled on memory/CPU/I/O

`ozwell-computer-pressure` · warning

- **Means:** the computer spends a lot of its time waiting for memory, CPU or disk: it is
  slow, and tool calls may time out.
- **Fires when:** over 10 minutes, all its processes were stalled more than 10% of the
  time, or some were stalled more than 50% of the time, for 10 minutes. The email says
  which resource.
- **Likely causes:** the agent runs something heavy (builds, browsers with many tabs),
  a memory limit that's too small, a busy host.
- **First:** Instance drill-down: pressure, memory and CPU panels, and per-service usage.

### Computer near its memory limit

`ozwell-computer-memory-near-limit` · warning

- **Means:** the computer uses more than 90% of its memory limit; it may start killing
  processes. Includes file cache, which is freed when needed, so check pressure too.
- **Fires when:** above 90% of the limit for 10 minutes.
- **Likely causes:** as above.
- **First:** Instance drill-down memory panels; if pressure is also high, raise the limit
  or stop what's running.

## The monitoring stack

### Stack component down

`ozwell-stack-down` · warning

- **Means:** VictoriaLogs, VictoriaTraces, VictoriaMetrics or vmagent isn't answering. Its
  data (logs, traces, metrics) is missing while it lasts.
- **Fires when:** it couldn't be scraped for 5 minutes. (If VictoriaMetrics or vmagent is
  down, you are more likely to get "Orchestrator down" instead, since nothing is stored.)
- **First:** `docker compose ps`; `docker compose logs --tail 100 <service>`.

### Stack storage low or read-only

`ozwell-stack-disk-low` · warning

- **Means:** a monitoring database is running out of disk, or has already stopped
  accepting data (read-only).
- **Fires when:** less than 5 GiB free on its volume, or read-only, for 5 minutes.
- **First:** `df -h` on the host; free space, or shorten the retention in `compose.yml`.

### Stack ingestion errors

`ozwell-stack-ingestion-errors` · warning

- **Means:** a monitoring service is dropping or rejecting data it receives.
- **Fires when:** any rows dropped or writes rejected in every 15-minute window, for
  15 minutes.
- **Likely causes:** bad timestamps (a computer's clock is off), too-large records,
  storage problems.
- **First:** `docker compose logs --tail 100 <service>` says why.

### vmagent remote-write backlog

`ozwell-stack-remote-write-backlog` · warning

- **Means:** vmagent collects metrics faster than it can store them; they arrive late, or
  are lost if the queue overflows.
- **Fires when:** more than 100 MiB queued, or anything dropped, for 15 minutes.
- **Likely causes:** VictoriaMetrics is slow or down, the host's disk is slow or full.
- **First:** `docker compose logs --tail 100 vmagent victoriametrics`.
