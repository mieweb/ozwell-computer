// Instance tracing (docs/observability-plan.md, workstream 4; issue #64).
//
// The computer records spans for the work it does for a request (screenshot capture vs.
// encode, input injection, exec, accessibility) and keeps finished spans in a bounded
// in-memory buffer. The orchestrator pulls them from GET /api/v1/traces as OTLP JSON and
// forwards them to VictoriaTraces: the computer never knows where telemetry goes.
//
// - Spans continue the incoming W3C traceparent (HTTP header, or MCP params._meta), so they
//   nest under the orchestrator's instance.callTool span.
// - Only request work is traced: withSpan() outside a traced request is a no-op, so polling,
//   timers and other background work never create spans.
// - Cost is bounded: the buffer holds at most maxSpans (oldest dropped first), spans carry at
//   most MAX_ATTRS attributes of at most MAX_VALUE characters, and one response is capped in
//   spans and bytes. No OpenTelemetry SDK: this is a few hundred bytes per span.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { parseTraceparent } from './trace-context.js';

export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue | undefined>;

/** OTLP SpanKind. */
export const SpanKind = { INTERNAL: 1, SERVER: 2 } as const;

const MAX_ATTRS = 32;
const MAX_VALUE = 1024;
const MAX_NAME = 256;

interface Context { traceId: string; spanId: string }

interface FinishedSpan {
  seq: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  start: bigint;
  end: bigint;
  attrs: Record<string, AttrValue>;
  error?: string;
  /** Approximate serialized size, for the response byte cap. */
  size: number;
}

/** Wall clock in nanoseconds, with sub-millisecond resolution. */
function nowNs(): bigint {
  const ms = performance.timeOrigin + performance.now();
  return BigInt(Math.floor(ms * 1000)) * 1000n;
}

const hexId = (bytes: number) => {
  for (;;) {
    const id = randomBytes(bytes).toString('hex');
    if (!/^0+$/.test(id)) return id;
  }
};

export class Span {
  private readonly attrs: Record<string, AttrValue> = {};
  private ended = false;
  private error?: string;
  readonly start = nowNs();

  constructor(
    private readonly tracer: Tracer,
    readonly ctx: Context,
    readonly name: string,
    readonly kind: number,
    readonly parentSpanId: string | undefined,
    attrs?: Attrs,
  ) {
    if (attrs) this.set(attrs);
  }

  set(attrs: Attrs): this {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined) continue;
      if (!(k in this.attrs) && Object.keys(this.attrs).length >= MAX_ATTRS) continue;
      this.attrs[k.slice(0, MAX_NAME)] = typeof v === 'string' ? v.slice(0, MAX_VALUE) : v;
    }
    return this;
  }

  /** Mark the span failed. The first failure wins (a caller may record a redacted one first). */
  fail(e: unknown) {
    if (this.error !== undefined) return;
    const err = e as { message?: unknown; reason?: unknown } | null;
    this.error = String(err?.message ?? e).slice(0, MAX_VALUE);
    if (typeof err?.reason === 'string') this.set({ 'error.type': err.reason });
  }

  /**
   * Fail with only the error's reason/code, not its message: for work whose errors can echo
   * user input that may carry secrets (a command line, a path).
   */
  failRedacted(e: unknown, what: string) {
    const err = e as { reason?: unknown; code?: unknown } | null;
    const kind = typeof err?.reason === 'string' ? err.reason : typeof err?.code === 'string' ? err.code : 'error';
    this.fail({ message: `${what} failed (${kind})`, reason: kind });
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.tracer.record({
      seq: 0, traceId: this.ctx.traceId, spanId: this.ctx.spanId, parentSpanId: this.parentSpanId,
      name: this.name.slice(0, MAX_NAME), kind: this.kind, start: this.start, end: nowNs(), attrs: this.attrs, error: this.error, size: 0,
    });
  }
}

export interface TracerOptions {
  /** Finished spans kept for the puller (default 4096); the oldest are dropped first. */
  maxSpans?: number;
  resource?: Attrs;
}

export interface Collected {
  /** OTLP JSON ExportTraceServiceRequest. */
  body: { resourceSpans: unknown[] };
  spans: number;
  /** Pass back as ?cursor= to get the spans after these. */
  cursor: string;
  /** Spans that were dropped (buffer full) between the given cursor and this response. */
  dropped: number;
  /** More spans are waiting (a limit was hit). */
  more: boolean;
}

export class Tracer {
  private readonly als = new AsyncLocalStorage<Context>();
  private readonly maxSpans: number;
  private buf: FinishedSpan[] = [];
  /** Sequence number of the last recorded span. */
  private seq = 0;
  /** Changes per process, so a cursor from before a restart is recognized. */
  readonly boot = hexId(4);
  private resource: Attrs;

  constructor(opts: TracerOptions = {}) {
    this.maxSpans = Math.max(1, opts.maxSpans ?? 4096);
    this.resource = { 'service.name': 'ozwell-computer', 'host.name': hostname(), ...opts.resource };
  }

  setResource(attrs: Attrs) { this.resource = { ...this.resource, ...attrs }; }

