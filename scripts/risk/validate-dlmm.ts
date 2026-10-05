import {
  DLMM_BIN_ARRAY_PAIR_OFFSET,
  decodeDlmmBinArray,
  decodeDlmmPair,
  dlmmFeeRate,
  dlmmSwapExactIn,
  METEORA_DLMM_PROGRAM,
} from '@colosseum/risk';
import { jupHeaders, MINTS, rpc, sleep } from '../lib';
import { getAccount, programAccountsByMemcmp } from './lib-pools';

// Validates the DLMM decoder: (1) bin amounts sum to the reserve token balances; (2) simulated sell
// output equals a Jupiter direct quote through the same pair. Usage: tsx validate-dlmm.ts <pair> <assetMint>
const pair = process.argv[2] ?? '5JWX8pQhJNpFMjPwKhFSSVWRpss4wSyoqgRGnBNJfyuX';
const mint = process.argv[3] ?? MINTS.SPYx;
const acc = await getAccount(pair);
if (!acc) throw new Error('pair not found');
const p = decodeDlmmPair(acc.data);
const raw = await programAccountsByMemcmp(METEORA_DLMM_PROGRAM, DLMM_BIN_ARRAY_PAIR_OFFSET, pair);
const bins = raw
  .map((a) => decodeDlmmBinArray(a.data))
  .filter((a) => a.pair === pair)
  .flatMap((a) => a.bins);
const bal = async (a: string) =>
  Number((await rpc<{ value: { amount: string } }>('getTokenAccountBalance', [a])).value.amount);
const [rx, ry] = [await bal(p.reserveX), await bal(p.reserveY)];
const sx = bins.reduce((s, b) => s + b.amountX, 0);
const sy = bins.reduce((s, b) => s + b.amountY, 0);
const state = { activeId: p.activeId, feeRate: dlmmFeeRate(p), bins };
console.log(
  JSON.stringify({
    pair,
    mintX: p.mintX,
    mintY: p.mintY,
    activeId: p.activeId,
    binStep: p.binStep,
    feeRate: state.feeRate,
    binArrays: raw.length,
    bins: bins.length,
    reserveXvsBins: sx / rx,
    reserveYvsBins: sy / ry,
  }),
);
const xForY = p.mintX === mint;
for (const units of [0.1, 1, 10, 100]) {
  const inRaw = Math.floor(units * 1e8);
  const sim = dlmmSwapExactIn(state, inRaw, xForY);
  const out = xForY ? p.mintY : p.mintX;
  const url = `https://api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${out}&amount=${inRaw}&slippageBps=50&onlyDirectRoutes=true&dexes=Meteora%20DLMM`;
  const body = (await (await fetch(url, { headers: jupHeaders() })).json()) as {
    outAmount?: string;
    routePlan?: Array<{ swapInfo: { ammKey: string } }>;
  };
  const same = body.routePlan?.[0]?.swapInfo.ammKey === pair;
  const jup = body.outAmount ? Number(body.outAmount) : null;
  console.log(
    JSON.stringify({
      units,
      simOut: Math.round(sim.amountOut),
      unfilledShare: sim.unfilledIn / inRaw,
      binsCrossed: sim.binsCrossed,
      jupOut: jup,
      jupSamePool: same,
      relDiff: jup && same ? ((sim.amountOut - jup) / jup).toExponential(3) : null,
    }),
  );
  await sleep(1500);
}
