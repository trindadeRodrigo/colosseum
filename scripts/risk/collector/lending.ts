// Lending-pool collector (Step 10b item 3). Bundled by scripts/risk/collector/install.sh into a single file that
// launchd runs from ~/.colosseum (macOS blocks launchd agents from reading ~/Documents). Registry: the file
// `pnpm risk:lending-registry` copies to ~/.colosseum/risk/lending-registry.json.
// Every run (minutes 1, 6, …, 56): one batched getMultipleAccounts of every registered reserve, vault, liquidity-layer,
// oracle and vault token account, decoded on-chain with packages/risk/src/lending, one row per reserve / vault /
// liquidity-layer token / curated vault in ~/.colosseum/risk/lending/YYYY-MM-DD.jsonl.
// Once an hour (the first run of each hour): every Kamino obligation and Jupiter Lend position (raw bytes,
// gzipped, plus one decoded row each, kept locally only) in lending-positions/, and the raw bytes of every state
// account read in raw-lending/. Failures are rows; nothing is retried in a loop beyond the RPC backoff.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  decodeJlChainlinkCache,
  decodeJlPosition,
  decodeJlRateModel,
  decodeJlTokenReserve,
  decodeJlUserBorrowPosition,
  decodeJlUserSupplyPosition,
  decodeJlVaultConfig,
  decodeJlVaultState,
  decodeKaminoObligation,
  decodeKaminoReserve,
  decodeKvaultState,
  JL_EXCHANGE_PRICE_PRECISION,
  JL_POSITION_SIZE,
  JL_VAULT_INTERNAL_DECIMALS,
  JL_VAULTS_PROGRAM,
  jlPositionAmounts,
  jlPositionTokens,
  jlTokenTotals,
  jlVaultExchangePrices,
  KAMINO_MARKET_OFFSET,
  KAMINO_OBLIGATION_SIZE,
  type KaminoReserve,
  KLEND_PROGRAM,
  kaminoAccruedDebtSf,
  kaminoReserveState,
  scopePrice,
  sfToNumber,
} from '@colosseum/risk';
import { getBase58Decoder } from '@solana/kit';

export const LENDING_METHOD_VERSION = 'lending-0.1';
const HOME = process.env.RISK_HOME ?? join(homedir(), '.colosseum', 'risk');
const RPC_URL = process.env.SOLANA_RPC_URL ?? '';
const SOURCE = 'Solana RPC getMultipleAccounts (Chainstack)';
const b58 = getBase58Decoder();
const PROVENANCE = 'live';

type RegRow = {
  account: string;
  venue: 'kamino' | 'jupiter_lend' | 'kamino_vault';
  market: string;
  marketName: string | null;
  role: string;
  mint: string;
  symbol: string;
  decimals: number;
  debtMint?: string | null;
  debtSymbol?: string | null;
  accounts: Record<string, unknown>;
  oracles: Record<string, unknown>;
  params: Record<string, unknown>;
  status: string;
};

