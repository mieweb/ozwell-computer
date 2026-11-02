import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';

export const MAX_LEASE_MS = 24 * 3600_000;
const MAX_LEASES = 128;

export interface LifecycleStatus {
  last_activity_at: number;
  active_requests: number;
  connections: number;
  running_jobs: number;
  busy: boolean;
  leases: number;
  prepared: boolean;
  lease_id: string | null;
}

/** The guest side of the external controller's prepare/save/resume handshake. */
export class Lifecycle {
  private lastActivity: number;
  private active = 0;
  private connections = 0;
  private leases = new Map<string, number>();
  private prepared: string | null = null;

  constructor(
    private workload: () => Promise<{ running_jobs: number; busy: boolean }>,
    private now: () => number = Date.now,
  ) { this.lastActivity = now(); }

  private touch() { this.lastActivity = this.now(); }

  /** Admission and prepare both change state synchronously, before awaiting any work. */
  enter(connection = false): () => void {
    if (this.prepared) throw new ApiError('hibernating', 'computer is preparing to hibernate; reconnect through its gateway', { retryAfterMs: 1000 });
    this.active++;
    if (connection) this.connections++;
    this.touch();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.active--;
      if (connection) this.connections--;
      this.touch();
    };
  }

  private leaseCount() {
    const now = this.now();
    for (const [id, until] of this.leases) if (until <= now) {
      this.leases.delete(id);
      this.lastActivity = Math.max(this.lastActivity, until);
    }
    return this.leases.size;
  }

  private view(work: { running_jobs: number; busy: boolean }): LifecycleStatus {
    const leases = this.leaseCount();
    return {
      last_activity_at: this.lastActivity, active_requests: this.active, connections: this.connections,
      ...work, leases, prepared: this.prepared !== null, lease_id: this.prepared,
    };
  }

  async status(): Promise<LifecycleStatus> {
    const work = await this.workload();
    // A live job/update is activity even when its starting request has already returned.
    if (!this.prepared && (work.running_jobs || work.busy)) this.touch();
    return this.view(work);
  }

  async prepare(idleMs: number): Promise<LifecycleStatus> {
    if (this.prepared) throw new ApiError('not_idle', 'computer is already prepared; resume before preparing again');
    if (this.active || this.leaseCount() || this.now() - this.lastActivity < idleMs)
      throw new ApiError('not_idle', 'computer has active work, a keep-awake lease, or recent activity');
    const reservation = randomUUID();
    this.prepared = reservation; // closes admission before the asynchronous workload check
    try {
      const work = await this.workload();
      if (this.prepared !== reservation) throw new ApiError('not_idle', 'preparation was cancelled');
      if (work.running_jobs || work.busy) {
        this.touch();
        throw new ApiError('not_idle', 'computer has a running job or upgrade');
      }
      return this.view(work);
    } catch (e) {
      if (this.prepared === reservation) this.prepared = null;
      throw e;
    }
  }

  resume() {
    this.prepared = null;
    this.touch();
  }

  get admissionClosed() { return this.prepared !== null; }

  keepAwake(id: string, ttlMs: number) {
    if (this.prepared) throw new ApiError('hibernating', 'computer is preparing to hibernate', { retryAfterMs: 1000 });
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_LEASE_MS)
      throw new ApiError('invalid_request', `lease id must be 1–128 URL-safe characters and ttl_ms must be 1–${MAX_LEASE_MS}`);
    if (this.leaseCount() >= MAX_LEASES && !this.leases.has(id)) throw new ApiError('limit_exceeded', 'too many keep-awake leases');
    this.leases.set(id, this.now() + ttlMs);
    this.touch();
  }

  release(id: string) {
    if (this.leases.delete(id)) this.touch();
  }
}

function excluded(req: FastifyRequest) {
  const path = req.url.split('?')[0];
  return path === '/health' || path === '/api/v1/metrics' || path === '/api/v1/lifecycle' || path.startsWith('/api/v1/lifecycle/');
}

interface RequestWork { begin(): () => void; terminal(): void; transportEnded(): void; replying(): void; observeReply(fn: () => void): () => void }
const requestWork = new AsyncLocalStorage<RequestWork>();

/** SDK dispatch can outlive its HTTP adapter (notably disconnected MCP calls). */
export async function retainRequestWork<T>(fn: () => Promise<T>): Promise<T> {
  const finish = requestWork.getStore()?.begin();
  try { return await fn(); } finally { finish?.(); }
}

