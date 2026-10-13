import type { Db } from '@colosseum/db';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import { person, testIssuer } from '../../testing/harness';

describe('guided thread rollout failure boundary', () => {
  it('answers safe retryable 503 on missing history schema for GET and POST with no private driver logs', async () => {
    const issuer = await testIssuer('thread-unavailable');
    const who = await person(issuer, 'passkey');
    const secret = 'my private goal and salary';
    const query = 'select thread_id from proposals where privy_id = $1';
    const db = {
      select: () => {
        throw new DrizzleQueryError(
          query,
          [who.sub, secret],
          Object.assign(new Error(secret), { code: '42703' }),
        );
      },
    } as unknown as Db;
    const logged: string[] = [];
    const app = await buildApp({
      env: {},
      v1: { auth: issuer.issuer, db },
      logTo: { write: (line) => logged.push(line) },
    });
    try {
      const url = `/v1/baskets/${crypto.randomUUID()}/thread`;
      for (const request of [
        { method: 'GET' as const, url, headers: who.headers },
        {
          method: 'POST' as const,
          url,
          headers: who.headers,
          payload: {
            text: secret,
            reply: { say: [], ask: null, open: [], facts: {} },
          },
        },
      ]) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ details: { retryable: true } });
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.body).not.toContain(secret);
      }
      expect(logged.length).toBeGreaterThan(0);
      for (const value of [secret, who.sub, query]) expect(logged.join('\n')).not.toContain(value);
    } finally {
      await app.close();
    }
  });
});
