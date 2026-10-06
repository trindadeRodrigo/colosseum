import { AssetId, BasketAsset, YieldObservation } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { candidates } from './index';
import { LEG_TYPES } from './leg-types';
import {
  assetId,
  extendedContext,
  extendedHeldOut,
  extendedRows,
  extendedShelf,
  extendedYields,
  fixtureYields,
  launchShelf,
  readExtendedFile,
  shelfGrid,
  violations,
} from './testing';

// The extended shelf (docs/vault/PROMPT-YIELD-SHELF.md, part (a)): the launch shelf plus the
// fixed-income tokens screened in docs/vault/research/yield-shelf/, for testing only. What holds for
// every row, whatever the chain: the rows are data, and these tests read them as they are written.
// Each chain's own expectations are in extended-shelf.<chain>.test.ts.

const NOTE = 'docs/vault/research/yield-shelf/';
const launch = launchShelf();
const extended = extendedShelf();
const rows = extendedRows();
const inPlans = rows.filter((row) => row.heldOut === undefined);
const PLACEHOLDER = ['11111111111111111111111111111111', `0x${'0'.repeat(40)}`];

const sample = {
  id: 'solana:sample',
  chain: 'solana',
  address: '11111111111111111111111111111111',
  symbol: 'SAMPLE',
  decimals: 6,
  cls: 'dollar_yield',
  underlying: 'SAMPLE',
  issuer: 'Sample issuer',
  tier: 'B',
  priceKind: 'none',
  priceRef: '',
  session: 'always',
  autoFollowEligible: false,
  maxWeightBps: 5000,
  blockedCountries: ['US'],
  sheet: 'sample',
  provenance: 'fixture',
};
const file = (row: Record<string, unknown>) => ({
  chain: 'solana',
  note: `${NOTE}solana.md`,
  readAt: '2026-10-06',
  rows: [{ asset: sample, verdict: 'add', source: `${NOTE}solana.md, SAMPLE`, ...row }],
});

describe('a file of the extended shelf', () => {
  it('reads a row a plan may hold, and one held out with its reason and its maturity', () => {
    expect(readExtendedFile(file({})).rows[0]?.unverified).toEqual([]);
    const held = readExtendedFile(
      file({ verdict: 'hold', heldOut: 'no maturity in the schedule yet', maturity: '2027-03-25' }),
    ).rows[0];
    expect(held?.heldOut).toBe('no maturity in the schedule yet');
    expect(held?.maturity).toBe('2027-03-25');
  });

  it('refuses a key it does not know, a hold with no reason, another chain, and a row not a fixture', () => {
    expect(() => readExtendedFile(file({ note: 'x' }))).toThrow();
    expect(() => readExtendedFile(file({ verdict: 'hold' }))).toThrow(
      /on hold and gives no reason/,
    );
    expect(() => readExtendedFile({ ...file({}), chain: 'robinhood' })).toThrow(/in the file of/);
    expect(() => readExtendedFile(file({ asset: { ...sample, provenance: 'live' } }))).toThrow(
      /not marked a fixture/,
    );
    expect(() => readExtendedFile(file({ verdict: 'out' }))).toThrow();
  });

  it('holds a row in plans to the whole shared type, and lets only a row held out carry a currency', () => {
    // The shared type refuses a token that is not cash and is counted in its own currency.
    const bond = { ...sample, currency: 'BRL' };
    expect(() => readExtendedFile(file({ asset: bond }))).toThrow();
    const held = readExtendedFile(
      file({ asset: bond, verdict: 'hold', heldOut: 'not a cash leg' }),
    );
    expect(held.rows[0]?.asset.currency).toBe('BRL');
  });
});

