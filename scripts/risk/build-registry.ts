import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, riskPools } from '@colosseum/db';
import {
  decodeClmmPool,
  decodeCpmmPool,
  decodeDlmmPair,
  decodeWhirlpool,
  METEORA_DLMM_PROGRAM,
  ORCA_WHIRLPOOL_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
} from '@colosseum/risk';
import { sql } from 'drizzle-orm';
import { jupHeaders, MINTS, nowIso, sleep } from '../lib';
import { getMultiple, rpc, rpcStats } from './lib-pools';

// Step 1 — pool registry. Confirms every candidate xStocks pool on-chain (owner program, decoded mints),
// adds pools DexScreener missed (getProgramAccounts by mint per venue), measures TVL from vault balances,
// and assigns refresh tiers: A = pools holding TIER_A_SHARE of supported TVL (5 min), B = rest (hourly),
// X = unsupported venue or failed confirmation. Writes risk_pools, data/risk/registry-*.json and the
// collector's copy at ~/.colosseum/risk/registry.json.
export const REGISTRY_METHOD_VERSION = 'registry-0.1';
const TIER_A_SHARE = Number(process.env.TIER_A_SHARE ?? 0.99);
const OUT = process.env.RISK_DATA_DIR ?? 'data/risk';
const latest = (prefix: string, ext: string) =>
  join(
    OUT,
    readdirSync(OUT)
      .filter((n) => n.startsWith(prefix) && n.endsWith(ext))
      .sort()
      .at(-1) as string,
  );

type Venue = 'raydium_clmm' | 'orca_whirlpool' | 'meteora_dlmm' | 'raydium_cpmm';
const VENUES: Record<
  Venue,
  { program: string; size: number; mintOffsets: [number, number]; dexscreener: string }
> = {
  raydium_clmm: {
    program: RAYDIUM_CLMM_PROGRAM,
    size: 1544,
    mintOffsets: [73, 105],
    dexscreener: 'raydium:CLMM',
  },
  orca_whirlpool: {
    program: ORCA_WHIRLPOOL_PROGRAM,
    size: 653,
    mintOffsets: [101, 181],
    dexscreener: 'orca:wp',
  },
  meteora_dlmm: {
    program: METEORA_DLMM_PROGRAM,
    size: 904,
    mintOffsets: [88, 120],
    dexscreener: 'meteora:DLMM',
  },
  raydium_cpmm: {
    program: RAYDIUM_CPMM_PROGRAM,
    size: 637,
    mintOffsets: [168, 200],
    dexscreener: 'raydium:CPMM',
  },
};
const venueByProgram = new Map(Object.entries(VENUES).map(([v, c]) => [c.program, v as Venue]));

// --- inputs: discovery file and the xStocks list ---
const discoveryFile = latest('pools-dexscreener-', '.jsonl');
const xFile = latest('xstocks-', '.json');
const xs = JSON.parse(readFileSync(xFile, 'utf8')) as {
  tokens: Array<{ id: string; symbol: string }>;
};
const symbol = new Map(xs.tokens.map((t) => [t.id, t.symbol]));
symbol.set(MINTS.USDC, 'USDC');
symbol.set(MINTS.USDT, 'USDT');
const SOL = 'So11111111111111111111111111111111111111112';
symbol.set(SOL, 'SOL');
const isX = (m: string) => xs.tokens.some((t) => t.id === m);

type Cand = { address: string; dsVenue: string; liq: number; vol: number; fromDiscovery: boolean };
const cands = new Map<string, Cand>();
for (const line of readFileSync(discoveryFile, 'utf8').split('\n').filter(Boolean)) {
  const r = JSON.parse(line) as {
    pairs: Array<{
      pairAddress: string;
      dexId: string;
      labels?: string[];
      liquidity?: { usd?: number };
      volume?: { h24?: number };
    }>;
  };
  for (const p of r.pairs ?? []) {
    if (cands.has(p.pairAddress)) continue;
    cands.set(p.pairAddress, {
      address: p.pairAddress,
      dsVenue: `${p.dexId}${p.labels?.length ? `:${p.labels.join('/')}` : ''}`,
      liq: p.liquidity?.usd ?? 0,
      vol: p.volume?.h24 ?? 0,
      fromDiscovery: true,
    });
  }
}
const assetsWithPools = new Set<string>();
for (const line of readFileSync(discoveryFile, 'utf8').split('\n').filter(Boolean)) {
  const r = JSON.parse(line) as { assetMint: string; pairs: unknown[] };
  if (r.pairs?.length) assetsWithPools.add(r.assetMint);
}

