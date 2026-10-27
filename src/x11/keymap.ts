import x11 from 'x11';

/** Common keysyms. */
export const XK = {
  BackSpace: 0xff08, Tab: 0xff09, Return: 0xff0d, Pause: 0xff13, Scroll_Lock: 0xff14, Sys_Req: 0xff15,
  Escape: 0xff1b, Delete: 0xffff, Home: 0xff50, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54,
  Page_Up: 0xff55, Page_Down: 0xff56, End: 0xff57, Print: 0xff61, Insert: 0xff63, Menu: 0xff67,
  Num_Lock: 0xff7f, KP_Enter: 0xff8d, KP_Multiply: 0xffaa, KP_Add: 0xffab, KP_Separator: 0xffac,
  KP_Subtract: 0xffad, KP_Decimal: 0xffae, KP_Divide: 0xffaf, KP_0: 0xffb0, KP_Equal: 0xffbd,
  F1: 0xffbe, Shift_L: 0xffe1, Shift_R: 0xffe2, Control_L: 0xffe3, Control_R: 0xffe4,
  Caps_Lock: 0xffe5, Meta_L: 0xffe7, Meta_R: 0xffe8, Alt_L: 0xffe9, Alt_R: 0xffea,
  Super_L: 0xffeb, Super_R: 0xffec, ISO_Level3_Shift: 0xfe03, space: 0x20,
} as const;

/** W3C KeyboardEvent.code → keysym (unshifted). */
const CODE: Record<string, number> = {
  Backspace: XK.BackSpace, Tab: XK.Tab, Enter: XK.Return, Escape: XK.Escape, Space: XK.space,
  Minus: 0x2d, Equal: 0x3d, BracketLeft: 0x5b, BracketRight: 0x5d, Backslash: 0x5c, Semicolon: 0x3b,
  Quote: 0x27, Backquote: 0x60, Comma: 0x2c, Period: 0x2e, Slash: 0x2f, IntlBackslash: 0x3c,
  CapsLock: XK.Caps_Lock, PrintScreen: XK.Print, ScrollLock: XK.Scroll_Lock, Pause: XK.Pause,
  Insert: XK.Insert, Home: XK.Home, PageUp: XK.Page_Up, Delete: XK.Delete, End: XK.End, PageDown: XK.Page_Down,
  ArrowLeft: XK.Left, ArrowUp: XK.Up, ArrowRight: XK.Right, ArrowDown: XK.Down,
  NumLock: XK.Num_Lock, NumpadDivide: XK.KP_Divide, NumpadMultiply: XK.KP_Multiply, NumpadSubtract: XK.KP_Subtract,
  NumpadAdd: XK.KP_Add, NumpadEnter: XK.KP_Enter, NumpadDecimal: XK.KP_Decimal, NumpadEqual: XK.KP_Equal,
  NumpadComma: XK.KP_Separator,
  ShiftLeft: XK.Shift_L, ShiftRight: XK.Shift_R, ControlLeft: XK.Control_L, ControlRight: XK.Control_R,
  AltLeft: XK.Alt_L, AltRight: XK.Alt_R, MetaLeft: XK.Super_L, MetaRight: XK.Super_R, OSLeft: XK.Super_L,
  OSRight: XK.Super_R, ContextMenu: XK.Menu,
};
for (let i = 0; i < 26; i++) CODE[`Key${String.fromCharCode(65 + i)}`] = 0x61 + i;
for (let i = 0; i < 10; i++) {
  CODE[`Digit${i}`] = 0x30 + i;
  CODE[`Numpad${i}`] = XK.KP_0 + i;
}
for (let i = 1; i <= 35; i++) CODE[`F${i}`] = XK.F1 + i - 1;

/** W3C KeyboardEvent.key values and friendly aliases (case-insensitive). */
const NAMES: Record<string, number> = {
  enter: XK.Return, return: XK.Return, escape: XK.Escape, esc: XK.Escape, backspace: XK.BackSpace,
  tab: XK.Tab, space: XK.space, spacebar: XK.space, delete: XK.Delete, del: XK.Delete, insert: XK.Insert, ins: XK.Insert,
  home: XK.Home, end: XK.End, pageup: XK.Page_Up, pgup: XK.Page_Up, pagedown: XK.Page_Down, pgdn: XK.Page_Down,
  arrowleft: XK.Left, left: XK.Left, arrowright: XK.Right, right: XK.Right, arrowup: XK.Up, up: XK.Up,
  arrowdown: XK.Down, down: XK.Down, printscreen: XK.Print, print: XK.Print, prtsc: XK.Print,
  scrolllock: XK.Scroll_Lock, pause: XK.Pause, break: XK.Pause, capslock: XK.Caps_Lock, numlock: XK.Num_Lock,
  contextmenu: XK.Menu, menu: XK.Menu, apps: XK.Menu,
  shift: XK.Shift_L, control: XK.Control_L, ctrl: XK.Control_L, alt: XK.Alt_L, option: XK.Alt_L,
  altgr: XK.ISO_Level3_Shift, meta: XK.Super_L, super: XK.Super_L, win: XK.Super_L, windows: XK.Super_L,
  cmd: XK.Super_L, command: XK.Super_L, os: XK.Super_L,
  plus: 0x2b, minus: 0x2d,
};

