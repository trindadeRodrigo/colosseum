import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deploymentAssets, SolanaDeploymentRecord } from '@colosseum/chain-solana/vault';
import { compose, type PersonalSheet } from '@colosseum/engine';
import { type AssetCurves, createLiquidityProvider, defaultRegimeParams } from '@colosseum/risk';
import type { BasketAsset } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { DEPLOYMENTS_DIR } from './deployments';
import { YieldObservation } from '@colosseum/schemas';
import { z } from 'zod';
import {
  asSandbox,
  exitTwins,
  type RegistryAsset,
  shelfTiers,
  standIns,
  tierTwins,
  twinSource,
} from './model-exits';
import { modelledTokens, modelYields } from './model-yields';
import { tiersSaid, withTiers } from './orders/personalize';
import readings from './testing/fixtures/model-readings.json';

// The devnet shelf's stand-ins read the sell depth of the mainnet tokens they model. The plan that
// prompted it: grow $20,000 over 63 months at high risk on Solana came out 85% cash, because every
// stand-in took tier C's ceiling of $1,500 (7.5% of $20,000) while SPYx's measured exit at 1% is far
// above what the plan asks of it.

const record = SolanaDeploymentRecord.parse(
  JSON.parse(readFileSync(join(DEPLOYMENTS_DIR, 'solana-devnet.json'), 'utf8')),
);
const shelf = deploymentAssets(record);
const SPYX = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W';
const QQQX = 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ';

const registry: RegistryAsset[] = [
  { assetSymbol: 'SPYx', assetMint: SPYX, tvlUsd: 5_000_000 },
  { assetSymbol: 'SPYx', assetMint: SPYX, tvlUsd: 900_000 },
  { assetSymbol: 'QQQx', assetMint: QQQX, tvlUsd: 400_000 },
  // an EVM registry row under the same name is another family's, never a Solana twin
  { assetSymbol: 'SPYx', assetMint: '0x1111111111111111111111111111111111111111', tvlUsd: 9e9 },
];

const calendar = JSON.parse(
  readFileSync(join(DEPLOYMENTS_DIR, '..', 'fixtures/risk/us-market-holidays.json'), 'utf8'),
);
// A measured curve in every regime: selling $1M costs 1%, so the capacity at 1% is $1M.
const curve = (assetId: string): AssetCurves => {
  const c = {
    points: [100, 10_000, 100_000, 1_000_000, 5_000_000].map((n) => ({
      notionalUsd: n,
      cost: n <= 1_000_000 ? (0.01 * n) / 1_000_000 : 0.05,
      samples: 50,
    })),
    insufficientFrom: null,
    quantile: 0.5,
    minSamples: 8,
    from: '2026-09-29T00:00:00.000Z',
    to: '2026-10-06T00:00:00.000Z',
    samples: 50,
  };
  return {
    assetId,
    byRegime: { us_market_hours: c, us_offhours_weekday: c, weekend: c, us_holiday: c },
  };
};
const providerFor = (ids: string[]) =>
  createLiquidityProvider({
    curves: new Map(ids.map((id) => [id, curve(id)])),
    regimeParams: defaultRegimeParams(calendar),
    methodVersion: 'risk-0.3',
    provenance: 'live',
  });

const sheet: PersonalSheet = {
  basketType: 'standard',
  goal: 'grow',
  amountUsd: 20_000,
  horizonMonths: 63,
  risk: 'high',
  themes: [],
  country: 'BR',
  chains: ['solana'],
  rules: { useHoldings: false, glide: true },
  language: 'en',
};
const planWith = (liquidity?: { provider: ReturnType<typeof providerFor>; source: string }) =>
  compose(
    sheet,
    { version: 'devnet', assets: shelf, families: [] },
    {
      now: '2026-10-06T12:00:00.000Z',
      ...(liquidity ? { liquidity: liquidity.provider, liquiditySource: liquidity.source } : {}),
    },
  );
const rulesOn = (plan: ReturnType<typeof planWith>, id: string) =>
  plan.lines.find((l) => l.assetId === id)?.reasons.map((r) => r.rule) ?? [];

describe('the twins of the devnet stand-ins', () => {
  it('are the registry assets their models name, on the same family of chains', () => {
    const twins = exitTwins(standIns(shelf), registry);
    expect(twins.map((t) => [t.symbol, t.twinSymbol, t.twinMint])).toEqual([
      ['tSPYx', 'SPYx', SPYX],
      ['tQQQx', 'QQQx', QQQX],
    ]);
  });

  it('are found in any case on EVM, where symbols are not spelled one way', () => {
    const token = {
      ...(shelf.find((a) => a.symbol === 'tSPYx') as BasketAsset),
      id: 'robinhood:spy',
      symbol: 'tSPY',
      underlying: 'SPY',
      address: '0xAbCdEf0000000000000000000000000000000001',
    };
    const evm = '0x8F3C0000000000000000000000000000000000Aa';
    expect(
      exitTwins([token], [{ assetSymbol: 'spy', assetMint: evm, tvlUsd: 1 }]).map(
        (t) => t.twinMint,
      ),
    ).toEqual([evm]);
  });

  it('are none for a live token or for cash: only a test-network token stands in', () => {
    const live = shelf.map((a) => ({ ...a, provenance: 'live' as const }));
    expect(exitTwins(standIns(live), registry)).toEqual([]);
    expect(standIns(shelf).some((a) => a.cls === 'cash')).toBe(false);
  });

  it('name whose depth each stand-in reads in the source', () => {
    const twins = exitTwins(standIns(shelf), registry);
    expect(twinSource('Bearing', twins)).toBe(
      'Bearing; mainnet depth applied to the test-network tokens that model it (SPYx for tSPYx, QQQx for tQQQx)',
    );
  });
});

