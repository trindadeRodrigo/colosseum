import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvmDeploymentRecord, deploymentAssets as evmAssets } from '@colosseum/chain-evm/vault';
import { deploymentAssets, SolanaDeploymentRecord } from '@colosseum/chain-solana/vault';
import { compose, type PersonalSheet } from '@colosseum/engine';
import { type AssetCurves, createLiquidityProvider, defaultRegimeParams } from '@colosseum/risk';
import { type BasketAsset, type LiquidityProvider, YieldObservation } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEPLOYMENTS_DIR } from './deployments';
import { asSandbox, isMeasured, issuerTwins, shelfTiers, standIns, tierTwins } from './model-exits';
import { modelledTokens, modelYields } from './model-yields';
import { tiersSaid, withTiers } from './orders/personalize';
import readings from './testing/fixtures/model-readings.json';

// An income plan on a test network, as the server makes it (gate ENG-DEVNET-EXIT-TWIN). The plan that
// prompted it: "earn income from $80,000 for 12 months" on devnet held 25% tsyrupUSDC and 75% cash.
// tjlUSDC had no reading (nothing read jlUSDC's yield), and every stand-in was one issuer, "test
// network", so the cap on one issuer held all dollar yield and gold to half together. A stand-in now
// takes its model's reading, its model's tier and its model's issuer, each labelled.

const read = (file: string) => JSON.parse(readFileSync(join(DEPLOYMENTS_DIR, file), 'utf8'));
const READINGS = z
  .array(z.object({ symbol: z.string(), chain: z.string(), reading: YieldObservation }))
  .parse(readings);
const SHELF = shelfTiers(read('../fixtures/risk/launch-shelf-tiers.json'));

const sheet = (
  chain: 'solana' | 'robinhood',
  amountUsd: number,
  goal: 'income' | 'protect' = 'income',
): PersonalSheet => ({
  basketType: 'standard',
  goal,
  amountUsd,
  horizonMonths: 12,
  risk: 'medium',
  themes: [],
  country: 'BR',
  chains: [chain],
  rules: { useHoldings: false, glide: true },
  language: 'en',
});

/** The plan as `personalize` makes it from the plan inputs, with no measured depth (none is stored for a yield token). */
function serverPlan(
  chain: 'solana' | 'robinhood',
  listed: BasketAsset[],
  amountUsd: number,
  goal: 'income' | 'protect' = 'income',
  provider?: LiquidityProvider,
) {
  const tokens = standIns(listed, 'sandbox');
  const tiers = tierTwins(
    tokens.filter((t) => !isMeasured(provider, t.id, 0.01, 7)),
    SHELF,
  ).map((t) => ({
    assetId: t.id,
    tier: t.tier,
    source: `tier ${t.tier} of ${t.twinSymbol} on mainnet, applied to the test-network token ${t.symbol}`,
    method: 'launch shelf tier',
    fetchedAt: '2026-10-01T14:00:00.000Z',
    provenance: 'sandbox' as const,
  }));
  const issuers = issuerTwins(tokens, SHELF).map((t) => ({
    assetId: t.id,
    issuer: t.issuer,
    of: t.twinSymbol,
  }));
  const assets = withTiers(listed, tiers, issuers);
  const plan = compose(
    sheet(chain, amountUsd, goal),
    { version: 'test-network', assets, families: [] },
    {
      now: '2026-10-06T12:00:00.000Z',
      yields: modelYields(modelledTokens(assets, [], 'sandbox'), READINGS),
      ...(provider ? { liquidity: provider, liquiditySource: 'Bearing (test)' } : {}),
    },
  );
  const weight = (id: string) => plan.lines.find((l) => l.assetId === id)?.weightBps ?? 0;
  return { plan, assets, tiers, issuers, weight };
}

describe('an income plan of $80,000 over 12 months on Solana devnet', () => {
  const listed = deploymentAssets(SolanaDeploymentRecord.parse(read('solana-devnet.json')));
  const { plan, assets, issuers, tiers, weight } = serverPlan('solana', listed, 80_000);

  it('counts each stand-in under its model’s issuer, not one "test network" for all', () => {
    const issuerOf = (id: string) => assets.find((a) => a.id === id)?.issuer;
    expect(issuerOf('solana:jlusdc')).toBe('Jupiter Lend');
    expect(issuerOf('solana:syrupusdc')).toBe('Maple');
    expect(issuerOf('solana:spyx')).toBe('Backed (xStocks)');
    // tPAXG's model is on no mainnet shelf row: it keeps the test network's name
    expect(issuerOf('solana:paxg')).toBe('test network');
  });

  it('holds both dollar-yield stand-ins, well above the 25% the report’s plan held, and less cash', () => {
    const held = plan.lines.map((l) => l.assetId);
    expect(held).toContain('solana:jlusdc');
    expect(held).toContain('solana:syrupusdc');
    expect(plan.removed.map((r) => r.ref)).not.toContain('tjlUSDC');
    const yieldBps = weight('solana:jlusdc') + weight('solana:syrupusdc');
    expect(yieldBps).toBeGreaterThanOrEqual(7000);
    // the credit budget still holds the credit leg to a quarter, as on mainnet
    expect(weight('solana:syrupusdc')).toBeLessThanOrEqual(2500);
    expect(weight('solana:usdc')).toBeLessThanOrEqual(3000);
  });

  it('labels every figure sandbox and says whose tier and whose issuer a line stands on', () => {
    for (const o of plan.observations) expect(o.provenance, `${o.kind} ${o.id}`).toBe('sandbox');
    const said = tiersSaid(
      { lines: plan.lines, flags: plan.flags, observations: plan.observations } as never,
      tiers,
      issuers,
    );
    expect(said.flags).toContain('issuer_from_model:solana:jlusdc:jlUSDC');
    expect(said.flags).toContain('issuer_from_model:solana:syrupusdc:syrupUSDC');
    expect(said.flags).toContain('tier_from_model:solana:jlusdc');
  });
});

