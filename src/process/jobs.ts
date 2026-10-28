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
import { mkdir, readdir, readFile, rm, stat, writeFile, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ApiError } from '../errors.js';

export const MAX_WAIT_MS = 50_000; // stays under common 60 s MCP client request timeouts
export const DEFAULT_WAIT_MS = 25_000;
const OUTPUT_CHUNK = 50_000;
const FINISHED_TTL_MS = 24 * 3600_000;

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

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** Jobs live next to the token file: /var/lib/ozwell-computer/jobs in the package/container. */
export function jobsFor(config: { tokenFile: string }, display: string) {
  return new Jobs(join(dirname(config.tokenFile), 'jobs'), display);
}

export class Jobs {
  constructor(private root: string, private display: string) {}

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
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ id, command, cwd: req.cwd ?? null, started: Date.now(), timeout_ms: timeoutS * 1000, pid: child.pid }));
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

  async view(id: string, offsets: { stdout?: number; stderr?: number } = {}): Promise<JobView> {
    const dir = this.dir(id);
    let meta;
    try { meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')); } catch { throw new ApiError('target_unavailable', `no job ${id}`); }
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

  /** Wait up to waitMs for the job to finish, then return its view. */
  async wait(id: string, waitMs: number, offsets?: { stdout?: number; stderr?: number }): Promise<JobView> {
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
    return this.wait(id, 2000);
  }

  /** Remove finished jobs older than the TTL. */
  async prune(now = Date.now()) {
    let ids: string[] = [];
    try { ids = await readdir(this.root); } catch { return; }
    for (const id of ids) {
      const done = await stat(join(this.root, id, 'exit')).catch(() => null);
      if (done && now - done.mtimeMs > FINISHED_TTL_MS) await rm(join(this.root, id), { recursive: true, force: true });
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
