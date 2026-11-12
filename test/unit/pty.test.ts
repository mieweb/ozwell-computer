import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPty } from '../../src/process/pty.js';
import { makeApp } from '../helpers.js';

vi.mock('../../src/process/pty.js', () => ({ loadPty: vi.fn() }));
const temporary: string[] = [];
afterEach(async () => {
  vi.mocked(loadPty).mockReset();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'oz-pty-'));
  temporary.push(root);
  const { app } = await makeApp({ tokenFile: join(root, 'token') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new WebSocket(`ws://127.0.0.1:${(app.server.address() as any).port}/api/v1/pty`, { headers: { authorization: 'Bearer secret-token' } });
  client.on('error', () => {});
  await once(client, 'open');
  return { app, client };
}

describe('PTY connection setup', () => {
  it('does not spawn a shell when the client closes while the native module loads', async () => {
    let loaded!: (module: any) => void;
    const pending = new Promise((resolve) => { loaded = resolve; });
    vi.mocked(loadPty).mockImplementation(() => pending);
    const spawn = vi.fn();
    const { app, client } = await fixture();
    try {
      expect(loadPty).toHaveBeenCalledOnce();
      client.close();
      await once(client, 'close');
      loaded({ spawn });
      await new Promise((resolve) => setImmediate(resolve));
      expect(spawn).not.toHaveBeenCalled();
    } finally { loaded({ spawn }); client.terminate(); await app.close(); }
  });

  it('still starts an open terminal and kills it when its client closes', async () => {
    const terminal = { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn() };
    const spawn = vi.fn(() => terminal);
    vi.mocked(loadPty).mockResolvedValue({ spawn });
    const { app, client } = await fixture();
    try {
      expect(spawn).toHaveBeenCalledOnce();
      expect(terminal.kill).not.toHaveBeenCalled();
      client.close();
      await once(client, 'close');
      await vi.waitFor(() => expect(terminal.kill).toHaveBeenCalledOnce());
    } finally { client.terminate(); await app.close(); }
  });
});
