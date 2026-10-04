import type { Address } from '@solana/kit';
import type { AssetEntry, AssetRegistryAccount, ConfigAccount } from './accounts';
import { ZERO_ADDRESS } from './accounts';
import type { RawAccount } from './rpc';
import { decodeScopeEntry, SCOPE_PRICES_BYTES, type ScopeEntry } from './scope';
import type { MintInfo } from './tokens';

// What the vault program checks before a keeper leg is valued, as the reader can tell in advance
// (DESIGN-VAULT section 5, programs/basket/src/price.rs and checks.rs). These are the program's own
// rules written again: where one changes there, it changes here in the same change.

/** `AssetEntry.flags`, bit 0: the admin has switched the keeper on for the asset. */
export const ASSET_KEEPER = 1;
/** The weekly loss counter falls in a straight line to nothing over this long. */
export const LOSS_WINDOW_SECONDS = 604_800n;
/** How old the one-hour average of a price may be. */
export const MAX_TWAP_AGE_SECONDS = 3_600n;
/** The program refuses an entry with a larger exponent. */
export const MAX_PRICE_EXPONENT = 18n;
/** A keeper leg stays this far from a change of a mint's multiplier, before and after. */
export const MULTIPLIER_WINDOW_SECONDS = 86_400n;

export function keeperOn(entry: Pick<AssetEntry, 'flags'>): boolean {
  return (entry.flags & ASSET_KEEPER) !== 0;
}

/** What is left of a vault's loss counter at `now` (the cluster's clock), in raw units of the cash mint. */
export function decayedLoss(lossAccum: bigint, lossTs: bigint, now: bigint): bigint {
  const since = now - lossTs;
  const elapsed = since < 0n ? 0n : since > LOSS_WINDOW_SECONDS ? LOSS_WINDOW_SECONDS : since;
  return (lossAccum * (LOSS_WINDOW_SECONDS - elapsed)) / LOSS_WINDOW_SECONDS;
}

/** The address the asset list names for the price account of an entry's slot, or null when it names none. */
export function priceAccountOf(
  entry: Pick<AssetEntry, 'priceSlot'>,
  registry: Pick<AssetRegistryAccount, 'priceAccounts'>,
): Address | null {
  const named = registry.priceAccounts[entry.priceSlot];
  return named && named !== ZERO_ADDRESS ? named : null;
}

/** Why a keeper leg would not value an asset now: the program's error, by name. */
export type ReferenceRefusal =
  | 'AssetNotPriced'
  | 'KeeperAssetOff'
  | 'PriceStale'
  | 'PriceDeviation';

export type Reference = {
  /** The price entry and its one-hour average, as far as they could be read. */
  price: ScopeEntry | null;
  twap: ScopeEntry | null;
  /** The first check the asset fails, in the program's order; null when a leg may value it. */
  refusal: ReferenceRefusal | null;
};

const isSet = (entry: ScopeEntry) =>
  entry.value > 0n &&
  entry.unixTimestamp > 0n &&
  entry.unixTimestamp <= 0x7fff_ffff_ffff_ffffn &&
  entry.exponent <= MAX_PRICE_EXPONENT;

const fresh = (entry: ScopeEntry, now: bigint, maxAge: bigint) => {
  const age = now - entry.unixTimestamp;
  return age <= maxAge && age >= -maxAge;
};

/**
 * The price reference of one listed asset, as `reference` in the program reads it. `priceAccount` is
 * the account at the address the asset list names for the entry's slot, or null when there is none.
 */
export function referenceOf(
  entry: AssetEntry,
  priceAccount: RawAccount | null,
  config: Pick<ConfigAccount, 'priceOwner' | 'maxPriceAgeS' | 'twapDevBps'>,
  now: bigint,
): Reference {
  const none = (refusal: ReferenceRefusal): Reference => ({ price: null, twap: null, refusal });
  if (entry.priceKind !== 1) return none('AssetNotPriced');
  if (!keeperOn(entry)) return none('KeeperAssetOff');
  if (entry.sourceCheck.some((byte) => byte !== 0)) return none('AssetNotPriced');
  if (
    !priceAccount ||
    priceAccount.owner !== config.priceOwner ||
    priceAccount.data.length !== SCOPE_PRICES_BYTES
  )
    return none('AssetNotPriced');

  const price = decodeScopeEntry(priceAccount.data, entry.priceIndex);
  if (!isSet(price)) return { price: null, twap: null, refusal: 'AssetNotPriced' };
  if (!fresh(price, now, BigInt(config.maxPriceAgeS)))
    return { price, twap: null, refusal: 'PriceStale' };
  const twap = decodeScopeEntry(priceAccount.data, entry.twapIndex);
  if (!isSet(twap)) return { price, twap: null, refusal: 'AssetNotPriced' };
  if (!fresh(twap, now, MAX_TWAP_AGE_SECONDS)) return { price, twap, refusal: 'PriceStale' };

  // Both at the larger of the two exponents, then compared without dividing.
  const exponent = price.exponent > twap.exponent ? price.exponent : twap.exponent;
  const spot = price.value * 10n ** (exponent - price.exponent);
  const average = twap.value * 10n ** (exponent - twap.exponent);
  const distance = spot > average ? spot - average : average - spot;
  if (distance * 10_000n > average * BigInt(config.twapDevBps))
    return { price, twap, refusal: 'PriceDeviation' };
  return { price, twap, refusal: null };
}

/**
 * What `amount` raw units of an asset are worth at a price entry, in raw units of the cash mint with
 * cash at one dollar, rounded down: the unit of the program's loss counter.
 */
export function valueInCash(
  amount: bigint,
  price: Pick<ScopeEntry, 'value' | 'exponent'>,
  assetDecimals: number,
  cashDecimals: number,
): bigint {
  const product = amount * price.value;
  const down = price.exponent + BigInt(assetDecimals);
  const up = BigInt(cashDecimals);
  return up >= down ? product * 10n ** (up - down) : product / 10n ** (down - up);
}

/**
 * True within a day, before or after, of a change of the mint's multiplier. The program compares the
 * two multipliers as bytes; two numbers that read the same are the same bytes.
 */
export function inMultiplierWindow(mint: MintInfo, now: bigint): boolean {
  const scaled = mint.scaledUiAmount;
  if (!scaled || Object.is(scaled.multiplier, scaled.newMultiplier)) return false;
  const away = now - scaled.newMultiplierEffectiveAt;
  return (away < 0n ? -away : away) < MULTIPLIER_WINDOW_SECONDS;
}
