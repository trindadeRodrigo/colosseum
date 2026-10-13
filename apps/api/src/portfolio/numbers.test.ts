import type { Db } from '@colosseum/db';
import type { Principal } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import type { ChainEntry } from '../orders/chains';
import { nextNumbers, oldestFirst, type Unnumbered, vaultNumbersOf } from './numbers';
import type { PersonScope } from './scope';

// The order vaults are numbered in and the numbers they take (gate VAULT-NUMBER), with no database.
// What the routes answer, and that a number never changes, is routes/v1/vault-number.test.ts.

const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const vault = (chain: Unnumbered['chain'], address: string, openedAt: Date | null): Unnumbered => ({
  chain,
  address,
  openedAt,
});

describe('the order vaults are numbered in', () => {
  it('is the opening order’s time, whatever the chain, and a vault no order opened comes last', () => {
    const fresh = [
      vault('solana', 'S-outside', null),
      vault('solana', 'S-late', at(9)),
      vault('robinhood', '0xearly', at(2)),
      vault('solana', 'S-mid', at(5)),
      vault('robinhood', '0xoutside', null),
    ];
    expect(oldestFirst(fresh).map((v) => v.address)).toEqual([
      '0xearly',
      'S-mid',
      'S-late',
      '0xoutside',
      'S-outside',
    ]);
  });

  it('breaks a tie by chain and then by address, so it does not depend on the order read', () => {
    const tied = [
      vault('solana', 'B', at(3)),
      vault('solana', 'A', at(3)),
      vault('robinhood', '0xz', at(3)),
    ];
    const want = ['0xz', 'A', 'B'];
    expect(oldestFirst(tied).map((v) => v.address)).toEqual(want);
    expect(oldestFirst([...tied].reverse()).map((v) => v.address)).toEqual(want);
  });
});

describe('the numbers vaults take', () => {
  it('start at 1 for a person with none', () => {
    expect(
      nextNumbers([], [vault('solana', 'B', at(2)), vault('robinhood', '0xa', at(1))]),
    ).toEqual([
      { chain: 'robinhood', address: '0xa', number: 1 },
      { chain: 'solana', address: 'B', number: 2 },
    ]);
  });

  it('go on after the highest one given, also for a vault older than every numbered one', () => {
    expect(nextNumbers([1, 2], [vault('robinhood', '0xold', at(1))])).toEqual([
      { chain: 'robinhood', address: '0xold', number: 3 },
    ]);
  });

  it('never fill a number that was given and is no longer shown', () => {
    expect(nextNumbers([1, 4], [vault('solana', 'A', null)]).map((v) => v.number)).toEqual([5]);
  });

  it('are none where there is no vault to number', () => {
    expect(nextNumbers([1, 2], [])).toEqual([]);
  });
});

describe('the numbers of a person’s vaults', () => {
  const scope: PersonScope = {
    chains: [{ entry: { chain: 'solana', provenance: 'mock' } as ChainEntry, owners: ['owner'] }],
    unavailable: [],
  };
  const person: Principal = { kind: 'user', userId: 'did:privy:test', wallets: [], ip: '::1' };
  const quiet = { warn: () => {}, error: () => {} };
  /** A database that must not be asked anything. */
  const untouched = new Proxy({} as Db, {
    get: () => {
      throw new Error('the database was asked');
    },
  });

  it('are none, and the read goes on, where the database cannot be read', async () => {
    const said: string[] = [];
    const numbers = await vaultNumbersOf(untouched, scope, person, {
      warn: () => {},
      error: (_fields, message) => said.push(message),
    });
    expect(numbers.of('solana', 'anything')).toBeUndefined();
    expect(said).toHaveLength(1);
    // And the log is not told again by the next read: a table that is not there fails every one.
    const again: string[] = [];
    await vaultNumbersOf(untouched, scope, person, {
      warn: () => {},
      error: (_fields, message) => again.push(message),
    });
    expect(again).toEqual([]);
  });

  it('are the ones already held where a new one cannot be given: only that vault has none', async () => {
    // What the two reads answer, in turn: the person's vaults, then the numbers they have.
    const answers: unknown[] = [
      [
        { chain: 'solana', address: 'A', owner: 'owner', basketId: '1', openedAt: at(1) },
        { chain: 'solana', address: 'B', owner: 'owner', basketId: '2', openedAt: at(2) },
      ],
      [{ chain: 'solana', address: 'A', number: 1 }],
    ];
    const query: unknown = new Proxy(
      {},
      {
        get: (_target, key) =>
          key === 'then' ? (done: (rows: unknown) => void) => done(answers.shift()) : () => query,
      },
    );
    const db = {
      select: () => query,
      transaction: async () => {
        throw new Error('the insert was refused');
      },
    } as unknown as Db;
    const numbers = await vaultNumbersOf(db, scope, person, quiet);
    expect(numbers.of('solana', 'A')).toBe(1);
    expect(numbers.of('solana', 'B')).toBeUndefined();
    expect(answers).toEqual([]);
  });

  it('are none, with nothing read, for a caller who is no signed-in person or holds no chain here', async () => {
    for (const who of [
      { ...person, kind: 'anon' as const },
      { ...person, userId: undefined },
    ])
      expect(
        (await vaultNumbersOf(untouched, scope, who, quiet)).of('solana', 'x'),
      ).toBeUndefined();
    const nowhere = { chains: [], unavailable: [] };
    expect(
      (await vaultNumbersOf(untouched, nowhere, person, quiet)).of('solana', 'x'),
    ).toBeUndefined();
  });
});
