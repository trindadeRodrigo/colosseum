import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  activeFromPositions,
  clmmState,
  clSim,
  concentration,
  decodeClmmAmmConfig,
  decodeClmmPool,
  decodeClmmPosition,
  decodeClmmTickArray,
  usdCurves,
  withoutPositions,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// QQQx/USDC Raydium CLMM fixture captured with its positions (scripts/risk/capture-pool-fixture.ts, POSITIONS=1).
const fx = JSON.parse(
  gunzipSync(
    readFileSync(
      'fixtures/risk/pools/raydium-GMjGLWzvK75LPetrgAmdeXnvxc4fUuQPwJxeQqTDU1aG.json.gz',
    ),
  ).toString(),
) as {
  pool: string;
  accounts: Record<string, string>;
  children: Record<string, string>;
  positions: Record<string, string>;
};
const b = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const h = decodeClmmPool(b(fx.accounts[fx.pool] as string));
const fee = decodeClmmAmmConfig(b(fx.accounts[h.ammConfig] as string)).tradeFeeRate;
const arrays = Object.values(fx.children)
  .map((c) => decodeClmmTickArray(b(c)))
  .filter((a) => a !== null && a.pool === fx.pool);
const state = clmmState(h, fee, arrays as NonNullable<(typeof arrays)[number]>[]);
const positions = Object.entries(fx.positions)
  .map(([k, v]) => decodeClmmPosition(k, b(v)))
  .filter((p) => p.pool === fx.pool && p.liquidity > 0);

describe('LP positions and concentration', () => {
  it('positions spanning the current tick sum to the pool active liquidity', () => {
    expect(positions.length).toBeGreaterThan(0);
    const act = activeFromPositions(positions, state.tickCurrent);
    expect(Math.abs(act - state.liquidity) / state.liquidity).toBeLessThan(1e-9);
  });

  it('removing every position leaves no liquidity; removing none changes nothing', () => {
    const empty = withoutPositions(state, positions);
    expect(empty.liquidity).toBeLessThan(state.liquidity * 1e-9);
    expect(withoutPositions(state, []).liquidity).toBe(state.liquidity);
  });

  it('concentration shares are ordered and the LP-exit stress raises cost', () => {
    const c = concentration(positions, state.tickCurrent, 0.02);
    expect(c.top1).toBeGreaterThan(0);
    expect(c.top1).toBeLessThanOrEqual(c.top3);
    expect(c.top3).toBeLessThanOrEqual(c.top10);
    expect(c.top10).toBeLessThanOrEqual(1 + 1e-12);
    const biggest = [...positions].sort((x, y) => y.liquidity - x.liquidity).slice(0, 3);
    const n = [100_000];
    const base = usdCurves(clSim(state, true), h.decimals0, h.decimals1, 1, n).sell[0];
    const stressed = usdCurves(
      clSim(withoutPositions(state, biggest), true),
      h.decimals0,
      h.decimals1,
      1,
      n,
    ).sell[0];
    expect(stressed?.costPct).toBeGreaterThan(base?.costPct ?? 0);
  });
});
