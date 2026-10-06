import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { isEligible, isExecutable, REGISTRY, REGISTRY_BY_ID, solve } from '@colosseum/engine';
import {
  Asset,
  AssetList,
  type ConstraintSheet,
  Profile,
  type YieldObservation,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { CHAINS } from '../scripts/risk-evm/config';
import { type CutForCollector, listRun } from '../scripts/risk-evm/listed';
import { type CutForSeed, evmAssetRows } from '../scripts/seed-evm';

// PLAN-UNIVERSE RU.8: `pnpm db:seed` writes an `assets` row per tracked EVM stock, from the committed
// asset list and the cut it names (here the cut frozen for RU.4's test). The row's `mint` is the address
// exactly as the collector writes it, and the row offers nothing to a plan: the structurer's answers
// with the rows in the table are the answers without them. No network, no database.
const list = AssetList.parse(
  JSON.parse(readFileSync('scripts/risk/universe/robinhood.json', 'utf8')),
);
const inputs = JSON.parse(
  gunzipSync(
    readFileSync('fixtures/risk/universe/robinhood-list-inputs-20261005T1947.json.gz'),
  ).toString(),
) as { names: { cut: string }; cut: CutForSeed & CutForCollector };
const CUT = inputs.names.cut;
const rows = evmAssetRows(list, inputs.cut, CUT);
const robinhood = CHAINS.find((c) => c.id === 'robinhood');
if (!robinhood) throw new Error('no robinhood chain in config.ts');

describe('the rows of the tracked EVM stocks', () => {
  it('is one row per stock of the list, each a valid asset under the list id', () => {
    expect(rows).toHaveLength(30);
    expect(rows.map((r) => r.id)).toEqual(list.assets.map((a) => a.id));
    for (const r of rows) expect(Asset.safeParse(r).success, r.id).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(30);
    for (const r of rows) expect(REGISTRY_BY_ID.has(r.id), r.id).toBe(false);
  });

  it('spells the address as the collector writes it: the cut, not the list', () => {
    const collector = listRun(robinhood, list, inputs.cut, {
      list: 'robinhood.json',
      cut: CUT,
    }).tokens;
    expect(rows.map((r) => [r.symbol, r.mint])).toEqual(
      collector.map((t) => [t.symbol, t.address]),
    );
    for (const [i, r] of rows.entries())
      expect(r.mint?.toLowerCase()).toBe(list.assets[i]?.address);
    // The list's lower-case form would not join risk_asset_snapshots for 29 of the 30. The registry
    // itself spells LLY in lower case, so the spelling is copied, never worked out as a checksum.
    const asTheListHasIt = rows.filter((r, i) => r.mint === list.assets[i]?.address);
    expect(asTheListHasIt.map((r) => r.symbol)).toEqual(['LLY']);
  });

  it('is the spelling of the hand list for the stocks collected before', () => {
    const byMint = new Map(rows.map((r) => [r.mint, r.symbol]));
    const shared = robinhood.tokens.filter((t) => rows.some((r) => r.symbol === t.symbol));
    expect(shared).toHaveLength(20);
    for (const t of shared) expect(byMint.get(t.address), t.symbol).toBe(t.symbol);
  });

  it('is on an EVM chain, 18 decimals, with the oracle or the reason it has none', () => {
    for (const r of rows) {
      expect(r.chain).toBe('evm');
      expect(r.decimals).toBe(18);
      expect(r.tokenProgram).toBeUndefined();
      expect(r.provenance).toBe('live');
      expect(r.metadata.label).toContain('not offered in a plan');
    }
    const oracle = (s: string) => rows.find((r) => r.symbol === s)?.metadata.oracle;
    expect(oracle('NVDA')).toMatch(/^chainlink 0x[0-9a-f]{40}/);
    expect(oracle('AMC')).toBe('none (no_feed)');
    expect(rows.filter((r) => r.metadata.oracle?.startsWith('none'))).toHaveLength(6);
  });

  it('refuses a cut that is not the one the list names, or that disagrees with it', () => {
    expect(() => evmAssetRows(list, inputs.cut, 'cut-robinhood-other.json')).toThrow(
      /written from/,
    );
    expect(() => evmAssetRows(list, { ...inputs.cut, chain: 'base' }, CUT)).toThrow(/for base/);
    const tracked = inputs.cut.tracked;
    expect(() => evmAssetRows(list, { ...inputs.cut, tracked: tracked.slice(1) }, CUT)).toThrow(
      /not tracked/,
    );
    const renamed = tracked.map((t, i) => (i === 0 ? { ...t, symbol: 'OTHER' } : t));
    expect(() => evmAssetRows(list, { ...inputs.cut, tracked: renamed }, CUT)).toThrow(
      /in the cut/,
    );
  });
});

// Fixture yields (fixtures are the one place literals may live): as tests/solver.test.ts has them.
const obs = (assetId: string, method: string, quoted: number): [string, YieldObservation] => [
  assetId,
  {
    assetId,
    quotedYield: quoted,
    haircutYield: quoted,
    haircutRule: 'fixture',
    source: 'fixture',
    method,
    fetchedAt: '2026-09-30T00:00:00.000Z',
    provenance: 'fixture',
  },
];
const yields = new Map([
  obs('kamino-usdc', 'protocol_api', 0.04),
  obs('usdy', 'realised_30d', 0.05),
  obs('syrupusdc', 'realised_30d', 0.055),
]);
const sheet = (profile: Profile): ConstraintSheet => ({
  language: 'en',
  currency: 'BRL',
  profile,
  target: { kind: 'balance', amountBrl: 500_000, byMonth: '2031-10' },
  horizonMonths: 60,
  liquidityWindowDays: 30,
  riskBudget: 'high',
  creditTolerance: 'accept',
  fxStance: 'accept_fx',
});
const plan = (assets: Asset[], profile: Profile, chain?: 'solana' | 'evm') =>
  solve({
    sheet: sheet(profile),
    capitalUsd: 100_000,
    assets,
    yields,
    fxUsdBrl: 5.2,
    nowMonth: '2026-10',
    chain,
  });

describe('a seeded row does not widen what the structurer offers', () => {
  it('is eligible under no profile and is never executed (the registry rule)', () => {
    for (const r of rows) {
      expect(r.kind).toBe('equity');
      expect(r.eligibleProfiles).toEqual([]);
      expect(r.capWeight).toBe(0);
      for (const p of Profile.options) expect(isEligible(r, p), `${r.id} ${p}`).toBe(false);
      expect(isExecutable(r)).toBe(false);
    }
  });

  it('leaves every plan as it is: the registry with the rows solves as the registry alone', () => {
    for (const p of Profile.options) {
      const alone = plan(REGISTRY, p);
      expect(plan([...REGISTRY, ...rows], p)).toEqual(alone);
      expect(plan([...rows, ...REGISTRY], p)).toEqual(alone);
    }
    expect(plan(REGISTRY, 'high_risk').legs.some((l) => l.assetId === 'spyx')).toBe(true);
  });

  it('holds even if a row is edited to name a profile: another chain is never in the plan (ONE-CHAIN)', () => {
    // what the solver would have done with such a row before: 30 more stocks in the equity split, and
    // a cap of 0 on any of them taking SPYx and QQQx to nothing
    for (const capWeight of [0, 0.3]) {
      const edited = rows.map((r) => ({
        ...r,
        eligibleProfiles: [...Profile.options],
        mintPath: 'dex_swap' as const,
        capWeight,
      }));
      for (const p of Profile.options)
        expect(plan([...REGISTRY, ...edited], p)).toEqual(plan(REGISTRY, p));
    }
  });

  it('a stock stays out of an income plan on any chain', () => {
    const edited = rows.map((r) => ({
      ...r,
      eligibleProfiles: [...Profile.options],
      capWeight: 0.3,
    }));
    const legs = plan([...REGISTRY, ...edited], 'income', 'evm').legs;
    expect(legs.filter((l) => edited.some((r) => r.id === l.assetId))).toEqual([]);
  });
});
