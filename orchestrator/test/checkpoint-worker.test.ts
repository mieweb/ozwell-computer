import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const workerFile = fileURLToPath(new URL('../src/providers/checkpoint-worker.mjs', import.meta.url));
async function runWorker(socket: string, operation = 'save') {
  const child = spawn(process.execPath, [workerFile], { env: { ...process.env, TARGET_ID: 'a'.repeat(64), CHECKPOINT_ID: 'ozc-0123456789abcdef', OPERATION: operation, ENGINE_SOCKET: socket }, stdio: 'ignore' });
  const [code] = await once(child, 'exit'); return code;
}
async function engine(status?: number) {
  const dir = await mkdtemp('/tmp/ozc-cp-worker-'), socket = join(dir, 'engine.sock'), calls: Array<{ path: string; body: any }> = [];
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    calls.push({ path: req.url!, body: text ? JSON.parse(text) : undefined });
    if (status === undefined) req.socket.destroy(); else { res.writeHead(status); res.end(status >= 400 ? 'engine failure' : ''); }
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { socket, calls };
}
describe('durable checkpoint worker receipt', () => {
  it('reports success only after checkpoint HTTP 201 and sends Exit=true', async () => {
    const e = await engine(201); expect(await runWorker(e.socket)).toBe(0);
    expect(e.calls).toEqual([{ path: `/containers/${'a'.repeat(64)}/checkpoints`, body: { CheckpointID: 'ozc-0123456789abcdef', Exit: true } }]);
  });
  it('restores exclusively through the checkpoint-qualified Engine endpoint', async () => {
    const e = await engine(204); expect(await runWorker(e.socket, 'restore')).toBe(0);
    expect(e.calls[0].path).toBe(`/containers/${'a'.repeat(64)}/start?checkpoint=ozc-0123456789abcdef`);
  });
  it.each([304, 500])('reserves exit 64 for a fully received HTTP failure (%s)', async (status) => {
    const e = await engine(status); expect(await runWorker(e.socket, 'restore')).toBe(64);
  });
  it('distinguishes lost/aborted requests from positive failure receipts', async () => {
    const e = await engine(); expect(await runWorker(e.socket)).toBe(2);
    expect(await runWorker('/tmp/ozc-no-such-checkpoint-socket')).toBe(2);
  });
});
