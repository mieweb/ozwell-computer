// Lives outside the guests. A save is allowed only after the guest atomically closes
// admission to new work; incoming requests wait for that transaction, then restore it.
import { randomUUID } from 'node:crypto';
import type { Computer, Provider } from './providers/types.ts';
import { InstanceError } from './instance-client.ts';

interface Activity {
  last_activity_at: number;
  active_requests: number;
  connections: number;
  running_jobs: number;
  busy: boolean;
  leases: number;
  prepared: boolean;
  lease_id: string | null;
}

export interface LifecycleOptions {
  /** Zero disables automatic saves; explicit saves still require a quiescent guest. */
  idleMs?: number;
  pollMs?: number;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  log?: { info(o: object, message: string): void; warn(o: object, message: string): void };
}

export interface ComputerLease { computer: Computer; release(): void }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class IdleController {
  readonly provider: Provider;
  private refs = new Map<string, number>();
  private releases = new Set<() => void>();
  private pendingReleases = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private sweeping?: Promise<void>;
  private closed = false;
  readonly idleMs: number;
  readonly pollMs: number;
  private readyTimeoutMs: number;
  private requestTimeoutMs: number;
  private log?: LifecycleOptions['log'];

  constructor(provider: Provider, opts: LifecycleOptions = {}) {
    this.provider = provider;
    if (!provider.hibernate || !provider.listAll || !provider.withLock) {
      throw new Error('idle hibernation requires a provider with hibernate, listAll and withLock');
    }
    this.idleMs = opts.idleMs ?? 300_000;
    this.pollMs = opts.pollMs ?? 15_000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 40_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    for (const [name, value] of Object.entries({ idleMs: this.idleMs, pollMs: this.pollMs, readyTimeoutMs: this.readyTimeoutMs, requestTimeoutMs: this.requestTimeoutMs })) {
      if (!Number.isSafeInteger(value) || value < (name === 'idleMs' ? 0 : 1) || value > 86_400_000) throw new Error(`invalid lifecycle ${name}`);
    }
    this.log = opts.log;
  }

  setLogger(log: NonNullable<LifecycleOptions['log']>) { this.log ??= log; }

  private lock<T>(id: string, fn: () => Promise<T>): Promise<T> { return this.provider.withLock!(id, fn); }

