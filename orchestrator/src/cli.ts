#!/usr/bin/env node
// Configuration (environment):
//   PROVIDER_URI         e.g. docker:///var/run/docker.sock or docker://host:2375 (required)
//   ORCHESTRATOR_TOKEN   pre-shared key Ozwell sends as a Bearer token (required unless
//                        ORCHESTRATOR_AUTH_DISABLED=true, for local development only)
//   ORCHESTRATOR_HOST    listen address (default 127.0.0.1)
//   ORCHESTRATOR_PORT    listen port (default 8090)
//   TOOL_CATALOG         path to the ozwell-computer tool catalog (default ../docs/mcp-tools.json)
import { readFileSync } from 'node:fs';
import { providerFromUri } from './providers/index.ts';
import { InstanceClient } from './instance-client.ts';
import { loadCatalog } from './mcp.ts';
import { buildServer } from './server.ts';

const env = process.env;
const die = (m: string) => { process.stderr.write(`ozwell-computer-orchestrator: ${m}\n`); process.exit(2); };

const uri = env.PROVIDER_URI || die('PROVIDER_URI is required (e.g. docker:///var/run/docker.sock)');
const authDisabled = ['1', 'true', 'yes'].includes((env.ORCHESTRATOR_AUTH_DISABLED ?? '').toLowerCase());
const psk = env.ORCHESTRATOR_TOKEN || (authDisabled ? null : die('ORCHESTRATOR_TOKEN is required (or ORCHESTRATOR_AUTH_DISABLED=true)'));
const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const provider = await providerFromUri(uri as string, env);
const catalog = loadCatalog(env.TOOL_CATALOG || new URL('../../docs/mcp-tools.json', import.meta.url));
const app = await buildServer({
  provider, catalog, client: new InstanceClient(), version, psk: psk as string | null,
  logger: { level: env.LOG_LEVEL || 'info', redact: ['req.headers.authorization'] },
});
app.log.info({ provider: provider.scheme, tools: catalog.length }, 'orchestrator configured');
if (authDisabled) app.log.warn('AUTHENTICATION IS DISABLED: any caller can act as any X-Ozwell-User-Id');
await app.listen({ host: env.ORCHESTRATOR_HOST || '127.0.0.1', port: Number(env.ORCHESTRATOR_PORT || 8090) });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { void app.close().then(() => process.exit(0)); });
