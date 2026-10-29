// Toolbar: container resource use (from the Prometheus endpoint) and update notices.
import { Fragment, useEffect, useState } from 'react';
import { Button, type ButtonProps } from '@mieweb/ui/components/Button';

type Metrics = { cpu?: number; mem?: number; limit?: number; vnc?: number };
type Sample = Metrics & { t: number };
type Part = { text: string; hot?: boolean };

const MiB = (b: number) => `${Math.round(b / 2 ** 20)} MiB`;

/** The few series the toolbar shows, from Prometheus text format. */
export function readMetrics(text: string): Metrics {
  const out: Metrics = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const m = /^(\w+)(\{[^}]*\})? (\S+)$/.exec(line);
    if (!m) continue;
    const [, name, labels = '', value] = m;
    const v = Number(value);
    if (name === 'ozwell_cgroup_cpu_seconds_total') out.cpu = v;
    else if (name === 'ozwell_cgroup_memory_bytes' && labels.includes('scope="container"')) out.mem = v;
    else if (name === 'ozwell_cgroup_memory_limit_bytes') out.limit = v;
    else if (name === 'ozwell_vnc_sent_bytes_total') out.vnc = v;
  }
  return out;
}

function perfParts(prev: Sample | null, now: Sample): Part[] {
  const secs = prev ? (now.t - prev.t) / 1000 : 0;
  const cpu = prev?.cpu !== undefined && now.cpu !== undefined ? ((now.cpu - prev.cpu) / secs) * 100 : undefined;
  const kbs = prev?.vnc !== undefined && now.vnc !== undefined ? (now.vnc - prev.vnc) / secs / 1024 : undefined;
  return [
    cpu !== undefined && { text: `CPU ${Math.max(0, cpu).toFixed(0)}%`, hot: cpu > 80 },
    now.mem !== undefined && {
      text: `Mem ${MiB(now.mem)}${now.limit ? ` / ${MiB(now.limit)}` : ''}`,
      hot: !!now.limit && now.mem / now.limit > 0.85,
    },
    kbs !== undefined && { text: `VNC ${kbs >= 1024 ? `${(kbs / 1024).toFixed(1)} MB/s` : `${kbs.toFixed(0)} KB/s`}` },
  ].filter((p): p is Part => !!p);
}

export function Perf({ intervalMs = 5000 }: { intervalMs?: number }) {
  const [parts, setParts] = useState<Part[]>([]);
  useEffect(() => {
    let prev: Sample | null = null;
    const tick = async () => {
      try {
        const res = await fetch('/api/v1/metrics', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(res.statusText);
        const now = { ...readMetrics(await res.text()), t: performance.now() };
        setParts(perfParts(prev, now));
        prev = now;
      } catch {
        setParts([]);
        prev = null;
      }
    };
    void tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return (
    <span id="perf" title="Container resource use (from /api/v1/metrics)">
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && ' · '}
          <span className={p.hot ? 'hot' : undefined}>{p.text}</span>
        </Fragment>
      ))}
    </span>
  );
}

type UpdateStatus = {
  supported: boolean;
  available?: boolean;
  current: string;
  latest?: string;
  upgrade?: { state: string; log: string };
};

const updateApi = (path: string, method = 'GET'): Promise<UpdateStatus> =>
  fetch(path, { method, credentials: 'same-origin' }).then((r) => r.json());
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

export function UpdateButton({ events }: { events: EventSource }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const busy = isBusy(status);

  useEffect(() => {
    const onStatus = (e: MessageEvent) => setStatus(JSON.parse(e.data));
    // After an upgrade the server restarts: refresh on reconnect.
    const onHello = () => updateApi('/api/v1/update').then(setStatus, () => setStatus(null));
    events.addEventListener('update.status', onStatus);
    events.addEventListener('hello', onHello);
    return () => {
      events.removeEventListener('update.status', onStatus);
      events.removeEventListener('hello', onHello);
    };
  }, [events]);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => updateApi('/api/v1/update').then(setStatus, () => undefined), 3000);
    return () => clearInterval(timer);
  }, [busy]);

  const view = updateView(status);
  if (!status || !view) return null;

  const apply = async () => {
    if (!confirm(`Upgrade ozwell-computer ${status.current} → ${status.latest ?? 'latest'}?\nThe viewer reconnects when the server restarts.`)) return;
    try { setStatus(await updateApi('/api/v1/update/apply', 'POST')); } catch (e) { alert(`Could not start the upgrade: ${(e as Error).message}`); }
  };
  return (
    <Button id="btn-update" size="sm" variant={view.variant} disabled={view.busy} title={view.title} onClick={apply}>
      {view.label}
    </Button>
  );
}
