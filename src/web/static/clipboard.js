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

const XK = { Control_L: 0xffe3, Shift_L: 0xffe1, Super_L: 0xffeb, Super_R: 0xffec, c: 0x63, v: 0x76 };
const TERMINALS = /^(xterm|uxterm|xfce4-terminal|gnome-terminal|konsole|kitty|alacritty|terminator|tilix|urxvt|st)/i;
const COPY_WAIT_MS = 1500;

export function initClipboard({ getRfb, events, toast }) {
  const supported = window.isSecureContext && !!navigator.clipboard;
  const api = (path, opts = {}) =>
    fetch(path, { credentials: 'same-origin', ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))));

  let focusedApp = '';
  let lastRemoteGen = -1;   // newest remote generation we've seen
  let syncedGen = -1;       // generation last written to the local clipboard
  let pushedGen = -1;       // generation created by our own paste push (don't echo back)
  let waiters = [];

  events.addEventListener('clipboard.changed', (e) => {
    const d = JSON.parse(e.data);
    lastRemoteGen = Math.max(lastRemoteGen, d.generation);
    if (d.owner_is_self) pushedGen = Math.max(pushedGen, d.generation);
    waiters.splice(0).forEach((w) => w(d));
  });
  const refreshFocus = async (id) => {
    if (!id) { focusedApp = ''; return; }
    try { const w = await api(`/api/v1/windows/${id}`); focusedApp = `${w.app_instance || ''} ${w.app || ''}`.trim(); } catch { /* ignore */ }
  };
  events.addEventListener('window.focus', (e) => void refreshFocus(JSON.parse(e.data).id));
  api('/api/v1/windows').then((r) => refreshFocus(r.windows.find((w) => w.focused)?.id)).catch(() => {});

  const isTerminal = () => TERMINALS.test(focusedApp);

  function send(keys) {
    const rfb = getRfb();
    if (!rfb) return;
    for (const [sym, code] of keys) rfb.sendKey(sym, code, true);
    for (const [sym, code] of [...keys].reverse()) rfb.sendKey(sym, code, false);
  }
  function releaseSuper() {
    const rfb = getRfb();
    rfb?.sendKey(XK.Super_L, 'MetaLeft', false);
    rfb?.sendKey(XK.Super_R, 'MetaRight', false);
  }
  /** The keystroke the focused app understands for copy/paste. */
  function combo(letter, e) {
    const shift = e.shiftKey || (e.metaKey && isTerminal());
    const keys = [[XK.Control_L, 'ControlLeft']];
    if (shift) keys.push([XK.Shift_L, 'ShiftLeft']);
    keys.push(letter === 'c' ? [XK.c, 'KeyC'] : [XK.v, 'KeyV']);
    return keys;
  }

  /** Resolves with the remote text after the next remote clipboard change, or null on timeout. */
  function nextRemoteText(sinceGen) {
    return new Promise((resolve) => {
      const done = async (d) => {
        clearTimeout(t);
        if (d.owner_is_self || d.generation <= sinceGen) return resolve(null);
        try { const c = await api('/api/v1/clipboard'); syncedGen = c.generation; resolve(c.text ?? null); } catch { resolve(null); }
      };
      const t = setTimeout(() => { waiters = waiters.filter((w) => w !== done); resolve(null); }, COPY_WAIT_MS);
      waiters.push(done);
    });
  }

  /** Write text (or a promise of text) locally; must be called from a user gesture. */
  function writeLocal(textOrPromise, label) {
    const p = Promise.resolve(textOrPromise);
    let write;
    if (window.ClipboardItem) {
      const blob = p.then((t) => (t === null ? Promise.reject(new Error('nothing copied')) : new Blob([t], { type: 'text/plain' })));
      write = navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    } else {
      write = p.then((t) => (t === null ? Promise.reject(new Error('nothing copied')) : navigator.clipboard.writeText(t)));
    }
    write.then(() => toast(label), (err) => { if (err?.message !== 'nothing copied') console.debug('clipboard write failed', err); });
  }

  function onCopy(e) {
    const since = lastRemoteGen;
    if (e.metaKey) { releaseSuper(); send(combo('c', e)); swallowKeyup(e.code); }
    // Ctrl+C itself was passed through to the desktop unchanged.
    writeLocal(nextRemoteText(since), 'Copied to your clipboard');
  }

  // Paste: let the browser perform its native paste so we get the text from the
  // 'paste' event, which needs no permission prompt (Firefox/Safari otherwise show a
  // "Paste" confirmation for every navigator.clipboard.readText()). If no paste event
  // arrives (e.g. focus is somewhere odd), fall back to readText().
  let pendingPaste = null;
  // Firefox only runs Ctrl+Shift+V ("paste without formatting") in editable elements,
  // so the canvas never gets a paste event for it. Briefly focusing this hidden
  // textarea during keydown sends the browser's paste (either form) here instead.
  const sink = document.createElement('textarea');
  sink.setAttribute('aria-hidden', 'true');
  sink.tabIndex = -1;
  sink.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
  document.body.appendChild(sink);
  let returnFocus = null;
  function restoreFocus() {
    sink.value = '';
    if (returnFocus && document.activeElement === sink) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }
  function onPaste(e) {
    swallowKeyup(e.code);
    returnFocus = document.activeElement;
    sink.focus({ preventScroll: true });
    if (e.metaKey) releaseSuper();
    const keys = combo('v', e);
    if (pendingPaste) clearTimeout(pendingPaste.timer);
    pendingPaste = {
      keys,
      timer: setTimeout(async () => {
        if (!pendingPaste || pendingPaste.keys !== keys) return;
        pendingPaste = null;
        restoreFocus();
        let text = null;
        try { text = await navigator.clipboard.readText(); } catch { /* denied/unsupported */ }
        await finishPaste(text, keys);
      }, 150),
    };
  }
  document.addEventListener('paste', (e) => {
    if (!pendingPaste) return;
    e.preventDefault();
    const { keys, timer } = pendingPaste;
    clearTimeout(timer);
    pendingPaste = null;
    restoreFocus();
    void finishPaste(e.clipboardData?.getData('text/plain') || null, keys);
  }, true);
  async function finishPaste(text, keys) {
    if (text) {
      try { await api('/api/v1/clipboard', { method: 'PUT', body: JSON.stringify({ text }) }); } catch { /* ignore */ }
    }
    // With no local text, this still pastes whatever is already on the desktop clipboard.
    send(keys);
  }

  // Keep noVNC from sending the keyup of a key we handled ourselves.
  const swallowed = new Set();
  function swallowKeyup(code) { swallowed.add(code); }

  const target = document.getElementById('screen');
  target.addEventListener('keydown', (e) => {
    if (!supported || getRfb()?.viewOnly) return;
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
  }, true);
  sink.addEventListener('keyup', (e) => { swallowed.delete(e.code); restoreFocus(); });
  target.addEventListener('keyup', (e) => {
    if (swallowed.delete(e.code)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  // Copies done without a shortcut (menus, select-to-copy) sync on the next gesture.
  function maybeSyncPending() {
    if (!supported || lastRemoteGen <= syncedGen || lastRemoteGen <= pushedGen) return;
    const gen = lastRemoteGen;
    syncedGen = gen;
    writeLocal(api('/api/v1/clipboard').then((c) => c.text ?? null), 'Desktop clipboard copied to yours');
  }
  target.addEventListener('pointerup', maybeSyncPending, true);

  return { supported, syncNow: maybeSyncPending };
}
