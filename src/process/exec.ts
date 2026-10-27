import { spawn } from 'node:child_process';
import { ApiError } from '../errors.js';

export interface ExecRequest {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  stdin?: string;
  shell?: boolean;
}

export interface ExecResult {
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  truncated: boolean;
  duration_ms: number;
}

const MAX_OUTPUT = 8 * 1024 * 1024;

export type ExecChunk = { stream: 'stdout' | 'stderr'; data: string } | { exit: ExecResult };

/** Run a command; onChunk receives streamed output when provided. */
export function runCommand(req: ExecRequest, display: string, onChunk?: (c: ExecChunk) => void, signal?: AbortSignal): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const useShell = req.shell ?? ((!req.args || req.args.length === 0) && /[\s|&;<>$`*?]/.test(req.cmd));
    // Own process group so a timeout kills the whole tree, not just the shell.
    const opts = { cwd: req.cwd, env: { ...process.env, DISPLAY: display, ...req.env }, detached: true };
    const child = useShell ? spawn('/bin/sh', ['-c', req.cmd], opts) : spawn(req.cmd, req.args ?? [], opts);
    let out = '', err = '', size = 0, truncated = false, timedOut = false;
    const killTree = () => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    const timeout = Math.min(Math.max(req.timeout_ms ?? 60_000, 1), 3_600_000);
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeout);
    const abort = () => killTree();
    signal?.addEventListener('abort', abort);
    const collect = (stream: 'stdout' | 'stderr') => (b: Buffer) => {
      const s = b.toString('utf8');
      onChunk?.({ stream, data: s });
      if (size + b.length > MAX_OUTPUT) { truncated = true; return; }
      size += b.length;
      if (stream === 'stdout') out += s; else err += s;
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    if (req.stdin !== undefined) child.stdin.end(req.stdin); else child.stdin.end();
    child.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(e.code === 'ENOENT' ? new ApiError('path_not_found', `command not found: ${req.cmd}`) : e);
    });
    // 'close' waits for stdio to close; a backgrounded grandchild can hold the pipes
    // open forever, so finish shortly after 'exit' regardless.
    let finished = false;
    child.once('exit', () => setTimeout(() => {
      if (finished) return;
      child.stdout.destroy(); child.stderr.destroy();
      child.emit('close', child.exitCode, child.signalCode);
    }, 500).unref());
    child.once('close', (code, sig) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const res: ExecResult = {
        exit_code: code, signal: sig, stdout: out, stderr: err, timed_out: timedOut, truncated, duration_ms: Date.now() - started,
      };
      onChunk?.({ exit: res });
      resolve(res);
    });
  });
}
