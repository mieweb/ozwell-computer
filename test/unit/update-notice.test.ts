import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeApp } from '../helpers.js';
import { updateNotice } from '../../src/mcp/server.js';
import type { UpdateStatus, Updater } from '../../src/update.js';

const auth = { authorization: 'Bearer secret-token' };
const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  supported: true, url: 'https://example.com/Packages', current: '1.0.0', latest: '1.1.0', available: true,
  checked_at: '2026-10-29T00:00:00Z', error: null, upgrade: { state: 'idle', at: null, log: '' }, ...over,
});

describe('updateNotice', () => {
  it('announces an available update until it is being installed', () => {
    expect(updateNotice(status())).toMatch(/^Update available: ozwell-computer 1\.1\.0 \(installed: 1\.0\.0\)\. Call update_computer/);
    expect(updateNotice(null)).toBeNull();
    expect(updateNotice(status({ available: false }))).toBeNull();
    expect(updateNotice(status({ supported: false }))).toBeNull();
    for (const state of ['requested', 'running'] as const) expect(updateNotice(status({ upgrade: { state, at: null, log: '' } }))).toBeNull();
  });
});

describe('MCP update notice and update_computer', () => {
  let app: FastifyInstance;
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let current = status();
  let applied = 0;
  const updater = {
    cached: () => current,
    status: async () => current,
    apply: async () => { applied++; current = status({ upgrade: { state: 'requested', at: null, log: '' } }); return current; },
  } as unknown as Updater;
  const texts = (r: any): string[] => r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text);

  beforeAll(async () => {
    ({ app } = await makeApp({}, 'secret-token', updater));
    await app.listen({ port: 0, host: '127.0.0.1' });
    client = new Client({ name: 'update-notice', version: '1' });
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp`), { requestInit: { headers: auth } });
    await client.connect(transport);
  });
  afterAll(async () => {
    await transport.terminateSession();
    await client.close();
    await app.close();
  });

  it('appends the notice to every tool result, errors included', async () => {
    const ok = await client.callTool({ name: 'read_file', arguments: { path: '/etc/hostname' } });
    expect(texts(ok).at(-1)).toMatch(/^Update available/);
    const failed = await client.callTool({ name: 'list_windows', arguments: {} });
    expect(failed.isError).toBe(true);
    expect(texts(failed).at(-1)).toMatch(/^Update available/);
  });

  it('update_computer requests the upgrade, after which the notice stops', async () => {
    const r = await client.callTool({ name: 'update_computer', arguments: {} });
    expect(JSON.parse(texts(r)[0])).toMatchObject({ upgrade: 'requested', current: '1.0.0', latest: '1.1.0' });
    expect(applied).toBe(1);
    expect(texts(await client.callTool({ name: 'read_file', arguments: { path: '/etc/hostname' } })).join('\n')).not.toMatch(/Update available/);
  });

  it('update_computer does nothing when already up to date', async () => {
    current = status({ available: false, latest: '1.0.0' });
    const r = await client.callTool({ name: 'update_computer', arguments: {} });
    expect(JSON.parse(texts(r)[0])).toMatchObject({ upgrade: 'none', message: 'Already up to date.' });
    expect(applied).toBe(1);
  });
});
