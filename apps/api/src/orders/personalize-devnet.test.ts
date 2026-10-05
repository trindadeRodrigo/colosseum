import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deploymentAssets, SolanaDeploymentRecord } from '@colosseum/chain-solana/vault';
import { compose } from '@colosseum/engine';
import { describe, expect, it } from 'vitest';
import { DEPLOYMENTS_DIR } from '../deployments';

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
    expect(plan.removed).toEqual([]);
  });
});
