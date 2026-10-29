// Background command jobs: "wait, then hand off".
//
// Each job runs detached in its own process group, with stdout/stderr written straight
// to files and the exit code recorded by a wrapper shell, all under <root>/<id>/. Nothing
// lives in server memory, so jobs keep running and stay readable across server restarts.
//   cmd.sh     the command (sh)          stdout / stderr   output
//   meta.json  {id, command, cwd, started, timeout_ms, pid}
//   exit       exit status (written when the command ends; 124/137 = timed out)
//   cancelled  marker written by cancel()
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ApiError } from '../errors.js';
import type { EventBus } from '../presence/index.js';

export const MAX_WAIT_MS = 50_000; // stays under common 60 s MCP client request timeouts
export const DEFAULT_WAIT_MS = 25_000;
const OUTPUT_CHUNK = 50_000;
const FINISHED_TTL_MS = 24 * 3600_000;
const WATCH_MS = 1000;
const FOLLOW_MS = 250;

export type JobState = 'running' | 'exited' | 'timed_out' | 'cancelled' | 'lost';

export interface JobStart {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  stdin?: string;
}

export interface JobView {
  job_id: string;
  state: JobState;
  exit_code: number | null;
  command: string;
  started_at: string;
  duration_ms: number;
  stdout: string;
  stderr: string;
  /** Byte offsets to pass back to read only output produced after this view. */
  stdout_offset: number;
  stderr_offset: number;
  truncated: boolean;
}

export type JobSummary = Omit<JobView, 'stdout' | 'stderr' | 'stdout_offset' | 'stderr_offset' | 'truncated'>;
export type JobOffsets = { stdout?: number; stderr?: number };

export const summarize = ({ stdout, stderr, stdout_offset, stderr_offset, truncated, ...s }: JobView): JobSummary => s;
const END = { stdout: Number.MAX_SAFE_INTEGER, stderr: Number.MAX_SAFE_INTEGER };

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LIST_CONCURRENCY = 16;

/** Like Promise.all(items.map(fn)), with at most `limit` calls in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

const instances = new WeakMap<object, Jobs>();

/**
 * One Jobs per desktop (shared by HTTP and MCP), publishing `job` and `job.removed` events on its bus.
 * Jobs live next to the token file: /var/lib/ozwell-computer/jobs in the package/container.
 */
export function jobsFor(config: { tokenFile: string }, desktop: { x: { displayName: string }; bus: EventBus }) {
  const existing = instances.get(desktop);
  if (existing) return existing;
  const jobs = new Jobs(join(dirname(config.tokenFile), 'jobs'), desktop.x.displayName,
    (s) => desktop.bus.publish('job', s), (id) => desktop.bus.publish('job.removed', { job_id: id }));
  instances.set(desktop, jobs);
  return jobs;
}

export class Jobs {
  private running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  /** onChange gets a job's summary when it starts and when it stops running; onRemove its id when pruned. */
  constructor(
    private root: string,
    private display: string,
    private onChange: (s: JobSummary) => void = () => {},
    private onRemove: (id: string) => void = () => {},
  ) {}

  /** Check running jobs every WATCH_MS until none are left. */
  private watch(id: string) {
    this.running.add(id);
    this.timer ??= setInterval(() => void this.check(), WATCH_MS).unref();
  }

