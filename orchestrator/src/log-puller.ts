// Instance log puller (docs/observability-plan.md, workstream 3).
//
// Every running computer's journal is pulled from its gatewayd-compatible
// GET /api/v1/logs/entries in the Journal Export Format, tagged with OZWELL_INSTANCE_ID,
// OZWELL_USER and OZWELL_PROVIDER, and forwarded to VictoriaLogs' /insert/journald/upload.
// Instances never need to know where logs go.
//
// - The first pull for an instance (including after an orchestrator restart) starts at
//   "now": nothing is backfilled. Later pulls continue after the last __CURSOR, which only
//   advances once VictoriaLogs accepted the batch.
// - Older instances without the route answer 404: they are skipped and re-checked every
//   recheckMs (and as soon as they reappear after a stop). 401 backs off the same way;
//   other failures back off exponentially. One instance never delays another.
// - Stopped or destroyed instances are dropped; there is no drain before destroy.
//
// Instance traces (workstream 4, issue #64) ride the same loop as a second stream per
// instance: finished spans are pulled from GET /api/v1/traces (OTLP JSON, from the
// computer's bounded span buffer), tagged with ozwell.instance_id, ozwell.user and
// ozwell.provider, re-encoded as OTLP protobuf (otlp.ts) and posted to VictoriaTraces.
// Discovery, scheduling, backoff and the 404 handling for older computers are shared; each
// stream has its own cursor and backoff. As with logs, the first pull starts at "now"
// (cursor=end): spans buffered before are not backfilled.
import { otlpJsonToProto } from './otlp.ts';
import type { Metrics } from './metrics.ts';
import { untraced } from './untraced.ts';
import { observedOwner, type Computer, type Provider } from './providers/types.ts';

export interface LogLogger { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }

export interface LogPullerOptions {
  provider: Provider;
  /** VictoriaLogs journald ingest, e.g. http://victorialogs:9428/insert/journald/upload
   * (the path systemd-journal-upload posts to: /insert/journald alone is a 400). Unset: no logs. */
  shipUrl?: string;
  /** VictoriaTraces OTLP/HTTP traces ingest, e.g.
   * http://victoriatraces:10428/insert/opentelemetry/v1/traces. Unset: no instance traces. */
  traceShipUrl?: string;
  /** Spans per trace pull (default 1000). */
  traceBatch?: number;
  metrics?: Metrics;
  log?: LogLogger;
  /** Between pulls of one instance (ORCHESTRATOR_LOG_POLL_MS, default 5000). */
  pollMs?: number;
  /** Instance pulls in flight at once (default 8). */
  concurrency?: number;
  /** How often the instance list is refreshed (default 15 s). */
  discoverMs?: number;
  /** Re-check an instance without the route, or that refused its token (default 10 min). */
  recheckMs?: number;
  /** Longest error backoff (default 5 min). */
  maxBackoffMs?: number;
  /** Entries per pull (default 1000). */
  batch?: number;
  /** Bytes read from one journal or traces response (default 16 MiB); the rest waits for the next pull. */
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  now?: () => number;
}

type Outcome = 'ok' | 'unsupported' | 'unauthorized' | 'unavailable' | 'ship_error' | 'error';

type Stream = 'logs' | 'traces';

interface InstanceState {
  stream: Stream;
  id: string;
  /** Start of the first pull's realtime range (epoch seconds). */
  since: number;
  cursor?: string;
  nextAt: number;
  failures: number;
  /** The last non-ok outcome that was logged, so it is logged once, not per poll. */
  reported?: Outcome;
  busy: boolean;
  /** The last pull filled a whole batch: more is waiting. */
  more?: boolean;
  /** Traces: spans to ask for; halved while responses exceed maxResponseBytes. */
  limit?: number;
}

export const JOURNAL_EXPORT = 'application/vnd.fdo.journal';

/** One field in the Journal Export Format: text when it can be, else the binary form. */
export function exportField(key: string, value: string): Buffer {
  if (!value.includes('\n')) return Buffer.from(`${key}=${value}\n`);
  const data = Buffer.from(value);
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(data.length));
  return Buffer.concat([Buffer.from(`${key}\n`), len, data, Buffer.from('\n')]);
}

/**
 * Split a Journal Export Format stream into entries, adding `extra` fields to each.
 * Returns the tagged stream, the entry count and the last __CURSOR. A trailing partial
 * entry (a stream cut short) is dropped; the next pull resumes from the last cursor.
 */
