import {
  type AccountMeta,
  type Address,
  fixDecoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getArrayDecoder,
  getArrayEncoder,
  getBooleanDecoder,
  getBooleanEncoder,
  getBytesDecoder,
  getI64Decoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getStructEncoder,
  getU8Decoder,
  getU16Decoder,
  getU16Encoder,
  getU32Decoder,
  getU32Encoder,
  getU64Decoder,
  getU64Encoder,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import {
  BASKET_PROGRAM,
  concat,
  discriminator,
  programDataAddress,
  readonly,
  SYSTEM_PROGRAM,
  signer,
  writable,
  writableSigner,
} from './env';
import { ata, type TestMint } from './tokens';

/** `BasketError`, in the frozen order of DESIGN-VAULT.md section 3.7. Anchor numbers them from 6000. */
export const FROZEN_ERRORS = [
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
] as const;

export const ERR = {
  VersionMismatch: 6021,
  WrongDestination: 6022,
  ParamOutOfBounds: 6023,
  // Appended by SOL-1, after the frozen list.
  NotUpgradeAuthority: 6024,
  InvalidTargets: 6025,
} as const;

export const CONFIG_SIZE = 364;
export const VAULT_SIZE = 1063;
export const MAX_POSITIONS = 16;

const addressEncoder = getAddressEncoder();
const u64 = getU64Encoder();

// ---- addresses ----

export async function configAddress(): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: BASKET_PROGRAM,
    seeds: ['config'],
  });
  return pda;
}

/** One vault per owner per plan id: seeds ["vault", owner, basket_id as u64 LE]. */
export async function vaultAddress(owner: Address, basketId: bigint): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: BASKET_PROGRAM,
    seeds: ['vault', addressEncoder.encode(owner), u64.encode(basketId)],
  });
  return pda;
}

// ---- accounts ----

export type Params = {
  toleranceBps: number;
  lossCapBps: number;
  bandBps: number;
  twapDevBps: number;
  maxPriceAgeS: number;
  assetCooldownS: number;
  publishDelayS: number;
  sessionOpenUtcS: number;
  sessionCloseUtcS: number;
};

export type InitConfigArgs = {
  guardian: Address;
  defaultKeeper: Address;
  routerProgram: Address;
  priceOwner: Address;
  params: Params;
};

const paramsEncoder = getStructEncoder([
  ['toleranceBps', getU16Encoder()],
  ['lossCapBps', getU16Encoder()],
  ['bandBps', getU16Encoder()],
  ['twapDevBps', getU16Encoder()],
  ['maxPriceAgeS', getU16Encoder()],
  ['assetCooldownS', getU32Encoder()],
  ['publishDelayS', getU32Encoder()],
  ['sessionOpenUtcS', getU32Encoder()],
  ['sessionCloseUtcS', getU32Encoder()],
]);

const initConfigArgsEncoder = getStructEncoder([
  ['guardian', addressEncoder],
  ['defaultKeeper', addressEncoder],
  ['routerProgram', addressEncoder],
  ['priceOwner', addressEncoder],
  ['params', paramsEncoder],
]);

const configDecoder = getStructDecoder([
  ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
  ['admin', getAddressDecoder()],
  ['pendingAdmin', getAddressDecoder()],
  ['guardian', getAddressDecoder()],
  ['defaultKeeper', getAddressDecoder()],
  ['routerProgram', getAddressDecoder()],
  ['priceOwner', getAddressDecoder()],
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
  ['reserved', fixDecoderSize(getBytesDecoder(), 64)],
]);

const positionDecoder = getStructDecoder([
  ['mint', getAddressDecoder()],
  ['targetBps', getU16Decoder()],
  ['tracked', getU64Decoder()],
  ['lastKeeperTs', getI64Decoder()],
]);

const vaultDecoder = getStructDecoder([
  ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
  ['owner', getAddressDecoder()],
  ['recipe', getAddressDecoder()],
  ['acceptedVersion', getU32Decoder()],
  ['autoFollow', getBooleanDecoder()],
  ['basketId', getU64Decoder()],
  ['bump', getU8Decoder()],
  ['keeper', getAddressDecoder()],
  ['count', getU8Decoder()],
  ['positions', getArrayDecoder(positionDecoder, { size: MAX_POSITIONS })],
  ['lossAccum', getU64Decoder()],
  ['lossTs', getI64Decoder()],
  ['reserved', fixDecoderSize(getBytesDecoder(), 128)],
]);

function accountData(svm: LiteSVM, addr: Address, what: string): Uint8Array {
  const account = svm.getAccount(addr);
  if (!account.exists) throw new Error(`${what} ${addr} does not exist`);
  if (account.programAddress !== BASKET_PROGRAM) throw new Error(`${what} is not the program's`);
  return new Uint8Array(account.data);
}

