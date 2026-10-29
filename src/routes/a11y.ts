import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../server.js';
import { unsupported } from '../errors.js';
import { a11yNode, errors, obj, prop, record, windowRef } from './schemas.js';

const snapshotId = prop('string', 'Snapshot id; element ids are only valid with the snapshot that produced them (the last 8 are kept)');
const truncated = prop('boolean', 'Whether the walk stopped at the node limit');

export default async function a11yRoutes(app: FastifyInstance, ctx: AppContext) {
  const a11y = () => {
    if (!ctx.a11y) throw unsupported('a11y', 'accessibility is disabled (OZWELL_COMPUTER_A11Y=off)');
    return ctx.a11y;
  };

  app.get('/api/v1/a11y/tree', {
    schema: {
      tags: ['a11y'], summary: 'Accessibility tree',
      description: 'Flat, pre-order AT-SPI tree for one window or the whole desktop. Fails with feature_unsupported when accessibility is disabled.',
      querystring: {
        type: 'object',
        properties: {
          window: prop('string', `Only this window's application. ${windowRef}`),
          max_depth: prop('integer', 'Maximum depth (default 64)', { minimum: 0 }),
          max_nodes: prop('integer', 'Maximum nodes (default 5000)', { minimum: 1, maximum: 20000 }),
          hidden: prop('string', 'Include invisible elements when 1 or true'),
        },
      },
      response: {
        200: record('A snapshot of the tree', { snapshot_id: snapshotId, truncated, nodes: prop('array', 'Elements in pre-order', { items: a11yNode }) }),
        ...errors,
      },
    },
  }, async (req) => {
    const q = req.query as any;
    return a11y().tree({ window: q.window, max_depth: q.max_depth, max_nodes: q.max_nodes, hidden: q.hidden === '1' || q.hidden === 'true' });
  });

  app.post('/api/v1/a11y/find', {
    schema: {
      tags: ['a11y'], summary: 'Find accessible elements',
      description: 'All given criteria must match.',
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          role: prop('string', 'Normalized or AT-SPI role, e.g. button, text_field, menuitem'),
          name: prop('string', 'Exact accessible name'),
          name_contains: prop('string', 'Case-insensitive substring of the name'),
          value_contains: prop('string', 'Case-insensitive substring of the value'),
          states: prop('array', 'States that must all be present, e.g. focused, checked', { items: { type: 'string' } }),
          max_results: prop('integer', 'Maximum matches returned (default 50)', { minimum: 1, maximum: 1000 }),
          window: prop('string', `Only search this window's application. ${windowRef}`),
        },
      },
      response: {
        200: record('Matching elements', {
          snapshot_id: snapshotId, truncated,
          matches: prop('array', 'Matches, up to max_results', { items: a11yNode }),
          total: prop('integer', 'Number of matches before max_results'),
        }),
        ...errors,
      },
    },
  }, async (req) => a11y().find((req.body as any) ?? {}));

  app.post('/api/v1/a11y/act', {
    schema: {
      tags: ['a11y'], summary: 'Act on an accessible element',
      description: 'Background-safe: does not move the pointer or require focus. Fails with stale_snapshot once the snapshot has expired.',
      body: {
        type: 'object', required: ['snapshot_id', 'element_id', 'action'],
        properties: {
          snapshot_id: snapshotId,
          element_id: prop('string', 'Element id from the same snapshot'),
          action: prop('string', 'press, focus, set_value, or any action name the element lists'),
          value: prop('string', 'New value for set_value'),
        },
      },
      response: {
        200: obj('Action result', {
          delivery: prop('string', 'Always background', { enum: ['background'] }),
          ok: prop('boolean', 'Whether the toolkit reported success'),
          action: prop('string', 'The element action that was invoked, when called by name'),
        }, { required: ['delivery', 'ok'] }),
        ...errors,
      },
    },
  }, async (req) => {
    const b = req.body as { snapshot_id: string; element_id: string; action: string; value?: string };
    return { delivery: 'background', ...(await a11y().act(b.snapshot_id, b.element_id, b.action, b.value)) };
  });
}
