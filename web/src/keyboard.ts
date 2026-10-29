// Local layouts can make Caps Lock a modifier without changing its keysym (XKB
// caps:ctrl_modifier, GNOME "Caps Lock is also a Ctrl", xmodmap "add control = Caps_Lock").
// The browser then still reports key "CapsLock", which noVNC would send as Caps_Lock; only
// the modifier flags of the events show what the key really does locally. So hold the
// press back until an event tells us, then send that modifier or a Caps_Lock tap instead.
// (Remaps that change the keysym, like ctrl:nocaps, already arrive as key "Control".)
import { useEffect, type RefObject } from 'react';

export type KeyLike = Pick<KeyboardEvent, 'type' | 'key' | 'repeat' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;
type Send = (keysym: number, code: string, down?: boolean) => void;
type Mod = readonly [flag: 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', key: string, keysym: number, code: string];

const MODS: readonly Mod[] = [
  ['ctrlKey', 'Control', 0xffe3, 'ControlLeft'],
  ['altKey', 'Alt', 0xffe9, 'AltLeft'],
  ['shiftKey', 'Shift', 0xffe1, 'ShiftLeft'],
  ['metaKey', 'Meta', 0xffeb, 'MetaLeft'],
];
const XK_Caps_Lock = 0xffe5;

/** `handle` returns true when it consumed the event, which must then be hidden from noVNC. */
export function createCapsLockRemap(send: Send) {
  const held = new Set<string>();
  let caps: Mod | 'pending' | null = null;

  // A modifier flag that no held modifier key (nor this event's own key) accounts for.
  const unexplained = (e: KeyLike) => MODS.find(([flag, key]) => e[flag] && key !== e.key && !held.has(key));
  const tap = (mod: Mod | undefined) => (mod ? send(mod[2], mod[3]) : send(XK_Caps_Lock, 'CapsLock'));

  const resolve = (e: KeyLike) => {
    if (caps !== 'pending') return;
    const mod = unexplained(e);
    caps = mod ?? null;
    if (mod) send(mod[2], mod[3], true); else tap(undefined);
  };

  const onCaps = (e: KeyLike) => {
    if (e.repeat) return;
    if (e.type === 'keydown') {
      caps = unexplained(e) ?? 'pending';
      if (caps !== 'pending') send(caps[2], caps[3], true);
      return;
    }
    if (caps === 'pending') tap(unexplained(e));
    else if (caps) send(caps[2], caps[3], false);
    caps = null;
  };

  return {
    handle(e: KeyLike): boolean {
      if (e.key === 'CapsLock') { onCaps(e); return true; }
      if (e.type === 'keydown') resolve(e);
      if (!MODS.some(([, key]) => key === e.key)) return false;
      if (e.type === 'keydown') held.add(e.key); else held.delete(e.key);
      return false;
    },
    reset() {
      if (caps && caps !== 'pending') send(caps[2], caps[3], false);
      caps = null;
      held.clear();
    },
  };
}

export function useCapsLockRemap(target: RefObject<HTMLElement | null>, getRfb: () => { viewOnly: boolean; sendKey: Send } | null) {
  useEffect(() => {
    const el = target.current;
    // macOS reports Caps Lock as a toggle (down when on, up when off), which noVNC handles.
    if (!el || /^(Mac|iP)/.test(navigator.platform)) return;
    const remap = createCapsLockRemap((keysym, code, down) => getRfb()?.sendKey(keysym, code, down));
    const onKey = (e: KeyboardEvent) => {
      if (getRfb()?.viewOnly || !remap.handle(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onBlur = () => remap.reset();
    el.addEventListener('keydown', onKey, true);
    el.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      el.removeEventListener('keydown', onKey, true);
      el.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []); // getRfb only reads a ref
}
