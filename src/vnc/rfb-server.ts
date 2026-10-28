import type { Logger } from 'pino';
import type { Desktop } from '../desktop.js';
import type { XSession } from '../x11/connection.js';
import { captureRect, getCursorImage, type Rect } from '../x11/capture.js';
import { addRect, DamageTracker } from '../x11/damage.js';
import { ENC, NATIVE_PF, PixelConverter, ZlibStream, decodePixelFormat, encodePixelFormat, pixelsOf, rectHeader, validPixelFormat, zrleTiles } from './encodings.js';

export interface RfbTransport {
  send(buf: Buffer): void;
  close(reason?: string): void;
  /** Bytes queued but not yet sent (for back-pressure). */
  buffered(): number;
}

export interface RfbOptions {
  viewOnly: boolean;
  name: string;
  participantName?: string;
  /** Existing presence participant (from the viewer page) to drive with this socket's pointer. */
  participantId?: string;
}

const trackers = new WeakMap<XSession, DamageTracker>();
export function trackerFor(s: XSession): DamageTracker {
  let t = trackers.get(s);
  if (!t) { t = new DamageTracker(s); trackers.set(s, t); }
  return t;
}

const MAX_CUT_TEXT = 1 << 20;
let sessionSeq = 0;

type State = 'version' | 'security' | 'init' | 'normal' | 'closed';

/** One RFB 3.8 connection served from the live X display. */
export class RfbSession {
  private state: State = 'version';
  private inbuf: Buffer = Buffer.alloc(0);
  private s: XSession;
  private conv = new PixelConverter(NATIVE_PF);
  private encodings = new Set<number>();
  private zlib: ZlibStream | null = null;
  private dirty: Rect[] = [];
  private pending: { incremental: boolean; rect: Rect } | null = null;
  private sending = false;
  private cursorDirty = true;
  private sizeDirty = false;
  private buttons = 0;
  private shiftsHeld = new Set<number>();
  private tracker: DamageTracker;
  private participantId: string | null = null;
  private lastCursorPublish = 0;
  private readonly id = ++sessionSeq;
  private width: number;
  private height: number;
  private inputChain: Promise<unknown> = Promise.resolve();
  private unsub: Array<() => void> = [];

  constructor(private desktop: Desktop, private t: RfbTransport, private opts: RfbOptions, private log: Logger) {
    this.s = desktop.x.require();
    this.width = this.s.width;
    this.height = this.s.height;
    this.tracker = trackerFor(this.s);
    t.send(Buffer.from('RFB 003.008\n', 'latin1'));
  }

  // ------------------------------------------------------------ lifecycle

  private startNormal() {
    this.state = 'normal';
    const onDamage = (rects: Rect[]) => {
      for (const r of rects) this.dirty = addRect(this.dirty, r);
      this.pump();
    };
    this.tracker.on('damage', onDamage);
    this.tracker.acquire();
    this.unsub.push(() => { this.tracker.off('damage', onDamage); this.tracker.release(); });

    const onGeom = (g: { width: number; height: number }) => {
      this.width = g.width; this.height = g.height;
      this.sizeDirty = true;
      this.dirty = [{ x: 0, y: 0, w: g.width, h: g.height }];
      this.pump();
    };
    this.s.on('geometry', onGeom);
    this.unsub.push(() => this.s.off('geometry', onGeom));

    const fixes = this.s.ext.fixes;
    if (fixes) {
      fixes.SelectCursorInput(this.s.root, 1);
      const onEv = (ev: any) => {
        if (ev.type === fixes.firstEvent + 1) { this.cursorDirty = true; this.pump(); }
      };
      this.s.on('xevent', onEv);
      this.unsub.push(() => this.s.off('xevent', onEv));
    }

    const ctl = this.desktop.ctl();
    const onClip = async (d: { owner_is_self?: boolean }) => {
      if (d.owner_is_self) return;
      try {
        const c = await ctl.clipboard.read();
        if (c.text !== undefined) this.sendCutText(c.text);
      } catch { /* ignore */ }
    };
    ctl.clipboard.on('changed', onClip);
    this.unsub.push(() => ctl.clipboard.off('changed', onClip));

    const onClose = () => this.close('display disconnected');
    this.s.once('close', onClose);
    this.unsub.push(() => this.s.off('close', onClose));

    if (this.opts.participantId && this.desktop.presence.get(this.opts.participantId)) {
      this.participantId = this.opts.participantId;
    } else {
      const p = this.desktop.presence.join({ name: this.opts.participantName || `viewer ${this.id}`, kind: 'human', key: `vnc:${this.id}` });
      this.participantId = p.participant_id;
    }
  }

