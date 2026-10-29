import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeApp } from '../helpers.js';
import { strictResponses } from '../../src/server.js';
import { updateStatus } from '../../src/routes/schemas.js';

describe('OpenAPI document', () => {
  let app: FastifyInstance;
  let paths: Record<string, Record<string, any>>;
  beforeAll(async () => {
    ({ app } = await makeApp());
    paths = (app.swagger() as any).paths;
  });
  afterAll(async () => { await app.close(); });

  const operations = () => Object.entries(paths).flatMap(([path, ops]) =>
    Object.entries(ops).map(([method, op]) => ({ name: `${method.toUpperCase()} ${path}`, op })));

  it('every operation has a summary, a described success response and the error shape', () => {
    const missing = operations().flatMap(({ name, op }) => {
      const success = Object.entries<any>(op.responses ?? {}).filter(([code]) => /^2/.test(code));
      return [
        !op.summary && `${name}: summary`,
        success.length === 0 && `${name}: 2xx response`,
        ...success.filter(([, r]) => !r.description || r.description === 'Default Response' || !r.content).map(([code]) => `${name}: ${code} description/content`),
        !op.responses?.['4XX']?.content?.['application/json'] && `${name}: 4XX error schema`,
      ].filter(Boolean);
    });
    expect(missing).toEqual([]);
  });

  it('every documented parameter and body property has a description', () => {
    const undescribed = (name: string, props: Record<string, any> = {}) =>
      Object.entries(props).filter(([, s]) => !s.description).map(([k]) => `${name}: ${k}`);
    const missing = operations().flatMap(({ name, op }) => [
      ...(op.parameters ?? []).filter((p: any) => !p.description && !p.schema?.description).map((p: any) => `${name}: ${p.name}`),
      ...undescribed(name, op.requestBody?.content?.['application/json']?.schema?.properties),
    ]);
    expect(missing).toEqual([]);
  });

  it('documents binary responses and uploads with their media types', () => {
    expect(Object.keys(paths['/api/v1/screenshot'].get.responses['200'].content)).toEqual(['image/png', 'image/jpeg', 'image/webp', 'application/json']);
    expect(paths['/api/v1/fs/content'].get.responses['206'].content['application/octet-stream'].schema.format).toBe('binary');
    expect(paths['/api/v1/fs/content'].put.requestBody.content['application/octet-stream'].schema.format).toBe('binary');
  });

  it('serializes replies through the response schema without losing fields', async () => {
    const r = await app.inject({ url: '/api/v1/capabilities', headers: { authorization: 'Bearer secret-token' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().display).toMatchObject({ connected: false, error: null });
  });
});

describe('strict responses', () => {
  it('fails a reply that its response schema would change', async () => {
    const app = Fastify();
    strictResponses(app);
    const schema = { response: { 200: { type: 'object', properties: { a: { type: 'string' }, n: { type: 'string' } } } } };
    app.get('/dropped', { schema }, async () => ({ a: 'x', b: 1 }));
    app.get('/coerced', { schema }, async () => ({ a: 'x', n: null }));
    app.get('/exact', { schema }, async () => ({ a: 'x' }));
    const dropped = await app.inject({ url: '/dropped' });
    expect(dropped.statusCode).toBe(500);
    expect(dropped.json().message).toBe('GET /dropped: the response schema changed the reply at .b: sent nothing, handler returned 1');
    expect((await app.inject({ url: '/coerced' })).json().message).toContain('.n: sent "", handler returned null');
    expect((await app.inject({ url: '/exact' })).json()).toEqual({ a: 'x' });
    await app.close();
  });

  it('keeps the git channel revision in update status', async () => {
    const app = Fastify();
    strictResponses(app);
    const status = {
      supported: true, url: 'git+https://github.com/mieweb/ozwell-computer#main', current: '1.0.0', latest: '1.0.0', available: true,
      checked_at: null, error: null, revision: { current: 'a'.repeat(40), latest: 'b'.repeat(40) },
      upgrade: { state: 'idle', at: null, log: '' },
    };
    app.get('/update', { schema: { response: { 200: updateStatus } } }, async () => status);
    expect((await app.inject({ url: '/update' })).json()).toEqual(status);
    await app.close();
  });
});
