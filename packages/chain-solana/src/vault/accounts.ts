import { PROGRAM_ERRORS } from '@colosseum/schemas';
import {
  type Address,
  fixDecoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getArrayDecoder,
  getBytesDecoder,
  getI64Decoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getU8Decoder,
  getU16Decoder,
  getU32Decoder,
  getU64Decoder,
  getU64Encoder,
  transformDecoder,
} from '@solana/kit';

// The four accounts of programs/basket, as programs/basket/src/state.rs lays them out (DESIGN-VAULT 3.7).
// Config, Vault and Recipe are Borsh; the asset list is the same fields with no padding. Each sits behind
// Anchor's 8-byte discriminator. The tests check these against idl/basket.json and against bytes the
// built program wrote (fixtures/solana-vault).

/** sha256("account:<Name>")[0..8] for each account, as idl/basket.json lists them. */
export const CONFIG_DISCRIMINATOR = new Uint8Array([155, 12, 170, 224, 30, 250, 204, 130]);
export const VAULT_DISCRIMINATOR = new Uint8Array([211, 8, 232, 43, 2, 152, 117, 119]);
export const ASSETS_DISCRIMINATOR = new Uint8Array([60, 94, 213, 134, 205, 170, 175, 68]);
export const RECIPE_DISCRIMINATOR = new Uint8Array([10, 162, 156, 100, 56, 193, 205, 77]);

export const CONFIG_SIZE = 396;
export const VAULT_SIZE = 1063;
export const ASSETS_SIZE = 6281;
export const RECIPE_SIZE = 1022;
export const MAX_POSITIONS = 16;
export const MAX_ASSETS = 64;
export const MAX_COMPONENTS = 12;

/** Frozen offsets in Vault, for memcmp filters: the program's field order does not change. */
export const VAULT_OWNER_OFFSET = 8;
export const VAULT_RECIPE_OFFSET = 40;
export const VAULT_ACCEPTED_VERSION_OFFSET = 72;
export const VAULT_AUTO_FOLLOW_OFFSET = 76;

/** All zeros: the empty value of an address field, and also the system program's id. */
export const ZERO_ADDRESS = '11111111111111111111111111111111' as Address;

/**
 * `BasketError`, in the program's order: the first block of `ChainErrorCode` in packages/schemas, which
 * is the one list. Anchor numbers them from 6000.
 */
export const VAULT_ERRORS = PROGRAM_ERRORS;
export const VAULT_ERROR_BASE = 6000;

/** The program's name for a custom error code, or null when the code is not one of its own. */
export function vaultErrorName(code: number): (typeof VAULT_ERRORS)[number] | null {
  return VAULT_ERRORS[code - VAULT_ERROR_BASE] ?? null;
}

const addressDecoder = getAddressDecoder();

/** A Borsh bool is one byte, 0 or 1. Anything else is not something the program wrote. */
const strictBoolean = transformDecoder(getU8Decoder(), (byte): boolean => {
  if (byte > 1) throw new Error(`a flag holds ${byte}, which is neither true nor false`);
  return byte === 1;
});

const configDecoder = getStructDecoder([
  ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
  ['admin', addressDecoder],
  ['pendingAdmin', addressDecoder],
  ['guardian', addressDecoder],
  ['defaultKeeper', addressDecoder],
  ['routerProgram', addressDecoder],
  ['priceOwner', addressDecoder],
  ['cashMint', addressDecoder],
  ['keeperPaused', strictBoolean],
  ['launched', strictBoolean],
  ['toleranceBps', getU16Decoder()],
  ['lossCapBps', getU16Decoder()],
  ['bandBps', getU16Decoder()],
  ['twapDevBps', getU16Decoder()],
  ['maxPriceAgeS', getU16Decoder()],
  ['assetCooldownS', getU32Decoder()],
  ['publishDelayS', getU32Decoder()],
  ['sessionOpenUtcS', getU32Decoder()],
  ['sessionCloseUtcS', getU32Decoder()],
  ['closedUntil', getI64Decoder()],
  ['closedDays', getArrayDecoder(getU16Decoder(), { size: 32 })],
  ['bump', getU8Decoder()],
  ['reserved', fixDecoderSize(getBytesDecoder(), 63)],
]);

