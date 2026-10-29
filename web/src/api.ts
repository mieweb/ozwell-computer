// Fastify rejects a JSON content-type without a body, so only label requests that have one.
export const api = <T>(path: string, opts: RequestInit = {}): Promise<T> =>
  fetch(path, { credentials: 'same-origin', ...opts, headers: { ...(opts.body != null && { 'content-type': 'application/json' }), ...opts.headers } })
    .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || r.statusText); return r.json(); });
