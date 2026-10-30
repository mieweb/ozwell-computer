import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Jobs, type JobSummary, type JobView } from '../../src/process/jobs.js';
import type { BusEvent } from '../../src/presence/index.js';
import { openSse } from '../../src/routes/sse.js';
import { webBuild } from '../../src/web/routes.js';
import { makeApp } from '../helpers.js';

const root = mkdtempSync(join(tmpdir(), 'oz-jobs-'));
const jobs = new Jobs(root, ':0');
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('background jobs (wait, then hand off)', () => {
  it('returns the result directly when the command finishes within the wait', async () => {
    const v = await jobs.wait(await jobs.start({ command: 'echo hi; echo err >&2; exit 3' }), 5000);
    expect(v).toMatchObject({ state: 'exited', exit_code: 3, stdout: 'hi\n', stderr: 'err\n' });
  });

  it('hands off a long command, then reports new output by offset and the final result', async () => {
    const id = await jobs.start({ command: 'echo one; sleep 1.5; echo two' });
    const first = await jobs.wait(id, 300);
    expect(first.state).toBe('running');
    expect(first.stdout).toBe('one\n');
    const done = await jobs.wait(id, 5000, { stdout: first.stdout_offset });
    expect(done).toMatchObject({ state: 'exited', exit_code: 0, stdout: 'two\n' });
    expect((await jobs.view(id)).stdout).toBe('one\ntwo\n');
  });

  it('times out and cancels the whole process group', async () => {
    const t = await jobs.wait(await jobs.start({ command: 'sleep 30', timeout_ms: 1000 }), 5000);
    expect(t.state).toBe('timed_out');
    const id = await jobs.start({ command: 'sleep 30 & sleep 30; echo never' });
    expect((await jobs.wait(id, 200)).state).toBe('running');
    const c = await jobs.cancel(id);
    expect(c.state).toBe('cancelled');
    expect(c.stdout).toBe('');
  });

  it('lists jobs newest first, without output', async () => {
    const done = await jobs.start({ command: 'echo listed' });
    await jobs.wait(done, 5000);
    await new Promise((r) => setTimeout(r, 5));
    const running = await jobs.start({ command: 'sleep 30' });
    const list = await jobs.list();
    expect(list.slice(0, 2)).toMatchObject([
      { job_id: running, state: 'running', command: 'sleep 30' },
      { job_id: done, state: 'exited', exit_code: 0, command: 'echo listed' },
    ]);
    expect(list[0]).not.toHaveProperty('stdout');
    await jobs.cancel(running);
    expect(await new Jobs(join(root, 'missing'), ':0').list()).toEqual([]);
  });

  it('runs argv without a shell, passes stdin/env/cwd, and keeps only the newest output', async () => {
    const a = await jobs.wait(await jobs.start({ command: 'printf', args: ['%s|', "it's", '$HOME'] }), 5000);
    expect(a.stdout).toBe("it's|$HOME|");
    const b = await jobs.wait(await jobs.start({ command: 'cat; echo $FOO; pwd', stdin: 'in\n', env: { FOO: 'bar' }, cwd: '/tmp' }), 5000);
    expect(b.stdout).toBe(`in\nbar\n${realpathSync('/tmp')}\n`);
    const big = await jobs.wait(await jobs.start({ command: 'seq 1 30000' }), 5000);
    expect(big.truncated).toBe(true);
    expect(big.stdout.trimEnd().endsWith('30000')).toBe(true);
  });

  it('rejects unknown or malformed ids and prunes old finished jobs', async () => {
    await expect(jobs.view('j-nope00000000')).rejects.toMatchObject({ reason: 'target_unavailable' });
    await expect(jobs.view('../etc')).rejects.toMatchObject({ reason: 'target_unavailable' });
    const removed: string[] = [];
    const pruning = new Jobs(join(root, 'prune'), ':0', undefined, (id) => removed.push(id));
    const id = await pruning.start({ command: 'true' });
    await pruning.wait(id, 5000);
    await pruning.prune(Date.now() + 2 * 86_400_000);
    await expect(pruning.view(id)).rejects.toMatchObject({ reason: 'target_unavailable' });
    expect(removed).toEqual([id]);
  });

  it('reports a job whose process vanished without an exit as lost', async () => {
    const id = await jobs.start({ command: 'true' });
    await jobs.wait(id, 5000);
    rmSync(join(root, id, 'exit'));
    writeFileSync(join(root, id, 'meta.json'), JSON.stringify({ id, command: 'x', started: Date.now(), pid: 2 ** 22 - 1 }));
    expect((await jobs.view(id)).state).toBe('lost');
  });

  it('reports starts and finishes, including cancels and jobs found by list()', async () => {
    const seen: JobSummary[] = [];
    const dir = join(root, 'notify');
    const watched = new Jobs(dir, ':0', (s) => seen.push(s));
    const quick = await watched.start({ command: 'sleep 0.3' });
    const slow = await watched.start({ command: 'sleep 30' });
    expect(seen.map((s) => [s.job_id, s.state])).toEqual([[quick, 'running'], [slow, 'running']]);
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ job_id: quick, state: 'exited', exit_code: 0 }), { timeout: 3000 });
    await watched.cancel(slow);
    expect(seen.at(-1)).toMatchObject({ job_id: slow, state: 'cancelled' });
    // A fresh instance (as after a server restart) picks up running jobs when it lists them.
    const orphan = await new Jobs(dir, ':0').start({ command: 'sleep 0.3' });
    expect((await watched.list()).find((j) => j.job_id === orphan)?.state).toBe('running');
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ job_id: orphan, state: 'exited' }), { timeout: 3000 });
    // Cancelling a job this instance never watched (started before a restart) still reports it.
    const unwatched = await new Jobs(dir, ':0').start({ command: 'sleep 30' });
    await watched.cancel(unwatched);
    expect(seen.at(-1)).toMatchObject({ job_id: unwatched, state: 'cancelled' });
  });

  it('keeps watching a job through failed reads, and reports it removed once its directory is gone', async () => {
    const seen: JobSummary[] = [];
    const removed: string[] = [];
    const dir = join(root, 'flaky');
    const watched = new Jobs(dir, ':0', (s) => seen.push(s), (id) => removed.push(id));
    const id = await watched.start({ command: 'sleep 0.5' });
    const meta = readFileSync(join(dir, id, 'meta.json'), 'utf8');
    writeFileSync(join(dir, id, 'meta.json'), '{'); // unreadable across a check or two, and past the job's end
    await new Promise((r) => setTimeout(r, 1500));
    writeFileSync(join(dir, id, 'meta.json'), meta);
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ job_id: id, state: 'exited' }), { timeout: 3000 });
    const gone = await watched.start({ command: 'sleep 30' });
    process.kill(-JSON.parse(readFileSync(join(dir, gone, 'meta.json'), 'utf8')).pid, 'SIGKILL');
    rmSync(join(dir, gone), { recursive: true, force: true });
    await vi.waitFor(() => expect(removed).toEqual([gone]), { timeout: 3000 });
  });

  it('lists with bounded concurrency, skipping only jobs that are starting or gone', async () => {
    const dir = join(root, 'many');
    const listing = new Jobs(dir, ':0');
    for (let i = 0; i < 40; i++) mkdirSync(join(dir, `j-${String(i).padStart(12, '0')}`), { recursive: true });
    writeFileSync(join(dir, 'stray'), '');
    let inFlight = 0;
    let most = 0;
    const summary = listing.summary.bind(listing);
    const spy = vi.spyOn(listing, 'summary').mockImplementation(async (id) => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return summary(id);
    });
    expect(await listing.list()).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(41);
    expect(most).toBeLessThanOrEqual(16);
    writeFileSync(join(dir, 'j-000000000000', 'meta.json'), '{');
    await expect(listing.list()).rejects.toThrow(SyntaxError);
  });

  it('follows output from offsets until the job stops', async () => {
    const id = await jobs.start({ command: 'echo one; sleep 0.5; echo two >&2; sleep 0.3' });
    const views: JobView[] = [];
    for await (const v of jobs.follow(id, {}, new AbortController().signal)) views.push(v);
    expect(views.map((v) => v.stdout).join('')).toBe('one\n');
    expect(views.map((v) => v.stderr).join('')).toBe('two\n');
    expect(views[0].state).toBe('running');
    expect(views.at(-1)).toMatchObject({ state: 'exited', stdout_offset: 4, stderr_offset: 4 });
    const rest: JobView[] = [];
    for await (const v of jobs.follow(id, { stdout: 4, stderr: 0 }, new AbortController().signal)) rest.push(v);
    expect(rest).toMatchObject([{ state: 'exited', stdout: '', stderr: 'two\n' }]);
    const ac = new AbortController();
    const long = await jobs.start({ command: 'sleep 30' });
    const it = jobs.follow(long, {}, ac.signal);
    expect((await it.next()).value).toMatchObject({ state: 'running' });
    ac.abort();
    expect((await it.next()).done).toBe(true);
    await jobs.cancel(long);
  });
});