describe('a plan to grow $20,000 on devnet', () => {
  it('without the twins, caps SPY at the tier-C ceiling and holds most of it in cash', () => {
    const plan = planWith();
    const spy = plan.lines.find((l) => l.assetId === 'solana:spyx');
    expect(spy?.weightBps).toBe(750);
    expect(rulesOn(plan, 'solana:spyx')).toContain('TIER_CEILING');
  });

  it('with SPYx’s measured depth, holds tSPYx past the ceiling, labelled sandbox with its twin named', () => {
    const twins = exitTwins(standIns(shelf), registry);
    const ids = twins.map((t) => t.id);
    const plan = planWith({
      provider: asSandbox(providerFor(ids)),
      source: twinSource('Bearing', twins),
    });
    const spy = plan.lines.find((l) => l.assetId === 'solana:spyx');
    expect(spy?.weightBps).toBeGreaterThan(750);
    expect(rulesOn(plan, 'solana:spyx')).not.toContain('TIER_CEILING');
    const read = plan.observations.find((o) => o.kind === 'liquidity' && o.id === 'solana:spyx');
    expect(read?.provenance).toBe('sandbox');
    expect(read?.source).toContain('SPYx for tSPYx');
  });

  it('relabels each leg’s entry as sandbox too', () => {
    const p = asSandbox(providerFor(['solana:spyx']));
    expect(p.provenance).toBe('sandbox');
    expect(
      p.entry('solana:spyx', { tau: 0.01, windowDays: 7, legAmountUsd: 10_000 })?.provenance,
    ).toBe('sandbox');
  });
});

// The plan of the report, made as the server makes it: the stand-ins read their twins' depth, those
// with no measured twin take their model's tier on the mainnet launch shelf, the dollar-yield ones
// their models' yields; SPY and QQQ are index funds (the record's `etf`).
const seed = JSON.parse(
  readFileSync(
    join(DEPLOYMENTS_DIR, '..', 'docs/vault/research/open-questions/launch-shelf.seed.json'),
    'utf8',
  ),
);
const READINGS = z
  .array(z.object({ symbol: z.string(), reading: YieldObservation }))
  .parse(readings);

describe('the plan to grow $20,000 over 63 months at high risk on devnet, as the server makes it', () => {
  const tokens = standIns(shelf);
  const twins = exitTwins(tokens, registry);
  const provider = asSandbox(providerFor(twins.map((t) => t.id)));
  const tiers = tierTwins(
    tokens.filter((t) => !provider.covers(t.id)),
    shelfTiers(seed),
  ).map((t) => ({
    assetId: t.id,
    tier: t.tier,
    source: `tier ${t.tier} of ${t.twinSymbol} on mainnet, applied to the test-network token ${t.symbol}`,
    method: 'launch shelf tier',
    fetchedAt: '2026-10-01T14:00:00.000Z',
    provenance: 'sandbox' as const,
  }));
  const assets = withTiers(shelf, tiers);
  const plan = compose(
    sheet,
    { version: 'devnet', assets, families: [] },
    {
      now: '2026-10-06T12:00:00.000Z',
      liquidity: provider,
      liquiditySource: twinSource('Bearing', twins),
      yields: modelYields(modelledTokens(assets, []), READINGS),
    },
  );
  const weight = (id: string) => plan.lines.find((l) => l.assetId === id)?.weightBps ?? 0;

  it('holds SPY as an index fund, past the tier ceiling and past one stock’s cap', () => {
    expect(assets.find((a) => a.id === 'solana:spyx')?.cls).toBe('etf');
    // the plan of the report held it at 7.5% (tier C); one stock's cap would stop it at 35%
    expect(weight('solana:spyx')).toBeGreaterThan(3500);
    expect(rulesOn(plan, 'solana:spyx')).not.toContain('TIER_CEILING');
    expect(rulesOn(plan, 'solana:spyx')).not.toContain('SINGLE_STOCK_CAP');
  });

  it('gives the dollar-yield stand-ins their models’ tier A: $50,000 a line, not tier C’s $1,500', () => {
    expect(tiers.map((t) => [t.assetId, t.tier])).toEqual(
      expect.arrayContaining([
        ['solana:jlusdc', 'A'],
        ['solana:syrupusdc', 'A'],
      ]),
    );
    const yieldLine = plan.lines.find((l) => l.assetId === 'solana:syrupusdc');
    const ceiling = yieldLine?.reasons.find((r) => r.rule === 'TIER_CEILING');
    expect(ceiling?.params.maxUsd).toBe(50_000);
    // the sleeve the plan asks for (5% at high risk) is held whole, not cut to the ceiling
    expect(weight('solana:syrupusdc')).toBe(500);
  });

  it('keeps cash well under half, every figure labelled sandbox, and says whose tier a line holds', () => {
    // the plan of the report held 85% in cash
    expect(weight('solana:usdc')).toBeLessThan(5000);
    for (const o of plan.observations) expect(o.provenance, `${o.kind} ${o.id}`).toBe('sandbox');
    const said = tiersSaid(
      { lines: plan.lines, flags: plan.flags, observations: plan.observations } as never,
      tiers,
    );
    const held = tiers.filter((t) => weight(t.assetId) > 0);
    expect(held.length).toBeGreaterThan(0);
    for (const t of held) {
      expect(said.flags).toContain(`tier_from_model:${t.assetId}`);
      const o = said.observations.find((x) => x.id === `tier ${t.assetId}`);
      expect(o?.provenance).toBe('sandbox');
      expect(o?.source).toContain('on mainnet, applied to the test-network token');
    }
  });
});
