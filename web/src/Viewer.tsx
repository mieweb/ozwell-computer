import RFB from '/novnc/core/rfb.js';
import { useEffect, useReducer, useRef, useState } from 'react';
import { Badge } from '@mieweb/ui/components/Badge';
import { Button } from '@mieweb/ui/components/Button';
import { Checkbox } from '@mieweb/ui/components/Checkbox';
import { Select } from '@mieweb/ui/components/Select';
import { Textarea } from '@mieweb/ui/components/Textarea';
import { api } from './api';
import { clipboardSupported, useClipboardSync } from './clipboard';
import { openServerEvents, useServerEvent } from './events';
import { JobsPanel, useJobs } from './jobs';
import { Perf, UpdateControls } from './status';
import { ThemeToggle } from './theme';

type Participant = { participant_id: string; name: string; kind: string; color: string; cursor?: { x: number; y: number; visible: boolean } };
type Cursor = Pick<Participant, 'participant_id' | 'name' | 'color'> & { x: number; y: number; visible: boolean };

const myName = localStorage.getItem('ozwell-computer-name') || `viewer-${Math.random().toString(36).slice(2, 6)}`;
localStorage.setItem('ozwell-computer-name', myName);

const withEntry = <V,>(m: Map<string, V>, key: string, value?: V) => {
  const next = new Map(m);
  if (value === undefined) next.delete(key); else next.set(key, value);
  return next;
};

function canvasBox(screen: HTMLElement | null, overlay: HTMLElement | null) {
  const c = screen?.querySelector('canvas');
  if (!c || !overlay) return null;
  const a = c.getBoundingClientRect(), b = overlay.getBoundingClientRect();
  return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height };
}

