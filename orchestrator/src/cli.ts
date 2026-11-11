#!/usr/bin/env node
// Configuration (environment):
//   PROVIDER_URI         e.g. docker:///var/run/docker.sock or docker://host:2375 (required)
//   ORCHESTRATOR_TOKEN   pre-shared key Ozwell sends as a Bearer token (required unless
//                        ORCHESTRATOR_AUTH_DISABLED=true, for local development only)
//   ORCHESTRATOR_HOST    listen address (default 127.0.0.1)
//   ORCHESTRATOR_PORT    listen port (default 8090)
//   TOOL_CATALOG         path to the ozwell-computer tool catalog (default ../docs/mcp-tools.json)
//   ORCHESTRATOR_MAX_INSTANCES  computers each user may have (default unlimited)
//   COMPUTER_FRAME_ANCESTORS  origins allowed to embed new computers' viewers in an iframe
//                        (passed to them as OZWELL_COMPUTER_FRAME_ANCESTORS)
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / OTEL_EXPORTER_OTLP_LOGS_ENDPOINT  optional OTLP
//                        export (see src/telemetry.ts, preloaded by `npm start`)
//   ORCHESTRATOR_INTERNAL_HOST / ORCHESTRATOR_INTERNAL_PORT  internal listener for vmagent
//                        (/metrics, /sd, /instances/:id/metrics); unset port disables it.
//                        Unauthenticated: never public.
//   ORCHESTRATOR_SD_ADDRESS  host:port vmagent reaches the internal listener at, put in /sd
//                        targets (default the internal host:port; compose: orchestrator:8091)
//   ORCHESTRATOR_OP_TIMEOUT_MS  give up timing a create/start/destroy after this (default 600000)
import { readFileSync } from 'node:fs';
import { providerFromUri } from './providers/index.ts';
import { InstanceClient } from './instance-client.ts';
import { isReady, loadCatalog } from './mcp.ts';
import { buildServer } from './server.ts';
import { instrumentProvider } from './instrument-provider.ts';
import { shutdownTelemetry } from './telemetry.ts';
import { Metrics } from './metrics.ts';
import { buildInternalServer } from './internal-server.ts';
import { OperationTracker } from './operations.ts';

const env = process.env;
const die = (m: string) => { process.stderr.write(`ozwell-computer-orchestrator: ${m}\n`); process.exit(2); };

const uri = env.PROVIDER_URI || die('PROVIDER_URI is required (e.g. docker:///var/run/docker.sock)');
const authDisabled = ['1', 'true', 'yes'].includes((env.ORCHESTRATOR_AUTH_DISABLED ?? '').toLowerCase());
const psk = env.ORCHESTRATOR_TOKEN || (authDisabled ? null : die('ORCHESTRATOR_TOKEN is required (or ORCHESTRATOR_AUTH_DISABLED=true)'));
const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const rawMax = env.ORCHESTRATOR_MAX_INSTANCES;
if (rawMax !== undefined && !/^\d+$/.test(rawMax)) die('ORCHESTRATOR_MAX_INSTANCES must be a non-negative integer');
const maxInstances = rawMax === undefined ? undefined : Number(rawMax);
const rawInternal = env.ORCHESTRATOR_INTERNAL_PORT;
if (rawInternal && !/^\d+$/.test(rawInternal)) die('ORCHESTRATOR_INTERNAL_PORT must be a port number');
const rawOpTimeout = env.ORCHESTRATOR_OP_TIMEOUT_MS;
if (rawOpTimeout && !/^\d+$/.test(rawOpTimeout)) die('ORCHESTRATOR_OP_TIMEOUT_MS must be a number of milliseconds');
const logger = { level: env.LOG_LEVEL || 'info', redact: ['req.headers.authorization'] };
const metrics = new Metrics();

const provider = instrumentProvider(await providerFromUri(uri as string, env), metrics.onProviderCall);
const operations = new OperationTracker({
  provider: provider.scheme, metrics, probe: (id) => isReady(provider, id),
  timeoutMs: rawOpTimeout ? Number(rawOpTimeout) : undefined,
});
operations.start();
const catalog = loadCatalog(env.TOOL_CATALOG || new URL('../../docs/mcp-tools.json', import.meta.url));
const app = await buildServer({
  provider, catalog, client: new InstanceClient(), version, psk: psk as string | null, maxInstances, metrics, operations, logger,
});
app.log.info({ provider: provider.scheme, tools: catalog.length, maxInstances: maxInstances ?? 'unlimited' }, 'orchestrator configured');
if (authDisabled) app.log.warn('AUTHENTICATION IS DISABLED: any caller can act as any X-Ozwell-User-Id');
await app.listen({ host: env.ORCHESTRATOR_HOST || '127.0.0.1', port: Number(env.ORCHESTRATOR_PORT || 8090) });
const internalHost = env.ORCHESTRATOR_INTERNAL_HOST || '127.0.0.1';
const sdAddress = env.ORCHESTRATOR_SD_ADDRESS || `${['0.0.0.0', '::'].includes(internalHost) ? '127.0.0.1' : internalHost}:${rawInternal}`;
const internal = rawInternal ? await buildInternalServer({ metrics, provider, sdAddress, logger: { ...logger, level: env.LOG_LEVEL || 'warn' } }) : null;
await internal?.listen({ host: internalHost, port: Number(rawInternal) });

const stop = () => Promise.all([app.close(), internal?.close()]).then(shutdownTelemetry).then(() => process.exit(0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { void stop(); });