/** Register after auth and before routes. Transport closure does not cancel work. */
export function registerLifecycle(app: FastifyInstance, lifecycle: Lifecycle, authDisabled: boolean) {
  const reservations = new WeakMap<FastifyRequest, RequestWork>();
  // onRoute is public Fastify API. Keep each function's receiver, return value,
  // promise, and callback convention; forcing handlers into async functions would
  // change callback hooks and hijacked WebSocket/SSE responses.
  app.addHook('onRoute', (route) => {
    type Work = (this: FastifyInstance, ...args: any[]) => any;
    const wrap = (fn: Work, handler = false): Work => function (...args) {
      const state = reservations.get(args[0]);
      if (!state) return fn.apply(this, args);
      const finish = state.begin();
      const settle = () => { stopReply(); if (handler) state.terminal(); finish(); };
      const last = args.length - 1, callback = !handler && typeof args[last] === 'function' ? args[last] : undefined;
      let returned = false, promise = false, replied = false;
      // Callback hooks may legally send an early reply instead of calling done.
      // Observe send, rather than close: disconnect does not complete that work.
      const stopReply = callback ? state.observeReply(() => { replied = true; if (returned && !promise) settle(); }) : () => {};
      if (callback) args[last] = (...values: any[]) => { try { return callback(...values); } finally { settle(); } };
      try {
        const result = requestWork.run(state, () => fn.apply(this, args));
        returned = true;
        if (result && typeof result.then === 'function') { promise = true; stopReply(); return Promise.resolve(result).finally(settle); }
        if (!callback || replied) settle();
        return result;
      } catch (error) { settle(); throw error; }
    };
    route.handler = wrap(route.handler, true);
    for (const key of ['onRequest', 'preParsing', 'preValidation', 'preHandler', 'preSerialization', 'onSend', 'onError'] as const) {
      const hooks = route[key];
      if (hooks) (route as any)[key] = Array.isArray(hooks) ? hooks.map((hook) => wrap(hook)) : wrap(hooks);
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    // Also covers validation failures and prehandlers that reply without calling
    // the handler. A still-running wrapped hook/handler keeps its execution pin.
    const state = reservations.get(req);
    state?.replying();
    state?.terminal();
    if (lifecycle.admissionClosed) {
      reply.header('connection', 'close');
      app.server.closeIdleConnections();
    }
    return payload;
  });
  app.addHook('onError', async (req) => { reservations.get(req)?.terminal(); });
  app.addHook('onRequest', async (req, reply) => {
    if (excluded(req)) return;
    // Public shell/static assets do not represent an authenticated desktop connection.
    // Signed file routes authenticate later, so conservatively account for them here.
    if (!authDisabled && !req.authSource && !req.url.startsWith('/files/')) return;
    const path = req.url.split('?')[0];
    const upgrade = req.headers.upgrade?.toLowerCase() === 'websocket';
    const persistent = upgrade || (req.method === 'GET' && (path === '/mcp' || path === '/api/v1/events' || /^\/api\/v1\/exec\/jobs\/[^/]+\/stream$/.test(path)));
    let done = lifecycle.enter(persistent), released = false;
    let executions = 0, terminal = false, transportEnded = false;
    const replyObservers = new Set<() => void>();
    const release = () => {
      if (!released && terminal && transportEnded && executions === 0) { released = true; done(); }
    };
    const state: RequestWork = {
      begin() {
        // A delayed SDK callback must acquire admission again if its adapter has
        // already finished, and must fail before starting if prepare won the race.
        if (released) { done = lifecycle.enter(); released = false; }
        executions++;
        let finished = false;
        return () => { if (!finished) { finished = true; executions--; release(); } };
      },
      terminal() { terminal = true; release(); },
      transportEnded() { transportEnded = true; release(); },
      replying() { for (const fn of [...replyObservers]) fn(); },
      observeReply(fn) { replyObservers.add(fn); return () => { replyObservers.delete(fn); }; },
    };
    reservations.set(req, state);
    const eventTarget = upgrade ? req.raw.socket : reply.raw;
    const finish = () => {
      eventTarget.removeListener('close', finish);
      if (!upgrade) reply.raw.removeListener('finish', finish);
      state.transportEnded();
    };
    eventTarget.once('close', finish);
    if (!upgrade) reply.raw.once('finish', finish);
    if (eventTarget.destroyed) finish();
  });
}
