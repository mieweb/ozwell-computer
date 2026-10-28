import RFB from '/novnc/core/rfb.js';
import { initClipboard } from '/static/clipboard.js';
import { initPerf, initUpdate } from '/static/status.js';

const $ = (id) => document.getElementById(id);
const status = $('status');
const overlay = $('overlay');
const screen = $('screen');
const serverViewOnly = document.body.dataset.viewOnly === '1';

const api = (path, opts = {}) =>
  fetch(path, { credentials: 'same-origin', ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } })
    .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || r.statusText); return r.json(); });

function setStatus(text, cls) { status.textContent = text; status.className = cls || ''; }

let me = null;
const myName = localStorage.getItem('ozwell-computer-name') || `viewer-${Math.random().toString(36).slice(2, 6)}`;
localStorage.setItem('ozwell-computer-name', myName);

let rfb = null;
let retry = 0;
async function connect() {
  // A fresh participant per connection; the server drops it when the socket closes.
  try {
    me = await api('/api/v1/presence/join', { method: 'POST', body: JSON.stringify({ name: myName, kind: 'human' }) });
  } catch (e) { me = null; console.warn('presence join failed', e); }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams();
  if (me) qs.set('participant', me.participant_id);
  const url = `${proto}//${location.host}/websockify?${qs}`;
  setStatus('connecting…');
  rfb = new RFB(screen, url, { shared: true });
  rfb.scaleViewport = $('sel-scale').value === 'fit';
  rfb.resizeSession = false;
  rfb.viewOnly = serverViewOnly || $('chk-viewonly').checked;
  rfb.focusOnClick = true;
  rfb.addEventListener('connect', () => { retry = 0; setStatus('connected', 'ok'); rfb.focus(); });
  rfb.addEventListener('disconnect', (e) => {
    setStatus(e.detail.clean ? 'disconnected' : 'connection lost', 'err');
    setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
  });
  rfb.addEventListener('clipboard', (e) => { if (!clip.supported) $('clip-text').value = e.detail.text; });
}
const es = new EventSource('/api/v1/events');

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1500);
}
const clip = initClipboard({ getRfb: () => rfb, events: es, toast });
initPerf($('perf'));
initUpdate($('btn-update'), es);

connect();

if (serverViewOnly) { $('chk-viewonly').checked = true; $('chk-viewonly').disabled = true; }
$('chk-viewonly').onchange = (e) => { if (rfb) rfb.viewOnly = e.target.checked; };
$('sel-scale').onchange = (e) => { if (rfb) rfb.scaleViewport = e.target.value === 'fit'; };
$('btn-cad').onclick = () => rfb?.sendCtrlAltDel();
$('btn-super').onclick = () => { rfb?.sendKey(0xffeb, 'MetaLeft'); };
$('btn-alttab').onclick = () => {
  if (!rfb) return;
  rfb.sendKey(0xffe9, 'AltLeft', true); rfb.sendKey(0xff09, 'Tab'); rfb.sendKey(0xffe9, 'AltLeft', false);
};
$('btn-full').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
// With the Clipboard API, copy/paste shortcuts just work; the manual panel is only a
// fallback for insecure origins (plain http on a non-localhost address).
if (clip.supported) {
  $('btn-clip').hidden = true;
} else {
  $('btn-clip').title = 'Clipboard sharing needs HTTPS (or localhost); edit the desktop clipboard here instead';
  $('btn-clip').onclick = () => { $('clip-panel').hidden = !$('clip-panel').hidden; if (!$('clip-panel').hidden) refreshClip(); };
}
async function refreshClip() {
  try { const c = await api('/api/v1/clipboard'); if (c.text !== undefined) $('clip-text').value = c.text; } catch { /* ignore */ }
}
$('clip-refresh').onclick = refreshClip;
$('clip-send').onclick = async () => {
  const text = $('clip-text').value;
  try { await api('/api/v1/clipboard', { method: 'PUT', body: JSON.stringify({ text }) }); } catch (e) { alert(e.message); }
};

// ---- presence overlay
const cursors = new Map();
const roster = new Map();
function renderRoster() {
  const el = $('roster');
  el.replaceChildren(...[...roster.values()].map((p) => {
    const s = document.createElement('span');
    s.className = 'chip'; s.style.background = p.color; s.textContent = `${p.kind === 'agent' ? 'agent: ' : ''}${p.name}`;
    s.title = p.kind;
    return s;
  }));
}
function canvasBox() {
  const c = screen.querySelector('canvas');
  if (!c) return null;
  const a = c.getBoundingClientRect(), b = overlay.getBoundingClientRect();
  return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height };
}
function drawCursor(p) {
  if (me && p.participant_id === me.participant_id) return;
  let el = cursors.get(p.participant_id);
  if (!p.visible) { el?.remove(); cursors.delete(p.participant_id); return; }
  if (!el) {
    el = document.createElement('div');
    el.className = 'pcursor';
    el.innerHTML = `<svg width="16" height="20" viewBox="0 0 16 20"><path d="M1 1 L1 17 L5 13 L8 19 L11 18 L8 12 L14 12 Z" stroke="#000" stroke-width="1"/></svg><span></span>`;
    overlay.appendChild(el);
    cursors.set(p.participant_id, el);
  }
  el.querySelector('path').setAttribute('fill', p.color);
  const label = el.querySelector('span');
  label.textContent = p.name; label.style.background = p.color;
  el.dataset.nx = p.x; el.dataset.ny = p.y;
  place(el);
}
function place(el) {
  const box = canvasBox();
  if (!box) return;
  el.style.left = `${box.x + Number(el.dataset.nx) * box.w}px`;
  el.style.top = `${box.y + Number(el.dataset.ny) * box.h}px`;
}
new ResizeObserver(() => cursors.forEach(place)).observe(overlay);

es.addEventListener('hello', (e) => {
  roster.clear();
  for (const p of JSON.parse(e.data).roster) { roster.set(p.participant_id, p); if (p.cursor) drawCursor({ ...p, ...p.cursor }); }
  renderRoster();
});
es.addEventListener('presence.joined', (e) => { const p = JSON.parse(e.data); roster.set(p.participant_id, p); renderRoster(); });
es.addEventListener('presence.left', (e) => {
  const { participant_id } = JSON.parse(e.data);
  roster.delete(participant_id); renderRoster();
  cursors.get(participant_id)?.remove(); cursors.delete(participant_id);
});
es.addEventListener('presence.cursor', (e) => drawCursor(JSON.parse(e.data)));

window.addEventListener('pagehide', () => {
  if (me) navigator.sendBeacon('/api/v1/presence/leave', new Blob([JSON.stringify({ participant_id: me.participant_id })], { type: 'application/json' }));
});
