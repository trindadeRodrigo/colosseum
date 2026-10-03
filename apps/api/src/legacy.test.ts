import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

// API-2: with LEGACY_STRUCTURER off, which is what unset means, no route that reaches a signer is
// registered. The structurer's monitor routes are the ones that do: POST /policies/:id/rebalance loads
// the agent key and signs on the server. tests/boundaries.test.ts holds the import side of this: the
// file is loaded only inside the `if` on the flag, and nothing else in the API imports a signing entry.

const MONITOR: [method: 'GET' | 'POST', url: string][] = [
  ['GET', '/policies/:id/drift'],
  ['POST', '/policies/:id/rebalance'],
  ['POST', '/policies/:id/revoke'],
  ['GET', '/executions'],
  ['GET', '/stats'],
];
const registered = (app: FastifyInstance) =>
  MONITOR.filter(([method, url]) => app.hasRoute({ method, url })).map(([, url]) => url);
const paths = (app: FastifyInstance) =>
  Object.keys((app.swagger() as { paths: Record<string, unknown> }).paths);

describe('the structurer’s server-signing routes', () => {
  it('are not registered with the flag off or unset, and the config says off', async () => {
    for (const env of [{}, { LEGACY_STRUCTURER: 'off' }]) {
      const app = await buildApp({ env });
      await app.ready();
      expect(registered(app)).toEqual([]);
      expect(paths(app).filter((p) => /^\/(policies|executions$|stats)/.test(p))).toEqual([]);
      // A request for one is a request for nothing: no handler runs, and no key file is looked for.
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
      // The rest of the structurer, which builds unsigned transactions for a wallet to sign, stays.
      expect(paths(app)).toEqual(
        expect.arrayContaining(['/goals', '/plans', '/plans/{id}/transactions']),
      );
      await app.close();
    }
  });

  it('are registered when the flag is on', async () => {
    const app = await buildApp({ env: { LEGACY_STRUCTURER: 'on' } });
    await app.ready();
    expect(registered(app)).toEqual(MONITOR.map(([, url]) => url));
    expect(paths(app)).toEqual(
      expect.arrayContaining(['/policies/{id}/rebalance', '/executions', '/stats']),
    );
    const config = await app.inject({ method: 'GET', url: '/v1/config' });
    expect(config.json().flags.legacyStructurer).toBe(true);
    await app.close();
  });
});
