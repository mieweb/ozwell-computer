import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeApp } from '../helpers.js';

const TOKEN = 'secret-token';
const auth = { authorization: `Bearer ${TOKEN}` };

describe('OZWELL_DESKTOP_EXEC=false', () => {
  let app: FastifyInstance;
  let base: string;
  beforeAll(async () => {
    ({ app } = await makeApp({ exec: false }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  afterAll(async () => { await app.close(); });

  it.each([
    ['POST', '/api/v1/exec', { cmd: 'id' }],
    ['POST', '/api/v1/apps/launch', { command: 'xterm' }],
    ['POST', '/api/v1/open', { target: '/tmp' }],
    ['GET', '/api/v1/fs?path=/tmp', undefined],
    ['GET', '/api/v1/fs/content?path=/etc/hostname', undefined],
    ['PUT', '/api/v1/fs/content?path=/tmp/x', 'data'],
    ['DELETE', '/api/v1/fs?path=/tmp/x', undefined],
    ['POST', '/api/v1/fs/move', { from: '/tmp/a', to: '/tmp/b' }],
    ['POST', '/api/v1/fs/mkdir', { path: '/tmp/a' }],
    ['POST', '/api/v1/fs/sign', { path: '/tmp/a' }],
  ])('%s %s → 403 permission_denied', async (method, url, payload) => {
    const r = await app.inject({
      method: method as any, url, headers: { ...auth, ...(typeof payload === 'string' ? { 'content-type': 'application/octet-stream' } : {}) },
      ...(payload === undefined ? {} : typeof payload === 'string' ? { payload } : { payload: payload as object }),
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.reason).toBe('permission_denied');
  });

  it('capabilities report exec as unavailable', async () => {
    const c = (await app.inject({ url: '/api/v1/capabilities', headers: auth })).json();
    expect(c.features.exec).toMatchObject({ available: false });
  });

  it('MCP does not offer run_command, read_file or write_file, and launch_app is refused', async () => {
    const client = new Client({ name: 'restricted', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: auth } });
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['run_command', 'read_file', 'write_file']) expect(names).not.toContain(n);
    expect(names).toContain('screenshot');
    const r: any = await client.callTool({ name: 'launch_app', arguments: { command: 'xterm' } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error.reason).toBe('permission_denied');
    await transport.terminateSession();
    await client.close();
  });
});