const stats = { calls: 0, retries429: 0, errors: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    stats.calls++;
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(60_000),
      });
      const j = (await res.json().catch(() => ({ error: { code: res.status } }))) as {
        result?: T;
        error?: { code?: number; message?: string };
      };
      if (res.status === 429 || j.error?.code === 429) {
        stats.retries429++;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
      return j.result as T;
    } catch (e) {
      stats.errors++;
      if (attempt === 5) throw e;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw new Error(`${method}: rate-limited after 6 attempts`);
}
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
async function getMultiple(keys: string[]) {
  const out = new Map<string, { owner: string; data: Uint8Array }>();
  let slot = 0;
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    const r = await rpc<{
      context: { slot: number };
      value: Array<{ owner: string; data: [string, string] } | null>;
    }>('getMultipleAccounts', [batch, { encoding: 'base64' }]);
    slot = r.context.slot;
    r.value.forEach((v, k) => {
      if (v) out.set(batch[k] as string, { owner: v.owner, data: b64(v.data[0]) });
    });
  }
  return { slot, accounts: out };
}
async function programAccounts(program: string, filters: unknown[]) {
  const r = await rpc<Array<{ pubkey: string; account: { data: [string, string] } }>>(
    'getProgramAccounts',
    [program, { encoding: 'base64', filters }],
  );
  return r.map((a) => ({ pubkey: a.pubkey, data: b64(a.account.data[0]) }));
}
async function slotMs(): Promise<number | null> {
  const s = await rpc<Array<{ numSlots: number; samplePeriodSecs: number }>>(
    'getRecentPerformanceSamples',
    [30],
  ).catch(() => null);
  if (!s) return null;
  const slots = s.reduce((a, x) => a + x.numSlots, 0);
  return slots ? (1000 * s.reduce((a, x) => a + x.samplePeriodSecs, 0)) / slots : null;
}
const tokenAmount = (d?: Uint8Array) =>
  d ? new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(64, true) : null;
const ui = (raw: bigint, dec: number) => Number(raw) / 10 ** dec;
const str = (x: unknown) => String(x);

