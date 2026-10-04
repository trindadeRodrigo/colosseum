import { type Address, generateKeyPairSigner, lamports } from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import { PRICES_SIZE } from './basket';

// A price account written by hand, in the layout of Kamino Scope's: a 40-byte header, then 512
// entries of 56 bytes. Entry i starts at 40 + 56·i: value u64, exponent u64, slot u64, unix time
// u64, then 24 bytes the program does not read. The price is value / 10^exponent, in dollars for one
// whole token. On mainnet the account is Scope's; here a test owns every byte.

/** sha256("account:OraclePrices")[0..8]: what Scope's own price account starts with. */
const SCOPE_PRICES_DISCRIMINATOR = [89, 128, 118, 221, 6, 72, 180, 146];

export type PriceEntry = {
  /** Dollars for one whole token, times 10^exponent. */
  value: bigint;
  exponent?: bigint;
  /** Unix seconds of the update. */
  unixTimestamp: bigint;
};

/** An empty price account owned by `owner`, at a fresh address or at `address`. */
export async function createPriceAccount(
  svm: LiteSVM,
  owner: Address,
  options: { address?: Address; size?: number } = {},
): Promise<Address> {
  const address = options.address ?? (await generateKeyPairSigner()).address;
  const data = new Uint8Array(options.size ?? PRICES_SIZE);
  data.set(SCOPE_PRICES_DISCRIMINATOR.slice(0, data.length));
  svm.setAccount({
    address,
    data,
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: owner,
    space: BigInt(data.length),
  });
  return address;
}

/** Writes entry `index` of a price account. Prices here use 8 decimal places unless told otherwise. */
export function writePrice(
  svm: LiteSVM,
  priceAccount: Address,
  index: number,
  entry: PriceEntry,
): void {
  const account = svm.getAccount(priceAccount);
  if (!account.exists) throw new Error(`no price account at ${priceAccount}`);
  const data = new Uint8Array(account.data);
  const view = new DataView(data.buffer);
  const at = 40 + 56 * index;
  view.setBigUint64(at, entry.value, true);
  view.setBigUint64(at + 8, entry.exponent ?? 8n, true);
  view.setBigUint64(at + 16, svm.getClock().slot, true);
  view.setBigUint64(at + 24, entry.unixTimestamp, true);
  svm.setAccount({ ...account, data });
}

/** Dollars, as a Scope value with 8 decimal places. */
export const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 1e8));
