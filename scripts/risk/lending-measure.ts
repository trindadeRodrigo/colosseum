import 'dotenv/config';
import {
  decodeJlChainlinkCache,
  decodeJlOracle,
  decodeJlRateModel,
  decodeJlTokenReserve,
  decodeJlUserBorrowPosition,
  decodeJlUserSupplyPosition,
  decodeJlVaultConfig,
  decodeJlVaultState,
  decodeKaminoObligation,
  decodeKaminoReserve,
  decodeKvaultState,
  discOf,
  eventDisc,
  JL_LIQUIDITY_PROGRAM,
  JL_VAULT_CONFIG_SIZE,
  JL_VAULTS_PROGRAM,
  jlPositionTokens,
  jlTokenTotals,
  KAMINO_MARKET_OFFSET,
  KAMINO_OBLIGATION_SIZE,
  KAMINO_RESERVE_MINT_OFFSET,
  KAMINO_RESERVE_SIZE,
  type KaminoReserve,
  KLEND_PROGRAM,
  KVAULT_PROGRAM,
  KVAULT_STATE_SIZE,
  kaminoAccruedDebtSf,
  kaminoReserveState,
  parseLogs,
  type RpcTx,
  scopePrice,
  txAccountKeys,
} from '@colosseum/risk';
import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
} from '@solana/kit';
import { valuePools } from './lib-history';
import {
  LENDING_HISTORY_DIR,
  loadMeasure,
  measuredSlotMs,
  measureLog,
  multipleAccounts,
  programAccounts,
  readAddressSignatures,
  registryAssets,
  registryVaults,
  saveMeasure,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  tokenAccount,
  walkAddress,
} from './lib-lending';
import { rpc, rpcStats } from './lib-pools';

