// A small client for a computer's REST API (/api/v1/...), with the computer's own token.
// Used by the admin CLI for versions, presence and in-place updates. Failures are
// InstanceErrors, classified like the MCP client's (unreachable = never reached it).
import { InstanceError, NOT_SENT, traceCarrier } from './instance-client.ts';
import type { Computer } from './providers/types.ts';

export interface UpgradeProgress { state: 'idle' | 'requested' | 'running' | 'succeeded' | 'unchanged' | 'failed' | string; at?: string | null; log?: string }

export interface UpdateStatus {
  supported: boolean;
  limitation?: string;
  current: string | null;
  latest: string | null;
  available: boolean;
  error: string | null;
  upgrade: UpgradeProgress;
}

/** Longer than the computer's 15 s limit on an update check (src/update.ts). */
export const CHECK_TIMEOUT_MS = 30_000;

export interface Participant { participant_id: string; name: string; kind: 'human' | 'agent' | string }

export class ComputerApi {
  readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(c: Pick<Computer, 'id' | 'internalUrl' | 'token' | 'status'>, timeoutMs = 10_000) {
    if (!c.internalUrl || !c.token) throw new InstanceError('target_unavailable', `computer ${c.id} is ${c.status} and not reachable`, true);
    this.url = c.internalUrl.replace(/\/+$/, '');
    this.token = c.token;
    this.timeoutMs = timeoutMs;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, timeoutMs = this.timeoutMs): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', ...traceCarrier() },
        signal: AbortSignal.timeout(Math.max(timeoutMs, this.timeoutMs)),
      });
    } catch (e) {
      throw new InstanceError('target_unavailable', `cannot reach the computer: ${(e as Error).message}`, NOT_SENT.has((e as any).cause?.code));
    }
    const text = await res.text().catch(() => '');
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON (e.g. a proxy page) */ }
    if (res.status === 503) throw new InstanceError('target_unavailable', 'the computer is unavailable (HTTP 503)', true);
    if (res.status === 401) throw new InstanceError('unauthenticated', 'the computer rejected its token');
    if (!res.ok) throw new InstanceError(body?.error?.reason ?? 'internal', body?.error?.message ?? `${method} ${path}: HTTP ${res.status}`);
    return body as T;
  }

  /** Installed version, from /api/v1/capabilities. */
  async version(): Promise<string> { return (await this.call<{ version: string }>('GET', '/api/v1/capabilities')).version; }
  /** People and agents on the desktop now. */
  async presence(): Promise<Participant[]> { return (await this.call<{ roster: Participant[] }>('GET', '/api/v1/presence')).roster ?? []; }
  /** Update status; an update-less computer (feature_unsupported) is reported as unsupported. */
  async updateStatus(): Promise<UpdateStatus> {
    try {
      return await this.call<UpdateStatus>('GET', '/api/v1/update');
    } catch (e) {
      if (e instanceof InstanceError && e.reason === 'feature_unsupported') {
        return { supported: false, limitation: e.message, current: null, latest: null, available: false, error: null, upgrade: { state: 'idle' } };
      }
      throw e;
    }
  }
  /** The computer allows its own check 15 s (index fetch or git ls-remote): give it more. */
  checkUpdate(): Promise<UpdateStatus> { return this.call('POST', '/api/v1/update/check', CHECK_TIMEOUT_MS); }
  applyUpdate(): Promise<UpdateStatus> { return this.call('POST', '/api/v1/update/apply'); }
}
