import 'dotenv/config';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, riskLendingPools } from '@colosseum/db';
import {
  decodeJlChainlinkCache,
  decodeJlOracle,
  decodeJlVaultConfig,
  decodeJlVaultState,
  decodeKaminoReserve,
  decodeKvaultState,
  JL_VAULTS_PROGRAM,
  KAMINO_RESERVE_SIZE,
  KLEND_PROGRAM,
  KVAULT_PROGRAM,
  KVAULT_STATE_SIZE,
  kaminoReserveState,
} from '@colosseum/risk';
import { sql } from 'drizzle-orm';
import {
  LENDING_DATA,
  LENDING_HISTORY_DIR,
  loadMeasure,
  measuredSlotMs,
  multipleAccounts,
  RISK_HOME,
  registryAssets,
} from './lib-lending';

// Step 10b item 2 — lending-pool registry. One row per Kamino reserve of every market that lists an xStock, per
// Jupiter Lend xStock vault, and per curated Kamino vault (kvault) with an allocation slot in a registered reserve
// (D15: tracked, `offered: false`). Inputs: the VL-1/2/5/8 measurements (`pnpm risk:lending-measure`). Every row is
// re-read on-chain here: the account must exist, be owned by the expected program, have the expected size and
// decode to the same market and mints as measured; otherwise it is dropped with a reason.
// Writes data/risk/lending-registry-<stamp>.json, ~/.colosseum/risk/lending-registry.json (read by the collector)
// and the table risk_lending_pools.
const METHOD_VERSION = 'lending-registry-0.1';
const SOURCE =
  'Solana RPC getMultipleAccounts; decoders packages/risk/src/lending (checked vs klend-sdk / @jup-ag/lend-read in VL-2 / VL-5)';
const KAMINO_MARKET_NAMES: Record<string, string> = {
  '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua': 'xStocks Market',
  B7a2Dmdnfg8zfZX2814d6Xo6ctxs22jnTuCcjTq5KcPD: 'STRCx Market',
  '8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr': 'Sentora xStocks Market',
};

type Vl1 = {
  kamino: Array<{
    market: string;
    reserve: string;
    mint: string;
    symbol: string;
    isXStock: boolean;
  }>;
};
type Vl5 = {
  rows: Array<{ vault: string; vaultId: number; pair: string; accounts: Record<string, unknown> }>;
  value: { verdict: string; sameBytesMismatches: number };
};
type Vl2 = { value: { handVsSdkMismatches: number } };
type Vl8 = {
  rows: Array<{
    vault: string;
    name: string;
    manager: string;
    allocationAdmin: string;
    tokenMint: string;
    sharesMint: string;
    tokenVault: string;
    allocations: Array<{
      reserve: string;
      registered: boolean;
      ctokenVault: string;
      ctokenAllocation: string;
    }>;
  }>;
};

const assets = registryAssets();
const v1 = loadMeasure<Vl1>('vl1');
const v2 = loadMeasure<Vl2>('vl2');
const v5 = loadMeasure<Vl5>('vl5');
const v8 = loadMeasure<Vl8>('vl8');
const fetchedAt = new Date();
const slotMs = await measuredSlotMs();

/** Oldest walked signature time of an address (VL-4 walk), if walked. */
function firstTx(addresses: string[]): Date | null {
  let t = Number.POSITIVE_INFINITY;
  for (const a of addresses) {
    const f = join(LENDING_HISTORY_DIR, 'sigs', a, 'cursor.json');
    if (!existsSync(f)) continue;
    const c = JSON.parse(readFileSync(f, 'utf8')) as { done: boolean; oldestTime?: number };
    if (c.done && c.oldestTime) t = Math.min(t, c.oldestTime);
  }
  return Number.isFinite(t) ? new Date(t * 1000) : null;
}

type Row = typeof riskLendingPools.$inferInsert;
const rows: Row[] = [];
const dropped: Array<{ account: string; venue: string; reason: string }> = [];
const base = {
  chain: 'solana',
  source: SOURCE,
  fetchedAt,
  provenance: 'live' as const,
  methodVersion: METHOD_VERSION,
};
const mintSymbol = (m: string, fallback: string) => assets.get(m) ?? fallback;