async function main() {
  if (!RPC_URL) throw new Error('SOLANA_RPC_URL not set (see ~/.colosseum/risk/env)');
  const started = Date.now();
  const now = new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const day = now.toISOString().slice(0, 10);
  const hour = String(now.getUTCHours()).padStart(2, '0');
  const fetchedAt = now.toISOString();
  const reg = JSON.parse(readFileSync(join(HOME, 'lending-registry.json'), 'utf8')) as {
    rows: RegRow[];
    methodVersion: string;
  };
  const failures: string[] = [];
  const outDir = join(HOME, 'lending');
  mkdirSync(outDir, { recursive: true });
  const rows: Array<Record<string, unknown>> = [];
  const base = (r: RegRow, kind: string, method: string) => ({
    kind,
    chain: 'solana',
    venue: r.venue,
    account: r.account,
    market: r.market,
    marketName: r.marketName,
    symbol: r.symbol,
    role: r.role,
    fetchedAt,
    source: SOURCE,
    method,
    methodVersion: LENDING_METHOD_VERSION,
    provenance: PROVENANCE,
  });

  const kamino = reg.rows.filter((r) => r.venue === 'kamino');
  const jl = reg.rows.filter((r) => r.venue === 'jupiter_lend');
  const kv = reg.rows.filter((r) => r.venue === 'kamino_vault');
  const kvAllocReserves = kv.flatMap((r) =>
    ((r.accounts.allocations as Array<{ reserve: string }>) ?? []).map((a) => a.reserve),
  );
  const kvCtokenVaults = kv.flatMap((r) =>
    ((r.accounts.allocations as Array<{ ctokenVault: string }>) ?? []).map((a) => a.ctokenVault),
  );
  const jlCaches = jl.flatMap((r) =>
    ((r.oracles.sources as Array<{ source: string }>) ?? []).map((s) => s.source),
  );
  const keys = [
    ...new Set([
      ...kamino.map((r) => r.account),
      ...kvAllocReserves,
      ...kamino.map((r) => String(r.oracles.scopePriceFeed)),
      ...kamino.flatMap((r) => [
        String(r.accounts.liquiditySupplyVault),
        String(r.accounts.collateralSupplyVault),
      ]),
      ...jl.flatMap((r) => [
        r.account,
        ...[
          'state',
          'supplyReserve',
          'borrowReserve',
          'supplyRateModel',
          'borrowRateModel',
          'supplyPosition',
          'borrowPosition',
        ].map((k) => String(r.accounts[k])),
      ]),
      ...jlCaches,
      ...kv.flatMap((r) => [r.account, String(r.accounts.tokenVault)]),
      ...kvCtokenVaults,
    ]),
  ];
  const ms = await slotMs();
  const { slot, accounts } = await getMultiple(keys);
  const get = (k: unknown) => accounts.get(String(k))?.data;

  // Kamino reserves
  const reserves = new Map<string, KaminoReserve>();
  for (const k of new Set([...kamino.map((r) => r.account), ...kvAllocReserves])) {
    const d = get(k);
    if (!d) continue;
    try {
      reserves.set(k, decodeKaminoReserve(d));
    } catch (e) {
      failures.push(`${k} reserve decode: ${String(e).slice(0, 100)}`);
    }
  }
  for (const r of kamino) {
    const res = reserves.get(r.account);
    if (!res) {
      failures.push(`${r.account} reserve missing`);
      rows.push({ ...base(r, 'failure', 'kamino_reserve_decode'), slot, error: 'reserve missing' });
      continue;
    }
    try {
      const st = kaminoReserveState(res, { slotMs: ms ?? undefined });
      const dec = res.mintDecimals;
      const scope = get(res.config.scopePriceFeed);
      const sp =
        scope && res.config.scopePriceChain.length
          ? scopePrice(scope, res.config.scopePriceChain)
          : null;
      const liqVault = tokenAmount(get(res.liquiditySupplyVault));
      const colVault = tokenAmount(get(res.collateralSupplyVault));
      rows.push({
        ...base(r, 'kamino_reserve', 'kamino_reserve_decode'),
        slot,
        lastUpdateSlot: str(res.lastUpdateSlot),
        mint: res.liquidityMint,
        decimals: dec,
        supplied: str(st.supplied),
        borrowed: str(st.borrowed),
        available: str(st.available),
        suppliedUi: ui(st.supplied, dec),
        borrowedUi: ui(st.borrowed, dec),
        availableUi: ui(st.available, dec),
        utilization: st.utilization,
        rateBasis: res.config.interestRateBasis === 0 ? 'legacy' : 'true_apr',
        slotMs: ms,
        borrowApr: st.borrowApr,
        supplyApr: st.supplyApr,
        borrowApy: st.borrowApy,
        supplyApy: st.supplyApy,
        depositLimit: str(res.config.depositLimit),
        borrowLimit: str(res.config.borrowLimit),
        depositHeadroom: str(st.depositHeadroom),
        borrowHeadroom: str(st.borrowHeadroom),
        depositWithdrawalCap: {
          capacity: str(res.config.depositWithdrawalCap.capacity),
          current: str(res.config.depositWithdrawalCap.current),
          intervalStart: str(res.config.depositWithdrawalCap.intervalStart),
          intervalSeconds: str(res.config.depositWithdrawalCap.intervalSeconds),
        },
        debtWithdrawalCap: {
          capacity: str(res.config.debtWithdrawalCap.capacity),
          current: str(res.config.debtWithdrawalCap.current),
          intervalStart: str(res.config.debtWithdrawalCap.intervalStart),
          intervalSeconds: str(res.config.debtWithdrawalCap.intervalSeconds),
        },
        withdrawQueueCtokens: str(res.withdrawQueueCollateral),
        cumulativeBorrowRateBsf: str(res.cumulativeBorrowRateBsf),
        borrowIndex: st.cumulativeBorrowRate,
        exchangeRate: st.exchangeRate,
        ctokenSupply: str(res.collateralMintTotalSupply),
        collateralVaultCtokens: colVault === null ? null : str(colVault),
        liquidityVaultBalance: liqVault === null ? null : str(liqVault),
        liquidityVaultMatchesAvailable: liqVault === null ? null : liqVault === res.availableAmount,
        oraclePriceUsd: st.priceUsd,
        oraclePriceTs: st.priceTs,
        oraclePriceAgeSec: st.priceTs ? nowS - st.priceTs : null,
        oracleSource: 'reserve.liquidity.marketPriceSf (Scope price at the last refresh)',
        scopePriceUsd: sp?.price ?? null,
        scopePriceTs: sp?.ts ?? null,
        scopePriceAgeSec: sp ? nowS - sp.ts : null,
        scopeFeed: res.config.scopePriceFeed,
        scopeChain: res.config.scopePriceChain,
        suppliedUsd: ui(st.supplied, dec) * st.priceUsd,
        borrowedUsd: ui(st.borrowed, dec) * st.priceUsd,
        loanToValuePct: res.config.loanToValuePct,
        liquidationThresholdPct: res.config.liquidationThresholdPct,
        status: res.config.status,
      });
    } catch (e) {
      failures.push(`${r.account}: ${String(e).slice(0, 120)}`);
      rows.push({
        ...base(r, 'failure', 'kamino_reserve_decode'),
        slot,
        error: String(e).slice(0, 200),
      });
    }
  }

  // Jupiter Lend: liquidity-layer tokens (once per token) and vaults
  const layerDone = new Set<string>();
  const vaultEx = new Map<
    number,
    { vaultSupplyExchangePrice: bigint; vaultBorrowExchangePrice: bigint }
  >();
  for (const r of jl) {
    try {
      const cfg = decodeJlVaultConfig(get(r.account) as Uint8Array);
      const st = decodeJlVaultState(get(r.accounts.state) as Uint8Array);
      const sr = decodeJlTokenReserve(get(r.accounts.supplyReserve) as Uint8Array);
      const br = decodeJlTokenReserve(get(r.accounts.borrowReserve) as Uint8Array);
      const srT = jlTokenTotals(sr, nowS);
      const brT = jlTokenTotals(br, nowS);
      for (const [key, t, tot, rm, sym] of [
        [r.accounts.supplyReserve, sr, srT, r.accounts.supplyRateModel, r.symbol],
        [r.accounts.borrowReserve, br, brT, r.accounts.borrowRateModel, r.debtSymbol],
      ] as const) {
        if (layerDone.has(String(key))) continue;
        layerDone.add(String(key));
        const rmd = get(rm);
        const model = rmd ? decodeJlRateModel(rmd) : null;
        rows.push({
          kind: 'jl_liquidity',
          chain: 'solana',
          venue: 'jupiter_lend',
          account: key,
          market: 'jupiter_lend:liquidity',
          symbol: sym,
          mint: t.mint,
          slot,
          supplied: str(tot.supplied),
          borrowed: str(tot.borrowed),
          available: str(tot.available),
          utilization: tot.utilization,
          borrowApr: tot.borrowApr,
          supplyApr: tot.supplyApr,
          storedUtilizationBps: t.lastUtilization,
          maxUtilizationBps: t.maxUtilization,
          feeOnInterestBps: t.feeOnInterest,
          supplyExchangePrice: str(tot.supplyExchangePrice),
          borrowExchangePrice: str(tot.borrowExchangePrice),
          lastUpdateAgeSec: nowS - Number(t.lastUpdateTimestamp),
          rateModel: model,
          fetchedAt,
          source: SOURCE,
          method: 'jupiter_lend_token_reserve_decode',
          methodVersion: LENDING_METHOD_VERSION,
          provenance: PROVENANCE,
        });
      }
      const spd = get(r.accounts.supplyPosition);
      const bpd = get(r.accounts.borrowPosition);
      const sp = spd ? decodeJlUserSupplyPosition(spd) : null;
      const bp = bpd ? decodeJlUserBorrowPosition(bpd) : null;
      const cacheKey = (r.oracles.sources as Array<{ source: string }>)?.[0]?.source;
      const cd = cacheKey ? get(cacheKey) : undefined;
      const cache = cd ? decodeJlChainlinkCache(cd) : null;
      // vault totals are in 9-decimal internal units at the vault exchange prices, accrued to now as the SDK does
      const vx = jlVaultExchangePrices(
        st,
        cfg,
        srT.supplyExchangePrice,
        brT.borrowExchangePrice,
        nowS,
      );
      vaultEx.set(cfg.vaultId, vx);
      const colTokens =
        (st.totalSupply * vx.vaultSupplyExchangePrice) / JL_EXCHANGE_PRICE_PRECISION;
      const debtTokens =
        (st.totalBorrow * vx.vaultBorrowExchangePrice) / JL_EXCHANGE_PRICE_PRECISION;
      const colDec = JL_VAULT_INTERNAL_DECIMALS;
      const debtDec = JL_VAULT_INTERNAL_DECIMALS;
      const tokDebtDec = (r.params.debtDecimals as number | undefined) ?? 6;
      const price = cache ? Number(cache.price) / 1e18 : null;
      rows.push({
        ...base(r, 'jl_vault', 'jupiter_lend_vault_decode'),
        slot,
        vaultId: cfg.vaultId,
        collateralMint: cfg.supplyToken,
        debtMint: cfg.borrowToken,
        debtSymbol: r.debtSymbol,
        collateralInternal: str(colTokens),
        debtInternal: str(debtTokens),
        internalDecimals: JL_VAULT_INTERNAL_DECIMALS,
        collateralUi: ui(colTokens, colDec),
        debtUi: ui(debtTokens, debtDec),
        liquiditySuppliedUi: sp
          ? ui(jlPositionTokens(sp, srT.supplyExchangePrice), r.decimals)
          : null,
        liquidityBorrowedUi: bp
          ? ui(jlPositionTokens(bp, brT.borrowExchangePrice), tokDebtDec)
          : null,
        liquiditySupplied: sp ? str(jlPositionTokens(sp, srT.supplyExchangePrice)) : null,
        liquidityBorrowed: bp ? str(jlPositionTokens(bp, brT.borrowExchangePrice)) : null,
        withdrawalLimit: sp ? str(sp.withdrawalLimit) : null,
        debtCeiling: bp ? str(bp.debtCeiling) : null,
        maxDebtCeiling: bp ? str(bp.maxDebtCeiling) : null,
        totalPositions: st.totalPositions,
        topmostTick: st.topmostTick,
        currentBranchId: st.currentBranchId,
        branchLiquidated: st.branchLiquidated,
        absorbedDebt: str(st.absorbedDebtAmount),
        absorbedCollateral: str(st.absorbedColAmount),
        vaultSupplyExchangePrice: str(vx.vaultSupplyExchangePrice),
        vaultBorrowExchangePrice: str(vx.vaultBorrowExchangePrice),
        vaultLastUpdateAgeSec: nowS - Number(st.lastUpdateTimestamp),
        debtLayerUtilization: brT.utilization,
        debtLayerAvailable: str(brT.available),
        debtLayerBorrowApr: brT.borrowApr,
        supplyRateMagnifier: cfg.supplyRateMagnifier,
        borrowRateMagnifier: cfg.borrowRateMagnifier,
        oraclePrice: price,
        oraclePriceUnit: `${r.debtSymbol} per ${r.symbol} (cache price / 1e18)`,
        oraclePriceTs: cache ? Number(cache.lastUpdateTimestampPrice) : null,
        oraclePriceAgeSec: cache ? nowS - Number(cache.lastUpdateTimestampPrice) : null,
        oracleMarketStatus: cache?.marketStatus ?? null,
        oracleSuspended: cache?.xstocksSuspended ?? null,
        oracleMultiplier: cache ? Number(cache.lastMultiplier) / 1e18 : null,
        aggregateLtv:
          price && colTokens > 0n
            ? ui(debtTokens, debtDec) / (ui(colTokens, colDec) * price)
            : null,
        collateralFactor: cfg.collateralFactor / 1000,
        liquidationThreshold: cfg.liquidationThreshold / 1000,
        liquidationPenalty: cfg.liquidationPenalty / 10_000,
      });
    } catch (e) {
      failures.push(`${r.account}: ${String(e).slice(0, 120)}`);
      rows.push({
        ...base(r, 'failure', 'jupiter_lend_vault_decode'),
        slot,
        error: String(e).slice(0, 200),
      });
    }
  }

  // curated vaults
  for (const r of kv) {
    try {
      const s = decodeKvaultState(get(r.account) as Uint8Array);
      let aum = Number(s.tokenAvailable);
      const allocs = s.allocations.map((a) => {
        const res = reserves.get(a.reserve);
        const st = res ? kaminoReserveState(res, { slotMs: ms ?? undefined }) : null;
        const liq = st ? Number(a.ctokenAllocation) * st.exchangeRate : null;
        if (liq !== null) aum += liq;
        const held = tokenAmount(get(a.ctokenVault));
        return {
          reserve: a.reserve,
          market: res?.lendingMarket ?? null,
          registered: kamino.some((k) => k.account === a.reserve),
          ctokens: str(a.ctokenAllocation),
          ctokenVaultMatches: held === null ? null : held === a.ctokenAllocation,
          liquidity: liq === null ? null : liq / 10 ** s.tokenMintDecimals,
          shareOfReserveSupply:
            st && liq !== null && st.supplied > 0n ? liq / Number(st.supplied) : null,
          reserveUtilization: st?.utilization ?? null,
        };
      });
      const pending = sfToNumber(s.pendingFeesSf);
      rows.push({
        ...base(r, 'kvault', 'kvault_state_decode'),
        slot,
        name: s.name,
        tokenMint: s.tokenMint,
        idleUi: Number(s.tokenAvailable) / 10 ** s.tokenMintDecimals,
        aumUi: (aum - pending) / 10 ** s.tokenMintDecimals,
        sharesIssuedUi: Number(s.sharesIssued) / 10 ** s.sharesMintDecimals,
        sharePrice:
          s.sharesIssued > 0n
            ? (aum - pending) /
              10 ** s.tokenMintDecimals /
              (Number(s.sharesIssued) / 10 ** s.sharesMintDecimals)
            : null,
        allocations: allocs,
        allocationsMissingReserve: allocs.filter((a) => a.liquidity === null).length,
      });
    } catch (e) {
      failures.push(`${r.account}: ${String(e).slice(0, 120)}`);
      rows.push({
        ...base(r, 'failure', 'kvault_state_decode'),
        slot,
        error: String(e).slice(0, 200),
      });
    }
  }
  appendFileSync(join(outDir, `${day}.jsonl`), rows.map((x) => `${JSON.stringify(x)}\n`).join(''));

  // hourly: positions and raw state
  let hourly: Record<string, unknown> | null = null;
  const posDir = join(HOME, 'lending-positions', day, hour);
  if (!existsSync(join(posDir, '.done'))) {
    hourly = { obligations: 0, jlPositions: 0, bytes: 0 };
    mkdirSync(posDir, { recursive: true });
    const rawDir = join(HOME, 'raw-lending', day);
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(
      join(rawDir, `${hour}.json.gz`),
      gzipSync(
        JSON.stringify({
          fetchedAt,
          slot,
          source: SOURCE,
          accounts: Object.fromEntries(
            [...accounts].map(([k, v]) => [
              k,
              { owner: v.owner, b64: Buffer.from(v.data).toString('base64') },
            ]),
          ),
        }),
      ),
    );
    // Kamino obligations per market
    for (const m of [...new Set(kamino.map((r) => r.market))]) {
      if (existsSync(join(posDir, `kamino-${m}.jsonl.gz`))) continue; // done earlier this hour
      try {
        const obs = await programAccounts(KLEND_PROGRAM, [
          { dataSize: KAMINO_OBLIGATION_SIZE },
          { memcmp: { offset: KAMINO_MARKET_OFFSET, bytes: m } },
        ]);
        const pSlot = slot;
        const decoded: string[] = [];
        for (const o of obs) {
          const d = decodeKaminoObligation(o.data);
          let colUsd = 0;
          let liqWeighted = 0;
          let debtUsd = 0;
          const deposits = d.deposits.map((x) => {
            const res = reserves.get(x.reserve);
            const st = res ? kaminoReserveState(res) : null;
            const amount =
              st && res ? (Number(x.depositedAmount) * st.exchangeRate) / st.scale : null;
            const usd = amount !== null && st ? amount * st.priceUsd : null;
            if (usd !== null && res) {
              colUsd += usd;
              liqWeighted += usd * (res.config.liquidationThresholdPct / 100);
            }
            return {
              reserve: x.reserve,
              symbol: kamino.find((k) => k.account === x.reserve)?.symbol ?? null,
              ctokens: str(x.depositedAmount),
              amount,
              usd,
            };
          });
          const borrows = d.borrows.map((b) => {
            const res = reserves.get(b.reserve);
            const st = res ? kaminoReserveState(res) : null;
            const amount =
              res && st
                ? sfToNumber(kaminoAccruedDebtSf(b, res.cumulativeBorrowRateBsf)) / st.scale
                : null;
            const usd = amount !== null && st ? amount * st.priceUsd : null;
            if (usd !== null) debtUsd += usd;
            return {
              reserve: b.reserve,
              symbol: kamino.find((k) => k.account === b.reserve)?.symbol ?? null,
              amount,
              usd,
            };
          });
          decoded.push(
            JSON.stringify({
              obligation: o.pubkey,
              owner: d.owner,
              market: m,
              slot: pSlot,
              fetchedAt,
              deposits,
              borrows,
              collateralUsd: colUsd,
              debtUsd,
              ltv: colUsd > 0 ? debtUsd / colUsd : null,
              liquidationLtv: colUsd > 0 ? liqWeighted / colUsd : null,
              elevationGroup: d.elevationGroup,
              method:
                'kamino_obligation_decode; amounts at reserve exchange rate and price of this run',
            }),
          );
        }
        const raw = gzipSync(
          JSON.stringify({
            fetchedAt,
            slot: pSlot,
            market: m,
            accounts: Object.fromEntries(
              obs.map((o) => [o.pubkey, Buffer.from(o.data).toString('base64')]),
            ),
          }),
        );
        writeFileSync(join(posDir, `kamino-${m}.raw.json.gz`), raw);
        writeFileSync(join(posDir, `kamino-${m}.jsonl.gz`), gzipSync(`${decoded.join('\n')}\n`));
        hourly.obligations = Number(hourly.obligations) + obs.length;
        hourly.bytes = Number(hourly.bytes) + raw.length;
      } catch (e) {
        failures.push(`obligations ${m}: ${String(e).slice(0, 120)}`);
      }
      await sleep(300);
    }
    // Jupiter Lend positions: one filtered getProgramAccounts per vault (vault id, u16 LE at offset 8). An
    // unfiltered scan returns all 62k positions of the program in about 100 s, past the timeout.
    try {
      const byVault = new Map<number, Array<{ pubkey: string; data: Uint8Array }>>();
      for (const r of jl) {
        const vid = Number(r.params.vaultId);
        if (existsSync(join(posDir, `jupiter_lend-${vid}.jsonl.gz`))) continue;
        byVault.set(
          vid,
          await programAccounts(JL_VAULTS_PROGRAM, [
            { dataSize: JL_POSITION_SIZE },
            { memcmp: { offset: 8, bytes: b58.decode(new Uint8Array([vid & 0xff, vid >> 8])) } },
          ]),
        );
        await sleep(200);
      }
      const ids = new Map(jl.map((r) => [Number(r.params.vaultId), r]));
      for (const [vid, arr] of byVault) {
        const r = ids.get(vid) as RegRow;
        const st = decodeJlVaultState(get(r.accounts.state) as Uint8Array);
        const cacheKey = (r.oracles.sources as Array<{ source: string }>)?.[0]?.source;
        const cd = cacheKey ? get(cacheKey) : undefined;
        const price = cd ? Number(decodeJlChainlinkCache(cd).price) / 1e18 : null;
        const vx = vaultEx.get(vid) ?? {
          vaultSupplyExchangePrice: st.vaultSupplyExchangePrice,
          vaultBorrowExchangePrice: st.vaultBorrowExchangePrice,
        };
        const decoded = arr.map((a) => {
          const p = decodeJlPosition(a.data);
          const amt = jlPositionAmounts(p, st.topmostTick);
          const col = ui(
            (amt.colRaw * vx.vaultSupplyExchangePrice) / JL_EXCHANGE_PRICE_PRECISION,
            JL_VAULT_INTERNAL_DECIMALS,
          );
          const debtRaw = amt.debtRaw > amt.dustDebtRaw ? amt.debtRaw - amt.dustDebtRaw : 0n;
          const debt = ui(
            (debtRaw * vx.vaultBorrowExchangePrice) / JL_EXCHANGE_PRICE_PRECISION,
            JL_VAULT_INTERNAL_DECIMALS,
          );
          return JSON.stringify({
            position: a.pubkey,
            vaultId: vid,
            nftId: p.nftId,
            positionMint: p.positionMint,
            tick: p.tick,
            slot,
            fetchedAt,
            collateral: col,
            debt,
            ltv: price && col > 0 ? debt / (col * price) : null,
            supplyOnly: p.isSupplyOnly === 1,
            liquidatedBranch: amt.liquidatedBranch,
            method:
              'jupiter_lend_position_decode (debt from tick ratio, net of dust debt; liquidated branches flagged, not resolved)',
          });
        });
        const raw = gzipSync(
          JSON.stringify({
            fetchedAt,
            slot,
            vaultId: vid,
            accounts: Object.fromEntries(
              arr.map((a) => [a.pubkey, Buffer.from(a.data).toString('base64')]),
            ),
          }),
        );
        writeFileSync(join(posDir, `jupiter_lend-${vid}.raw.json.gz`), raw);
        writeFileSync(
          join(posDir, `jupiter_lend-${vid}.jsonl.gz`),
          gzipSync(`${decoded.join('\n')}\n`),
        );
        hourly.jlPositions = Number(hourly.jlPositions) + arr.length;
        hourly.bytes = Number(hourly.bytes) + raw.length;
      }
    } catch (e) {
      failures.push(`jl positions: ${String(e).slice(0, 120)}`);
    }
    // the hour is complete once every market and vault has its file; a missing one is retried by the next run
    const complete =
      [...new Set(kamino.map((r) => r.market))].every((m) =>
        existsSync(join(posDir, `kamino-${m}.jsonl.gz`)),
      ) &&
      jl.every((r) =>
        existsSync(join(posDir, `jupiter_lend-${Number(r.params.vaultId)}.jsonl.gz`)),
      );
    if (complete) writeFileSync(join(posDir, '.done'), fetchedAt);
    hourly.complete = complete;
  }

  const summary = {
    kind: 'run',
    fetchedAt,
    slot,
    slotMs: ms,
    accountsRequested: keys.length,
    accountsRead: accounts.size,
    rows: rows.length,
    byKind: rows.reduce((m: Record<string, number>, x) => {
      m[String(x.kind)] = (m[String(x.kind)] ?? 0) + 1;
      return m;
    }, {}),
    hourly,
    failures: failures.length,
    failureSample: failures.slice(0, 3),
    rpc: stats,
    seconds: Math.round((Date.now() - started) / 1000),
    registryMethodVersion: reg.methodVersion,
    methodVersion: LENDING_METHOD_VERSION,
  };
  appendFileSync(join(outDir, 'runs.jsonl'), `${JSON.stringify(summary)}\n`);
  console.log(JSON.stringify(summary));
}

await main();
