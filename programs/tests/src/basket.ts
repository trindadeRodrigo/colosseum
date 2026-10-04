import {
  type AccountMeta,
  AccountRole,
  type Address,
  addEncoderSizePrefix,
  fixDecoderSize,
  fixEncoderSize,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getArrayDecoder,
  getArrayEncoder,
  getBooleanDecoder,
  getBooleanEncoder,
  getBytesDecoder,
  getBytesEncoder,
  getI64Decoder,
  getI64Encoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getStructEncoder,
  getU8Decoder,
  getU8Encoder,
  getU16Decoder,
  getU16Encoder,
  getU32Decoder,
  getU32Encoder,
  getU64Decoder,
  getU64Encoder,
  type Instruction,
  isWritableRole,
  type TransactionSigner,
} from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import {
  BASKET_PROGRAM,
  concat,
  discriminator,
  expectOk,
  programDataAddress,
  readonly,
  type SendResult,
  SYSTEM_PROGRAM,
  SYSVAR_RENT,
  send,
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
  NotKeeper: 6000,
  AutoFollowOff: 6001,
  KeeperPaused: 6002,
  MintNotAccepted: 6003,
  RouterNotAllowed: 6004,
  SpentTooMuch: 6005,
  ReceivedTooLittle: 6006,
  AccountTampered: 6008,
  PriceStale: 6009,
  PriceDeviation: 6010,
  MarketClosed: 6011,
  MultiplierWindow: 6012,
  NotTowardTarget: 6013,
  PastTarget: 6014,
  Cooldown: 6015,
  LossCapReached: 6016,
  AssetNotPriced: 6017,
  NewAssetNeedsOwner: 6018,
  VersionNotEffective: 6019,
  CreatorLimit: 6020,
  VersionMismatch: 6021,
  WrongDestination: 6022,
  ParamOutOfBounds: 6023,
  // Appended by SOL-1, after the frozen list.
  NotUpgradeAuthority: 6024,
  InvalidTargets: 6025,
  NotCashMint: 6026,
  ZeroAddress: 6027,
  // Appended by SOL-2.
  LockedAtLaunch: 6028,
  HookNotAllowed: 6029,
  AssetListFull: 6030,
  SameMint: 6031,
  NoPendingVersion: 6032,
  NotCreatorOrGuardian: 6033,
  // Appended by SOL-3.
  NotCashLeg: 6034,
  KeeperAssetOff: 6035,
  // Appended by the SOL-3 fix round.
  PriceOutOfRange: 6036,
  NothingTraded: 6037,
} as const;

export const CONFIG_SIZE = 396;
export const VAULT_SIZE = 1063;
export const ASSETS_SIZE = 6281;
export const RECIPE_SIZE = 1022;
export const MAX_POSITIONS = 16;
export const MAX_ASSETS = 64;
export const MAX_COMPONENTS = 12;
/** `AssetEntry.flags`, bit 0: the keeper may trade the asset. */
export const ASSET_KEEPER = 1;
/** A price account in Scope's layout: a 40-byte header and 512 entries of 56 bytes. */
export const PRICES_SIZE = 40 + 56 * 512;

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

/** The platform's asset list: seeds ["assets"]. */
export async function assetsAddress(): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: BASKET_PROGRAM,
    seeds: ['assets'],
  });
  return pda;
}

/** One shared portfolio per creator per family: seeds ["recipe", creator, family_id]. */
export async function recipeAddress(creator: Address, familyId: Uint8Array): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: BASKET_PROGRAM,
    seeds: ['recipe', addressEncoder.encode(creator), familyId],
  });
  return pda;
}

/** A family id from a short name: the name's bytes, padded with zeros to 32. */
export function familyId(name: string): Uint8Array {
  const bytes = new TextEncoder().encode(name);
  if (bytes.length > 32) throw new Error('a family id is 32 bytes');
  const out = new Uint8Array(32);
  out.set(bytes);
  return out;
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
  cashMint: Address;
  params: Params;
};

