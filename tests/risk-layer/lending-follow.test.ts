import { readFileSync } from 'node:fs';
import {
  type FollowContext,
  type FollowRow,
  followSummary,
  KNOWN_SWAP_PROGRAMS,
  outflow,
  type RpcTx,
  seizedReceipt,
  tokenDeltas,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// PLAN-ANALYTICS item 13 — where the seized collateral went, on frozen mainnet transactions
// (fixtures/risk/lending/follow.json, `pnpm risk:lending-freeze-follow-fixtures`): the first liquidation of each
// outcome of the 2026-10-03 run, its liquidation transaction and its outflow transaction.
type Liq = {
  s: string;
  liquidator: string;
  collateralMint: string;
  collateralSeized: string;
  collateralPrice: number | null;
};
const fx = JSON.parse(readFileSync('fixtures/risk/lending/follow.json', 'utf8')) as {
  programs: string[];
  vaults: Array<{ address: string; vault0: string; vault1: string }>;
  cases: Array<{ outcome: string; liquidation: Liq; liquidationTx: RpcTx; outTx: RpcTx | null }>;
};
const ctx: FollowContext = {
  registryVaults: new Map(
    fx.vaults.flatMap((v) => [[v.vault0, v.address] as const, [v.vault1, v.address] as const]),
  ),
  swapPrograms: new Set([...fx.programs, ...KNOWN_SWAP_PROGRAMS]),
  dollarMints: new Set([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  ]),
};
const one = (outcome: string) => {
  const c = fx.cases.find((x) => x.outcome === outcome);
  if (!c) throw new Error(`no ${outcome} case in the fixture`);
  return c;
};

describe('the seized collateral after a liquidation', () => {
  it('kept by the liquidator, then sold into a registry pool near the oracle', () => {
    const c = one('sold_registry_pool');
    const r = seizedReceipt(c.liquidationTx, c.liquidation, ctx);
    if (r.kept !== true) throw new Error('expected the liquidator to keep the units');
    expect(r.units * 2n).toBeGreaterThanOrEqual(BigInt(c.liquidation.collateralSeized));
    const m = outflow(c.outTx as RpcTx, r.accounts, c.liquidation.collateralMint, ctx);
    expect(m?.outcome).toBe('sold_registry_pool');
    expect(fx.vaults.map((v) => v.address)).toContain(m?.pool);
    // the realised price is the owner's dollars received ÷ units sold; here within 2% of the program's oracle
    expect(
      Math.abs((m?.realisedUsd as number) / (c.liquidation.collateralPrice as number) - 1),
    ).toBeLessThan(0.02);
    // a swap moves the stock between accounts: its deltas sum to zero
    const stock = tokenDeltas(c.outTx as RpcTx).filter(
      (d) => d.mint === c.liquidation.collateralMint,
    );
    expect(stock.reduce((s, d) => s + d.delta, 0n)).toBe(0n);
  });

  it('kept, then sold outside the registry: through a listed program or for another token', () => {
    const c = one('sold_outside_registry');
    const r = seizedReceipt(c.liquidationTx, c.liquidation, ctx);
    if (r.kept !== true) throw new Error('expected the liquidator to keep the units');
    const m = outflow(c.outTx as RpcTx, r.accounts, c.liquidation.collateralMint, ctx);
    expect(m).toMatchObject({ outcome: 'sold_outside_registry', pool: null });
  });

  it('gone in the liquidation transaction: sold outside the registry, with no realised price', () => {
    const c = one('sold_same_tx_outside_registry');
    const r = seizedReceipt(c.liquidationTx, c.liquidation, ctx);
    if (r.kept !== false) throw new Error('expected the units to leave in the same transaction');
    expect(r.out).toMatchObject({ outcome: 'sold_outside_registry', realisedUsd: null });
  });

  it('gone in the liquidation transaction through no listed program: moved, not called a sale', () => {
    const c = one('transferred_same_tx');
    const r = seizedReceipt(c.liquidationTx, c.liquidation, ctx);
    if (r.kept !== false) throw new Error('expected the units to leave in the same transaction');
    expect(r.out.outcome).toBe('transferred');
  });

  it('a liquidation the liquidator still held is a kept receipt', () => {
    const c = one('held');
    expect(seizedReceipt(c.liquidationTx, c.liquidation, ctx).kept).toBe(true);
  });

  it('an outflow is null for a transaction that does not lower the followed accounts', () => {
    const c = one('sold_registry_pool');
    const r = seizedReceipt(c.liquidationTx, c.liquidation, ctx);
    if (r.kept !== true) throw new Error('expected a kept receipt');
    // the liquidation transaction itself raised them
    expect(outflow(c.liquidationTx, r.accounts, c.liquidation.collateralMint, ctx)).toBeNull();
  });
});

describe('the summary publishes counts and medians by asset, no wallet', () => {
  const row = (over: Partial<FollowRow>): FollowRow => ({
    asset: 'SPYx',
    venue: 'kamino',
    seizedUsd: 100,
    oraclePrice: 100,
    outcome: 'sold_registry_pool',
    hours: 1,
    share: 1,
    realisedUsd: 101,
    ...over,
  });
  it('groups by asset and outcome', () => {
    const s = followSummary([
      row({}),
      row({ hours: 3, realisedUsd: 99 }),
      row({ outcome: 'held', hours: null, share: null, realisedUsd: null, seizedUsd: null }),
    ]);
    expect(s).toEqual([
      {
        asset: 'SPYx',
        outcome: 'sold_registry_pool',
        liquidations: 2,
        seizedUsd: 200,
        seizedUsdKnown: 2,
        medianHours: 2,
        medianShare: 1,
        realisedVsOracle: { median: 0, samples: 2 },
      },
      {
        asset: 'SPYx',
        outcome: 'held',
        liquidations: 1,
        seizedUsd: null,
        seizedUsdKnown: 0,
        medianHours: null,
        medianShare: null,
        realisedVsOracle: { median: null, samples: 0 },
      },
    ]);
    expect(JSON.stringify(s)).not.toMatch(/liquidator|owner|signature/);
  });
});
