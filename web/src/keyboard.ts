// Local layouts can make Caps Lock a modifier without changing its keysym (XKB
// caps:ctrl_modifier, GNOME "Caps Lock is also a Ctrl", xmodmap "add control = Caps_Lock").
// The browser then still reports key "CapsLock", which noVNC would send as Caps_Lock; only
// the modifier flags of the events show what the key really does locally. So hold the
// press back until an event tells us, then send that modifier or a Caps_Lock tap instead.
// (Remaps that change the keysym, like ctrl:nocaps, already arrive as key "Control".)
import { useEffect, type RefObject } from 'react';

type Flag = 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey';
export type Flags = Pick<KeyboardEvent, Flag>;
export type KeyLike = Flags & Pick<KeyboardEvent, 'type' | 'key' | 'code' | 'repeat'>;
type Send = (keysym: number, code: string, down?: boolean) => void;
type Mod = readonly [flag: Flag, keysym: number, code: string];

const MODS: readonly Mod[] = [
  ['ctrlKey', 0xffe3, 'ControlLeft'],
  ['altKey', 0xffe9, 'AltLeft'],
  ['shiftKey', 0xffe1, 'ShiftLeft'],
  ['metaKey', 0xffeb, 'MetaLeft'],
];
// The flags each modifier key sets; some browsers report AltGr as Ctrl+Alt.
const KEY_FLAGS: Record<string, Flag[]> = {
  Control: ['ctrlKey'], Alt: ['altKey'], Shift: ['shiftKey'], Meta: ['metaKey'], AltGraph: ['ctrlKey', 'altKey'],
};
const XK_Caps_Lock = 0xffe5;
// Elements outside the screen that briefly take focus on its behalf (the clipboard's paste sink).
const PROXY = '[data-screen-keys]';

/** `handle` returns true when it consumed the event, which must then be hidden from noVNC. */
export function createCapsLockRemap(send: Send) {
  // Physical modifier keys noVNC has forwarded, by code (so left and right are separate).
  const held = new Map<string, Flag[]>();
  // Caps Lock's role while held. `sent`: we pressed its keysym remotely and must release it; the
  // server tracks keys by keysym, so a physical key with the same code shares that press.
  let caps: { mod: Mod; sent: boolean } | 'pending' | null = null;

  // A modifier flag that neither the event's own key nor any held modifier key accounts for.
  const unexplained = (e: Flags, own: Flag[]) =>
    MODS.find(([flag]) => e[flag] && !own.includes(flag) && ![...held.values()].some((f) => f.includes(flag)));
  const press = (mod: Mod) => {
    caps = { mod, sent: !held.has(mod[2]) };
    if (caps.sent) send(mod[1], mod[2], true);
  };
  const tap = (mod: Mod | undefined) => {
    if (!mod) return send(XK_Caps_Lock, 'CapsLock');
    if (!held.has(mod[2])) send(mod[1], mod[2]);
  };

  const resolve = (e: Flags, own: Flag[]) => {
    if (caps !== 'pending') return;
    const mod = unexplained(e, own);
    if (mod) return press(mod);
    // A held modifier accounts for the flags, but Caps Lock might set them too: wait for its release.
    if (MODS.some(([flag]) => e[flag])) return;
    caps = null;
    tap(undefined);
  };

  const onCaps = (e: KeyLike) => {
    if (e.repeat) return;
    if (e.type === 'keydown') {
      const mod = unexplained(e, []);
      if (mod) press(mod); else caps = 'pending';
      return;
    }
    if (caps === 'pending') tap(unexplained(e, []));
    // A physical key with the same keysym pressed meanwhile now owns the remote press.
    else if (caps?.sent && !held.has(caps.mod[2])) send(caps.mod[1], caps.mod[2], false);
    caps = null;
  };

  return {
    handle(e: KeyLike): boolean {
      if (e.key === 'CapsLock') { onCaps(e); return true; }
      const flags = KEY_FLAGS[e.key];
      if (e.type === 'keydown') resolve(e, flags ?? []);
      if (!flags) return false;
      if (e.type === 'keydown') { held.set(e.code, flags); return false; }
      held.delete(e.code);
      if (caps === 'pending') {
        // The released key no longer explains its flag: if it is still set, Caps Lock sets it.
        const mod = unexplained(e, []);
        if (!mod) return false;
        // Same keysym: keep the remote press for Caps Lock instead of letting noVNC release it.
        if (mod[2] !== e.code) { press(mod); return false; }
        caps = { mod, sent: true };
        return true;
      }
      if (caps?.mod[2] !== e.code) return false;
      // Caps Lock still holds this keysym: keep it pressed remotely until Caps Lock is released.
      caps.sent = true;
      return true;
    },
    /** Pointer and wheel events carry modifier flags too: settle Caps Lock before noVNC sends them. */
    pointer(e: Flags) {
      resolve(e, []);
    },
    /** Whether the desktop has `code`'s key down for someone else: a physical key or Caps Lock. */
    holds(code: string) {
      return held.has(code) || (caps !== 'pending' && caps?.mod[2] === code);
    },
    reset() {
      if (caps !== 'pending' && caps?.sent) send(caps.mod[1], caps.mod[2], false);
      caps = null;
      held.clear();
    },
  };
}

let active: ReturnType<typeof createCapsLockRemap> | null = null;
/** Whether a key the viewer's user holds keeps `code` down on the desktop (synthetic shortcuts must not release it). */
export const remoteHolds = (code: string) => active?.holds(code) ?? false;

export function useCapsLockRemap(target: RefObject<HTMLElement | null>, getRfb: () => { viewOnly: boolean; sendKey: Send } | null) {
  useEffect(() => {
    const el = target.current;
    // macOS reports Caps Lock as a toggle (down when on, up when off), which noVNC handles.
    if (!el || /^(Mac|iP)/.test(navigator.platform)) return;
    const remap = createCapsLockRemap((keysym, code, down) => getRfb()?.sendKey(keysym, code, down));
    active = remap;
    const onKey = (e: KeyboardEvent) => {
      if (getRfb()?.viewOnly || !remap.handle(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onPointer = (e: MouseEvent) => {
      if (!getRfb()?.viewOnly) remap.pointer(e);
    };
    const reset = () => remap.reset();
    const isProxy = (t: EventTarget | null) => t instanceof Element && t.matches(PROXY);
    const onProxyKey = (e: KeyboardEvent) => {
      if (isProxy(e.target)) onKey(e);
    };
    // Focus moving elsewhere in the page sends the key-up there, not to the desktop.
    const onFocusOut = (e: FocusEvent) => {
      if (!el.contains(e.relatedTarget as Node | null) && !isProxy(e.relatedTarget)) reset();
    };
    const listeners = [['keydown', onKey], ['keyup', onKey], ['pointerdown', onPointer], ['wheel', onPointer], ['focusout', onFocusOut]] as const;
    for (const [type, fn] of listeners) el.addEventListener(type, fn as EventListener, true);
    document.addEventListener('keydown', onProxyKey, true);
    document.addEventListener('keyup', onProxyKey, true);
    window.addEventListener('blur', reset);
    return () => {
      active = null;
      for (const [type, fn] of listeners) el.removeEventListener(type, fn as EventListener, true);
      document.removeEventListener('keydown', onProxyKey, true);
      document.removeEventListener('keyup', onProxyKey, true);
      window.removeEventListener('blur', reset);
    };
  }, []); // getRfb only reads a ref
}