  private async request(c: Computer, path: string, method = 'GET', body?: unknown): Promise<Response> {
    if (!c.internalUrl || !c.token) throw new InstanceError('target_unavailable', `computer ${c.id} has no guest endpoint`);
    return fetch(`${c.internalUrl}/api/v1/lifecycle${path}`, {
      method, headers: { authorization: `Bearer ${c.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
  }

  private async checked(c: Computer, path: string, method = 'GET', body?: unknown): Promise<void> {
    const r = await this.request(c, path, method, body);
    await r.body?.cancel();
    if (!r.ok) throw new InstanceError('target_unavailable', `computer ${c.id} lifecycle ${method} ${path || '/'} failed (HTTP ${r.status})`);
  }

  private async running(id: string, startStopped: boolean): Promise<Computer> {
    let c = await this.provider.get(id);
    if (!c) throw new InstanceError('target_unavailable', `no computer ${id}`);
    if (c.hibernated || (c.stopped && startStopped)) {
      this.log?.info({ instance: id, restored: !!c.hibernated }, 'starting computer');
      // The provider must restore a saved image or fail. Never retry with a force boot.
      c = await this.provider.start(id);
    } else if (c.stopped) {
      throw new InstanceError('computer_stopped', `computer ${id} is stopped; call start_computer`);
    }
    const until = Date.now() + this.readyTimeoutMs;
    for (;;) {
      if (c.internalUrl && c.token) {
        try {
          const r = await fetch(`${c.internalUrl}/health`, { signal: AbortSignal.timeout(Math.min(3000, this.requestTimeoutMs)) });
          await r.body?.cancel();
          if (r.status === 204) break;
        } catch { /* A restored network may take a moment to recover. */ }
      }
      if (Date.now() >= until) throw new InstanceError('computer_starting', `computer ${id} did not become ready within the wait budget; retry the request`);
      await sleep(Math.min(200, until - Date.now()));
      const latest = await this.provider.get(id);
      if (!latest || latest.stopped) throw new InstanceError('target_unavailable', `computer ${id} stopped while becoming ready`);
      c = latest;
    }
    // Also repairs a controller crash after prepare, or after start but before resume.
    await this.checked(c, '/resume', 'POST', {});
    return c;
  }

  /** Pin activity before waiting on a save. Each request also gets a guest lease, so
   * multiple gateways sharing this provider cannot save in the forwarding gap. */
  async acquire(id: string, startStopped = false): Promise<ComputerLease> {
    if (this.closed) throw new InstanceError('target_unavailable', 'the hibernation controller is closing');
    this.refs.set(id, (this.refs.get(id) ?? 0) + 1);
    const lease = `gateway-${randomUUID()}`;
    let c: Computer;
    try {
      c = await this.lock(id, async () => {
        if (this.closed) throw new InstanceError('target_unavailable', 'the hibernation controller is closing');
        const running = await this.running(id, startStopped);
        await this.checked(running, `/leases/${lease}`, 'PUT', { ttl_ms: 60_000 });
        return running;
      });
    } catch (e) { this.drop(id); throw e; }
    let released = false;
    let renewal: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (renewal || released) return;
      renewal = this.checked(c, `/leases/${lease}`, 'PUT', { ttl_ms: 60_000 })
        .catch((e) => this.log?.warn({ instance: id, err: (e as Error).message }, 'activity lease renewal failed'))
        .finally(() => { renewal = undefined; });
    }, 20_000).unref();
    const release = () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      this.releases.delete(release);
      // Keep the in-process pin until deletion finishes. A failed deletion expires
      // safely after 60 seconds rather than risking an interrupted request.
      // A renewal already in flight must finish before deletion; otherwise its
      // late PUT could recreate the lease after the last connection has closed.
      const deletion = (async () => { await renewal; await this.checked(c, `/leases/${lease}`, 'DELETE'); })()
        .catch(() => {}).finally(() => { this.drop(id); this.pendingReleases.delete(deletion); });
      this.pendingReleases.add(deletion);
    };
    this.releases.add(release);
    if (this.closed) { release(); throw new InstanceError('target_unavailable', 'the hibernation controller is closing'); }
    return { computer: c, release };
  }

  private drop(id: string) {
    const n = (this.refs.get(id) ?? 1) - 1;
    if (n) this.refs.set(id, n); else this.refs.delete(id);
  }

  /** Explicit keep-awake policy for downloads, remote sessions or application work
   * that the guest cannot infer from Ozwell's own command-job registry. */
  async keepAwake(id: string, ttlMs: number): Promise<void> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) throw new InstanceError('invalid_request', 'ttl_ms must be between 1 and 86400000');
    const active = await this.acquire(id);
    try { await this.checked(active.computer, '/leases/manual', 'PUT', { ttl_ms: ttlMs }); }
    finally { active.release(); }
  }

  async allowIdle(id: string): Promise<void> {
    await this.lock(id, async () => {
      const c = await this.provider.get(id);
      if (!c) throw new InstanceError('target_unavailable', `no computer ${id}`);
      if (!c.stopped) await this.checked(c, '/leases/manual', 'DELETE');
    });
  }

  async hibernate(id: string, idleMs = 0): Promise<Computer> {
    return this.lock(id, async () => {
      const c = await this.provider.get(id);
      if (!c) throw new InstanceError('target_unavailable', `no computer ${id}`);
      if (c.hibernated && c.stopped) return c;
      if (c.stopped) throw new InstanceError('computer_stopped', `computer ${id} is stopped`);
      if (this.refs.has(id)) throw new InstanceError('not_idle', `computer ${id} has active requests`);
      const status = await this.request(c, '');
      if (!status.ok) { await status.body?.cancel(); throw new InstanceError('target_unavailable', `computer ${id} does not support idle hibernation (HTTP ${status.status})`); }
      const state = await status.json() as Activity;
      // A controller may have died after preparing without saving. No other
      // transaction can be preparing this guest while we hold the provider lock.
      if (state.prepared) { await this.checked(c, '/resume', 'POST', {}); throw new InstanceError('not_idle', `computer ${id} recovered an interrupted save; waiting for its idle grace`); }
      const prepared = await this.request(c, '/prepare', 'POST', { idle_ms: idleMs });
      await prepared.body?.cancel();
      if (prepared.status === 409) throw new InstanceError('not_idle', `computer ${id} has connections, work, keep-awake leases, or recent activity`);
      if (!prepared.ok) throw new InstanceError('target_unavailable', `computer ${id} could not prepare for hibernation (HTTP ${prepared.status})`);
      try {
        // Check again after awaiting the guest: a local request might now be queued.
        if (this.refs.has(id)) throw new InstanceError('not_idle', `computer ${id} received a request while preparing`);
        const saved = await this.provider.hibernate!(id);
        if (!saved.hibernated || !saved.stopped) throw new Error(`computer ${id} did not reach managed-save state`);
        this.log?.info({ instance: id }, 'computer hibernated');
        return saved;
      } catch (e) {
        // Never start a guest merely to recover from a save error. If save actually
        // finished before the error, retain it for the next authorized request.
        // Re-enter the guard as well as the lock: a timed-out virsh command can
        // leave libvirtd's save job running after its client has disappeared.
        await this.lock(id, async () => {
          const now = await this.provider.get(id);
          if (now && !now.stopped) await this.checked(now, '/resume', 'POST', {});
        }).catch((resumeError) => {
          this.log?.warn({ instance: id, err: (resumeError as Error).message }, 'failed to reopen guest admission after save failure');
        });
        throw e;
      }
    });
  }

  /** Recover prepared running guests after a process restart, leaving saved guests asleep. */
  async start(): Promise<void> {
    if (this.closed) throw new Error('controller is closed');
    if (this.timer) return;
    for (const c of await this.provider.listAll!()) {
      if (c.stopped) continue;
      await this.lock(c.id, async () => {
        const now = await this.provider.get(c.id);
        if (now && !now.stopped) await this.checked(now, '/resume', 'POST', {});
      }).catch((e) => this.log?.warn({ instance: c.id, err: (e as Error).message }, 'guest recovery deferred until next request'));
    }
    if (this.idleMs > 0) this.timer = setInterval(() => { void this.sweep(); }, this.pollMs).unref();
  }

  sweep(): Promise<void> {
    if (this.closed || this.idleMs === 0) return Promise.resolve();
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      try {
        for (const c of await this.provider.listAll!()) {
          if (this.closed) break;
          if (c.stopped || this.refs.has(c.id)) continue;
          await this.hibernate(c.id, this.idleMs).catch((e) => {
            if (!(e instanceof InstanceError && e.reason === 'not_idle')) this.log?.warn({ instance: c.id, err: (e as Error).message }, 'idle hibernation failed; retaining computer state');
          });
        }
      } catch (e) { this.log?.warn({ err: (e as Error).message }, 'could not enumerate idle computers'); }
    })().finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    for (const release of this.releases) release();
    await this.sweeping;
    await Promise.allSettled([...this.pendingReleases]);
  }
}
