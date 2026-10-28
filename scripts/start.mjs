// `npm start`: run the server on this host (attaching to $DISPLAY) and open the viewer.
// When no token is configured, reuse the compose service's generated token if it is
// running, so the same link works for both.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT, generatedToken, isRunning, url } from './compose.mjs';

const tokenFile = process.env.OZWELL_COMPUTER_TOKEN_FILE || join(homedir(), '.config', 'ozwell-computer', 'token');

if (!process.env.OZWELL_COMPUTER_TOKEN) {
  let shared = null;
  try { if (isRunning()) shared = generatedToken(); } catch { /* no docker: fine */ }
  if (shared) {
    let current = null;
    try { current = readFileSync(tokenFile, 'utf8').trim(); } catch { /* none yet */ }
    if (current !== shared) {
      mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
      writeFileSync(tokenFile, shared + '\n', { mode: 0o600 });
      process.stderr.write(`[start] using the compose service's token (saved to ${tokenFile})\n`);
    }
  }
}

// Don't collide with the compose service on the default port.
const args = process.argv.slice(2);
const portGiven = process.env.OZWELL_COMPUTER_PORT || args.some((a) => a === '--port' || a.startsWith('--port='));
if (!portGiven) {
  let composePort = null;
  try { if (isRunning()) composePort = new URL(url()).port; } catch { /* no docker */ }
  if (composePort === '8080') {
    args.push('--port', '8081');
    process.stderr.write('[start] the compose service is on port 8080; using 8081\n');
  }
}

const child = spawn(process.execPath, [join(ROOT, 'dist/cli.js'), '--open', ...args], {
  stdio: 'inherit',
  env: { ...process.env, OZWELL_COMPUTER_TOKEN_FILE: tokenFile },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, sig) => process.exit(sig ? 1 : (code ?? 0)));