// Kamino reserves
const kAcc = await multipleAccounts(v1.kamino.map((r) => r.reserve));
for (const m of v1.kamino) {
  const a = kAcc.accounts.get(m.reserve);
  const drop = (reason: string) => dropped.push({ account: m.reserve, venue: 'kamino', reason });
  if (!a) {
    drop('account not found');
    continue;
  }
  if (a.owner !== KLEND_PROGRAM) {
    drop(`owner ${a.owner}`);
    continue;
  }
  if (a.data.length !== KAMINO_RESERVE_SIZE) {
    drop(`size ${a.data.length}`);
    continue;
  }
  const r = decodeKaminoReserve(a.data);
  if (r.lendingMarket !== m.market || r.liquidityMint !== m.mint) {
    drop('market or mint changed since VL-1');
    continue;
  }
  const st = kaminoReserveState(r, { slotMs });
  const isX = assets.has(r.liquidityMint);
  const role = isX ? 'collateral' : r.config.borrowLimit > 0n ? 'debt' : 'collateral';
  rows.push({
    ...base,
    account: m.reserve,
    venue: 'kamino',
    program: KLEND_PROGRAM,
    market: m.market,
    marketName: KAMINO_MARKET_NAMES[m.market] ?? null,
    role,
    mint: r.liquidityMint,
    symbol: mintSymbol(r.liquidityMint, r.config.name),
    decimals: r.mintDecimals,
    dexAssetMint: isX ? r.liquidityMint : null,
    accounts: {
      liquiditySupplyVault: r.liquiditySupplyVault,
      liquidityFeeVault: r.liquidityFeeVault,
      collateralMint: r.collateralMint,
      collateralSupplyVault: r.collateralSupplyVault,
      farmCollateral: r.farmCollateral,
      farmDebt: r.farmDebt,
      tokenProgram: r.tokenProgram,
    },
    oracles: {
      scopePriceFeed: r.config.scopePriceFeed,
      scopePriceChain: r.config.scopePriceChain,
      scopeTwapChain: r.config.scopeTwapChain,
      pythPrice: r.config.pythPrice,
      switchboardPriceAggregator: r.config.switchboardPriceAggregator,
    },
    params: {
      status: r.config.status,
      interestRateBasis: r.config.interestRateBasis,
      loanToValuePct: r.config.loanToValuePct,
      liquidationThresholdPct: r.config.liquidationThresholdPct,
      minLiquidationBonusBps: r.config.minLiquidationBonusBps,
      maxLiquidationBonusBps: r.config.maxLiquidationBonusBps,
      badDebtLiquidationBonusBps: r.config.badDebtLiquidationBonusBps,
      depositLimit: r.config.depositLimit.toString(),
      borrowLimit: r.config.borrowLimit.toString(),
      borrowable: r.config.borrowLimit > 0n,
      usableAsCollateral: r.config.loanToValuePct > 0,
      maxAgePriceSeconds: r.config.maxAgePriceSeconds.toString(),
      borrowRateCurve: r.config.borrowRateCurve,
      suppliedAtRegistry: st.supplied.toString(),
      borrowedAtRegistry: st.borrowed.toString(),
      suppliedUsdAtRegistry: (Number(st.supplied) / st.scale) * st.priceUsd,
    },
    manager: null,
    offered: null,
    firstTxAt: firstTx([m.reserve]),
    verification: v2.value.handVsSdkMismatches === 0 ? 'onchain' : 'api',
    status: st.supplied === 0n && st.borrowed === 0n ? 'empty' : 'active',
    statusReason: r.config.status !== 0 ? `reserve status ${r.config.status} (not active)` : null,
    method: 'kamino_reserve_decode',
  });
}