describe('the extended shelf', () => {
  it('is the launch shelf, unchanged, with the rows a plan may hold after it', () => {
    expect(extended.assets.slice(0, launch.assets.length)).toEqual(launch.assets);
    expect(extended.families).toEqual(launch.families);
    expect(extended.assets.slice(launch.assets.length).map((a) => a.id)).toEqual(
      inPlans.map((row) => row.asset.id),
    );
    expect(extended.version).not.toBe(launch.version);
    expect(new Set(extended.assets.map((a) => a.id)).size).toBe(extended.assets.length);
  });

  it('lists each row once, on Solana or Robinhood Chain, as a fixture read from the research note', () => {
    expect(new Set(rows.map((row) => row.asset.id)).size).toBe(rows.length);
    for (const row of rows) {
      const a = row.asset;
      // The id is the chain and the symbol, as on the launch shelf; a symbol an id cannot spell
      // (USD*) still gets an id of its chain.
      expect(AssetId.safeParse(a.id).success, a.id).toBe(true);
      expect(a.id.startsWith(`${a.chain}:`), a.id).toBe(true);
      if (/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(a.symbol))
        expect(a.id, a.id).toBe(assetId(a.chain, a.symbol));
      expect(['solana', 'robinhood'], a.id).toContain(a.chain);
      expect(a.provenance, a.id).toBe('fixture');
      expect(row.source, a.id).toContain(`${NOTE}${a.chain}.md`);
      // A stand-in address is said to be one: a mint or contract is never passed off as verified.
      if (PLACEHOLDER.includes(a.address))
        expect(row.unverified.join(' '), a.id).toMatch(/address|mint|contract/);
    }
  });

  it('holds every row a plan may hold as a BasketAsset in dollar yield, with its leg types', () => {
    for (const row of inPlans) {
      const a = BasketAsset.parse(row.asset);
      expect(a.cls, a.id).toBe('dollar_yield');
      expect(a.currency, a.id).toBeUndefined();
      const leg = LEG_TYPES[a.symbol];
      expect(leg, `${a.id} has no leg type`).toBeDefined();
      expect(leg?.types.length, a.id).toBeGreaterThan(0);
      expect(leg?.source.length, a.id).toBeGreaterThan(0);
      expect(leg?.readAt, a.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('keeps a row held out off the shelf the engine takes, with its reason', () => {
    const ids = new Set(extended.assets.map((a) => a.id));
    for (const row of extendedHeldOut()) {
      expect(ids.has(row.asset.id), row.asset.id).toBe(false);
      expect(row.heldOut?.length, row.asset.id).toBeGreaterThan(0);
    }
  });
});

describe('the yields of the extended shelf', () => {
  const added = extendedYields().slice(fixtureYields().length);

  it('are the fixture yields, unchanged, with the dated claims of the research after them', () => {
    expect(extendedYields().slice(0, fixtureYields().length)).toEqual(fixtureYields());
  });

  it('each name a token of the extended shelf, a source in the research note and the day it was read', () => {
    const byId = new Map(rows.map((row) => [row.asset.id, row]));
    expect(new Set(added.map((y) => y.assetId)).size).toBe(added.length);
    for (const y of added) {
      expect(() => YieldObservation.parse(y), y.assetId).not.toThrow();
      const row = byId.get(y.assetId);
      expect(row, `${y.assetId} is not on the extended shelf`).toBeDefined();
      expect(y.provenance, y.assetId).toBe('fixture');
      expect(y.source ?? '', y.assetId).toContain(`${NOTE}${row?.asset.chain}.md`);
      expect(y.fetchedAt ?? '', y.assetId).toMatch(/^2026-\d{2}-\d{2}T/);
      expect(y.method, y.assetId).toMatch(/not_a_reading$/);
      expect(y.haircutRule.length, y.assetId).toBeGreaterThan(0);
      expect(y.haircutYield, y.assetId).toBeLessThanOrEqual(y.quotedYield);
    }
  });
});

describe('plans on the extended shelf', () => {
  const ctx = extendedContext();
  it.each(['solana', 'robinhood'] as const)(
    'on %s, every candidate of every goal of the grid is a plan in order',
    (chain) => {
      const heldOut = new Set(extendedHeldOut(chain).map((row) => row.asset.id));
      for (const s of shelfGrid(chain)) {
        const answer = candidates(s, extended, ctx);
        expect(answer.shown.length, `${s.goal}:${s.risk}:${s.amountUsd}`).toBeGreaterThan(0);
        for (const { id, plan } of answer.shown) {
          expect(
            violations(plan, extended, ctx),
            `${id} ${s.goal}:${s.risk}:${s.amountUsd}`,
          ).toEqual([]);
          for (const line of plan.lines) expect(heldOut.has(line.assetId)).toBe(false);
        }
      }
    },
  );
});
