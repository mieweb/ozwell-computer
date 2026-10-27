import { EventEmitter } from 'node:events';
import x11 from 'x11';
import type { XSession } from './connection.js';
import { call } from './connection.js';
import { getProperty, u32list } from './windows.js';

export interface ClipboardContent {
  text?: string;
  image_png_base64?: string;
}

const READ_TIMEOUT_MS = 2000;

/**
 * CLIPBOARD / PRIMARY owner and requestor.
 * - write(): takes ownership and answers SelectionRequest for text and image/png.
 * - read(): ConvertSelection into a property on a private window (with INCR support).
 * - generation increments on every XFIXES selection-owner change.
 */
export class Clipboard extends EventEmitter {
  private win: number;
  generation = 0;
  private owned: { text?: string; png?: Buffer } | null = null;
  private pending = new Map<number, (ev: any) => void>();
  private propSeq = 0;

  constructor(private s: XSession) {
    super();
    const X = s.X;
    this.win = s.allocId();
    X.CreateWindow(this.win, s.root, -10, -10, 1, 1, 0, 0, 0, 0, { eventMask: x11.eventMask.PropertyChange });
    s.on('xevent', (ev: any) => void this.onEvent(ev));
    void this.init();
  }

  get available() { return true; }

  private async init() {
    const fixes = this.s.ext.fixes;
    if (!fixes) return;
    for (const sel of ['CLIPBOARD', 'PRIMARY']) {
      const atom = await this.s.atom(sel);
      fixes.SelectSelectionInput(this.win, atom, 1 | 2 | 4);
    }
  }

  private async onEvent(ev: any) {
    const fixes = this.s.ext.fixes;
    if (fixes && ev.type === fixes.firstEvent) {
      const clip = await this.s.atom('CLIPBOARD');
      if (ev.selection === clip) {
        this.generation++;
        if (ev.owner !== this.win) this.owned = null;
        this.emit('changed', { generation: this.generation, owner_is_self: ev.owner === this.win });
      }
      return;
    }
    switch (ev.name) {
      case 'SelectionRequest':
        await this.answer(ev).catch(() => undefined);
        break;
      case 'SelectionClear': {
        const clip = await this.s.atom('CLIPBOARD');
        if (ev.selection === clip) this.owned = null;
        break;
      }
      case 'SelectionNotify':
        if (ev.requestor === this.win) this.pending.get(ev.property || -ev.target)?.(ev);
        break;
      case 'PropertyNotify':
        if (ev.wid === this.win) this.pending.get(-1000000 - ev.atom)?.(ev);
        break;
    }
  }

  private async answer(ev: any) {
    const X = this.s.X;
    const [targetsA, utf8, text, str, plain, plainUtf8, png, multiple] = await Promise.all(
      ['TARGETS', 'UTF8_STRING', 'TEXT', 'STRING', 'text/plain', 'text/plain;charset=utf-8', 'image/png', 'MULTIPLE'].map((n) => this.s.atom(n)),
    );
    const prop = ev.property || ev.target;
    let ok = false;
    const content = this.owned;
    if (content) {
      if (ev.target === targetsA) {
        const t = [targetsA];
        if (content.text !== undefined) t.push(utf8, text, str, plain, plainUtf8);
        if (content.png) t.push(png);
        X.ChangeProperty(0, ev.requestor, prop, this.s.X.atoms.ATOM, 32, t);
        ok = true;
      } else if (content.text !== undefined && [utf8, text, plainUtf8].includes(ev.target)) {
        X.ChangeProperty(0, ev.requestor, prop, utf8, 8, Buffer.from(content.text, 'utf8'));
        ok = true;
      } else if (content.text !== undefined && [str, plain].includes(ev.target)) {
        X.ChangeProperty(0, ev.requestor, prop, str, 8, Buffer.from(content.text, 'latin1'));
        ok = true;
      } else if (content.png && ev.target === png) {
        X.ChangeProperty(0, ev.requestor, prop, png, 8, content.png);
        ok = true;
      }
    }
    void multiple;
    X.SendEvent(ev.requestor, 0, 0, {
      name: 'SelectionNotify',
      time: ev.time,
      requestor: ev.requestor,
      selection: ev.selection,
      target: ev.target,
      property: ok ? prop : 0,
    });
  }