export function Viewer({ serverViewOnly, exec }: { serverViewOnly: boolean; exec: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const meRef = useRef<Participant | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [status, setStatus] = useState({ text: 'connecting…', cls: '' });
  const [viewOnly, setViewOnly] = useState(serverViewOnly);
  const [scale, setScale] = useState('fit');
  const prefs = useRef({ viewOnly, fit: scale === 'fit' });
  const [clipOpen, setClipOpen] = useState(false);
  const [clipText, setClipText] = useState('');
  const [jobsOpen, setJobsOpen] = useState(false);
  const { jobs, refresh: refreshJobs } = useJobs(exec);
  const running = jobs.filter((j) => j.state === 'running').length;
  const [toast, setToast] = useState({ text: '', shown: false });
  const [roster, setRoster] = useState(new Map<string, Participant>());
  const [cursors, setCursors] = useState(new Map<string, Cursor>());
  const [fullscreen, setFullscreen] = useState(false);
  const [, relayout] = useReducer((n: number) => n + 1, 0);

  const showToast = (text: string) => {
    setToast({ text, shown: true });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast((t) => ({ ...t, shown: false })), 1500);
  };

  useEffect(() => {
    let retry = 0;
    const connect = async () => {
      // A fresh participant per connection; the server drops it when the socket closes.
      meRef.current = await api<Participant>('/api/v1/presence/join', { method: 'POST', body: JSON.stringify({ name: myName, kind: 'human' }) })
        .catch(() => null);
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = new URLSearchParams(meRef.current ? { participant: meRef.current.participant_id } : {});
      setStatus({ text: 'connecting…', cls: '' });
      const rfb = new RFB(screenRef.current!, `${proto}//${location.host}/websockify?${qs}`, { shared: true });
      rfb.scaleViewport = prefs.current.fit;
      rfb.resizeSession = false;
      rfb.viewOnly = prefs.current.viewOnly;
      rfb.focusOnClick = true;
      rfb.addEventListener('connect', () => { retry = 0; setStatus({ text: 'connected', cls: 'text-success' }); rfb.focus(); });
      rfb.addEventListener('disconnect', (e) => {
        setStatus({ text: e.detail.clean ? 'disconnected' : 'connection lost', cls: 'text-destructive' });
        setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
      });
      rfb.addEventListener('clipboard', (e) => { if (!clipboardSupported) setClipText(e.detail.text); });
      rfbRef.current = rfb;
    };
    void connect();
  }, []);
  useClipboardSync(screenRef, () => rfbRef.current, showToast);

  useEffect(() => {
    prefs.current = { viewOnly, fit: scale === 'fit' };
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.viewOnly = viewOnly;
    rfb.scaleViewport = scale === 'fit';
  }, [viewOnly, scale]);

  // ---- presence: roster chips and other participants' cursors
  const drawCursor = (p: Cursor) => {
    if (p.participant_id === meRef.current?.participant_id) return;
    setCursors((m) => withEntry(m, p.participant_id, p.visible ? p : undefined));
  };
  useServerEvent<{ roster: Participant[] }>('hello', ({ roster: list }) => {
    setRoster(new Map(list.map((p) => [p.participant_id, p])));
    for (const p of list) if (p.cursor) drawCursor({ ...p, ...p.cursor });
  });
  useServerEvent<Participant>('presence.joined', (p) => setRoster((m) => withEntry(m, p.participant_id, p)));
  useServerEvent<{ participant_id: string }>('presence.left', ({ participant_id }) => {
    setRoster((m) => withEntry(m, participant_id));
    setCursors((m) => withEntry(m, participant_id));
  });
  useServerEvent<Cursor>('presence.cursor', drawCursor);
  useEffect(() => {
    new ResizeObserver(relayout).observe(overlayRef.current!);
    window.addEventListener('pagehide', () => {
      if (!meRef.current) return;
      navigator.sendBeacon('/api/v1/presence/leave', new Blob([JSON.stringify({ participant_id: meRef.current.participant_id })], { type: 'application/json' }));
    });
  }, []);
  useEffect(() => {
    // Keyboard Lock API: not in lib.dom yet.
    const { keyboard } = navigator as Navigator & { keyboard?: { lock(): Promise<void>; unlock(): void } };
    document.addEventListener('fullscreenchange', () => {
      const full = document.fullscreenElement === wrapRef.current;
      setFullscreen(full);
      // Send Esc, Alt+Tab etc. to the desktop while fullscreen (Chromium only; hold Esc to exit).
      // If the lock is refused (e.g. permission denied), fullscreen still works without it.
      if (full) keyboard?.lock().catch(() => undefined); else keyboard?.unlock();
      rfbRef.current?.focus();
    });
  }, []);
  // Last: every useServerEvent above and in the children is subscribed by now.
  useEffect(openServerEvents, []);

  const refreshClip = () =>
    api<{ text?: string }>('/api/v1/clipboard').then((c) => { if (c.text !== undefined) setClipText(c.text); }, () => undefined);
  const toggleClip = () => {
    if (!clipOpen) void refreshClip();
    setClipOpen(!clipOpen);
  };
  const sendClip = () =>
    api('/api/v1/clipboard', { method: 'PUT', body: JSON.stringify({ text: clipText }) }).catch((e: Error) => alert(e.message));
  const altTab = () => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.sendKey(0xffe9, 'AltLeft', true); rfb.sendKey(0xff09, 'Tab'); rfb.sendKey(0xffe9, 'AltLeft', false);
  };
  const box = canvasBox(screenRef.current, overlayRef.current);

  return (
    <>
      <div id="toolbar" className="flex flex-none items-center gap-1.5 border-b border-border bg-card px-2 py-1">
        <span id="status" className={status.cls}>{status.text}</span>
        <Perf />
        <UpdateControls toast={showToast} />
        <span className="flex-1" />
        <Button id="btn-cad" size="sm" variant="outline" title="Send Ctrl+Alt+Del" onClick={() => rfbRef.current?.sendCtrlAltDel()}>Ctrl+Alt+Del</Button>
        <Button id="btn-super" size="sm" variant="outline" title="Send Super" onClick={() => rfbRef.current?.sendKey(0xffeb, 'MetaLeft')}>Super</Button>
        <Button id="btn-alttab" size="sm" variant="outline" title="Send Alt+Tab" onClick={altTab}>Alt+Tab</Button>
        {/* With the Clipboard API, copy/paste shortcuts just work; the panel is a fallback for insecure origins. */}
        {!clipboardSupported && (
          <Button id="btn-clip" size="sm" variant="outline" onClick={toggleClip}
            title="Clipboard sharing needs HTTPS (or localhost); edit the desktop clipboard here instead">Clipboard</Button>
        )}
        {exec && (
          <Button id="btn-jobs" size="sm" variant={running ? 'secondary' : 'outline'} title="Background commands started through the API or MCP"
            onClick={() => setJobsOpen(!jobsOpen)}>{running ? `Jobs (${running})` : 'Jobs'}</Button>
        )}
        <Checkbox id="chk-viewonly" size="sm" label="view only" title="Ignore my input"
          checked={viewOnly} disabled={serverViewOnly} onChange={(e) => setViewOnly(e.target.checked)} />
        <div className="w-24">
          <Select id="sel-scale" size="sm" aria-label="Scaling" value={scale} onValueChange={setScale}
            options={[{ value: 'fit', label: 'fit' }, { value: 'remote', label: '1:1' }]} />
        </div>
        <Button id="btn-full" size="sm" variant={fullscreen ? 'primary' : 'outline'} aria-pressed={fullscreen}
          title="Show only the remote desktop, fullscreen (hold Esc to exit)"
          onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : wrapRef.current!.requestFullscreen()).catch(() => undefined)}>Fullscreen</Button>
        <ThemeToggle viewOnly={serverViewOnly} toast={showToast} />
        <span id="roster" className="flex gap-1">
          {[...roster.values()].map((p) => (
            <Badge key={p.participant_id} data-participant={p.participant_id} className="text-neutral-950" size="sm" title={p.kind} style={{ background: p.color }}>
              {`${p.kind === 'agent' ? 'agent: ' : ''}${p.name}`}
            </Badge>
          ))}
        </span>
      </div>
      {clipOpen && (
        <div id="clip-panel" className="flex flex-none items-start gap-1.5 bg-muted px-2 py-1.5">
          <div className="flex-1">
            <Textarea id="clip-text" rows={4} label="Remote clipboard" hideLabel placeholder="Remote clipboard (edit and press Send)"
              value={clipText} onChange={(e) => setClipText(e.target.value)} />
          </div>
          <Button id="clip-send" size="sm" onClick={sendClip}>Send</Button>
          <Button id="clip-refresh" size="sm" variant="outline" onClick={refreshClip}>Refresh</Button>
        </div>
      )}
      {exec && jobsOpen && <JobsPanel jobs={jobs} refresh={refreshJobs} canCancel={!viewOnly} toast={showToast} />}
      <div id="screen-wrap" className="relative flex-1 overflow-hidden [&:fullscreen]:size-full [&:fullscreen]:bg-background" ref={wrapRef}>
        <div id="screen" className="absolute inset-0" ref={screenRef} />
        <div id="overlay" className="pointer-events-none absolute inset-0" ref={overlayRef}>
          {[...cursors.values()].map((p) => (
            <div key={p.participant_id} data-participant={p.participant_id} className="absolute size-0 transition-[left,top]! duration-[60ms]! ease-linear!"
              style={box ? { left: box.x + p.x * box.w, top: box.y + p.y * box.h } : undefined}>
              <svg className="absolute -top-px -left-px drop-shadow-[0_0_1px_black]" width="16" height="20" viewBox="0 0 16 20">
                <path d="M1 1 L1 17 L5 13 L8 19 L11 18 L8 12 L14 12 Z" fill={p.color} stroke="#000" strokeWidth="1" />
              </svg>
              <span className="absolute top-4 left-3.5 rounded-sm px-1 text-[11px] whitespace-nowrap text-neutral-950" style={{ background: p.color }}>{p.name}</span>
            </div>
          ))}
        </div>
        <div id="toast" className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded-md bg-neutral-900/90 px-3.5 py-1.5 text-neutral-50"
          hidden={!toast.shown}>{toast.text}</div>
      </div>
    </>
  );
}
