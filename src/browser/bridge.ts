import { createHash, randomBytes } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
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

/** Whether a server accepts connections on this Unix socket. */
function listening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    const done = (live: boolean) => { s.destroy(); resolve(live); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

function listenOn(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
}

const closeServer = (server: Server) => new Promise<void>((r) => server.close(() => r()));

/**
 * Held while a bridge owns `path`, so two servers starting together can't both take it:
 * an abstract Unix socket (Linux), which only one process can bind and which the kernel
 * releases when its holder exits, so there is no stale lock to clean up. (Another local
 * user could squat the name and keep the bridge from starting, but never impersonate it.)
 */
async function acquireLock(path: string): Promise<Server> {
  const server = createServer((s) => s.destroy());
  const name = `\0ozwell-computer-browser-bridge:${createHash('sha256').update(path).digest('hex').slice(0, 32)}`;
  try {
    await listenOn(server, name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`another server is listening on ${path}`);
    throw e;
  }
  return server;
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
  private readonly pending = new Map<string, Pending>();
  private readonly waiters = new Set<() => void>();
  private nextId = 1;
  /** Prefixes request ids: a native host that outlived a previous server may still
   * deliver that server's replies, which must not answer this one's requests. */
  private readonly nonce = randomBytes(6).toString('base64url');
  /** Inode of the socket this bridge put at `path`, while listening. */
  private inode: number | null = null;
  /** The lock on `path` (see acquireLock()), while listening. */
  private lock: Server | null = null;
  private readonly opts: Required<BridgeOptions>;

  constructor(readonly path: string, private readonly log: Logger, opts: BridgeOptions = {}) {
    this.opts = { browserRunning: firefoxRunning, connectWaitMs: 10_000, timeoutMs: 15_000, ...opts };
  }

  /**
   * Listen on the socket. Fails if another server is listening there (or the path is not a
   * socket); replaces a stale socket left behind by one that died.
   */
  async listen(): Promise<void> {
    const held = await acquireLock(this.path);
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const existing = await lstat(this.path).catch(() => null);
      if (existing && !existing.isSocket()) throw new Error(`${this.path} exists and is not a socket`);
      // A server that doesn't take the lock (none should) still keeps its socket.
      if (existing && await listening(this.path)) throw new Error(`another server is listening on ${this.path}`);
      // Bound under a temporary name, then renamed into place: closing a Unix socket server
      // unlinks the path it was bound to, which must never be one another server now owns.
      const tmp = `${this.path}.${process.pid}`;
      await rm(tmp, { force: true });
      const server = createServer((s) => this.accept(s));
      await listenOn(server, tmp);
      await chmod(tmp, 0o600);
      await rename(tmp, this.path);
      this.inode = (await stat(this.path)).ino;
      server.on('error', (e) => this.log.warn({ err: e.message }, 'browser bridge socket error'));
      this.server = server;
      this.lock = held;
    } catch (e) {
      await closeServer(held);
      throw e;
    }
  }

  async close(): Promise<void> {
    for (const c of this.conns) c.socket.destroy();
    const s = this.server;
    this.server = null;
    if (s) await closeServer(s);
    // Only our own socket: another server may have replaced it since.
    if (this.inode !== null && (await stat(this.path).catch(() => null))?.ino === this.inode) await rm(this.path, { force: true }).catch(() => undefined);
    this.inode = null;
    // Last: the next server may take the path only once it is free.
    const l = this.lock;
    this.lock = null;
    if (l) await closeServer(l);
  }

  /** The connected browser, or null. */
  info(): BrowserInfo | null {
    return this.current()?.info ?? null;
  }

  /** Call a method of the extension (e.g. cookies.getAll) and return its result. */
  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    let conn = this.current();
    if (!conn && this.opts.connectWaitMs > 0) {
      const running = await this.opts.browserRunning();
      // The extension may have connected while the process check ran.
      conn = this.current() ?? (running ? await this.waitForConnection(this.opts.connectWaitMs) : null);
    }
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
    const id = `${this.nonce}.${this.nextId++}`;
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
      for (const b of bodies) {
        // An exception here would be uncaught, and stop the server.
        try { this.receive(b); } catch (e) { this.log.warn({ err: (e as Error).message }, 'browser bridge: bad reply ignored'); }
      }
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

  /** A reply from the extension. Anything else (bad JSON, null, not an object) is ignored. */
  private receive(body: Buffer) {
    let msg: unknown;
    try { msg = JSON.parse(body.toString('utf8')); } catch { return; }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return;
    const { id, result, error } = msg as { id?: unknown; result?: unknown; error?: unknown };
    const p = typeof id === 'string' ? this.pending.get(id) : undefined;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id as string);
    if (error === undefined) p.resolve(result);
    else p.reject(new ApiError('invalid_request', `Firefox: ${typeof error === 'string' ? error : JSON.stringify(error)}`));
  }
}
