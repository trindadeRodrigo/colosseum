import { inspect } from 'node:util';
import type { Db } from '@colosseum/db';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { testApp } from '../testing/harness';
import { hideServerErrors } from './errors';
import { isDatabaseError, loggable } from './loggable';

// A failed query's error holds the statement and its values, in its message, its stack and its
// fields: a person's sign-in id, their wallet, their words. A log line has its name and its code, and
// none of that, on every route.

const PERSON = 'did:privy:cmab12cd34ef56gh78ij90kl';
/** The error as the drivers throw it: Drizzle's, over the database's own. */
const failedQuery = () =>
  new DrizzleQueryError(
    'select "id", "chain_id" from "users" where "users"."privy_id" = $1',
    [PERSON],
    Object.assign(
      new Error('(EMAXCONNSESSION) max clients reached in session mode - pool_size: 15'),
      { name: 'PostgresError', code: 'EMAXCONNSESSION', query: 'select 1', parameters: [PERSON] },
    ),
  );
const NOTHING_OF_IT = /did:privy|cmab12cd|privy_id|select |max clients|pool_size/;

describe('what of an error is logged', () => {
  it('self-check: the driver’s error does hold the person’s id, wherever it is printed', () => {
    const err = failedQuery();
    expect(err.message).toContain(PERSON);
    expect(inspect(err)).toContain(PERSON);
    expect(JSON.stringify({ ...err, cause: { ...(err.cause as object) } })).toContain(PERSON);
  });

  it('is a database error’s name and code alone, and any other error whole', () => {
    expect(loggable(failedQuery())).toEqual({ type: 'DrizzleQueryError', code: 'EMAXCONNSESSION' });
    // the driver's own error, thrown bare, and one wrapped by something else
    const bare = failedQuery().cause;
    expect(loggable(bare)).toEqual({ type: 'PostgresError', code: 'EMAXCONNSESSION' });
    const wrapped = new Error('a transaction failed', { cause: failedQuery() });
    expect(loggable(wrapped)).toEqual({ type: 'Error', code: 'EMAXCONNSESSION' });
    // no code where the database gave none, and never a code that is not one
    const odd = Object.assign(failedQuery(), { cause: undefined, code: `${PERSON} is not a code` });
    expect(loggable(odd)).toEqual({ type: 'DrizzleQueryError' });
    const other = new Error('the node is not answering');
    expect(isDatabaseError(other)).toBe(false);
    expect(loggable(other)).toBe(other);
    for (const not of [null, undefined, 'a string', 7]) expect(loggable(not)).toBe(not);
  });

  it('holds on a route outside /v1: the line names the failure and nothing of the query', async () => {
    const logged: string[] = [];
    const app = Fastify({ logger: { stream: { write: (line: string) => logged.push(line) } } });
    hideServerErrors(app);
    app.get('/db', async () => {
      throw failedQuery();
    });
    app.get('/other', async () => {
      throw new Error('the node is not answering');
    });
    const res = await app.inject({ url: '/db' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(NOTHING_OF_IT);
    const failed = logged
      .filter((line) => line.includes('a route failed'))
      .map((l) => JSON.parse(l));
    expect(failed).toHaveLength(1);
    expect(failed[0].err).toEqual({ type: 'DrizzleQueryError', code: 'EMAXCONNSESSION' });
    expect(failed[0].reqId).toBeTruthy();
    expect(logged.join('\n')).not.toMatch(NOTHING_OF_IT);
    // an error that is not the database's is logged as before, with its message
    await app.inject({ url: '/other' });
    expect(logged.join('\n')).toContain('the node is not answering');
  });

  it('holds on /v1: a query that fails under a route is logged by name and code', async () => {
    const logged: string[] = [];
    // Every read fails as the pooler failed them on the hosted API.
    const failing = new Proxy({} as Db, {
      get: () => () => {
        throw failedQuery();
      },
    });
    const { app } = await testApp({
      issuer: null,
      db: failing,
      logTo: { write: (line) => logged.push(line) },
    });
    try {
      const res = await app.inject({ url: `/v1/baskets/${crypto.randomUUID()}` });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        error: expect.stringMatching(/^the server failed on this request \(.+\)$/),
      });
      const failed = logged
        .filter((line) => line.includes('a /v1 route failed'))
        .map((line) => JSON.parse(line));
      expect(failed).toHaveLength(1);
      expect(failed[0].err).toEqual({ type: 'DrizzleQueryError', code: 'EMAXCONNSESSION' });
      expect(logged.join('\n')).not.toMatch(NOTHING_OF_IT);
    } finally {
      await app.close();
    }
  });
});
