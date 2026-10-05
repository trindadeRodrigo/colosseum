import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createDb, riskMarketParams } from '@colosseum/db';
import { Reserve } from '@kamino-finance/klend-sdk';

// VR-3 / VR-4 (Step 10): decode the Kamino reserve accounts captured by the collector (raw on-chain bytes)
// with klend-sdk's generated decoder and compare the on-chain config with what Kamino's API reports.
// Jupiter Lend vault parameters come from the protocol API only (no decoder yet) and are labelled so.
// Writes data/risk/verify-markets-<stamp>.json and prints a comparison table.
const HOME = join(homedir(), '.colosseum', 'risk');
const lastDir = readdirSync(join(HOME, 'raw-markets')).sort().at(-1) as string;
const lastFile = readdirSync(join(HOME, 'raw-markets', lastDir))
  .sort()
  .at(-1) as string;
const raw = JSON.parse(
  gunzipSync(readFileSync(join(HOME, 'raw-markets', lastDir, lastFile))).toString(),
) as {
  fetchedAt: string;
  slot: number;
  accounts: Record<string, string>;
};
const apiRows = readFileSync(join(HOME, 'markets', `${lastDir}.jsonl`), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(
    (l) =>
      JSON.parse(l) as Record<string, unknown> & {
        account: string;
        venue: string;
        api: Record<string, unknown>;
      },
  );
const api = new Map(
  apiRows.filter((r) => r.fetchedAt === raw.fetchedAt).map((r) => [r.account, r]),
);
const out: Array<Record<string, unknown>> = [];
for (const [account, b64] of Object.entries(raw.accounts)) {
  const row = api.get(account);
  if (row?.venue !== 'kamino') continue;
  try {
    const r = Reserve.decode(Buffer.from(b64, 'base64'));
    const c = r.config;
    const name = Buffer.from(c.tokenInfo.name).toString('utf8').replace(/\0+$/, '');
    const heuristic = c.tokenInfo.heuristic;
    const scale = 10 ** heuristic.exp.toNumber();
    out.push({
      venue: 'kamino',
      market: row.marketName,
      reserve: account,
      token: name,
      isXStock: row.isXStock,
      onchain: {
        loanToValuePct: c.loanToValuePct,
        liquidationThresholdPct: c.liquidationThresholdPct,
        minLiquidationBonusBps: c.minLiquidationBonusBps,
        maxLiquidationBonusBps: c.maxLiquidationBonusBps,
        badDebtLiquidationBonusBps: c.badDebtLiquidationBonusBps,
        depositLimit: c.depositLimit.toString(),
        borrowLimit: c.borrowLimit.toString(),
        status: c.status,
        priceHeuristic: {
          lower: heuristic.lower.toNumber() / scale,
          upper: heuristic.upper.toNumber() / scale,
        },
        maxAgePriceSeconds: c.tokenInfo.maxAgePriceSeconds.toString(),
        maxTwapDivergenceBps: c.tokenInfo.maxTwapDivergenceBps.toString(),
        scopePriceChain: c.tokenInfo.scopeConfiguration.priceChain,
        scopeTwapChain: c.tokenInfo.scopeConfiguration.twapChain,
        scopePriceFeed: c.tokenInfo.scopeConfiguration.priceFeed.toString(),
      },
      api: {
        maxLtv: row.api.maxLtv,
        totalSupplyUsd: row.api.totalSupplyUsd,
        totalBorrowUsd: row.api.totalBorrowUsd,
      },
      apiMatchesOnchainLtv: Math.abs(Number(row.api.maxLtv) * 100 - c.loanToValuePct) < 0.5,
      source:
        'Solana RPC getMultipleAccounts (raw reserve bytes) decoded with @kamino-finance/klend-sdk Reserve.decode',
      fetchedAt: raw.fetchedAt,
      slot: raw.slot,
      provenance: 'live',
    });
  } catch (e) {
    out.push({ venue: 'kamino', reserve: account, error: String(e).slice(0, 160) });
  }
}
for (const r of apiRows.filter(
  (x) => x.venue === 'jupiter_lend' && x.fetchedAt === raw.fetchedAt,
)) {
  out.push({
    venue: 'jupiter_lend',
    vault: r.account,
    token: r.symbol,
    borrow: r.borrowSymbol,
    api: {
      collateralFactorPermille: r.api.collateralFactor,
      liquidationThresholdPermille: r.api.liquidationThreshold,
      liquidationMaxLimitPermille: r.api.liquidationMaxLimit,
      liquidationPenaltyBps: r.api.liquidationPenalty,
      oracle: r.api.oracle,
    },
    onchain: null,
    note: 'protocol API values; on-chain vault config not decoded yet (VR-4 partial)',
    source: r.source,
    fetchedAt: r.fetchedAt,
    provenance: 'live',
  });
}
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '');
writeFileSync(join('data/risk', `verify-markets-${stamp}.json`), JSON.stringify(out, null, 1));
for (const r of out) {
  if (r.venue === 'kamino' && !r.error) {
    const o = r.onchain as Record<string, unknown> & {
      priceHeuristic: { lower: number; upper: number };
    };
    console.log(
      `${String(r.market).padEnd(24)} ${String(r.token).padEnd(8)} LTV ${o.loanToValuePct}% LT ${o.liquidationThresholdPct}% bonus ${o.minLiquidationBonusBps}-${o.maxLiquidationBonusBps}bps heuristic [${o.priceHeuristic.lower}, ${o.priceHeuristic.upper}] maxAge ${o.maxAgePriceSeconds}s api=${(r.api as { maxLtv: unknown }).maxLtv} match=${r.apiMatchesOnchainLtv}`,
    );
  } else if (r.venue === 'jupiter_lend') {
    const a = r.api as Record<string, unknown>;
    console.log(
      `jupiter_lend ${String(r.token).padEnd(7)}/${String(r.borrow).padEnd(7)} CF ${Number(a.collateralFactorPermille) / 10}% LT ${Number(a.liquidationThresholdPermille) / 10}% penalty ${a.liquidationPenaltyBps}bps (API)`,
    );
  } else console.log(JSON.stringify(r));
}

