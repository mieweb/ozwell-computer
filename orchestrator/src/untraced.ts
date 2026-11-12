// Background polling (log puller, readiness watcher, vmagent's discovery and scrapes) would
// otherwise create a root trace every few seconds per computer and bury the tool-call and
// operation traces. Its timings are metrics instead.
import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';

export const untraced = <T>(fn: () => T): T => context.with(suppressTracing(context.active()), fn);
