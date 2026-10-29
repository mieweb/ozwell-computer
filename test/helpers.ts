import pino from 'pino';
import { Desktop } from '../src/desktop.js';
import { buildServer } from '../src/server.js';
import { defaults, type Config } from '../src/config.js';
import type { Updater } from '../src/update.js';

export async function makeApp(over: Partial<Config> = {}, token: string | null = 'secret-token', updater: Updater | null = null) {
  const log = pino({ level: 'silent' });
  const config: Config = { ...defaults(), strictResponses: true, authDisabled: token === null, ...over };
  const desktop = new Desktop(config.display, log);
  const app = await buildServer({ config, desktop, token, version: '0.0.0-test', a11y: null, ptyAvailable: false, updater, log });
  await app.ready();
  return { app, desktop, config };
}