// persist normalised parameters
const { db, client } = createDb();
for (const r of out) {
  if (r.error) continue;
  const kamino = r.venue === 'kamino';
  const o = (r.onchain ?? {}) as {
    loanToValuePct: number;
    liquidationThresholdPct: number;
    minLiquidationBonusBps: number;
    maxLiquidationBonusBps: number;
  };
  const a = r.api as Record<string, unknown>;
  const row = {
    venue: String(r.venue),
    market: kamino ? String(r.market) : 'jupiter_lend',
    account: String(kamino ? r.reserve : r.vault),
    assetMint:
      (apiRows.find((x) => x.account === (kamino ? r.reserve : r.vault))?.assetMint as string) ??
      null,
    asset: String(r.token),
    borrowAsset: kamino ? null : String(r.borrow),
    isXStock: kamino ? (r.isXStock ? 1 : 0) : 1,
    params: kamino
      ? {
          ltv: o.loanToValuePct / 100,
          liquidationThreshold: o.liquidationThresholdPct / 100,
          liquidationBonusMin: o.minLiquidationBonusBps / 1e4,
          liquidationBonusMax: o.maxLiquidationBonusBps / 1e4,
          raw: r.onchain,
        }
      : {
          ltv: Number(a.collateralFactorPermille) / 1000,
          liquidationThreshold: Number(a.liquidationThresholdPermille) / 1000,
          liquidationMaxLimit: Number(a.liquidationMaxLimitPermille) / 1000,
          liquidationBonusMin: Number(a.liquidationPenaltyBps) / 1e4,
          liquidationBonusMax: Number(a.liquidationPenaltyBps) / 1e4,
          raw: a,
        },
    totals: kamino
      ? r.api
      : (apiRows.find((x) => x.account === r.vault)?.api as Record<string, unknown> | undefined)
        ? (() => {
            const v = apiRows.find((x) => x.account === r.vault)?.api as Record<string, unknown>;
            return {
              totalSupply: v.totalSupply,
              totalBorrow: v.totalBorrow,
              totalPositions: v.totalPositions,
              oraclePrice: v.oraclePrice,
              supplyDecimals: (v.supplyToken as { decimals: number }).decimals,
              borrowDecimals: (v.borrowToken as { decimals: number }).decimals,
            };
          })()
        : null,
    verification: kamino ? (r.apiMatchesOnchainLtv ? 'onchain' : 'onchain_mismatch_api') : 'api',
    fetchedAt: new Date(String(r.fetchedAt)),
    slot: kamino ? Number(r.slot) : null,
    source: String(r.source),
    method: kamino ? 'klend_sdk_reserve_decode' : 'jupiter_lend_api_borrow_vaults',
    provenance: 'live' as const,
  };
  await db.insert(riskMarketParams).values(row).onConflictDoNothing();
}
await client.end();
console.log(JSON.stringify({ persisted: out.filter((r) => !r.error).length }));