/** The starting values of DESIGN-VAULT.md section 5. They are settings, not figures the app shows.
 * The loss cap is half of what a person is promised: the counter drains as it fills, so seven
 * days can hold just under twice the parameter. */
export const DEFAULT_PARAMS: Params = {
  toleranceBps: 75,
  lossCapBps: 100,
  bandBps: 50,
  twapDevBps: 200,
  maxPriceAgeS: 120,
  assetCooldownS: 3_600,
  publishDelayS: 60,
  sessionOpenUtcS: 14 * 3_600 + 30 * 60,
  sessionCloseUtcS: 20 * 3_600,
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

// The cash mint is not among the arguments: it goes in as an account, which has to be a mint.
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
  ['cashMint', getAddressDecoder()],
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

const bytes32 = fixDecoderSize(getBytesDecoder(), 32);

// Packed: the bytes are the fields in this order with no padding (state.rs).
const assetEntryDecoder = getStructDecoder([
  ['mint', getAddressDecoder()],
  ['priceSlot', getU8Decoder()],
  ['priceIndex', getU16Decoder()],
  ['twapIndex', getU16Decoder()],
  ['decimals', getU8Decoder()],
  ['priceKind', getU8Decoder()],
  ['session', getU8Decoder()],
  ['maxWeightBps', getU16Decoder()],
  ['flags', getU8Decoder()],
  ['sourceCheck', bytes32],
  ['minPrice', getU64Decoder()],
  ['maxPrice', getU64Decoder()],
  ['reserved', fixDecoderSize(getBytesDecoder(), 5)],
]);

const assetRegistryDecoder = getStructDecoder([
  ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
  ['priceAccounts', getArrayDecoder(getAddressDecoder(), { size: 4 })],
  ['count', getU8Decoder()],
  ['assets', getArrayDecoder(assetEntryDecoder, { size: MAX_ASSETS })],
]);

const componentDecoder = getStructDecoder([
  ['mint', getAddressDecoder()],
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
  ['creator', getAddressDecoder()],
  ['familyId', bytes32],
  ['current', recipeVersionDecoder],
  ['pending', recipeVersionDecoder],
  ['lastPublishTs', getI64Decoder()],
  ['maxFeeBps', getU16Decoder()],
  ['flags', getU8Decoder()],
  ['vetoed', getBooleanDecoder()],
  ['lastVersion', getU32Decoder()],
  ['reserved', fixDecoderSize(getBytesDecoder(), 28)],
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

/** The asset list, with only the entries in use. */
export async function readAssets(svm: LiteSVM) {
  const registry = assetRegistryDecoder.decode(accountData(svm, await assetsAddress(), 'assets'));
  return { ...registry, assets: registry.assets.slice(0, registry.count) };
}

export type Component = { mint: Address; weightBps: number };

/** A shared portfolio. Each version carries only the components in use. */
export function readRecipe(svm: LiteSVM, recipe: Address) {
  const decoded = recipeDecoder.decode(accountData(svm, recipe, 'recipe'));
  const used = (v: typeof decoded.current) => ({
    ...v,
    components: v.components.slice(0, v.count),
  });
  return { ...decoded, current: used(decoded.current), pending: used(decoded.pending) };
}

/** What the vault has recorded for a mint, or null when the mint is not one of its positions. */
export function trackedFor(svm: LiteSVM, vault: Address, mint: Address): bigint | null {
  const state = readVault(svm, vault);
  const position = state.positions.slice(0, state.count).find((p) => p.mint === mint);
  return position ? position.tracked : null;
}

// ---- instructions ----

/** Accounts: authority (signer, pays), config, the cash mint, the program, its program data,
 * system program. */
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
      readonly(args.cashMint),
      readonly(overrides.program ?? BASKET_PROGRAM),
      readonly(overrides.programData ?? (await programDataAddress(BASKET_PROGRAM))),
      readonly(SYSTEM_PROGRAM),
    ],
    data: concat(discriminator('init_config'), initConfigArgsEncoder.encode(args)),
  };
}

