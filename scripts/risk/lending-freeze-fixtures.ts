import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Obligation, Reserve, VaultState } from '@kamino-finance/klend-sdk';
import { multipleAccounts, programAccounts } from './lib-lending';

// Step 10b — freeze live lending account bytes with the protocol SDK's decode of the same bytes, for
// tests/risk-layer/lending.test.ts (D11: hand-written readers checked against the SDK on frozen bytes).
// Accounts: two Kamino reserves (SPYx, USDC in the xStocks Market), the Scope feed they price from, the largest
// obligation by debt in that market, one curated vault, and one Jupiter Lend vault with its state, liquidity-layer
// reserve and positions, rate model, oracle, oracle cache and three positions.
// Positions are public chain data; fixtures keep bytes only, no owner is printed or labelled.
const OUT = 'fixtures/risk/lending';
mkdirSync(OUT, { recursive: true });
const reg = JSON.parse(readFileSync('data/risk/lending-measure/vl5.json', 'utf8')) as {
  rows: Array<{ vault: string; vaultId: number; accounts: Record<string, string> }>;
};
const v2 = JSON.parse(readFileSync('data/risk/lending-measure/vl2.json', 'utf8')) as {
  rows: Array<{
    reserve: string;
    symbol: string;
    market: string;
    accounts: Record<string, string>;
  }>;
};
const MARKET = '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua';
const big = (x: unknown) => (x === null || x === undefined ? null : String(x));
const json = (o: unknown) =>
  JSON.parse(
    JSON.stringify(o, (_k, v) =>
      typeof v === 'bigint'
        ? v.toString()
        : v && typeof v === 'object' && v.constructor?.name === 'BN'
          ? v.toString()
          : v,
    ),
  );

const spy = v2.rows.find((r) => r.market === MARKET && r.symbol === 'SPYx');
const usdc = v2.rows.find((r) => r.market === MARKET && r.symbol === 'USDC');
if (!spy || !usdc) throw new Error('VL-2 rows missing');
const kAcc = await multipleAccounts([
  spy.reserve,
  usdc.reserve,
  spy.accounts.scopePriceFeed as string,
]);
const fixtures: Record<string, unknown> = { fetchedAt: new Date().toISOString(), slot: kAcc.slot };
for (const r of [spy, usdc]) {
  const b = kAcc.accounts.get(r.reserve)?.data as Uint8Array;
  const s = Reserve.decode(Buffer.from(b));
  fixtures[`reserve_${r.symbol}`] = {
    address: r.reserve,
    b64: Buffer.from(b).toString('base64'),
    sdk: {
      lendingMarket: s.lendingMarket,
      liquidityMint: s.liquidity.mintPubkey,
      liquiditySupplyVault: s.liquidity.supplyVault,
      availableAmount: big(s.liquidity.totalAvailableAmount),
      borrowedAmountSf: big(s.liquidity.borrowedAmountSf),
      marketPriceSf: big(s.liquidity.marketPriceSf),
      mintDecimals: big(s.liquidity.mintDecimals),
      collateralMint: s.collateral.mintPubkey,
      collateralMintTotalSupply: big(s.collateral.mintTotalSupply),
      collateralSupplyVault: s.collateral.supplyVault,
      loanToValuePct: s.config.loanToValuePct,
      liquidationThresholdPct: s.config.liquidationThresholdPct,
      maxLiquidationBonusBps: s.config.maxLiquidationBonusBps,
      interestRateBasis: (s.config as unknown as { interestRateBasis: number }).interestRateBasis,
      depositLimit: big(s.config.depositLimit),
      borrowLimit: big(s.config.borrowLimit),
      scopePriceFeed: s.config.tokenInfo.scopeConfiguration.priceFeed,
      scopePriceChain: s.config.tokenInfo.scopeConfiguration.priceChain.filter(
        (x: number) => x !== 65535,
      ),
      borrowRateCurve: s.config.borrowRateCurve.points.map(
        (p: { utilizationRateBps: number; borrowRateBps: number }) => ({
          utilizationBps: p.utilizationRateBps,
          borrowRateBps: p.borrowRateBps,
        }),
      ),
    },
  };
}
fixtures.scope = {
  address: spy.accounts.scopePriceFeed,
  b64: Buffer.from(
    kAcc.accounts.get(spy.accounts.scopePriceFeed as string)?.data as Uint8Array,
  ).toString('base64'),
};

// the obligation with the largest borrowed value in the market, and one curated vault
const obs = await programAccounts('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', [
  { dataSize: 3344 },
  { memcmp: { offset: 32, bytes: MARKET } },
]);
const ob = obs
  .map((a) => ({ a, o: Obligation.decode(Buffer.from(a.data)) }))
  .sort((x, y) =>
    BigInt(y.o.borrowedAssetsMarketValueSf.toString()) >
    BigInt(x.o.borrowedAssetsMarketValueSf.toString())
      ? 1
      : -1,
  )[0];
