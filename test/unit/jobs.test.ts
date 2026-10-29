import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Jobs } from '../../src/process/jobs.js';

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
    const id = await jobs.start({ command: 'true' });
    await jobs.wait(id, 5000);
    await jobs.prune(Date.now() + 2 * 86_400_000);
    await expect(jobs.view(id)).rejects.toMatchObject({ reason: 'target_unavailable' });
  });

  it('reports a job whose process vanished without an exit as lost', async () => {
    const id = await jobs.start({ command: 'true' });
    await jobs.wait(id, 5000);
    rmSync(join(root, id, 'exit'));
    writeFileSync(join(root, id, 'meta.json'), JSON.stringify({ id, command: 'x', started: Date.now(), pid: 2 ** 22 - 1 }));
    expect((await jobs.view(id)).state).toBe('lost');
  });
});
