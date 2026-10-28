import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { m } from '../metrics.js';

export interface BusEvent { type: string; data: unknown; id: number; ts: number }

/** In-process pub/sub feeding SSE streams and the viewer overlay. */
export class EventBus extends EventEmitter {
  private seq = 0;
  constructor() {
    super();
    this.setMaxListeners(1000);
  }
  publish(type: string, data: unknown) {
    const ev: BusEvent = { type, data, id: ++this.seq, ts: Date.now() };
    this.emit('event', ev);
  }
  subscribe(fn: (ev: BusEvent) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export type ParticipantKind = 'human' | 'agent';

export interface Participant {
  participant_id: string;
  name: string;
  kind: ParticipantKind;
  color: string;
  cursor: { x: number; y: number; visible: boolean } | null;
  joined_at: number;
  last_seen: number;
  /** external key for auto-created participants (X-Principal id, MCP session, VNC socket) */
  key?: string;
}

const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990', '#800000'];

export interface PresenceOptions {
  agentIdleMs?: number;
  humanCursorHideMs?: number;
  humanLeaveMs?: number;
}

export class Presence {
  private parts = new Map<string, Participant>();
  private byKey = new Map<string, string>();
  private colorIdx = 0;
  private timer: NodeJS.Timeout;
  private agentIdleMs: number;
  private humanCursorHideMs: number;
  private humanLeaveMs: number;

  constructor(private bus: EventBus, opts: PresenceOptions = {}) {
    this.agentIdleMs = opts.agentIdleMs ?? 15_000;
    this.humanCursorHideMs = opts.humanCursorHideMs ?? 60_000;
    this.humanLeaveMs = opts.humanLeaveMs ?? 10 * 60_000;
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref();
  }

  private count() {
    let h = 0, a = 0;
    for (const p of this.parts.values()) (p.kind === 'agent' ? a++ : h++);
    m.presence.set({ kind: 'human' }, h);
    m.presence.set({ kind: 'agent' }, a);
  }

  roster(): Participant[] {
    return [...this.parts.values()].map(({ key: _k, ...p }) => p as Participant);
  }

  get(id: string): Participant | undefined {
    return this.parts.get(id);
  }

  join(input: { name?: string; kind?: ParticipantKind; color?: string; key?: string }): Participant {
    if (input.key) {
      const existing = this.byKey.get(input.key);
      if (existing && this.parts.has(existing)) {
        const p = this.parts.get(existing)!;
        p.last_seen = Date.now();
        return p;
      }
    }
    const now = Date.now();
    const p: Participant = {
      participant_id: randomUUID(),
      name: (input.name ?? '').slice(0, 64) || (input.kind === 'agent' ? 'agent' : 'guest'),
      kind: input.kind ?? 'human',
      color: input.color && /^#[0-9a-f]{3,8}$/i.test(input.color) ? input.color : PALETTE[this.colorIdx++ % PALETTE.length],
      cursor: null,
      joined_at: now,
      last_seen: now,
      key: input.key,
    };
    this.parts.set(p.participant_id, p);
    this.count();
    if (input.key) this.byKey.set(input.key, p.participant_id);
    this.bus.publish('presence.joined', this.public(p));
    return p;
  }

  leave(id: string): boolean {
    const p = this.parts.get(id);
    if (!p) return false;
    this.parts.delete(id);
    this.count();
    if (p.key) this.byKey.delete(p.key);
    this.bus.publish('presence.left', { participant_id: id });
    return true;
  }

  leaveByKey(key: string) {
    const id = this.byKey.get(key);
    if (id) this.leave(id);
  }

  /** Update a cursor in normalized coordinates. */
  cursor(id: string, x: number, y: number, visible = true): boolean {
    const p = this.parts.get(id);
    if (!p) return false;
    p.cursor = { x: clamp01(x), y: clamp01(y), visible };
    p.last_seen = Date.now();
    this.bus.publish('presence.cursor', { participant_id: id, name: p.name, kind: p.kind, color: p.color, ...p.cursor });
    return true;
  }

  touch(id: string) {
    const p = this.parts.get(id);
    if (p) p.last_seen = Date.now();
  }

  private public(p: Participant) {
    const { key: _k, ...rest } = p;
    return rest;
  }

  private sweep() {
    const now = Date.now();
    for (const p of [...this.parts.values()]) {
      const idle = now - p.last_seen;
      if (p.kind === 'agent' && idle > this.agentIdleMs) {
        if (p.key?.startsWith('mcp:')) {
          // MCP sessions stay joined; just hide the cursor.
          if (p.cursor?.visible) this.cursor(p.participant_id, p.cursor.x, p.cursor.y, false);
        } else this.leave(p.participant_id);
      } else if (p.kind === 'human') {
        if (idle > this.humanLeaveMs && !p.key?.startsWith('vnc:')) this.leave(p.participant_id);
        else if (idle > this.humanCursorHideMs && p.cursor?.visible) {
          p.cursor.visible = false;
          this.bus.publish('presence.cursor', { participant_id: p.participant_id, name: p.name, kind: p.kind, color: p.color, ...p.cursor });
        }
      }
    }
  }

  dispose() {
    clearInterval(this.timer);
  }
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export interface Principal { id?: string; name?: string; kind?: ParticipantKind }

export function parsePrincipal(header: string | string[] | undefined): Principal | null {
  if (!header || Array.isArray(header)) return null;
  try {
    const v = JSON.parse(header);
    if (!v || typeof v !== 'object') return null;
    const kind = v.kind === 'agent' || v.kind === 'human' ? v.kind : undefined;
    return { id: typeof v.id === 'string' ? v.id.slice(0, 128) : undefined, name: typeof v.name === 'string' ? v.name.slice(0, 64) : undefined, kind };
  } catch {
    return null;
  }
}
