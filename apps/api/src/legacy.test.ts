import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

// API-2: with LEGACY_STRUCTURER off, which is what unset means, no route that reaches a signer is
// registered. One route of the structurer's monitor does: POST /policies/:id/rebalance loads the agent
// key and signs on the server. It lives in routes/monitor-rebalance.ts, which the API loads only under
// the flag. The monitor's other routes read, or build an unsigned transaction for the wallet to sign,
// and are always served: the home page and the monitor page call them.
// tests/boundaries.test.ts holds the import side: that file is loaded only inside the `if` on the
// flag, and nothing else in the API imports a signing entry.

type Route = [method: 'GET' | 'POST', url: string];
const SIGNS: Route[] = [['POST', '/policies/:id/rebalance']];
const ALWAYS: Route[] = [
  ['GET', '/policies/:id/drift'],
  ['POST', '/policies/:id/revoke'],
  ['GET', '/executions'],
  ['GET', '/stats'],
];
const registered = (app: FastifyInstance, routes: Route[]) =>
  routes.filter(([method, url]) => app.hasRoute({ method, url })).map(([, url]) => url);
const urls = (routes: Route[]) => routes.map(([, url]) => url);
const paths = (app: FastifyInstance) =>
  Object.keys((app.swagger() as { paths: Record<string, unknown> }).paths);

describe('the structurer’s server-signing route', () => {
  it('is not registered with the flag off or unset, and the config says off', async () => {
    for (const env of [{}, { LEGACY_STRUCTURER: 'off' }]) {
      const app = await buildApp({ env });
      await app.ready();
      expect(registered(app, SIGNS)).toEqual([]);
      expect(paths(app)).not.toContain('/policies/{id}/rebalance');
      // A request for it is a request for nothing: no handler runs, and no key file is looked for.
      const id = '4b1c0f0e-3f8e-4d0e-9d2b-0d7a3a6b1c2d';
      const res = await app.inject({
        method: 'POST',
        url: `/policies/${id}/rebalance`,
        payload: { dryRun: false },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toMatch(/Route POST:\/policies\/.* not found/);
      const config = await app.inject({ method: 'GET', url: '/v1/config' });
      expect(config.json().flags.legacyStructurer).toBe(false);
      await app.close();
    }
  });

  it('is registered when the flag is on', async () => {
    const app = await buildApp({ env: { LEGACY_STRUCTURER: 'on' } });
    await app.ready();
    expect(registered(app, SIGNS)).toEqual(urls(SIGNS));
    expect(paths(app)).toContain('/policies/{id}/rebalance');
    const config = await app.inject({ method: 'GET', url: '/v1/config' });
    expect(config.json().flags.legacyStructurer).toBe(true);
    await app.close();
  });

  it('is the only route the flag takes away: the monitor’s reads and its unsigned revoke are always served', async () => {
    for (const env of [{}, { LEGACY_STRUCTURER: 'off' }, { LEGACY_STRUCTURER: 'on' }]) {
      const app = await buildApp({ env });
      await app.ready();
      expect(registered(app, ALWAYS)).toEqual(urls(ALWAYS));
      expect(paths(app)).toEqual(
        expect.arrayContaining([
          '/policies/{id}/drift',
          '/policies/{id}/revoke',
          '/executions',
          '/stats',
          // The rest of the structurer, which builds unsigned transactions for a wallet to sign.
          '/goals',
          '/plans',
          '/plans/{id}/transactions',
        ]),
      );
      await app.close();
    }
  });
});