/** The router and the price owner are set by address. Accounts: admin (signer), config. */
async function setAddressInstruction(
  name: 'set_router' | 'set_price_owner',
  admin: TransactionSigner,
  value: Address,
  config?: Address,
): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [signer(admin), writable(config ?? (await configAddress()))],
    data: concat(discriminator(name), addressEncoder.encode(value)),
  };
}

export const setRouterInstruction = (admin: TransactionSigner, value: Address, config?: Address) =>
  setAddressInstruction('set_router', admin, value, config);
export const setPriceOwnerInstruction = (
  admin: TransactionSigner,
  value: Address,
  config?: Address,
) => setAddressInstruction('set_price_owner', admin, value, config);
/** The cash mint is set by account, and has to be a mint. Accounts: admin (signer), config, the mint. */
export async function setCashMintInstruction(
  admin: TransactionSigner,
  mint: Address,
  config?: Address,
): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [signer(admin), writable(config ?? (await configAddress())), readonly(mint)],
    data: discriminator('set_cash_mint'),
  };
}

/** The three setter events carry the old and the new value. */
export function decodeAddressChange(payload: Uint8Array): { old: Address; new: Address } {
  const decoder = getAddressDecoder();
  return { old: decoder.decode(payload.slice(0, 32)), new: decoder.decode(payload.slice(32, 64)) };
}

/** One instruction with no arguments but its name. Accounts: the signer, then Config. */
async function switchInstruction(
  name: string,
  who: TransactionSigner,
  config?: Address,
): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [signer(who), writable(config ?? (await configAddress()))],
    data: discriminator(name),
  };
}

/** Accounts: admin (signer), config. */
export async function setParamsInstruction(
  admin: TransactionSigner,
  params: Params,
  config?: Address,
): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [signer(admin), writable(config ?? (await configAddress()))],
    data: concat(discriminator('set_params'), paramsEncoder.encode(params)),
  };
}

export const launchInstruction = (admin: TransactionSigner, config?: Address) =>
  switchInstruction('launch', admin, config);
export const unpauseKeeperInstruction = (admin: TransactionSigner, config?: Address) =>
  switchInstruction('unpause_keeper', admin, config);
/** Accounts: guardian (signer), config. */
export const pauseKeeperInstruction = (guardian: TransactionSigner, config?: Address) =>
  switchInstruction('pause_keeper', guardian, config);
/** Accounts: the proposed admin (signer), config. */
export const acceptAdminInstruction = (pendingAdmin: TransactionSigner, config?: Address) =>
  switchInstruction('accept_admin', pendingAdmin, config);

/** Accounts: admin (signer), config. */
export async function proposeAdminInstruction(
  admin: TransactionSigner,
  pendingAdmin: Address,
  config?: Address,
): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [signer(admin), writable(config ?? (await configAddress()))],
    data: concat(discriminator('propose_admin'), addressEncoder.encode(pendingAdmin)),
  };
}

/** The guardian and the default keeper are set by address. Accounts: admin (signer), config. */
async function setKeyInstruction(
  name: 'set_guardian' | 'set_default_keeper',
  admin: TransactionSigner,
  value: Address,
  config?: Address,
): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [signer(admin), writable(config ?? (await configAddress()))],
    data: concat(discriminator(name), addressEncoder.encode(value)),
  };
}

export const setGuardianInstruction = (
  admin: TransactionSigner,
  value: Address,
  config?: Address,
) => setKeyInstruction('set_guardian', admin, value, config);
export const setDefaultKeeperInstruction = (
  admin: TransactionSigner,
  value: Address,
  config?: Address,
) => setKeyInstruction('set_default_keeper', admin, value, config);

/** Accounts: the admin (`set_closed_until`) or the guardian (`extend_closed_until`), config. */
async function closedUntilInstruction(
  name: 'set_closed_until' | 'extend_closed_until',
  who: TransactionSigner,
  closedUntil: bigint,
  config?: Address,
): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [signer(who), writable(config ?? (await configAddress()))],
    data: concat(discriminator(name), getI64Encoder().encode(closedUntil)),
  };
}

