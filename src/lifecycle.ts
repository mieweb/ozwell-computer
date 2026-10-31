import { randomUUID } from 'node:crypto';
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

/** Register after auth. Raw reply events also cover hijacked MCP and SSE responses. */
export function registerLifecycle(app: FastifyInstance, lifecycle: Lifecycle, authDisabled: boolean) {
  app.addHook('onRequest', async (req, reply) => {
    if (excluded(req)) return;
    // Public shell/static assets do not represent an authenticated desktop connection.
    // Signed file routes authenticate later, so conservatively account for them here.
    if (!authDisabled && !req.authSource && !req.url.startsWith('/files/')) return;
    const path = req.url.split('?')[0];
    const upgrade = req.headers.upgrade?.toLowerCase() === 'websocket';
    const persistent = upgrade || (req.method === 'GET' && (path === '/mcp' || path === '/api/v1/events' || /^\/api\/v1\/exec\/jobs\/[^/]+\/stream$/.test(path)));
    const done = lifecycle.enter(persistent);
    const eventTarget = upgrade ? req.raw.socket : reply.raw;
    const finish = () => {
      eventTarget.removeListener('close', finish);
      if (!upgrade) reply.raw.removeListener('finish', finish);
      done();
    };
    eventTarget.once('close', finish);
    if (!upgrade) reply.raw.once('finish', finish);
    if (eventTarget.destroyed) finish();
  });
}
