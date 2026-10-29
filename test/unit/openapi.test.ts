import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers.js';

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

  it('documents binary responses with their media types', () => {
    expect(Object.keys(paths['/api/v1/screenshot'].get.responses['200'].content)).toEqual(['image/png', 'image/jpeg', 'image/webp', 'application/json']);
    expect(paths['/api/v1/fs/content'].get.responses['206'].content['application/octet-stream'].schema.format).toBe('binary');
  });

  it('serializes replies as returned, not through the response schema', async () => {
    const r = await app.inject({ url: '/api/v1/capabilities', headers: { authorization: 'Bearer secret-token' } });
    expect(r.json().display).toMatchObject({ connected: false, error: null });
  });
});