describe('an income plan on Robinhood Chain’s test network', () => {
  const listed = evmAssets(EvmDeploymentRecord.parse(read('robinhood-testnet.json')));
  const { plan, assets, weight } = serverPlan('robinhood', listed, 20_000);

  // Without its leg-type row (tSGOV typed as SGOV is, a rate leg) the engine leaves it out: its kind is
  // never guessed.
  it('holds tSGOV on SGOV’s reading, counted under Robinhood as on mainnet', () => {
    const id = assets.find((a) => a.symbol === 'tSGOV')?.id as string;
    expect(assets.find((a) => a.id === id)?.issuer).toBe('Robinhood');
    expect(weight(id)).toBeGreaterThan(0);
    expect(plan.removed.map((r) => r.ref)).not.toContain('tSGOV');
    const y = plan.observations.find((o) => o.kind === 'yield' && o.id === id);
    expect(y?.provenance).toBe('sandbox');
    expect(y?.source).toContain('applied to tSGOV on a test network');
  });
});

describe('what a chain that is not a test network borrows', () => {
  const listed = deploymentAssets(SolanaDeploymentRecord.parse(read('solana-devnet.json')));

  it('is nothing: no issuer, no tier and no reading, whatever its tokens are labelled', () => {
    for (const provenance of ['mock', 'live', undefined]) {
      const tokens = standIns(listed, provenance);
      expect(issuerTwins(tokens, SHELF)).toEqual([]);
      expect(tierTwins(tokens, SHELF)).toEqual([]);
      expect(modelYields(modelledTokens(listed, [], provenance), READINGS)).toEqual([]);
    }
  });

  it('nor does a stand-in take the reading of its model on another chain', () => {
    const rh = evmAssets(EvmDeploymentRecord.parse(read('robinhood-testnet.json')));
    const base = READINGS.map((r) => (r.symbol === 'SGOV' ? { ...r, chain: 'base' } : r));
    const borrowed = modelYields(modelledTokens(rh, [], 'sandbox'), base);
    expect(borrowed.map((y) => y.assetId)).not.toContain('robinhood:tsgov');
  });
});

describe('two stand-ins of one issuer', () => {
  it('share that issuer’s cap: on Robinhood Chain tSGOV and tGLD hold half a plan to protect together', () => {
    const listed = evmAssets(EvmDeploymentRecord.parse(read('robinhood-testnet.json')));
    const { plan, assets, weight } = serverPlan('robinhood', listed, 20_000, 'protect');
    const sgov = assets.find((a) => a.symbol === 'tSGOV') as BasketAsset;
    const gld = assets.find((a) => a.symbol === 'tGLD') as BasketAsset;
    expect([sgov.issuer, gld.issuer]).toEqual(['Robinhood', 'Robinhood']);
    expect(weight(sgov.id)).toBeGreaterThan(0);
    expect(weight(gld.id)).toBeGreaterThan(0);
    expect(weight(sgov.id) + weight(gld.id)).toBe(5000);
    expect(plan.lines.flatMap((l) => l.reasons.map((r) => r.rule))).toContain('ISSUER_CAP_PLAN');
  });
});

// On the hosted API after #133, Robinhood Chain's plans were still mostly cash (income 98%, protect 94%,
// grow 85%): its twins' curves were there, from the collector's first two runs, but too thin to read,
// so no tier was borrowed and every stand-in fell back to the test network's own tier C.
describe('a twin whose curves are too thin to read', () => {
  const listed = evmAssets(EvmDeploymentRecord.parse(read('robinhood-testnet.json')));
  // two samples a point where eight are needed: every point of the curve is insufficient
  const thin = (assetId: string): AssetCurves => {
    const c = {
      points: [100, 10_000, 1_000_000].map((n) => ({ notionalUsd: n, cost: 0.001, samples: 2 })),
      insufficientFrom: 0,
      quantile: 0.5,
      minSamples: 8,
      from: '2026-10-06T20:07:54.000Z',
      to: '2026-10-06T20:09:31.000Z',
      samples: 16,
    };
    return { assetId, byRegime: { us_offhours_weekday: c } };
  };
  const provider = asSandbox(
    createLiquidityProvider({
      curves: new Map(standIns(listed, 'sandbox').map((t) => [t.id, thin(t.id)])),
      regimeParams: defaultRegimeParams(read('../fixtures/risk/us-market-holidays.json')),
      methodVersion: 'risk-0.3',
      provenance: 'live',
    }),
  );

  it('is covered and not measured, so the stand-in still takes its model’s tier', () => {
    expect(provider.covers('robinhood:tsgov')).toBe(true);
    expect(isMeasured(provider, 'robinhood:tsgov', 0.01, 7)).toBe(false);
    expect(isMeasured(undefined, 'robinhood:tsgov', 0.01, 7)).toBe(false);
    const { tiers } = serverPlan('robinhood', listed, 80_000, 'income', provider);
    expect(tiers.find((t) => t.assetId === 'robinhood:tsgov')?.tier).toBe('A');
  });

  it('and the $80,000 income plan holds tSGOV at its 40% cap, not at tier C’s $1,500', () => {
    const { weight } = serverPlan('robinhood', listed, 80_000, 'income', provider);
    expect(weight('robinhood:tsgov')).toBe(4000);
  });
});
