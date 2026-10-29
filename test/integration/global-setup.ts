/**
 * Integration-suite setup: use the compose dev container.
 *  - not running → `docker compose up -d` (builds the image only if missing)
 *  - running     → restart just the server so it runs the freshly built ./dist
 * The container is left running afterwards. Set OZ_URL (+ OZ_TOKEN) to test any
 * other server instead.
 */
import type { TestProject } from 'vitest/node';
// @ts-expect-error plain ESM helper without type declarations
import { isRunning, restartServer, up, waitReady } from '../../scripts/compose.mjs';

declare module 'vitest' {
  export interface ProvidedContext { ozUrl: string; ozToken: string }
}

const log = (m: string) => process.stderr.write(`[integration] ${m}\n`);

export default async function setup(project: TestProject) {
  if (process.env.OZ_URL) {
    log(`using ${process.env.OZ_URL}`);
    project.provide('ozUrl', process.env.OZ_URL);
    project.provide('ozToken', process.env.OZ_TOKEN ?? 'testtoken');
    return;
  }
  if (isRunning()) {
    log('compose service is running; restarting the server to pick up ./dist');
    restartServer();
  } else {
    log('starting compose service (docker compose up -d)…');
    up();
  }
  const { url, token } = await waitReady();
  log(`ready at ${url}`);
  project.provide('ozUrl', url);
  project.provide('ozToken', token);
  return async () => {
    if (isFilteredRun()) { log('filtered run: skipping the API/MCP coverage check'); return; }
    await checkCoverage(url, token);
  };
}

/** True when only some files/tests were selected, so full coverage isn't expected. */
function isFilteredRun(): boolean {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-t' || a.startsWith('--testNamePattern') || a.startsWith('-t=')) return true;
    if (a === '--project' || a === '--config' || a === '-c') { i++; continue; }
    if (!a.startsWith('-') && a !== 'run' && a !== 'watch') return true; // file filter
  }
  return false;
}

/**
 * Fail the run unless every documented route returned a 2xx at least once and every MCP
 * tool was called. Uses the server's own Prometheus counters, which start at zero when
 * setup restarts the server (with OZ_URL they may include earlier traffic).
 */
async function checkCoverage(url: string, token: string) {
  const text = await (await fetch(`${url}/api/v1/metrics`, { headers: { authorization: `Bearer ${token}` } })).text();
  const hits = new Set<string>();
  const tools = new Set<string>();
  for (const line of text.split('\n')) {
    let mm = /^ozwell_http_request_duration_seconds_count\{(.*)\} (\d+)/.exec(line);
    if (mm && Number(mm[2]) > 0) {
      const l = Object.fromEntries([...mm[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
      if (/^2\d\d$/.test(l.status)) hits.add(`${l.method} ${l.route}`);
      continue;
    }
    mm = /^ozwell_mcp_tool_calls_total\{(.*)\} (\d+)/.exec(line);
    if (mm && Number(mm[2]) > 0) {
      const tool = /tool="([^"]*)"/.exec(mm[1])?.[1];
      if (tool) tools.add(tool);
    }
  }

  const headers = { authorization: `Bearer ${token}` };
  const spec = await (await fetch(`${url}/api/docs/json`, { headers })).json();
  // With update checks off (the compose default), apply can only answer 501.
  const update = await (await fetch(`${url}/api/v1/update`, { headers })).json();
  const unsupported = new Set(update.supported ? [] : ['POST /api/v1/update/apply']);
  const missingRoutes: string[] = [];
  for (const [path, ops] of Object.entries<Record<string, unknown>>(spec.paths)) {
    for (const method of Object.keys(ops)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
      const key = `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`;
      if (!hits.has(key) && !unsupported.has(key)) missingRoutes.push(key);
    }
  }
  const allTools = await listMcpTools(url, token);
  const missingTools = allTools.filter((t) => !tools.has(t));

  if (missingRoutes.length || missingTools.length) {
    throw new Error(
      'API/MCP coverage check failed: these were never exercised successfully by the integration suite\n' +
      (missingRoutes.length ? `  routes (no 2xx response): ${missingRoutes.join(', ')}\n` : '') +
      (missingTools.length ? `  MCP tools (never called): ${missingTools.join(', ')}\n` : ''),
    );
  }
  log(`coverage: all ${Object.keys(spec.paths).length} documented paths and ${allTools.length} MCP tools exercised`);
}

/**
 * tools/list over plain HTTP. (The SDK client opens a background SSE stream whose abort
 * on close surfaces as an unhandled error in this teardown, so it's avoided here.)
 */
async function listMcpTools(url: string, token: string): Promise<string[]> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
  };
  const rpc = async (body: object) => {
    const r = await fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await r.text();
    // The reply is either JSON or a single SSE event carrying JSON.
    const json = text.trimStart().startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
    return { res: r, msg: json ? JSON.parse(json) : null };
  };
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'coverage-check', version: '1' } } });
  const sid = init.res.headers.get('mcp-session-id');
  if (!sid) throw new Error('coverage check: MCP initialize returned no session id');
  headers['mcp-session-id'] = sid;
  headers['mcp-protocol-version'] = init.msg?.result?.protocolVersion ?? '2025-06-18';
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await fetch(`${url}/mcp`, { method: 'DELETE', headers }).catch(() => undefined);
  return (list.msg?.result?.tools ?? []).map((t: { name: string }) => t.name);
}
