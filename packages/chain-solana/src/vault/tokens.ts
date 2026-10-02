import {
  type Address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
} from '@solana/kit';

// Mints and token accounts of both token programs, read by hand from their raw bytes. The layouts are
// the same for the first 165 bytes; Token-2022 appends typed extensions after them.

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' as Address;

export function isTokenProgram(program: Address): boolean {
  return program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM;
}

const MINT_BYTES = 82;
const TOKEN_ACCOUNT_BYTES = 165;
/** Token-2022: one byte after the 165 says what the account is, then the extensions follow. */
const ACCOUNT_TYPE_OFFSET = 165;
const ACCOUNT_TYPE_MINT = 1;
/** `ExtensionType::ScaledUiAmount` in the Token-2022 program. */
const EXTENSION_SCALED_UI_AMOUNT = 25;

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

/** The associated token account: the one address per (holder, mint, the mint's token program). */
export async function associatedTokenAddress(
  holder: Address,
  mint: Address,
  tokenProgram: Address,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [
      addressEncoder.encode(holder),
      addressEncoder.encode(tokenProgram),
      addressEncoder.encode(mint),
    ],
  });
  return pda;
}

/** The scaled-UI-amount extension of a stock token: what one raw unit shows as, now and after a set time. */
export type ScaledUiAmount = {
  multiplier: number;
  /** Unix seconds from which `newMultiplier` applies. */
  newMultiplierEffectiveAt: bigint;
  newMultiplier: number;
};

export type MintInfo = {
  /** The program that owns the mint: its token accounts live under the same program. */
  tokenProgram: Address;
  decimals: number;
  /** Null on a mint without the extension, which is every classic mint. */
  scaledUiAmount: ScaledUiAmount | null;
};

/** Walks a Token-2022 mint's extensions and returns the value bytes of one type, or null. */
function mintExtension(data: Uint8Array, type: number): Uint8Array | null {
  if (data.length <= ACCOUNT_TYPE_OFFSET || data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT)
    return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = ACCOUNT_TYPE_OFFSET + 1;
  while (at + 4 <= data.length) {
    const entryType = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    // Type 0 is the padding after the last extension.
    if (entryType === 0) return null;
    if (at + 4 + length > data.length) return null;
    if (entryType === type) return data.subarray(at + 4, at + 4 + length);
    at += 4 + length;
  }
  return null;
}

/** Decodes a mint of either token program. Throws when the bytes are not an initialised mint. */
export function decodeMint(tokenProgram: Address, data: Uint8Array): MintInfo {
  if (!isTokenProgram(tokenProgram)) throw new Error('the mint is not owned by a token program');
  // A classic mint is exactly 82 bytes. A Token-2022 mint is 82, or padded to 165 and typed.
  const typed =
    data.length > ACCOUNT_TYPE_OFFSET && data[ACCOUNT_TYPE_OFFSET] === ACCOUNT_TYPE_MINT;
  if (data.length !== MINT_BYTES && !(tokenProgram === TOKEN_2022_PROGRAM && typed))
    throw new Error(`not a mint: ${data.length} bytes`);
  if (data[45] !== 1) throw new Error('the mint is not initialised');
  const decimals = data[44] ?? 0;
  const scaled =
    tokenProgram === TOKEN_2022_PROGRAM ? mintExtension(data, EXTENSION_SCALED_UI_AMOUNT) : null;
  if (!scaled) return { tokenProgram, decimals, scaledUiAmount: null };
  // authority (32) | multiplier f64 | new multiplier effective at i64 | new multiplier f64
  if (scaled.length < 56) throw new Error('the scaled-UI-amount extension is cut short');
  const view = new DataView(scaled.buffer, scaled.byteOffset, scaled.byteLength);
  return {
    tokenProgram,
    decimals,
    scaledUiAmount: {
      multiplier: view.getFloat64(32, true),
      newMultiplierEffectiveAt: view.getBigInt64(40, true),
      newMultiplier: view.getFloat64(48, true),
    },
  };
}

/** The multiplier in force at `unixSeconds` (the cluster's clock): 1 for a mint that has none. */
export function multiplierAt(mint: MintInfo, unixSeconds: bigint): number {
  const scaled = mint.scaledUiAmount;
  if (!scaled) return 1;
  return unixSeconds >= scaled.newMultiplierEffectiveAt ? scaled.newMultiplier : scaled.multiplier;
}

export type TokenAccountInfo = { mint: Address; owner: Address; amount: bigint };

/** Decodes a token account of either token program. Throws when the bytes are not an initialised one. */
export function decodeTokenAccount(data: Uint8Array): TokenAccountInfo {
  if (data.length < TOKEN_ACCOUNT_BYTES)
    throw new Error(`not a token account: ${data.length} bytes`);
  // State: 0 uninitialised, 1 initialised, 2 frozen. A frozen balance is still the holder's.
  if (data[108] !== 1 && data[108] !== 2) throw new Error('the token account is not initialised');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: addressDecoder.decode(data.subarray(0, 32)),
    owner: addressDecoder.decode(data.subarray(32, 64)),
    amount: view.getBigUint64(64, true),
  };
}
