// PROVIDER_URI dispatch: the scheme picks a provider; the rest of the URI (and the
// environment) is handed to that provider to interpret.
import type { Provider, ProviderFactory } from './types.ts';
import { dockerProvider } from './docker.ts';
import { opensourceServerProvider } from './opensource-server.ts';

const registry = new Map<string, ProviderFactory>([
  ['docker', dockerProvider],
  ['opensource-server', opensourceServerProvider],
]);

/** Register an additional provider (e.g. from a plugin or a test). */
export function registerProvider(scheme: string, factory: ProviderFactory) {
  registry.set(scheme.toLowerCase(), factory);
}

export async function providerFromUri(uri: string, env: NodeJS.ProcessEnv = process.env): Promise<Provider> {
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw new Error(`PROVIDER_URI is not a URI: ${uri}`); }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  const factory = registry.get(scheme);
  if (!factory) throw new Error(`no provider for scheme "${scheme}" (known: ${[...registry.keys()].join(', ')})`);
  return factory(parsed, env);
}
