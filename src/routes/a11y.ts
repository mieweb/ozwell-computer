import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../server.js';
import { unsupported } from '../errors.js';

export default async function a11yRoutes(app: FastifyInstance, ctx: AppContext) {
  const a11y = () => {
    if (!ctx.a11y) throw unsupported('a11y', 'accessibility is disabled (OZWELL_COMPUTER_A11Y=off)');
    return ctx.a11y;
  };

  app.get('/api/v1/a11y/tree', {
    schema: {
      tags: ['a11y'],
      querystring: {
        type: 'object',
        properties: {
          window: { type: 'string' }, max_depth: { type: 'integer', minimum: 0 }, max_nodes: { type: 'integer', minimum: 1, maximum: 20000 },
          hidden: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const q = req.query as any;
    return a11y().tree({ window: q.window, max_depth: q.max_depth, max_nodes: q.max_nodes, hidden: q.hidden === '1' || q.hidden === 'true' });
  });

  app.post('/api/v1/a11y/find', {
    schema: {
      tags: ['a11y'],
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          role: { type: 'string' }, name: { type: 'string' }, name_contains: { type: 'string' }, value_contains: { type: 'string' },
          states: { type: 'array', items: { type: 'string' } }, max_results: { type: 'integer', minimum: 1, maximum: 1000 }, window: { type: 'string' },
        },
      },
    },
  }, async (req) => a11y().find((req.body as any) ?? {}));

  app.post('/api/v1/a11y/act', {
    schema: {
      tags: ['a11y'],
      body: {
        type: 'object', required: ['snapshot_id', 'element_id', 'action'],
        properties: { snapshot_id: { type: 'string' }, element_id: { type: 'string' }, action: { type: 'string' }, value: { type: 'string' } },
      },
    },
  }, async (req) => {
    const b = req.body as { snapshot_id: string; element_id: string; action: string; value?: string };
    return { delivery: 'background', ...(await a11y().act(b.snapshot_id, b.element_id, b.action, b.value)) };
  });
}
