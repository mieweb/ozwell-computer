// Orchestrator Prometheus metrics, served on the internal listener's /metrics and pulled
// by vmagent (no OTLP metrics push). OpenMetrics format so histograms carry exemplars
// with the trace id of an observation, for metrics → trace jumps in Grafana.
import { trace } from '@opentelemetry/api';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics, type OpenMetricsContentType } from 'prom-client';
import type { ProviderCallObserver } from './instrument-provider.ts';
import { observedOwner, type Computer } from './providers/types.ts';

/** trace_id of the active span, as exemplar labels; none when untraced. */
export function exemplar(): Record<string, string> | undefined {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx && ctx.traceId !== '00000000000000000000000000000000' ? { trace_id: ctx.traceId } : undefined;
}

export class Metrics {
  readonly registry = (() => {
    const r = new Registry<OpenMetricsContentType>();
    r.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
    return r;
  })();

  readonly toolCallDuration = new Histogram({
    name: 'ozwell_orchestrator_tool_call_duration_seconds',
    help: 'MCP tools/call duration as seen by the orchestrator',
    labelNames: ['tool', 'outcome'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 40, 60, 120, 300, 600],
    enableExemplars: true,
    registers: [this.registry],
  });

  readonly toolCalls = new Counter({
    name: 'ozwell_orchestrator_tool_calls_total',
    help: 'MCP tools/call requests handled',
    labelNames: ['tool', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly providerCallDuration = new Histogram({
    name: 'ozwell_orchestrator_provider_call_duration_seconds',
    help: 'Duration of a single provider API method call',
    labelNames: ['provider', 'method', 'outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    enableExemplars: true,
    registers: [this.registry],
  });

  // Operations (operations.ts): one logical create/start/destroy/list/get, end to end.
  readonly operationDuration = new Histogram({
    name: 'ozwell_orchestrator_operation_duration_seconds',
    help: 'Provider operation duration, from the request until the result is usable',
    labelNames: ['provider', 'operation', 'outcome'] as const,
    buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 45, 60, 90, 120, 180, 300, 600, 900],
    enableExemplars: true,
    registers: [this.registry],
  });

  readonly operationPhase = new Histogram({
    name: 'ozwell_orchestrator_operation_phase_seconds',
    help: 'Time spent in each operation phase: enqueue (provider API call), provision (until running), boot (until /health is 204)',
    labelNames: ['provider', 'operation', 'phase'] as const,
    buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 45, 60, 90, 120, 180, 300, 600, 900],
    registers: [this.registry],
  });

  readonly operations = new Counter({
    name: 'ozwell_orchestrator_operations_total',
    help: 'Provider operations finished',
    labelNames: ['provider', 'operation', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly operationsInFlight = new Gauge({
    name: 'ozwell_orchestrator_operations_in_flight',
    help: 'Provider operations started and not yet finished',
    labelNames: ['provider', 'operation'] as const,
    registers: [this.registry],
  });

  readonly timeToReadyObserved = new Histogram({
    name: 'ozwell_orchestrator_time_to_ready_observed_seconds',
    help: 'From create until the first tool call that reported ready:true (what a client experiences)',
    labelNames: ['provider'] as const,
    buckets: [1, 2.5, 5, 10, 20, 30, 40, 60, 90, 120, 180, 300, 600, 900],
    registers: [this.registry],
  });

  // Computer metadata as its own series (the "info metric" pattern): computers' scraped
  // series carry only instance_id and provider, so changing metadata never splits them.
  // Join it in queries: ... * on (instance_id) group_left (user) ozwell_orchestrator_computer_info
  readonly computerInfo = new Gauge({
    name: 'ozwell_orchestrator_computer_info',
    help: 'Always 1, one series per computer; labels carry its metadata (user is the owner email, else id)',
    labelNames: ['instance_id', 'provider', 'user', 'display_name', 'created_at'] as const,
    registers: [this.registry],
  });

  /** Replace the computer metadata series with these computers. */
  setComputers(computers: Computer[], provider: string) {
    this.computerInfo.reset();
    for (const c of computers) {
      const labels: Partial<Record<'instance_id' | 'provider' | 'user' | 'display_name' | 'created_at', string>> =
        { instance_id: c.id, provider, user: observedOwner(c) };
      if (c.displayName) labels.display_name = c.displayName;
      if (c.createdAt) labels.created_at = c.createdAt;
      this.computerInfo.set(labels, 1);
    }
  }

  readonly computerCache = new Counter({
    name: 'ozwell_orchestrator_computer_cache_total',
    help: 'Computer lookups for desktop tool calls: hit (no provider call), miss, or revalidated (a cached entry failed and was looked up again)',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  // Instance log puller (log-puller.ts).
  readonly logPulls = new Counter({
    name: 'ozwell_orchestrator_log_pulls_total',
    help: 'Instance journal pulls, by outcome: ok, unsupported (no logs route: an older instance), unauthorized, unavailable, ship_error, error',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly logEntriesShipped = new Counter({
    name: 'ozwell_orchestrator_log_entries_shipped_total',
    help: 'Instance journal entries forwarded to VictoriaLogs',
    registers: [this.registry],
  });

  readonly logPullUnsupported = new Gauge({
    name: 'ozwell_orchestrator_log_pull_unsupported_instances',
    help: 'Running instances whose version has no logs route (re-checked periodically)',
    registers: [this.registry],
  });

  constructor(opts: { defaultMetrics?: boolean } = {}) {
    if (opts.defaultMetrics ?? true) collectDefaultMetrics({ register: this.registry, prefix: 'ozwell_orchestrator_' });
  }

  observeToolCall(tool: string, outcome: string, seconds: number) {
    const labels = { tool, outcome };
    this.toolCallDuration.observe({ labels, value: seconds, exemplarLabels: exemplar() });
    this.toolCalls.inc(labels);
  }

  /** Pass to instrumentProvider. */
  readonly onProviderCall: ProviderCallObserver = ({ provider, method, seconds, outcome }) => {
    this.providerCallDuration.observe({ labels: { provider, method, outcome }, value: seconds, exemplarLabels: exemplar() });
  };
}
