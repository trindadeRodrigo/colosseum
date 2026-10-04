import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { corsAllowlist, DEFAULT_CORS_ORIGINS } from './cors';
import { plainPath, underV1 } from './paths';

// API-2: /v1 answers a browser only from an origin on the allowlist. What the rest of the API does
// is held by tests/risk-routes-untouched.test.ts.

const WEB = 'http://localhost:3000';
const OTHER = 'https://somewhere-else.example';
/** `/v1/config` spelled other ways. The first three reach the route: the router decodes them. */
const SPELLINGS = [
  '/%761/config',
  '/v%31/config',
  '/%76%31/config',
  '/v1%2Fconfig',
  '//v1/config',
  '/V1/config',
  '/v1/../v1/config',
  '/./v1/config',
  '/v1;x/config',
  '/v1/config/',
  '/v1/config?x=1',
  '/x/../v1/config',
];

describe('the CORS allowlist', () => {
  it('is the development origin when nothing is set, and what CORS_ORIGINS lists when it is', () => {
    expect(DEFAULT_CORS_ORIGINS).toEqual([WEB]);
    expect(corsAllowlist({})).toEqual([WEB]);
    expect(corsAllowlist({ CORS_ORIGINS: '  ' })).toEqual([WEB]);
    expect(corsAllowlist({ CORS_ORIGINS: 'https://app.example' })).toEqual(['https://app.example']);
    expect(
      corsAllowlist({ CORS_ORIGINS: ' https://app.example , http://localhost:3005 ' }),
    ).toEqual(['https://app.example', 'http://localhost:3005']);
    // No origin at all: a host whose browsers only reach the API through the web app's server.
    expect(corsAllowlist({ CORS_ORIGINS: 'none' })).toEqual([]);
  });

  it('refuses anything that is not an origin, a star included, without repeating the value', () => {
    const bad = [
      '*',
      'https://*.example',
      'app.example',
      'https://app.example/',
      'https://app.example/path',
      'ftp://app.example',
      'https://app.example,',
      'https://user:SECRET@app.example',
    ];
    for (const value of bad) {
      let message = 'no error';
      try {
        corsAllowlist({ CORS_ORIGINS: value });
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect([value, message]).toEqual([
        value,
        'CORS_ORIGINS: expected origins such as https://app.example, separated by commas',
      ]);
    }
  });

  it('governs /v1 and nothing beside it', () => {
    for (const url of ['/v1', '/v1/', '/v1/orders', '/v1?x=1', '/v1/me/chain'])
      expect([url, underV1(url)]).toEqual([url, true]);
    for (const url of ['/', '/v10', '/v1x/orders', '/risk/assets', '/plans', '/docs', '/x/v1/'])
      expect([url, underV1(url)]).toEqual([url, false]);
  });

  it('reads a path however it is spelled: the router decodes a path before it matches a route', () => {
    for (const url of SPELLINGS) expect([url, underV1(url)]).toEqual([url, true]);
    expect(plainPath('/%761/config?x=%2Fv1')).toBe('/v1/config');
    expect(plainPath('/%2576%2531/config')).toBe('/v1/config');
    expect(plainPath('/a/./b/../c//d;e/')).toBe('/a/c/d');
    // A bad escape is left as it is, and reading it never throws.
    expect(plainPath('/risk/%zz/%E0%A4%A')).toBe('/risk/%zz/à¤%a');
    // The other routes stay the other routes, whatever is in them.
    for (const url of ['/risk/%76%31', '/risk/assets/v1', '/plans/../risk/v1', '/docs?next=/v1/'])
      expect([url, underV1(url)]).toEqual([url, false]);
  });
});

describe('CORS on /v1', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ env: { CORS_ORIGINS: `${WEB},https://app.example` } });
  });
  afterAll(async () => {
    await app.close();
  });
  const preflight = (url: string, origin: string, method = 'POST') =>
    app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin,
        'access-control-request-method': method,
        'access-control-request-headers': 'authorization,privy-id-token,content-type',
      },
    });

  it('answers an origin on the list, and gives no other origin leave to read', async () => {
    for (const origin of [WEB, 'https://app.example']) {
      const res = await app.inject({ method: 'GET', url: '/v1/config', headers: { origin } });
      expect([res.statusCode, res.headers['access-control-allow-origin']]).toEqual([200, origin]);
      expect(res.headers.vary).toMatch(/Origin/);
    }
    for (const origin of [OTHER, 'http://localhost:3001', 'null', `${WEB}.evil.example`]) {
      const res = await app.inject({ method: 'GET', url: '/v1/config', headers: { origin } });
      expect([origin, res.headers['access-control-allow-origin']]).toEqual([origin, undefined]);
    }
    // Never a star, and never credentials.
    const res = await app.inject({ method: 'GET', url: '/v1/config', headers: { origin: WEB } });
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers a preflight the same way, so a write from another origin is never sent', async () => {
    for (const url of ['/v1/orders', '/v1/me/chain', '/v1/orders/x/legs/y/build']) {
      const ok = await preflight(url, WEB, url === '/v1/me/chain' ? 'PUT' : 'POST');
      expect([url, ok.statusCode, ok.headers['access-control-allow-origin']]).toEqual([
        url,
        204,
        WEB,
      ]);
      expect(ok.headers['access-control-allow-methods']).toBe('GET, HEAD, POST, PUT');
      expect(ok.headers['access-control-allow-headers']).toBe(
        'authorization,privy-id-token,content-type',
      );
      const no = await preflight(url, OTHER);
      expect([url, no.headers['access-control-allow-origin']]).toEqual([url, undefined]);
    }
  });

  it('holds a path to the allowlist however it is spelled, on a read and on a preflight', async () => {
    const served: string[] = [];
    for (const url of SPELLINGS) {
      const res = await app.inject({ method: 'GET', url, headers: { origin: OTHER } });
      if (res.statusCode === 200) served.push(url);
      expect([url, res.headers['access-control-allow-origin']]).toEqual([url, undefined]);
      const pre = await preflight(url, OTHER);
      expect([url, pre.headers['access-control-allow-origin']]).toEqual([url, undefined]);
      // The origin on the list is answered on the same spelling.
      const mine = await preflight(url, WEB);
      expect([url, mine.headers['access-control-allow-origin']]).toEqual([url, WEB]);
    }
    // These spellings reach the route itself: the router decodes an escape, and a client resolves
    // the dots. Without the rule, any origin could read the answer of the first three.
    expect(served).toEqual([
      '/%761/config',
      '/v%31/config',
      '/%76%31/config',
      '/v1/../v1/config',
      '/./v1/config',
      '/v1/config?x=1',
      '/x/../v1/config',
    ]);
  });

  it('with the list set to none, gives no origin leave at all', async () => {
    const closed = await buildApp({ env: { CORS_ORIGINS: 'none' } });
    for (const origin of [WEB, OTHER]) {
      const res = await closed.inject({ method: 'GET', url: '/v1/config', headers: { origin } });
      expect([res.statusCode, res.headers['access-control-allow-origin']]).toEqual([
        200,
        undefined,
      ]);
    }
    await closed.close();
  });

  it('stops the API at start on a list it cannot read', async () => {
    await expect(buildApp({ env: { CORS_ORIGINS: '*' } })).rejects.toThrow(
      /^CORS_ORIGINS: expected/,
    );
  });
});
