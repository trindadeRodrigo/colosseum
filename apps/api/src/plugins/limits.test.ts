import { OrderError } from '@colosseum/schemas';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { person, type TestIssuer, testApp, testDb, testIssuer } from '../testing/harness';
import { registerAuth } from './auth';
import { createCounter, LIMITS, registerLimits, requireDeclared } from './limits';

// API-2: rate limits and default deny for /v1. The numbers are in one place, `LIMITS`, and these tests
// run the app with them as a server does, on a clock the test moves.

vi.setConfig({ testTimeout: 60_000 });

describe('the limits, in one place', () => {
  it('are the design’s: 60 a minute anonymous, 120 signed in, 30 on the builders, 10 on the parser', () => {
    expect(LIMITS).toEqual({
      windowSeconds: 60,
      caller: { anonymous: 60, signedIn: 120 },
      class: { standard: null, build: 30, parse: 10 },
    });
  });

  it('count per key in a window, start again when it closes, and forget who has gone', () => {
    const counter = createCounter(60_000);
    const t0 = 1_000_000;
    expect(counter.take('a', 2, t0)).toEqual({
      ok: true,
      limit: 2,
      remaining: 1,
      resetAt: t0 + 60_000,
    });
    expect(counter.take('a', 2, t0 + 10)).toMatchObject({ ok: true, remaining: 0 });
    // Over: refused until the window that opened with the first request closes.
    expect(counter.take('a', 2, t0 + 59_999)).toMatchObject({ ok: false, remaining: 0 });
    expect(counter.take('b', 2, t0 + 59_999)).toMatchObject({ ok: true, remaining: 1 });
    expect(counter.take('a', 2, t0 + 60_000)).toMatchObject({
      ok: true,
      remaining: 1,
      resetAt: t0 + 120_000,
    });
    // A caller whose window has closed is dropped at the next sweep.
    expect(counter.size()).toBe(2);
    counter.take('c', 2, t0 + 200_000);
    expect(counter.size()).toBe(1);
  });
});

describe('rate limits on /v1, as the server runs them', () => {
  let issuer: TestIssuer;
  let data: Awaited<ReturnType<typeof testDb>>;
  let app: FastifyInstance;
  let clock = Date.parse('2026-10-05T15:00:00.000Z');

  beforeAll(async () => {
    issuer = await testIssuer('limits');
    data = await testDb();
  });
  // A new app, so a new table of counts, for each test.
  beforeEach(async () => {
    await app?.close();
    ({ app } = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      limits: LIMITS,
      now: () => new Date(clock),
    }));
  });
  afterAll(async () => {
    await app?.close();
    await data.cleanUp();
  });

  const send = (
    method: 'GET' | 'POST',
    url: string,
    more: { headers?: Record<string, string>; payload?: object; remoteAddress?: string } = {},
  ) => app.inject({ method, url, ...more });
  /** `n` requests, one after the other. Their status codes, each once, in the order first seen. */
  async function burst(n: number, one: () => ReturnType<typeof send>) {
    const seen: number[] = [];
    for (let i = 0; i < n; i++) {
      const { statusCode } = await one();
      if (!seen.includes(statusCode)) seen.push(statusCode);
    }
    return seen;
  }

  it('lets an address make 60 requests a minute with nobody signed in, and refuses the next', async () => {
    const first = await send('GET', '/v1/config');
    expect(first.statusCode).toBe(200);
    expect([
      first.headers['ratelimit-limit'],
      first.headers['ratelimit-remaining'],
      first.headers['ratelimit-reset'],
    ]).toEqual(['60', '59', '60']);
    expect(await burst(59, () => send('GET', '/v1/config'))).toEqual([200]);

    const over = await send('GET', '/v1/config');
    expect(over.statusCode).toBe(429);
    expect(OrderError.parse(over.json())).toEqual({
      error: 'too many requests',
      code: 'RATE_LIMITED',
      fix: 'Try again in 60 seconds.',
      details: { retryable: true },
    });
    expect([over.headers['retry-after'], over.headers['ratelimit-remaining']]).toEqual(['60', '0']);
    // Another address has a budget of its own. A forwarded address is not believed: it is this one.
    expect((await send('GET', '/v1/config', { remoteAddress: '10.0.0.7' })).statusCode).toBe(200);
    const forwarded = { headers: { 'x-forwarded-for': '10.0.0.8' } };
    expect((await send('GET', '/v1/config', forwarded)).statusCode).toBe(429);

    // Half a minute on it says how long is left; once the window has closed the count starts again.
    clock += 30_000;
    const later = await send('GET', '/v1/config');
    expect([later.statusCode, later.headers['retry-after']]).toEqual([429, '30']);
    expect(later.json().fix).toBe('Try again in 30 seconds.');
    clock += 30_000;
    expect((await send('GET', '/v1/config')).statusCode).toBe(200);
  });

  it('counts a sign-in that fails, so guessing at tokens runs out too', async () => {
    const guess = {
      headers: { authorization: 'Bearer not-a-token', 'privy-id-token': 'nor-this' },
    };
    expect(await burst(60, () => send('GET', '/v1/me', guess))).toEqual([401]);
    expect((await send('GET', '/v1/me', guess)).statusCode).toBe(429);
    // And a request with no token at all is in the same count.
    expect((await send('GET', '/v1/portfolio')).statusCode).toBe(429);
  });

  it('counts a signed-in person by who they are: 120 a minute, from any address', async () => {
    const [a, b] = [data.track(await person(issuer)), data.track(await person(issuer))];
    const me = (who: typeof a, remoteAddress?: string) =>
      send('GET', '/v1/me', { headers: who.headers, ...(remoteAddress ? { remoteAddress } : {}) });
    const first = await me(a);
    expect([first.statusCode, first.headers['ratelimit-limit']]).toEqual([200, '120']);
    expect(await burst(119, () => me(a))).toEqual([200]);
    expect((await me(a)).statusCode).toBe(429);
    // The count is the person's: another address does not reset it.
    expect((await me(a, '10.0.0.9')).statusCode).toBe(429);
    // Somebody else at the same address is not held back, and neither is a caller who is not signed in.
    expect((await me(b)).statusCode).toBe(200);
    expect((await send('GET', '/v1/config')).statusCode).toBe(200);
  });

  it('holds the builders to 30 a minute between them, on top of the person’s own count', async () => {
    const a = data.track(await person(issuer));
    const id = '4b1c0f0e-3f8e-4d0e-9d2b-0d7a3a6b1c2d';
    // A request the builder refuses is still a request.
    const plan = () =>
      send('POST', '/v1/orders', {
        headers: a.headers,
        payload: { type: 'buy', owner: a.owner, amountUsd: 10, proposalId: id },
      });
    const first = await plan();
    expect([first.statusCode, first.headers['ratelimit-limit']]).toEqual([404, '30']);
    expect(await burst(29, plan)).toEqual([404]);
    const over = await plan();
    expect([over.statusCode, over.json().code]).toEqual([429, 'RATE_LIMITED']);
    // Building a step is in the same class, so it is out too.
    const build = await send('POST', `/v1/orders/${id}/legs/${id}/build`, { headers: a.headers });
    expect(build.statusCode).toBe(429);
    // A read is not: the person has used 32 of their 120.
    const read = await send('GET', '/v1/me', { headers: a.headers });
    expect([
      read.statusCode,
      read.headers['ratelimit-limit'],
      read.headers['ratelimit-remaining'],
    ]).toEqual([200, '120', '87']);
  });

  it('applies to /v1 and to nothing else the API serves', async () => {
    for (const url of ['/health', '/risk/facts/methodology']) {
      const seen = await burst(150, () => send('GET', url));
      expect([url, seen]).toEqual([url, [200]]);
      const res = await send('GET', url);
      expect(Object.keys(res.headers).filter((h) => h.startsWith('ratelimit'))).toEqual([]);
    }
  });
});

