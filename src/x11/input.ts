import { call, type XSession } from './connection.js';
import { charToKeysym, isModifierKeysym, keysymCasePair, MODIFIER_KEYSYM, type Modifier, XK } from './keymap.js';
import { unsupported } from '../errors.js';

const KeyPress = 2, KeyRelease = 3, ButtonPress = 4, ButtonRelease = 5, MotionNotify = 6;

export type ButtonName = 'left' | 'middle' | 'right' | 'back' | 'forward';
export const BUTTONS: Record<ButtonName, number> = { left: 1, middle: 2, right: 3, back: 8, forward: 9 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface KeyLoc { keycode: number; level: number }

/**
 * Synthesises input through XTEST and owns the keysym → keycode table,
 * including temporary remapping of spare keycodes for characters that have
 * no key on the current layout.
 */
export class InputController {
  private minKeycode: number;
  private maxKeycode: number;
  private perKeycode = 0;
  private rows: number[][] = [];
  private lookup = new Map<number, KeyLoc>();
  private spares: number[] = [];
  private spareUse = new Map<number, number>(); // keycode -> keysym currently assigned
  private spareOriginal = new Map<number, number[]>();
  private pressedKeys = new Map<number, number>(); // keysym -> keycode
  private pressedButtons = new Set<number>();
  private loading: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private s: XSession) {
    this.minKeycode = s.display.min_keycode;
    this.maxKeycode = s.display.max_keycode;
    s.on('xevent', (ev: any) => {
      if (ev.name === 'MappingNotify' && ev.request === 1 && !this.remapping) this.loading = null;
    });
  }

  get available(): boolean {
    return !!this.s.ext.xtest;
  }

  private get xtest() {
    if (!this.s.ext.xtest) throw unsupported('input', 'the XTEST extension is not available on this display');
    return this.s.ext.xtest;
  }

  /** Serialize all input so that concurrent API calls don't interleave key sequences. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private remapping = false;

  async ensureMapping(): Promise<void> {
    if (!this.loading) this.loading = this.loadMapping();
    return this.loading;
  }

  private async loadMapping(): Promise<void> {
    const count = this.maxKeycode - this.minKeycode + 1;
    const rows = await call<number[][]>(this.s.X, 'GetKeyboardMapping', this.minKeycode, count);
    this.rows = rows;
    this.perKeycode = rows[0]?.length ?? 0;
    this.lookup.clear();
    const spares: number[] = [];
    rows.forEach((row, i) => {
      const kc = this.minKeycode + i;
      if (this.spareUse.has(kc)) {
        spares.push(kc);
      } else if (row.every((k) => k === 0)) {
        spares.push(kc);
        return;
      }
      // Only levels 0/1 (plain and shifted) are used for lookup.
      for (let level = 0; level < Math.min(2, row.length); level++) {
        const ks = row[level];
        if (ks && !this.lookup.has(ks)) this.lookup.set(ks, { keycode: kc, level });
      }
      // A row with only level 0 filled for a letter implies case pair.
      if (row[0] && !row[1]) {
        const [lo, up] = keysymCasePair(row[0]);
        if (up !== lo && !this.lookup.has(up)) this.lookup.set(up, { keycode: kc, level: 1 });
      }
    });
    // Prefer high keycodes as spares (least likely to be used by real hardware).
    this.spares = spares.filter((k) => k > 8).sort((a, b) => b - a).slice(0, 16);
  }

  private async remapSpare(keysym: number): Promise<KeyLoc> {
    for (const [kc, ks] of this.spareUse) if (ks === keysym) return { keycode: kc, level: 0 };
    if (this.spares.length === 0) throw unsupported('keyboard', 'no spare keycode available to type this character');
    // LRU: take the first spare not currently held.
    const held = new Set(this.pressedKeys.values());
    const idx = this.spares.findIndex((k) => !held.has(k));
    if (idx < 0) throw unsupported('keyboard', 'all spare keycodes are in use');
    const kc = this.spares.splice(idx, 1)[0];
    this.spares.push(kc);
    if (!this.spareOriginal.has(kc)) this.spareOriginal.set(kc, this.rows[kc - this.minKeycode] ?? new Array(this.perKeycode).fill(0));
    const syms = new Array(this.perKeycode || 2).fill(0);
    syms[0] = keysym;
    if (syms.length > 1) syms[1] = keysym;
    this.remapping = true;
    try {
      this.s.X.ChangeKeyboardMapping(kc, syms.length, syms);
      await this.s.sync();
    } finally {
      this.remapping = false;
    }
    if (this.rows[kc - this.minKeycode]) this.rows[kc - this.minKeycode] = syms;
    this.spareUse.set(kc, keysym);
    // Give clients a moment to process MappingNotify before the key event.
    await sleep(5);
    return { keycode: kc, level: 0 };
  }

  async locate(keysym: number): Promise<KeyLoc> {
    await this.ensureMapping();
    const loc = this.lookup.get(keysym);
    if (loc) return loc;
    return this.remapSpare(keysym);
  }

  private fake(type: number, detail: number, x = 0, y = 0) {
    this.xtest.FakeInput(type, detail, 0, type === MotionNotify ? this.s.root : 0, x, y);
  }

  // ---- low level ---------------------------------------------------------

  /** Press/release a keysym exactly as given (no automatic shift). Used by RFB. */
  async keyRaw(keysym: number, down: boolean): Promise<void> {
    if (down) {
      const loc = await this.locate(keysym);
      this.pressedKeys.set(keysym, loc.keycode);
      this.fake(KeyPress, loc.keycode);
    } else {
      const kc = this.pressedKeys.get(keysym) ?? (await this.locate(keysym)).keycode;
      this.pressedKeys.delete(keysym);
      this.fake(KeyRelease, kc);
    }
    await this.s.sync();
  }

  /**
   * RFB-style key event: the client sends the keysym it wants ("A", ">") and may or
   * may not hold Shift. Add a transient Shift when the keysym sits on the shifted
   * level and the client isn't holding one (x11vnc behaves the same way).
   */
  async keyFromClient(keysym: number, down: boolean, shiftHeld: boolean): Promise<void> {
    if (!down || shiftHeld || isModifierKeysym(keysym)) return this.keyRaw(keysym, down);
    const loc = await this.locate(keysym);
    if (loc.level !== 1) return this.keyRaw(keysym, down);
    const shift = await this.locate(XK.Shift_L);
    this.fake(KeyPress, shift.keycode);
    this.pressedKeys.set(keysym, loc.keycode);
    this.fake(KeyPress, loc.keycode);
    this.fake(KeyRelease, shift.keycode);
    await this.s.sync();
  }

  async modifiersDown(mods: Modifier[]): Promise<void> {
    for (const m of mods) await this.keyRaw(MODIFIER_KEYSYM[m], true);
  }

  async modifiersUp(mods: Modifier[]): Promise<void> {
    for (const m of [...mods].reverse()) await this.keyRaw(MODIFIER_KEYSYM[m], false);
  }

  /** Tap a keysym, adding Shift when the keysym lives at the shifted level. */
  async tap(keysym: number, opts: { modifiers?: Modifier[]; holdMs?: number } = {}): Promise<void> {
    const loc = await this.locate(keysym);
    const mods = [...(opts.modifiers ?? [])];
    const needShift = loc.level === 1 && !mods.includes('shift') && !isModifierKeysym(keysym);
    if (needShift) mods.push('shift');
    await this.modifiersDown(mods);
    this.fake(KeyPress, loc.keycode);
    if (opts.holdMs) { await this.s.sync(); await sleep(opts.holdMs); }
    this.fake(KeyRelease, loc.keycode);
    await this.s.sync();
    await this.modifiersUp(mods);
  }

  async typeText(text: string, delayMs = 0): Promise<void> {
    for (const ch of text) {
      if (ch === '\r') continue;
      await this.tap(charToKeysym(ch));
      if (delayMs) await sleep(delayMs);
    }
  }

  async moveTo(x: number, y: number): Promise<void> {
    this.fake(MotionNotify, 0, Math.round(x), Math.round(y));
    await this.s.sync();
  }

  async button(button: number, down: boolean): Promise<void> {
    if (down) this.pressedButtons.add(button); else this.pressedButtons.delete(button);
    this.fake(down ? ButtonPress : ButtonRelease, button);
    await this.s.sync();
  }

  async click(button: number, count = 1, intervalMs = 40): Promise<void> {
    for (let i = 0; i < count; i++) {
      await this.button(button, true);
      await this.button(button, false);
      if (i + 1 < count) await sleep(intervalMs);
    }
  }

  /** Scroll by wheel clicks: dy>0 scrolls down, dx>0 scrolls right. */
  async scroll(dx: number, dy: number): Promise<void> {
    const steps = (n: number, pos: number, neg: number) => {
      const b = n > 0 ? pos : neg;
      return Array.from({ length: Math.abs(Math.round(n)) }, () => b);
    };
    for (const b of [...steps(dy, 5, 4), ...steps(dx, 7, 6)]) await this.click(b, 1, 0);
  }

  async pointer(): Promise<{ x: number; y: number; child: number; mask: number }> {
    const p = await call<any>(this.s.X, 'QueryPointer', this.s.root);
    return { x: p.rootX, y: p.rootY, child: p.child, mask: p.keyMask };
  }

  /** Release anything still held and restore remapped keycodes. */
  async releaseAll(): Promise<void> {
    if (!this.s.ext.xtest || this.s.closed) return;
    for (const [, kc] of this.pressedKeys) this.fake(KeyRelease, kc);
    this.pressedKeys.clear();
    for (const b of this.pressedButtons) this.fake(ButtonRelease, b);
    this.pressedButtons.clear();
    for (const [kc, syms] of this.spareOriginal) {
      const row = syms.length ? syms : new Array(this.perKeycode).fill(0);
      this.s.X.ChangeKeyboardMapping(kc, row.length, row);
    }
    this.spareOriginal.clear();
    this.spareUse.clear();
    try { await this.s.sync(); } catch { /* closing */ }
  }
}

export { XK };
