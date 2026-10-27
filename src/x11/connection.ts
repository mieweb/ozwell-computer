import { EventEmitter } from 'node:events';
import x11 from 'x11';
import type { Logger } from 'pino';
import { ApiError } from '../errors.js';

/** Promisify a node-x11 request whose last argument is `cb(err, result)`. */
export function call<T = any>(X: any, method: string, ...args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      X[method](...args, (err: unknown, res: T) => (err ? reject(xError(err, method)) : resolve(res)));
    } catch (e) {
      reject(e);
    }
  });
}

function xError(err: unknown, method: string): Error {
  if (err instanceof Error) return err;
  const e = err as { error?: number; message?: string; badParam?: number };
  const out = new Error(`X error in ${method}: ${e?.message ?? JSON.stringify(err)}`);
  (out as any).x11 = err;
  return out;
}

export interface PixelLayout {
  bitsPerPixel: number;
  depth: number;
  redShift: number;
  greenShift: number;
  blueShift: number;
  redMax: number;
  greenMax: number;
  blueMax: number;
  bigEndian: boolean;
}

export interface Extensions {
  xtest: any | null;
  damage: any | null;
  fixes: any | null;
  randr: any | null;
  composite: any | null;
}

function maskInfo(mask: number): { shift: number; max: number } {
  if (!mask) return { shift: 0, max: 0 };
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  return { shift, max: mask >>> shift };
}

/** A live connection to one X display. */
export class XSession extends EventEmitter {
  readonly X: any;
  readonly display: any;
  readonly root: number;
  readonly ext: Extensions;
  readonly pixel: PixelLayout;
  readonly maxRequestBytes: number;
  readonly displayName: string;
  closed = false;
  /** Increments every time the root geometry changes. */
  geometryEpoch = 0;
  width: number;
  height: number;

  private constructor(displayName: string, X: any, display: any, ext: Extensions) {
    super();
    this.setMaxListeners(100);
    this.displayName = displayName;
    this.X = X;
    this.display = display;
    const scr = display.screen[0];
    this.root = scr.root;
    this.width = scr.pixel_width;
    this.height = scr.pixel_height;
    this.ext = ext;
    const depth = scr.root_depth;
    const visual = scr.depths?.[depth]?.[scr.root_visual] ?? { red_mask: 0xff0000, green_mask: 0xff00, blue_mask: 0xff };
    const r = maskInfo(visual.red_mask);
    const g = maskInfo(visual.green_mask);
    const b = maskInfo(visual.blue_mask);
    this.pixel = {
      depth,
      bitsPerPixel: display.format?.[depth]?.bits_per_pixel ?? 32,
      redShift: r.shift, greenShift: g.shift, blueShift: b.shift,
      redMax: r.max, greenMax: g.max, blueMax: b.max,
      bigEndian: display.image_byte_order === 1,
    };
    this.maxRequestBytes = (display.max_request_length ?? 65535) * 4;
    X.on('event', (ev: any) => this.emit('xevent', ev));
    X.on('error', (err: any) => this.emit('xerror', err));
    X.on('end', () => this.markClosed());
    X.on('close', () => this.markClosed());
  }

  private markClosed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  static async connect(displayName: string, log?: Logger): Promise<XSession> {
    const { X, display } = await new Promise<{ X: any; display: any }>((resolve, reject) => {
      let settled = false;
      const client = x11.createClient({ display: displayName }, (err: unknown, display: any) => {
        if (settled) return;
        settled = true;
        if (err) reject(err instanceof Error ? err : new Error(String((err as any)?.message ?? err)));
        else resolve({ X: display.client, display });
      });
      client.on('error', (err: unknown) => {
        if (!settled) { settled = true; reject(err); }
      });
    });
    const load = (name: string) =>
      new Promise<any | null>((resolve) => {
        X.require(name, (err: unknown, ext: any) => {
          if (err) { log?.debug({ ext: name }, 'X extension unavailable'); resolve(null); }
          else resolve(ext);
        });
      });
    const ext: Extensions = {
      xtest: await load('xtest'),
      damage: await load('damage'),
      fixes: await load('fixes'),
      randr: await load('randr'),
      composite: null,
    };
    const s = new XSession(displayName, X, display, ext);
    await s.watchRoot();
    return s;
  }

