// Operation timing (docs/observability-plan.md, workstream 1).
//
// An operation is one logical intent (create, start, destroy, list, get) whose lifetime is
// independent of the tool calls that observe it. It starts when the provider call is issued
// and completes when its terminal condition is first seen:
//   create / start  /health answers 204         (phases: enqueue → provision → boot)
//   destroy         the provider no longer has it (phases: enqueue → provision)
//   list / get      the call returns              (phase: enqueue)
// A background watcher polls in-flight create/start/destroy operations, so completion is
// recorded even when no client keeps polling. In memory only: a restart drops them.
//
// Each operation is its own trace (`operation.<op>`, a root span) so a create-to-ready trace
// can be long while tool-call traces stay short; tool-call spans link to it.
import { ROOT_CONTEXT, SpanStatusCode, trace, type Link, type Span } from '@opentelemetry/api';
import type { Computer } from './providers/types.ts';
import type { Metrics } from './metrics.ts';

export type OpKind = 'create' | 'start' | 'destroy' | 'list' | 'get';
export type Phase = 'enqueue' | 'provision' | 'boot';
export type Outcome = 'ok' | 'error' | 'failed' | 'timeout';

/** Re-reads a computer and checks its /health (mcp.ts `isReady`). */
export type Probe = (id: string) => Promise<{ c: Computer | null; ready: boolean }>;

const DEAD = ['failed', 'missing', 'dead'];
const tracer = trace.getTracer('ozwell-computer-orchestrator');

export class Operation {
  id: string | undefined;
  phase: Phase = 'enqueue';
  outcome: Outcome | undefined;
  readonly span: Span;
  private phaseStart: number;
  /** Set while the watcher is polling it, so slow probes never overlap. */
  polling = false;

  private readonly tracker: OperationTracker;
  readonly kind: OpKind;
  readonly provider: string;
  readonly startedAt: number;

  constructor(tracker: OperationTracker, kind: OpKind, provider: string, startedAt: number, id?: string) {
    this.tracker = tracker;
    this.kind = kind;
    this.provider = provider;
    this.startedAt = startedAt;
    this.id = id;
    this.phaseStart = startedAt;
    // A root span: the operation's own trace, independent of the tool call that began it.
    this.span = tracer.startSpan(`operation.${kind}`, {
      root: true, startTime: startedAt,
      attributes: { 'ozwell.operation': kind, 'ozwell.provider': provider, ...(id ? { 'ozwell.instance_id': id } : {}) },
    }, ROOT_CONTEXT);
  }

  get done() { return this.outcome !== undefined; }

  /** A link for tool-call spans that start or observe this operation. */
  link(): Link { return { context: this.span.spanContext(), attributes: { 'ozwell.operation': this.kind } }; }

  /** The provider API call returned. list/get are complete; the others are now provisioning. */
  enqueued(c?: Computer | null) {
    // A repeated start joins this operation: its provider call returning must not reset the phase.
    if (this.done || this.phase !== 'enqueue') { if (c && !this.done) this.progress(c, false); return; }
    if (c?.id && !this.id) this.tracker.bind(this, c.id);
    this.enterPhase('provision');
    if (this.kind === 'list' || this.kind === 'get') this.finish('ok');
    else if (this.kind === 'destroy') return;
    else if (c) this.progress(c, false);
  }

  /** Apply one observation of the computer (from the watcher or a client's poll). */
  progress(c: Computer | null, healthy: boolean) {
    if (this.done) return;
    if (this.kind === 'destroy') { if (!c) this.finish('ok'); return; }
    if (!c || DEAD.includes(c.status)) { this.finish('failed', c ? `status ${c.status}` : 'computer disappeared'); return; }
    if (this.phase === 'provision' && !c.stopped && c.internalUrl) this.enterPhase('boot');
    if (healthy && !c.stopped) {
      if (this.phase === 'provision') this.enterPhase('boot');
      this.finish('ok');
    }
  }