// --- second pass: on-chain search by mint, per venue (checkpointed: a rerun skips finished searches) ---
const ckptFile = join(
  OUT,
  `registry-search-${discoveryFile.match(/(\d{8}T\d{4})/)?.[1] ?? 'x'}.json`,
);
const ckpt: Record<string, string[]> = existsSync(ckptFile)
  ? JSON.parse(readFileSync(ckptFile, 'utf8'))
  : {};
let found = 0;
for (const mint of process.env.SKIP_SEARCH === '1' ? [] : assetsWithPools) {
  for (const [, cfg] of Object.entries(VENUES)) {
    for (const offset of cfg.mintOffsets) {
      const key = `${cfg.program}:${offset}:${mint}`;
      if (!ckpt[key]) {
        const r = await rpc<Array<{ pubkey: string }>>('getProgramAccounts', [
          cfg.program,
          {
            encoding: 'base64',
            dataSlice: { offset: 0, length: 0 },
            filters: [{ dataSize: cfg.size }, { memcmp: { offset, bytes: mint } }],
          },
        ]);
        ckpt[key] = r.map((a) => a.pubkey);
        writeFileSync(ckptFile, JSON.stringify(ckpt));
        await sleep(150);
      }
      for (const a of ckpt[key] ?? []) {
        if (!cands.has(a)) {
          cands.set(a, { address: a, dsVenue: 'onchain', liq: 0, vol: 0, fromDiscovery: false });
          found++;
        }
      }
    }
  }
}
console.log(JSON.stringify({ discoveryCandidates: cands.size - found, foundOnChainOnly: found }));

// --- confirm each candidate on-chain ---
type Row = typeof riskPools.$inferInsert & {
  vault0?: string;
  vault1?: string;
  mint0: string;
  mint1: string;
};
const addrs = [...cands.keys()];
const accs = await getMultiple(addrs);
const rows: Row[] = [];
const fetchedAt = new Date();
const excluded: Array<{ address: string; venue: string; reason: string }> = [];
for (const [i, address] of addrs.entries()) {
  const c = cands.get(address) as Cand;
  const acc = accs[i];
  const venue = acc ? venueByProgram.get(acc.owner) : undefined;
  if (!acc || !venue) {
    excluded.push({
      address,
      venue: c.dsVenue,
      reason: acc ? `unsupported program ${acc.owner}` : 'account not found',
    });
    continue;
  }
  let mint0: string;
  let mint1: string;
  let vault0: string;
  let vault1: string;
  try {
    if (venue === 'raydium_clmm') {
      const h = decodeClmmPool(acc.data);
      [mint0, mint1, vault0, vault1] = [h.mint0, h.mint1, h.vault0, h.vault1];
    } else if (venue === 'orca_whirlpool') {
      const h = decodeWhirlpool(acc.data);
      [mint0, mint1, vault0, vault1] = [h.mintA, h.mintB, h.vaultA, h.vaultB];
    } else if (venue === 'meteora_dlmm') {
      const h = decodeDlmmPair(acc.data);
      [mint0, mint1, vault0, vault1] = [h.mintX, h.mintY, h.reserveX, h.reserveY];
    } else {
      const h = decodeCpmmPool(acc.data);
      [mint0, mint1, vault0, vault1] = [h.mint0, h.mint1, h.vault0, h.vault1];
    }
  } catch (e) {
    excluded.push({ address, venue, reason: `decode failed: ${String(e).slice(0, 80)}` });
    continue;
  }
  const assetIs0 = isX(mint0) ? 1 : isX(mint1) ? 0 : -1;
  if (assetIs0 < 0) {
    excluded.push({ address, venue, reason: 'no xStock mint in pool' });
    continue;
  }
  const assetMint = assetIs0 ? mint0 : mint1;
  const quoteMint = assetIs0 ? mint1 : mint0;
  const exitPath =
    quoteMint === MINTS.USDC || quoteMint === MINTS.USDT
      ? 'direct_usd'
      : quoteMint === SOL
        ? 'via_sol'
        : isX(quoteMint)
          ? 'via_xstock'
          : 'other';
  rows.push({
    address,
    program: acc.owner,
    venue,
    assetMint,
    assetSymbol: symbol.get(assetMint) ?? assetMint.slice(0, 6),
    quoteMint,
    quoteSymbol: symbol.get(quoteMint) ?? null,
    exitPath,
    assetIsToken0: assetIs0,
    decimals0: 0,
    decimals1: 0,
    discoveryLiquidityUsd: c.liq,
    discoveryVolume24hUsd: c.vol,
    tier: 'B',
    status: 'confirmed',
    methodVersion: REGISTRY_METHOD_VERSION,
    source: c.fromDiscovery
      ? 'api.dexscreener.com (discovery) + Solana RPC getMultipleAccounts (confirmation)'
      : 'Solana RPC getProgramAccounts by mint (discovery + confirmation)',
    method: 'onchain_decode_owner_and_mints',
    fetchedAt,
    provenance: 'live',
    vault0,
    vault1,
    mint0,
    mint1,
  });
}

