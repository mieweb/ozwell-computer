// Shared helpers for the integration suite (server URL/token come from global-setup.ts).
import { expect, inject } from 'vitest';
import WebSocket from 'ws';

export const URL_ = inject('ozUrl');
export const TOKEN = inject('ozToken');
export const auth = { authorization: `Bearer ${TOKEN}` };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(URL_ + path, {
    method, headers: { ...auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual',
  });
  const ct = r.headers.get('content-type') ?? '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}

export async function exec(cmd: string) {
  return (await api('POST', '/api/v1/exec', { cmd, timeout_ms: 10000 })).body as { stdout: string; exit_code: number };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 10000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(200);
  }
}

export async function freshXterm(title: string): Promise<string> {
  await api('POST', '/api/v1/apps/launch', { command: 'xterm', args: ['-xrm', 'XTerm*allowTitleOps: false', '-T', title, '-geometry', '80x20+100+100'] });
  const w = await waitFor(async () => ((await api('GET', '/api/v1/windows')).body.windows as any[]).find((x) => x.title === title));
  await api('POST', `/api/v1/windows/${w.id}/activate`);
  await sleep(300);
  return w.id;
}


export async function windows(): Promise<any[]> {
  return (await api('GET', '/api/v1/windows')).body.windows;
}

/** Launch a zenity dialog (writes its result to `out`) and return its window id. */
export async function zenity(args: string[], out: string, title: string): Promise<string> {
  await exec(`rm -f ${out}`);
  await api('POST', '/api/v1/apps/launch', { command: 'sh', args: ['-c', `zenity --title='${title}' ${args.map((a) => `'${a}'`).join(' ')} > ${out}`] });
  const w = await waitFor(async () => (await windows()).find((x) => x.title === title));
  await api('POST', `/api/v1/windows/${w.id}/activate`);
  await sleep(500);
  return w.id;
}

/** Poll a file in the container until it has content. */
export async function fileContent(path: string, ms = 8000): Promise<string> {
  return waitFor(async () => (await exec(`cat ${path} 2>/dev/null`)).stdout, ms);
}

/** PNG of a screen region, for before/after comparisons. */
export async function regionShot(x: number, y: number, w: number, h: number): Promise<Buffer> {
  return (await api('GET', `/api/v1/screenshot?region=${x},${y},${w},${h}&format=png`)).body as Buffer;
}

export class RfbClient {
  ws!: WebSocket;
  buf = Buffer.alloc(0);
  waiters: Array<() => void> = [];
  width = 0; height = 0;
  constructor(private url: string, private headers: Record<string, string>) {}
  async open() {
    this.ws = new WebSocket(this.url, { headers: this.headers });
    this.ws.on('message', (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.waiters.splice(0).forEach((w) => w()); });
    await new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
  }
  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n) await new Promise<void>((res, rej) => { this.waiters.push(res); setTimeout(() => rej(new Error('rfb read timeout')), 10000); });
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  send(b: Buffer | number[]) { this.ws.send(Buffer.from(b as any)); }
  async handshake() {
    expect((await this.read(12)).toString()).toBe('RFB 003.008\n');
    this.send(Buffer.from('RFB 003.008\n'));
    expect([...(await this.read(2))]).toEqual([1, 1]);
    this.send([1]);
    expect((await this.read(4)).readUInt32BE(0)).toBe(0);
    this.send([1]);
    const init = await this.read(24);
    this.width = init.readUInt16BE(0); this.height = init.readUInt16BE(2);
    await this.read(init.readUInt32BE(20));
    // noVNC-style pixel format: 32bpp, R at shift 0
    const pf = Buffer.alloc(20);
    pf[0] = 0; pf[4] = 32; pf[5] = 24; pf[6] = 0; pf[7] = 1;
    pf.writeUInt16BE(255, 8); pf.writeUInt16BE(255, 10); pf.writeUInt16BE(255, 12);
    pf[14] = 0; pf[15] = 8; pf[16] = 16;
    this.send(pf);
  }
  setEncodings(encs: number[]) {
    const b = Buffer.alloc(4 + 4 * encs.length);
    b[0] = 2; b.writeUInt16BE(encs.length, 2);
    encs.forEach((e, i) => b.writeInt32BE(e, 4 + 4 * i));
    this.send(b);
  }
  request(incremental: boolean, x = 0, y = 0, w = this.width, h = this.height) {
    const b = Buffer.alloc(10);
    b[0] = 3; b[1] = incremental ? 1 : 0; b.writeUInt16BE(x, 2); b.writeUInt16BE(y, 4); b.writeUInt16BE(w, 6); b.writeUInt16BE(h, 8);
    this.send(b);
  }
  /** Read one FramebufferUpdate; returns rect headers (+ zrle payload sizes). */
  async update(): Promise<Array<{ x: number; y: number; w: number; h: number; enc: number; bytes: number }>> {
    let t: number;
    while ((t = (await this.read(1))[0]) !== 0) {
      if (t === 3) { await this.read(3); const len = (await this.read(4)).readUInt32BE(0); await this.read(len); continue; }
      if (t === 2) continue;
      throw new Error('unexpected server message ' + t);
    }
    const hdr = await this.read(3);
    const n = hdr.readUInt16BE(1);
    const rects = [];
    for (let i = 0; i < n; i++) {
      const r = await this.read(12);
      const rect = { x: r.readUInt16BE(0), y: r.readUInt16BE(2), w: r.readUInt16BE(4), h: r.readUInt16BE(6), enc: r.readInt32BE(8), bytes: 0 };
      if (rect.enc === 16) { const len = (await this.read(4)).readUInt32BE(0); this.zrle.push(await this.read(len)); rect.bytes = len; }
      else if (rect.enc === 0) { rect.bytes = rect.w * rect.h * 4; await this.read(rect.bytes); }
      else if (rect.enc === -239) { rect.bytes = rect.w * rect.h * 4 + Math.ceil(rect.w / 8) * rect.h; await this.read(rect.bytes); }
      rects.push(rect);
    }
    return rects;
  }
  zrle: Buffer[] = [];
  close() { this.ws.close(); }
}