  async write(content: ClipboardContent): Promise<number> {
    this.owned = {
      text: content.text,
      png: content.image_png_base64 ? Buffer.from(content.image_png_base64, 'base64') : undefined,
    };
    const owned = this.owned;
    for (const sel of ['CLIPBOARD', 'PRIMARY']) {
      if (sel === 'PRIMARY' && owned.text === undefined) continue;
      this.s.X.SetSelectionOwner(this.win, await this.s.atom(sel), 0);
    }
    await this.s.sync();
    this.owned = owned; // XFIXES event for our own ownership must not clear it
    if (!this.s.ext.fixes) {
      this.generation++;
      this.emit('changed', { generation: this.generation, owner_is_self: true });
    }
    return this.generation;
  }

  private convert(selection: number, target: number): Promise<{ type: number; data: Buffer } | null> {
    const X = this.s.X;
    return new Promise(async (resolve) => {
      const prop = await this.s.atom(`OZWELL_SEL_${this.propSeq++ % 8}`);
      const timer = setTimeout(() => { cleanup(); resolve(null); }, READ_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(prop);
        this.pending.delete(-target);
        this.pending.delete(-1000000 - prop);
      };
      const onNotify = async (ev: any) => {
        this.pending.delete(prop);
        this.pending.delete(-target);
        if (!ev.property) { cleanup(); resolve(null); return; }
        const p = await getProperty(this.s, this.win, prop);
        const incr = await this.s.atom('INCR');
        if (p && p.type === incr) {
          // INCR: delete the property to start the transfer, then read chunks.
          const chunks: Buffer[] = [];
          let type = 0;
          this.pending.set(-1000000 - prop, async (pev: any) => {
            if (pev.state !== 0) return;
            const r = await call<any>(X, 'GetProperty', 1, this.win, prop, 0, 0, 1 << 24);
            if (!r.data?.length) { cleanup(); resolve({ type, data: Buffer.concat(chunks) }); return; }
            type = r.type;
            chunks.push(Buffer.from(r.data));
          });
          X.DeleteProperty(this.win, prop);
          return;
        }
        X.DeleteProperty(this.win, prop);
        cleanup();
        resolve(p ? { type: p.type, data: Buffer.from(p.data) } : null);
      };
      this.pending.set(prop, onNotify);
      this.pending.set(-target, onNotify);
      X.ConvertSelection(this.win, selection, target, prop, 0);
    });
  }

  async read(): Promise<ClipboardContent & { generation: number }> {
    if (this.owned) {
      return {
        generation: this.generation,
        ...(this.owned.text !== undefined ? { text: this.owned.text } : {}),
        ...(this.owned.png ? { image_png_base64: this.owned.png.toString('base64') } : {}),
      };
    }
    const sel = await this.s.atom('CLIPBOARD');
    const owner = await call<number>(this.s.X, 'GetSelectionOwner', sel);
    if (!owner) return { generation: this.generation };
    const targetsAtom = await this.s.atom('TARGETS');
    const t = await this.convert(sel, targetsAtom);
    const targets = new Set(t ? u32list(t.data) : []);
    const out: ClipboardContent & { generation: number } = { generation: this.generation };
    const utf8 = await this.s.atom('UTF8_STRING');
    const png = await this.s.atom('image/png');
    if (targets.size === 0 || targets.has(utf8)) {
      const r = await this.convert(sel, utf8);
      if (r) out.text = r.data.toString('utf8');
    } else if (targets.has(this.s.X.atoms.STRING)) {
      const r = await this.convert(sel, this.s.X.atoms.STRING);
      if (r) out.text = r.data.toString('latin1');
    }
    if (targets.has(png)) {
      const r = await this.convert(sel, png);
      if (r) out.image_png_base64 = r.data.toString('base64');
    }
    return out;
  }

  dispose() {
    try { this.s.X.DestroyWindow(this.win); } catch { /* ignore */ }
    this.removeAllListeners();
  }
}