// --- mints: decimals and transfer fees ---
const mints = [...new Set(rows.flatMap((r) => [r.mint0, r.mint1]))];
const mintInfo = new Map<string, { decimals: number; feeBps: number }>();
for (let i = 0; i < mints.length; i += 100) {
  const batch = mints.slice(i, i + 100);
  const r = await rpc<{
    value: Array<{
      data: {
        parsed: {
          info: {
            decimals: number;
            extensions?: Array<{
              extension: string;
              state: { newerTransferFee?: { transferFeeBasisPoints: number } };
            }>;
          };
        };
      };
    } | null>;
  }>('getMultipleAccounts', [batch, { encoding: 'jsonParsed' }]);
  for (const [k, v] of r.value.entries()) {
    const info = v?.data.parsed.info;
    if (!info) continue;
    const fee = info.extensions?.find((e) => e.extension === 'transferFeeConfig');
    mintInfo.set(batch[k] as string, {
      decimals: info.decimals,
      feeBps: fee?.state.newerTransferFee?.transferFeeBasisPoints ?? 0,
    });
  }
}

// --- TVL from vault balances, priced for ranking only (Jupiter Price API v3) ---
const vaults = rows.flatMap((r) => [r.vault0 as string, r.vault1 as string]);
const vaultAccs = await getMultiple(vaults);
const bal = new Map<string, number>();
for (const [i, v] of vaults.entries()) {
  const a = vaultAccs[i];
  if (a && a.data.length >= 72)
    bal.set(v, Number(new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true)));
}
// Price only the xStocks and the USD/SOL quotes; exotic quote tokens are left unpriced, so a pool's TVL
// counts the xStock side plus any USD/SOL/xStock quote side (a lower bound for exotic pairs).
const price = new Map<string, number>([
  [MINTS.USDC, 1],
  [MINTS.USDT, 1],
]);
const toPrice = [SOL, ...new Set(rows.flatMap((r) => [r.mint0, r.mint1]).filter((m) => isX(m)))];
for (let i = 0; i < toPrice.length; i += 50) {
  const ids = toPrice.slice(i, i + 50).join(',');
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`https://api.jup.ag/price/v3?ids=${ids}`, { headers: jupHeaders() });
    const text = await res.text();
    if (res.status === 429 || !text.startsWith('{')) {
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    for (const [m, p] of Object.entries(JSON.parse(text) as Record<string, { usdPrice?: number }>))
      if (p?.usdPrice) price.set(m, p.usdPrice);
    break;
  }
  await sleep(1300);
}
for (const r of rows) {
  const m0 = mintInfo.get(r.mint0);
  const m1 = mintInfo.get(r.mint1);
  r.decimals0 = m0?.decimals ?? 0;
  r.decimals1 = m1?.decimals ?? 0;
  r.transferFeeBps0 = m0?.feeBps ?? 0;
  r.transferFeeBps1 = m1?.feeBps ?? 0;
  const v0 = (bal.get(r.vault0 as string) ?? 0) / 10 ** r.decimals0;
  const v1 = (bal.get(r.vault1 as string) ?? 0) / 10 ** r.decimals1;
  r.tvlUsd = v0 * (price.get(r.mint0) ?? 0) + v1 * (price.get(r.mint1) ?? 0);
}

