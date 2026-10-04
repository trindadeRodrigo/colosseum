import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../apps/api/src/app';
import { buildRiskApp } from '../apps/risk-api/src/app';

// API-2 put rate limits, default deny and a CORS allowlist on /v1. The risk layer's routes (/risk/*,
// also served alone by apps/risk-api) are the other founder's, and none of it may change how they
// answer. apps/risk-api was not edited, so it is the reference: for the same request, the API answers
// a /risk route as the risk API does.

const ORIGINS = ['http://localhost:3000', 'https://somewhere-else.example', 'https://app.example'];
const CORS_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-allow-credentials',
  'access-control-expose-headers',
  'vary',
];

describe('the risk layer’s routes are answered as before', () => {
  let api: Awaited<ReturnType<typeof buildApp>>;
  let risk: Awaited<ReturnType<typeof buildRiskApp>>;
  beforeAll(async () => {
    // The API as a host would run it: an allowlist of one origin, the server's own limits.
    api = await buildApp({ env: { CORS_ORIGINS: 'https://app.example' } });
    risk = await buildRiskApp();
  });
  afterAll(async () => {
    await api.close();
    await risk.close();
  });
  const cors = (headers: Record<string, unknown>) =>
    Object.fromEntries(CORS_HEADERS.map((name) => [name, headers[name]]));

  it('CORS: any origin is reflected, on a read and on a preflight, exactly as the risk API does', async () => {
    for (const origin of ORIGINS) {
      const get = { method: 'GET' as const, url: '/risk/facts/methodology', headers: { origin } };
      const [a, b] = [await api.inject(get), await risk.inject(get)];
      expect([a.statusCode, cors(a.headers)]).toEqual([b.statusCode, cors(b.headers)]);
      expect(a.headers['access-control-allow-origin']).toBe(origin);
      expect(a.json()).toEqual(b.json());

      const preflight = {
        method: 'OPTIONS' as const,
        url: '/risk/positions/assess',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      };
      const [p, q] = [await api.inject(preflight), await risk.inject(preflight)];
      expect([p.statusCode, cors(p.headers)]).toEqual([q.statusCode, cors(q.headers)]);
      expect([p.statusCode, p.headers['access-control-allow-origin']]).toEqual([204, origin]);
    }
  });

  it('no sign-in, no rate limit and no /v1 error shape: 200 requests in a row are answered', async () => {
    for (let i = 0; i < 200; i++) {
      const res = await api.inject({ method: 'GET', url: '/risk/facts/methodology' });
      expect([i, res.statusCode]).toEqual([i, 200]);
      if (i === 199)
        expect(Object.keys(res.headers).filter((h) => /ratelimit|retry-after/.test(h))).toEqual([]);
    }
    // A body the route refuses is refused by the route's own validation, with its own answer.
    const bad = {
      method: 'POST' as const,
      url: '/risk/positions/assess',
      payload: { cashUsd: 'x' },
    };
    const [a, b] = [await api.inject(bad), await risk.inject(bad)];
    expect([a.statusCode, a.json()]).toEqual([b.statusCode, b.json()]);
    expect(a.statusCode).toBe(400);
  });

  it('serves the same /risk routes, with the same documents, as the risk API', async () => {
    await api.ready();
    await risk.ready();
    type Doc = { paths: Record<string, unknown> };
    const [a, b] = [api.swagger() as unknown as Doc, risk.swagger() as unknown as Doc];
    const riskPaths = Object.keys(a.paths).filter((p) => p.startsWith('/risk/'));
    expect(riskPaths.sort()).toEqual(Object.keys(b.paths).sort());
    for (const path of riskPaths) expect(a.paths[path], path).toEqual(b.paths[path]);
  });
});