if (!ob) throw new Error('no obligation');
fixtures.obligation = {
  b64: Buffer.from(ob.a.data).toString('base64'),
  sdk: {
    lendingMarket: ob.o.lendingMarket,
    deposits: ob.o.deposits
      .filter(
        (d: { depositReserve: string }) => d.depositReserve !== '11111111111111111111111111111111',
      )
      .map((d: { depositReserve: string; depositedAmount: unknown }) => ({
        reserve: d.depositReserve,
        depositedAmount: big(d.depositedAmount),
      })),
    borrows: ob.o.borrows
      .filter(
        (b: { borrowReserve: string }) => b.borrowReserve !== '11111111111111111111111111111111',
      )
      .map((b: { borrowReserve: string; borrowedAmountSf: unknown }) => ({
        reserve: b.borrowReserve,
        borrowedAmountSf: big(b.borrowedAmountSf),
      })),
    depositedValueSf: big(ob.o.depositedValueSf),
    borrowedAssetsMarketValueSf: big(ob.o.borrowedAssetsMarketValueSf),
  },
};
const kv = 'A3hTCWdnfV6uiQLxRmnv17EpiEtmc93v1AGQnWy44Mup';
const kvAcc = (await multipleAccounts([kv])).accounts.get(kv)?.data as Uint8Array;
const kvs = VaultState.decode(Buffer.from(kvAcc));
fixtures.kvault = {
  address: kv,
  b64: Buffer.from(kvAcc).toString('base64'),
  sdk: {
    tokenMint: kvs.tokenMint,
    tokenAvailable: big(kvs.tokenAvailable),
    sharesIssued: big(kvs.sharesIssued),
    name: Buffer.from(kvs.name).toString('utf8').replace(/\0+$/, ''),
    allocations: kvs.vaultAllocationStrategy
      .filter((a: { reserve: string }) => a.reserve !== '11111111111111111111111111111111')
      .map((a: { reserve: string; ctokenAllocation: unknown }) => ({
        reserve: a.reserve,
        ctokenAllocation: big(a.ctokenAllocation),
      })),
  },
};

// Jupiter Lend: SPYx/USDC (vault 78), decoded with the read SDK's Anchor coders on the same bytes
const { Client } = await import('@jup-ag/lend-read');
const client = new Client(process.env.SOLANA_RPC_URL as string);
type Coder = { coder: { accounts: { decode(n: string, b: Buffer): Record<string, unknown> } } };
const vp = client.vault as unknown as { program: Coder; oracle: Coder };
const lp = client.liquidity as unknown as { program: Coder };
const v = reg.rows.find((x) => x.vaultId === 78);
if (!v) throw new Error('vault 78 missing');
const keys = {
  config: v.vault,
  state: v.accounts.state,
  borrowReserve: v.accounts.borrowReserve,
  supplyPosition: v.accounts.supplyPosition,
  borrowPosition: v.accounts.borrowPosition,
  borrowRateModel: v.accounts.borrowRateModel,
  oracle: v.accounts.oracle,
} as Record<string, string>;
const jAcc = await multipleAccounts(Object.values(keys));
const jl: Record<string, unknown> = {};
const names: Record<string, [Coder, string]> = {
  config: [vp.program, 'vaultConfig'],
  state: [vp.program, 'vaultState'],
  borrowReserve: [lp.program, 'tokenReserve'],
  supplyPosition: [lp.program, 'userSupplyPosition'],
  borrowPosition: [lp.program, 'userBorrowPosition'],
  borrowRateModel: [lp.program, 'rateModel'],
  oracle: [vp.oracle, 'oracle'],
};
for (const [k, addr] of Object.entries(keys)) {
  const b = jAcc.accounts.get(addr)?.data as Uint8Array;
  const [c, n] = names[k] as [Coder, string];
  jl[k] = {
    address: addr,
    b64: Buffer.from(b).toString('base64'),
    sdk: json(c.coder.accounts.decode(n, Buffer.from(b))),
  };
}
const orc = vp.oracle.coder.accounts.decode(
  'oracle',
  Buffer.from(jAcc.accounts.get(keys.oracle as string)?.data as Uint8Array),
) as {
  sources: Array<{ source: { toBase58(): string } }>;
};
const cacheKey = orc.sources[0]?.source.toBase58() as string;
const cache = (await multipleAccounts([cacheKey])).accounts.get(cacheKey)?.data as Uint8Array;
jl.cache = {
  address: cacheKey,
  b64: Buffer.from(cache).toString('base64'),
  sdk: json(vp.oracle.coder.accounts.decode('chainlinkDataStreamsCache', Buffer.from(cache))),
};
// three positions with debt, and the SDK's own debt computation for them
const all = await programAccounts('jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi', [
  { dataSize: 71 },
]);
const mine = all.filter((a) => a.data[8] === 78 && a.data[9] === 0);
const positions: unknown[] = [];
for (const a of mine) {
  const d = vp.program.coder.accounts.decode('position', Buffer.from(a.data)) as Record<
    string,
    unknown
  >;
  if (Number(String(d.tick)) <= -16383 || d.is_supply_only_position || d.isSupplyOnlyPosition)
    continue;
  const st = await client.vault.getCurrentPositionState({
    vaultId: 78,
    position: {
      ...d,
      isSupplyOnlyPosition: Boolean(d.isSupplyOnlyPosition ?? d.is_supply_only_position),
      supplyAmount: d.supplyAmount ?? d.supply_amount,
      dustDebtAmount: d.dustDebtAmount ?? d.dust_debt_amount,
      tickId: d.tickId ?? d.tick_id,
    } as never,
  });
  positions.push({ b64: Buffer.from(a.data).toString('base64'), sdkState: json(st) });
  if (positions.length >= 3) break;
}
jl.positions = positions;
fixtures.jupiterLend = jl;
writeFileSync(join(OUT, 'accounts.json'), JSON.stringify(fixtures));
console.log(
  JSON.stringify({
    file: join(OUT, 'accounts.json'),
    slot: kAcc.slot,
    positions: positions.length,
    jlPositionsInVault: mine.length,
  }),
);