export const setClosedUntilInstruction = (
  admin: TransactionSigner,
  closedUntil: bigint,
  config?: Address,
) => closedUntilInstruction('set_closed_until', admin, closedUntil, config);
export const extendClosedUntilInstruction = (
  guardian: TransactionSigner,
  closedUntil: bigint,
  config?: Address,
) => closedUntilInstruction('extend_closed_until', guardian, closedUntil, config);

/** Accounts: admin (signer), config. `day` is days since 1970, UTC. */
export async function setClosedDayInstruction(
  admin: TransactionSigner,
  day: number,
  closed: boolean,
  config?: Address,
): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [signer(admin), writable(config ?? (await configAddress()))],
    data: concat(
      discriminator('set_closed_day'),
      getU16Encoder().encode(day),
      getBooleanEncoder().encode(closed),
    ),
  };
}

/** Accounts: guardian (signer), config. */
export async function addClosedDayInstruction(
  guardian: TransactionSigner,
  day: number,
  config?: Address,
): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [signer(guardian), writable(config ?? (await configAddress()))],
    data: concat(discriminator('add_closed_day'), getU16Encoder().encode(day)),
  };
}

/** Initialises Config with the default parameters and unused keys wherever the test names none. */
export async function initConfig(
  svm: LiteSVM,
  deployer: TransactionSigner,
  args: Partial<InitConfigArgs> & { cashMint: Address },
): Promise<SendResult> {
  const unused = SYSVAR_RENT; // any address that is not the zero address
  return send(svm, deployer, [
    await initConfigInstruction(deployer, {
      guardian: unused,
      defaultKeeper: unused,
      routerProgram: unused,
      priceOwner: unused,
      params: DEFAULT_PARAMS,
      ...args,
    }),
  ]);
}

/** A copy of the real Config at another address, with some bytes changed. No transaction
 * can make this account; it shows what the address check on Config is for. */
export async function forgeConfig(
  svm: LiteSVM,
  changes: {
    admin?: Address;
    guardian?: Address;
    cashMint?: Address;
    routerProgram?: Address;
    publishDelayS?: number;
    defaultKeeper?: Address;
    keeperPaused?: boolean;
  },
): Promise<Address> {
  const forged = (await generateKeyPairSigner()).address;
  await patchConfig(svm, changes, forged);
  return forged;
}

/** Rewrites bytes of Config, at its own address or as a copy at another. Only a test can. */
export async function patchConfig(
  svm: LiteSVM,
  changes: {
    admin?: Address;
    guardian?: Address;
    cashMint?: Address;
    routerProgram?: Address;
    publishDelayS?: number;
    defaultKeeper?: Address;
    keeperPaused?: boolean;
  },
  at?: Address,
): Promise<void> {
  const real = svm.getAccount(await configAddress());
  if (!real.exists) throw new Error('initialise Config before changing its bytes');
  const data = new Uint8Array(real.data);
  if (changes.admin) data.set(addressEncoder.encode(changes.admin), 8);
  if (changes.guardian) data.set(addressEncoder.encode(changes.guardian), 72);
  if (changes.defaultKeeper) data.set(addressEncoder.encode(changes.defaultKeeper), 104);
  if (changes.routerProgram) data.set(addressEncoder.encode(changes.routerProgram), 136);
  if (changes.keeperPaused !== undefined) data[232] = changes.keeperPaused ? 1 : 0;
  if (changes.cashMint) data.set(addressEncoder.encode(changes.cashMint), 200);
  if (changes.publishDelayS !== undefined)
    new DataView(data.buffer).setUint32(248, changes.publishDelayS, true);
  svm.setAccount({ ...real, address: at ?? real.address, data });
}

// ---- the asset list ----

/** Accounts: admin (signer, pays), config, assets, system program. */
export async function initAssetsInstruction(
  admin: TransactionSigner,
  overrides: { config?: Address; assets?: Address } = {},
): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      writableSigner(admin),
      readonly(overrides.config ?? (await configAddress())),
      writable(overrides.assets ?? (await assetsAddress())),
      readonly(SYSTEM_PROGRAM),
    ],
    data: discriminator('init_assets'),
  };
}

