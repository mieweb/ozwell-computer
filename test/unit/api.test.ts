import Fastify from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../web/src/api.js';

describe('viewer api helper', () => {
  const app = Fastify();
  app.delete('/job', async () => ({ ok: true }));
  app.put('/clip', async (req) => req.body);
  afterAll(() => app.close());
  afterEach(() => vi.unstubAllGlobals());

  // Replays the request the helper builds against a real Fastify route.
  const send = async (path: string, opts?: RequestInit) => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const res = await app.inject({
        method: init.method as 'PUT' | 'DELETE',
        url,
        headers: init.headers as Record<string, string>,
        ...(init.body != null && { payload: init.body as string }),
      });
      return new Response(res.body, { status: res.statusCode });
    });
    vi.stubGlobal('fetch', fetch);
    const body = await api(path, opts);
    return { body, headers: fetch.mock.calls[0][1].headers };
  };

  it('sends no JSON content-type on a bodiless request', async () => {
    const { body, headers } = await send('/job', { method: 'DELETE' });
    expect(headers).not.toHaveProperty('content-type');
    expect(body).toEqual({ ok: true });
  });

  it('labels a JSON body', async () => {
    const { body, headers } = await send('/clip', { method: 'PUT', body: JSON.stringify({ text: 'hi' }) });
    expect(headers).toHaveProperty('content-type', 'application/json');
    expect(body).toEqual({ text: 'hi' });
  });
});
