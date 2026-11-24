import { ApiError } from '../errors.js';
import type { BrowserBridge } from './bridge.js';

// Cookies in the desktop's Firefox, through its ozwell-computer extension (the
// WebExtension cookies API). Domains follow the cookie-jar convention, in and out: a
// leading dot (".example.com") is a domain cookie, also sent to subdomains; without one
// ("example.com") the cookie is host-only. So a cookie read with getCookies can be set
// again as is. Only first-party (unpartitioned) cookies of the default store are covered.

export type SameSite = 'none' | 'lax' | 'strict';

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  host_only: boolean;
  path: string;
  secure: boolean;
  http_only: boolean;
  same_site: SameSite | 'unspecified';
  /** Unix time in seconds; null for a session cookie. */
  expires: number | null;
}

export interface SetCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  http_only?: boolean;
  /** unspecified (as get reports it) is the same as leaving it out. */
  same_site?: SameSite | 'unspecified';
  /** null (as get reports a session cookie) is the same as leaving it out. */
  expires?: number | null;
  /** Optional, as get reports it: must agree with domain. */
  host_only?: boolean;
}

export interface CookieQuery { domain?: string; name?: string; url?: string }

/** A cookie as the WebExtension API reports it. */
interface WebExtCookie {
  name: string; value: string; domain: string; hostOnly: boolean; path: string; secure: boolean; httpOnly: boolean;
  sameSite: 'no_restriction' | 'lax' | 'strict' | 'unspecified'; session: boolean; expirationDate?: number;
}

const HOST = /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$|^\[[0-9a-f:.]+\]$/i;

/** The host part of a cookie domain (without its leading dot), validated. */
function hostOf(domain: string): string {
  const host = domain.startsWith('.') ? domain.slice(1) : domain;
  if (!HOST.test(host)) throw new ApiError('invalid_request', `domain must be a host name such as example.com or .example.com, not ${JSON.stringify(domain)}`);
  return host.toLowerCase();
}

/** A Path attribute (RFC 6265 4.1.1: any character but controls and ";"). */
function checkPath(path: string): string {
  if (!path.startsWith('/') || /[\x00-\x1f\x7f;]/.test(path)) throw new ApiError('invalid_request', 'path must start with "/" and contain no ";" or control characters');
  return path;
}

const toSameSite = { none: 'no_restriction', lax: 'lax', strict: 'strict' } as const;

function present(c: WebExtCookie): Cookie {
  return {
    name: c.name, value: c.value, domain: c.domain, host_only: c.hostOnly, path: c.path,
    secure: c.secure, http_only: c.httpOnly,
    same_site: c.sameSite === 'no_restriction' ? 'none' : c.sameSite,
    expires: c.session || c.expirationDate === undefined ? null : c.expirationDate,
  };
}

const byKey = (a: Cookie, b: Cookie) => a.domain.localeCompare(b.domain) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name);

/** The URL the extension needs to address a cookie: its host and path, https for a secure one. */
const urlFor = (host: string, path: string, secure: boolean) => `${secure ? 'https' : 'http'}://${host}${path}`;

/** Cookies with exactly this name and domain (and path, when given). */
async function exact(bridge: BrowserBridge, name: string, domain: string, path?: string): Promise<Cookie[]> {
  const host = hostOf(domain);
  const want = domain.startsWith('.') ? `.${host}` : host;
  const all = await bridge.call<WebExtCookie[]>('cookies.getAll', { name, domain: host });
  return all.map(present).filter((c) => c.domain.toLowerCase() === want && (path === undefined || c.path === path));
}

export async function getCookies(bridge: BrowserBridge, q: CookieQuery = {}): Promise<Cookie[]> {
  const params: Record<string, string> = {};
  if (q.domain !== undefined) params.domain = hostOf(q.domain);
  if (q.name !== undefined) params.name = q.name;
  if (q.url !== undefined) {
    if (!/^https?:\/\/[^/]/i.test(q.url)) throw new ApiError('invalid_request', 'url must be an http(s) URL');
    params.url = q.url;
  }
  return (await bridge.call<WebExtCookie[]>('cookies.getAll', params)).map(present).sort(byKey);
}

export async function setCookie(bridge: BrowserBridge, c: SetCookie): Promise<Cookie> {
  if (!c.name || /[\s;=,]/.test(c.name)) throw new ApiError('invalid_request', 'name must be non-empty, without spaces, ";", "=" or ","');
  if (/[;\r\n]/.test(c.value)) throw new ApiError('invalid_request', 'value must not contain ";" or line breaks');
  const host = hostOf(c.domain);
  const path = checkPath(c.path ?? '/');
  const secure = c.secure ?? false;
  if (c.host_only !== undefined && c.host_only === c.domain.startsWith('.')) {
    throw new ApiError('invalid_request', 'host_only disagrees with domain: a leading dot makes a domain cookie, none a host-only one');
  }
  if (c.same_site === 'none' && !secure) throw new ApiError('invalid_request', 'same_site "none" requires secure: true');
  await bridge.call('cookies.set', {
    url: urlFor(host, path, secure), name: c.name, value: c.value, path, secure,
    // Without a domain the extension sets a host-only cookie.
    ...(c.domain.startsWith('.') ? { domain: `.${host}` } : {}),
    httpOnly: c.http_only ?? false,
    ...(c.same_site && c.same_site !== 'unspecified' ? { sameSite: toSameSite[c.same_site] } : {}),
    ...(c.expires != null ? { expirationDate: c.expires } : {}),
  });
  // cookies.set answers with whichever cookie of that name the URL would get (a host-only
  // and a domain cookie can both match): read back the one that was set.
  const stored = await exact(bridge, c.name, c.domain, path);
  if (!stored[0]) throw new ApiError('invalid_request', 'Firefox did not keep the cookie (is expires in the past?)');
  return stored[0];
}

/** Delete the cookies with this name and domain (all paths unless one is given); returns them. */
export async function deleteCookies(bridge: BrowserBridge, q: { name: string; domain: string; path?: string }): Promise<Cookie[]> {
  if (q.path !== undefined) checkPath(q.path);
  const found = await exact(bridge, q.name, q.domain, q.path);
  const host = hostOf(q.domain);
  for (const c of found) {
    // An expired cookie replaces exactly the one with the same domain, path and name.
    await bridge.call('cookies.set', {
      url: urlFor(host, c.path, c.secure), name: c.name, value: '', path: c.path, secure: c.secure,
      ...(c.host_only ? {} : { domain: c.domain }), expirationDate: 1,
    });
  }
  return found;
}