export type Modifier = 'shift' | 'ctrl' | 'alt' | 'super' | 'altgr';
export const MODIFIER_KEYSYM: Record<Modifier, number> = {
  shift: XK.Shift_L, ctrl: XK.Control_L, alt: XK.Alt_L, super: XK.Super_L, altgr: XK.ISO_Level3_Shift,
};

export function normalizeModifier(m: string): Modifier {
  const k = m.toLowerCase();
  if (k === 'shift') return 'shift';
  if (k === 'ctrl' || k === 'control') return 'ctrl';
  if (k === 'alt' || k === 'option') return 'alt';
  if (['super', 'meta', 'win', 'windows', 'cmd', 'command', 'os'].includes(k)) return 'super';
  if (k === 'altgr') return 'altgr';
  throw new Error(`unknown modifier: ${m}`);
}

/** Unicode code point → keysym. */
export function charToKeysym(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (ch === '\n' || ch === '\r') return XK.Return;
  if (ch === '\t') return XK.Tab;
  if (ch === '\b') return XK.BackSpace;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x01000000 | cp;
}

/** keysym → Unicode string (best effort), used for RFB/clipboard. */
export function keysymToChar(ks: number): string | null {
  if ((ks >= 0x20 && ks <= 0x7e) || (ks >= 0xa0 && ks <= 0xff)) return String.fromCodePoint(ks);
  if ((ks & 0xff000000) === 0x01000000) return String.fromCodePoint(ks & 0x00ffffff);
  return null;
}

/** XF86keysym.h subset (not in keysymdef.h). */
const XF86: Record<string, number> = {
  XF86AudioLowerVolume: 0x1008ff11, XF86AudioMute: 0x1008ff12, XF86AudioRaiseVolume: 0x1008ff13, XF86AudioPlay: 0x1008ff14,
  XF86AudioStop: 0x1008ff15, XF86AudioPrev: 0x1008ff16, XF86AudioNext: 0x1008ff17, XF86HomePage: 0x1008ff18,
  XF86Mail: 0x1008ff19, XF86Search: 0x1008ff1b, XF86Calculator: 0x1008ff1d, XF86Back: 0x1008ff26,
  XF86Forward: 0x1008ff27, XF86Refresh: 0x1008ff29, XF86Reload: 0x1008ff73, XF86Copy: 0x1008ff57,
  XF86Cut: 0x1008ff58, XF86Paste: 0x1008ff6d,
};

let xkNames: Map<string, number> | null = null;
function xkByName(name: string): number | undefined {
  if (!xkNames) {
    xkNames = new Map();
    const table = x11.keySyms as Record<string, { code: number }>;
    for (const [k, v] of Object.entries(table)) xkNames.set(k.replace(/^XK_/, ''), v.code);
  }
  return xkNames.get(name);
}

/**
 * Resolve a key identifier to a keysym. Accepts W3C `code` ("KeyA", "Enter"),
 * W3C `key` names and friendly aliases ("ctrl", "PgUp"), single characters, X keysym
 * names ("XF86AudioMute"), and hex ("0xff0d").
 */
export function resolveKeysym(key: string): number {
  if (CODE[key] !== undefined) return CODE[key];
  const lower = key.toLowerCase();
  if (NAMES[lower] !== undefined) return NAMES[lower];
  if (/^f([1-9]|[12][0-9]|3[0-5])$/i.test(key)) return XK.F1 + parseInt(key.slice(1), 10) - 1;
  if ([...key].length === 1) return charToKeysym(key);
  if (/^0x[0-9a-f]+$/i.test(key)) return parseInt(key, 16);
  if (XF86[key] !== undefined) return XF86[key];
  const xk = xkByName(key);
  if (xk !== undefined) return xk;
  throw new Error(`unknown key: ${key}`);
}

export function isModifierKeysym(ks: number): boolean {
  return (ks >= XK.Shift_L && ks <= XK.Super_R) || ks === XK.ISO_Level3_Shift;
}

/** Convert a keysym to lower/upper pair for case lookups. */
export function keysymCasePair(ks: number): [number, number] {
  if (ks >= 0x41 && ks <= 0x5a) return [ks + 0x20, ks];
  if (ks >= 0x61 && ks <= 0x7a) return [ks, ks - 0x20];
  if (ks >= 0xc0 && ks <= 0xde && ks !== 0xd7) return [ks + 0x20, ks];
  if (ks >= 0xe0 && ks <= 0xfe && ks !== 0xf7) return [ks, ks - 0x20];
  return [ks, ks];
}
