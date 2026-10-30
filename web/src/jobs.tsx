// Background commands (POST /api/v1/exec with wait_ms, MCP run_command), with live output and cancel.
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { Badge, type BadgeProps } from '@mieweb/ui/components/Badge';
import { Button } from '@mieweb/ui/components/Button';
import { api } from './api';
import { useServerEvent, useServerEventsState, useServerStreamId } from './events';

type JobState = 'running' | 'exited' | 'timed_out' | 'cancelled' | 'lost';
export type JobSummary = { job_id: string; state: JobState; exit_code: number | null; command: string; started_at: string; duration_ms: number };
type JobOutput = { stdout: string; stderr: string; stdout_offset: number; stderr_offset: number; truncated: boolean };
type JobView = JobSummary & JobOutput;
type Tagged = { tag?: string };
type Chunk = { key: number; text: string; className: string };
type Output = { chunks: Chunk[]; chars: number; discarded: boolean };

const LIST_MS = 2000;
const OUTPUT_MS = 1000;
const MAX_CHARS = 1_000_000;
const MAX_CHUNKS = 2000;
const EMPTY: Output = { chunks: [], chars: 0, discarded: false };

const stateLabel = (j: JobSummary) => (j.state === 'exited' ? `exit ${j.exit_code}` : j.state.replace('_', ' '));

function stateVariant(j: JobSummary): BadgeProps['variant'] {
  if (j.state === 'running') return 'success';
  if (j.state === 'exited') return j.exit_code === 0 ? 'secondary' : 'danger';
  return 'warning';
}

function StateBadge({ job, id }: { job: JobSummary; id?: string }) {
  return <Badge id={id} size="sm" variant={stateVariant(job)} className="flex-none">{stateLabel(job)}</Badge>;
}

const upsert = (jobs: JobSummary[], s: JobSummary) =>
  jobs.some((j) => j.job_id === s.job_id) ? jobs.map((j) => (j.job_id === s.job_id ? s : j)) : [s, ...jobs];

type Update = (jobs: JobSummary[]) => JobSummary[];

/**
 * The job list (when exec is enabled): fetched when the event stream (re)connects (retrying until a
 * fetch succeeds), then kept current by `job` / `job.removed` events; polled only while the stream
 * is broken. refresh() fetches now.
 */
export function useJobs(enabled: boolean) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const stream = useServerEventsState();
  // Events that arrive while a fetch is in flight are replayed onto its snapshot.
  const pending = useRef<Update[] | null>(null);
  const latest = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout>>(undefined);
  const update = (fn: Update) => { pending.current?.push(fn); setJobs(fn); };
  const refresh = useCallback(async () => {
    const n = ++latest.current;
    const buffered: Update[] = [];
    pending.current = buffered;
    const list = await api<{ jobs: JobSummary[] }>('/api/v1/exec/jobs').finally(() => { if (pending.current === buffered) pending.current = null; });
    if (n !== latest.current) return;
    setJobs(buffered.reduce((js, fn) => fn(js), list.jobs));
  }, []);
  const sync = useCallback(() => {
    clearTimeout(retry.current);
    refresh().catch(() => { retry.current = setTimeout(sync, LIST_MS); });
  }, [refresh]);
  useEffect(() => { if (enabled) sync(); return () => clearTimeout(retry.current); }, [enabled, sync]);
  useServerEvent('hello', () => { if (enabled) sync(); });
  useServerEvent<JobSummary>('job', (s) => { if (enabled) update((js) => upsert(js, s)); });
  useServerEvent<{ job_id: string }>('job.removed', ({ job_id }) => { if (enabled) update((js) => js.filter((j) => j.job_id !== job_id)); });
  useEffect(() => {
    if (!enabled || stream !== 'broken') return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const poll = () => void refresh().catch(() => undefined).finally(() => { if (!stopped) timer = setTimeout(poll, LIST_MS); });
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [enabled, stream, refresh]);
  return { jobs, refresh };
}

const outputChunks = (o: JobOutput, key: () => number) => [
  o.truncated && { text: '… earlier output not shown …\n', className: 'note italic text-muted-foreground' },
  o.stdout && { text: o.stdout, className: 'out' },
  o.stderr && { text: o.stderr, className: 'err text-destructive' },
].filter((c) => !!c).map((c) => ({ ...c, key: key() }));

/** Append chunks, dropping the oldest beyond MAX_CHARS / MAX_CHUNKS (so each update copies at most MAX_CHUNKS refs). */
function appendBounded(o: Output, added: Chunk[]): Output {
  const chunks = [...o.chunks, ...added];
  let chars = o.chars + added.reduce((n, c) => n + c.text.length, 0);
  let start = 0;
  while (start < chunks.length - 1 && (chars > MAX_CHARS || chunks.length - start > MAX_CHUNKS)) chars -= chunks[start++].text.length;
  return { chunks: start ? chunks.slice(start) : chunks, chars, discarded: o.discarded || start > 0 };
}

// PUTs to one stream's subscription go one at a time, so a stop can't overtake the next subscribe.
let subscriptions = Promise.resolve();
let tags = 0;
const subscribe = (streamId: string, body: object) => {
  const put = subscriptions.then(() => api(`/api/v1/events/${encodeURIComponent(streamId)}/job`, { method: 'PUT', body: JSON.stringify(body) }));
  subscriptions = put.then(() => undefined, () => undefined);
  return put;
};

/**
 * Tails the job's output over the shared event stream, resubscribing from the last offsets whenever
 * it reconnects; while the stream is down or the subscription fails, polls with byte offsets
 * (retrying failures) until a read succeeds with the job no longer running.
 */
