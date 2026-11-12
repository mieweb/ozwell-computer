// OpenTelemetry bootstrap. Loaded before anything else with `node --import ./src/telemetry.ts`
// so the instrumentations can patch fastify, pino, undici and http as they load.
//
// Opt-in: with neither OTEL_EXPORTER_OTLP_TRACES_ENDPOINT nor OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
// set, nothing is started and the orchestrator behaves exactly as without this file. (The
// SDK alone would default to OTLP exporters on localhost, so processors are always explicit.)
//
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT  VictoriaTraces OTLP/HTTP traces endpoint
//   OTEL_EXPORTER_OTLP_LOGS_ENDPOINT    VictoriaLogs OTLP/HTTP logs endpoint (protobuf: VictoriaLogs takes no JSON)
//   OTEL_SERVICE_NAME                   default ozwell-computer-orchestrator
//   OTEL_TRACES_SAMPLER / _ARG          standard; the SDK default samples 100%
import { register as registerAsyncLoader } from 'node:module';
import { register as registerSyncLoader, supportsSyncHooks } from 'import-in-the-middle/register-hooks.mjs';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace';
import { BatchLogRecordProcessor, type LogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { FastifyOtelInstrumentation } from '@fastify/otel';

export interface TelemetryConfig {
  tracesEndpoint?: string;
  logsEndpoint?: string;
  serviceName: string;
}

export function telemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  return {
    tracesEndpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || undefined,
    logsEndpoint: env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || undefined,
    serviceName: env.OTEL_SERVICE_NAME || 'ozwell-computer-orchestrator',
  };
}

export const telemetryEnabled = (c: TelemetryConfig) => Boolean(c.tracesEndpoint || c.logsEndpoint);

/** Build (not start) the SDK, or null when telemetry is disabled. */
export function buildSdk(c: TelemetryConfig): NodeSDK | null {
  if (!telemetryEnabled(c)) return null;
  const spanProcessors: SpanProcessor[] = c.tracesEndpoint
    ? [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: c.tracesEndpoint }) })] : [];
  const logRecordProcessors: LogRecordProcessor[] = c.logsEndpoint
    ? [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: c.logsEndpoint }) })] : [];
  return new NodeSDK({
    serviceName: c.serviceName,
    spanProcessors,
    logRecordProcessors,
    metricReaders: [], // metrics are pulled by vmagent from /metrics, never pushed
    instrumentations: [
      new HttpInstrumentation(), // the docker socket and other node:http clients
      new UndiciInstrumentation(), // fetch: opensource-server API, instances
      // trace_id/span_id in every pino line; records also go over OTLP when logs are on.
      new PinoInstrumentation({ disableLogSending: !c.logsEndpoint }),
      new FastifyOtelInstrumentation({ registerOnInitialization: true, ignorePaths: '/health' }),
    ],
  });
}

const config = telemetryConfig();
const sdk = buildSdk(config);
if (sdk) {
  // ESM: let the instrumentations hook modules loaded with `import`. In-thread hooks where
  // Node supports them (module.register() is deprecated on Node 26).
  if (supportsSyncHooks()) registerSyncLoader();
  else registerAsyncLoader('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  sdk.start();
  process.once('beforeExit', () => { void shutdownTelemetry(); });
}

/** Flush and stop exporters (no-op when disabled). cli.ts awaits this before exiting. */
export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown().catch(() => {});
}