export async function readConfig(svm: LiteSVM) {
  return configDecoder.decode(accountData(svm, await configAddress(), 'config'));
}

export function readVault(svm: LiteSVM, vault: Address) {
  return vaultDecoder.decode(accountData(svm, vault, 'vault'));
}

/** What the vault has recorded for a mint, or null when the mint is not one of its positions. */
export function trackedFor(svm: LiteSVM, vault: Address, mint: Address): bigint | null {
  const state = readVault(svm, vault);
  const position = state.positions.slice(0, state.count).find((p) => p.mint === mint);
  return position ? position.tracked : null;
}

// ---- instructions ----

/** Accounts: authority (signer, pays), config, the program, its program data, system program. */
export async function initConfigInstruction(
  authority: TransactionSigner,
  args: InitConfigArgs,
  overrides: { program?: Address; programData?: Address } = {},
): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      writableSigner(authority),
      writable(await configAddress()),
      readonly(overrides.program ?? BASKET_PROGRAM),
      readonly(overrides.programData ?? (await programDataAddress(BASKET_PROGRAM))),
      readonly(SYSTEM_PROGRAM),
    ],
    data: concat(discriminator('init_config'), initConfigArgsEncoder.encode(args)),
  };
}

/** Accounts: admin (signer), config. */
export async function setRouterInstruction(
  admin: TransactionSigner,
  routerProgram: Address,
): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [signer(admin), writable(await configAddress())],
    data: concat(discriminator('set_router'), addressEncoder.encode(routerProgram)),
  };
}

/** Accounts: admin (signer), config. */
export async function setPriceOwnerInstruction(
  admin: TransactionSigner,
  priceOwner: Address,
): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [signer(admin), writable(await configAddress())],
    data: concat(discriminator('set_price_owner'), addressEncoder.encode(priceOwner)),
  };
}

export type Target = { mint: Address; targetBps: number };

const createVaultArgsEncoder = getStructEncoder([
  ['basketId', u64],
  [
    'targets',
    getArrayEncoder(
      getStructEncoder([
        ['mint', addressEncoder],
        ['targetBps', getU16Encoder()],
      ]),
    ),
  ],
  ['autoFollow', getBooleanEncoder()],
  ['expectedVersion', getU32Encoder()],
]);

/** Accounts: owner (signer, pays), vault, system program. */
export async function createVaultInstruction(input: {
  owner: TransactionSigner;
  basketId: bigint;
  targets?: Target[];
  autoFollow?: boolean;
  expectedVersion?: number;
  /** For hostile tests: a vault address other than the one derived from this owner. */
  vault?: Address;
}): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      writableSigner(input.owner),
      writable(input.vault ?? (await vaultAddress(input.owner.address, input.basketId))),
      readonly(SYSTEM_PROGRAM),
    ],
    data: concat(
      discriminator('create_vault'),
      createVaultArgsEncoder.encode({
        basketId: input.basketId,
        targets: input.targets ?? [],
        autoFollow: input.autoFollow ?? false,
        expectedVersion: input.expectedVersion ?? 0,
      }),
    ),
  };
}

/** Accounts: owner (signer), vault, mint, the vault's token account, the source token account,
 * the mint's token program. */
export async function depositInstruction(input: {
  owner: TransactionSigner;
  vault: Address;
  mint: TestMint;
  amount: bigint;
  source?: Address;
  vaultTokenAccount?: Address;
}): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      signer(input.owner),
      writable(input.vault),
      readonly(input.mint.address),
      writable(input.vaultTokenAccount ?? (await ata(input.vault, input.mint))),
      writable(input.source ?? (await ata(input.owner.address, input.mint))),
      readonly(input.mint.program),
    ],
    data: concat(discriminator('deposit'), u64.encode(input.amount)),
  };
}

/** Accounts: owner (signer), vault, mint, the vault's token account, the destination token
 * account, the mint's token program, then any extra accounts a transfer hook needs. */
export async function withdrawInstruction(input: {
  owner: TransactionSigner;
  vault: Address;
  mint: TestMint;
  amount: bigint;
  destination?: Address;
  vaultTokenAccount?: Address;
  extraAccounts?: AccountMeta[];
}): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      signer(input.owner),
      writable(input.vault),
      readonly(input.mint.address),
      writable(input.vaultTokenAccount ?? (await ata(input.vault, input.mint))),
      writable(input.destination ?? (await ata(input.owner.address, input.mint))),
      readonly(input.mint.program),
      ...(input.extraAccounts ?? []),
    ],
    data: concat(discriminator('withdraw'), u64.encode(input.amount)),
  };
}