  /** The active span's context, if any. */
  active(): Context | undefined { return this.als.getStore(); }

  /**
   * Start a span. Without `parent` it is a child of the active span; with a traceparent it
   * continues that trace; with neither it starts a new trace (`root`) or returns null.
   */
  start(name: string, o: { traceparent?: unknown; kind?: number; attrs?: Attrs; root?: boolean } = {}): Span | null {
    const remote = parseTraceparent(o.traceparent);
    const active = this.active();
    let traceId: string, parent: string | undefined;
    // Prefer the active span when it is in the same trace (e.g. an MCP tool call inside the
    // traced HTTP request whose _meta carries the caller's span): keeps the nesting intact.
    if (active && (!remote || remote.trace_id === active.traceId)) { traceId = active.traceId; parent = active.spanId; }
    else if (remote) { traceId = remote.trace_id; parent = remote.span_id; }
    else if (o.root) { traceId = hexId(16); parent = undefined; }
    else return null;
    return new Span(this, { traceId, spanId: hexId(8) }, name, o.kind ?? SpanKind.INTERNAL, parent, o.attrs);
  }

  /** Run fn with span as the active span. */
  runWith<T>(span: Span | null, fn: () => T): T {
    return span ? this.als.run(span.ctx, fn) : fn();
  }

  /**
   * Run fn in a child span of the active span. Outside a traced request (background work) it
   * just runs fn. Errors mark the span failed and are rethrown.
   */
  async withSpan<T>(name: string, attrs: Attrs | undefined, fn: (span: Span | null) => Promise<T> | T, o: { traceparent?: unknown } = {}): Promise<T> {
    const span = this.start(name, { attrs, traceparent: o.traceparent });
    if (!span) return fn(null);
    try {
      return await this.als.run(span.ctx, () => fn(span));
    } catch (e) {
      span.fail(e);
      throw e;
    } finally {
      span.end();
    }
  }

  record(s: FinishedSpan) {
    s.seq = ++this.seq;
    s.size = 260 + s.name.length + (s.error?.length ?? 0) + Object.entries(s.attrs).reduce((n, [k, v]) => n + k.length + String(v).length + 40, 0);
    this.buf.push(s);
    if (this.buf.length > this.maxSpans) this.buf.splice(0, this.buf.length - this.maxSpans);
  }

  /** Spans in the buffer (tests). */
  get size() { return this.buf.length; }

  /**
   * Finished spans after `cursor` (from a previous response; absent or from another boot:
   * everything buffered), at most `limit` spans and about `maxBytes` of JSON.
   */
  collect(cursor: string | undefined, limit = 1000, maxBytes = 4 * 1024 * 1024): Collected {
    const m = cursor ? /^([0-9a-f]+):(\d+)$/.exec(cursor) : null;
    // "end": no spans, only a cursor at the end (a puller's first pull doesn't backfill).
    // A cursor from this buffer, including boot:0 (cursor=end before any span was recorded).
    const known = cursor === 'end' || (!!m && m[1] === this.boot && Number(m[2]) <= this.seq);
    const after = cursor === 'end' ? this.seq : known ? Number(m![2]) : 0;
    const first = this.buf.length ? this.buf[0].seq : this.seq + 1;
    const dropped = known ? Math.max(0, first - after - 1) : 0;
    const out: FinishedSpan[] = [];
    let bytes = 0;
    let more = false;
    for (let i = Math.max(0, after - first + 1); i < this.buf.length; i++) {
      const s = this.buf[i];
      if (out.length >= limit || (out.length > 0 && bytes + s.size > maxBytes)) { more = true; break; }
      out.push(s);
      bytes += s.size;
    }
    const last = out.length ? out[out.length - 1].seq : Math.max(after, first - 1);
    return { body: this.otlp(out), spans: out.length, cursor: `${this.boot}:${last}`, dropped, more };
  }

  private otlp(spans: FinishedSpan[]): { resourceSpans: unknown[] } {
    if (!spans.length) return { resourceSpans: [] };
    return {
      resourceSpans: [{
        resource: { attributes: kvs(this.resource) },
        scopeSpans: [{
          scope: { name: 'ozwell-computer' },
          spans: spans.map((s) => ({
            traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
            name: s.name, kind: s.kind,
            startTimeUnixNano: String(s.start), endTimeUnixNano: String(s.end),
            attributes: kvs(s.attrs),
            status: s.error ? { code: 2, message: s.error } : {},
          })),
        }],
      }],
    };
  }
}

function kvs(attrs: Attrs) {
  return Object.entries(attrs).filter(([, v]) => v !== undefined).map(([key, v]) => ({
    key,
    value: typeof v === 'string' ? { stringValue: v }
      : typeof v === 'boolean' ? { boolValue: v }
        : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v },
  }));
}

/** The process-wide tracer. */
export const tracer = new Tracer();

/** Shorthand for tracer.withSpan. */
export const withSpan = <T>(name: string, attrs: Attrs | undefined, fn: (span: Span | null) => Promise<T> | T) => tracer.withSpan(name, attrs, fn);
