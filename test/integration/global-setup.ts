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
}