const positionDecoder = getStructDecoder([
  ['mint', addressDecoder],
  ['targetBps', getU16Decoder()],
  ['tracked', getU64Decoder()],
  ['lastKeeperTs', getI64Decoder()],
]);

const vaultDecoder = getStructDecoder([
  ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
  ['owner', addressDecoder],
  ['recipe', addressDecoder],
  ['acceptedVersion', getU32Decoder()],
  ['autoFollow', strictBoolean],
  ['basketId', getU64Decoder()],
  ['bump', getU8Decoder()],
  ['keeper', addressDecoder],
  ['count', getU8Decoder()],
  ['positions', getArrayDecoder(positionDecoder, { size: MAX_POSITIONS })],
  ['lossAccum', getU64Decoder()],
  ['lossTs', getI64Decoder()],
  ['reserved', fixDecoderSize(getBytesDecoder(), 128)],
]);

const bytes32 = fixDecoderSize(getBytesDecoder(), 32);

// Packed: no padding between the fields, so an entry is 96 bytes and starts at 137 + 96·i.
const assetEntryDecoder = getStructDecoder([
  ['mint', addressDecoder],
  ['priceSlot', getU8Decoder()],
  ['priceIndex', getU16Decoder()],
  ['twapIndex', getU16Decoder()],
  ['decimals', getU8Decoder()],
  ['priceKind', getU8Decoder()],
  ['session', getU8Decoder()],
  ['maxWeightBps', getU16Decoder()],
  ['flags', getU8Decoder()],
  ['sourceCheck', bytes32],
  ['reserved', fixDecoderSize(getBytesDecoder(), 21)],
]);

const assetRegistryDecoder = getStructDecoder([
  ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
  ['priceAccounts', getArrayDecoder(addressDecoder, { size: 4 })],
  ['count', getU8Decoder()],
  ['assets', getArrayDecoder(assetEntryDecoder, { size: MAX_ASSETS })],
]);

const componentDecoder = getStructDecoder([
  ['mint', addressDecoder],
  ['weightBps', getU16Decoder()],
]);

const recipeVersionDecoder = getStructDecoder([
  ['version', getU32Decoder()],
  ['effectiveAt', getI64Decoder()],
  ['metaHash', bytes32],
  ['count', getU8Decoder()],
  ['components', getArrayDecoder(componentDecoder, { size: MAX_COMPONENTS })],
]);

const recipeDecoder = getStructDecoder([
  ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
  ['creator', addressDecoder],
  ['familyId', bytes32],
  ['current', recipeVersionDecoder],
  ['pending', recipeVersionDecoder],
  ['lastPublishTs', getI64Decoder()],
  ['maxFeeBps', getU16Decoder()],
  ['flags', getU8Decoder()],
  ['vetoed', strictBoolean],
  // The highest version number ever given out; zero on an account older than the field.
  ['lastVersion', getU32Decoder()],
  ['reserved', fixDecoderSize(getBytesDecoder(), 28)],
]);

export type ConfigAccount = Omit<ReturnType<typeof configDecoder.decode>, 'discriminator'>;
export type AssetEntry = ReturnType<typeof assetEntryDecoder.decode>;
/** `assets` holds only the entries in use: the first `count` of the sixty-four. */
export type AssetRegistryAccount = Omit<
  ReturnType<typeof assetRegistryDecoder.decode>,
  'discriminator'
>;
export type RecipeComponent = ReturnType<typeof componentDecoder.decode>;
/** `components` holds only the lines in use. `version` zero means there is no such version. */
export type RecipeVersion = ReturnType<typeof recipeVersionDecoder.decode>;
export type RecipeAccount = Omit<ReturnType<typeof recipeDecoder.decode>, 'discriminator'>;
export type PositionEntry = ReturnType<typeof positionDecoder.decode>;
/** `positions` holds only the slots in use: the first `count` of the sixteen. */
export type VaultAccount = Omit<ReturnType<typeof vaultDecoder.decode>, 'discriminator'>;

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const KINDS = {
  config: [CONFIG_SIZE, CONFIG_DISCRIMINATOR],
  vault: [VAULT_SIZE, VAULT_DISCRIMINATOR],
  assets: [ASSETS_SIZE, ASSETS_DISCRIMINATOR],
  recipe: [RECIPE_SIZE, RECIPE_DISCRIMINATOR],
} as const;