  fail(e: unknown) { this.finish('error', (e as Error)?.message ?? String(e)); }

  private enterPhase(next: Phase) {
    const now = this.tracker.now();
    this.tracker.metrics?.operationPhase.observe({ provider: this.provider, operation: this.kind, phase: this.phase }, (now - this.phaseStart) / 1000);
    this.span.addEvent(`phase.${next}`, { 'ozwell.previous_phase': this.phase, 'ozwell.phase_seconds': (now - this.phaseStart) / 1000 }, now);
    this.phase = next;
    this.phaseStart = now;
  }

  /** @internal */
  finish(outcome: Outcome, message?: string) {
    if (this.done) return;
    const now = this.tracker.now();
    // The phase the operation ended in is timed too (e.g. boot, up to ready).
    this.tracker.metrics?.operationPhase.observe({ provider: this.provider, operation: this.kind, phase: this.phase }, (now - this.phaseStart) / 1000);
    this.outcome = outcome;
    this.span.setAttributes({ 'ozwell.outcome': outcome, 'ozwell.final_phase': this.phase, ...(this.id ? { 'ozwell.instance_id': this.id } : {}) });
    if (outcome !== 'ok') {
      this.span.setStatus({ code: SpanStatusCode.ERROR, message: message ?? outcome });
      this.span.setAttribute('error.type', outcome);
    }
    this.span.end(now);
    this.tracker.finished(this, now);
  }
}

export interface OperationTrackerOptions {
  provider: string;
  probe: Probe;
  metrics?: Metrics;
  /** Watcher poll interval (default 1500 ms). */
  pollMs?: number;
  /** Give up on create/start/destroy after this long (ORCHESTRATOR_OP_TIMEOUT_MS, default 10 min). */
  timeoutMs?: number;
  /** Probes run at once (default 8). */
  concurrency?: number;
  /** Clock, in epoch ms (tests). */
  now?: () => number;
}

export class OperationTracker {
  readonly metrics: Metrics | undefined;
  readonly now: () => number;
  private readonly byId = new Map<string, Operation>();
  private readonly unbound = new Set<Operation>();
  /** create start times, kept until a client first sees ready:true (observed time-to-ready). */
  private readonly createdAt = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private readonly opts: Required<Omit<OperationTrackerOptions, 'metrics' | 'now'>>;

  constructor(opts: OperationTrackerOptions) {
    this.metrics = opts.metrics;
    this.now = opts.now ?? Date.now;
    this.opts = { provider: opts.provider, probe: opts.probe, pollMs: opts.pollMs ?? 1500, timeoutMs: opts.timeoutMs ?? 600_000, concurrency: opts.concurrency ?? 8 };
  }

  /** Start the background watcher. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pollOnce(); }, this.opts.pollMs);
    this.timer.unref();
  }

  stop() { clearInterval(this.timer); this.timer = undefined; }

  /**
   * Begin an operation. A create/start/destroy already in flight for the same computer and
   * kind is returned instead of a second one (e.g. repeated start_computer calls).
   */
  begin(kind: OpKind, id?: string): Operation {
    if (id && kind !== 'list' && kind !== 'get') {
      const cur = this.byId.get(id);
      if (cur && !cur.done && cur.kind === kind) return cur;
      // e.g. destroy during a create: the create never completes, so end it now.
      if (cur && !cur.done) cur.finish('error', `superseded by ${kind}`);
    }
    const op = new Operation(this, kind, this.opts.provider, this.now(), id);
    this.metrics?.operationsInFlight.inc({ provider: op.provider, operation: kind });
    if (kind === 'list' || kind === 'get') return op; // never watched
    if (id) this.track(op, id); else this.unbound.add(op);
    return op;
  }

