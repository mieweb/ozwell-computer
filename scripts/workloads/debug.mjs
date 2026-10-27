import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
// Step-through check for the EHR workload: runs one agent cycle and saves a screenshot after
// every step (and on errors) to $OUT (default /tmp/ehr-steps). Usage:
//   OZ_WEBCHART_USER=... OZ_WEBCHART_PASS=... node scripts/workloads/debug.mjs
import { mkdirSync } from 'node:fs';
import { waitReady } from '../compose.mjs';
import { ehrAgent } from './ehr.mjs';
const OUT = process.env.OUT || '/tmp/ehr-steps';
mkdirSync(OUT, { recursive: true });
const { url, token } = await waitReady();
const auth = { authorization: 'Bearer ' + token };
const client = new Client({ name: 'ehr-debug', version: '1' });
const transport = new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: auth } });
await client.connect(transport);
const stop = { flag: false };
let k = 0;
const snap = async (name) => {
  const b = Buffer.from(await (await fetch(url + '/api/v1/screenshot?max_dimension=1280', { headers: auth })).arrayBuffer());
  writeFileSync(`${OUT}/step-${String(++k).padStart(2, '0')}-${name}.png`, b);
};
const call = async (name, args = {}) => {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) { await snap(`ERR-${name}`); throw new Error(`${name}: ${r.content?.[0]?.text}`); }
  if (process.env.V) console.log(`  ${name} ${JSON.stringify(args).slice(0, 90)} ${Date.now() - t}ms`);
  return r;
};
try {
  await ehrAgent({
    call, stop, think: async () => {}, log: console.log,
    countError: async (w, e) => { console.log('ERROR', w, e.message); await snap('ERROR'); stop.flag = true; },
    mark: async (name) => { console.log('step ok:', name); await snap(name.replace('ehr.', '')); if (name === 'ehr.task_list') stop.flag = true; },
  }, 0);
} finally {
  await transport.terminateSession().catch(() => {});
  await client.close();
}
