import { addressBytes, base58Encode, concatBytes, hexDecode, utf8Encode } from '../../bytes';
import { onEd25519Curve, sha256 } from '../../hash';

// The addresses a step's accounts must have, each worked out from the person's own address. Nothing here
// is read from the transaction. The seeds are the program's own (DESIGN-VAULT 3.7), and tables.test.ts
// holds them to the committed interface file.

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const TOKEN_PROGRAMS = {
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'token-2022': 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
} as const;

export const SEEDS = {
  vault: 'vault',
  config: 'config',
  assets: 'assets',
  recipe: 'recipe',
} as const;

const MARKER = utf8Encode('ProgramDerivedAddress');

/** The address a program derives from seeds: the first of bumps 255 down to 0 that is off the curve. */
export function programAddress(seeds: Uint8Array[], program: string): string {
  const owner = addressBytes(program);
  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = sha256(concatBytes(...seeds, Uint8Array.of(bump), owner, MARKER));
    if (!onEd25519Curve(hash)) return base58Encode(hash);
  }
  throw new Error('no address for these seeds');
}

/** The plan's number as the program takes it: eight bytes, little-endian. */
export function basketIdBytes(basketId: string): Uint8Array {
  let n = BigInt(basketId);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** The vault of one owner for one plan. */
export const vaultAddress = (program: string, owner: string, basketId: string) =>
  programAddress([utf8Encode(SEEDS.vault), addressBytes(owner), basketIdBytes(basketId)], program);

export const configAddress = (program: string) =>
  programAddress([utf8Encode(SEEDS.config)], program);

export const assetsAddress = (program: string) =>
  programAddress([utf8Encode(SEEDS.assets)], program);

/** A creator's shared portfolio of one family: the registry's account. */
export const recipeAddress = (program: string, creator: string, familyId: string) =>
  programAddress(
    [utf8Encode(SEEDS.recipe), addressBytes(creator), hexDecode(`0x${familyId}`)],
    program,
  );

/** The associated token account of `holder` for `mint`, under the token program that owns the mint. */
export const tokenAccountAddress = (holder: string, mint: string, tokenProgram: string) =>
  programAddress(
    [addressBytes(holder), addressBytes(tokenProgram), addressBytes(mint)],
    ASSOCIATED_TOKEN_PROGRAM,
  );
