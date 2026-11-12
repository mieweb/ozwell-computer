import { describe, expect, it } from 'vitest';
import { URL_, auth, api, waitFor } from './helpers.js';

describe('guest lifecycle', () => {
  it('gates work only after requests, jobs and leases have drained, and resumes explicitly', async () => {
    const lifecycle = '/api/v1/lifecycle';
    const resume = () => api('POST', `${lifecycle}/resume`, {});
    const prepare = (idle_ms = 0) => api('POST', `${lifecycle}/prepare`, { idle_ms });
    const abort = new AbortController();
    let job: string | undefined;
    try {
      expect((await fetch(`${URL_}${lifecycle}`)).status).toBe(401);
      expect((await api('PUT', `${lifecycle}/leases/integration-work`, { ttl_ms: 60_000 })).body.leases).toBeGreaterThan(0);
      expect(await prepare()).toMatchObject({ status: 409, body: { error: { reason: 'not_idle' } } });
      expect((await api('DELETE', `${lifecycle}/leases/integration-work`)).status).toBe(200);

      const command = await api('POST', '/api/v1/exec', { cmd: 'sleep 30', wait_ms: 0 });
      expect(command.body.state).toBe('running');
      job = command.body.job_id;
      expect((await api('GET', lifecycle)).body.running_jobs).toBeGreaterThan(0);
      expect((await prepare()).status).toBe(409);
      await api('DELETE', `/api/v1/exec/jobs/${job}`);
      job = undefined;

      const stream = await fetch(`${URL_}/api/v1/events`, { headers: auth, signal: abort.signal });
      expect(stream.status).toBe(200);
      expect((await api('GET', lifecycle)).body.connections).toBeGreaterThan(0);
      expect((await prepare()).status).toBe(409);
      abort.abort();
      await waitFor(async () => (await api('GET', lifecycle)).body.active_requests === 0);
      expect((await prepare(86_400_000)).status).toBe(409);

      const prepared = await prepare();
      expect(prepared.status).toBe(200);
      expect(prepared.headers.get('connection')).toBe('close');
      expect(prepared.body).toMatchObject({ prepared: true, lease_id: expect.any(String), active_requests: 0, running_jobs: 0 });
      expect(await api('GET', '/api/v1/capabilities')).toMatchObject({ status: 503, body: { error: { reason: 'hibernating', retry_after_ms: 1000 } } });
      const health = await fetch(`${URL_}/health`);
      expect(health.status).toBe(204);
      expect(health.headers.get('connection')).toBe('close');
      const metrics = await api('GET', '/api/v1/metrics');
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get('connection')).toBe('close');
      expect((await api('GET', lifecycle)).body.prepared).toBe(true);
      expect((await resume()).body.prepared).toBe(false);
      expect((await api('GET', '/api/v1/capabilities')).status).toBe(200);
    } finally {
      abort.abort();
      await resume();
      if (job) await api('DELETE', `/api/v1/exec/jobs/${job}`);
      await api('DELETE', `${lifecycle}/leases/integration-work`);
    }
  });
});