// Step 10b item 1 — verify and measure the lending venues before building on them (VL-1 … VL-8).
// Usage: pnpm risk:lending-measure <vl1|vl2|vl3|vl4|vl5|vl6|vl7|vl8>
// Each task appends {vl, command, value} rows to data/risk/lending-measure.jsonl and saves its full output to
// data/risk/lending-measure/<task>.json, which the registry (item 2) reads.
const mode = process.argv[2] ?? 'vl1';
const command = `pnpm risk:lending-measure ${process.argv.slice(2).join(' ')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const JUP_PRICE = 'https://lite-api.jup.ag/price/v3';
const KAMINO_SEED_CTOKENS = 100_000n;
const JL_API = 'https://lite-api.jup.ag/lend/v1/borrow/vaults';

async function jupPrices(mints: string[]) {
  const out = new Map<string, { usdPrice: number; multiplier: number }>();
  for (let i = 0; i < mints.length; i += 50) {
    const r = (await (
      await fetch(`${JUP_PRICE}?ids=${mints.slice(i, i + 50).join(',')}`, {
        signal: AbortSignal.timeout(30_000),
      })
    ).json()) as Record<
      string,
      { usdPrice: number; decimals: number; scaledUiConfig?: { multiplier: number } }
    >;
    for (const [m, v] of Object.entries(r))
      out.set(m, { usdPrice: v.usdPrice, multiplier: v.scaledUiConfig?.multiplier ?? 1 });
  }
  return out;
}

async function vl1() {
  const t0 = Date.now();
  const assets = registryAssets();
  // (a) Kamino reserves whose liquidity mint is an xStock, then every reserve of those markets
  const xReserves: Array<{ reserve: string; market: string; mint: string; symbol: string }> = [];
  for (const [mint, symbol] of assets) {
    const found = await programAccounts(
      KLEND_PROGRAM,
      [
        { dataSize: KAMINO_RESERVE_SIZE },
        { memcmp: { offset: KAMINO_RESERVE_MINT_OFFSET, bytes: mint } },
      ],
      { offset: KAMINO_MARKET_OFFSET, length: 32 },
    );
    for (const a of found)
      xReserves.push({
        reserve: a.pubkey,
        market: b58(a.data),
        mint,
        symbol,
      });
    await sleep(250);
  }
  const markets = [...new Set(xReserves.map((r) => r.market))];
  const kamino: Array<Record<string, unknown>> = [];
  for (const m of markets) {
    const rs = await programAccounts(KLEND_PROGRAM, [
      { dataSize: KAMINO_RESERVE_SIZE },
      { memcmp: { offset: KAMINO_MARKET_OFFSET, bytes: m } },
    ]);
    for (const a of rs) {
      const r = decodeKaminoReserve(a.data);
      const s = kaminoReserveState(r);
      kamino.push({
        market: m,
        reserve: a.pubkey,
        mint: r.liquidityMint,
        symbol: assets.get(r.liquidityMint) ?? r.config.name,
        isXStock: assets.has(r.liquidityMint),
        status: r.config.status,
        decimals: r.mintDecimals,
        supplied: s.supplied.toString(),
        borrowed: s.borrowed.toString(),
        priceUsd: s.priceUsd,
        suppliedUsd: (Number(s.supplied) / s.scale) * s.priceUsd,
        borrowedUsd: (Number(s.borrowed) / s.scale) * s.priceUsd,
      });
    }
    await sleep(250);
  }
  // (b) Jupiter Lend: API vaults and on-chain vault configs
  const apiVaults = (await (
    await fetch(JL_API, { signal: AbortSignal.timeout(30_000) })
  ).json()) as Array<{
    id: number;
    address: string;
    supplyToken: { address: string; symbol: string };
    borrowToken: { address: string; symbol: string };
  }>;
  const cfgs = await programAccounts(JL_VAULTS_PROGRAM, [{ dataSize: JL_VAULT_CONFIG_SIZE }]);
  const onchainVaults = cfgs.map((a) => ({ address: a.pubkey, ...decodeJlVaultConfig(a.data) }));
  const jlX = onchainVaults.filter((v) => assets.has(v.supplyToken) || assets.has(v.borrowToken));
  const apiX = apiVaults.filter(
    (v) => assets.has(v.supplyToken.address) || assets.has(v.borrowToken.address),
  );
  const onlyOnchain = jlX.filter((v) => !apiX.some((a) => a.address === v.address));
  const onlyApi = apiX.filter((a) => !jlX.some((v) => v.address === a.address));

  // (c) every token account holding the 18 assets of the 80% set, grouped by holder
  const known = new Map<string, string>(registryVaults());
  const kaminoVaults = await multipleAccounts(kamino.map((k) => String(k.reserve)));
  for (const [k, acc] of kaminoVaults.accounts) {
    if (!acc) continue;
    const r = decodeKaminoReserve(acc.data);
    known.set(r.liquiditySupplyVault, `kamino_reserve_liquidity:${k}`);
    known.set(r.collateralSupplyVault, `kamino_reserve_collateral:${k}`);
    known.set(r.liquidityFeeVault, `kamino_reserve_fee:${k}`);
  }
  const heldMints = [...new Set(valuePools().map((p) => p.assetMint))];
  // the liquidity layer's TokenReserve.vault per mint (PDA ["reserve", mint]); found by memcmp on mint
  for (const mint of heldMints) {
    const tr = await programAccounts(JL_LIQUIDITY_PROGRAM, [
      { memcmp: { offset: 8, bytes: mint } },
    ]);
    for (const a of tr)
      if (a.data.length === 192)
        known.set(b58(a.data.subarray(40, 72)), `jupiter_lend_liquidity:${a.pubkey}`);
    await sleep(250);
  }
  const prices = await jupPrices(heldMints);
  const mintInfo = await multipleAccounts(heldMints);
  const holders: Array<Record<string, unknown>> = [];
  const byClass = new Map<string, { usd: number; accounts: number }>();
  for (const mint of heldMints) {
    const program = mintInfo.accounts.get(mint)?.owner ?? TOKEN_2022_PROGRAM;
    const accs = await programAccounts(program, [{ memcmp: { offset: 0, bytes: mint } }], {
      offset: 32,
      length: 40,
    });
    const p = prices.get(mint);
    const rows = accs
      .map((a) => {
        const v = new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength);
        const raw = v.getBigUint64(32, true);
        return { account: a.pubkey, authority: b58(a.data.subarray(0, 32)), raw };
      })
      .filter((r) => r.raw > 0n);
    const decimals = mintInfo.accounts.get(mint)?.data[44] ?? 8;
    for (const r of rows) {
      const usd = p ? (Number(r.raw) / 10 ** decimals) * p.multiplier * p.usdPrice : 0;
      holders.push({ mint, symbol: assets.get(mint), ...r, raw: r.raw.toString(), usd });
    }
    await sleep(300);
  }
  // classify authorities: known vault accounts first, then the authority account's owner program
  const big = holders.filter((h) => !known.has(String(h.account)) && Number(h.usd) >= 10_000);
  const auths = [...new Set(big.map((h) => String(h.authority)))];
  const authInfo = await multipleAccounts(auths);
  for (const h of holders) {
    const k = known.get(String(h.account));
    let cls: string;
    if (k) cls = k.split(':')[0] as string;
    else if (Number(h.usd) < 10_000) cls = 'small_holders(<$10k)';
    else {
      const a = authInfo.accounts.get(String(h.authority));
      cls = !a
        ? 'pda_no_account'
        : a.owner === '11111111111111111111111111111111'
          ? 'wallet'
          : `program:${a.owner}`;
    }
    h.class = cls;
    const c = byClass.get(cls) ?? { usd: 0, accounts: 0 };
    c.usd += Number(h.usd);
    c.accounts++;
    byClass.set(cls, c);
  }
  // for PDA authorities without an account, the last transaction of the token account names the program
  const pdaTop = holders
    .filter((h) => h.class === 'pda_no_account')
    .sort((a, b) => Number(b.usd) - Number(a.usd))
    .slice(0, 25);
  for (const h of pdaTop) {
    const sigs = await rpc<Array<{ signature: string }>>('getSignaturesForAddress', [
      h.account,
      { limit: 3 },
    ]);
    const programs = new Set<string>();
    for (const s of sigs.slice(0, 2)) {
      const tx = await rpc<{
        transaction: {
          message: { accountKeys: string[]; instructions: Array<{ programIdIndex: number }> };
        };
        meta: {
          loadedAddresses?: { writable: string[]; readonly: string[] };
          logMessages?: string[];
        };
      } | null>('getTransaction', [
        s.signature,
        { encoding: 'json', maxSupportedTransactionVersion: 1 },
      ]);
      for (const l of tx?.meta?.logMessages ?? []) {
        const m = /^Program (\w+) invoke \[1\]/.exec(l);
        if (m) programs.add(m[1] as string);
      }
    }
    h.invokedPrograms = [...programs];
  }
  const totalUsd = holders.reduce((s, h) => s + Number(h.usd), 0);
  const value = {
    kaminoMarkets: markets.length,
    kaminoReserves: kamino.length,
    kaminoXStockReserves: kamino.filter((k) => k.isXStock).length,
    jupiterLendVaultsOnchain: onchainVaults.length,
    jupiterLendVaultsApi: apiVaults.length,
    jupiterLendXStockVaults: jlX.length,
    jupiterLendOnlyOnchain: onlyOnchain.map((v) => v.address),
    jupiterLendOnlyApi: onlyApi.map((v) => v.address),
    heldAssets: heldMints.length,
    holderAccounts: holders.length,
    heldUsd: Math.round(totalUsd),
    byClass: Object.fromEntries(
      [...byClass]
        .sort((a, b) => b[1].usd - a[1].usd)
        .map(([k, v]) => [k, { usd: Math.round(v.usd), accounts: v.accounts }]),
    ),
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  saveMeasure('vl1', {
    value,
    kamino,
    jupiterLend: jlX,
    jupiterLendApi: apiX.map((v) => ({
      id: v.id,
      address: v.address,
      supply: v.supplyToken.symbol,
      borrow: v.borrowToken.symbol,
    })),
    holders: holders
      .filter((h) => Number(h.usd) >= 10_000)
      .sort((a, b) => Number(b.usd) - Number(a.usd)),
    prices: Object.fromEntries(prices),
    priceSource: JUP_PRICE,
    fetchedAt: new Date().toISOString(),
  });
  measureLog({ vl: 'VL-1', command, value, rpc: rpcStats });
}

const addrDec = getAddressDecoder();
const addrEnc = getAddressEncoder();
function b58(b: Uint8Array): string {
  return addrDec.decode(b.subarray(0, 32));
}

type Vl1 = {
  kamino: Array<{
    market: string;
    reserve: string;
    mint: string;
    symbol: string;
    isXStock: boolean;
  }>;
  jupiterLend: Array<{
    address: string;
    vaultId: number;
    supplyToken: string;
    borrowToken: string;
  }>;
};
const KAMINO_API = 'https://api.kamino.finance';
const rel = (a: number, b: number) =>
  a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-18);

/** VL-2 (Kamino): account map per reserve, hand reader vs klend-sdk, totals and rates vs the API, oracle
 *  price (Scope chain) vs the reserve's refreshed price, vault balances vs reserve fields. */
async function vl2() {
  const { Reserve } = await import('@kamino-finance/klend-sdk');
  const v1 = loadMeasure<Vl1>('vl1');
  const assets = registryAssets();
  const reserves = v1.kamino;
  const markets = [...new Set(reserves.map((r) => r.market))];
  const apiAt = new Date().toISOString();
  const api = new Map<string, Record<string, string>>();
  for (const m of markets) {
    const res = await fetch(`${KAMINO_API}/kamino-market/${m}/reserves/metrics`, {
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (res?.ok)
      for (const r of (await res.json()) as Array<Record<string, string>>)
        api.set(String(r.reserve), r);
  }
  const slotMs = await measuredSlotMs();
  const { slot, accounts } = await multipleAccounts(reserves.map((r) => r.reserve));
  const decoded = new Map<string, KaminoReserve>();
  for (const [k, a] of accounts) if (a) decoded.set(k, decodeKaminoReserve(a.data));
  const scopeFeeds = [...new Set([...decoded.values()].map((r) => r.config.scopePriceFeed))];
  const vaultKeys = [...decoded.values()].flatMap((r) => [
    r.liquiditySupplyVault,
    r.collateralSupplyVault,
    r.liquidityFeeVault,
    r.collateralMint,
  ]);
  const extra = await multipleAccounts([...scopeFeeds, ...vaultKeys, ...markets]);
  const rows: Array<Record<string, unknown>> = [];
  let fieldMismatches = 0;
  for (const res of reserves) {
    const acc = accounts.get(res.reserve);
    if (!acc) {
      rows.push({ reserve: res.reserve, error: 'account not found' });
      continue;
    }
    const h = decoded.get(res.reserve) as KaminoReserve;
    const sdk = Reserve.decode(Buffer.from(acc.data));
    const c = sdk.config;
    const pairs: Array<[string, unknown, unknown]> = [
      ['lendingMarket', h.lendingMarket, sdk.lendingMarket],
      ['liquidityMint', h.liquidityMint, sdk.liquidity.mintPubkey],
      ['liquiditySupplyVault', h.liquiditySupplyVault, sdk.liquidity.supplyVault],
      ['liquidityFeeVault', h.liquidityFeeVault, sdk.liquidity.feeVault],
      ['availableAmount', h.availableAmount, BigInt(sdk.liquidity.totalAvailableAmount.toString())],
      ['borrowedAmountSf', h.borrowedAmountSf, BigInt(sdk.liquidity.borrowedAmountSf.toString())],
      ['marketPriceSf', h.marketPriceSf, BigInt(sdk.liquidity.marketPriceSf.toString())],
      ['mintDecimals', BigInt(h.mintDecimals), BigInt(sdk.liquidity.mintDecimals.toString())],
      [
        'cumulativeBorrowRateBsf',
        h.cumulativeBorrowRateBsf,
        sdk.liquidity.cumulativeBorrowRateBsf.value.reduce(
          (s: bigint, x: { toString(): string }, i: number) =>
            s + (BigInt(x.toString()) << BigInt(64 * i)),
          0n,
        ),
      ],
      [
        'accumulatedProtocolFeesSf',
        h.accumulatedProtocolFeesSf,
        BigInt(sdk.liquidity.accumulatedProtocolFeesSf.toString()),
      ],
      ['collateralMint', h.collateralMint, sdk.collateral.mintPubkey],
      [
        'collateralMintTotalSupply',
        h.collateralMintTotalSupply,
        BigInt(sdk.collateral.mintTotalSupply.toString()),
      ],
      ['collateralSupplyVault', h.collateralSupplyVault, sdk.collateral.supplyVault],
      ['status', h.config.status, c.status],
      ['loanToValuePct', h.config.loanToValuePct, c.loanToValuePct],
      ['liquidationThresholdPct', h.config.liquidationThresholdPct, c.liquidationThresholdPct],
      ['minLiquidationBonusBps', h.config.minLiquidationBonusBps, c.minLiquidationBonusBps],
      ['maxLiquidationBonusBps', h.config.maxLiquidationBonusBps, c.maxLiquidationBonusBps],
      [
        'badDebtLiquidationBonusBps',
        h.config.badDebtLiquidationBonusBps,
        c.badDebtLiquidationBonusBps,
      ],
      ['protocolTakeRatePct', h.config.protocolTakeRatePct, c.protocolTakeRatePct],
      [
        'interestRateBasis',
        h.config.interestRateBasis,
        (c as unknown as { interestRateBasis: number }).interestRateBasis,
      ],
      ['hostFixedInterestRateBps', h.config.hostFixedInterestRateBps, c.hostFixedInterestRateBps],
      [
        'borrowRateCurve',
        JSON.stringify(h.config.borrowRateCurve),
        JSON.stringify(
          c.borrowRateCurve.points.map(
            (p: { utilizationRateBps: number; borrowRateBps: number }) => ({
              utilizationBps: p.utilizationRateBps,
              borrowRateBps: p.borrowRateBps,
            }),
          ),
        ),
      ],
      ['depositLimit', h.config.depositLimit, BigInt(c.depositLimit.toString())],
      ['borrowLimit', h.config.borrowLimit, BigInt(c.borrowLimit.toString())],
      ['name', h.config.name, Buffer.from(c.tokenInfo.name).toString('utf8').replace(/\0+$/, '')],
      [
        'maxAgePriceSeconds',
        h.config.maxAgePriceSeconds,
        BigInt(c.tokenInfo.maxAgePriceSeconds.toString()),
      ],
      ['heuristicLower', h.config.heuristic.lower, BigInt(c.tokenInfo.heuristic.lower.toString())],
      ['scopePriceFeed', h.config.scopePriceFeed, c.tokenInfo.scopeConfiguration.priceFeed],
      [
        'scopePriceChain',
        JSON.stringify(h.config.scopePriceChain),
        JSON.stringify(
          c.tokenInfo.scopeConfiguration.priceChain.filter((x: number) => x !== 65535),
        ),
      ],
      ['pythPrice', h.config.pythPrice, c.tokenInfo.pythConfiguration.price],
      [
        'depositWithdrawalCapCapacity',
        h.config.depositWithdrawalCap.capacity,
        BigInt(c.depositWithdrawalCap.configCapacity.toString()),
      ],
      [
        'debtWithdrawalCapCapacity',
        h.config.debtWithdrawalCap.capacity,
        BigInt(c.debtWithdrawalCap.configCapacity.toString()),
      ],
      [
        'utilizationLimitBlockBorrowingAbovePct',
        h.config.utilizationLimitBlockBorrowingAbovePct,
        c.utilizationLimitBlockBorrowingAbovePct,
      ],
      [
        'withdrawQueueCollateral',
        h.withdrawQueueCollateral,
        BigInt(sdk.withdrawQueue.queuedCollateralAmount.toString()),
      ],
    ];
    const mismatches = pairs
      .filter(([, a, b]) => String(a) !== String(b))
      .map(([k, a, b]) => ({ field: k, hand: String(a), sdk: String(b) }));
    fieldMismatches += mismatches.length;
    const st = kaminoReserveState(h, { slotMs });
    const a = api.get(res.reserve);
    const scope = extra.accounts.get(h.config.scopePriceFeed);
    let oracle: Record<string, unknown> = { error: 'scope feed not found' };
    if (scope && h.config.scopePriceChain.length) {
      const sp = scopePrice(scope.data, h.config.scopePriceChain);
      oracle = {
        scopePrice: sp.price,
        scopeTs: sp.ts,
        reservePrice: st.priceUsd,
        reservePriceTs: st.priceTs,
        relGap: rel(sp.price, st.priceUsd),
      };
    }
    const bal = (k: string) => {
      const x = extra.accounts.get(k);
      return x ? tokenAccount(x.data).amount : null;
    };
    const liqVault = bal(h.liquiditySupplyVault);
    const colVault = bal(h.collateralSupplyVault);
    rows.push({
      market: res.market,
      reserve: res.reserve,
      symbol: assets.get(h.liquidityMint) ?? h.config.name,
      accounts: {
        liquidityMint: h.liquidityMint,
        liquiditySupplyVault: h.liquiditySupplyVault,
        liquidityFeeVault: h.liquidityFeeVault,
        collateralMint: h.collateralMint,
        collateralSupplyVault: h.collateralSupplyVault,
        scopePriceFeed: h.config.scopePriceFeed,
        scopePriceChain: h.config.scopePriceChain,
        pythPrice: h.config.pythPrice,
        switchboardPriceAggregator: h.config.switchboardPriceAggregator,
        farmCollateral: h.farmCollateral,
        farmDebt: h.farmDebt,
        tokenProgram: h.tokenProgram,
      },
      sdkFieldsChecked: pairs.length,
      mismatches,
      onchain: {
        supplied: Number(st.supplied) / st.scale,
        borrowed: Number(st.borrowed) / st.scale,
        available: Number(st.available) / st.scale,
        utilization: st.utilization,
        supplyApy: st.supplyApy,
        borrowApy: st.borrowApy,
      },
      api: a
        ? {
            totalSupply: Number(a.totalSupply),
            totalBorrow: Number(a.totalBorrow),
            supplyApy: Number(a.supplyApy),
            borrowApy: Number(a.borrowApy),
            maxLtv: Number(a.maxLtv),
          }
        : null,
      relGap: a
        ? {
            supply: rel(Number(st.supplied) / st.scale, Number(a.totalSupply)),
            borrow: rel(Number(st.borrowed) / st.scale, Number(a.totalBorrow)),
            supplyApy: Math.abs(st.supplyApy - Number(a.supplyApy)),
            borrowApy: Math.abs(st.borrowApy - Number(a.borrowApy)),
            ltv: Math.abs(h.config.loanToValuePct / 100 - Number(a.maxLtv)),
          }
        : null,
      oracle,
      vaults: {
        liquidityVaultBalance: liqVault?.toString(),
        availableAmount: h.availableAmount.toString(),
        liquidityVaultMinusAvailable:
          liqVault !== null ? (liqVault - h.availableAmount).toString() : null,
        collateralVaultBalance: colVault?.toString(),
        collateralMintTotalSupply: h.collateralMintTotalSupply.toString(),
      },
    });
  }
  const ok = rows.filter((r) => !r.error);
  const withApi = ok.filter((r) => r.relGap);
  const maxGap = (k: string) =>
    Math.max(0, ...withApi.map((r) => Number((r.relGap as Record<string, number>)[k])));
  const value = {
    reserves: rows.length,
    decoded: ok.length,
    sdkFieldsCompared: ok.reduce((s, r) => s + Number(r.sdkFieldsChecked), 0),
    handVsSdkMismatches: fieldMismatches,
    withApiRow: withApi.length,
    maxRelGapSupply: maxGap('supply'),
    maxRelGapBorrow: maxGap('borrow'),
    maxAbsGapSupplyApy: maxGap('supplyApy'),
    maxAbsGapBorrowApy: maxGap('borrowApy'),
    maxAbsGapLtv: maxGap('ltv'),
    maxScopeVsReservePriceGap: Math.max(
      0,
      ...ok
        .filter((r) => Number((r.oracle as { reservePrice?: number }).reservePrice) > 0)
        .map((r) => Number((r.oracle as { relGap?: number }).relGap ?? 0)),
    ),
    neverPricedReserves: ok
      .filter((r) => !(Number((r.oracle as { reservePrice?: number }).reservePrice) > 0))
      .map((r) => `${r.symbol}:${r.reserve}`),
    liquidityVaultEqualsAvailable: ok.filter(
      (r) => (r.vaults as Record<string, string>).liquidityVaultMinusAvailable === '0',
    ).length,
    slot,
    slotMs,
    apiAt,
  };
  saveMeasure('vl2', {
    value,
    rows,
    source: {
      onchain: 'Solana RPC getMultipleAccounts',
      api: `${KAMINO_API}/kamino-market/<market>/reserves/metrics`,
      sdk: '@kamino-finance/klend-sdk 12.0.1 Reserve.decode',
    },
  });
  measureLog({ vl: 'VL-2', command, value });
}

const enc = new TextEncoder();
const le = (n: number, bytes: number) => {
  const b = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) b[i] = (n >> (8 * i)) & 0xff;
  return b;
};
const pda = async (program: string, seeds: Array<Uint8Array | string>) =>
  (
    await getProgramDerivedAddress({
      programAddress: address(program),
      seeds: seeds.map((s) =>
        typeof s === 'string' && s.length > 30
          ? addrEnc.encode(address(s))
          : typeof s === 'string'
            ? enc.encode(s)
            : s,
      ),
    })
  )[0] as string;

/** Every account a Jupiter Lend vault touches, derived as the read SDK derives them. */
export async function jlVaultAccounts(v: {
  address: string;
  vaultId: number;
  supplyToken: string;
  borrowToken: string;
  oracle: string;
}) {
  const state = await pda(JL_VAULTS_PROGRAM, ['vault_state', le(v.vaultId, 2)]);
  const liq = JL_LIQUIDITY_PROGRAM;
  return {
    config: v.address,
    state,
    oracle: v.oracle,
    supplyReserve: await pda(liq, ['reserve', v.supplyToken]),
    borrowReserve: await pda(liq, ['reserve', v.borrowToken]),
    supplyRateModel: await pda(liq, ['rate_model', v.supplyToken]),
    borrowRateModel: await pda(liq, ['rate_model', v.borrowToken]),
    // the vault is the liquidity layer's "protocol"; which vault PDA plays that role is checked below
    supplyPositionByConfig: await pda(liq, ['user_supply_position', v.supplyToken, v.address]),
    supplyPositionByState: await pda(liq, ['user_supply_position', v.supplyToken, state]),
    borrowPositionByConfig: await pda(liq, ['user_borrow_position', v.borrowToken, v.address]),
    borrowPositionByState: await pda(liq, ['user_borrow_position', v.borrowToken, state]),
    liquidity: await pda(liq, ['liquidity']),
  };
}

const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
/** SDK-decoded Anchor account → flat {camelKey: string}; BN/PublicKey/bool normalised. */
function normSdk(o: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    const key = prefix + camel(k);
    if (v === null || v === undefined) out[key] = String(v);
    else if (typeof v === 'boolean') out[key] = v ? '1' : '0';
    else if (typeof v === 'object' && typeof (v as { toBase58?: unknown }).toBase58 === 'function')
      out[key] = (v as { toBase58(): string }).toBase58();
    else if (
      typeof v === 'object' &&
      (v as { constructor?: { name?: string } }).constructor?.name === 'BN'
    )
      out[key] = (v as { toString(): string }).toString();
    else if (Array.isArray(v)) out[key] = String(v.length);
    else if (typeof v === 'object') {
      const keys = Object.keys(v as object);
      // Anchor enums decode to {variant: {}}
      if (
        keys.length === 1 &&
        JSON.stringify((v as Record<string, unknown>)[keys[0] as string]) === '{}'
      )
        out[key] = keys[0] as string;
      else Object.assign(out, normSdk(v as Record<string, unknown>, `${key}.`));
    } else out[key] = String(v);
  }
  return out;
}
/** Compare every field of a hand-decoded object with the SDK decode of the same bytes. */
function compareFields(
  hand: Record<string, unknown>,
  sdk: Record<string, string>,
  alias: Record<string, string> = {},
) {
  const res: Array<{ field: string; hand: string; sdk: string }> = [];
  let n = 0;
  for (const [k, v] of Object.entries(hand)) {
    if (typeof v === 'object' && v !== null && typeof v !== 'bigint') continue;
    const sk = alias[k] ?? k;
    if (!(sk in sdk)) continue;
    n++;
    if (String(v) !== sdk[sk]) res.push({ field: k, hand: String(v), sdk: sdk[sk] as string });
  }
  return { compared: n, mismatches: res };
}

/** VL-5 (Jupiter Lend): config, state and liquidity-layer positions decoded by hand vs the read SDK vs the API,
 *  oracle cache price vs the API price, and vault positions counted on-chain. */
async function vl5() {
  const { Client } = await import('@jup-ag/lend-read');
  const client = new Client(process.env.SOLANA_RPC_URL as string);
  const v1 = loadMeasure<Vl1>('vl1');
  const apiRows = (await (
    await fetch(JL_API, { signal: AbortSignal.timeout(30_000) })
  ).json()) as Array<Record<string, unknown> & { address: string }>;
  const api = new Map(apiRows.map((r) => [r.address, r]));
  const rows: Array<Record<string, unknown>> = [];
  let mismatches = 0;
  let checked = 0;
  let bytesCompared = 0;
  let bytesMismatched = 0;
  const big = (x: { toString(): string } | null | undefined) =>
    x === null || x === undefined ? null : BigInt(x.toString());
  for (const v of v1.jupiterLend) {
    const cfgAcc = (await multipleAccounts([v.address])).accounts.get(v.address);
    if (!cfgAcc) {
      rows.push({ vault: v.address, error: 'config not found' });
      continue;
    }
    const cfg = decodeJlVaultConfig(cfgAcc.data);
    const acc = await jlVaultAccounts({ ...v, oracle: cfg.oracle });
    const keys = Object.values(acc);
    const now = Math.floor(Date.now() / 1000);
    const { accounts } = await multipleAccounts(keys);
    const get = (k: string) => accounts.get(k)?.data;
    const st = decodeJlVaultState(get(acc.state) as Uint8Array);
    const supplyPosKey = get(acc.supplyPositionByConfig)
      ? acc.supplyPositionByConfig
      : acc.supplyPositionByState;
    const borrowPosKey = get(acc.borrowPositionByConfig)
      ? acc.borrowPositionByConfig
      : acc.borrowPositionByState;
    const sp = get(supplyPosKey)
      ? decodeJlUserSupplyPosition(get(supplyPosKey) as Uint8Array)
      : null;
    const bp = get(borrowPosKey)
      ? decodeJlUserBorrowPosition(get(borrowPosKey) as Uint8Array)
      : null;
    const sr = decodeJlTokenReserve(get(acc.supplyReserve) as Uint8Array);
    const br = decodeJlTokenReserve(get(acc.borrowReserve) as Uint8Array);
    const brTot = jlTokenTotals(br, now);
    const srTot = jlTokenTotals(sr, now);
    const orc = get(acc.oracle) ? decodeJlOracle(get(acc.oracle) as Uint8Array) : null;
    const srcKeys = orc?.sources.map((s) => s.source) ?? [];
    const srcAccs = await multipleAccounts(srcKeys);
    const caches = srcKeys.map((k) => {
      const a = srcAccs.accounts.get(k);
      return a
        ? { source: k, owner: a.owner, size: a.data.length, ...decodeJlChainlinkCache(a.data) }
        : { source: k, missing: true };
    });
    // the SDK's Anchor coders on the same bytes: the decoder check proper
    type Coder = {
      coder: { accounts: { decode(name: string, b: Buffer): Record<string, unknown> } };
    };
    const vp = client.vault as unknown as { program: Coder; oracle: Coder };
    const lp = client.liquidity as unknown as { program: Coder };
    const dec = (c: Coder, name: string, k: string) =>
      normSdk(c.coder.accounts.decode(name, Buffer.from(get(k) as Uint8Array)));
    const byBytes = [
      ['vaultConfig', compareFields(cfg, dec(vp.program, 'vaultConfig', acc.config))],
      ['vaultState', compareFields(st, dec(vp.program, 'vaultState', acc.state))],
      ['supplyTokenReserve', compareFields(sr, dec(lp.program, 'tokenReserve', acc.supplyReserve))],
      ['borrowTokenReserve', compareFields(br, dec(lp.program, 'tokenReserve', acc.borrowReserve))],
      [
        'supplyPosition',
        sp
          ? compareFields(sp, dec(lp.program, 'userSupplyPosition', supplyPosKey))
          : { compared: 0, mismatches: [{ field: 'missing', hand: '', sdk: '' }] },
      ],
      [
        'borrowPosition',
        bp
          ? compareFields(bp, dec(lp.program, 'userBorrowPosition', borrowPosKey))
          : { compared: 0, mismatches: [{ field: 'missing', hand: '', sdk: '' }] },
      ],
      [
        'borrowRateModel',
        compareFields(
          decodeJlRateModel(get(acc.borrowRateModel) as Uint8Array),
          dec(lp.program, 'rateModel', acc.borrowRateModel),
        ),
      ],
      [
        'oracle',
        orc
          ? compareFields(
              {
                nonce: orc.nonce,
                sources: orc.sources.length,
                ...Object.fromEntries(
                  orc.sources.flatMap((x, i) => [
                    [`s${i}source`, x.source],
                    [`s${i}invert`, x.invert],
                    [`s${i}multiplier`, x.multiplier],
                    [`s${i}divisor`, x.divisor],
                  ]),
                ),
              },
              (() => {
                const raw = vp.oracle.coder.accounts.decode(
                  'oracle',
                  Buffer.from(get(acc.oracle) as Uint8Array),
                ) as { nonce: number; sources: Array<Record<string, unknown>> };
                const o: Record<string, string> = {
                  nonce: String(raw.nonce),
                  sources: String(raw.sources.length),
                };
                raw.sources.forEach((x, i) => {
                  const n = normSdk(x);
                  o[`s${i}source`] = n.source as string;
                  o[`s${i}invert`] = n.invert as string;
                  o[`s${i}multiplier`] = n.multiplier as string;
                  o[`s${i}divisor`] = n.divisor as string;
                });
                return o;
              })(),
            )
          : { compared: 0, mismatches: [] },
      ],
      ...srcKeys.map((k) => {
        const a = srcAccs.accounts.get(k);
        if (!a)
          return [
            'cache',
            { compared: 0, mismatches: [{ field: 'missing', hand: k, sdk: '' }] },
          ] as const;
        const h = decodeJlChainlinkCache(a.data);
        const n = normSdk(
          vp.oracle.coder.accounts.decode('chainlinkDataStreamsCache', Buffer.from(a.data)),
        );
        return [
          'oracleCache',
          compareFields({ ...h, feeds: h.feeds }, n, {
            xstocksActivation: 'genericData.xstocksActivationDateTime',
            xstocksSuspended: 'genericData.xstocksSuspended',
            marketStatus: 'genericData.marketStatus',
            v11TransitionTimestamp: 'genericData.v11TransitionTimestampS',
            lastMultiplier: 'genericData.xstocksLastMultiplier',
          }),
        ] as const;
      }),
    ] as Array<
      readonly [
        string,
        { compared: number; mismatches: Array<{ field: string; hand: string; sdk: string }> },
      ]
    >;
    const byteFields = byBytes.reduce((s2, [, c]) => s2 + c.compared, 0);
    const byteMismatches = byBytes.flatMap(([n, c]) =>
      c.mismatches.map((m) => ({ account: n, ...m })),
    );
    bytesCompared += byteFields;
    bytesMismatched += byteMismatches.length;
    // SDK high-level reader (separate reads seconds later; amounts on busy layers accrue in between)
    const sdk = await client.vault.getVaultByVaultId(v.vaultId);
    const sdkTok = await client.liquidity.getOverallTokenData(sdk.constantViews.borrowToken);
    const pairs: Array<[string, unknown, unknown]> = [
      ['supplyToken', cfg.supplyToken, sdk.constantViews.supplyToken.toBase58()],
      ['borrowToken', cfg.borrowToken, sdk.constantViews.borrowToken.toBase58()],
      ['collateralFactor', cfg.collateralFactor, Number(sdk.configs.collateralFactor.toString())],
      [
        'liquidationThreshold',
        cfg.liquidationThreshold,
        Number(sdk.configs.liquidationThreshold.toString()),
      ],
      [
        'liquidationMaxLimit',
        cfg.liquidationMaxLimit,
        Number(sdk.configs.liquidationMaxLimit.toString()),
      ],
      [
        'liquidationPenalty',
        cfg.liquidationPenalty,
        Number(sdk.configs.liquidationPenalty.toString()),
      ],
      ['withdrawGap', cfg.withdrawGap, Number(sdk.configs.withdrawalGap.toString())],
      ['borrowFee', cfg.borrowFee, Number(sdk.configs.borrowFee.toString())],
      ['oracle', cfg.oracle, sdk.configs.oracle.toBase58()],
      ['rebalancer', cfg.rebalancer, sdk.configs.rebalancer.toBase58()],
      ['totalSupply', st.totalSupply, big(sdk.vaultState.totalSupply)],
      ['totalBorrow', st.totalBorrow, big(sdk.vaultState.totalBorrow)],
      ['totalPositions', st.totalPositions, sdk.vaultState.totalPositions],
      ['topmostTick', st.topmostTick, sdk.vaultState.topTick],
      ['currentBranchId', st.currentBranchId, sdk.vaultState.currentBranch],
      ['nextPositionId', st.nextPositionId, sdk.vaultState.nextPositionId],
      [
        'vaultSupplyExchangePrice',
        st.vaultSupplyExchangePrice,
        big(sdk.vaultState.vaultSupplyExchangePrice),
      ],
      [
        'vaultBorrowExchangePrice',
        st.vaultBorrowExchangePrice,
        big(sdk.vaultState.vaultBorrowExchangePrice),
      ],
      ['absorbedDebtAmount', st.absorbedDebtAmount, big(sdk.vaultState.absorbedDebtAmount)],
      [
        'liquiditySupplyPosition',
        sp ? jlPositionTokens(sp, srTot.supplyExchangePrice) : null,
        big(sdk.liquidityUserSupplyData.supply),
      ],
      [
        'liquidityBorrowPosition',
        bp ? jlPositionTokens(bp, brTot.borrowExchangePrice) : null,
        big(sdk.liquidityUserBorrowData.borrow),
      ],
      ['borrowTokenTotalSupply', brTot.supplied, big(sdkTok.totalSupply)],
      ['borrowTokenTotalBorrow', brTot.borrowed, big(sdkTok.totalBorrow)],
      ['borrowTokenBorrowRate', br.borrowRate, Number(sdkTok.borrowRate.toString())],
      [
        'borrowTokenSupplyRateBps',
        Math.round(brTot.supplyApr * 10_000),
        Number(sdkTok.supplyRate.toString()),
      ],
    ];
    const relOf = (a: unknown, b: unknown) => {
      if (typeof a === 'bigint' && typeof b === 'bigint')
        return a === b ? 0 : Number(a > b ? a - b : b - a) / Number(a > b ? a : b);
      return String(a) === String(b) ? 0 : 1;
    };
    const cmp = pairs.map(([k, a, b]) => ({
      field: k,
      hand: String(a),
      sdk: String(b),
      rel: relOf(a, b),
    }));
    // amounts accrue between the two reads (seconds apart): exact fields must match, accruing ones within 1e-6
    const accruing = new Set([
      'liquiditySupplyPosition',
      'liquidityBorrowPosition',
      'borrowTokenTotalSupply',
      'borrowTokenTotalBorrow',
      'borrowTokenSupplyRateBps',
    ]);
    const bad = cmp.filter((c) =>
      accruing.has(c.field)
        ? c.rel > 1e-6 &&
          !(c.field === 'borrowTokenSupplyRateBps' && Math.abs(Number(c.hand) - Number(c.sdk)) <= 1)
        : c.rel !== 0,
    );
    mismatches += bad.length;
    checked += cmp.length;
    const a = api.get(v.address) as Record<string, string> | undefined;
    const colDec = Number((a?.supplyToken as unknown as { decimals: number })?.decimals ?? 8);
    const debtDec = Number((a?.borrowToken as unknown as { decimals: number })?.decimals ?? 6);
    const cache = caches[0] as
      | { price?: bigint; lastUpdateTimestampPrice?: bigint; marketStatus?: number }
      | undefined;
    rows.push({
      vault: v.address,
      vaultId: v.vaultId,
      pair: `${a ? (a.supplyToken as unknown as { symbol: string }).symbol : v.supplyToken}/${a ? (a.borrowToken as unknown as { symbol: string }).symbol : v.borrowToken}`,
      accounts: {
        ...acc,
        supplyPosition: supplyPosKey,
        borrowPosition: borrowPosKey,
        protocolIs: supplyPosKey === acc.supplyPositionByConfig ? 'vault_config' : 'vault_state',
        oracleSources: srcKeys,
        liquidityVaultSupply: sr.vault,
        liquidityVaultBorrow: br.vault,
      },
      sameBytes: Object.fromEntries(byBytes.map(([n, c]) => [n, c.compared])),
      sameBytesMismatches: byteMismatches,
      sdkCompare: cmp,
      sdkMismatches: bad,
      apiCompare: a
        ? {
            totalSupplyLiquidity: [
              String(sp ? jlPositionTokens(sp, srTot.supplyExchangePrice) : null),
              a.totalSupplyLiquidity,
            ],
            totalBorrowLiquidity: [
              String(bp ? jlPositionTokens(bp, brTot.borrowExchangePrice) : null),
              a.totalBorrowLiquidity,
            ],
            totalPositions: [st.totalPositions, a.totalPositions],
            collateralFactor: [cfg.collateralFactor, a.collateralFactor],
            liquidationThreshold: [cfg.liquidationThreshold, a.liquidationThreshold],
            liquidationPenalty: [cfg.liquidationPenalty, a.liquidationPenalty],
            // the API prints the cached price with its last three digits dropped
            oraclePrice: [
              cache?.price !== undefined ? (cache.price / 1000n).toString() : null,
              a.oraclePrice,
            ],
          }
        : null,
      oracle: {
        sources: orc?.sources.map((x) => ({
          ...x,
          multiplier: x.multiplier.toString(),
          divisor: x.divisor.toString(),
        })),
        caches: caches.map((c) =>
          JSON.parse(JSON.stringify(c, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))),
        ),
        cachePriceUsd: cache?.price ? Number(cache.price) / 1e18 : null,
        decimals: { collateral: colDec, debt: debtDec },
      },
    });
  }
  const ok = rows.filter((r) => !r.error);
  const apiAgree = (k: string) =>
    ok.filter((r) => {
      const c = (r.apiCompare as Record<string, [unknown, unknown]> | null)?.[k];
      return c && String(c[0]) === String(c[1]);
    }).length;
  const value = {
    vaults: rows.length,
    decoded: ok.length,
    sameBytesFieldsCompared: bytesCompared,
    sameBytesMismatches: bytesMismatched,
    sdkReaderFieldsCompared: checked,
    sdkReaderMismatches: mismatches,
    sdkReaderNote:
      'reader vs SDK high-level reads taken seconds apart; accruing amounts allowed 1e-6',
    protocolKey: [...new Set(ok.map((r) => (r.accounts as { protocolIs: string }).protocolIs))],
    apiEqual: {
      collateralFactor: apiAgree('collateralFactor'),
      liquidationThreshold: apiAgree('liquidationThreshold'),
      liquidationPenalty: apiAgree('liquidationPenalty'),
      totalPositions: apiAgree('totalPositions'),
      oraclePrice: apiAgree('oraclePrice'),
    },
    verdict: bytesMismatched === 0 && ok.length === rows.length ? 'onchain' : 'api',
  };
  saveMeasure('vl5', {
    value,
    rows,
    source: {
      onchain: 'Solana RPC getMultipleAccounts',
      sdk: '@jup-ag/lend-read 0.0.14 Client',
      api: JL_API,
    },
  });
  measureLog({ vl: 'VL-5', command, value });
}

/** VL-6: every obligation of each Kamino market in one getProgramAccounts; deposits and debts summed per
 *  reserve against the reserve's own totals (cTokens in the collateral vault; borrowed amount). */
async function vl6() {
  const v1 = loadMeasure<Vl1>('vl1');
  const assets = registryAssets();
  const markets = [...new Set(v1.kamino.map((r) => r.market))];
  const slotMs = await measuredSlotMs();
  const { accounts: resAcc } = await multipleAccounts(v1.kamino.map((r) => r.reserve));
  const reserves = new Map<string, KaminoReserve>();
  for (const [k, a] of resAcc) if (a) reserves.set(k, decodeKaminoReserve(a.data));
  const colVaults = await multipleAccounts(
    [...reserves.values()].map((r) => r.collateralSupplyVault),
  );
  const perMarket: Array<Record<string, unknown>> = [];
  const perReserve: Array<Record<string, unknown>> = [];
  for (const m of markets) {
    const t = Date.now();
    const obs = await programAccounts(KLEND_PROGRAM, [
      { dataSize: KAMINO_OBLIGATION_SIZE },
      { memcmp: { offset: KAMINO_MARKET_OFFSET, bytes: m } },
    ]);
    const ms = Date.now() - t;
    const dep = new Map<string, bigint>();
    const debtSf = new Map<string, bigint>();
    let withDebt = 0;
    let empty = 0;
    for (const o of obs) {
      const d = decodeKaminoObligation(o.data);
      if (!d.deposits.length && !d.borrows.length) empty++;
      if (d.borrows.length) withDebt++;
      for (const x of d.deposits)
        dep.set(x.reserve, (dep.get(x.reserve) ?? 0n) + x.depositedAmount);
      for (const b of d.borrows) {
        const r = reserves.get(b.reserve);
        const acc = r ? kaminoAccruedDebtSf(b, r.cumulativeBorrowRateBsf) : b.borrowedAmountSf;
        debtSf.set(b.reserve, (debtSf.get(b.reserve) ?? 0n) + acc);
      }
    }
    perMarket.push({
      market: m,
      obligations: obs.length,
      withDebt,
      empty,
      ms,
      bytes: obs.length * KAMINO_OBLIGATION_SIZE,
    });
    for (const [k, r] of reserves) {
      if (r.lendingMarket !== m) continue;
      const cv = colVaults.accounts.get(r.collateralSupplyVault);
      const vaultCtokens = cv ? tokenAccount(cv.data).amount : null;
      const sumDep = dep.get(k) ?? 0n;
      const sumDebt = (debtSf.get(k) ?? 0n) >> 60n;
      const resDebt = r.borrowedAmountSf >> 60n;
      perReserve.push({
        market: m,
        reserve: k,
        symbol: assets.get(r.liquidityMint) ?? r.config.name,
        obligationsCtokens: sumDep.toString(),
        collateralVaultCtokens: vaultCtokens?.toString(),
        ctokensEqual: vaultCtokens === sumDep,
        mintTotalSupply: r.collateralMintTotalSupply.toString(),
        ctokensOutsideObligations: (r.collateralMintTotalSupply - sumDep).toString(),
        obligationsDebt: sumDebt.toString(),
        reserveBorrowed: resDebt.toString(),
        debtRelGap:
          resDebt > 0n
            ? Number(sumDebt > resDebt ? sumDebt - resDebt : resDebt - sumDebt) / Number(resDebt)
            : sumDebt === 0n
              ? 0
              : 1,
      });
    }
    await sleep(500);
  }
  const value = {
    markets: perMarket,
    reserves: perReserve.length,
    ctokensEqual: perReserve.filter((r) => r.ctokensEqual).length,
    maxDebtRelGap: Math.max(0, ...perReserve.map((r) => Number(r.debtRelGap))),
    note: 'obligation debt accrued to each reserve index at its last refresh; reserves refresh at different slots',
    slotMs,
  };
  saveMeasure('vl6', { value, perReserve });
  measureLog({ vl: 'VL-6', command, value });
}

/** VL-8: curated Kamino vaults (kvault) that allocate into a registered reserve: allocations, AUM, share of
 *  each reserve's supply, and the check that each vault's cToken account holds exactly its recorded allocation. */
async function vl8() {
  const v1 = loadMeasure<Vl1>('vl1');
  const assets = registryAssets();
  const t = Date.now();
  const all = await programAccounts(KVAULT_PROGRAM, [{ dataSize: KVAULT_STATE_SIZE }]);
  const ms = Date.now() - t;
  const ours = new Set(v1.kamino.map((r) => r.reserve));
  const vaults = all.map((a) => ({ address: a.pubkey, ...decodeKvaultState(a.data) }));
  const hits = vaults.filter((v) => v.allocations.some((x) => ours.has(x.reserve)));
  const slotMs = await measuredSlotMs();
  const resKeys = [...new Set(hits.flatMap((v) => v.allocations.map((x) => x.reserve)))];
  const { accounts: resAcc } = await multipleAccounts(resKeys);
  const reserves = new Map<string, KaminoReserve>();
  for (const [k, a] of resAcc) if (a) reserves.set(k, decodeKaminoReserve(a.data));
  const ctokenVaults = await multipleAccounts(
    hits.flatMap((v) => v.allocations.map((x) => x.ctokenVault)),
  );
  const rows = hits.map((v) => {
    let aum = Number(v.tokenAvailable);
    const allocs = v.allocations.map((x) => {
      const r = reserves.get(x.reserve);
      const st = r ? kaminoReserveState(r, { slotMs }) : null;
      const liq = st ? Number(x.ctokenAllocation) * st.exchangeRate : 0;
      aum += liq;
      const held = ctokenVaults.accounts.get(x.ctokenVault);
      const heldCtokens = held ? tokenAccount(held.data).amount : null;
      return {
        reserve: x.reserve,
        registered: ours.has(x.reserve),
        market: r?.lendingMarket,
        symbol: r ? (assets.get(r.liquidityMint) ?? r.config.name) : null,
        ctokenAllocation: x.ctokenAllocation.toString(),
        ctokenVault: x.ctokenVault,
        ctokenVaultBalance: heldCtokens?.toString() ?? null,
        ctokenVaultMatches: heldCtokens === x.ctokenAllocation,
        liquidity: liq / 10 ** v.tokenMintDecimals,
        shareOfReserveSupply: st && st.supplied > 0n ? liq / Number(st.supplied) : null,
        targetWeight: x.targetAllocationWeight.toString(),
        cap: x.tokenAllocationCap.toString(),
      };
    });
    return {
      vault: v.address,
      name: v.name,
      manager: v.adminAuthority,
      allocationAdmin: v.allocationAdmin,
      tokenMint: v.tokenMint,
      token: assets.get(v.tokenMint) ?? v.tokenMint,
      sharesMint: v.sharesMint,
      tokenVault: v.tokenVault,
      idle: Number(v.tokenAvailable) / 10 ** v.tokenMintDecimals,
      aum: aum / 10 ** v.tokenMintDecimals,
      sharePrice:
        v.sharesIssued > 0n
          ? aum / 10 ** v.tokenMintDecimals / (Number(v.sharesIssued) / 10 ** v.sharesMintDecimals)
          : null,
      allocations: allocs,
    };
  });
  // every holder of each registered reserve's cToken: obligations (the collateral vault), curated vaults, others
  const ctokenVaultOwner = new Map(
    rows.flatMap((v) => v.allocations.map((a) => [a.ctokenVault, v.name || v.vault] as const)),
  );
  const holders: Array<Record<string, unknown>> = [];
  for (const r of v1.kamino) {
    const mint = (
      reserves.get(r.reserve) ??
      decodeKaminoReserve(
        (await multipleAccounts([r.reserve])).accounts.get(r.reserve)?.data as Uint8Array,
      )
    ).collateralMint;
    const accs = await programAccounts(
      TOKEN_PROGRAM,
      [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }],
      { offset: 32, length: 40 },
    );
    // re-read the reserve right after the holder scan: busy reserves move between reads
    const res = decodeKaminoReserve(
      (await multipleAccounts([r.reserve])).accounts.get(r.reserve)?.data as Uint8Array,
    );
    let obligations = 0n;
    let curated = 0n;
    let others = 0n;
    let otherHolders = 0;
    let topOther = 0n;
    for (const a of accs) {
      const v = new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(
        32,
        true,
      );
      if (a.pubkey === res.collateralSupplyVault) obligations += v;
      else if (ctokenVaultOwner.has(a.pubkey)) curated += v;
      else if (v > 0n) {
        others += v;
        otherHolders++;
        if (v > topOther) topOther = v;
      }
    }
    const total = obligations + curated + others;
    holders.push({
      reserve: r.reserve,
      symbol: r.symbol,
      market: r.market,
      mintTotalSupply: res.collateralMintTotalSupply.toString(),
      sumOfHolders: total.toString(),
      // klend mints MIN_INITIAL_DEPOSIT (100,000) cTokens for the seed deposit at reserve creation, held by no account
      holdersEqualSupply: total + KAMINO_SEED_CTOKENS === res.collateralMintTotalSupply,
      obligationsShare: total ? Number(obligations) / Number(total) : 0,
      curatedVaultShare: total ? Number(curated) / Number(total) : 0,
      otherHoldersShare: total ? Number(others) / Number(total) : 0,
      otherHolders,
      largestOtherHolderShare: total ? Number(topOther) / Number(total) : 0,
    });
    await sleep(250);
  }
  const value = {
    kvaultsOnchain: vaults.length,
    gpaMs: ms,
    vaultsInOurReserves: rows.length,
    byReserve: Object.fromEntries(
      v1.kamino
        .map((r) => [
          `${r.symbol}@${r.market.slice(0, 6)}:${r.reserve}`,
          rows.flatMap((v) =>
            v.allocations
              .filter((a) => a.reserve === r.reserve && Number(a.ctokenAllocation) > 0)
              .map(
                (a) => `${v.name || v.vault}: ${((a.shareOfReserveSupply ?? 0) * 100).toFixed(2)}%`,
              ),
          ),
        ])
        .filter(([, x]) => (x as string[]).length),
    ),
    ctokenVaultsMatching: rows.flatMap((v) => v.allocations).filter((a) => a.ctokenVaultMatches)
      .length,
    allocations: rows.flatMap((v) => v.allocations).length,
    reservesWhereHoldersSumToSupply: holders.filter((h) => h.holdersEqualSupply).length,
    supplierSplit: Object.fromEntries(
      holders
        .filter((h) => !assets.has(String(v1.kamino.find((k) => k.reserve === h.reserve)?.mint)))
        .map((h) => [
          `${h.symbol}@${String(h.market).slice(0, 6)}`,
          {
            obligations: +Number(h.obligationsShare).toFixed(4),
            curatedVaults: +Number(h.curatedVaultShare).toFixed(4),
            otherHolders: +Number(h.otherHoldersShare).toFixed(4),
            otherHolderCount: h.otherHolders,
            largestOther: +Number(h.largestOtherHolderShare).toFixed(4),
          },
        ]),
    ),
  };
  saveMeasure('vl8', { value, rows, holders });
  measureLog({ vl: 'VL-8', command, value });
}

type Addr = { address: string; kind: string; group: string; label: string };
type Vl2Row = {
  market: string;
  reserve: string;
  symbol: string;
  accounts: Record<string, unknown>;
};
type Vl5Row = { vault: string; vaultId: number; pair: string; accounts: Record<string, string> };
type Vl8Row = {
  vault: string;
  name: string;
  tokenVault: string;
  allocations: Array<{ ctokenVault: string; registered: boolean }>;
};

/** The address set that VL-3 checks and VL-4 / item 4 walk, grouped by market (Kamino), vault (Jupiter Lend)
 *  or curated vault. */
function lendingAddresses(): Addr[] {
  const v2 = loadMeasure<{ rows: Vl2Row[] }>('vl2').rows;
  const v5 = loadMeasure<{ rows: Vl5Row[] }>('vl5').rows;
  const v8 = loadMeasure<{ rows: Vl8Row[] }>('vl8').rows;
  const out: Addr[] = [];
  for (const m of [...new Set(v2.map((r) => r.market))])
    out.push({ address: m, kind: 'kamino_market', group: `kamino:${m}`, label: 'market' });
  for (const r of v2) {
    const g = `kamino:${r.market}`;
    out.push({ address: r.reserve, kind: 'kamino_reserve', group: g, label: r.symbol });
    out.push({
      address: String(r.accounts.liquiditySupplyVault),
      kind: 'kamino_liquidity_vault',
      group: g,
      label: r.symbol,
    });
    out.push({
      address: String(r.accounts.collateralSupplyVault),
      kind: 'kamino_collateral_vault',
      group: g,
      label: r.symbol,
    });
    out.push({
      address: String(r.accounts.liquidityFeeVault),
      kind: 'kamino_fee_vault',
      group: g,
      label: r.symbol,
    });
  }
  for (const v of v5) {
    const g = `jupiter_lend:${v.vaultId}`;
    out.push({
      address: v.accounts.config as string,
      kind: 'jl_vault_config',
      group: g,
      label: v.pair,
    });
    out.push({
      address: v.accounts.state as string,
      kind: 'jl_vault_state',
      group: g,
      label: v.pair,
    });
    out.push({
      address: v.accounts.supplyPosition as string,
      kind: 'jl_supply_position',
      group: g,
      label: v.pair,
    });
    out.push({
      address: v.accounts.borrowPosition as string,
      kind: 'jl_borrow_position',
      group: g,
      label: v.pair,
    });
  }
  for (const v of v8.filter((x) => x.allocations.some((a) => a.registered))) {
    const g = `kvault:${v.vault}`;
    out.push({ address: v.vault, kind: 'kvault_state', group: g, label: v.name });
    out.push({ address: v.tokenVault, kind: 'kvault_token_vault', group: g, label: v.name });
  }
  return out;
}

/** Signatures (successful only) for an address back to `since`, in memory: for one-day checks. */
async function sigsSince(addr: string, since: number) {
  const ok = new Set<string>();
  let failed = 0;
  let before: string | undefined;
  for (;;) {
    const page = await rpc<Array<{ signature: string; blockTime: number | null; err: unknown }>>(
      'getSignaturesForAddress',
      [addr, { limit: 1000, ...(before ? { before } : {}) }],
    );
    if (!page.length) break;
    let done = false;
    for (const sg of page) {
      if ((sg.blockTime ?? 0) < since) {
        done = true;
        break;
      }
      if (sg.err) failed++;
      else ok.add(sg.signature);
    }
    if (done) break;
    before = page.at(-1)?.signature;
  }
  return { ok, failed };
}

async function pool<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let k = i++; k < items.length; k = i++) out[k] = await f(items[k] as T);
    }),
  );
  return out;
}

/** VL-3: over one day, does the default address set (vault token accounts + market for Kamino; config, state and
 *  liquidity positions for Jupiter Lend; state + token vault for curated vaults) see every transaction that touches
 *  each reserve or vault account? */
async function vl3() {
  const addrs = lendingAddresses();
  const since = Math.floor(Date.now() / 1000) - 86_400;
  const t0 = Date.now();
  const sets = await pool(addrs, 8, (a) => sigsSince(a.address, since));
  const by = new Map(
    addrs.map((a, i) => [a.address, { ...a, ...(sets[i] as { ok: Set<string>; failed: number }) }]),
  );
  const groups = [...new Set(addrs.map((a) => a.group))];
  const rows: Array<Record<string, unknown>> = [];
  for (const g of groups) {
    const ms = [...by.values()].filter((a) => a.group === g);
    const defaultSet = new Set<string>();
    const all = new Set<string>();
    for (const a of ms) {
      for (const s2 of a.ok) all.add(s2);
      const inDefault = a.kind !== 'kamino_reserve';
      if (inDefault) for (const s2 of a.ok) defaultSet.add(s2);
    }
    // the reserve accounts are the reference for Kamino; for the others every address is in the default set
    const reserveSigs = new Set(
      ms
        .filter(
          (a) =>
            a.kind === 'kamino_reserve' || a.kind === 'jl_vault_state' || a.kind === 'kvault_state',
        )
        .flatMap((a) => [...a.ok]),
    );
    const missed = [...reserveSigs].filter((x) => !defaultSet.has(x));
    const marketOnly = ms.find((a) => a.kind === 'kamino_market');
    const vaultsOnly = new Set(
      ms
        .filter((a) => /vault$/.test(a.kind) && a.kind !== 'kamino_fee_vault')
        .flatMap((a) => [...a.ok]),
    );
    // a missed tx matters only if it writes one of the reference accounts; fetch each and check
    const refKeys = new Set(
      ms
        .filter(
          (a) =>
            a.kind === 'kamino_reserve' || a.kind === 'jl_vault_state' || a.kind === 'kvault_state',
        )
        .map((a) => a.address),
    );
    const missedDetail = await pool(missed, 8, async (sig) => {
      const tx = await rpc<RpcTx | null>('getTransaction', [
        sig,
        { encoding: 'json', maxSupportedTransactionVersion: 1 },
      ]);
      if (!tx) return { sig, writes: null, programs: [] as string[] };
      const msg = tx.transaction.message as RpcTx['transaction']['message'] & {
        header: {
          numRequiredSignatures: number;
          numReadonlySignedAccounts: number;
          numReadonlyUnsignedAccounts: number;
        };
      };
      const keys = txAccountKeys(tx);
      const nStatic = msg.accountKeys.length;
      const h = msg.header;
      const writable = (i: number) =>
        i < nStatic
          ? i < h.numRequiredSignatures
            ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts
            : i < nStatic - h.numReadonlyUnsignedAccounts
          : i < nStatic + (tx.meta?.loadedAddresses?.writable.length ?? 0);
      const writes = keys.some((k, i) => refKeys.has(k) && writable(i));
      const programs = [
        ...new Set(
          (tx.meta?.logMessages ?? [])
            .flatMap((l) => {
              const m2 = /^Program (\w+) invoke \[1\]/.exec(l);
              return m2 ? [m2[1] as string] : [];
            })
            .filter((p2) => !p2.startsWith('ComputeBudget')),
        ),
      ];
      const ix = [
        ...new Set(
          (tx.meta?.logMessages ?? []).flatMap((l) => {
            const m2 = /^Program log: Instruction: (\w+)/.exec(l);
            return m2 ? [m2[1] as string] : [];
          }),
        ),
      ];
      return { sig, writes, programs, ix };
    });
    const missedWriting = missedDetail.filter((d) => d.writes);
    const missedKinds: Record<string, number> = {};
    for (const d of missedDetail) {
      const k = `${d.writes ? 'WRITES' : 'read-only'}:${(d as { ix?: string[] }).ix?.join('+') ?? '?'}`;
      missedKinds[k] = (missedKinds[k] ?? 0) + 1;
    }
    rows.push({
      group: g,
      addresses: ms.length,
      referenceMissedWriting: missedWriting.length,
      missedKinds,
      referenceTxs: reserveSigs.size,
      defaultSetTxs: defaultSet.size,
      unionTxs: all.size,
      referenceMissedByDefault: missed.length,
      missedSample: missed.slice(0, 3),
      marketCoversReference: marketOnly
        ? [...reserveSigs].filter((x) => !marketOnly.ok.has(x)).length === 0
        : null,
      vaultTxsNotOnReference: [...vaultsOnly].filter((x) => !reserveSigs.has(x)).length,
      failedTxs: ms.reduce((s2, a) => s2 + a.failed, 0),
      perAddress: ms.map((a) => ({
        address: a.address,
        kind: a.kind,
        label: a.label,
        txs: a.ok.size,
      })),
    });
  }
  const value = {
    window: { since: new Date(since * 1000).toISOString(), hours: 24 },
    groups: rows.length,
    addresses: addrs.length,
    groupsFullyCovered: rows.filter((r) => r.referenceMissedByDefault === 0).length,
    referenceTxsMissed: rows.reduce((s2, r) => s2 + Number(r.referenceMissedByDefault), 0),
    referenceTxsMissedThatWrite: rows.reduce((s2, r) => s2 + Number(r.referenceMissedWriting), 0),
    missedKinds: rows.reduce((acc: Record<string, number>, r) => {
      for (const [k, n] of Object.entries(r.missedKinds as Record<string, number>))
        acc[k] = (acc[k] ?? 0) + n;
      return acc;
    }, {}),
    unionTxsPerDay: rows.reduce((s2, r) => s2 + Number(r.unionTxs), 0),
    vaultTxsNotOnReference: rows.reduce((s2, r) => s2 + Number(r.vaultTxsNotOnReference), 0),
    byGroup: Object.fromEntries(
      rows.map((r) => [
        r.group,
        {
          ref: r.referenceTxs,
          default: r.defaultSetTxs,
          union: r.unionTxs,
          missed: r.referenceMissedByDefault,
          marketCovers: r.marketCoversReference,
        },
      ]),
    ),
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  saveMeasure('vl3', { value, rows, addresses: addrs });
  measureLog({ vl: 'VL-3', command, value, rpc: rpcStats });
}

/** VL-4: walk every address of the VL-3 set back to its first transaction (signatures kept on disk for the
 *  history fetch), and count unique transactions per group: total, failed, first date. Also samples one page of
 *  the Jupiter Lend liquidity-layer accounts (D12: shared by every Jupiter Lend product) for a per-day rate. */
async function vl4() {
  const addrs = lendingAddresses();
  const parallel = Number(process.argv[3] ?? 8);
  const t0 = Date.now();
  const cursors = await pool(addrs, parallel, async (a) => {
    const c = await walkAddress(LENDING_HISTORY_DIR, a.address, 0);
    return c;
  });
  const groups = [...new Set(addrs.map((a) => a.group))];
  const rows: Array<Record<string, unknown>> = [];
  let total = 0;
  let totalFailed = 0;
  let walked = 0;
  for (const g of groups) {
    const seen = new Set<string>();
    let failed = 0;
    let first = Number.POSITIVE_INFINITY;
    let last = 0;
    for (const a of addrs.filter((x) => x.group === g)) {
      for (const sg of readAddressSignatures(LENDING_HISTORY_DIR, a.address)) {
        walked++;
        const k = sg.signature.slice(0, 24);
        if (seen.has(k)) continue;
        seen.add(k);
        if (sg.failed) failed++;
        if (sg.blockTime) {
          first = Math.min(first, sg.blockTime);
          last = Math.max(last, sg.blockTime);
        }
      }
    }
    total += seen.size;
    totalFailed += failed;
    rows.push({
      group: g,
      txs: seen.size,
      failed,
      toFetch: seen.size - failed,
      first: Number.isFinite(first) ? new Date(first * 1000).toISOString() : null,
      last: last ? new Date(last * 1000).toISOString() : null,
      days: Number.isFinite(first) ? +((last - first) / 86_400).toFixed(1) : 0,
    });
  }
  // D12: Jupiter Lend liquidity layer, one page per account
  const v5 = loadMeasure<{ rows: Vl5Row[] }>('vl5').rows;
  const layer = [
    ...new Set(
      v5.flatMap((v) => [
        v.accounts.supplyReserve,
        v.accounts.borrowReserve,
        v.accounts.liquidityVaultSupply,
        v.accounts.liquidityVaultBorrow,
      ]),
    ),
  ] as string[];
  const layerRates = await pool(layer, 4, async (k) => {
    const page = await rpc<Array<{ blockTime: number | null; err: unknown }>>(
      'getSignaturesForAddress',
      [k, { limit: 1000 }],
    );
    const span = ((page[0]?.blockTime ?? 0) - (page.at(-1)?.blockTime ?? 0)) / 86_400;
    return {
      account: k,
      n: page.length,
      spanDays: +span.toFixed(3),
      perDay: span > 0 ? Math.round(page.length / span) : null,
    };
  });
  const jlFirst = Math.min(
    ...rows
      .filter((r) => String(r.group).startsWith('jupiter_lend'))
      .map((r) => Date.parse(String(r.first))),
  );
  const layerDays = (Date.now() - jlFirst) / 86_400_000;
  const layerPerDay = Math.max(0, ...layerRates.map((r) => r.perDay ?? 0));
  const value = {
    addresses: addrs.length,
    signaturesWalked: walked,
    uniqueTxs: total,
    failed: totalFailed,
    failedShare: total ? +(totalFailed / total).toFixed(4) : 0,
    toFetch: total - totalFailed,
    budget: 3_000_000,
    withinBudget: total - totalFailed <= 3_000_000,
    byGroup: Object.fromEntries(
      rows.map((r) => [r.group, { txs: r.txs, failed: r.failed, first: r.first }]),
    ),
    d12LiquidityLayer: {
      busiestAccountPerDay: layerPerDay,
      estimatedLifetimeTxs: Math.round(layerPerDay * layerDays),
      basis: `busiest liquidity-layer account's last 1,000 signatures × ${layerDays.toFixed(0)} days since the first xStock vault tx (upper-bound style estimate, not a walk)`,
    },
    seconds: Math.round((Date.now() - t0) / 1000),
    parallel,
  };
  saveMeasure('vl4', {
    value,
    rows,
    layerRates,
    walkDir: LENDING_HISTORY_DIR,
    cursors: addrs.map((a, i) => ({
      ...a,
      kept: cursors[i]?.kept,
      failed: cursors[i]?.failed,
      oldest: cursors[i]?.oldestTime,
    })),
  });
  measureLog({ vl: 'VL-4', command, value, rpc: rpcStats });
}