export type AssetArgs = {
  priceSlot: number;
  priceIndex: number;
  twapIndex: number;
  priceKind: number;
  session: number;
  maxWeightBps: number;
  flags: number;
  sourceCheck: Uint8Array;
  /** The plausible price range, in millionths of a dollar for one whole token. */
  minPrice: bigint;
  maxPrice: bigint;
};

/** An entry with no price reference and the widest ceiling: what a test lists unless it says otherwise. */
export const DEFAULT_ASSET: AssetArgs = {
  priceSlot: 0,
  priceIndex: 0,
  twapIndex: 0,
  priceKind: 0,
  session: 0,
  maxWeightBps: 5_000,
  flags: 0,
  sourceCheck: new Uint8Array(32),
  minPrice: 0n,
  maxPrice: 0n,
};

const assetArgsEncoder = getStructEncoder([
  ['priceSlot', getU8Encoder()],
  ['priceIndex', getU16Encoder()],
  ['twapIndex', getU16Encoder()],
  ['priceKind', getU8Encoder()],
  ['session', getU8Encoder()],
  ['maxWeightBps', getU16Encoder()],
  ['flags', getU8Encoder()],
  ['sourceCheck', fixEncoderSize(getBytesEncoder(), 32)],
  ['minPrice', u64],
  ['maxPrice', u64],
]);

/** Accounts: admin (signer), config, assets, the mint. */
export async function upsertAssetInstruction(
  admin: TransactionSigner,
  mint: Address,
  args: Partial<AssetArgs> = {},
  overrides: { config?: Address; assets?: Address } = {},
): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      signer(admin),
      readonly(overrides.config ?? (await configAddress())),
      writable(overrides.assets ?? (await assetsAddress())),
      readonly(mint),
    ],
    data: concat(
      discriminator('upsert_asset'),
      assetArgsEncoder.encode({ ...DEFAULT_ASSET, ...args }),
    ),
  };
}

/** Lists each mint with the default entry, a few per transaction. */
export async function listAssets(
  svm: LiteSVM,
  admin: TransactionSigner,
  mints: Address[],
  args: Partial<AssetArgs> = {},
): Promise<void> {
  for (let i = 0; i < mints.length; i += 8) {
    const batch = mints.slice(i, i + 8);
    expectOk(
      await send(
        svm,
        admin,
        await Promise.all(batch.map((mint) => upsertAssetInstruction(admin, mint, args))),
      ),
    );
  }
}

/** Accounts: admin (signer), config, assets, the price account. */
export async function setPriceAccountInstruction(
  admin: TransactionSigner,
  slot: number,
  priceAccount: Address,
  overrides: { config?: Address; assets?: Address } = {},
): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      signer(admin),
      readonly(overrides.config ?? (await configAddress())),
      writable(overrides.assets ?? (await assetsAddress())),
      readonly(priceAccount),
    ],
    data: concat(discriminator('set_price_account'), getU8Encoder().encode(slot)),
  };
}

/** Config, the empty asset list, and then each mint listed: what most tests start from. */
export async function initPlatform(
  svm: LiteSVM,
  deployer: TransactionSigner,
  args: Partial<InitConfigArgs> & { cashMint: Address },
  listed: Address[] = [],
): Promise<void> {
  expectOk(await initConfig(svm, deployer, args));
  expectOk(await send(svm, deployer, [await initAssetsInstruction(deployer)]));
  await listAssets(svm, deployer, listed);
}

// ---- shared portfolios ----

const componentsEncoder = getArrayEncoder(
  getStructEncoder([
    ['mint', addressEncoder],
    ['weightBps', getU16Encoder()],
  ]),
);
const hash32 = fixEncoderSize(getBytesEncoder(), 32);

