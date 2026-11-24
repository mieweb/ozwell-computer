/**
 * The cookie API and its MCP tools against the real Firefox in the container: cookies set
 * through it reach the sites Firefox loads, and cookies those sites set can be read back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { URL_, auth, api, exec, waitFor } from './helpers.js';

const PORT = 18765;
const SITE = `http://127.0.0.1:${PORT}`;
const LOG = '/tmp/oz-cookie-site.log';
const SCRIPT = '/tmp/oz-cookie-site.js';
// Anchored: matches the server's command line, not the shell running pkill.
const KILL_SITE = `pkill -f '^node ${SCRIPT}'`;

// A site that records the Cookie header of each page request and sets a cookie of its own.
const site = `require('http').createServer((q, r) => {
  if (q.url.startsWith('/page')) require('fs').appendFileSync('${LOG}', q.url + ' ' + (q.headers.cookie || '') + '\\n');
  r.setHeader('set-cookie', 'site_set=from-site; Path=/');
  r.end('ok');
}).listen(${PORT}, '127.0.0.1')`;

const stopFirefox = () => exec('pkill -x firefox-esr; for i in $(seq 100); do pgrep -x firefox-esr >/dev/null || exit 0; sleep 0.1; done; pkill -KILL -x firefox-esr');
// Firefox restores the previous session's tabs, so each run uses its own page paths.
const RUN = Date.now().toString(36);
const open = (path: string) => api('POST', '/api/v1/apps/launch', { command: 'firefox-esr', args: [SITE + path + `?${RUN}`] });
/** The Cookie header Firefox sent for a page. */
const sentFor = (path: string) => waitFor(async () => {
  const key = `${path}?${RUN} `;
  const line = (await exec(`cat ${LOG} 2>/dev/null`)).stdout.split('\n').find((l) => l.startsWith(key));
  return line === undefined ? null : { cookie: line.slice(key.length) };
}, 20000).then((r) => r.cookie);

let client: Client;
let transport: StreamableHTTPClientTransport;
async function tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r: any = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name} failed: ${r.content?.[0]?.text}`);
  return JSON.parse(r.content[0].text);
}

beforeAll(async () => {
  await stopFirefox();
  await exec(`rm -f ${LOG}; ${KILL_SITE}; cat > ${SCRIPT} <<'EOF'\n${site}\nEOF\n(node ${SCRIPT} >/dev/null 2>&1 &)`);
  await waitFor(async () => (await exec(`curl -so /dev/null -w '%{http_code}' ${SITE}/`)).stdout === '200');
  client = new Client({ name: 'oz-browser-tools', version: '1.0.0' });
  transport = new StreamableHTTPClientTransport(new URL(URL_ + '/mcp'), { requestInit: { headers: auth } });
  await client.connect(transport);
});
afterAll(async () => {
  await api('DELETE', '/api/v1/browser/cookies?name=site_set&domain=127.0.0.1').catch(() => undefined);
  await stopFirefox();
  await exec(`${KILL_SITE}; rm -f ${LOG} ${SCRIPT}`);
  await transport?.terminateSession().catch(() => undefined);
  await client?.close();
});

describe('browser cookies', () => {
  it('fail clearly without Firefox, and wait for one that is starting', async () => {
    const r = await api('GET', '/api/v1/browser/cookies');
    expect(r.status).toBe(404);
    expect(r.body.error.reason).toBe('target_unavailable');
    expect((await api('GET', '/api/v1/capabilities')).body.features.browser.available).toBe(false);
    await api('POST', '/api/v1/apps/launch', { command: 'firefox-esr', args: ['about:blank'] });
    const listed = await api('GET', '/api/v1/browser/cookies?domain=127.0.0.1');
    expect(listed.status).toBe(200);
    expect(listed.body.cookies).toBeInstanceOf(Array);
    expect((await api('GET', '/api/v1/capabilities')).body.features.browser).toEqual({ available: true });
  });

  it('HTTP: a cookie set through the API is sent to the site, and the site\'s own cookie can be read back', async () => {
    const set = await api('PUT', '/api/v1/browser/cookies', { name: 'oz_rest', value: 'rest-secret', domain: '127.0.0.1', http_only: true });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ name: 'oz_rest', value: 'rest-secret', domain: '127.0.0.1', host_only: true, path: '/', secure: false, http_only: true, same_site: 'unspecified', expires: null });
    await open('/page-rest-1');
    expect(await sentFor('/page-rest-1')).toContain('oz_rest=rest-secret');

    const sent = (await api('GET', `/api/v1/browser/cookies?url=${encodeURIComponent(SITE + '/')}`)).body.cookies;
    expect(sent.map((c: any) => `${c.name}=${c.value}`)).toEqual(expect.arrayContaining(['oz_rest=rest-secret', 'site_set=from-site']));

    const del = await api('DELETE', '/api/v1/browser/cookies?name=oz_rest&domain=127.0.0.1');
    expect(del.status).toBe(200);
    expect(del.body.deleted.map((c: any) => c.value)).toEqual(['rest-secret']);
    await open('/page-rest-2');
    expect(await sentFor('/page-rest-2')).not.toContain('oz_rest');
  });

  it('MCP: set_cookie, get_cookies and delete_cookie', async () => {
    const c = await tool('set_cookie', { name: 'oz_mcp', value: 'mcp-secret', domain: '127.0.0.1', path: '/page-mcp' });
    expect(c).toMatchObject({ name: 'oz_mcp', value: 'mcp-secret', domain: '127.0.0.1', path: '/page-mcp' });
    await open('/page-mcp/1');
    expect(await sentFor('/page-mcp/1')).toContain('oz_mcp=mcp-secret');
    await open('/page-other');
    expect(await sentFor('/page-other')).not.toContain('oz_mcp');
    // A result passes straight back to set_cookie.
    const [got] = (await tool('get_cookies', { domain: '127.0.0.1', name: 'oz_mcp' })).cookies;
    expect(got).toEqual(c);
    expect(await tool('set_cookie', { ...got, value: 'mcp-renewed' })).toEqual({ ...got, value: 'mcp-renewed' });
    expect((await tool('delete_cookie', { name: 'oz_mcp', domain: '127.0.0.1' })).deleted.map((x: any) => x.value)).toEqual(['mcp-renewed']);
    expect((await tool('get_cookies', { name: 'oz_mcp' })).cookies).toEqual([]);
  });
});
