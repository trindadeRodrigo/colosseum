import {
  AccountRole,
  type Address,
  addEncoderSizePrefix,
  fixEncoderSize,
  getAddressEncoder,
  getArrayEncoder,
  getBooleanEncoder,
  getBytesEncoder,
  getStructEncoder,
  getU8Encoder,
  getU16Encoder,
  getU32Encoder,
  getU64Encoder,
  type IAccountMeta,
  type IInstruction,
} from '@solana/kit';
import { ASSOCIATED_TOKEN_PROGRAM } from './tokens';

// The instructions of programs/basket, written by hand as idl/basket.json lays them out (DESIGN-VAULT
// 3.7): Anchor's 8-byte discriminator, then the arguments in Borsh. Accounts are in the order the
// interface lists them; an optional account that is left out is passed as the program's own id, which
// is how Anchor reads "none". A test decodes every instruction built here against the interface file.

export const SYSTEM_PROGRAM = '11111111111111111111111111111111' as Address;
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111' as Address;

/** sha256("global:<name>")[0..8], as idl/basket.json lists them. */
export const BASKET_DISCRIMINATORS = {
  accept_version: [215, 87, 246, 194, 63, 68, 225, 179],
  adopt_version: [213, 117, 253, 10, 21, 238, 139, 217],
  cancel_pending: [74, 87, 109, 242, 64, 192, 151, 71],
  create_vault: [29, 237, 247, 208, 193, 82, 54, 135],
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  keeper_leg: [46, 178, 18, 83, 188, 146, 82, 217],
  owner_swap: [12, 59, 193, 156, 47, 162, 240, 108],
  publish_recipe: [209, 229, 198, 141, 172, 92, 229, 96],
  set_auto_follow: [255, 29, 5, 116, 253, 61, 227, 189],
  set_targets: [28, 232, 16, 206, 7, 118, 12, 122],
  sync_balances: [148, 188, 122, 63, 81, 90, 11, 85],
  update_recipe: [79, 118, 143, 237, 68, 36, 242, 15],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
} as const;
export type BasketInstructionName = keyof typeof BASKET_DISCRIMINATORS;

const u64 = getU64Encoder();
const u32 = getU32Encoder();
const bool = getBooleanEncoder();
const bytes32 = fixEncoderSize(getBytesEncoder(), 32);
/** Borsh `Vec<u8>`: a u32 length, then the bytes. */
const bytesVec = addEncoderSizePrefix(getBytesEncoder(), u32);
const targetsEncoder = getArrayEncoder(
  getStructEncoder([
    ['mint', getAddressEncoder()],
    ['targetBps', getU16Encoder()],
  ]),
  { size: u32 },
);
const componentsEncoder = getArrayEncoder(
  getStructEncoder([
    ['mint', getAddressEncoder()],
    ['weightBps', getU16Encoder()],
  ]),
  { size: u32 },
);

export type TargetLine = { mint: Address; targetBps: number };
export type ComponentLine = { mint: Address; weightBps: number };

