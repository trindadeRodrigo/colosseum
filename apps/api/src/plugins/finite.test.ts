import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { NonFiniteResponse, nonFinitePaths, refuseNonFinite } from './finite';

// A number that is not finite never leaves the server. JSON writes Infinity and NaN as null, so a
// route with no response schema would send a figure that is not one; a route with a schema fails on
// it with no word of where it was. Either way the answer is refused, and the error names the route
// and the path, never the values around it.

describe('numbers that are not finite', () => {
  it('finds each one by its path, and nothing in what is finite', () => {
    expect(
      nonFinitePaths({
        legs: [{ expected: [{ costBps: 12 }, { costBps: Number.POSITIVE_INFINITY }] }],
        price: Number.NaN,
        down: Number.NEGATIVE_INFINITY,
        fine: { n: 0, s: 'Infinity', none: null, at: new Date(0), big: 10n },
      }),
    ).toEqual(['legs[0].expected[1].costBps', 'price', 'down']);
    expect(nonFinitePaths(Number.NaN)).toEqual(['(root)']);
    for (const fine of [null, undefined, 'NaN', 1.5, [], {}, [1, [2, { a: 3 }]]])
      expect(nonFinitePaths(fine)).toEqual([]);
  });

  it('refuses the answer of a route that holds one, naming the route and the path', async () => {
    const app = Fastify();
    const thrown: unknown[] = [];
    refuseNonFinite(app);
    app.setErrorHandler((err, _req, reply) => {
      thrown.push(err);
      return reply.code(500).send({ error: 'the server failed on this request' });
    });
    app.get('/orders/:id', async () => ({
      id: 'secret-order',
      legs: [{ expected: [{ costBps: 1 / 0 }] }],
    }));
    app.get('/fine', async () => ({ legs: [{ expected: [{ costBps: 3 }] }], note: null }));
    app.get('/text', async () => 'Infinity');

    const res = await app.inject({ method: 'GET', url: '/orders/abc' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('null');
    const [err] = thrown;
    expect(err).toBeInstanceOf(NonFiniteResponse);
    expect((err as Error).message).toBe(
      'GET /orders/:id answered a number that is not finite at legs[0].expected[0].costBps',
    );
    // nothing of the answer itself
    expect((err as Error).message).not.toContain('secret-order');

    const fine = await app.inject({ method: 'GET', url: '/fine' });
    expect(fine.statusCode).toBe(200);
    expect(fine.json()).toEqual({ legs: [{ expected: [{ costBps: 3 }] }], note: null });
    expect((await app.inject({ method: 'GET', url: '/text' })).body).toBe('Infinity');
    await app.close();
  });
});