// Jupiter Lend vaults
const jAcc = await multipleAccounts(
  v5.rows.flatMap((v) => [v.vault, String(v.accounts.state), String(v.accounts.oracle)]),
);
const caches = await multipleAccounts(
  v5.rows.flatMap((v) => {
    const o = jAcc.accounts.get(String(v.accounts.oracle));
    return o ? decodeJlOracle(o.data).sources.map((s) => s.source) : [];
  }),
);
for (const v of v5.rows) {
  const a = jAcc.accounts.get(v.vault);
  const drop = (reason: string) =>
    dropped.push({ account: v.vault, venue: 'jupiter_lend', reason });
  if (!a) {
    drop('config not found');
    continue;
  }
  if (a.owner !== JL_VAULTS_PROGRAM) {
    drop(`owner ${a.owner}`);
    continue;
  }
  const cfg = decodeJlVaultConfig(a.data);
  const stAcc = jAcc.accounts.get(String(v.accounts.state));
  if (!stAcc) {
    drop('vault state not found');
    continue;
  }
  const st = decodeJlVaultState(stAcc.data);
  if (st.vaultId !== cfg.vaultId) {
    drop('state vault id differs');
    continue;
  }
  const orc = jAcc.accounts.get(cfg.oracle);
  const sources = orc ? decodeJlOracle(orc.data).sources : [];
  const cache = sources[0] ? caches.accounts.get(sources[0].source) : null;
  const [colSym, debtSym] = v.pair.split('/');
  rows.push({
    ...base,
    account: v.vault,
    venue: 'jupiter_lend',
    program: JL_VAULTS_PROGRAM,
    market: `jupiter_lend:${cfg.vaultId}`,
    marketName: `Jupiter Lend ${v.pair}`,
    role: 'vault',
    mint: cfg.supplyToken,
    symbol: mintSymbol(cfg.supplyToken, String(colSym)),
    decimals: (v.accounts as { decimals?: number }).decimals ?? 8,
    debtMint: cfg.borrowToken,
    debtSymbol: String(debtSym),
    dexAssetMint: assets.has(cfg.supplyToken) ? cfg.supplyToken : null,
    accounts: {
      state: v.accounts.state,
      supplyReserve: v.accounts.supplyReserve,
      borrowReserve: v.accounts.borrowReserve,
      supplyRateModel: v.accounts.supplyRateModel,
      borrowRateModel: v.accounts.borrowRateModel,
      supplyPosition: v.accounts.supplyPosition,
      borrowPosition: v.accounts.borrowPosition,
      liquidityVaultSupply: v.accounts.liquidityVaultSupply,
      liquidityVaultBorrow: v.accounts.liquidityVaultBorrow,
      liquidity: v.accounts.liquidity,
    },
    oracles: {
      oracle: cfg.oracle,
      sources: sources.map((s) => ({
        source: s.source,
        invert: s.invert,
        multiplier: s.multiplier.toString(),
        divisor: s.divisor.toString(),
        sourceType: s.sourceType,
      })),
      sourceOwner: cache?.owner ?? null,
      cacheFeeds: cache ? decodeJlChainlinkCache(cache.data).feeds : null,
    },
    params: {
      vaultId: cfg.vaultId,
      collateralFactor: cfg.collateralFactor / 1000,
      liquidationThreshold: cfg.liquidationThreshold / 1000,
      liquidationMaxLimit: cfg.liquidationMaxLimit / 1000,
      liquidationPenalty: cfg.liquidationPenalty / 10_000,
      withdrawGap: cfg.withdrawGap / 10_000,
      borrowFee: cfg.borrowFee,
      vaultType: cfg.vaultType,
      totalPositionsAtRegistry: st.totalPositions,
    },
    manager: null,
    offered: null,
    firstTxAt: firstTx([v.vault, String(v.accounts.state)]),
    verification: v5.value.sameBytesMismatches === 0 ? 'onchain' : 'api',
    status: 'active',
    statusReason: null,
    method: 'jupiter_lend_vault_decode',
  });
}
// the decimals of the collateral: from the mint accounts
const jlMints = await multipleAccounts([
  ...new Set(rows.filter((r) => r.venue === 'jupiter_lend').map((r) => r.mint)),
]);
for (const r of rows.filter((x) => x.venue === 'jupiter_lend')) {
  const m = jlMints.accounts.get(r.mint);
  if (m) r.decimals = m.data[44] as number;
}

