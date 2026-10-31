// Deployment-only supervisor. A Docker container sharing another container's
// network namespace must restart to follow it after a runtime crash/restart.
import { spawn } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const generationPath = '/run/ozwell-docker/runtime-generation';
const generation = await readFile(generationPath, 'utf8');
const identity = /^([a-f0-9-]{36})\n(net:\[\d+\])\n$/.exec(generation);
if (!identity) throw new Error('Invalid private checkpoint runtime generation');
// Docker may attach us to the previous namespace just before a runtime restart.
// Reading the new generation in that old namespace must never admit requests.
if (await readlink('/proc/self/ns/net') !== identity[2]) process.exit(75);
const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.ts', import.meta.url))], { stdio: 'inherit' });
let stopping = false;
let exitCode;
let killTimer;
let checking = false;
const stop = (code) => {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  clearInterval(watch);
  child.kill('SIGTERM');
  // The provider's independently recorded Docker operations remain recoverable
  // if graceful shutdown cannot finish while the runtime is unavailable.
  killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
};
const watch = setInterval(async () => {
  if (checking || stopping) return;
  checking = true;
  try {
    if (await readFile(generationPath, 'utf8') !== generation) stop(75);
  } catch { stop(75); }
  finally { checking = false; }
}, 500);
child.once('error', () => stop(1));
child.once('close', (code, signal) => {
  clearInterval(watch);
  clearTimeout(killTimer);
  process.exit(exitCode ?? code ?? (signal ? 1 : 0));
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));
