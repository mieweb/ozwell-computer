// GET /api/v1/traces against the running computer: MCP tool calls and API requests record
// spans that continue the caller's traceparent (issue #64).
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { URL_, api, auth, waitFor } from './helpers.js';

const spansOf = (body: any): any[] => body.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans));

/** Every span buffered after `cursor`, paging until the end. */
async function spansAfter(cursor?: string): Promise<{ spans: any[]; cursor: string }> {
  const spans: any[] = [];
  for (;;) {
    const r = await fetch(`${URL_}/api/v1/traces${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: auth });
    expect(r.status).toBe(200);
    spans.push(...spansOf(await r.json()));
    cursor = r.headers.get('ozwell-trace-cursor')!;
    expect(cursor).toBeTruthy();
    if (r.headers.get('ozwell-trace-more') !== '1') return { spans, cursor };
  }
}

describe('traces', () => {
  it('nests an MCP screenshot\'s capture and encode spans under the caller\'s span', async () => {
    const { cursor } = await spansAfter();
    const trace = randomBytes(16).toString('hex');
    const parent = randomBytes(8).toString('hex');
    const client = new Client({ name: 'oz-traces', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(URL_ + '/mcp'), { requestInit: { headers: auth } }));
    try {
      await client.callTool({ name: 'screenshot', arguments: { max_dimension: 256 }, _meta: { traceparent: `00-${trace}-${parent}-01` } });
    } finally { await client.close(); }
    const spans = await waitFor(async () => {
      const got = (await spansAfter(cursor)).spans.filter((s) => s.traceId === trace);
      return got.some((s) => s.name === 'screenshot.encode') && got;
    });
    const by = (n: string) => spans.find((s) => s.name === n);
    expect(by('mcp.tool screenshot')).toMatchObject({ parentSpanId: parent });
    expect(by('screenshot')).toMatchObject({ parentSpanId: by('mcp.tool screenshot').spanId });
    expect(by('screenshot.capture')).toMatchObject({ parentSpanId: by('screenshot').spanId });
    expect(by('screenshot.encode')).toMatchObject({ parentSpanId: by('screenshot').spanId });
  });

  it('traces API requests with a traceparent header, and pages with the cursor', async () => {
    const { cursor } = await spansAfter();
    const trace = randomBytes(16).toString('hex');
    await api('POST', '/api/v1/input/pointer', { action: 'move', x: 5, y: 5 }, { traceparent: `00-${trace}-${'2'.repeat(16)}-01` });
    const { spans, cursor: next } = await spansAfter(cursor);
    const req = spans.find((s) => s.traceId === trace && s.name === 'POST /api/v1/input/pointer');
    expect(req).toMatchObject({ kind: 2, parentSpanId: '2'.repeat(16) });
    expect(spans.find((s) => s.traceId === trace && s.name === 'input.pointer')).toMatchObject({ parentSpanId: req.spanId });
    expect((await spansAfter(next)).spans.filter((s) => s.traceId === trace)).toEqual([]);
  });
});