  close(reason = 'closed') {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const u of this.unsub) { try { u(); } catch { /* ignore */ } }
    this.unsub = [];
    this.zlib?.close();
    // The viewer's participant lives exactly as long as its socket; the page re-joins on reconnect.
    if (this.participantId) this.desktop.presence.leave(this.participantId);
    // Release anything this viewer held down.
    if (this.buttons && !this.s.closed) {
      const ctl = this.desktop.ctl();
      for (let b = 0; b < 8; b++) if (this.buttons & (1 << b)) void ctl.input.button(b + 1, false).catch(() => undefined);
    }
    this.t.close(reason);
    this.log.debug({ id: this.id, reason }, 'rfb session closed');
  }

  // ------------------------------------------------------------ parsing

  feed(chunk: Buffer) {
    if (this.state === 'closed') return;
    this.inbuf = this.inbuf.length ? Buffer.concat([this.inbuf, chunk]) : chunk;
    if (this.inbuf.length > 32 * 1024 * 1024) return this.close('input buffer overflow');
    try {
      while ((this.state as State) !== 'closed') {
        const used = this.parseOne(this.inbuf);
        if (used === 0) break;
        this.inbuf = this.inbuf.subarray(used);
      }
    } catch (e) {
      this.log.debug({ err: (e as Error).message }, 'rfb protocol error');
      this.close('protocol error');
    }
  }

  /** Parse one message; returns bytes consumed or 0 if more data is needed. */
  private parseOne(b: Buffer): number {
    switch (this.state) {
      case 'version': {
        if (b.length < 12) return 0;
        const v = b.subarray(0, 12).toString('latin1');
        const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(v);
        if (!m) throw new Error('bad version');
        if (Number(m[1]) !== 3 || Number(m[2]) < 8) {
          // 3.3/3.7 clients are not supported; tell them why in 3.3 style.
          const reason = Buffer.from('RFB 3.8 required', 'latin1');
          const out = Buffer.alloc(8 + reason.length);
          out.writeUInt32BE(0, 0); out.writeUInt32BE(reason.length, 4); reason.copy(out, 8);
          this.t.send(out);
          this.close('unsupported version');
          return 12;
        }
        this.t.send(Buffer.from([1, 1])); // one security type: None
        this.state = 'security';
        return 12;
      }
      case 'security': {
        if (b.length < 1) return 0;
        if (b[0] !== 1) {
          const reason = Buffer.from('unsupported security type', 'latin1');
          const out = Buffer.alloc(8 + reason.length);
          out.writeUInt32BE(1, 0); out.writeUInt32BE(reason.length, 4); reason.copy(out, 8);
          this.t.send(out);
          this.close('bad security type');
          return 1;
        }
        this.t.send(Buffer.from([0, 0, 0, 0]));
        this.state = 'init';
        return 1;
      }
      case 'init': {
        if (b.length < 1) return 0;
        const name = Buffer.from(this.opts.name, 'utf8');
        const out = Buffer.alloc(24 + name.length);
        out.writeUInt16BE(this.width, 0);
        out.writeUInt16BE(this.height, 2);
        encodePixelFormat(NATIVE_PF).copy(out, 4);
        out.writeUInt32BE(name.length, 20);
        name.copy(out, 24);
        this.t.send(out);
        this.startNormal();
        return 1;
      }
      case 'normal':
        return this.parseClientMessage(b);
      default:
        return 0;
    }
  }

  private parseClientMessage(b: Buffer): number {
    if (b.length < 1) return 0;
    switch (b[0]) {
      case 0: { // SetPixelFormat
        if (b.length < 20) return 0;
        const pf = decodePixelFormat(b, 4);
        if (!validPixelFormat(pf)) throw new Error('unsupported pixel format');
        this.conv = new PixelConverter(pf);
        this.dirty = [{ x: 0, y: 0, w: this.width, h: this.height }];
        return 20;
      }
      case 2: { // SetEncodings
        if (b.length < 4) return 0;
        const n = b.readUInt16BE(2);
        if (b.length < 4 + 4 * n) return 0;
        this.encodings.clear();
        for (let i = 0; i < n; i++) this.encodings.add(b.readInt32BE(4 + 4 * i));
        if (this.encodings.has(ENC.ZRLE) && !this.zlib) this.zlib = new ZlibStream(1);
        this.cursorDirty = true;
        return 4 + 4 * n;
      }
      case 3: { // FramebufferUpdateRequest
        if (b.length < 10) return 0;
        const incremental = b[1] !== 0;
        const rect = { x: b.readUInt16BE(2), y: b.readUInt16BE(4), w: b.readUInt16BE(6), h: b.readUInt16BE(8) };
        if (!incremental) this.dirty = addRect(this.dirty, rect);
        this.pending = { incremental, rect };
        this.pump();
        return 10;
      }
      case 4: { // KeyEvent
        if (b.length < 8) return 0;
        this.onKey(b[1] !== 0, b.readUInt32BE(4));
        return 8;
      }
      case 5: { // PointerEvent
        if (b.length < 6) return 0;
        this.onPointer(b[1], b.readUInt16BE(2), b.readUInt16BE(4));
        return 6;
      }
      case 6: { // ClientCutText
        if (b.length < 8) return 0;
        const len = b.readInt32BE(4);
        const abs = Math.abs(len);
        if (abs > MAX_CUT_TEXT) throw new Error('cut text too large');
        if (b.length < 8 + abs) return 0;
        if (len >= 0 && !this.opts.viewOnly) {
          const text = b.subarray(8, 8 + len).toString('latin1');
          void this.desktop.ctl().clipboard.write({ text }).catch(() => undefined);
        }
        return 8 + abs;
      }
      case 251: { // SetDesktopSize (ignored; not advertised)
        if (b.length < 8) return 0;
        const n = b[6];
        if (b.length < 8 + 16 * n) return 0;
        return 8 + 16 * n;
      }
      default:
        throw new Error(`unknown client message ${b[0]}`);
    }
  }

  // ------------------------------------------------------------ input

  private queueInput(fn: () => Promise<unknown>) {
    this.inputChain = this.inputChain.then(fn).catch((e) => this.log.debug({ err: (e as Error).message }, 'rfb input failed'));
  }

  private onKey(down: boolean, keysym: number) {
    if (this.opts.viewOnly) return;
    const ctl = this.desktop.ctl();
    if (keysym === 0xffe1 || keysym === 0xffe2) {
      if (down) this.shiftsHeld.add(keysym); else this.shiftsHeld.delete(keysym);
    }
    const shiftHeld = this.shiftsHeld.size > 0;
    this.queueInput(() => ctl.input.run(() => ctl.input.keyFromClient(keysym, down, shiftHeld)));
    if (this.participantId) this.desktop.presence.touch(this.participantId);
  }

  private onPointer(mask: number, x: number, y: number) {
    const now = Date.now();
    if (this.participantId && now - this.lastCursorPublish > 50) {
      this.lastCursorPublish = now;
      this.desktop.presence.cursor(this.participantId, x / Math.max(1, this.width - 1), y / Math.max(1, this.height - 1), true);
    }
    if (this.opts.viewOnly) return;
    const ctl = this.desktop.ctl();
    const prev = this.buttons;
    this.buttons = mask;
    this.queueInput(() => ctl.input.run(async () => {
      await ctl.input.moveTo(Math.min(x, this.width - 1), Math.min(y, this.height - 1));
      for (let i = 0; i < 8; i++) {
        const bit = 1 << i;
        if ((prev & bit) !== (mask & bit)) await ctl.input.button(i + 1, (mask & bit) !== 0);
      }
    }));
  }

  // ------------------------------------------------------------ output

  sendCutText(text: string) {
    if (this.state !== 'normal') return;
    const data = Buffer.from(text.replace(/[^\x00-\xff]/g, '?'), 'latin1').subarray(0, MAX_CUT_TEXT);
    const out = Buffer.alloc(8 + data.length);
    out[0] = 3;
    out.writeUInt32BE(data.length, 4);
    data.copy(out, 8);
    this.t.send(out);
  }

  private pump() {
    if (this.sending || !this.pending || this.state !== 'normal') return;
    const hasWork = this.dirty.length > 0 || this.sizeDirty || (this.cursorDirty && this.encodings.has(ENC.Cursor));
    if (!hasWork) return;
    // Back-pressure: let the socket drain before producing more.
    if (this.t.buffered() > 4 * 1024 * 1024) { setTimeout(() => this.pump(), 20); return; }
    this.sending = true;
    const req = this.pending;
    this.pending = null;
    this.sendUpdate()
      .then((sent) => { if (!sent && !this.pending) this.pending = req; })
      .catch((e) => { this.log.debug({ err: (e as Error).message }, 'rfb update failed'); this.close('update failed'); })
      .finally(() => { this.sending = false; this.pump(); });
  }

  private async sendUpdate(): Promise<boolean> {
    const parts: Buffer[] = [];
    let n = 0;
    if (this.sizeDirty) {
      this.sizeDirty = false;
      if (this.encodings.has(ENC.DesktopSize)) {
        parts.push(rectHeader(0, 0, this.width, this.height, ENC.DesktopSize));
        n++;
      } else {
        this.close('desktop resized and client does not support DesktopSize');
        return true;
      }
    }
    if (this.cursorDirty && this.encodings.has(ENC.Cursor)) {
      this.cursorDirty = false;
      const c = await this.cursorRect().catch(() => null);
      if (c) { parts.push(c); n++; }
    }
    const rects = this.dirty;
    this.dirty = [];
    const useZrle = this.encodings.has(ENC.ZRLE) && this.zlib;
    for (const r0 of rects) {
      const x = Math.max(0, r0.x), y = Math.max(0, r0.y);
      const w = Math.min(this.width, r0.x + r0.w) - x, h = Math.min(this.height, r0.y + r0.h) - y;
      if (w <= 0 || h <= 0) continue;
      const f = await captureRect(this.s, { x, y, w, h });
      if (useZrle) {
        const tiles = zrleTiles(pixelsOf(f.data), f.width, 0, 0, f.width, f.height, this.conv);
        const z = await this.zlib!.compress(tiles);
        const len = Buffer.allocUnsafe(4);
        len.writeUInt32BE(z.length, 0);
        parts.push(rectHeader(f.x, f.y, f.width, f.height, ENC.ZRLE), len, z);
      } else {
        parts.push(rectHeader(f.x, f.y, f.width, f.height, ENC.Raw), this.conv.raw(f.data));
      }
      n++;
    }
    if (n === 0) {
      // Nothing to send; keep the request outstanding.
      return false;
    }
    const head = Buffer.alloc(4);
    head[0] = 0;
    head.writeUInt16BE(n, 2);
    if (this.state === 'normal') this.t.send(Buffer.concat([head, ...parts]));
    return true;
  }

  private async cursorRect(): Promise<Buffer | null> {
    const c = await getCursorImage(this.s);
    if (!c || !c.width || !c.height) return null;
    const pixels = Buffer.allocUnsafe(c.width * c.height * this.conv.bpp);
    const maskStride = Math.ceil(c.width / 8);
    const mask = Buffer.alloc(maskStride * c.height);
    let o = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const px = c.argb.readUInt32LE((y * c.width + x) * 4);
        const a = px >>> 24;
        let r = (px >>> 16) & 255, g = (px >>> 8) & 255, b = px & 255;
        if (a > 0 && a < 255) { r = Math.min(255, (r * 255) / a | 0); g = Math.min(255, (g * 255) / a | 0); b = Math.min(255, (b * 255) / a | 0); }
        o = this.conv.writePixel(pixels, o, this.conv.value((r << 16) | (g << 8) | b));
        if (a > 127) mask[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return Buffer.concat([rectHeader(c.xhot, c.yhot, c.width, c.height, ENC.Cursor), pixels, mask]);
  }
}
