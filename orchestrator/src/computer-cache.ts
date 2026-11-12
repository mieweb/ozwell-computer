// Computers looked up for desktop tool calls, kept until something shows they changed.
//
// Every desktop tool needs the computer's owner, URL and token. Without a cache each call
// costs a provider lookup (on opensource-server, an HTTPS request to the manager). Owner is
// fixed at create; URL, token and running state rarely change, and when they do the call
// itself fails (refused, the proxy's 503, or 401 from a different computer at that address),
// which revalidates the entry. Only running computers are cached: a stopped one is always
// looked up again, so a computer started elsewhere is seen at once.
import type { Computer } from './providers/types.ts';

interface Entry { c: Computer; at: number; used: number }

export interface ComputerCacheOptions {
  /** Look an entry up again after this long even if nothing failed (default 1 h). */
  maxAgeMs?: number;
  /** Drop entries unused for this long (default 1 h). */
  idleMs?: number;
  now?: () => number;
}

export class ComputerCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxAgeMs: number;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(o: ComputerCacheOptions = {}) {
    this.maxAgeMs = o.maxAgeMs ?? 3_600_000;
    this.idleMs = o.idleMs ?? 3_600_000;
    this.now = o.now ?? Date.now;
  }

  get(id: string): Computer | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    const now = this.now();
    if (now - e.at >= this.maxAgeMs || now - e.used >= this.idleMs) { this.entries.delete(id); return undefined; }
    e.used = now;
    return e.c;
  }

  /** Remember a freshly looked-up computer; anything not running and reachable is forgotten. */
  set(c: Computer | null | undefined, id = c?.id) {
    if (!id) return;
    if (!c || c.stopped || !c.internalUrl || !c.token) { this.entries.delete(id); return; }
    const now = this.now();
    this.entries.set(id, { c, at: now, used: now });
    this.sweep(now);
  }

  delete(id: string) { this.entries.delete(id); }

  get size() { return this.entries.size; }

  private lastSweep = 0;
  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [id, e] of this.entries) if (now - e.at >= this.maxAgeMs || now - e.used >= this.idleMs) this.entries.delete(id);
  }
}
