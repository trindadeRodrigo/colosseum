import {
  afterTransferFee,
  cpSwapExactIn,
  decodeCpmmAmmConfig,
  decodeCpmmPool,
} from '@colosseum/risk';
import { jupHeaders, rpc, sleep } from '../lib';
import { getAccount } from './lib-pools';

// Validates the CPMM decoder: simulated output vs Jupiter direct quote through the same pool.
// Usage: tsx validate-cpmm.ts <pool> <inMint> <amountRaw,...>
const [pool, inMint, amounts] = process.argv.slice(2) as [string, string, string];
const acc = await getAccount(pool);
if (!acc) throw new Error('pool not found');
const p = decodeCpmmPool(acc.data);
const cfgAcc = await getAccount(p.ammConfig);
const cfg = decodeCpmmAmmConfig(cfgAcc?.data ?? new Uint8Array());
const bal = async (a: string) =>
  BigInt((await rpc<{ value: { amount: string } }>('getTokenAccountBalance', [a])).value.amount);
const r0 = Number((await bal(p.vault0)) - p.owed0);
const r1 = Number((await bal(p.vault1)) - p.owed1);
const zeroIn = p.mint0 === inMint;
const feeRate = (cfg.tradeFeeRate + (p.enableCreatorFee ? cfg.creatorFeeRate : 0)) / 1e6;
const s = { reserveIn: zeroIn ? r0 : r1, reserveOut: zeroIn ? r1 : r0, feeRate };
console.log(
  JSON.stringify({
    pool,
    mint0: p.mint0,
    mint1: p.mint1,
    cfg,
    enableCreatorFee: p.enableCreatorFee,
    creatorFeeOn: p.creatorFeeOn,
    size: acc.data.length,
    cfgSize: cfgAcc?.data.length,
    r0,
    r1,
  }),
);
for (const a of amounts.split(',')) {
  const outFee = Number(process.env.OUT_FEE_BPS ?? 0);
  const sim = afterTransferFee(
    cpSwapExactIn(s, Number(a)),
    outFee ? { bps: outFee, maximumFee: Number.MAX_SAFE_INTEGER } : undefined,
  );
  const out = zeroIn ? p.mint1 : p.mint0;
  const url = `https://api.jup.ag/swap/v1/quote?inputMint=${inMint}&outputMint=${out}&amount=${a}&slippageBps=50&onlyDirectRoutes=true&dexes=Raydium%20CP`;
  const b = (await (await fetch(url, { headers: jupHeaders() })).json()) as {
    outAmount?: string;
    routePlan?: Array<{ swapInfo: { ammKey: string } }>;
  };
  const same = b.routePlan?.[0]?.swapInfo.ammKey === pool;
  console.log(
    JSON.stringify({
      amountIn: a,
      sim: Math.floor(sim),
      jup: b.outAmount ?? null,
      same,
      relDiff:
        b.outAmount && same
          ? ((sim - Number(b.outAmount)) / Number(b.outAmount)).toExponential(3)
          : null,
    }),
  );
  await sleep(1300);
}
