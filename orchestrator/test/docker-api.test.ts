import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DockerApi } from '../src/providers/docker.ts';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const app = createServer(handler); await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => { app.closeAllConnections(); app.close(() => resolve()); }));
  return { host: '127.0.0.1', port: (app.address() as any).port };
}
describe('bounded Docker control reads', () => {
  it('rejects a truncated inspection response rather than leaving the lock pinned forever', async () => {
    const target = await server((req, res) => { res.writeHead(200, { 'content-length': '1000', 'content-type': 'application/json' }); res.write('{"State":'); setImmediate(() => req.socket.destroy()); });
    await expect(new DockerApi(target, 1000).call('GET', '/containers/test/json')).rejects.toThrow(/aborted|reset/i);
  });
  it('bounds a stalled GET without detaching mutation requests', async () => {
    const target = await server((req, res) => { if (req.method === 'POST') setTimeout(() => { res.writeHead(204); res.end(); }, 60); });
    const api = new DockerApi(target, 20);
    await expect(api.call('GET', '/containers/test/json')).rejects.toThrow(/abort/i);
    await expect(api.call('POST', '/containers/test/start')).resolves.toMatchObject({ status: 204 });
  });
});
