// Local ⇄ remote clipboard sharing through the browser Clipboard API.
//
// - Copy (Ctrl/Cmd+C, Ctrl+Shift+C) in the viewer: the keys go to the desktop, we
//   wait for the server's clipboard.changed event, then write the text locally.
//   The write starts inside the key event (ClipboardItem with a promise) so it
//   also works in Safari/Firefox, which require a user gesture.
// - Paste (Ctrl/Cmd+V, Ctrl+Shift+V): read the local clipboard, set the desktop's
//   clipboard, then send the paste keystroke.
// - Copies made without a shortcut (menus, select-to-copy) are written locally on
//   the next click/key in the viewer.
// Text goes through /api/v1/clipboard (full Unicode), not RFB cut-text (Latin-1).
import type RFB from '/novnc/core/rfb.js';
import { useEffect, useRef, type RefObject } from 'react';
import { api } from './api';
import { useServerEvent } from './events';

type Key = readonly [keysym: number, code: string];
type ClipboardChanged = { generation: number; owner_is_self: boolean };
type RemoteClipboard = { generation: number; text?: string };
type Modifiers = Pick<KeyboardEvent, 'shiftKey' | 'metaKey'>;

const XK = { Control_L: 0xffe3, Shift_L: 0xffe1, Super_L: 0xffeb, Super_R: 0xffec, c: 0x63, v: 0x76 };
const TERMINALS = /^(xterm|uxterm|xfce4-terminal|gnome-terminal|konsole|kitty|alacritty|terminator|tilix|urxvt|st)/i;
const COPY_WAIT_MS = 1500;
const NOTHING_COPIED = 'nothing copied';

export const clipboardSupported = window.isSecureContext && !!navigator.clipboard;

