import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Person,
  person,
  type TestIssuer,
  testApp,
  testDb,
  testIssuer,
} from '../../testing/harness';

// The four answers of the portfolio section are one person's own (PORT-2): each says that nothing
// between the person and the server may keep it for the next caller, as a plan read back does
// (routes/v1/baskets.ts). Through HTTP on the mock chains and the real database.

const ROUTES = ['history', 'plans', 'rebalances', 'exposure'] as const;

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let ann: Person;

beforeAll(async () => {
  issuer = await testIssuer('test');
  data = await testDb();
  ({ app } = await testApp({ issuer: issuer.issuer, db: data.db }));
  ann = data.track(await person(issuer, 'passkey'));
});
afterAll(async () => {
  await app.close();
  await data.cleanUp();
});

describe('the answers of the portfolio section are kept by nobody', () => {
  for (const route of ROUTES)
    it(`GET /v1/portfolio/${route} says private, no-store`, async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/portfolio/${route}`,
        headers: ann.headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

  it('says it on a refusal too: it is set before anything is read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/portfolio/history?from=2026-10-05T00:00:00.000Z&to=2026-10-04T00:00:00.000Z',
      headers: ann.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });
});
