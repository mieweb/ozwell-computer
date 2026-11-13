// Run by smoke.sh inside the orchestrator container (the backends publish no ports).
// Sends one traced request to the orchestrator, then waits for its trace in VictoriaTraces,
// the orchestrator's metrics in VictoriaMetrics, its log line in VictoriaLogs, and a journal
// entry sent to ORCHESTRATOR_LOG_SHIP_URL (the instance log path).
import { randomBytes } from 'node:crypto';

const trace = randomBytes(16).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

async function waitFor(what, check, secs = 90) {
  const end = Date.now() + secs * 1000;
  for (;;) {
    try { if (await check()) { console.log(`ok: ${what}`); return; } } catch { /* not yet */ }
    if (Date.now() > end) fail(`no ${what} after ${secs}s`);
    await sleep(3000);
  }
}

const r = await fetch('http://127.0.0.1:8090/mcp', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.ORCHESTRATOR_TOKEN}`, 'x-ozwell-user-id': 'smoke-test',
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    traceparent: `00-${trace}-00f067aa0ba902b7-01`,
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
await r.body?.cancel();
if (r.status !== 200) fail(`POST /mcp answered ${r.status}`);
console.log(`sent request with trace ${trace}`);

await waitFor('trace in VictoriaTraces', async () =>
  (await (await fetch(`http://victoriatraces:10428/select/jaeger/api/traces/${trace}`)).text()).includes(`"traceID":"${trace}"`));
await waitFor('orchestrator metrics in VictoriaMetrics', async () =>
  (await (await fetch('http://victoriametrics:8428/api/v1/query?query=' + encodeURIComponent('up{job="orchestrator"}==1'))).json()).data.result.length > 0);
await waitFor('orchestrator log line in VictoriaLogs', async () =>
  (await (await fetch('http://victorialogs:9428/select/logsql/query?query=' + encodeURIComponent(`trace_id:="${trace}"`))).text()).includes(trace));
// The instance log path: one journal entry to ORCHESTRATOR_LOG_SHIP_URL, as the puller sends it.
const ship = process.env.ORCHESTRATOR_LOG_SHIP_URL;
if (!ship) fail('ORCHESTRATOR_LOG_SHIP_URL is not set');
const marker = `smoke-journal-${trace}`;
const shipped = await fetch(ship, {
  method: 'POST', headers: { 'content-type': 'application/vnd.fdo.journal' },
  body: `__REALTIME_TIMESTAMP=${Date.now() * 1000}\nMESSAGE=${marker}\nOZWELL_INSTANCE_ID=smoke-test\n\n`,
});
await shipped.body?.cancel();
if (!shipped.ok) fail(`${ship} answered ${shipped.status}`);
await waitFor('journal entry in VictoriaLogs', async () =>
  (await (await fetch('http://victorialogs:9428/select/logsql/query?query=' + encodeURIComponent(`"${marker}"`))).text()).includes(marker));
console.log('smoke test passed');
