import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import { ApiError } from '../errors.js';
import { FrameReader, frame } from './protocol.js';

export interface BrowserInfo { name: string; version: string }

interface Conn { socket: Socket; info: BrowserInfo | null }
interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; conn: Conn }

export interface BridgeOptions {
  /** Whether a browser process is running: a call waits for its extension to connect only then. */
  browserRunning?: () => Promise<boolean>;
  /** How long a call waits for a starting browser's extension to connect. */
  connectWaitMs?: number;
  /** How long a call waits for the extension's answer. */
  timeoutMs?: number;
}

export const NOT_CONNECTED = 'Firefox is not running, or its ozwell-computer extension is not connected. ' +
  'Start Firefox (launch_app "firefox-esr", or POST /api/v1/apps/launch) and try again.';

/** The bridge, or feature_unsupported when the server runs without one. */
export function needBridge(b: BrowserBridge | null): BrowserBridge {
  if (!b) throw new ApiError('feature_unsupported', 'the browser bridge is not running', { feature: 'browser' });
  return b;
}

/** Whether a Firefox process is running (its main process is named firefox, firefox-esr or firefox-bin). */
export async function firefoxRunning(): Promise<boolean> {
  const pids = (await readdir('/proc').catch(() => [] as string[])).filter((p) => /^\d+$/.test(p));
  for (const pid of pids) {
    const comm = await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '');
    if (/^firefox(-esr|-bin)?\n?$/.test(comm)) return true;
  }
  return false;
}

/**
 * The server end of the link to Firefox's ozwell-computer extension: a Unix socket that
 * its native messaging host connects to (see protocol.ts). The latest connection whose
 * extension answered `browser.info` is the one calls go to.
 */
export class BrowserBridge {
  private server: Server | null = null;
  private readonly conns = new Set<Conn>();
  private readonly ready: Conn[] = [];
  private readonly pending = new Map<number, Pending>();
  private readonly waiters = new Set<() => void>();
  private nextId = 1;
  private readonly opts: Required<BridgeOptions>;

  constructor(readonly path: string, private readonly log: Logger, opts: BridgeOptions = {}) {
    this.opts = { browserRunning: firefoxRunning, connectWaitMs: 10_000, timeoutMs: 15_000, ...opts };
  }

  async listen(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await rm(this.path, { force: true }); // left behind by a previous server
    const server = createServer((s) => this.accept(s));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.path, () => { server.off('error', reject); resolve(); });
    });
    await chmod(this.path, 0o600);
    server.on('error', (e) => this.log.warn({ err: e.message }, 'browser bridge socket error'));
    this.server = server;
  }

  async close(): Promise<void> {
    for (const c of this.conns) c.socket.destroy();
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
    await rm(this.path, { force: true }).catch(() => undefined);
  }

  /** The connected browser, or null. */
  info(): BrowserInfo | null {
    return this.current()?.info ?? null;
  }

  /** Call a method of the extension (e.g. cookies.getAll) and return its result. */
  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    let conn = this.current();
    if (!conn && this.opts.connectWaitMs > 0 && await this.opts.browserRunning()) conn = await this.waitForConnection(this.opts.connectWaitMs);
    if (!conn) throw new ApiError('target_unavailable', NOT_CONNECTED);
    return this.send<T>(conn, method, params);
  }

  private current(): Conn | null {
    return this.ready.at(-1) ?? null;
  }

  private waitForConnection(ms: number): Promise<Conn | null> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(this.current()); };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  private send<T>(conn: Conn, method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ApiError('target_unavailable', `Firefox did not answer ${method} within ${this.opts.timeoutMs / 1000} s`));
      }, this.opts.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, conn });
      conn.socket.write(frame({ id, method, params }));
    });
  }

  private accept(socket: Socket) {
    const conn: Conn = { socket, info: null };
    this.conns.add(conn);
    const reader = new FrameReader();
    socket.on('data', (chunk: Buffer) => {
      let bodies: Buffer[];
      try { bodies = reader.push(chunk); } catch (e) {
        this.log.warn({ err: (e as Error).message }, 'browser bridge: bad frame; dropping the connection');
        socket.destroy();
        return;
      }
      for (const b of bodies) this.receive(b);
    });
    socket.on('error', () => undefined); // 'close' follows
    socket.on('close', () => {
      this.conns.delete(conn);
      const i = this.ready.indexOf(conn);
      if (i >= 0) {
        this.ready.splice(i, 1);
        this.log.info('browser extension disconnected');
      }
      for (const [id, p] of this.pending) {
        if (p.conn !== conn) continue;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new ApiError('target_unavailable', 'Firefox disconnected before answering (did it close?)'));
      }
    });
    // The extension proves itself by answering; a host whose browser went away never does.
    this.send<BrowserInfo>(conn, 'browser.info', {}).then((info) => {
      if (!this.conns.has(conn)) return;
      conn.info = { name: String(info?.name ?? 'unknown'), version: String(info?.version ?? '') };
      this.ready.push(conn);
      this.log.info({ browser: conn.info }, 'browser extension connected');
      for (const w of [...this.waiters]) w();
    }, (e: Error) => {
      this.log.warn({ err: e.message }, 'browser extension did not identify itself; dropping the connection');
      socket.destroy();
    });
  }

  private receive(body: Buffer) {
    let msg: { id?: unknown; result?: unknown; error?: unknown };
    try { msg = JSON.parse(body.toString('utf8')); } catch { return; }
    const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id as number);
    if (msg.error !== undefined) p.reject(new ApiError('invalid_request', `Firefox: ${String(msg.error)}`));
    else p.resolve(msg.result);
  }
}
