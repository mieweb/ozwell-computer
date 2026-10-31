// One operation per Docker worker. Docker retains its exit status as the durable
// completion receipt even if the orchestrator disconnects or is killed.
import { request } from 'node:http';
// Exit 64 is reserved for a fully received HTTP failure. Runtime/startup failures
// (including Node's usual exit 1) are never interpreted as daemon completion.
process.exitCode = 2;
const crash = (error) => { process.stderr.write(`${error?.message ?? error}\n`); process.exit(2); };
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
const { TARGET_ID: target, CHECKPOINT_ID: checkpoint, OPERATION: operation } = process.env;
if (!/^[a-f0-9]{64}$/.test(target ?? '') || !/^ozc-[a-f0-9]{16}$/.test(checkpoint ?? '') || !['save', 'restore'].includes(operation ?? '')) process.exit(2);
const save = operation === 'save';
const body = save ? JSON.stringify({ CheckpointID: checkpoint, Exit: true }) : undefined;
const path = `/containers/${target}/${save ? 'checkpoints' : `start?checkpoint=${checkpoint}`}`;
let finished = false;
const ambiguous = (error) => { if (!finished) { finished = true; process.stderr.write(`${error?.message ?? 'ambiguous Docker request failure'}\n`); process.exitCode = 2; } };
const req = request({ socketPath: process.env.ENGINE_SOCKET ?? '/engine.sock', method: 'POST', path, headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} }, (res) => {
  const chunks = [];
  res.on('data', (chunk) => { if (chunks.reduce((n, b) => n + b.length, 0) < 65536) chunks.push(chunk); });
  res.on('aborted', () => ambiguous(new Error('Docker response aborted')));
  res.on('error', ambiguous);
  res.on('end', () => {
    if (finished) return;
    finished = true;
    const success = res.statusCode === (save ? 201 : 204);
    if (!success) process.stderr.write(`Docker HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}\n`);
    process.exitCode = success ? 0 : 64;
  });
});
// Deliberately no request timeout: interrupting this client cannot cancel the
// daemon's checkpoint job. Callers bound their wait without killing the worker.
req.on('error', ambiguous);
req.end(body);
