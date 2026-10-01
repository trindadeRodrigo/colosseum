import { readdirSync, readFileSync } from 'node:fs';
import {
  activeLiquidity,
  applyLiquidity,
  chainBreaks,
  compareTickMaps,
  decoders,
  liquidityChanges,
  type PoolEvent,
  parseLogs,
  type RpcTx,
  rewind,
  type TickMap,
  tokenBalances,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// Step 5b — event decoders on frozen mainnet transactions (fixtures/risk/txs, fetched 2026-10-01).
type Fx = {
  venue: string;
  label: string;
  tx: RpcTx;
  pools: Record<string, [string, string]>;
  mint0: Record<string, string>;
};
const dir = 'fixtures/risk/txs';
const fixtures: Fx[] = readdirSync(dir).map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));

/** Signed vault-balance change implied by one decoded event, in raw units (vault0, vault1). */
function vaultFlow(e: PoolEvent): [bigint, bigint] {
  const a0 = BigInt(e.kind === 'close' ? 0 : e.amount0);
  const a1 = BigInt(e.kind === 'close' ? 0 : e.amount1);
  if (e.kind === 'swap') return e.zeroForOne ? [a0, -a1] : [-a0, a1];
  if (e.kind === 'fees') return [-a0, -a1];
  if (e.kind === 'liquidity')
    return e.action === 'decrease'
      ? [-a0 - BigInt(e.fee0 ?? 0), -a1 - BigInt(e.fee1 ?? 0)]
      : [a0, a1];
  return [0n, 0n];
}

describe('pool event decoders (live transactions)', () => {
  it('has fixtures for every decoded venue', () => {
    const venues = new Set(fixtures.map((f) => f.venue));
    for (const v of ['raydium_clmm', 'orca_whirlpool', 'raydium_cpmm', 'meteora_dlmm'])
      expect(venues).toContain(v);
  });
  for (const fx of fixtures)
    describe(`${fx.venue} ${fx.label}`, () => {
      const pools = Object.entries(fx.pools);
      it('finds the pool and decodes at least one event, logs not truncated', () => {
        expect(pools.length).toBeGreaterThan(0);
        expect(parseLogs(fx.tx.meta?.logMessages ?? []).truncated).toBe(false);
        for (const [pool] of pools)
          expect(
            decoders[fx.venue]?.(fx.tx, pool, { mint0: fx.mint0[pool] }).events.length,
          ).toBeGreaterThan(0);
      });
      it('decoded amounts equal the vaults’ token balance changes', () => {
        for (const [pool, vaults] of pools) {
          const d = decoders[fx.venue]?.(fx.tx, pool, { mint0: fx.mint0[pool] });
          const flow = (d?.events ?? [])
            .map(vaultFlow)
            .reduce((s, f) => [s[0] + f[0], s[1] + f[1]] as [bigint, bigint], [0n, 0n] as [
              bigint,
              bigint,
            ]);
          const { pre, post } = tokenBalances(fx.tx, vaults);
          const delta = [0, 1].map((i) => BigInt(post[i] ?? 0) - BigInt(pre[i] ?? 0));
          expect(flow).toEqual(delta);
        }
      });
      it('liquidity events move pool liquidity by the delta exactly when in range', () => {
        for (const [pool] of pools)
          for (const e of decoders[fx.venue]?.(fx.tx, pool, { mint0: fx.mint0[pool] }).events ??
            []) {
            if (e.kind !== 'liquidity' || e.poolLiquidityBefore === undefined) continue;
            const inRange =
              (e.tickLower as number) <= (e.tick as number) &&
              (e.tick as number) < (e.tickUpper as number);
            expect(
              BigInt(e.poolLiquidityAfter as string) - BigInt(e.poolLiquidityBefore as string),
            ).toBe(inRange ? BigInt(e.liquidityDelta as string) : 0n);
          }
      });
    });
});

describe('replay', () => {
  const base = (): TickMap =>
    new Map([
      [-100, { net: 500n, gross: 500n }],
      [100, { net: -500n, gross: 500n }],
    ]);
  const ev = (tickLower: number, tickUpper: number, d: bigint): PoolEvent => ({
    kind: 'liquidity',
    pool: 'P',
    ixIndex: 0,
    action: d > 0n ? 'increase' : 'decrease',
    tickLower,
    tickUpper,
    liquidityDelta: d.toString(),
    amount0: '0',
    amount1: '0',
  });
  it('apply then rewind restores the layout exactly', () => {
    const m = base();
    const rows = [
      { slot: 10, seq: 3, events: [ev(-50, 50, 200n)] },
      { slot: 11, seq: 2, events: [ev(-100, 100, -500n)] },
      { slot: 11, seq: 1, events: [ev(0, 200, 70n)] },
    ];
    for (const r of rows) for (const c of liquidityChanges(r.events)) applyLiquidity(m, c);
    expect(activeLiquidity(m, 0)).toBe(270n);
    expect(compareTickMaps(base(), rewind(m, 11, rows, 9))).toEqual([]);
    // rewinding only to slot 10 keeps the slot-10 event
    expect(rewind(m, 11, rows, 10).get(-50)).toEqual({ net: 200n, gross: 200n });
  });
  it('a missing event shows as a tick mismatch and a chain break', () => {
    const m = base();
    applyLiquidity(m, liquidityChanges([ev(-50, 50, 200n)])[0] as never);
    expect(compareTickMaps(base(), rewind(m, 11, [], 9)).map((x) => x.tick)).toEqual([-50, 50]);
    const swap = (l: bigint): PoolEvent => ({
      kind: 'swap',
      pool: 'P',
      ixIndex: 0,
      amount0: '1',
      amount1: '1',
      zeroForOne: true,
      liquidity: l.toString(),
      tick: 0,
    });
    const rows = [
      { slot: 1, seq: 9, events: [swap(500n)] },
      {
        slot: 2,
        seq: 8,
        events: [
          { ...ev(-50, 50, 200n), poolLiquidityBefore: '700', poolLiquidityAfter: '900', tick: 0 },
        ],
      },
    ];
    expect(chainBreaks(rows)).toHaveLength(1);
  });
});
