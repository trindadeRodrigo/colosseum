import {
  ASSET_KEEPER,
  type AssetEntry,
  decayedLoss,
  inMultiplierWindow,
  keeperOn,
  LOSS_WINDOW_SECONDS,
  type MintInfo,
  priceAccountOf,
  type RawAccount,
  referenceOf,
  SCOPE_PRICES_BYTES,
  TOKEN_2022_PROGRAM,
  valueInCash,
  ZERO_ADDRESS,
} from '@colosseum/chain-solana/vault';
import type { Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';

// The vault program's rules for a keeper leg, written again for the reader
// (packages/chain-solana/src/vault/keeper.ts against programs/basket/src/price.rs and checks.rs).
// The program's own tests are in programs/tests/basket-keeper.test.ts; the numbers here are the same
// boundaries, so a rule that moves in one place fails in the other.

const NOW = 1_791_385_200n; // Wed 2026-10-07 15:00 UTC
const OWNER = 'So11111111111111111111111111111111111111112' as Address;
const ACCOUNT = 'SysvarC1ock11111111111111111111111111111111' as Address;
const MINT = 'SysvarRent111111111111111111111111111111111' as Address;
const config = { priceOwner: OWNER, maxPriceAgeS: 120, twapDevBps: 200 };

type Written = { value: bigint; exponent?: bigint; at?: bigint };

/** A price account in Scope's layout with the price at entry 344 and its average at 279. */
function prices(price: Written, twap: Written, owner: Address = OWNER): RawAccount {
  const data = new Uint8Array(SCOPE_PRICES_BYTES);
  const view = new DataView(data.buffer);
  for (const [index, entry] of [
    [344, price],
    [279, twap],
  ] as const) {
    const at = 40 + 56 * index;
    view.setBigUint64(at, entry.value, true);
    view.setBigUint64(at + 8, entry.exponent ?? 8n, true);
    view.setBigUint64(at + 24, entry.at ?? NOW, true);
  }
  return { address: ACCOUNT, owner, lamports: 1n, data };
}

const entry = (change: Partial<AssetEntry> = {}): AssetEntry => ({
  mint: MINT,
  priceSlot: 0,
  priceIndex: 344,
  twapIndex: 279,
  decimals: 8,
  priceKind: 1,
  session: 1,
  maxWeightBps: 5_000,
  flags: ASSET_KEEPER,
  sourceCheck: new Uint8Array(32),
  // 400 to 600 dollars, around the 500 the tests price it at.
  minPrice: 400_000000n,
  maxPrice: 600_000000n,
  reserved: new Uint8Array(5),
  ...change,
});

const usd = (dollars: number) => BigInt(Math.round(dollars * 1e8));
const at500 = { value: usd(500) };
const refusal = (asset: AssetEntry, account: RawAccount | null) =>
  referenceOf(asset, account, config, NOW).refusal;

describe("the keeper's price reference, as the reader tells it in advance", () => {
  it('passes an asset that is switched on, fresh, and at its average', () => {
    const reference = referenceOf(entry(), prices(at500, at500), config, NOW);
    expect(reference.refusal).toBeNull();
    expect([reference.price?.value, reference.twap?.value]).toEqual([usd(500), usd(500)]);
  });

  it('refuses in the order the program does', () => {
    const good = prices(at500, at500);
    expect(refusal(entry({ priceKind: 0, flags: 0 }), good)).toBe('AssetNotPriced');
    expect(refusal(entry({ flags: 0 }), good)).toBe('KeeperAssetOff');
    expect(refusal(entry({ sourceCheck: new Uint8Array(32).fill(7) }), good)).toBe(
      'AssetNotPriced',
    );
    expect(refusal(entry(), null)).toBe('AssetNotPriced');
    expect(refusal(entry(), prices(at500, at500, MINT))).toBe('AssetNotPriced');
    expect(refusal(entry(), { ...good, data: good.data.slice(0, SCOPE_PRICES_BYTES - 56) })).toBe(
      'AssetNotPriced',
    );
  });

  it('refuses an entry that holds no price', () => {
    expect(refusal(entry(), prices({ value: 0n }, at500))).toBe('AssetNotPriced');
    expect(refusal(entry(), prices({ ...at500, at: 0n }, at500))).toBe('AssetNotPriced');
    expect(refusal(entry(), prices({ ...at500, at: 1n << 63n }, at500))).toBe('AssetNotPriced');
    expect(refusal(entry(), prices({ ...at500, exponent: 19n }, at500))).toBe('AssetNotPriced');
    expect(refusal(entry(), prices(at500, { ...at500, at: 0n }))).toBe('AssetNotPriced');
  });

  it('holds the price to the range of the asset, to the millionth of a dollar', () => {
    const at = (dollars: number) => refusal(entry(), prices({ value: usd(dollars) }, at500));
    expect([at(399.999999), at(600.000001), at(1_000), at(1)]).toEqual([
      'PriceOutOfRange',
      'PriceOutOfRange',
      'PriceOutOfRange',
      'PriceOutOfRange',
    ]);
    // At the floor and at the ceiling it passes the range, and is then too far from its average.
    expect([at(400), at(600)]).toEqual(['PriceDeviation', 'PriceDeviation']);
    // With another number of decimal places, and with none.
    expect(refusal(entry(), prices({ value: 600_000001n, exponent: 6n }, at500))).toBe(
      'PriceOutOfRange',
    );
    expect(refusal(entry(), prices({ value: 399n, exponent: 0n }, at500))).toBe('PriceOutOfRange');
    // No range is no price that passes, whatever the switch says.
    expect(refusal(entry({ minPrice: 0n, maxPrice: 0n }), prices(at500, at500))).toBe(
      'PriceOutOfRange',
    );
  });

  it('holds the price to the allowed age, behind the clock and ahead of it', () => {
    expect(refusal(entry(), prices({ ...at500, at: NOW - 121n }, at500))).toBe('PriceStale');
    expect(refusal(entry(), prices({ ...at500, at: NOW - 120n }, at500))).toBeNull();
    expect(refusal(entry(), prices({ ...at500, at: NOW + 121n }, at500))).toBe('PriceStale');
    expect(refusal(entry(), prices({ ...at500, at: NOW + 120n }, at500))).toBeNull();
  });

  it('holds the average to an hour', () => {
    expect(refusal(entry(), prices(at500, { ...at500, at: NOW - 3_601n }))).toBe('PriceStale');
    expect(refusal(entry(), prices(at500, { ...at500, at: NOW - 3_600n }))).toBeNull();
  });

  it('holds the price to within 200 bps of its average, on either side', () => {
    expect(refusal(entry(), prices(at500, { value: usd(510.21) }))).toBe('PriceDeviation');
    expect(refusal(entry(), prices(at500, { value: usd(510.2) }))).toBeNull();
    expect(refusal(entry(), prices(at500, { value: usd(490.19) }))).toBe('PriceDeviation');
    expect(refusal(entry(), prices(at500, { value: usd(490.2) }))).toBeNull();
  });

  it('compares a price and an average with different exponents', () => {
    const price = { value: 500_000000n, exponent: 6n };
    expect(refusal(entry(), prices(price, { value: 500n, exponent: 0n }))).toBeNull();
    expect(refusal(entry(), prices(price, { value: 520n, exponent: 0n }))).toBe('PriceDeviation');
  });

  it('refuses an entry that holds no price before it looks at the range', () => {
    expect(refusal(entry({ minPrice: 0n, maxPrice: 0n }), prices({ value: 0n }, at500))).toBe(
      'AssetNotPriced',
    );
  });
});

describe("the keeper's other numbers", () => {
  it('reads the switch from bit 0 of the flags', () => {
    expect([keeperOn({ flags: 0 }), keeperOn({ flags: 1 }), keeperOn({ flags: 2 })]).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('names the price account of an entry by its slot, and none for an empty slot', () => {
    const priceAccounts = [ZERO_ADDRESS, ACCOUNT, ZERO_ADDRESS, ZERO_ADDRESS];
    expect(priceAccountOf({ priceSlot: 1 }, { priceAccounts })).toBe(ACCOUNT);
    expect(priceAccountOf({ priceSlot: 0 }, { priceAccounts })).toBeNull();
  });

  it('values an amount in raw units of the cash mint, rounded down', () => {
    // 0.1 of an 8-decimal token at 500 dollars is 50 dollars of a 6-decimal dollar.
    expect(valueInCash(10_000_000n, { value: usd(500), exponent: 8n }, 8, 6)).toBe(50_000_000n);
    expect(valueInCash(10_000_000n, { value: 500n, exponent: 0n }, 8, 6)).toBe(50_000_000n);
    expect(valueInCash(1n, { value: usd(500), exponent: 8n }, 8, 6)).toBe(5n);
    expect(valueInCash(1n, { value: usd(0.1), exponent: 8n }, 8, 6)).toBe(0n);
    // A cash mint with more decimal places than the price and the asset have together.
    expect(valueInCash(3n, { value: 2n, exponent: 0n }, 2, 6)).toBe(60_000n);
  });

  it('lets a loss fall in a straight line to nothing over seven days', () => {
    const week = LOSS_WINDOW_SECONDS;
    expect(decayedLoss(200_000n, NOW, NOW)).toBe(200_000n);
    expect(decayedLoss(200_000n, NOW - week / 2n, NOW)).toBe(100_000n);
    expect(decayedLoss(200_000n, NOW - week, NOW)).toBe(0n);
    expect(decayedLoss(200_000n, NOW - 2n * week, NOW)).toBe(0n);
    // A counter stamped ahead of the clock has not started to fall.
    expect(decayedLoss(200_000n, NOW + 60n, NOW)).toBe(200_000n);
  });

  it('keeps a day clear on either side of a multiplier change', () => {
    const mint = (multiplier: number, newMultiplier: number, at: bigint): MintInfo => ({
      tokenProgram: TOKEN_2022_PROGRAM,
      decimals: 8,
      hookProgram: null,
      scaledUiAmount: { multiplier, newMultiplier, newMultiplierEffectiveAt: at },
    });
    const day = 86_400n;
    expect(inMultiplierWindow(mint(1, 2, NOW + day - 1n), NOW)).toBe(true);
    expect(inMultiplierWindow(mint(1, 2, NOW + day), NOW)).toBe(false);
    expect(inMultiplierWindow(mint(1, 2, NOW - day + 1n), NOW)).toBe(true);
    expect(inMultiplierWindow(mint(1, 2, NOW - day), NOW)).toBe(false);
    // The same multiplier again is no change, and a mint without one has none.
    expect(inMultiplierWindow(mint(1.5, 1.5, NOW), NOW)).toBe(false);
    expect(inMultiplierWindow({ ...mint(1, 2, NOW), scaledUiAmount: null }, NOW)).toBe(false);
  });
});
