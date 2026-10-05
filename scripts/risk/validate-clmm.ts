import { type ClState, RAYDIUM_CLMM_PROGRAM, swapExactIn } from '@colosseum/risk';
import { jupHeaders, MINTS, sleep } from '../lib';
import { loadClmm, loadWhirlpool } from './lib-pools';

// Validates concentrated-liquidity decoders (Raydium CLMM, Orca Whirlpool) against the chain and Jupiter.
// Check 1 (invariant): active liquidity rebuilt from tick arrays (sum of liquidityNet for ticks <= current)
// equals the pool's stored liquidity. Check 2: simulated sell output equals a Jupiter direct quote whose
// single hop is the same pool. Usage: tsx scripts/risk/validate-clmm.ts [raydium|orca]
type Case = { sym: string; mint: string; pool: string; venue: 'raydium' | 'orca' };
const CASES: Case[] = [
  {
    sym: 'SPYx',
    mint: MINTS.SPYx,
    pool: '6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE',
    venue: 'raydium',
  },
  {
    sym: 'QQQx',
    mint: MINTS.QQQx,
    pool: 'GMjGLWzvK75LPetrgAmdeXnvxc4fUuQPwJxeQqTDU1aG',
    venue: 'raydium',
  },
  {
    sym: 'SPYx',
    mint: MINTS.SPYx,
    pool: 'Fae5dWVntUt6zbWu2voXxioDpMii7SqQwtsxBmoVCsHR',
    venue: 'orca',
  },
];
const only = process.argv[2];
const DEX_LABEL = { raydium: 'Raydium CLMM', orca: 'Whirlpool' } as const;
const DECIMALS: Record<string, number> = { [MINTS.USDC]: 6, [MINTS.SPYx]: 8, [MINTS.QQQx]: 8 };

for (const c of CASES.filter((x) => !only || x.venue === only)) {
  let state: ClState;
  let mint0: string;
  let extra: Record<string, unknown>;
  if (c.venue === 'raydium') {
    const p = await loadClmm(RAYDIUM_CLMM_PROGRAM, c.pool);
    state = p.state;
    mint0 = p.header.mint0;
    extra = { tickArrays: p.arrays };
  } else {
    const p = await loadWhirlpool(c.pool);
    state = p.state;
    mint0 = p.header.mintA;
    extra = { tickArrays: p.arrays, kinds: p.kinds };
  }
  const assetIs0 = mint0 === c.mint;
  const dAsset = DECIMALS[c.mint] as number;
  const dUsdc = 6;
  const p01 = state.sqrtPrice ** 2; // token1 per token0, raw units
  const priceUsdc = assetIs0 ? p01 * 10 ** (dAsset - dUsdc) : 1 / (p01 * 10 ** (dUsdc - dAsset));
  const rebuilt = state.ticks
    .filter((t) => t.tick <= state.tickCurrent)
    .reduce((s, t) => s + t.liquidityNet, 0);
  console.log(
    JSON.stringify({
      ...c,
      ...extra,
      initTicks: state.ticks.length,
      feeRate: state.feeRate,
      invariantRelErr: Math.abs(rebuilt - state.liquidity) / state.liquidity,
      priceUsdc,
    }),
  );
  for (const usd of [1_000, 10_000, 100_000, 1_000_000]) {
    const inRaw = Math.floor((usd / priceUsdc) * 10 ** dAsset);
    const sim = swapExactIn(state, inRaw, assetIs0);
    const simUsdc = sim.amountOut / 10 ** dUsdc;
    const url = `https://api.jup.ag/swap/v1/quote?inputMint=${c.mint}&outputMint=${MINTS.USDC}&amount=${inRaw}&slippageBps=50&onlyDirectRoutes=true&dexes=${encodeURIComponent(DEX_LABEL[c.venue])}`;
    const body = (await (await fetch(url, { headers: jupHeaders() })).json()) as {
      outAmount?: string;
      routePlan?: Array<{ swapInfo: { ammKey: string } }>;
    };
    const same = body.routePlan?.[0]?.swapInfo.ammKey === c.pool;
    const jup = body.outAmount ? Number(body.outAmount) / 10 ** dUsdc : null;
    console.log(
      JSON.stringify({
        sym: c.sym,
        venue: c.venue,
        usd,
        simOutUsdc: Number(simUsdc.toFixed(4)),
        simCostPct: Number(((1 - simUsdc / usd) * 100).toFixed(4)),
        unfilledShare: Number((sim.unfilledIn / inRaw).toFixed(6)),
        ticksCrossed: sim.ticksCrossed,
        jupOutUsdc: jup,
        jupSamePool: same,
        relDiff: jup && same ? Number(((simUsdc - jup) / jup).toExponential(3)) : null,
      }),
    );
    await sleep(1500);
  }
}
