// Quote cross-check collector (Step 3). Every 15 minutes, for each asset in the set holding
// QUOTE_SET_SHARE of pool TVL: Jupiter quotes selling the asset for USDC and buying it with USDC at a
// few notionals. Rows keep the route (pools and split), so the routing gap against our single-pool
// simulation can be measured offline. Failed quotes are rows with `error`; nothing is retried in a loop.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.RISK_HOME ?? join(homedir(), '.colosseum', 'risk');
const BASE = process.env.JUPITER_API_BASE ?? 'https://api.jup.ag/swap/v1';
const KEY = process.env.JUPITER_API_KEY;
const QUOTE_SET_SHARE = 0.8;
const NOTIONALS = [1_000, 10_000, 100_000];
const SPACING_MS = Number(process.env.RISK_QUOTE_SPACING_MS ?? 1300);
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RegPool = {
  address: string;
  assetMint: string;
  assetSymbol: string;
  tvlUsd: number;
  decimals0: number;
  decimals1: number;
  assetIsToken0: number;
};
const reg = JSON.parse(readFileSync(join(HOME, 'registry.json'), 'utf8')) as { pools: RegPool[] };
const tvlByAsset = new Map<string, { symbol: string; tvl: number; decimals: number }>();
for (const p of reg.pools) {
  const v = tvlByAsset.get(p.assetMint) ?? {
    symbol: p.assetSymbol,
    tvl: 0,
    decimals: p.assetIsToken0 ? p.decimals0 : p.decimals1,
  };
  v.tvl += p.tvlUsd ?? 0;
  tvlByAsset.set(p.assetMint, v);
}
const total = [...tvlByAsset.values()].reduce((s, v) => s + v.tvl, 0);
const set: Array<[string, { symbol: string; tvl: number; decimals: number }]> = [];
let cum = 0;
for (const e of [...tvlByAsset.entries()].sort((a, b) => b[1].tvl - a[1].tvl)) {
  if (cum >= QUOTE_SET_SHARE * total) break;
  cum += e[1].tvl;
  set.push(e);
}

// reference USD price per asset: latest pool snapshot's midUsd (pool collector), else skip sell side
const day = new Date().toISOString().slice(0, 10);
const snapFile = join(HOME, 'pools', `${day}.jsonl`);
const midUsd = new Map<string, number>();
const refTvl = new Map<string, number>();
const poolTvl = new Map(
  (reg.pools as Array<RegPool & { address?: string }>).map((p) => [p.address ?? '', p.tvlUsd ?? 0]),
);
if (existsSync(snapFile)) {
  for (const l of readFileSync(snapFile, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(l) as {
      pool: string;
      assetMint: string;
      midUsd: number | null;
      exitPath: string;
    };
    // reference price: the asset's largest direct-USD pool (by registry TVL), latest snapshot
    if (!r.midUsd || r.exitPath !== 'direct_usd') continue;
    const tvl = poolTvl.get(r.pool) ?? 0;
    if (tvl >= (refTvl.get(r.assetMint) ?? 0)) {
      refTvl.set(r.assetMint, tvl);
      midUsd.set(r.assetMint, r.midUsd);
    }
  }
}

mkdirSync(join(HOME, 'quotes'), { recursive: true });
const file = join(HOME, 'quotes', `${day}.jsonl`);
const runId = new Date().toISOString();
let rows = 0;
let errors = 0;
async function quote(inputMint: string, outputMint: string, amount: bigint) {
  const url = `${BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`;
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', ...(KEY ? { 'x-api-key': KEY } : {}) },
    });
    const body = (await res.json().catch(() => ({}))) as {
      outAmount?: string;
      error?: string;
      routePlan?: Array<{
        percent: number;
        swapInfo: { ammKey: string; label: string; inAmount: string; outAmount: string };
      }>;
    };
    return { status: res.status, body, url };
  } catch (e) {
    return { status: 0, body: { error: String(e) }, url };
  }
}
for (const [mint, a] of set) {
  for (const n of NOTIONALS) {
    for (const side of ['sell', 'buy'] as const) {
      const ref = midUsd.get(mint);
      let amount: bigint | null = null;
      if (side === 'buy') amount = BigInt(n) * 1_000_000n;
      else if (ref) amount = BigInt(Math.floor((n / ref) * 10 ** a.decimals));
      const fetchedAt = new Date().toISOString();
      if (amount === null) {
        appendFileSync(
          file,
          `${JSON.stringify({ runId, asset: a.symbol, assetMint: mint, side, notionalUsd: n, error: 'no_ref_price', fetchedAt })}\n`,
        );
        errors++;
        continue;
      }
      const q = side === 'sell' ? await quote(mint, USDC, amount) : await quote(USDC, mint, amount);
      const ok = q.status === 200 && q.body.outAmount;
      if (!ok) errors++;
      appendFileSync(
        file,
        `${JSON.stringify({
          runId,
          asset: a.symbol,
          assetMint: mint,
          side,
          notionalUsd: n,
          refMidUsd: ref ?? null,
          amountIn: amount.toString(),
          outAmount: ok ? q.body.outAmount : null,
          route: ok
            ? (q.body.routePlan ?? []).map((r) => ({
                pool: r.swapInfo.ammKey,
                label: r.swapInfo.label,
                percent: r.percent,
                inAmount: r.swapInfo.inAmount,
                outAmount: r.swapInfo.outAmount,
              }))
            : null,
          error: ok ? null : `${q.status} ${String(q.body.error ?? '')}`.trim(),
          source: `${BASE}/quote`,
          method: `jupiter_quote_exact_in_${side}`,
          fetchedAt,
          provenance: 'live',
        })}\n`,
      );
      rows++;
      await sleep(SPACING_MS);
    }
  }
}
const summary = {
  kind: 'quotes_run',
  runId,
  assets: set.length,
  rows,
  errors,
  finishedAt: new Date().toISOString(),
};
appendFileSync(join(HOME, 'quote-runs.jsonl'), `${JSON.stringify(summary)}\n`);
console.log(JSON.stringify(summary));
