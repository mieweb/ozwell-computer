export const api = <T>(path: string, opts: RequestInit = {}): Promise<T> =>
  fetch(path, { credentials: 'same-origin', ...opts, headers: { 'content-type': 'application/json', ...opts.headers } })
    .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || r.statusText); return r.json(); });
