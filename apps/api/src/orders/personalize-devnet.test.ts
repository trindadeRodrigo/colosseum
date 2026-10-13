import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deploymentAssets, SolanaDeploymentRecord } from '@colosseum/chain-solana/vault';
import { compose, type PersonalSheet } from '@colosseum/engine';
import { YieldObservation } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEPLOYMENTS_DIR } from '../deployments';
import { type ModelReading, modelledTokens, modelYields } from '../model-yields';
import readings from '../testing/fixtures/model-readings.json';

// The shelf the API lists on devnet is the deploy's record (`deploymentAssets`): tPAXG is gold whose
// underlying is PAXG, and tGLDx is retired. A plan to protect there holds tPAXG (gate GOLD-PAXG).

const record = SolanaDeploymentRecord.parse(
  JSON.parse(readFileSync(join(DEPLOYMENTS_DIR, 'solana-devnet.json'), 'utf8')),
);
const assets = deploymentAssets(record);

describe('gold on the devnet shelf', () => {
  it('is tPAXG, and a plan to protect holds it', () => {
    expect(assets.filter((a) => a.cls === 'gold').map((a) => [a.symbol, a.underlying])).toEqual([
      ['tPAXG', 'PAXG'],
    ]);
    const plan = compose(
      {
        basketType: 'standard',
        goal: 'protect',
        amountUsd: 2_000,
        horizonMonths: 18,
        // At high risk: every token on devnet has one issuer, "test network".
        risk: 'high',
        themes: [],
        country: 'BR',
        chains: ['solana'],
        rules: { useHoldings: false, glide: true },
        language: 'en',
      },
      { version: 'devnet', assets, families: [] },
      { now: '2026-10-05T12:00:00.000Z' },
    );
    expect(plan.lines.find((l) => l.assetId === 'solana:paxg')?.weightBps).toBe(2500);
    // No yield reading is handed in, and a missing yield is never counted as zero (ENG-3 slice 1):
    // the two dollar-yield stand-ins are left out, and the plan says why.
    expect(plan.removed.map((r) => [r.ref, r.reasons.map((x) => x.rule)])).toEqual([
      ['tjlUSDC', ['NO_YIELD']],
      ['tsyrupUSDC', ['NO_YIELD']],
    ]);
  });
});

// The two dollar-yield stand-ins model jlUSDC and syrupUSDC. Given the readings of those two, as the
// server keeps them, they take them, relabelled as a test network's (model-yields.ts), and are placed.

const MODEL_READINGS: ModelReading[] = z
  .array(z.object({ symbol: z.string(), chain: z.string(), reading: YieldObservation }))
  .parse(readings);

const sheetFor = (goal: 'protect' | 'income'): PersonalSheet => ({
  basketType: 'standard',
  goal,
  amountUsd: 2_000,
  horizonMonths: 18,
  risk: 'high',
  themes: [],
  country: 'BR',
  chains: ['solana'],
  rules: { useHoldings: false, glide: true },
  language: 'en',
});
const planWith = (goal: 'protect' | 'income', yields: YieldObservation[]) =>
  compose(
    sheetFor(goal),
    { version: 'devnet', assets, families: [] },
    { now: '2026-10-05T12:00:00.000Z', yields },
  );

describe('the devnet stand-ins for jlUSDC and syrupUSDC', () => {
  const yields = modelYields(modelledTokens(assets, [], 'sandbox'), MODEL_READINGS);

  it('take the readings of the tokens they model, labelled sandbox and said to be applied', () => {
    expect(yields.map((y) => y.assetId).sort()).toEqual(['solana:jlusdc', 'solana:syrupusdc']);
    for (const y of yields) {
      expect(y.provenance).toBe('sandbox');
      expect(y.source).toContain('applied to');
      expect(y.fetchedAt).toBe('2026-10-05T12:00:00.000Z');
    }
    const syrup = yields.find((y) => y.assetId === 'solana:syrupusdc');
    const model = MODEL_READINGS.find((r) => r.symbol === 'syrupUSDC')?.reading;
    // the method is the model's own, so the engine ranks the reading as it would the model's
    expect(syrup?.method).toBe(model?.method);
    expect([syrup?.quotedYield, syrup?.haircutYield]).toEqual([
      model?.quotedYield,
      model?.haircutYield,
    ]);
  });

  it.each(['protect', 'income'] as const)(
    'are placed in a plan to %s, and every figure it stands on is labelled sandbox',
    (goal) => {
      const plan = planWith(goal, yields);
      const held = plan.lines.map((l) => l.assetId);
      expect(held).toContain('solana:jlusdc');
      expect(held).toContain('solana:syrupusdc');
      expect(plan.removed.map((r) => r.ref)).not.toContain('tjlUSDC');
      expect(plan.observations.length).toBeGreaterThan(0);
      for (const o of plan.observations) expect(o.provenance, o.method).toBe('sandbox');
    },
  );

  it('stay out as NO_YIELD when the models have no reading, or only one that is not live', () => {
    expect(modelYields(modelledTokens(assets, [], 'sandbox'), [])).toEqual([]);
    const notLive = MODEL_READINGS.map((r) => ({
      ...r,
      reading: { ...r.reading, provenance: 'mock' as const },
    }));
    const none = modelYields(modelledTokens(assets, [], 'sandbox'), notLive);
    expect(none).toEqual([]);
    expect(
      planWith('protect', none).removed.map((r) => [r.ref, r.reasons.map((x) => x.rule)]),
    ).toEqual([
      ['tjlUSDC', ['NO_YIELD']],
      ['tsyrupUSDC', ['NO_YIELD']],
    ]);
  });

  it('keep a reading of their own over their model’s', () => {
    const [first] = MODEL_READINGS;
    if (!first) throw new Error('the fixture has readings');
    const own = { ...first.reading, assetId: 'solana:jlusdc', provenance: 'sandbox' as const };
    expect(modelledTokens(assets, [own], 'sandbox').map((a) => a.id)).not.toContain(
      'solana:jlusdc',
    );
  });

  it('take nothing when they are not on a test network: a live token never takes another’s reading', () => {
    const live = assets.map((a) => ({ ...a, provenance: 'live' as const }));
    expect(modelledTokens(live, [], 'sandbox')).toEqual([]);
    expect(modelYields(modelledTokens(live, [], 'sandbox'), MODEL_READINGS)).toEqual([]);
  });
});
