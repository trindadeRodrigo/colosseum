import {
  type Address,
  fixDecoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getArrayDecoder,
  getBooleanDecoder,
  getBytesDecoder,
  getI64Decoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getU8Decoder,
  getU16Decoder,
  getU32Decoder,
  getU64Decoder,
  getU64Encoder,
} from '@solana/kit';

// The two accounts of programs/basket, as programs/basket/src/state.rs lays them out (DESIGN-VAULT 3.7).
// Borsh, behind Anchor's 8-byte discriminator. The tests check these against idl/basket.json and against
// bytes the built program wrote (fixtures/solana-vault).

/** sha256("account:Config")[0..8] and sha256("account:Vault")[0..8], as idl/basket.json lists them. */
export const CONFIG_DISCRIMINATOR = new Uint8Array([155, 12, 170, 224, 30, 250, 204, 130]);
export const VAULT_DISCRIMINATOR = new Uint8Array([211, 8, 232, 43, 2, 152, 117, 119]);

export const CONFIG_SIZE = 396;
export const VAULT_SIZE = 1063;
export const MAX_POSITIONS = 16;

/** Frozen offsets in Vault, for memcmp filters: the program's field order does not change. */
export const VAULT_OWNER_OFFSET = 8;
export const VAULT_RECIPE_OFFSET = 40;
export const VAULT_ACCEPTED_VERSION_OFFSET = 72;
export const VAULT_AUTO_FOLLOW_OFFSET = 76;

/** All zeros: the empty value of an address field, and also the system program's id. */
export const ZERO_ADDRESS = '11111111111111111111111111111111' as Address;

/** `BasketError`, in the program's order. Anchor numbers them from 6000. */
export const VAULT_ERRORS = [
  'NotKeeper',
  'AutoFollowOff',
  'KeeperPaused',
  'MintNotAccepted',
  'RouterNotAllowed',
  'SpentTooMuch',
  'ReceivedTooLittle',
  'OtherAccountDebited',
  'AccountTampered',
  'PriceStale',
  'PriceDeviation',
  'MarketClosed',
  'MultiplierWindow',
  'NotTowardTarget',
  'PastTarget',
  'Cooldown',
  'LossCapReached',
  'AssetNotPriced',
  'NewAssetNeedsOwner',
  'VersionNotEffective',
  'CreatorLimit',
  'VersionMismatch',
  'WrongDestination',
  'ParamOutOfBounds',
  'NotUpgradeAuthority',
  'InvalidTargets',
  'NotCashMint',
  'ZeroAddress',
] as const;
export const VAULT_ERROR_BASE = 6000;

/** The program's name for a custom error code, or null when the code is not one of its own. */
export function vaultErrorName(code: number): (typeof VAULT_ERRORS)[number] | null {
  return VAULT_ERRORS[code - VAULT_ERROR_BASE] ?? null;
}

const addressDecoder = getAddressDecoder();

const configDecoder = getStructDecoder([
  ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
  ['admin', addressDecoder],
  ['pendingAdmin', addressDecoder],
  ['guardian', addressDecoder],
  ['defaultKeeper', addressDecoder],
  ['routerProgram', addressDecoder],
  ['priceOwner', addressDecoder],
  ['cashMint', addressDecoder],
  ['keeperPaused', getBooleanDecoder()],
  ['launched', getBooleanDecoder()],
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
  ['autoFollow', getBooleanDecoder()],
  ['basketId', getU64Decoder()],
  ['bump', getU8Decoder()],
  ['keeper', addressDecoder],
  ['count', getU8Decoder()],
  ['positions', getArrayDecoder(positionDecoder, { size: MAX_POSITIONS })],
  ['lossAccum', getU64Decoder()],
  ['lossTs', getI64Decoder()],
  ['reserved', fixDecoderSize(getBytesDecoder(), 128)],
]);

export type ConfigAccount = Omit<ReturnType<typeof configDecoder.decode>, 'discriminator'>;
export type PositionEntry = ReturnType<typeof positionDecoder.decode>;
/** `positions` holds only the slots in use: the first `count` of the sixteen. */
export type VaultAccount = Omit<ReturnType<typeof vaultDecoder.decode>, 'discriminator'>;

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** True when the bytes are the size of `kind` and start with its discriminator. */
export function isAccount(kind: 'config' | 'vault', data: Uint8Array): boolean {
  const [size, tag] =
    kind === 'config' ? [CONFIG_SIZE, CONFIG_DISCRIMINATOR] : [VAULT_SIZE, VAULT_DISCRIMINATOR];
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

const addressEncoder = getAddressEncoder();

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
