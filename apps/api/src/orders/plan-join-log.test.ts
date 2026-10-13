import { mockAddress } from '@colosseum/chain-mock';
import type { Db } from '@colosseum/db';
import type { Principal } from '@colosseum/schemas';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from '../redact';
import { joinMissed } from './plan-join';

const PERSON = 'did:privy:join-log-private-person';
const WORDS = 'my private retirement goal';
const SQL = 'select "privy_id", "words" from "users" where "privy_id" = $1';
const failedQuery = () =>
  new DrizzleQueryError(
    SQL,
    [PERSON, WORDS],
    Object.assign(new Error('private driver detail'), {
      name: 'PostgresError',
      code: 'ECONNRESET',
      query: SQL,
      parameters: [PERSON, WORDS],
    }),
  );

const owner = mockAddress('solana', 'join-log-owner');
const address = mockAddress('solana', 'join-log-vault');
const principal: Principal = {
  kind: 'user',
  userId: PERSON,
  wallets: [{ family: 'solana', address: owner, kind: 'external' }],
  ip: '127.0.0.1',
};

/** No connection: the first look returns a vault or fails; the per-vault query then fails. */
function failingDb(stage: 'look' | 'vault', err: Error) {
  let selects = 0;
  const db = new Proxy({} as Db, {
    get: (_target, key) => {
      if (key !== 'select') throw new Error(`unexpected database operation: ${String(key)}`);
      return () => {
        selects += 1;
        if (stage === 'look' || selects > 1) throw err;
        return { from: () => ({ where: async () => [{ address }] }) };
      };
    },
  });
  return { db, selects: () => selects };
}

async function readWithLog(stage: 'look' | 'vault', err: Error) {
  const logged: string[] = [];
  const app = Fastify({
    logger: { ...loggerOptions({}), stream: { write: (line: string) => logged.push(line) } },
  });
  const failing = failingDb(stage, err);
  app.get('/joined', async (req) => {
    await joinMissed(
      failing.db,
      'solana',
      [{ chain: 'solana', address, owner, basketId: '7' }],
      principal,
      req.log,
    );
    return { ok: true };
  });
  try {
    const response = await app.inject({ url: '/joined' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    const errors = logged.map((line) => JSON.parse(line)).filter((line) => line.level === 50);
    expect(errors).toHaveLength(1);
    expect(errors[0].chain).toBe('solana');
    expect(failing.selects()).toBe(stage === 'look' ? 1 : 2);
    return { errors, written: logged.join('\n') };
  } finally {
    await app.close();
  }
}

describe('join recovery through the production logger', () => {
  it.each(['look', 'vault'] as const)(
    'keeps only the database error type/code when the %s query fails, without failing the answer',
    async (stage) => {
      const err = failedQuery();
      // The driver really carries the private values; omission cannot pass on an empty fixture.
      expect(err.message).toContain(PERSON);
      expect(err.message).toContain(WORDS);
      expect(err.message).toContain(SQL);
      const { errors, written } = await readWithLog(stage, err);
      expect(errors[0].err).toEqual({ type: 'DrizzleQueryError', code: 'ECONNRESET' });
      for (const privateValue of [PERSON, WORDS, SQL, 'private driver detail'])
        expect(written).not.toContain(privateValue);
      expect(written).not.toMatch(/"(?:message|stack|query|params|parameters|cause)":/);
      expect(errors[0].msg).toBe(
        stage === 'look'
          ? 'the vaults that hold no plan could not be read: none was joined'
          : 'a vault could not be joined to its plan',
      );
      if (stage === 'vault') expect(errors[0].vault).toBe(address);
    },
  );

  it('preserves the message of an error that is not a database failure', async () => {
    const { errors, written } = await readWithLog('look', new Error('a non-database failure'));
    // The production hook turns an Error into a plain object before pino serializes it.
    expect(errors[0].err).toMatchObject({ type: 'Object', message: 'a non-database failure' });
    expect(written).toContain('a non-database failure');
  });
});