describe('viewer build id', () => {
  it('identifies the viewer build by its index.html', () => {
    const page = join(root, 'index.html');
    expect(webBuild(page, '1.2.3')).toBe('1.2.3');
    writeFileSync(page, '<script src="/static/assets/index-AAAA.js"></script>');
    const a = webBuild(page, '1.2.3');
    expect(a).toMatch(/^[\w-]{16}$/);
    expect(webBuild(page, '1.2.3')).toBe(a);
    writeFileSync(page, '<script src="/static/assets/index-BBBB.js"></script>');
    expect(webBuild(page, '1.2.3')).not.toBe(a);
  });
});

describe('job events and the output stream route', () => {  const events = (stream: string) => [...stream.matchAll(/(?:id: (\S+)\n)?event: (\S+)\ndata: (.*)\n\n/g)]
    .map(([, id, type, data]) => ({ id, type, data: JSON.parse(data) }));

  it('publishes job events and streams output, resuming from Last-Event-ID', async () => {
    const { app, desktop } = await makeApp({ exec: true, tokenFile: join(root, 'app', 'token') });
    const bus: BusEvent[] = [];
    desktop.bus.subscribe((ev) => bus.push(ev));
    const headers = { authorization: 'Bearer secret-token' };
    const start = await app.inject({ method: 'POST', url: '/api/v1/exec', headers, payload: { cmd: 'echo one; sleep 0.4; echo two >&2', wait_ms: 0 } });
    const id = start.json().job_id;
    expect(bus.filter((e) => e.type === 'job')[0].data).toMatchObject({ job_id: id, state: 'running' });
    const r = await app.inject({ url: `/api/v1/exec/jobs/${id}/stream`, headers });
    expect(r.headers['content-type']).toBe('text/event-stream');
    const evs = events(r.payload);
    expect(evs.filter((e) => e.type === 'output').map((e) => e.data.stdout + e.data.stderr).join('')).toBe('one\ntwo\n');
    expect(evs.find((e) => e.type === 'output')).toMatchObject({ id: '4-0', data: { stdout: 'one\n', stdout_offset: 4, stderr_offset: 0 } });
    expect(evs.at(-1)).toMatchObject({ type: 'end', data: { job_id: id, state: 'exited', exit_code: 0 } });
    expect(evs.filter((e) => e.type === 'state').map((e) => e.data.state)).toEqual(['running', 'exited']);
    const resumed = events((await app.inject({ url: `/api/v1/exec/jobs/${id}/stream?stdout_offset=0`, headers: { ...headers, 'last-event-id': '4-0' } })).payload);
    expect(resumed.map((e) => e.type)).toEqual(['output', 'state', 'end']);
    expect(resumed[0].data).toMatchObject({ stdout: '', stderr: 'two\n' });
    expect((await app.inject({ url: '/api/v1/exec/jobs/j-000000000000/stream', headers })).statusCode).toBe(404);
    await vi.waitFor(() => expect(bus.filter((e) => e.type === 'job').at(-1)?.data).toMatchObject({ job_id: id, state: 'exited' }), { timeout: 3000 });
    await app.close();
  });

  it('carries one job\'s output at a time on the shared event stream', async () => {
    const { app } = await makeApp({ exec: true, tokenFile: join(root, 'shared', 'token') });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const headers = { authorization: 'Bearer secret-token' };
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/v1/events`, { headers, signal: ac.signal });
    const stream = (async function* () {
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body!) {
        buf += dec.decode(chunk, { stream: true });
        const last = buf.lastIndexOf('\n\n');
        if (last < 0) continue;
        yield* events(buf.slice(0, last + 2));
        buf = buf.slice(last + 2);
      }
    })();
    const next = async (type: string) => { for (;;) { const e = (await stream.next()).value!; if (e.type === type) return e; } };
    const { stream_id, build } = (await next('hello')).data;
    expect(stream_id).toMatch(/^[\w-]{22}$/);
    expect(build).toBe(webBuild(join(import.meta.dirname, '..', '..', 'dist', 'web', 'static', 'index.html'), '0.0.0-test'));
    const put = (body: object, sid = stream_id) => app.inject({ method: 'PUT', url: `/api/v1/events/${sid}/job`, headers, payload: body });
    const exec = async (cmd: string, wait_ms: number) => (await app.inject({ method: 'POST', url: '/api/v1/exec', headers, payload: { cmd, wait_ms } })).json().job_id;

    const long = await exec('echo first; sleep 30', 0);
    expect((await put({ job_id: long, tag: 'a' })).json()).toEqual({ ok: true });
    expect(await next('job.output')).toMatchObject({ id: undefined, data: { job_id: long, stdout: 'first\n', stdout_offset: 6, tag: 'a' } });
    // A new subscription replaces the old one and starts at its offsets.
    const quick = await exec('echo one; echo two >&2', 5000);
    await put({ job_id: quick, stdout_offset: 4, tag: 'b' });
    const got = [await next('job.output'), await next('job.state'), await next('job.end')];
    expect(got.map((e) => e.data)).toMatchObject([
      { job_id: quick, stdout: '', stderr: 'two\n', tag: 'b' },
      { job_id: quick, state: 'exited', tag: 'b' },
      { job_id: quick, state: 'exited', exit_code: 0, tag: 'b' },
    ]);
    expect((await put({ job_id: null })).json()).toEqual({ ok: true });
    expect((await put({ job_id: 'j-000000000000' })).statusCode).toBe(404);
    expect((await put({ job_id: null }, 'nope')).json().error.reason).toBe('target_unavailable');
    await app.inject({ method: 'DELETE', url: `/api/v1/exec/jobs/${long}`, headers });
    ac.abort();
    await vi.waitFor(async () => expect((await put({ job_id: null })).statusCode).toBe(404));
    await app.close();
  });

  it('aborts a stream whose client left before it opened', async () => {
    const app = Fastify();
    let arrived!: () => void;
    const arrival = new Promise<void>((r) => { arrived = r; });
    const opened = new Promise<AbortSignal>((resolve) => app.get('/s', async (req, reply) => {
      arrived();
      await once(req.raw.socket, 'close');
      resolve(openSse(reply, '/s').signal);
    }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const ac = new AbortController();
    void fetch(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/s`, { signal: ac.signal }).catch(() => undefined);
    await arrival;
    ac.abort();
    expect((await opened).aborted).toBe(true);
    await app.close();
  });
});