/** True when the bytes are the size of `kind` and start with its discriminator. */
export function isAccount(kind: keyof typeof KINDS, data: Uint8Array): boolean {
  const [size, tag] = KINDS[kind];
  return data.length === size && sameBytes(data.subarray(0, 8), tag);
}

/** Decodes a Config account. Throws when the bytes are not one. */
export function decodeConfig(data: Uint8Array): ConfigAccount {
  if (!isAccount('config', data))
    throw new Error(`not a Config account: ${data.length} bytes, expected ${CONFIG_SIZE}`);
  const { discriminator: _, ...config } = configDecoder.decode(data);
  return config;
}

/** Decodes a Vault account. Throws when the bytes are not one, or when `count` is past the sixteen slots. */
export function decodeVault(data: Uint8Array): VaultAccount {
  if (!isAccount('vault', data))
    throw new Error(`not a Vault account: ${data.length} bytes, expected ${VAULT_SIZE}`);
  const { discriminator: _, ...vault } = vaultDecoder.decode(data);
  if (vault.count > MAX_POSITIONS) throw new Error(`a vault has ${vault.count} positions in use`);
  return { ...vault, positions: vault.positions.slice(0, vault.count) };
}

/** Decodes the asset list. Throws when the bytes are not one, or when `count` is past the sixty-four entries. */
export function decodeAssetRegistry(data: Uint8Array): AssetRegistryAccount {
  if (!isAccount('assets', data))
    throw new Error(`not an asset list: ${data.length} bytes, expected ${ASSETS_SIZE}`);
  const { discriminator: _, ...registry } = assetRegistryDecoder.decode(data);
  if (registry.count > MAX_ASSETS) throw new Error(`an asset list has ${registry.count} entries`);
  return { ...registry, assets: registry.assets.slice(0, registry.count) };
}

/** Decodes a shared portfolio. Throws when the bytes are not one, or when a version names more than twelve lines. */
export function decodeRecipe(data: Uint8Array): RecipeAccount {
  if (!isAccount('recipe', data))
    throw new Error(`not a Recipe account: ${data.length} bytes, expected ${RECIPE_SIZE}`);
  const { discriminator: _, ...recipe } = recipeDecoder.decode(data);
  const used = (version: RecipeVersion): RecipeVersion => {
    if (version.count > MAX_COMPONENTS)
      throw new Error(`a version of a shared portfolio has ${version.count} lines`);
    return { ...version, components: version.components.slice(0, version.count) };
  };
  return { ...recipe, current: used(recipe.current), pending: used(recipe.pending) };
}

/**
 * The version in effect at `now` (unix seconds, the cluster's clock) and the one that waits. The
 * program's own rule: a version that waited and whose time has come is in effect with no transaction,
 * whether or not anyone has written to the account since.
 */
export function versionsAt(
  recipe: RecipeAccount,
  now: bigint,
): { active: RecipeVersion; pending: RecipeVersion | null } {
  if (recipe.pending.version === 0) return { active: recipe.current, pending: null };
  return now >= recipe.pending.effectiveAt
    ? { active: recipe.pending, pending: null }
    : { active: recipe.current, pending: recipe.pending };
}

const addressEncoder = getAddressEncoder();

/** The platform's asset list: seeds ["assets"]. */
export async function assetsAddress(program: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: program, seeds: ['assets'] });
  return pda;
}

/** One shared portfolio per creator per family: seeds ["recipe", creator, family id (32 bytes)]. */
export async function recipeAddress(
  program: Address,
  creator: Address,
  familyId: Uint8Array,
): Promise<Address> {
  if (familyId.length !== 32) throw new Error('a family id is 32 bytes');
  const [pda] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: ['recipe', addressEncoder.encode(creator), familyId],
  });
  return pda;
}

/** The one Config account of a deployment: seeds ["config"]. */
export async function configAddress(program: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: program, seeds: ['config'] });
  return pda;
}

/** One vault per owner per plan id: seeds ["vault", owner, basket_id as u64 LE]. */
export async function vaultAddress(
  program: Address,
  owner: Address,
  basketId: bigint,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: ['vault', addressEncoder.encode(owner), getU64Encoder().encode(basketId)],
  });
  return pda;
}
