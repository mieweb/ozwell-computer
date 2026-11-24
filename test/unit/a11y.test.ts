import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { A11y, type A11yNode, type FindOptions } from '../../src/a11y/atspi.js';
import { defaults } from '../../src/config.js';
import { Desktop } from '../../src/desktop.js';
import { buildServer } from '../../src/server.js';

const log = pino({ level: 'silent' });
const auth = { authorization: 'Bearer a11y-test-token' };

// Synthetic AT-SPI results: no live desktop or application data is needed to
// reproduce the empty-name and icon-description failures.
function fixture() {
  const a11y = new A11y('on', log);
  const nodes: A11yNode[] = [
    { role: 'link', native_role: 'link', name: 'Encounters', description: 'Open encounter list', value: null, states: ['visible', 'showing'], actions: ['jump'] },
    { role: 'text_field', native_role: 'entry', name: 'Notes', description: '', value: 'Draft note', states: ['visible', 'editable'], actions: ['set_value', 'focus'] },
    { role: 'button', native_role: 'push button', name: '\uf040', description: 'Edit section', value: null, states: ['visible', 'showing'], actions: ['press'] },
    { role: 'text_field', native_role: 'entry', name: '', description: 'Optional comment', value: '', states: ['visible', 'editable'], actions: ['set_value', 'focus'] },
  ].map((n, i) => ({ ...n, element_id: `s1.${i + 1}`, parent_id: null, depth: 0, bounds: null, app: 'Fixture' }));
  const walk = vi.spyOn(a11y as any, 'walk').mockImplementation(async (...args: any[]) => ({
    snapshot_id: 's1', truncated: false, nodes: nodes.filter(args[1]),
  }));
  return { a11y, walk };
}

describe('accessibility search', () => {
  it.each([
    { name_contains: 'encounter' },
    { name: '', name_contains: 'encounter' },
    { role: 'link', name: '', name_contains: 'ENCOUNTER', description: '', description_contains: '', value_contains: '', states: [] },
  ])('finds named links with empty placeholder filters: %j', async (query) => {
    const { a11y } = fixture();
    const r = await a11y.find(query);
    expect(r.total).toBe(1);
    expect(r.matches[0].name).toBe('Encounters');
  });

  it('does not restrict role-only searches to unnamed controls', async () => {
    const { a11y } = fixture();
    const r = await a11y.find({ role: 'text_field', name: '', states: ['editable'] });
    expect(r.matches.map((n) => n.name)).toEqual(['Notes', '']);
  });

  it('supports explicit unnamed searches without making false a constraint', async () => {
    const { a11y } = fixture();
    expect((await a11y.find({ name_empty: true })).matches.map((n) => n.name)).toEqual(['']);
    expect((await a11y.find({ role: 'text_field', name_empty: false })).total).toBe(2);
    expect((await a11y.find({ name_empty: true, name_contains: 'note' })).total).toBe(0);
    expect((await a11y.find({ name_empty: true, name: 'Notes' })).total).toBe(0);
  });

  it('matches icon descriptions exactly or by case-insensitive substring', async () => {
    const { a11y } = fixture();
    for (const query of [{ description: 'Edit section' }, { description: '', description_contains: 'EDIT' }]) {
      expect((await a11y.find(query)).matches.map((n) => n.name)).toEqual(['\uf040']);
    }
    expect((await a11y.find({ description: 'edit section' })).total).toBe(0);
    expect((await a11y.find({ description: 'Edit section', description_contains: 'missing' })).total).toBe(0);
    expect((await a11y.find({ role: 'link', description_contains: 'Edit' })).total).toBe(0);
  });

  it('preserves exact names, native roles, combined filters and window scoping', async () => {
    const { a11y, walk } = fixture();
    const query: FindOptions = { window: '0x123', role: 'entry', name: 'Notes', name_contains: 'NOTE', value_contains: 'DRAFT', states: ['editable', 'visible'] };
    expect((await a11y.find(query)).matches.map((n) => n.name)).toEqual(['Notes']);
    expect(walk).toHaveBeenCalledWith(expect.objectContaining({ window: '0x123' }), expect.any(Function));
    expect((await a11y.find({ ...query, name: 'notes' })).total).toBe(0);
    expect((await a11y.find({ ...query, value_contains: 'missing' })).total).toBe(0);
    expect((await a11y.find({ ...query, states: ['focused'] })).total).toBe(0);
  });

  it('retains the total when limiting returned matches', async () => {
    const { a11y } = fixture();
    const r = await a11y.find({ role: 'text_field', name: '', max_results: 1 });
    expect(r.total).toBe(2);
    expect(r.matches).toHaveLength(1);
  });
});

describe('accessibility HTTP and MCP contracts', () => {
  let app: FastifyInstance;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeAll(async () => {
    const { a11y } = fixture();
    const config = { ...defaults(), strictResponses: true };
    const desktop = new Desktop(config.display, log);
    app = await buildServer({ config, desktop, token: 'a11y-test-token', version: 'test', a11y, ptyAvailable: false, updater: null, browser: null, log });
    await app.listen({ port: 0, host: '127.0.0.1' });
    client = new Client({ name: 'a11y-test', version: '1' });
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp`), { requestInit: { headers: auth } });
    await client.connect(transport);
  });
  afterAll(async () => {
    await transport?.terminateSession();
    await client?.close();
    await app?.close();
  });

  async function tool(name: string, args: Record<string, unknown>) {
    const r: any = await client.callTool({ name, arguments: args });
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content.find((c: any) => c.type === 'text').text);
  }

  it('accepts the new filters through both public schemas', async () => {
    for (const query of [
      { name: '', name_contains: 'encounter' },
      { name_empty: true, description: 'Optional comment' },
      { description: '', description_contains: 'EDIT' },
    ]) {
      const http = await app.inject({ method: 'POST', url: '/api/v1/a11y/find', headers: auth, payload: query });
      expect(http.statusCode).toBe(200);
      expect(http.json().total).toBe(1);
      expect((await tool('find_element', query)).matches).toEqual(http.json().matches);
    }
  });

  it('keeps nonempty descriptions in MCP trees but omits empty ones', async () => {
    const r = await tool('get_ui_tree', {});
    expect(r.nodes.find((n: A11yNode) => n.name === '\uf040').description).toBe('Edit section');
    expect(r.nodes.find((n: A11yNode) => n.name === 'Notes')).not.toHaveProperty('description');
    expect(r.nodes.every((n: A11yNode) => !('app' in n))).toBe(true);
  });
});