describe('default deny for /v1', () => {
  const scoped = async (declare: (scope: FastifyInstance) => void) => {
    const app = Fastify();
    await app.register(async (scope) => {
      requireDeclared(scope);
      registerAuth(scope, null);
      registerLimits(scope);
      declare(scope);
    });
    await app.ready();
    return app;
  };

  it('does not start with a route that does not say who may call it, or which budget it counts against', async () => {
    const handler = async () => ({ ok: true });
    await expect(scoped((s) => s.get('/v1/open', handler))).rejects.toThrow(
      'GET /v1/open declares no sign-in rule (config.auth)',
    );
    await expect(
      scoped((s) => s.post('/v1/write', { config: { limit: 'standard' } }, handler)),
    ).rejects.toThrow('POST /v1/write declares no sign-in rule (config.auth)');
    await expect(
      scoped((s) => s.get('/v1/unlimited', { config: { auth: 'public' } }, handler)),
    ).rejects.toThrow('GET /v1/unlimited declares no rate-limit class (config.limit)');
    await expect(
      scoped((s) =>
        s.get('/v1/odd', { config: { auth: 'public', limit: 'none' as never } }, handler),
      ),
    ).rejects.toThrow(/declares no rate-limit class/);
    // With both, it starts and serves.
    const app = await scoped((s) =>
      s.get('/v1/fine', { config: { auth: 'public', limit: 'standard' } }, handler),
    );
    expect((await app.inject({ method: 'GET', url: '/v1/fine' })).statusCode).toBe(200);
    await app.close();
  });

  it('answers a path or a method that is no route with 404, and a route with no token with a refusal', async () => {
    const data = await testDb();
    const issuer = await testIssuer('deny');
    const { app } = await testApp({ issuer: issuer.issuer, db: data.db });
    const tries: [string, string, number][] = [
      ['GET', '/v1', 404],
      ['GET', '/v1/nothing', 404],
      ['DELETE', '/v1/orders', 404],
      ['POST', '/v1/config', 404],
      ['GET', '/v1/orders', 404],
      // Every route but the config needs a person.
      ['GET', '/v1/me', 401],
      ['GET', '/v1/funding', 401],
      ['GET', '/v1/portfolio', 401],
      ['POST', '/v1/orders', 401],
      ['PUT', '/v1/me/chain', 401],
      ['GET', '/v1/config', 200],
    ];
    for (const [method, url, status] of tries) {
      const res = await app.inject({ method: method as 'GET', url });
      expect([method, url, res.statusCode]).toEqual([method, url, status]);
    }
    await app.close();
    await data.cleanUp();
  });
});