/** VL-7: on recent transactions of each program, which instructions log Anchor events (`Program data:`), which
 *  do not, and whether the vault token balances are in the tx meta (they are the amount source either way). */
async function vl7() {
  const klendIdl = (
    await import('@kamino-finance/klend-sdk/dist/idl/klend.json', { with: { type: 'json' } })
  ).default as { events?: Array<{ name: string }> };
  const kvaultIdl = (
    await import('@kamino-finance/klend-sdk/dist/idl/kvault.json', { with: { type: 'json' } })
  ).default as { events?: Array<{ name: string }> };
  const jlEvents = [
    'LogOperate',
    'LogLiquidate',
    'LogLiquidateInfo',
    'LogAbsorb',
    'LogRebalance',
    'LogUserPosition',
    'LogClosePosition',
    'LogUpdateExchangePrices',
    'LogLiquidationRoundingDiff',
    'LogUpdateCollateralFactor',
    'LogUpdateLiquidationThreshold',
    'LogUpdateOracle',
    'LogClaim',
    'LogCollectRevenue',
    'LogUpdateRateDataV1',
    'LogUpdateRateDataV2',
    'LogUpdateTokenConfigs',
    'LogUpdateUserSupplyConfigs',
    'LogUpdateUserBorrowConfigs',
    'LogBorrowRateCap',
    'LogDeposit',
    'LogWithdraw',
    'LogUpdateRates',
    'LogUpdateRewards',
    'LogInitTick',
    'LogInitTickIdLiquidation',
    'LogInitBranch',
    'LogInitTickHasDebtArray',
    'LogUpdateBorrowFee',
  ];
  const names = new Map<string, string>();
  for (const n of [
    ...(klendIdl.events ?? []).map((e) => e.name),
    ...(kvaultIdl.events ?? []).map((e) => e.name),
    ...jlEvents,
  ])
    names.set(eventDisc(n), n);
  const v2 = loadMeasure<{ rows: Vl2Row[] }>('vl2').rows;
  const v5 = loadMeasure<{ rows: Vl5Row[] }>('vl5').rows;
  const v8 = loadMeasure<{ rows: Vl8Row[] }>('vl8').rows;
  const busiestKv = v8.filter((v) => v.allocations.some((a) => a.registered)).map((v) => v.vault);
  const samples: Array<{ program: string; address: string; limit: number }> = [
    { program: KLEND_PROGRAM, address: '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua', limit: 150 },
    {
      program: KLEND_PROGRAM,
      address: String(
        v2.find((r) => r.symbol === 'USDC' && r.market.startsWith('B7a2'))?.accounts
          .liquiditySupplyVault,
      ),
      limit: 60,
    },
    ...v5
      .slice(0, 8)
      .map((v) => ({ program: JL_VAULTS_PROGRAM, address: v.accounts.state as string, limit: 25 })),
    ...busiestKv.slice(0, 4).map((a) => ({ program: KVAULT_PROGRAM, address: a, limit: 25 })),
  ];
  const programs = new Map<
    string,
    {
      txs: number;
      ix: Record<string, { n: number; withEvents: number; events: Record<string, number> }>;
      payloadsUnknown: number;
    }
  >();
  let liquidationsSeen = 0;
  for (const smp of samples) {
    const sigs = (
      await rpc<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [
        smp.address,
        { limit: smp.limit },
      ])
    )
      .filter((x) => !x.err)
      .map((x) => x.signature);
    const txs = await pool(sigs, 8, (sig) =>
      rpc<RpcTx | null>('getTransaction', [
        sig,
        { encoding: 'json', maxSupportedTransactionVersion: 1 },
      ]),
    );
    const st = programs.get(smp.program) ?? { txs: 0, ix: {}, payloadsUnknown: 0 };
    for (const tx of txs) {
      if (!tx?.meta) continue;
      st.txs++;
      const { frames } = parseLogs(tx.meta.logMessages ?? []);
      for (const f of frames.filter(
        (x) =>
          x.program === smp.program ||
          (smp.program === JL_VAULTS_PROGRAM && x.program === JL_LIQUIDITY_PROGRAM),
      )) {
        const ixName = `${f.program === JL_LIQUIDITY_PROGRAM ? 'liquidity.' : ''}${f.ix[0] ?? '(no ix log)'}`;
        if (/^(liquidity\.)?Liquidate/.test(ixName)) liquidationsSeen++;
        const e = st.ix[ixName] ?? { n: 0, withEvents: 0, events: {} };
        e.n++;
        if (f.data.length) e.withEvents++;
        for (const d of f.data) {
          const n = names.get(discOf(d)) ?? `unknown:${discOf(d)}`;
          if (n.startsWith('unknown')) st.payloadsUnknown++;
          e.events[n] = (e.events[n] ?? 0) + 1;
        }
        st.ix[ixName] = e;
      }
    }
    programs.set(smp.program, st);
  }
  const value = {
    txsInspected: [...programs.values()].reduce((s2, p2) => s2 + p2.txs, 0),
    liquidationIxSeen: liquidationsSeen,
    note: 'kvault frames without an instruction log are self-invocations (Anchor emit_cpi events in inner instruction data); liquidations are rare and none fell in this sample, so their event check moves to the item-5 fixtures',
    byProgram: Object.fromEntries(
      [...programs].map(([p2, st]) => [
        p2,
        {
          txs: st.txs,
          unknownPayloads: st.payloadsUnknown,
          ix: Object.fromEntries(
            Object.entries(st.ix)
              .sort((a, b) => b[1].n - a[1].n)
              .map(([k, v]) => [
                k,
                `${v.n} (${v.withEvents} with events${
                  Object.keys(v.events).length
                    ? `: ${Object.entries(v.events)
                        .map(([en, c]) => `${en}×${c}`)
                        .join(', ')}`
                    : ''
                })`,
              ]),
          ),
        },
      ]),
    ),
  };
  saveMeasure('vl7', { value });
  measureLog({ vl: 'VL-7', command, value });
}

const tasks: Record<string, () => Promise<void>> = { vl1, vl2, vl3, vl4, vl5, vl6, vl7, vl8 };
const task = tasks[mode];
if (!task) throw new Error(`unknown task ${mode}`);
await task();
void TOKEN_PROGRAM;