function createClipboardSync(target: HTMLElement, getRfb: () => RFB | null, toast: (text: string) => void) {
  let focusedApp = '';
  let lastRemoteGen = -1; // newest remote generation we've seen
  let syncedGen = -1; // generation last written to the local clipboard
  let pushedGen = -1; // generation created by our own paste push (don't echo back)
  let waiters: Array<(d: ClipboardChanged) => void> = [];

  const remoteChanged = (d: ClipboardChanged) => {
    lastRemoteGen = Math.max(lastRemoteGen, d.generation);
    if (d.owner_is_self) pushedGen = Math.max(pushedGen, d.generation);
    waiters.splice(0).forEach((w) => w(d));
  };
  const focusChanged = async (id: number | null | undefined) => {
    if (!id) { focusedApp = ''; return; }
    try {
      const w = await api<{ app?: string; app_instance?: string }>(`/api/v1/windows/${id}`);
      focusedApp = `${w.app_instance || ''} ${w.app || ''}`.trim();
    } catch { /* ignore */ }
  };
  api<{ windows: Array<{ id: number; focused: boolean }> }>('/api/v1/windows')
    .then((r) => focusChanged(r.windows.find((w) => w.focused)?.id)).catch(() => {});

  const isTerminal = () => TERMINALS.test(focusedApp);

  function send(keys: Key[]) {
    const rfb = getRfb();
    if (!rfb) return;
    for (const [sym, code] of keys) rfb.sendKey(sym, code, true);
    // A modifier the user still holds (physically or via a remapped Caps Lock) stays down.
    const stillHeld = (sym: number) => (sym === XK.Control_L && held.ctrlKey) || (sym === XK.Shift_L && held.shiftKey);
    for (const [sym, code] of [...keys].reverse()) if (!stillHeld(sym)) rfb.sendKey(sym, code, false);
  }
  function releaseSuper() {
    const rfb = getRfb();
    rfb?.sendKey(XK.Super_L, 'MetaLeft', false);
    rfb?.sendKey(XK.Super_R, 'MetaRight', false);
  }
  /** The keystroke the focused app understands for copy/paste. */
  function combo(letter: 'c' | 'v', e: Modifiers): Key[] {
    const shift = e.shiftKey || (e.metaKey && isTerminal());
    return [
      [XK.Control_L, 'ControlLeft'],
      ...(shift ? [[XK.Shift_L, 'ShiftLeft'] as const] : []),
      letter === 'c' ? [XK.c, 'KeyC'] : [XK.v, 'KeyV'],
    ];
  }

  /** Resolves with the remote text after the next remote clipboard change, or null on timeout. */
  function nextRemoteText(sinceGen: number) {
    return new Promise<string | null>((resolve) => {
      const done = async (d: ClipboardChanged) => {
        clearTimeout(t);
        if (d.owner_is_self || d.generation <= sinceGen) return resolve(null);
        try {
          const c = await api<RemoteClipboard>('/api/v1/clipboard');
          syncedGen = c.generation;
          resolve(c.text ?? null);
        } catch { resolve(null); }
      };
      const t = setTimeout(() => { waiters = waiters.filter((w) => w !== done); resolve(null); }, COPY_WAIT_MS);
      waiters.push(done);
    });
  }

  /** Write text (or a promise of text) locally; must be called from a user gesture. */
  function writeLocal(text: Promise<string | null>, label: string) {
    const nonEmpty = text.then((t) => t ?? Promise.reject(new Error(NOTHING_COPIED)));
    const write = window.ClipboardItem
      ? navigator.clipboard.write([new ClipboardItem({ 'text/plain': nonEmpty.then((t) => new Blob([t], { type: 'text/plain' })) })])
      : nonEmpty.then((t) => navigator.clipboard.writeText(t));
    write.then(() => toast(label), (err: Error) => { if (err?.message !== NOTHING_COPIED) console.debug('clipboard write failed', err); });
  }

  function onCopy(e: KeyboardEvent) {
    const since = lastRemoteGen;
    if (e.metaKey) { releaseSuper(); send(combo('c', e)); swallowed.add(e.code); }
    // Ctrl+C itself was passed through to the desktop unchanged.
    writeLocal(nextRemoteText(since), 'Copied to your clipboard');
  }

  // Paste: let the browser perform its native paste so we get the text from the
  // 'paste' event, which needs no permission prompt (Firefox/Safari otherwise show a
  // "Paste" confirmation for every navigator.clipboard.readText()). If no paste event
  // arrives (e.g. focus is somewhere odd), fall back to readText().
  let pendingPaste: { keys: Key[]; timer: ReturnType<typeof setTimeout> } | null = null;
  // Firefox only runs Ctrl+Shift+V ("paste without formatting") in editable elements,
  // so the canvas never gets a paste event for it. Briefly focusing this hidden
  // textarea during keydown sends the browser's paste (either form) here instead.
  const sink = document.createElement('textarea');
  sink.setAttribute('aria-hidden', 'true');
  // Keys typed while it briefly has focus still belong to the desktop (see keyboard.ts).
  sink.dataset.screenKeys = '';
  sink.tabIndex = -1;
  sink.className = 'fixed top-0 -left-[9999px] size-px opacity-0';
  document.body.appendChild(sink);
  let returnFocus: HTMLElement | null = null;
  function restoreFocus() {
    sink.value = '';
    if (returnFocus && document.activeElement === sink) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }
  function onPaste(e: KeyboardEvent) {
    swallowed.add(e.code);
    returnFocus = document.activeElement as HTMLElement | null;
    sink.focus({ preventScroll: true });
    if (e.metaKey) releaseSuper();
    const keys = combo('v', e);
    if (pendingPaste) clearTimeout(pendingPaste.timer);
    pendingPaste = {
      keys,
      timer: setTimeout(async () => {
        if (pendingPaste?.keys !== keys) return;
        pendingPaste = null;
        restoreFocus();
        await finishPaste(await readLocal(), keys);
      }, 150),
    };
  }
  const onPasteEvent = (e: ClipboardEvent) => {
    if (!pendingPaste) return;
    e.preventDefault();
    const { keys, timer } = pendingPaste;
    clearTimeout(timer);
    pendingPaste = null;
    restoreFocus();
    void finishPaste(e.clipboardData?.getData('text/plain') || null, keys);
  };
  async function readLocal() {
    try { return await navigator.clipboard.readText(); } catch { return null; } // denied/unsupported
  }
  async function finishPaste(text: string | null, keys: Key[]) {
    if (text) await api('/api/v1/clipboard', { method: 'PUT', body: JSON.stringify({ text }) }).catch(() => {});
    // With no local text, this still pastes whatever is already on the desktop clipboard.
    send(keys);
  }

  // Keep noVNC from sending the keyup of a key we handled ourselves.
  const swallowed = new Set<string>();
  // Modifier flags of the latest key event anywhere in the page (focus may be on the sink).
  let held: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey'> = { ctrlKey: false, shiftKey: false };
  const trackHeld = (e: KeyboardEvent) => { held = e; };

  const onKeydown = (e: KeyboardEvent) => {
    if (getRfb()?.viewOnly) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    if (e.code === 'KeyV') {
      // Hide the key from noVNC but don't preventDefault: the browser's paste must run.
      e.stopImmediatePropagation();
      onPaste(e);
    } else if (e.code === 'KeyC') {
      if (e.metaKey) { e.preventDefault(); e.stopImmediatePropagation(); }
      onCopy(e);
    } else {
      maybeSyncPending();
    }
  };
  const onSinkKeyup = (e: KeyboardEvent) => { swallowed.delete(e.code); restoreFocus(); };
  const onKeyup = (e: KeyboardEvent) => {
    if (swallowed.delete(e.code)) { e.preventDefault(); e.stopImmediatePropagation(); }
  };

  // Copies done without a shortcut (menus, select-to-copy) sync on the next gesture.
  function maybeSyncPending() {
    if (lastRemoteGen <= syncedGen || lastRemoteGen <= pushedGen) return;
    syncedGen = lastRemoteGen;
    writeLocal(api<RemoteClipboard>('/api/v1/clipboard').then((c) => c.text ?? null), 'Desktop clipboard copied to yours');
  }

  document.addEventListener('paste', onPasteEvent, true);
  document.addEventListener('keydown', trackHeld, true);
  document.addEventListener('keyup', trackHeld, true);
  target.addEventListener('keydown', onKeydown, true);
  target.addEventListener('keyup', onKeyup, true);
  target.addEventListener('pointerup', maybeSyncPending, true);
  sink.addEventListener('keyup', onSinkKeyup);
  const dispose = () => {
    document.removeEventListener('paste', onPasteEvent, true);
    document.removeEventListener('keydown', trackHeld, true);
    document.removeEventListener('keyup', trackHeld, true);
    target.removeEventListener('keydown', onKeydown, true);
    target.removeEventListener('keyup', onKeyup, true);
    target.removeEventListener('pointerup', maybeSyncPending, true);
    sink.remove();
  };
  return { remoteChanged, focusChanged, dispose };
}

/** Shares the clipboard between this browser and the desktop shown in `screen` (secure origins only). */
export function useClipboardSync(screen: RefObject<HTMLElement | null>, getRfb: () => RFB | null, toast: (text: string) => void) {
  const sync = useRef<ReturnType<typeof createClipboardSync>>(null);
  useServerEvent<ClipboardChanged>('clipboard.changed', (d) => sync.current?.remoteChanged(d));
  useServerEvent<{ id: number | null }>('window.focus', (d) => void sync.current?.focusChanged(d.id));
  useEffect(() => {
    if (!clipboardSupported) return;
    sync.current = createClipboardSync(screen.current!, getRfb, toast);
    return () => { sync.current?.dispose(); sync.current = null; };
  }, []); // getRfb and toast only touch refs and setters
}