  /** Time a list/get call as an operation that completes when it returns. `onBegin` sees the
   * operation before the call (e.g. to link the tool-call span to it). */
  async timed<T>(kind: 'list' | 'get', fn: () => Promise<T>, onBegin?: (op: Operation) => void): Promise<T> {
    const op = this.begin(kind);
    onBegin?.(op);
    try {
      const r = await fn();
      op.enqueued();
      return r;
    } catch (e) {
      op.fail(e);
      throw e;
    }
  }

  /** The in-flight create/start/destroy for a computer, if any. */
  inFlight(id: string): Operation | undefined {
    const op = this.byId.get(id);
    return op && !op.done ? op : undefined;
  }

  /**
   * A tool call saw this computer's readiness (create/get/start_computer). Feeds the in-flight
   * operation, and the first ready:true after a create records observed time-to-ready.
   */
  observe(c: Computer, ready: boolean) {
    this.inFlight(c.id)?.progress(c, ready);
    if (!ready) return;
    const t0 = this.createdAt.get(c.id);
    if (t0 === undefined) return;
    this.createdAt.delete(c.id);
    this.metrics?.timeToReadyObserved.observe({ provider: this.opts.provider }, (this.now() - t0) / 1000);
  }

  private pass: Promise<void> | undefined;

  /** One watcher pass: probe every in-flight create/start/destroy (capped concurrency). A pass
   * still running is shared, so slow probes never overlap and the cap holds across ticks. */
  pollOnce(): Promise<void> {
    this.pass ??= this.runPass().finally(() => { this.pass = undefined; });
    return this.pass;
  }

  private async runPass(): Promise<void> {
    const now = this.now();
    for (const op of this.unbound) if (now - op.startedAt >= this.opts.timeoutMs) op.finish('timeout', 'no computer id');
    for (const op of this.byId.values()) {
      if (!op.done && now - op.startedAt >= this.opts.timeoutMs) op.finish('timeout', `not done after ${this.opts.timeoutMs} ms`);
    }
    // Probed only once the provider call returned (enqueue is timed by the call itself).
    const queue = [...this.byId.values()].filter((op) => !op.done && !op.polling && op.phase !== 'enqueue');
    const worker = async () => {
      for (let op = queue.shift(); op; op = queue.shift()) {
        op.polling = true;
        try {
          const { c, ready } = await this.opts.probe(op.id!);
          op.progress(c, ready);
        } catch { /* transient: try again next pass */ } finally {
          op.polling = false;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.concurrency, queue.length) }, worker));
    // Forget observed-time-to-ready starts nobody ever polled to ready.
    for (const [id, t0] of this.createdAt) if (now - t0 > this.opts.timeoutMs * 2) this.createdAt.delete(id);
  }

  /** @internal An unbound create learned its computer id. */
  bind(op: Operation, id: string) {
    op.id = id;
    op.span.setAttribute('ozwell.instance_id', id);
    this.unbound.delete(op);
    this.track(op, id);
  }

  private track(op: Operation, id: string) {
    this.byId.set(id, op);
    if (op.kind === 'create') this.createdAt.set(id, op.startedAt);
  }

  /** @internal */
  finished(op: Operation, now: number) {
    const labels = { provider: op.provider, operation: op.kind };
    const traceId = op.span.spanContext().traceId;
    const exemplarLabels: Record<string, string> | undefined = op.span.spanContext().traceFlags & 1 ? { trace_id: traceId } : undefined;
    this.metrics?.operationDuration.observe({ labels: { ...labels, outcome: op.outcome! }, value: (now - op.startedAt) / 1000, exemplarLabels });
    this.metrics?.operations.inc({ ...labels, outcome: op.outcome! });
    this.metrics?.operationsInFlight.dec(labels);
    this.unbound.delete(op);
    if (op.id && this.byId.get(op.id) === op) this.byId.delete(op.id);
    if (op.kind === 'create' && op.outcome !== 'ok' && op.id) this.createdAt.delete(op.id);
  }
}