export function tagExport(buf: Buffer, extra: Buffer): { body: Buffer; entries: number; cursor?: string } {
  const out: Buffer[] = [];
  let entries = 0;
  let cursor: string | undefined;
  let entryStart = 0;
  let entryCursor: string | undefined;
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    if (nl < 0) break; // partial line
    if (nl === i) {
      // Blank line: the entry ends. Tag it before its terminator.
      if (i > entryStart) {
        out.push(buf.subarray(entryStart, i), extra, Buffer.from('\n'));
        entries++;
        if (entryCursor) cursor = entryCursor;
      }
      i = nl + 1;
      entryStart = i;
      entryCursor = undefined;
      continue;
    }
    const line = buf.subarray(i, nl);
    const eq = line.indexOf(0x3d);
    if (eq >= 0) {
      if (line.subarray(0, eq).toString() === '__CURSOR') entryCursor = line.subarray(eq + 1).toString();
      i = nl + 1;
    } else {
      // Binary field: KEY\n, 64-bit little-endian length, data, \n.
      const lenAt = nl + 1;
      if (lenAt + 8 > buf.length) break;
      const len = Number(buf.readBigUInt64LE(lenAt));
      const end = lenAt + 8 + len;
      if (end + 1 > buf.length) break;
      i = end + 1;
    }
  }
  return { body: Buffer.concat(out), entries, cursor };
}

/** Read at most `limit` bytes of a body, then cancel the rest. */
export async function readBounded(res: Response, limit: number): Promise<{ buf: Buffer; truncated: boolean }> {
  if (!res.body) return { buf: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { buf: Buffer.concat(parts), truncated: false };
    parts.push(value);
    size += value.length;
    if (size >= limit) {
      await reader.cancel().catch(() => undefined);
      return { buf: Buffer.concat(parts).subarray(0, limit), truncated: true };
    }
  }
}

export class LogPuller {
  private readonly o: Required<Omit<LogPullerOptions, 'metrics' | 'log' | 'shipUrl' | 'traceShipUrl'>> & Pick<LogPullerOptions, 'metrics' | 'log' | 'shipUrl' | 'traceShipUrl'>;
  private readonly states = new Map<string, InstanceState>();
  private computers = new Map<string, Computer>();
  private lastDiscover = -Infinity;
  private discovering: Promise<void> | undefined;
  private inFlight = 0;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(opts: LogPullerOptions) {
    // Options given as undefined (e.g. an unset env var) keep their defaults.
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as LogPullerOptions;
    this.o = {
      pollMs: 5000, concurrency: 8, discoverMs: 15_000, recheckMs: 600_000, maxBackoffMs: 300_000,
      batch: 1000, traceBatch: 1000, maxResponseBytes: 16 * 1024 * 1024, requestTimeoutMs: 30_000, now: Date.now, ...given,
    };
  }

  start() {
    if (this.timer) return;
    // Tick faster than the poll interval so due instances start promptly.
    this.timer = setInterval(() => { void this.tick(); }, Math.max(250, Math.min(1000, this.o.pollMs)));
    this.timer.unref();
  }

  stop() { clearInterval(this.timer); this.timer = undefined; }

  /**
   * One scheduling pass: refresh discovery if due, then start due pulls, longest-waiting
   * first, up to the in-flight cap. Only discovery and selection hold the lock: pulls run on,
   * so a slow computer never delays the next pass. Resolves when this pass's pulls finish.
   */
  tick(): Promise<void> {
    return untraced(() => this.runTick());
  }

