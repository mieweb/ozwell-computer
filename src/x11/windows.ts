import { EventEmitter } from 'node:events';
import x11 from 'x11';
import { call, type XSession } from './connection.js';
import { ApiError } from '../errors.js';

export interface Bounds { x: number; y: number; width: number; height: number }

export interface WindowInfo {
  id: string;
  epoch: number;
  title: string;
  app: string | null;
  app_instance: string | null;
  pid: number | null;
  bounds: Bounds;
  focused: boolean;
  minimized: boolean;
  maximized: boolean;
}

export const hexId = (wid: number) => '0x' + wid.toString(16);

export function parseWindowId(id: string | number): number {
  if (typeof id === 'number') return id;
  const n = /^0x[0-9a-f]+$/i.test(id) ? parseInt(id, 16) : /^\d+$/.test(id) ? parseInt(id, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new ApiError('invalid_request', `invalid window id: ${id}`);
  return n;
}

export async function getProperty(s: XSession, wid: number, prop: string | number, type = 0): Promise<{ type: number; format: number; data: Buffer } | null> {
  const atom = typeof prop === 'number' ? prop : await s.atom(prop);
  try {
    const r = await call<any>(s.X, 'GetProperty', 0, wid, atom, type, 0, 1 << 20);
    if (!r || r.type === 0) return null;
    return { type: r.type, format: r.format, data: r.data };
  } catch {
    return null;
  }
}

export function u32list(buf: Buffer | undefined): number[] {
  if (!buf) return [];
  const out: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i += 4) out.push(buf.readUInt32LE(i));
  return out;
}

/** EWMH/ICCCM window management, plus window-epoch tracking. */
export class WindowManager extends EventEmitter {
  private epochs = new Map<number, number>();
  private destroyed = new Set<number>();
  private watched = new Set<number>();
  private lastList: number[] = [];
  private lastActive = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private boundsTimers = new Map<number, NodeJS.Timeout>();

  constructor(private s: XSession) {
    super();
    s.on('xevent', (ev: any) => void this.onEvent(ev));
    void this.refresh(false).catch(() => undefined);
  }

  private async onEvent(ev: any) {
    switch (ev.name) {
      case 'PropertyNotify':
        if (ev.wid === this.s.root) {
          const name = await this.s.atomName(ev.atom).catch(() => '');
          if (name === '_NET_CLIENT_LIST_STACKING' || name === '_NET_CLIENT_LIST' || name === '_NET_ACTIVE_WINDOW') this.scheduleRefresh();
        } else if (this.watched.has(ev.wid)) {
          const name = await this.s.atomName(ev.atom).catch(() => '');
          if (name === '_NET_WM_NAME' || name === 'WM_NAME' || name === '_NET_WM_STATE') this.emit('changed', { id: hexId(ev.wid) });
        }
        break;
      case 'DestroyNotify':
        this.typeCache.delete(ev.wid);
        if (this.watched.has(ev.wid)) {
          this.watched.delete(ev.wid);
          this.destroyed.add(ev.wid);
        }
        break;
      case 'ConfigureNotify':
        if (this.watched.has(ev.wid1)) this.scheduleBounds(ev.wid1);
        break;
    }
  }