function useJobOutput(id: string | null) {
  const [view, setView] = useState<JobSummary | null>(null);
  const [output, setOutput] = useState<Output>(EMPTY);
  const streamId = useServerStreamId();
  const offsets = useRef({ stdout: 0, stderr: 0 });
  const seq = useRef(0);
  // Events from an earlier subscription (still in flight) carry another tag and are ignored.
  const tag = useRef<string | null>(null);
  const append = (o: JobOutput) => {
    offsets.current = { stdout: o.stdout_offset, stderr: o.stderr_offset };
    const added = outputChunks(o, () => seq.current++);
    if (added.length) setOutput((out) => appendBounded(out, added));
  };
  const onPoll = useEffectEvent((v: JobView) => { append(v); setView(v); });
  useServerEvent<JobOutput & Tagged>('job.output', (o) => { if (o.tag === tag.current) append(o); });
  useServerEvent<JobSummary & Tagged>('job.state', (s) => { if (s.tag === tag.current) setView(s); });
  useServerEvent<JobSummary & Tagged>('job.end', (s) => { if (s.tag === tag.current) setView(s); });
  useEffect(() => {
    setView(null);
    setOutput(EMPTY);
    offsets.current = { stdout: 0, stderr: 0 };
  }, [id]);
  useEffect(() => {
    if (!id) return;
    const url = `/api/v1/exec/jobs/${encodeURIComponent(id)}`;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const poll = async () => {
      const { stdout, stderr } = offsets.current;
      const v = await api<JobView>(`${url}?stdout_offset=${stdout}&stderr_offset=${stderr}`).catch(() => null);
      if (stopped) return;
      if (v) {
        onPoll(v);
        if (v.state !== 'running') return;
      }
      timer = setTimeout(poll, OUTPUT_MS);
    };
    const stop = () => { stopped = true; clearTimeout(timer); };
    if (!streamId) { void poll(); return stop; }
    const t = `${++tags}`;
    tag.current = t;
    const { stdout, stderr } = offsets.current;
    subscribe(streamId, { job_id: id, stdout_offset: stdout, stderr_offset: stderr, tag: t }).catch(() => {
      if (stopped) return;
      tag.current = null;
      void poll();
    });
    return () => {
      stop();
      if (tag.current === t) tag.current = null;
      void subscribe(streamId, { job_id: null }).catch(() => undefined);
    };
  }, [id, streamId]);
  return { view, output };
}

export function JobsPanel({ jobs, refresh, canCancel, toast }: {
  jobs: JobSummary[];
  refresh: () => Promise<void>;
  canCancel: boolean;
  toast: (text: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  const { view, output } = useJobOutput(selected);
  const outRef = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);

  // The list may be stale when the tab opens; pick the default only once it is refreshed.
  useEffect(() => { void refresh().catch(() => undefined).finally(() => setFresh(true)); }, [refresh]);
  // Also moves off a job that was pruned while selected.
  useEffect(() => {
    if (!fresh || jobs.some((j) => j.job_id === selected)) return;
    setSelected(jobs.length ? (jobs.find((j) => j.state === 'running') ?? jobs[0]).job_id : null);
  }, [fresh, jobs, selected]);

  useLayoutEffect(() => {
    const out = outRef.current;
    if (out && atBottom.current) out.scrollTop = out.scrollHeight;
  }, [output]);

  const cancel = async () => {
    if (!view || !confirm(`Cancel this command?\n\n${view.command}`)) return;
    await api(`/api/v1/exec/jobs/${encodeURIComponent(view.job_id)}`, { method: 'DELETE' }).catch((e: Error) => toast(`Could not cancel: ${e.message}`));
  };

  return (
    <div id="jobs-panel" className="flex min-h-0 flex-1 flex-col bg-muted md:flex-row">
      <ul id="jobs-list" className="m-0 max-h-[40%] list-none overflow-y-auto border-b border-border p-0 md:max-h-none md:w-[35%] md:max-w-[420px] md:border-r md:border-b-0">
        {!jobs.length && <li className="empty px-2 py-1 text-muted-foreground">No background commands</li>}
        {jobs.map((j) => (
          <li key={j.job_id} className={j.job_id === selected ? 'sel' : undefined}>
            <button type="button" aria-pressed={j.job_id === selected} onClick={() => setSelected(j.job_id)}
              title={`${j.job_id}, started ${new Date(j.started_at).toLocaleString()}`}
              className={`flex w-full cursor-pointer items-center gap-1.5 px-2 py-2 text-left md:py-1 whitespace-nowrap hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset ${j.job_id === selected ? 'bg-accent' : ''}`}>
              <StateBadge job={j} />
              <code className="truncate">{j.command}</code>
            </button>
          </li>
        ))}
      </ul>
      <div id="jobs-detail" className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div id="jobs-head" className="flex min-h-8 items-center gap-2 border-b border-border px-2 py-1">
          {view && <StateBadge id="jobs-state" job={view} />}
          <code id="jobs-cmd" className="flex-1 truncate" title={view?.command}>{view?.command}</code>
          {view?.state === 'running' && canCancel && (
            <Button id="jobs-cancel" size="sm" variant="danger" onClick={cancel}>Cancel</Button>
          )}
        </div>
        <pre id="jobs-out" ref={outRef} className="m-0 flex-1 overflow-auto bg-background px-2 py-1.5 font-mono text-xs break-all whitespace-pre-wrap"
          onScroll={(e) => { const o = e.currentTarget; atBottom.current = o.scrollHeight - o.scrollTop - o.clientHeight < 4; }}>
          {output.discarded && <span className="note italic text-muted-foreground">… earlier output discarded …{'\n'}</span>}
          {output.chunks.map((c) => <span key={c.key} className={c.className}>{c.text}</span>)}
        </pre>
      </div>
    </div>
  );
}