/** Accounts: creator (signer, pays), recipe, config, assets, system program. */
export async function publishRecipeInstruction(input: {
  creator: TransactionSigner;
  familyId: Uint8Array;
  components: Component[];
  metaHash?: Uint8Array;
  maxFeeBps?: number;
  flags?: number;
  recipe?: Address;
  config?: Address;
  assets?: Address;
}): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      writableSigner(input.creator),
      writable(input.recipe ?? (await recipeAddress(input.creator.address, input.familyId))),
      readonly(input.config ?? (await configAddress())),
      readonly(input.assets ?? (await assetsAddress())),
      readonly(SYSTEM_PROGRAM),
    ],
    data: concat(
      discriminator('publish_recipe'),
      hash32.encode(input.familyId),
      componentsEncoder.encode(input.components),
      hash32.encode(input.metaHash ?? new Uint8Array(32)),
      getU16Encoder().encode(input.maxFeeBps ?? 0),
      getU8Encoder().encode(input.flags ?? 0),
    ),
  };
}

/** Accounts: creator (signer), recipe, config, assets. */
export async function updateRecipeInstruction(input: {
  creator: TransactionSigner;
  recipe: Address;
  components: Component[];
  metaHash?: Uint8Array;
  config?: Address;
  assets?: Address;
}): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      signer(input.creator),
      writable(input.recipe),
      readonly(input.config ?? (await configAddress())),
      readonly(input.assets ?? (await assetsAddress())),
    ],
    data: concat(
      discriminator('update_recipe'),
      componentsEncoder.encode(input.components),
      hash32.encode(input.metaHash ?? new Uint8Array(32)),
    ),
  };
}

/** Accounts: the creator or the guardian (signer), recipe, config. */
export async function cancelPendingInstruction(input: {
  signer: TransactionSigner;
  recipe: Address;
  config?: Address;
}): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      signer(input.signer),
      writable(input.recipe),
      readonly(input.config ?? (await configAddress())),
    ],
    data: discriminator('cancel_pending'),
  };
}

/** The payload of a `RecipePublished` event. */
export function decodeRecipePublished(payload: Uint8Array) {
  return getStructDecoder([
    ['recipe', getAddressDecoder()],
    ['version', getU32Decoder()],
    ['creator', getAddressDecoder()],
    ['components', getArrayDecoder(componentDecoder)],
    ['effectiveAt', getI64Decoder()],
    ['turnoverBps', getU16Decoder()],
    ['metaHash', bytes32],
  ]).decode(payload);
}

/** The rule a refused publish broke, as the program logged it; null when it logged none. */
export function limitReason(logs: string[]): number | null {
  const line = logs.find((l) => l.includes('creator limit: reason='));
  const match = line?.match(/reason=(\d+)/);
  return match?.[1] ? Number(match[1]) : null;
}

// ---- vaults ----

export type Target = { mint: Address; targetBps: number };

const targetsEncoder = getArrayEncoder(
  getStructEncoder([
    ['mint', addressEncoder],
    ['targetBps', getU16Encoder()],
  ]),
);

const createVaultArgsEncoder = getStructEncoder([
  ['basketId', u64],
  ['targets', targetsEncoder],
  ['autoFollow', getBooleanEncoder()],
  ['expectedVersion', getU32Encoder()],
]);

/** Accounts: owner (signer, pays), vault, config, assets, the shared portfolio to follow (the
 * program's own id when there is none), system program. */
export async function createVaultInstruction(input: {
  owner: TransactionSigner;
  basketId: bigint;
  targets?: Target[];
  autoFollow?: boolean;
  expectedVersion?: number;
  /** The shared portfolio the vault follows. */
  recipe?: Address;
  /** For hostile tests: a vault address other than the one derived from this owner. */
  vault?: Address;
  config?: Address;
  assets?: Address;
}): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      writableSigner(input.owner),
      writable(input.vault ?? (await vaultAddress(input.owner.address, input.basketId))),
      readonly(input.config ?? (await configAddress())),
      readonly(input.assets ?? (await assetsAddress())),
      readonly(input.recipe ?? BASKET_PROGRAM),
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

/** Accounts: owner (signer), vault, config, assets. */
export async function setTargetsInstruction(input: {
  owner: TransactionSigner;
  vault: Address;
  targets: Target[];
  config?: Address;
  assets?: Address;
}): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      signer(input.owner),
      writable(input.vault),
      readonly(input.config ?? (await configAddress())),
      readonly(input.assets ?? (await assetsAddress())),
    ],
    data: concat(discriminator('set_targets'), targetsEncoder.encode(input.targets)),
  };
}