function data(name: BasketInstructionName, ...args: ArrayLike<number>[]): Uint8Array {
  const parts = [BASKET_DISCRIMINATORS[name], ...args];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const readonly = (address: Address): IAccountMeta => ({ address, role: AccountRole.READONLY });
const writable = (address: Address): IAccountMeta => ({ address, role: AccountRole.WRITABLE });
const signer = (address: Address): IAccountMeta => ({
  address,
  role: AccountRole.READONLY_SIGNER,
});
const payer = (address: Address): IAccountMeta => ({
  address,
  role: AccountRole.WRITABLE_SIGNER,
});

/** The program's fixed accounts, derived once per adapter. */
export type ProgramAccounts = { program: Address; config: Address; assets: Address };

/** A token's mint with the program that owns it: its token accounts live under the same program. */
export type TokenRef = { mint: Address; tokenProgram: Address };

export function createVaultInstruction(
  p: ProgramAccounts,
  a: {
    owner: Address;
    vault: Address;
    basketId: bigint;
    targets: TargetLine[];
    autoFollow: boolean;
    expectedVersion: number;
    /** The shared portfolio the vault follows; left out, it has targets of its own. */
    recipe?: Address;
  },
): IInstruction {
  return {
    programAddress: p.program,
    accounts: [
      payer(a.owner),
      writable(a.vault),
      readonly(p.config),
      readonly(p.assets),
      readonly(a.recipe ?? p.program),
      readonly(SYSTEM_PROGRAM),
    ],
    data: data(
      'create_vault',
      u64.encode(a.basketId),
      targetsEncoder.encode(a.targets),
      bool.encode(a.autoFollow),
      u32.encode(a.expectedVersion),
    ),
  };
}

export function depositInstruction(
  p: ProgramAccounts,
  a: {
    owner: Address;
    vault: Address;
    cash: TokenRef;
    vaultAccount: Address;
    source: Address;
    amount: bigint;
  },
): IInstruction {
  return {
    programAddress: p.program,
    accounts: [
      signer(a.owner),
      readonly(a.vault),
      readonly(p.config),
      readonly(a.cash.mint),
      writable(a.vaultAccount),
      writable(a.source),
      readonly(a.cash.tokenProgram),
    ],
    data: data('deposit', u64.encode(a.amount)),
  };
}

/** A router's instruction as the vault forwards it: its bytes, and its accounts with no signer among them. */
export type ForwardedRoute = {
  router: Address;
  data: Uint8Array;
  accounts: IAccountMeta[];
};

/** The accounts a swap or a keeper leg names before the router's own: the two sides, as the vault holds them. */
export type SwapSides = {
  input: TokenRef;
  output: TokenRef;
  vaultInput: Address;
  vaultOutput: Address;
};

function swapAccounts(
  p: ProgramAccounts,
  vault: Address,
  sides: SwapSides,
  router: Address,
): IAccountMeta[] {
  return [
    writable(vault),
    readonly(p.config),
    readonly(p.assets),
    readonly(sides.input.mint),
    readonly(sides.output.mint),
    writable(sides.vaultInput),
    writable(sides.vaultOutput),
    readonly(sides.input.tokenProgram),
    readonly(sides.output.tokenProgram),
    readonly(router),
  ];
}

/**
 * A router's accounts with every signer flag taken off. The vault signs for itself inside the call; a
 * signer the route asks for would otherwise have to sign the whole transaction.
 */
export function stripSigners(accounts: readonly IAccountMeta[]): IAccountMeta[] {
  return accounts.map((a) => ({
    address: a.address,
    role:
      a.role === AccountRole.WRITABLE_SIGNER || a.role === AccountRole.WRITABLE
        ? AccountRole.WRITABLE
        : AccountRole.READONLY,
  }));
}

export function ownerSwapInstruction(
  p: ProgramAccounts,
  a: {
    owner: Address;
    vault: Address;
    sides: SwapSides;
    maxIn: bigint;
    minOut: bigint;
    route: ForwardedRoute;
  },
): IInstruction {
  return {
    programAddress: p.program,
    accounts: [
      signer(a.owner),
      ...swapAccounts(p, a.vault, a.sides, a.route.router),
      ...stripSigners(a.route.accounts),
    ],
    data: data(
      'owner_swap',
      u64.encode(a.maxIn),
      u64.encode(a.minOut),
      bytesVec.encode(a.route.data),
    ),
  };
}

export function keeperLegInstruction(
  p: ProgramAccounts,
  a: {
    keeper: Address;
    vault: Address;
    sides: SwapSides;
    amountIn: bigint;
    priceAccount: Address;
    route: ForwardedRoute;
  },
): IInstruction {
  return {
    programAddress: p.program,
    accounts: [
      signer(a.keeper),
      ...swapAccounts(p, a.vault, a.sides, a.route.router),
      readonly(a.priceAccount),
      ...stripSigners(a.route.accounts),
    ],
    data: data('keeper_leg', u64.encode(a.amountIn), bytesVec.encode(a.route.data)),
  };
}

export function setTargetsInstruction(
  p: ProgramAccounts,
  a: { owner: Address; vault: Address; targets: TargetLine[] },
): IInstruction {
  return {
    programAddress: p.program,
    accounts: [signer(a.owner), writable(a.vault), readonly(p.config), readonly(p.assets)],
    data: data('set_targets', targetsEncoder.encode(a.targets)),
  };
}

export function withdrawInstruction(
  p: ProgramAccounts,
  a: {
    owner: Address;
    vault: Address;
    token: TokenRef;
    vaultAccount: Address;
    destination: Address;
    amount: bigint;
  },
): IInstruction {
  return {
    programAddress: p.program,
    accounts: [
      signer(a.owner),
      writable(a.vault),
      readonly(a.token.mint),
      writable(a.vaultAccount),
      writable(a.destination),
      readonly(a.token.tokenProgram),
    ],
    data: data('withdraw', u64.encode(a.amount)),
  };
}

export function acceptVersionInstruction(
  p: ProgramAccounts,
  a: { owner: Address; vault: Address; recipe: Address; expectedVersion: number },
): IInstruction {
  return {
    programAddress: p.program,
    accounts: [signer(a.owner), writable(a.vault), readonly(a.recipe)],
    data: data('accept_version', u32.encode(a.expectedVersion)),
  };
}

export function setAutoFollowInstruction(
  p: ProgramAccounts,
  a: { owner: Address; vault: Address; on: boolean },
): IInstruction {
  return {
    programAddress: p.program,
    accounts: [signer(a.owner), writable(a.vault)],
    data: data('set_auto_follow', bool.encode(a.on)),
  };
}

export function publishRecipeInstruction(
  p: ProgramAccounts,
  a: {
    creator: Address;
    recipe: Address;
    familyId: Uint8Array;
    components: ComponentLine[];
    metaHash: Uint8Array;
  },
): IInstruction {
  return {
    programAddress: p.program,
    accounts: [
      payer(a.creator),
      writable(a.recipe),
      readonly(p.config),
      readonly(p.assets),
      readonly(SYSTEM_PROGRAM),
    ],
    data: data(
      'publish_recipe',
      bytes32.encode(a.familyId),
      componentsEncoder.encode(a.components),
      bytes32.encode(a.metaHash),
      // The fee and the flags: the program takes zero and nothing else (DESIGN-VAULT section 6).
      getU16Encoder().encode(0),
      getU8Encoder().encode(0),
    ),
  };
}

export function updateRecipeInstruction(
  p: ProgramAccounts,
  a: { creator: Address; recipe: Address; components: ComponentLine[]; metaHash: Uint8Array },
): IInstruction {
  return {
    programAddress: p.program,
    accounts: [signer(a.creator), writable(a.recipe), readonly(p.config), readonly(p.assets)],
    data: data('update_recipe', componentsEncoder.encode(a.components), bytes32.encode(a.metaHash)),
  };
}

/** Signed by the portfolio's creator, or by the guardian as a veto. */
export function cancelPendingInstruction(
  p: ProgramAccounts,
  a: { signer: Address; recipe: Address },
): IInstruction {
  return {
    programAddress: p.program,
    accounts: [signer(a.signer), writable(a.recipe), readonly(p.config)],
    data: data('cancel_pending'),
  };
}

/** Anyone may send it; whoever pays is the fee payer, and the instruction itself names no signer. */
export function adoptVersionInstruction(
  p: ProgramAccounts,
  a: { vault: Address; recipe: Address },
): IInstruction {
  return {
    programAddress: p.program,
    accounts: [writable(a.vault), readonly(a.recipe), readonly(p.config)],
    data: data('adopt_version'),
  };
}

/** Signed by the vault's owner or its keeper. `accounts` are the vault's own token accounts to read. */
export function syncBalancesInstruction(
  p: ProgramAccounts,
  a: { signer: Address; vault: Address; accounts: Address[] },
): IInstruction {
  return {
    programAddress: p.program,
    accounts: [
      signer(a.signer),
      writable(a.vault),
      readonly(p.config),
      ...a.accounts.map(readonly),
    ],
    data: data('sync_balances'),
  };
}

/** "Create the associated token account if it is missing", paid by `payer`. */
export function createTokenAccountInstruction(a: {
  payer: Address;
  account: Address;
  holder: Address;
  token: TokenRef;
}): IInstruction {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    accounts: [
      payer(a.payer),
      writable(a.account),
      readonly(a.holder),
      readonly(a.token.mint),
      readonly(SYSTEM_PROGRAM),
      readonly(a.token.tokenProgram),
    ],
    data: new Uint8Array([1]),
  };
}

/** The most compute units a transaction may ask for. */
export const MAX_COMPUTE_UNITS = 1_400_000;

export function computeUnitLimitInstruction(units: number): IInstruction {
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    data: new Uint8Array([2, ...u32.encode(units)]),
  };
}

/** The price of a compute unit, in millionths of a lamport. */
export function computeUnitPriceInstruction(microLamports: bigint): IInstruction {
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    data: new Uint8Array([3, ...u64.encode(microLamports)]),
  };
}