  private scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh(true).catch(() => undefined);
    }, 30);
  }

  private scheduleBounds(wid: number) {
    if (this.boundsTimers.has(wid)) return;
    this.boundsTimers.set(wid, setTimeout(async () => {
      this.boundsTimers.delete(wid);
      try {
        const b = await this.bounds(wid);
        this.emit('bounds', { id: hexId(wid), epoch: this.epochOf(wid), bounds: b });
      } catch { /* gone */ }
    }, 50));
  }

  epochOf(wid: number): number {
    if (this.destroyed.has(wid)) {
      this.destroyed.delete(wid);
      this.epochs.set(wid, (this.epochs.get(wid) ?? 0) + 1);
    }
    return this.epochs.get(wid) ?? 0;
  }

  private watch(wid: number) {
    if (this.watched.has(wid)) return;
    this.watched.add(wid);
    try {
      this.s.X.ChangeWindowAttributes(wid, { eventMask: x11.eventMask.StructureNotify | x11.eventMask.PropertyChange });
    } catch { /* ignore */ }
  }

  async hasWindowManager(): Promise<boolean> {
    const p = await getProperty(this.s, this.s.root, '_NET_SUPPORTING_WM_CHECK');
    return !!p && u32list(p.data)[0] > 0;
  }

  private typeCache = new Map<number, boolean>();
  /** Panels, docks and desktop backgrounds are part of the shell, not app windows. */
  private async isShellWindow(wid: number): Promise<boolean> {
    const cached = this.typeCache.get(wid);
    if (cached !== undefined) return cached;
    const p = await getProperty(this.s, wid, '_NET_WM_WINDOW_TYPE');
    const types = u32list(p?.data);
    const shell = new Set([await this.s.atom('_NET_WM_WINDOW_TYPE_DOCK'), await this.s.atom('_NET_WM_WINDOW_TYPE_DESKTOP')]);
    const res = types.some((t) => shell.has(t));
    this.typeCache.set(wid, res);
    return res;
  }

  async clientIds(): Promise<number[]> {
    for (const name of ['_NET_CLIENT_LIST_STACKING', '_NET_CLIENT_LIST']) {
      const p = await getProperty(this.s, this.s.root, name);
      if (p) {
        const out: number[] = [];
        for (const id of u32list(p.data)) if (!(await this.isShellWindow(id))) out.push(id);
        return out;
      }
    }
    // No EWMH WM: fall back to mapped top-level children of root.
    const tree = await call<any>(this.s.X, 'QueryTree', this.s.root);
    const out: number[] = [];
    for (const c of tree.children as number[]) {
      try {
        const a = await call<any>(this.s.X, 'GetWindowAttributes', c);
        if (a.mapState === 2 && !a.overrideRedirect && a.klass === 1) out.push(c);
      } catch { /* gone */ }
    }
    return out;
  }

  async activeId(): Promise<number> {
    const p = await getProperty(this.s, this.s.root, '_NET_ACTIVE_WINDOW');
    if (p) return u32list(p.data)[0] ?? 0;
    const f = await call<any>(this.s.X, 'GetInputFocus');
    return f.focus > 1 ? f.focus : 0;
  }

  /** Recompute the client list and emit created/destroyed/focus events. */
  async refresh(emit: boolean): Promise<number[]> {
    const ids = await this.clientIds();
    const active = await this.activeId();
    const prev = new Set(this.lastList);
    const now = new Set(ids);
    for (const id of ids) {
      this.watch(id);
      if (emit && !prev.has(id)) this.emit('created', { id: hexId(id), epoch: this.epochOf(id) });
    }
    for (const id of this.lastList) if (emit && !now.has(id)) this.emit('destroyed', { id: hexId(id), epoch: this.epochs.get(id) ?? 0 });
    if (emit && active !== this.lastActive) this.emit('focus', { id: active ? hexId(active) : null });
    this.lastList = ids;
    this.lastActive = active;
    return ids;
  }

  async bounds(wid: number): Promise<Bounds> {
    const g = await call<any>(this.s.X, 'GetGeometry', wid);
    const t = await call<any>(this.s.X, 'TranslateCoordinates', wid, this.s.root, 0, 0);
    return { x: t.destX, y: t.destY, width: g.width, height: g.height };
  }

  private async title(wid: number): Promise<string> {
    const utf8 = await this.s.atom('UTF8_STRING');
    const n = await getProperty(this.s, wid, '_NET_WM_NAME', utf8);
    if (n?.data?.length) return n.data.toString('utf8');
    const w = await getProperty(this.s, wid, this.s.X.atoms.WM_NAME);
    return w?.data ? w.data.toString('latin1') : '';
  }

  async info(wid: number, active?: number): Promise<WindowInfo> {
    let bounds: Bounds;
    try {
      bounds = await this.bounds(wid);
    } catch {
      throw new ApiError('target_unavailable', `window ${hexId(wid)} does not exist`);
    }
    const [title, cls, pidP, stateP] = await Promise.all([
      this.title(wid),
      getProperty(this.s, wid, this.s.X.atoms.WM_CLASS),
      getProperty(this.s, wid, '_NET_WM_PID'),
      getProperty(this.s, wid, '_NET_WM_STATE'),
    ]);
    const clsParts = cls?.data ? cls.data.toString('latin1').split('\0') : [];
    const states = new Set(u32list(stateP?.data));
    const [hidden, maxV, maxH] = await Promise.all([
      this.s.atom('_NET_WM_STATE_HIDDEN'), this.s.atom('_NET_WM_STATE_MAXIMIZED_VERT'), this.s.atom('_NET_WM_STATE_MAXIMIZED_HORZ'),
    ]);
    const act = active ?? (await this.activeId());
    return {
      id: hexId(wid),
      epoch: this.epochOf(wid),
      title,
      app: clsParts[1] || null,
      app_instance: clsParts[0] || null,
      pid: pidP?.data?.length ? pidP.data.readUInt32LE(0) : null,
      bounds,
      focused: act === wid,
      minimized: states.has(hidden),
      maximized: states.has(maxV) && states.has(maxH),
    };
  }

  async list(): Promise<WindowInfo[]> {
    const ids = await this.refresh(false);
    const active = await this.activeId();
    const out: WindowInfo[] = [];
    for (const id of ids) {
      try { out.push(await this.info(id, active)); } catch { /* raced with destroy */ }
    }
    return out;
  }

  /** Validate an id (+ optional epoch) and return the numeric window. */
  async resolve(id: string | number, epoch?: number): Promise<number> {
    const wid = parseWindowId(id);
    if (epoch !== undefined && epoch !== this.epochOf(wid)) throw new ApiError('stale_handle', `window ${hexId(wid)} epoch ${epoch} is stale (current ${this.epochOf(wid)})`);
    try {
      await call(this.s.X, 'GetGeometry', wid);
    } catch {
      throw new ApiError('target_unavailable', `window ${hexId(wid)} does not exist`);
    }
    if (this.destroyed.has(wid) && epoch !== undefined) throw new ApiError('stale_handle', `window ${hexId(wid)} was destroyed`);
    return wid;
  }

  private async clientMessage(wid: number, type: string, data: number[]) {
    const atom = await this.s.atom(type);
    this.s.X.SendClientMessage(this.s.root, wid, atom, 32, data);
    await this.s.sync();
  }

  async activate(wid: number) {
    if (await this.hasWindowManager()) {
      await this.clientMessage(wid, '_NET_ACTIVE_WINDOW', [2, 0, 0]);
    } else {
      this.s.X.MapWindow(wid);
      this.s.X.RaiseWindow(wid);
      this.s.X.SetInputFocus(wid, 1, 0);
      await this.s.sync();
    }
  }

  async minimize(wid: number) {
    await this.clientMessage(wid, 'WM_CHANGE_STATE', [3]);
  }

  private async setMaximized(wid: number, on: boolean) {
    const v = await this.s.atom('_NET_WM_STATE_MAXIMIZED_VERT');
    const h = await this.s.atom('_NET_WM_STATE_MAXIMIZED_HORZ');
    await this.clientMessage(wid, '_NET_WM_STATE', [on ? 1 : 0, v, h, 2]);
  }

  async maximize(wid: number) { await this.setMaximized(wid, true); }

  async restore(wid: number) {
    const info = await this.info(wid);
    if (info.minimized) await this.activate(wid);
    if (info.maximized) await this.setMaximized(wid, false);
  }

  async close(wid: number) {
    if (await this.hasWindowManager()) await this.clientMessage(wid, '_NET_CLOSE_WINDOW', [0, 2]);
    else {
      const protocols = await getProperty(this.s, wid, 'WM_PROTOCOLS');
      const del = await this.s.atom('WM_DELETE_WINDOW');
      if (u32list(protocols?.data).includes(del)) {
        this.s.X.SendClientMessage(wid, wid, await this.s.atom('WM_PROTOCOLS'), 32, [del, 0], 0);
      } else this.s.X.DestroyWindow(wid);
      await this.s.sync();
    }
  }

  async setBounds(wid: number, b: Partial<Bounds>) {
    if (await this.hasWindowManager()) {
      let flags = 1 /* NorthWest gravity */ | (2 << 12);
      const d = [0, b.x ?? 0, b.y ?? 0, b.width ?? 0, b.height ?? 0];
      if (b.x !== undefined) flags |= 1 << 8;
      if (b.y !== undefined) flags |= 1 << 9;
      if (b.width !== undefined) flags |= 1 << 10;
      if (b.height !== undefined) flags |= 1 << 11;
      d[0] = flags;
      // Un-maximize first, otherwise most WMs ignore the request.
      await this.setMaximized(wid, false);
      await this.clientMessage(wid, '_NET_MOVERESIZE_WINDOW', d);
    } else {
      const opts: Record<string, number> = {};
      for (const k of ['x', 'y', 'width', 'height'] as const) if (b[k] !== undefined) opts[k] = b[k]!;
      this.s.X.ConfigureWindow(wid, opts);
      await this.s.sync();
    }
  }

  /** Top-level client window under a root coordinate, if any. */
  async windowAt(x: number, y: number): Promise<number | null> {
    const ids = await this.clientIds();
    for (let i = ids.length - 1; i >= 0; i--) {
      try {
        const b = await this.bounds(ids[i]);
        const info = await this.info(ids[i]);
        if (info.minimized) continue;
        if (x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height) return ids[i];
      } catch { /* ignore */ }
    }
    return null;
  }

  dispose() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const t of this.boundsTimers.values()) clearTimeout(t);
    this.removeAllListeners();
  }
}