/** A router's instruction as the vault forwards it: its program, its bytes, and its accounts
 * with every signature taken off, since the vault program signs for the vault itself. */
export function forwarded(route: Instruction): {
  router: Address;
  data: Uint8Array;
  routerAccounts: AccountMeta[];
} {
  return {
    router: route.programAddress,
    data: new Uint8Array(route.data ?? []),
    routerAccounts: (route.accounts ?? []).map((a) => ({
      address: a.address,
      role: isWritableRole(a.role) ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
  };
}

const bytesWithLength = addEncoderSizePrefix(getBytesEncoder(), getU32Encoder());

/** Accounts: owner (signer), vault, config, assets, the input mint, the output mint, the
 * vault's token account for each, the token program of each, the router, then the router's
 * own accounts in its order. */
export async function ownerSwapInstruction(input: {
  owner: TransactionSigner;
  vault: Address;
  inputMint: TestMint;
  outputMint: TestMint;
  maxIn: bigint;
  minOut: bigint;
  router: Address;
  data: Uint8Array;
  routerAccounts: AccountMeta[];
  vaultInput?: Address;
  vaultOutput?: Address;
  config?: Address;
  assets?: Address;
}): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      signer(input.owner),
      writable(input.vault),
      readonly(input.config ?? (await configAddress())),
      readonly(input.assets ?? (await assetsAddress())),
      readonly(input.inputMint.address),
      readonly(input.outputMint.address),
      writable(input.vaultInput ?? (await ata(input.vault, input.inputMint))),
      writable(input.vaultOutput ?? (await ata(input.vault, input.outputMint))),
      readonly(input.inputMint.program),
      readonly(input.outputMint.program),
      readonly(input.router),
      ...input.routerAccounts,
    ],
    data: concat(
      discriminator('owner_swap'),
      u64.encode(input.maxIn),
      u64.encode(input.minOut),
      bytesWithLength.encode(input.data),
    ),
  };
}

/** Accounts: owner (signer), vault, config, mint (the cash mint), the vault's token account,
 * the source token account, the mint's token program, then any extra accounts for a hook. */
export async function depositInstruction(input: {
  owner: TransactionSigner;
  vault: Address;
  mint: TestMint;
  amount: bigint;
  source?: Address;
  vaultTokenAccount?: Address;
  config?: Address;
  extraAccounts?: AccountMeta[];
}): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      signer(input.owner),
      readonly(input.vault),
      readonly(input.config ?? (await configAddress())),
      readonly(input.mint.address),
      writable(input.vaultTokenAccount ?? (await ata(input.vault, input.mint))),
      writable(input.source ?? (await ata(input.owner.address, input.mint))),
      readonly(input.mint.program),
      ...(input.extraAccounts ?? []),
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

// ---- following, and the keeper ----

/** Accounts: owner (signer), vault, the shared portfolio. */
export async function acceptVersionInstruction(input: {
  owner: TransactionSigner;
  vault: Address;
  recipe: Address;
  expectedVersion: number;
}): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [signer(input.owner), writable(input.vault), readonly(input.recipe)],
    data: concat(discriminator('accept_version'), getU32Encoder().encode(input.expectedVersion)),
  };
}

/** Accounts: owner (signer), vault. */
export async function setAutoFollowInstruction(input: {
  owner: TransactionSigner;
  vault: Address;
  on: boolean;
}): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [signer(input.owner), writable(input.vault)],
    data: concat(discriminator('set_auto_follow'), getBooleanEncoder().encode(input.on)),
  };
}

/** Nobody signs. Accounts: vault, the shared portfolio it follows, config. */
export async function adoptVersionInstruction(input: {
  vault: Address;
  recipe: Address;
  config?: Address;
}): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      writable(input.vault),
      readonly(input.recipe),
      readonly(input.config ?? (await configAddress())),
    ],
    data: discriminator('adopt_version'),
  };
}

/** Accounts: the vault's owner or its keeper (signer), vault, config, then the vault's own token
 * accounts to read. */
