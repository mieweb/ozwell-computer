import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.js';
import type { AppContext } from '../server.js';
import { deleteCookies, getCookies, setCookie, type SetCookie } from '../browser/cookies.js';
import { needBridge } from '../browser/bridge.js';
import { errors, prop, record } from './schemas.js';

const domainDoc = 'Cookie domain: ".example.com" for a domain cookie (also sent to subdomains), "example.com" for a host-only cookie';

export const cookie = record('A cookie in the desktop\'s Firefox', {
  name: prop('string', 'Cookie name'),
  value: prop('string', 'Cookie value'),
  domain: prop('string', 'Domain, with a leading dot for a domain cookie (also sent to subdomains)'),
  host_only: prop('boolean', 'Whether the cookie is sent only to exactly this host (domain has no leading dot)'),
  path: prop('string', 'Path the cookie is sent for'),
  secure: prop('boolean', 'Whether the cookie is sent only over https'),
  http_only: prop('boolean', 'Whether page scripts are kept from reading it'),
  same_site: prop('string', 'SameSite attribute; unspecified when the cookie has none', { enum: ['none', 'lax', 'strict', 'unspecified'] }),
  expires: prop(['number', 'null'], 'Expiry as Unix time in seconds, or null for a session cookie'),
});

const unavailable = 'Fails with 404 target_unavailable when Firefox is not running or its ozwell-computer extension is not connected ' +
  '(a call waits up to 10 s for a Firefox that is still starting). Disabled when OZWELL_COMPUTER_EXEC=false.';

export default async function browserRoutes(app: FastifyInstance, ctx: AppContext) {
  const { config } = ctx;
  const gate = async () => {
    if (!config.exec) throw new ApiError('permission_denied', 'browser cookies are disabled (OZWELL_COMPUTER_EXEC=false)');
  };
  const bridge = () => needBridge(ctx.browser);

  app.get('/api/v1/browser/cookies', {
    preHandler: gate,
    schema: {
      tags: ['browser'], summary: 'List Firefox cookies',
      description: 'Cookies in the desktop\'s Firefox (first-party, default store), sorted by domain, path and name. ' + unavailable,
      querystring: {
        type: 'object',
        properties: {
          domain: prop('string', 'Only cookies of this domain and its subdomains (a leading dot is ignored)'),
          name: prop('string', 'Only cookies with this name'),
          url: prop('string', 'Only cookies Firefox would send to this http(s) URL'),
        },
      },
      response: { 200: record('Matching cookies', { cookies: prop('array', 'The cookies', { items: cookie }) }), ...errors },
    },
  }, async (req) => ({ cookies: await getCookies(bridge(), req.query as { domain?: string; name?: string; url?: string }) }));

  app.put('/api/v1/browser/cookies', {
    preHandler: gate,
    schema: {
      tags: ['browser'], summary: 'Set a Firefox cookie',
      description: 'Creates or replaces the cookie with this name, domain and path, e.g. to sign the browser in. Pages already open ' +
        'see it on their next request (reload them). ' + unavailable,
      body: {
        type: 'object', required: ['name', 'value', 'domain'], additionalProperties: false,
        properties: {
          name: prop('string', 'Cookie name', { minLength: 1 }),
          value: prop('string', 'Cookie value'),
          domain: prop('string', domainDoc, { minLength: 1 }),
          path: prop('string', 'Path (default /)'),
          secure: prop('boolean', 'Send only over https (default false)'),
          http_only: prop('boolean', 'Hide from page scripts (default false)'),
          same_site: prop('string', 'SameSite attribute; "none" needs secure; unspecified (the default) leaves it out', { enum: ['none', 'lax', 'strict', 'unspecified'] }),
          expires: prop(['number', 'null'], 'Expiry as Unix time in seconds; omit (or null) for a session cookie'),
          host_only: prop('boolean', 'Optional; must agree with domain (lets a listed cookie be sent back as is)'),
        },
      },
      response: { 200: cookie, ...errors },
    },
  }, async (req) => setCookie(bridge(), req.body as SetCookie));

  app.delete('/api/v1/browser/cookies', {
    preHandler: gate,
    schema: {
      tags: ['browser'], summary: 'Delete Firefox cookies',
      description: 'Deletes the cookies with this name and exact domain (on every path unless path is given), and returns them. ' + unavailable,
      querystring: {
        type: 'object', required: ['name', 'domain'],
        properties: {
          name: prop('string', 'Cookie name', { minLength: 1 }),
          domain: prop('string', domainDoc, { minLength: 1 }),
          path: prop('string', 'Only the cookie with this path'),
        },
      },
      response: { 200: record('Deleted cookies', { deleted: prop('array', 'The cookies that were deleted (empty if none matched)', { items: cookie }) }), ...errors },
    },
  }, async (req) => ({ deleted: await deleteCookies(bridge(), req.query as { name: string; domain: string; path?: string }) }));
}
