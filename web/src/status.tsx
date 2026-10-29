// Toolbar: container resource use (from the Prometheus endpoint), the installed version
// and update notices.
import { Fragment, useEffect, useState } from 'react';
import { Button, type ButtonProps } from '@mieweb/ui/components/Button';
import { api } from './api';
import { useServerEvent } from './events';
import { checkResult, versionTitle, type UpdateStatus } from './version';
import { PLACEHOLDER, perfParts, readMetrics, type Sample } from './perf';

// Literal class names so Tailwind generates them; fixed widths keep the toolbar from shifting.
const WIDTH: Record<number, string> = { 3: 'w-[3ch]', 4: 'w-[4ch]', 5: 'w-[5ch]' };

export function Perf({ intervalMs = 5000 }: { intervalMs?: number }) {
  const [parts, setParts] = useState(() => perfParts(null, null, undefined));
  useEffect(() => {
    let prev: Sample | null = null;
    // Static per container, so it survives failed fetches and keeps its slot.
    let limit: number | null | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async (next: number) => {
      try {
        const res = await fetch('/api/v1/metrics', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(res.statusText);
        const now = { ...readMetrics(await res.text()), t: performance.now() };
        limit = now.limit || null;
        setParts(perfParts(prev, now, limit));
        prev = now;
      } catch {
        setParts(perfParts(null, null, limit));
        prev = null;
      }
      if (stopped) return;
      timer = setTimeout(() => tick(intervalMs), next);
    };
    // A quick second sample so the values replace the placeholders within ~1s.
    void tick(1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [intervalMs]);
  return (
    <span id="perf" className="font-mono text-[11px] whitespace-nowrap text-muted-foreground" title="Container resource use (from /api/v1/metrics)">
      {parts.map((p, i) => (
        <Fragment key={p.label}>
          {i > 0 && ' · '}
          <span className={p.hot ? 'text-warning' : undefined}>
            {`${p.label} `}
            <span className={`inline-block text-right tabular-nums ${WIDTH[p.width]}`}>{p.value ?? PLACEHOLDER}</span>
            {p.unit}
            {'limit' in p && p.limit !== null && (
              <>
                {' / '}
                <span className={`inline-block text-right tabular-nums ${WIDTH[p.width]}`}>{p.limit ?? PLACEHOLDER}</span>
                {' MiB'}
              </>
            )}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

const updateApi = (path: string, method = 'GET'): Promise<UpdateStatus> =>
  fetch(path, { method, credentials: 'same-origin' })
    .then(async (r) => { const body = await r.json(); if (!r.ok) throw new Error(body.error?.message || r.statusText); return body; });
const tail = (log: string, n: number) => log.split('\n').filter(Boolean).slice(-n).join('\n');
const isBusy = (s: UpdateStatus | null) => s?.upgrade?.state === 'requested' || s?.upgrade?.state === 'running';

function updateView(s: UpdateStatus | null): { label: string; title: string; variant: ButtonProps['variant']; busy?: boolean } | null {
  if (!s?.supported) return null;
  if (isBusy(s)) return { label: 'Updating…', title: tail(s.upgrade!.log, 3), variant: 'secondary', busy: true };
  if (s.upgrade?.state === 'failed') return { label: 'Update failed', title: `Click to retry.\n\n${tail(s.upgrade.log, 8)}`, variant: 'danger' };
  if (!s.available) return null;
  return {
    label: `Update to ${s.latest}`,
    title: `ozwell-computer ${s.latest} is available (installed: ${s.current}). The server restarts; open apps keep running.`,
    variant: 'primary',
  };
}

/** The installed version, always shown (click to check for a release now), and the upgrade button. */
export function UpdateControls({ toast }: { toast: (text: string) => void }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const busy = isBusy(status);

  useServerEvent<UpdateStatus>('update.status', setStatus);
  // After an upgrade the server restarts: refresh on reconnect.
  useServerEvent('hello', () => {
    updateApi('/api/v1/update').then(setStatus, () => setStatus(null));
    api<{ version: string }>('/api/v1/capabilities').then((c) => setVersion(c.version), () => undefined);
  });

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => updateApi('/api/v1/update').then(setStatus, () => undefined), 3000);
    return () => clearInterval(timer);
  }, [busy]);

  const check = async () => {
    setChecking(true);
    try {
      const s = await updateApi('/api/v1/update/check', 'POST');
      setStatus(s);
      toast(checkResult(s));
    } catch (e) {
      toast(`Update check failed: ${(e as Error).message}`);
    } finally {
      setChecking(false);
    }
  };
  const apply = async () => {
    if (!confirm(`Upgrade ozwell-computer ${status!.current} → ${status!.latest ?? 'latest'}?\nThe viewer reconnects when the server restarts.`)) return;
    try { setStatus(await updateApi('/api/v1/update/apply', 'POST')); } catch (e) { alert(`Could not start the upgrade: ${(e as Error).message}`); }
  };

  const current = status?.current ?? version;
  const title = versionTitle(status);
  const view = updateView(status);
  return (
    <>
      {current && (
        // Disabled buttons get no hover events, so the wrapper carries the tooltip too.
        <span title={title}>
          <Button id="btn-version" size="sm" variant="ghost" className={`font-mono text-[11px] text-muted-foreground ${checking ? 'cursor-progress' : ''}`}
            disabled={checking || !status?.supported} title={title} onClick={check}>
            v{current}
          </Button>
        </span>
      )}
      {view && (
        <Button id="btn-update" size="sm" variant={view.variant} disabled={view.busy} title={view.title} onClick={apply}>
          {view.label}
        </Button>
      )}
    </>
  );
}