  private async runTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const pulls: Promise<void>[] = [];
    try {
      await this.discover();
      const now = this.o.now();
      const due = [...this.states.entries()]
        .filter(([, s]) => !s.busy && s.nextAt <= now)
        .sort(([, a], [, b]) => a.nextAt - b.nextAt);
      for (const [, s] of due) {
        if (this.inFlight >= this.o.concurrency) break;
        const c = this.computers.get(s.id);
        if (!c) continue;
        s.busy = true;
        this.inFlight++;
        pulls.push(this.pull(c, s).finally(() => { s.busy = false; this.inFlight--; }));
      }
    } finally {
      this.ticking = false;
    }
    await Promise.all(pulls);
  }

  private async discover() {
    if (this.o.now() - this.lastDiscover < this.o.discoverMs) return;
    this.discovering ??= (async () => {
      try {
        const all = await this.o.provider.listAll();
        const running = all.filter((c) => !c.stopped && c.internalUrl && c.token);
        this.computers = new Map(running.map((c) => [c.id, c]));
        const nowSec = Math.floor(this.o.now() / 1000);
        const streams: Stream[] = [...(this.o.shipUrl ? ['logs' as const] : []), ...(this.o.traceShipUrl ? ['traces' as const] : [])];
        for (const c of running) {
          for (const stream of streams) {
            const key = `${stream}:${c.id}`;
            if (!this.states.has(key)) this.states.set(key, { stream, id: c.id, since: nowSec, nextAt: 0, failures: 0, busy: false });
          }
        }
        // Stopped or gone: forget it (a restart starts again from "now").
        for (const [key, s] of this.states) if (!this.computers.has(s.id)) this.states.delete(key);
        this.lastDiscover = this.o.now();
      } catch (e) {
        this.o.log?.warn({ err: (e as Error).message }, 'log puller: listing computers failed');
        this.lastDiscover = this.o.now(); // retry on the next discovery interval, keep the old list
      } finally {
        this.discovering = undefined;
      }
    })();
    await this.discovering;
    this.updateUnsupported();
  }

  private updateUnsupported() {
    const n = { logs: 0, traces: 0 };
    for (const s of this.states.values()) if (s.reported === 'unsupported') n[s.stream]++;
    if (this.o.shipUrl) this.o.metrics?.logPullUnsupported.set(n.logs);
    if (this.o.traceShipUrl) this.o.metrics?.tracePullUnsupported.set(n.traces);
  }

  private async pull(c: Computer, s: InstanceState): Promise<void> {
    const outcome = await (s.stream === 'traces' ? this.pullTraces(c, s) : this.pullOnce(c, s)).catch((e: Error): Outcome => {
      this.report(c, s, 'error', e.message);
      return 'error';
    });
    (s.stream === 'traces' ? this.o.metrics?.tracePulls : this.o.metrics?.logPulls)?.inc({ outcome });
    const now = this.o.now();
    if (outcome === 'ok') {
      if (s.reported) this.o.log?.info({ instance_id: c.id, stream: s.stream }, `log puller: instance ${s.stream} flowing again`);
      s.failures = 0;
      s.reported = undefined;
      s.nextAt = s.more ? now : now + this.o.pollMs;
    } else if (outcome === 'unsupported' || outcome === 'unauthorized') {
      s.nextAt = now + this.o.recheckMs;
    } else {
      s.failures++;
      // A traces response that was too large is retried at once with a smaller limit.
      s.nextAt = s.more ? now : now + Math.min(this.o.maxBackoffMs, this.o.pollMs * 2 ** s.failures);
    }
    this.updateUnsupported();
  }

  private report(c: Computer, s: InstanceState, outcome: Outcome, detail: string) {
    if (s.reported === outcome) return;
    s.reported = outcome;
    const fields = { instance_id: c.id, provider: this.o.provider.scheme, stream: s.stream, outcome, detail };
    if (outcome === 'unsupported') this.o.log?.info(fields, `log puller: instance has no ${s.stream} route (older version); re-checking later`);
    else this.o.log?.warn(fields, `log puller: pulling instance ${s.stream} failed`);
  }

  private async pullOnce(c: Computer, s: InstanceState): Promise<Outcome> {
    const n = this.o.batch;
    s.more = false;
    const range = s.cursor ? `entries=${s.cursor}:1:${n}` : `realtime=${s.since}::0:${n}`;
    let res: Response;
    try {
      res = await fetch(`${c.internalUrl}/api/v1/logs/entries`, {
        headers: { authorization: `Bearer ${c.token}`, accept: JOURNAL_EXPORT, range },
        signal: AbortSignal.timeout(this.o.requestTimeoutMs),
      });
    } catch (e) {
      this.report(c, s, 'unavailable', (e as Error).message);
      return 'unavailable';
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 404) { this.report(c, s, 'unsupported', 'HTTP 404'); return 'unsupported'; }
      if (res.status === 401 || res.status === 403) { this.report(c, s, 'unauthorized', `HTTP ${res.status}`); return 'unauthorized'; }
      if (res.status === 400 && s.cursor) {
        // The instance's journal no longer knows the cursor (rotated, or a new container): start again from now.
        s.cursor = undefined;
        s.since = Math.floor(this.o.now() / 1000);
      }
      this.report(c, s, res.status >= 500 ? 'unavailable' : 'error', `HTTP ${res.status}`);
      return res.status >= 500 ? 'unavailable' : 'error';
    }
    const extra = Buffer.concat([
      exportField('OZWELL_INSTANCE_ID', c.id), exportField('OZWELL_USER', observedOwner(c)), exportField('OZWELL_PROVIDER', this.o.provider.scheme),
    ]);
    // The instance is agent-controlled: never buffer an unbounded response.
    const { buf, truncated } = await readBounded(res, this.o.maxResponseBytes);
    const { body, entries, cursor } = tagExport(buf, extra);
    if (entries === 0) {
      if (!truncated) return 'ok';
      // One entry is larger than the whole budget: it can never be read. Skip to now.
      s.cursor = undefined;
      s.since = Math.floor(this.o.now() / 1000);
      this.report(c, s, 'error', `a journal entry exceeds ${this.o.maxResponseBytes} bytes; skipped to now`);
      return 'error';
    }
    let shipped: Response;
    try {
      shipped = await fetch(this.o.shipUrl!, {
        method: 'POST', headers: { 'content-type': JOURNAL_EXPORT }, body: new Uint8Array(body),
        signal: AbortSignal.timeout(this.o.requestTimeoutMs),
      });
      await shipped.body?.cancel().catch(() => undefined);
    } catch (e) {
      this.report(c, s, 'ship_error', (e as Error).message);
      return 'ship_error';
    }
    if (!shipped.ok) { this.report(c, s, 'ship_error', `VictoriaLogs HTTP ${shipped.status}`); return 'ship_error'; }
    if (cursor) s.cursor = cursor;
    this.o.metrics?.logEntriesShipped.inc(entries);
    // A full batch: more is waiting, pull again right away.
    // A full batch, or a response cut at the byte budget: more is waiting.
    s.more = entries >= n || truncated;
    return 'ok';
  }

  private async pullTraces(c: Computer, s: InstanceState): Promise<Outcome> {
    s.more = false;
    const limit = s.limit ?? this.o.traceBatch;
    // The first pull only finds the end of the buffer: like logs, nothing is backfilled.
    const q = new URLSearchParams({ cursor: s.cursor ?? 'end', limit: String(limit) });
    let res: Response;
    try {
      res = await fetch(`${c.internalUrl}/api/v1/traces?${q}`, {
        headers: { authorization: `Bearer ${c.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.o.requestTimeoutMs),
      });
    } catch (e) {
      this.report(c, s, 'unavailable', (e as Error).message);
      return 'unavailable';
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 404) { this.report(c, s, 'unsupported', 'HTTP 404'); return 'unsupported'; }
      if (res.status === 401 || res.status === 403) { this.report(c, s, 'unauthorized', `HTTP ${res.status}`); return 'unauthorized'; }
      this.report(c, s, res.status >= 500 ? 'unavailable' : 'error', `HTTP ${res.status}`);
      return res.status >= 500 ? 'unavailable' : 'error';
    }
    const next = res.headers.get('ozwell-trace-cursor') ?? undefined;
    const dropped = Number(res.headers.get('ozwell-trace-dropped') ?? 0);
    if (Number.isSafeInteger(dropped) && dropped > 0) this.o.metrics?.traceSpansDropped.inc(dropped);
    // The instance is agent-controlled: never buffer an unbounded response.
    const { buf, truncated } = await readBounded(res, this.o.maxResponseBytes);
    if (truncated) {
      if (limit > 1) {
        // Ask for fewer spans at once, right away.
        s.limit = Math.max(1, Math.floor(limit / 2));
        s.more = true;
        this.report(c, s, 'error', `traces response exceeds ${this.o.maxResponseBytes} bytes; asking for ${s.limit} spans`);
        return 'error';
      }
      // One span is larger than the whole budget: skip it.
      if (next) s.cursor = next;
      s.limit = undefined;
      this.report(c, s, 'error', `a span exceeds ${this.o.maxResponseBytes} bytes; skipped`);
      return 'error';
    }
    let body: Buffer, spans: number;
    try {
      ({ body, spans } = otlpJsonToProto(JSON.parse(buf.toString('utf8')), {
        'ozwell.instance_id': c.id, 'ozwell.user': observedOwner(c), 'ozwell.provider': this.o.provider.scheme,
      }));
    } catch (e) {
      // Invalid JSON can't get better by retrying: skip past it.
      if (next) s.cursor = next;
      this.report(c, s, 'error', `invalid traces response: ${(e as Error).message}`);
      return 'error';
    }
    if (spans > 0) {
      let shipped: Response;
      try {
        shipped = await fetch(this.o.traceShipUrl!, {
          method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: new Uint8Array(body),
          signal: AbortSignal.timeout(this.o.requestTimeoutMs),
        });
        await shipped.body?.cancel().catch(() => undefined);
      } catch (e) {
        this.report(c, s, 'ship_error', (e as Error).message);
        return 'ship_error';
      }
      if (!shipped.ok) { this.report(c, s, 'ship_error', `VictoriaTraces HTTP ${shipped.status}`); return 'ship_error'; }
      this.o.metrics?.traceSpansShipped.inc(spans);
    }
    if (next) s.cursor = next;
    s.more = res.headers.get('ozwell-trace-more') === '1';
    if (!s.more) s.limit = undefined;
    return 'ok';
  }
}