  private async check() {
    for (const id of this.running) {
      const s = await this.summary(id).catch(() => null);
      if (s?.state === 'running') continue;
      // A failed read is retried on the next check unless the job is gone.
      if (!s && await stat(join(this.root, id)).then(() => true, (e) => e.code !== 'ENOENT')) continue;
      this.running.delete(id);
      if (s) this.onChange(s);
      else this.onRemove(id);
    }
    if (this.running.size || !this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private dir(id: string) {
    if (!/^j-[a-z0-9]{12}$/.test(id)) throw new ApiError('target_unavailable', `no job ${id}`);
    return join(this.root, id);
  }

  async start(req: JobStart): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    void this.prune();
    const id = 'j-' + randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 12);
    const dir = join(this.root, id);
    await mkdir(dir, { mode: 0o700 });
    const command = req.args?.length ? [req.command, ...req.args].map(q).join(' ') : req.command;
    const timeoutS = Math.max(1, Math.ceil(Math.min(req.timeout_ms ?? 3_600_000, 24 * 3_600_000) / 1000));
    await writeFile(join(dir, 'cmd.sh'), command + '\n');
    if (req.stdin !== undefined) await writeFile(join(dir, 'stdin'), req.stdin);
    // timeout(1) enforces the limit even if this server restarts; it kills the whole group.
    const wrapper = `timeout --kill-after=5 ${timeoutS} sh ${q(join(dir, 'cmd.sh'))} < ${req.stdin !== undefined ? q(join(dir, 'stdin')) : '/dev/null'}; echo $? > ${q(join(dir, 'exit.tmp'))}; mv ${q(join(dir, 'exit.tmp'))} ${q(join(dir, 'exit'))}`;
    const out = openSync(join(dir, 'stdout'), 'a');
    const err = openSync(join(dir, 'stderr'), 'a');
    let child;
    try {
      child = spawn('/bin/sh', ['-c', wrapper], {
        cwd: req.cwd || process.env.HOME || '/', detached: true, stdio: ['ignore', out, err],
        env: { ...process.env, DISPLAY: this.display, ...req.env },
      });
      await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject); });
    } catch (e) {
      throw (e as NodeJS.ErrnoException).code === 'ENOENT' ? new ApiError('path_not_found', `working directory not found: ${req.cwd}`) : e;
    } finally {
      closeSync(out); closeSync(err);
    }
    child.unref();
    // Written atomically, so a missing meta.json means "still starting" and an unreadable one is an error.
    await writeFile(join(dir, 'meta.json.tmp'), JSON.stringify({ id, command, cwd: req.cwd ?? null, started: Date.now(), timeout_ms: timeoutS * 1000, pid: child.pid }));
    await rename(join(dir, 'meta.json.tmp'), join(dir, 'meta.json'));
    this.onChange(await this.summary(id));
    this.watch(id);
    return id;
  }

  private async readFrom(path: string, offset: number) {
    let fh;
    try { fh = await open(path, 'r'); } catch { return { text: '', end: offset, truncated: false }; }
    try {
      const size = (await fh.stat()).size;
      let from = Math.min(Math.max(0, offset), size);
      let truncated = false;
      if (size - from > OUTPUT_CHUNK) { from = size - OUTPUT_CHUNK; truncated = true; } // newest output wins
      const buf = Buffer.alloc(size - from);
      await fh.read(buf, 0, buf.length, from);
      return { text: buf.toString('utf8'), end: size, truncated };
    } finally { await fh.close(); }
  }

  async view(id: string, offsets: JobOffsets = {}): Promise<JobView> {
    const dir = this.dir(id);
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8').catch((e) => {
      throw e.code === 'ENOENT' ? new ApiError('target_unavailable', `no job ${id}`) : e;
    }));
    const exitText = await readFile(join(dir, 'exit'), 'utf8').catch(() => null);
    const cancelled = await stat(join(dir, 'cancelled')).then(() => true, () => false);
    let state: JobState;
    let exit: number | null = null;
    if (exitText !== null) {
      exit = Number(exitText.trim());
      state = cancelled ? 'cancelled' : exit === 124 || exit === 137 ? 'timed_out' : 'exited';
    } else {
      state = alive(meta.pid) ? 'running' : cancelled ? 'cancelled' : 'lost';
    }
    const [o, e] = await Promise.all([this.readFrom(join(dir, 'stdout'), offsets.stdout ?? 0), this.readFrom(join(dir, 'stderr'), offsets.stderr ?? 0)]);
    const end = exitText !== null ? (await stat(join(dir, 'exit'))).mtimeMs : Date.now();
    return {
      job_id: id, state, exit_code: state === 'exited' || state === 'timed_out' ? exit : null, command: meta.command,
      started_at: new Date(meta.started).toISOString(), duration_ms: Math.round(end - meta.started),
      stdout: o.text, stderr: e.text, stdout_offset: o.end, stderr_offset: e.end, truncated: o.truncated || e.truncated,
    };
  }

  async summary(id: string): Promise<JobSummary> {
    return summarize(await this.view(id, END));
  }

  /** All jobs still on disk, newest first, without their output. */
  async list(): Promise<JobSummary[]> {
    const ids = await readdir(this.root).catch((e) => { if (e.code === 'ENOENT') return [] as string[]; throw e; });
    // Skip jobs still starting (no meta.json yet) or removed meanwhile; other failures fail the list.
    const read = (id: string) => this.summary(id).catch((e) => {
      if (e instanceof ApiError && e.reason === 'target_unavailable') return null;
      throw e;
    });
    const jobs = (await mapLimit(ids, LIST_CONCURRENCY, read)).filter((s) => s !== null);
    // Jobs left running by an earlier server process get watched from here on.
    for (const j of jobs) if (j.state === 'running') this.watch(j.job_id);
    return jobs.sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  /**
   * Yield views with the output produced since the previous one (starting at offsets) whenever
   * there is new output or the state changes; the last one is the first that is not running.
   */
  async *follow(id: string, offsets: JobOffsets, signal: AbortSignal): AsyncGenerator<JobView> {
    let at = offsets;
    let state: JobState | null = null;
    for (;;) {
      const v = await this.view(id, at);
      if (signal.aborted) return;
      if (v.stdout || v.stderr || v.truncated || v.state !== state) yield v;
      if (v.state !== 'running') return;
      at = { stdout: v.stdout_offset, stderr: v.stderr_offset };
      state = v.state;
      await sleep(FOLLOW_MS);
      if (signal.aborted) return;
    }
  }

  /** Wait up to waitMs for the job to finish, then return its view. */
  async wait(id: string, waitMs: number, offsets?: JobOffsets): Promise<JobView> {
    const end = Date.now() + Math.min(Math.max(0, waitMs), MAX_WAIT_MS);
    for (;;) {
      const v = await this.view(id, offsets);
      if (v.state !== 'running' || Date.now() >= end) return v;
      await sleep(Math.min(250, Math.max(10, end - Date.now())));
    }
  }

  async cancel(id: string): Promise<JobView> {
    const dir = this.dir(id);
    const v = await this.view(id);
    if (v.state === 'running') {
      await writeFile(join(dir, 'cancelled'), '');
      const { pid } = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }
    const done = await this.wait(id, 2000);
    if (v.state !== 'running' || done.state === 'running') return done;
    this.running.delete(id);
    this.onChange(summarize(done));
    return done;
  }

  /** Remove finished jobs older than the TTL. */
  async prune(now = Date.now()) {
    let ids: string[] = [];
    try { ids = await readdir(this.root); } catch { return; }
    for (const id of ids) {
      const done = await stat(join(this.root, id, 'exit')).catch(() => null);
      if (!done || now - done.mtimeMs <= FINISHED_TTL_MS) continue;
      await rm(join(this.root, id), { recursive: true, force: true });
      this.onRemove(id);
    }
  }
}

/** The MCP/HTTP shape: finished jobs read like a plain command result; running ones add guidance. */
export function present(v: JobView) {
  if (v.state === 'running') {
    return { ...v, note: `Still running after ${Math.round(v.duration_ms / 1000)} s. Call command_output with this job_id (and the offsets to get only new output) until state is not "running".` };
  }
  return v;
}
