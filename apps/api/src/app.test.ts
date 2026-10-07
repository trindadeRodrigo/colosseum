import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

describe('api skeleton', () => {
  it('serves health with the disclaimer', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().disclaimer).toContain('not licensed');
    await app.close();
  });

  it('publishes the three endpoints in OpenAPI with the disclaimer in the description', async () => {
    const app = await buildApp();
    await app.ready();
    const doc = app.swagger() as { paths: Record<string, unknown>; info: { description: string } };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/goals', '/plans', '/plans/{id}/transactions']),
    );
    expect(doc.info.description).toContain('not licensed');
    await app.close();
  });

  it('rejects invalid bodies with 400', async () => {
    const app = await buildApp();
    const bad = await app.inject({ method: 'POST', url: '/goals', payload: { text: 'x' } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('counts the open writes by address after CORS, so a browser can read the refusal', async () => {
    const limits = {
      windowSeconds: 60,
      caller: { anonymous: 2, signedIn: 2 },
      class: { standard: null, build: null, parse: null },
    };
    const app = await buildApp({ v1: { limits } });
    const post = () =>
      app.inject({
        method: 'POST',
        url: '/goals',
        headers: { origin: 'https://somewhere.example' },
        payload: {},
      });
    // a body the route refuses is still a request made
    expect([(await post()).statusCode, (await post()).statusCode]).toEqual([400, 400]);
    const over = await post();
    expect(over.statusCode).toBe(429);
    expect(over.headers['access-control-allow-origin']).toBe('https://somewhere.example');
    // a read is not counted
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
    await app.close();
  });
});