export async function syncBalancesInstruction(input: {
  signer: TransactionSigner;
  vault: Address;
  tokenAccounts: Address[];
  config?: Address;
}): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      signer(input.signer),
      writable(input.vault),
      readonly(input.config ?? (await configAddress())),
      ...input.tokenAccounts.map(readonly),
    ],
    data: discriminator('sync_balances'),
  };
}

/** Accounts: keeper (signer), vault, config, assets, the input mint, the output mint, the
 * vault's token account for each, the token program of each, the router, the price account,
 * then the router's own accounts in its order. */
export async function keeperLegInstruction(input: {
  keeper: TransactionSigner;
  vault: Address;
  inputMint: TestMint;
  outputMint: TestMint;
  amountIn: bigint;
  router: Address;
  data: Uint8Array;
  routerAccounts: AccountMeta[];
  priceAccount: Address;
  vaultInput?: Address;
  vaultOutput?: Address;
  config?: Address;
  assets?: Address;
}): Promise<Instruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      signer(input.keeper),
      writable(input.vault),
      readonly(input.config ?? (await configAddress())),
      readonly(input.assets ?? (await assetsAddress())),
      readonly(input.inputMint.address),
      readonly(input.outputMint.address),
      writable(input.vaultInput ?? (await ata(input.vault, input.inputMint))),
      writable(input.vaultOutput ?? (await ata(input.vault, input.outputMint))),
      readonly(input.inputMint.program),
      readonly(input.outputMint.program),
      readonly(input.router),
      readonly(input.priceAccount),
      ...input.routerAccounts,
    ],
    data: concat(
      discriminator('keeper_leg'),
      u64.encode(input.amountIn),
      bytesWithLength.encode(input.data),
    ),
  };
}

/** The payload of a `KeeperTrade` event. */
export function decodeKeeperTrade(payload: Uint8Array) {
  return getStructDecoder([
    ['vault', getAddressDecoder()],
    ['mintIn', getAddressDecoder()],
    ['mintOut', getAddressDecoder()],
    ['spent', getU64Decoder()],
    ['received', getU64Decoder()],
    ['loss', getU64Decoder()],
    ['lossUsedBps', getU16Decoder()],
  ]).decode(payload);
}

/** The payload of a `Followed` or a `VersionAdopted` event: vault, portfolio, version. */
export function decodeVersionEvent(payload: Uint8Array) {
  return getStructDecoder([
    ['vault', getAddressDecoder()],
    ['recipe', getAddressDecoder()],
    ['version', getU32Decoder()],
  ]).decode(payload);
}

/** Rewrites bytes of a vault. Only a test can: no instruction sets a vault's own keeper yet,
 * and `tracked` only moves when the program moves the tokens. */
export function patchVault(
  svm: LiteSVM,
  vault: Address,
  changes: {
    keeper?: Address;
    tracked?: { mint: Address; amount: bigint };
    lossAccum?: bigint;
    lossTs?: bigint;
  },
): void {
  const account = svm.getAccount(vault);
  if (!account.exists) throw new Error(`no vault at ${vault}`);
  const data = new Uint8Array(account.data);
  const view = new DataView(data.buffer);
  // owner 8, recipe 40, accepted_version 72, auto_follow 76, basket_id 77, bump 85,
  // keeper 86, count 118, positions 119 (50 bytes each), loss_accum 919, loss_ts 927.
  if (changes.keeper) data.set(addressEncoder.encode(changes.keeper), 86);
  if (changes.tracked) {
    const state = vaultDecoder.decode(data);
    const index = state.positions
      .slice(0, state.count)
      .findIndex((p) => p.mint === changes.tracked?.mint);
    if (index < 0) throw new Error('the mint is not one of the positions');
    view.setBigUint64(119 + 50 * index + 34, changes.tracked.amount, true);
  }
  if (changes.lossAccum !== undefined) view.setBigUint64(919, changes.lossAccum, true);
  if (changes.lossTs !== undefined) view.setBigInt64(927, changes.lossTs, true);
  svm.setAccount({ ...account, data });
}
