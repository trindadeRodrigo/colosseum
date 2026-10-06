import { BasketInputError } from '@colosseum/basket';
import { ChainError, type VaultView } from '@colosseum/schemas';
import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { reasonOf, said, sayer } from './pass';
import { cutToCents, SNAPSHOT_METHOD, snapshotRow } from './store';

// The parts of a pass that need no chain and no database: how a failure is put in words, what a line
// carries, and what a row is made of. The passes themselves are in pipeline.test.ts.

const NODE = 'https://node.example/key-in-the-path';
const hide = (text: string) => text.split(NODE).join('<SOLANA_RPC_URL>');

describe('a reason', () => {
  it("is an error's code and message, and never its cause or its stack", () => {
    const transport = new Error(`HTTP request failed.\n\nURL: ${NODE}`);
    const refused = Object.assign(new ChainError('Unavailable', 'the node did not answer'), {
      cause: transport,
    });
    expect(reasonOf(refused)).toBe('Unavailable: the node did not answer');
    expect(reasonOf(new BasketInputError('CashNotListed', 'the cash token is not listed'))).toBe(
      'CashNotListed: the cash token is not listed',
    );
    expect(reasonOf(new Error('plain'))).toBe('plain');
    expect(reasonOf('not an error')).toBe('not an error');
  });

  it('says a query the database refused by its code, not by the query and what it carried', () => {
    const refused = new DrizzleQueryError(
      'insert into "vault_snapshots" values ($1)',
      ['an owner address'],
      Object.assign(new Error(`connect ECONNREFUSED at ${NODE}`), { code: 'ECONNREFUSED' }),
    );
    expect(reasonOf(refused)).toBe('the database did not take a query (ECONNREFUSED)');
    expect(reasonOf(new DrizzleQueryError('select 1', []))).toBe(
      'the database did not take a query',
    );
  });

  it('goes through hide before it is cut, keeps its first line, and has a length', () => {
    const ctx = { hide };
    expect(said(ctx, new ChainError('Unavailable', `request to ${NODE} failed`))).toBe(
      'Unavailable: request to <SOLANA_RPC_URL> failed',
    );
    // What a library's error says after its first line is where it names what it called.
    expect(said(ctx, new Error('HTTP request failed.\n\nURL: https://other.example/key'))).toBe(
      'HTTP request failed.',
    );
    // An address that straddles the cut is taken out whole first: no half of it is left.
    const long = said(ctx, new Error(`${'x'.repeat(290)} ${NODE} after`));
    expect(long).toHaveLength(303);
    expect(long.endsWith('...')).toBe(true);
    expect(long).not.toContain('node.example');
    expect(long).toContain('<SOLANA_R');
  });
});

describe('a line', () => {
  it('carries its time, the chain and its name before anything else', () => {
    const lines: string[] = [];
    const say = sayer(
      { out: (line) => lines.push(line), now: () => new Date('2026-10-06T12:00:00.000Z') },
      { chain: 'solana', name: 'Solana devnet' },
    );
    say({ pass: 'done', read: 2, failed: 0, skipped: 1, dryRun: false });
    expect(lines).toEqual([
      '{"at":"2026-10-06T12:00:00.000Z","chain":"solana","name":"Solana devnet","pass":"done","read":2,"failed":0,"skipped":1,"dryRun":false}',
    ]);
  });
});

describe('a row', () => {
  it('cuts dollars to cents and never rounds them up', () => {
    expect(cutToCents('599.999999')).toBe('599.99');
    expect(cutToCents('600')).toBe('600.00');
    expect(cutToCents('0.5')).toBe('0.50');
    expect(cutToCents('1058.940000')).toBe('1058.94');
  });

  it('is the view, the prices it stood on, the rules and the height, under the label of the source', () => {
    const price = {
      source: 'a price account',
      method: 'value / 10^exponent',
      fetchedAt: '2026-10-06T12:00:00.000Z',
      provenance: 'sandbox' as const,
      asset: 'solana:spy',
      usdPerToken: '100',
      ageSeconds: 3,
      maxAgeSeconds: 120,
      market: 'open' as const,
    };
    const seen: VaultView = {
      chain: 'solana',
      address: 'Vau1t',
      owner: 'Owner',
      basketId: '42',
      recipeOnchainId: 'Recipe',
      acceptedVersion: 2,
      autoFollow: true,
      keeper: 'Keeper',
      cash: { asset: 'solana:usdc', raw: '1000000', multiplier: '1', display: '1' },
      positions: [
        {
          asset: 'solana:spy',
          raw: '599999999',
          multiplier: '1',
          display: '5.99999999',
          targetBps: 10_000,
          lastKeeperAt: null,
          valueUsd: '599.999999',
          weightBps: 9_984,
          driftBps: -16,
        },
      ],
      lossUsedBps: 7,
      observedAt: '2026-10-06T12:00:01.000Z',
      pending: { version: 3, effectiveAt: 1_790_000_000, newAssets: [] },
      valueUsd: '600.999999',
    };
    const row = snapshotRow({
      source: {
        chain: 'solana',
        provenance: 'sandbox',
        source: 'Solana devnet, read over RPC by the vault reader',
      },
      seen,
      prices: [price],
      rules: { paused: false, lossCapBps: 100, bandBps: 50 },
      height: 412_345_678n,
      basketId: null,
    });
    expect(row).toEqual({
      chainId: 'solana',
      address: 'Vau1t',
      observedAt: new Date('2026-10-06T12:00:01.000Z'),
      blockOrSlot: '412345678',
      owner: 'Owner',
      basketId: null,
      onchainBasketId: '42',
      recipeOnchainId: 'Recipe',
      acceptedVersion: 2,
      autoFollow: true,
      valueUsd: '600.99',
      cash: seen.cash,
      positions: seen.positions,
      pending: seen.pending,
      lossUsedBps: 7,
      bandBps: 50,
      lossCapBps: 100,
      paused: false,
      prices: [price],
      provenance: 'sandbox',
      source: 'Solana devnet, read over RPC by the vault reader',
      method: SNAPSHOT_METHOD,
    });
    // A chain that cannot say its height, and has no rules, leaves them empty rather than zero.
    const bare = snapshotRow({
      source: { chain: 'solana', provenance: 'mock', source: 'chain-mock' },
      seen,
      prices: [],
      rules: { paused: null, lossCapBps: null, bandBps: null },
      height: null,
      basketId: null,
    });
    expect([bare.blockOrSlot, bare.bandBps, bare.lossCapBps, bare.paused]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});
