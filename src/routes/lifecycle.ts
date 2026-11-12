import type { FastifyInstance } from 'fastify';
import { type Lifecycle, MAX_LEASE_MS } from '../lifecycle.js';
import { errors, prop, record } from './schemas.js';

const status = record('Guest work and hibernation admission state', {
  last_activity_at: prop('integer', 'Last authenticated activity, in milliseconds since the Unix epoch'),
  active_requests: prop('integer', 'Admitted requests still executing or streaming, including connections'),
  connections: prop('integer', 'Open WebSocket and event-stream requests'),
  running_jobs: prop('integer', 'Detached command jobs still running, including jobs recovered after server restart'),
  busy: prop('boolean', 'An upgrade is requested or running'),
  leases: prop('integer', 'Unexpired explicit keep-awake leases'),
  prepared: prop('boolean', 'Admission is closed for an external managed save'),
  lease_id: prop(['string', 'null'], 'Preparation identity; retained until explicit resume, including across VM save/restore'),
});
const schema = (summary: string) => ({ tags: ['system'], summary, response: { 200: status, ...errors } });

export default async function lifecycleRoutes(app: FastifyInstance, lifecycle: Lifecycle) {
  app.addHook('onSend', async (_req, reply, payload) => { reply.header('cache-control', 'no-store'); return payload; });
  app.get('/api/v1/lifecycle', { schema: schema('Guest idleness and hibernation state; polling does not keep the guest awake') }, async () => lifecycle.status());
  app.post('/api/v1/lifecycle/prepare', {
    schema: {
      ...schema('Close work admission only if the guest has been idle; returns not_idle (409) otherwise'),
      body: record('Required idle grace', { idle_ms: prop('integer', 'Minimum time without activity', { minimum: 0, maximum: MAX_LEASE_MS }) }, { additionalProperties: false }),
    },
  }, async (req, reply) => {
    const prepared = await lifecycle.prepare((req.body as { idle_ms: number }).idle_ms);
    // Control-plane HTTP pools are not desktop activity. Drain their idle TCP
    // sockets before CRIU saves the process tree; the preparation response also
    // closes its own connection once its body has been delivered.
    reply.header('connection', 'close');
    app.server.closeIdleConnections();
    return prepared;
  });
  app.post('/api/v1/lifecycle/resume', {
    schema: {
      ...schema('Reopen work admission after restore, save failure, or controller recovery'),
      body: { type: 'object', additionalProperties: false },
    },
  }, async () => { lifecycle.resume(); return lifecycle.status(); });
  const params = record('Keep-awake lease', { id: prop('string', 'Caller-chosen identifier', { pattern: '^[A-Za-z0-9_-]{1,128}$' }) });
  app.put('/api/v1/lifecycle/leases/:id', {
    schema: {
      ...schema('Create or renew a bounded keep-awake lease for work outside command jobs'), params,
      body: record('Lease lifetime', { ttl_ms: prop('integer', 'Renew before this lifetime elapses; maximum one day', { minimum: 1, maximum: MAX_LEASE_MS }) }, { additionalProperties: false }),
    },
  }, async (req) => {
    lifecycle.keepAwake((req.params as { id: string }).id, (req.body as { ttl_ms: number }).ttl_ms);
    return lifecycle.status();
  });
  app.delete('/api/v1/lifecycle/leases/:id', { schema: { ...schema('Release a keep-awake lease (idempotent)'), params } }, async (req) => {
    lifecycle.release((req.params as { id: string }).id);
    return lifecycle.status();
  });
}