// --- tiers by on-chain TVL ---
const sorted = [...rows].sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
const total = sorted.reduce((s, r) => s + (r.tvlUsd ?? 0), 0);
let cum = 0;
for (const r of sorted) {
  r.tier = cum < TIER_A_SHARE * total && (r.tvlUsd ?? 0) > 0 ? 'A' : 'B';
  cum += r.tvlUsd ?? 0;
}
const pareto = (q: number) => {
  let s = 0;
  let n = 0;
  for (const r of sorted) {
    if (s >= q * total) break;
    s += r.tvlUsd ?? 0;
    n++;
  }
  return n;
};

// --- persist ---
const { db, client } = createDb();
for (const r of rows) {
  const { vault0: _v0, vault1: _v1, mint0: _m0, mint1: _m1, ...row } = r;
  await db
    .insert(riskPools)
    .values(row)
    .onConflictDoUpdate({
      target: riskPools.address,
      set: {
        ...row,
        address: sql`excluded.address`,
      },
    });
}
await client.end();
const stamp = nowIso().slice(0, 16).replace(/[-:]/g, '');
const registry = {
  methodVersion: REGISTRY_METHOD_VERSION,
  fetchedAt: fetchedAt.toISOString(),
  tierAShare: TIER_A_SHARE,
  pools: sorted.map((r) => ({
    address: r.address,
    venue: r.venue,
    program: r.program,
    assetMint: r.assetMint,
    assetSymbol: r.assetSymbol,
    quoteMint: r.quoteMint,
    quoteSymbol: r.quoteSymbol,
    exitPath: r.exitPath,
    assetIsToken0: r.assetIsToken0,
    mint0: r.mint0,
    mint1: r.mint1,
    vault0: r.vault0,
    vault1: r.vault1,
    decimals0: r.decimals0,
    decimals1: r.decimals1,
    transferFeeBps0: r.transferFeeBps0,
    transferFeeBps1: r.transferFeeBps1,
    tvlUsd: r.tvlUsd,
    tier: r.tier,
  })),
  excluded,
};
writeFileSync(join(OUT, `registry-${stamp}.json`), JSON.stringify(registry, null, 1));
const home = join(homedir(), '.colosseum', 'risk');
mkdirSync(home, { recursive: true });
writeFileSync(join(home, 'registry.json'), JSON.stringify(registry));
const byVenue: Record<string, { pools: number; tvl: number }> = {};
for (const r of rows) {
  byVenue[r.venue] ??= { pools: 0, tvl: 0 };
  const v = byVenue[r.venue] as { pools: number; tvl: number };
  v.pools++;
  v.tvl += r.tvlUsd ?? 0;
}
const exclReasons: Record<string, number> = {};
for (const e of excluded) {
  const k = `${e.venue}: ${e.reason.split(' ').slice(0, 2).join(' ')}`;
  exclReasons[k] = (exclReasons[k] ?? 0) + 1;
}
console.log(
  JSON.stringify(
    {
      confirmed: rows.length,
      tierA: rows.filter((r) => r.tier === 'A').length,
      tierB: rows.filter((r) => r.tier === 'B').length,
      assets: new Set(rows.map((r) => r.assetMint)).size,
      tvlUsdOnChain: Math.round(total),
      pareto: { '80%': pareto(0.8), '90%': pareto(0.9), '95%': pareto(0.95), '99%': pareto(0.99) },
      exitPaths: rows.reduce<Record<string, number>>((m, r) => {
        m[r.exitPath] = (m[r.exitPath] ?? 0) + (r.tvlUsd ?? 0);
        return m;
      }, {}),
      byVenue,
      excluded: excluded.length,
      rpcStats,
      exclReasons,
      top: sorted
        .slice(0, 10)
        .map((r) => `${r.assetSymbol}/${r.quoteSymbol} ${r.venue} ${Math.round(r.tvlUsd ?? 0)}`),
    },
    null,
    1,
  ),
);