// curated vaults with an allocation slot in a registered reserve (D15)
const registered = new Set(rows.filter((r) => r.venue === 'kamino').map((r) => r.account));
const kv = await multipleAccounts(v8.rows.map((v) => v.vault));
for (const v of v8.rows) {
  const a = kv.accounts.get(v.vault);
  const drop = (reason: string) =>
    dropped.push({ account: v.vault, venue: 'kamino_vault', reason });
  if (!a) {
    drop('vault not found');
    continue;
  }
  if (a.owner !== KVAULT_PROGRAM || a.data.length !== KVAULT_STATE_SIZE) {
    drop('owner or size');
    continue;
  }
  const s = decodeKvaultState(a.data);
  const ours = s.allocations.filter((x) => registered.has(x.reserve));
  if (!ours.length) {
    drop('no allocation slot in a registered reserve any more');
    continue;
  }
  const funded = ours.filter((x) => x.ctokenAllocation > 0n);
  rows.push({
    ...base,
    account: v.vault,
    venue: 'kamino_vault',
    program: KVAULT_PROGRAM,
    market: `kvault:${v.vault}`,
    marketName: s.name || null,
    role: 'curated_vault',
    mint: s.tokenMint,
    // the vault's token is the liquidity mint of the reserves it allocates into
    symbol:
      rows.find((r) => r.venue === 'kamino' && r.mint === s.tokenMint)?.symbol ??
      s.tokenMint.slice(0, 6),
    decimals: s.tokenMintDecimals,
    dexAssetMint: null,
    accounts: {
      tokenVault: s.tokenVault,
      sharesMint: s.sharesMint,
      baseVaultAuthority: s.baseVaultAuthority,
      allocations: s.allocations.map((x) => ({
        reserve: x.reserve,
        ctokenVault: x.ctokenVault,
        registered: registered.has(x.reserve),
      })),
    },
    oracles: {},
    params: {
      allocationsInRegisteredReserves: ours.map((x) => ({
        reserve: x.reserve,
        ctokenAllocation: x.ctokenAllocation.toString(),
        targetWeight: x.targetAllocationWeight.toString(),
        cap: x.tokenAllocationCap.toString(),
      })),
      allocationsTotal: s.allocations.length,
      allocationAdmin: s.allocationAdmin,
    },
    manager: s.adminAuthority,
    offered: 0,
    firstTxAt: firstTx([v.vault]),
    verification: 'onchain',
    status: funded.length ? 'active' : 'slot_only',
    statusReason: funded.length
      ? null
      : 'allocation slot in a registered reserve, currently 0 cTokens',
    method: 'kvault_state_decode',
  });
}

function countBy(xs: string[]) {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return m;
}
const stamp = fetchedAt.toISOString().slice(0, 16).replace(/[-:]/g, '');
const out = {
  methodVersion: METHOD_VERSION,
  fetchedAt: fetchedAt.toISOString(),
  source: SOURCE,
  slotMs,
  counts: {
    rows: rows.length,
    byVenue: countBy(rows.map((r) => r.venue)),
    byRole: countBy(rows.map((r) => r.role)),
    byStatus: countBy(rows.map((r) => r.status)),
    verification: countBy(rows.map((r) => r.verification)),
    markets: new Set(rows.map((r) => r.market)).size,
    dropped: dropped.length,
  },
  dropped,
  rows,
};
const file = join(LENDING_DATA, `lending-registry-${stamp}.json`);
writeFileSync(file, JSON.stringify(out, null, 1));
mkdirSync(RISK_HOME, { recursive: true });
copyFileSync(file, join(RISK_HOME, 'lending-registry.json'));

const { db, client } = createDb();
await db.transaction(async (tx) => {
  for (const r of rows)
    await tx
      .insert(riskLendingPools)
      .values(r)
      .onConflictDoUpdate({
        target: riskLendingPools.account,
        set: { ...r, account: undefined } as Partial<Row>,
      });
  // rows no longer confirmed stay in the table, marked
  const keep = rows.map((r) => r.account);
  await tx
    .update(riskLendingPools)
    .set({ status: 'dropped', statusReason: 'not confirmed by the latest registry run' })
    .where(
      sql`${riskLendingPools.account} not in (${sql.join(
        keep.map((k) => sql`${k}`),
        sql`, `,
      )})`,
    );
});
await client.end();
console.log(JSON.stringify({ file, ...out.counts }));
for (const r of rows)
  console.log(
    `${r.venue.padEnd(13)} ${String(r.marketName ?? r.market)
      .slice(0, 26)
      .padEnd(
        26,
      )} ${r.role.padEnd(13)} ${r.symbol.padEnd(8)} ${r.status.padEnd(9)} first ${r.firstTxAt?.toISOString().slice(0, 10) ?? '—'} ${r.account}`,
  );