  private async watchRoot() {
    const em = x11.eventMask;
    this.X.ChangeWindowAttributes(this.root, {
      eventMask: em.StructureNotify | em.SubstructureNotify | em.PropertyChange,
    });
    if (this.ext.randr) {
      try { this.ext.randr.SelectInput(this.root, this.ext.randr.NotifyMask.ScreenChange ?? 1); } catch { /* ignore */ }
    }
    this.on('xevent', (ev: any) => {
      if (ev.name === 'ConfigureNotify' && ev.wid1 === this.root) {
        if (ev.width !== this.width || ev.height !== this.height) this.setGeometry(ev.width, ev.height);
      } else if (typeof ev.name === 'string' && ev.name.startsWith('RRScreenChangeNotify')) {
        void this.refreshGeometry();
      }
    });
  }

  private setGeometry(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.geometryEpoch++;
    this.emit('geometry', { width: w, height: h, epoch: this.geometryEpoch });
  }

  async refreshGeometry(): Promise<void> {
    const g = await call<any>(this.X, 'GetGeometry', this.root);
    if (g.width !== this.width || g.height !== this.height) this.setGeometry(g.width, g.height);
  }

  private atomCache = new Map<string, number>();
  async atom(name: string): Promise<number> {
    const cached = this.atomCache.get(name) ?? this.X.atoms?.[name];
    if (cached) return cached;
    const id = await call<number>(this.X, 'InternAtom', false, name);
    this.atomCache.set(name, id);
    return id;
  }

  async atomName(id: number): Promise<string> {
    return call<string>(this.X, 'GetAtomName', id);
  }

  allocId(): number {
    return this.X.AllocID();
  }

  /** Round trip: guarantees all prior requests were processed. */
  async sync(): Promise<void> {
    await call(this.X, 'GetInputFocus');
  }

  extensionNames(): string[] {
    const out: string[] = [];
    if (this.ext.xtest) out.push('XTEST');
    if (this.ext.damage) out.push('DAMAGE');
    if (this.ext.fixes) out.push('XFIXES');
    if (this.ext.randr) out.push('RANDR');
    return out;
  }

  close() {
    if (this.closed) return;
    try { this.X.terminate?.() ?? this.X.close?.(); } catch { /* ignore */ }
    this.markClosed();
  }
}

/**
 * Holds the current XSession and reconnects when the display goes away.
 * Services listen for 'session' to (re)initialise per-connection state.
 */
export class XManager extends EventEmitter {
  private current: XSession | null = null;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;
  lastError: string | null = null;

  constructor(readonly displayName: string, private log: Logger) {
    super();
    this.setMaxListeners(100);
  }

  get session(): XSession | null {
    return this.current && !this.current.closed ? this.current : null;
  }

  /** Throws `target_unavailable` when no display is connected. */
  require(): XSession {
    const s = this.session;
    if (!s) throw new ApiError('target_unavailable', `X display ${this.displayName} is not connected` + (this.lastError ? `: ${this.lastError}` : ''));
    return s;
  }

  async start(): Promise<void> {
    await this.tryConnect();
  }

  private async tryConnect(): Promise<void> {
    if (this.stopped) return;
    try {
      const s = await XSession.connect(this.displayName, this.log);
      this.current = s;
      this.lastError = null;
      this.log.info({ display: this.displayName, width: s.width, height: s.height, extensions: s.extensionNames() }, 'connected to X display');
      s.on('xerror', (err: any) => this.log.debug({ err: err?.message ?? err }, 'X error'));
      s.once('close', () => {
        this.log.warn({ display: this.displayName }, 'X connection closed; will reconnect');
        this.emit('down');
        this.scheduleRetry();
      });
      this.emit('session', s);
    } catch (err) {
      this.lastError = (err as Error)?.message ?? String(err);
      this.log.warn({ display: this.displayName, err: this.lastError }, 'cannot connect to X display; retrying');
      this.scheduleRetry();
    }
  }

  private scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.tryConnect();
    }, 1000);
    this.retryTimer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.current?.close();
  }
}
