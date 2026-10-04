import { createHash } from 'node:crypto';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  assetsAddress,
  associatedTokenAddress,
  configAddress,
  createTokenAccountInstruction,
  exchangeAddress,
  pairAddress,
  SCOPE_ENTRY_BYTES,
  SCOPE_HEADER_BYTES,
  SCOPE_PRICES_BYTES,
  SCOPE_PRICES_DISCRIMINATOR,
} from '@colosseum/chain-solana/vault';
import {
  AccountRole,
  type Address,
  getAddressEncoder,
  type IAccountMeta,
  type IInstruction,
} from '@solana/kit';
import { BASKET_PROGRAM, MOCK_ROUTER_PROGRAM, programDataAddress } from './svm-node';

// What only an admin, an issuer or a test exchange's owner does, for the tests that set a chain up: the
// platform's Config and asset list, mints, and the test exchange's pairs. Written by hand from the
// interface files, as the program tests write them with their own kit. The adapter builds none of it.

export const SYSTEM_PROGRAM = '11111111111111111111111111111111' as Address;
const enc = getAddressEncoder();

const ro = (address: Address): IAccountMeta => ({ address, role: AccountRole.READONLY });
const w = (address: Address): IAccountMeta => ({ address, role: AccountRole.WRITABLE });
const s = (address: Address): IAccountMeta => ({ address, role: AccountRole.READONLY_SIGNER });
const ws = (address: Address): IAccountMeta => ({ address, role: AccountRole.WRITABLE_SIGNER });

const anchor = (name: string) =>
  new Uint8Array(createHash('sha256').update(`global:${name}`).digest().subarray(0, 8));

class Bytes {
  private parts: number[] = [];
  raw(bytes: ArrayLike<number>) {
    this.parts.push(...Array.from(bytes));
    return this;
  }
  u8(n: number) {
    return this.raw([n & 0xff]);
  }
  u16(n: number) {
    return this.raw([n & 0xff, (n >> 8) & 0xff]);
  }
  u32(n: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return this.raw(b);
  }
  u64(n: bigint) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return this.raw(b);
  }
  key(a: Address) {
    return this.raw(enc.encode(a));
  }
  done() {
    return new Uint8Array(this.parts);
  }
}

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

export async function initConfig(a: {
  authority: Address;
  guardian: Address;
  keeper: Address;
  router: Address;
  priceOwner: Address;
  cashMint: Address;
  params: Params;
}): Promise<IInstruction> {
  const p = a.params;
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      ws(a.authority),
      w(await configAddress(BASKET_PROGRAM)),
      ro(a.cashMint),
      ro(BASKET_PROGRAM),
      ro(await programDataAddress(BASKET_PROGRAM)),
      ro(SYSTEM_PROGRAM),
    ],
    data: new Bytes()
      .raw(anchor('init_config'))
      .key(a.guardian)
      .key(a.keeper)
      .key(a.router)
      .key(a.priceOwner)
      .u16(p.toleranceBps)
      .u16(p.lossCapBps)
      .u16(p.bandBps)
      .u16(p.twapDevBps)
      .u16(p.maxPriceAgeS)
      .u32(p.assetCooldownS)
      .u32(p.publishDelayS)
      .u32(p.sessionOpenUtcS)
      .u32(p.sessionCloseUtcS)
      .done(),
  };
}

export async function initAssets(admin: Address): Promise<IInstruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      ws(admin),
      ro(await configAddress(BASKET_PROGRAM)),
      w(await assetsAddress(BASKET_PROGRAM)),
      ro(SYSTEM_PROGRAM),
    ],
    data: anchor('init_assets'),
  };
}

export async function setPriceAccount(
  admin: Address,
  slot: number,
  account: Address,
): Promise<IInstruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      s(admin),
      ro(await configAddress(BASKET_PROGRAM)),
      w(await assetsAddress(BASKET_PROGRAM)),
      ro(account),
    ],
    data: new Bytes().raw(anchor('set_price_account')).u8(slot).done(),
  };
}

export async function upsertAsset(
  admin: Address,
  mint: Address,
  a: {
    priceIndex: number;
    twapIndex: number;
    keeperOn: boolean;
    /** Millionths of a dollar for one whole token. */
    minPrice: bigint;
    maxPrice: bigint;
    maxWeightBps?: number;
    session?: 0 | 1;
  },
): Promise<IInstruction> {
  return {
    programAddress: BASKET_PROGRAM,
    accounts: [
      s(admin),
      ro(await configAddress(BASKET_PROGRAM)),
      w(await assetsAddress(BASKET_PROGRAM)),
      ro(mint),
    ],
    data: new Bytes()
      .raw(anchor('upsert_asset'))
      .u8(0) // price slot
      .u16(a.priceIndex)
      .u16(a.twapIndex)
      .u8(1) // price kind: scope
      .u8(a.session ?? 0)
      .u16(a.maxWeightBps ?? 5_000)
      .u8(a.keeperOn ? 1 : 0)
      .raw(new Uint8Array(32)) // source check: off
      .u64(a.minPrice)
      .u64(a.maxPrice)
      .done(),
  };
}

// ---- the test exchange ----

export async function initRouter(admin: Address): Promise<IInstruction> {
  return {
    programAddress: MOCK_ROUTER_PROGRAM,
    accounts: [
      ws(admin),
      w(await exchangeAddress(MOCK_ROUTER_PROGRAM)),
      ro(MOCK_ROUTER_PROGRAM),
      ro(await programDataAddress(MOCK_ROUTER_PROGRAM)),
      ro(SYSTEM_PROGRAM),
    ],
    data: anchor('init_router'),
  };
}

export async function initPair(
  admin: Address,
  mintIn: Address,
  mintOut: Address,
  num: bigint,
  den: bigint,
): Promise<IInstruction> {
  return {
    programAddress: MOCK_ROUTER_PROGRAM,
    accounts: [
      ws(admin),
      ro(await exchangeAddress(MOCK_ROUTER_PROGRAM)),
      ro(mintIn),
      ro(mintOut),
      w(await pairAddress(MOCK_ROUTER_PROGRAM, mintIn, mintOut)),
      ro(SYSTEM_PROGRAM),
    ],
    data: new Bytes().raw(anchor('init_pair')).u64(num).u64(den).done(),
  };
}

export async function setPairPrice(
  admin: Address,
  mintIn: Address,
  mintOut: Address,
  num: bigint,
  den: bigint,
): Promise<IInstruction> {
  return {
    programAddress: MOCK_ROUTER_PROGRAM,
    accounts: [
      s(admin),
      ro(await exchangeAddress(MOCK_ROUTER_PROGRAM)),
      w(await pairAddress(MOCK_ROUTER_PROGRAM, mintIn, mintOut)),
    ],
    data: new Bytes().raw(anchor('set_price')).u64(num).u64(den).done(),
  };
}

// ---- mints and SOL ----

export const MINT_BYTES = 82n;

export function createAccount(a: {
  payer: Address;
  account: Address;
  lamports: bigint;
  space: bigint;
  owner: Address;
}): IInstruction {
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [ws(a.payer), ws(a.account)],
    data: new Bytes().u32(0).u64(a.lamports).u64(a.space).key(a.owner).done(),
  };
}

export function transferSol(from: Address, to: Address, lamports: bigint): IInstruction {
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [ws(from), w(to)],
    data: new Bytes().u32(2).u64(lamports).done(),
  };
}

/** InitializeMint2: the same layout under both token programs. */
export function initMint(a: {
  mint: Address;
  tokenProgram: Address;
  decimals: number;
  authority: Address;
}): IInstruction {
  return {
    programAddress: a.tokenProgram,
    accounts: [w(a.mint)],
    data: new Bytes().u8(20).u8(a.decimals).key(a.authority).u8(1).key(a.authority).done(),
  };
}

export async function mintTo(a: {
  mint: Address;
  tokenProgram: Address;
  holder: Address;
  authority: Address;
  amount: bigint;
}): Promise<IInstruction[]> {
  const account = await associatedTokenAddress(a.holder, a.mint, a.tokenProgram);
  return [
    createTokenAccountInstruction({
      payer: a.authority,
      account,
      holder: a.holder,
      token: { mint: a.mint, tokenProgram: a.tokenProgram },
    }),
    {
      programAddress: a.tokenProgram,
      accounts: [w(a.mint), w(account), s(a.authority)],
      data: new Bytes().u8(7).u64(a.amount).done(),
    },
  ];
}

// ---- the price account ----

export type PriceEntry = { index: number; twapIndex: number; value: bigint; exponent: bigint };

/** A price account in Scope's layout, every entry and its average stamped at `at` (unix seconds). */
export function priceAccountBytes(entries: PriceEntry[], at: bigint, slot: bigint): Uint8Array {
  const data = new Uint8Array(SCOPE_PRICES_BYTES);
  data.set(SCOPE_PRICES_DISCRIMINATOR, 0);
  data.set(enc.encode(MOCK_ROUTER_PROGRAM), 8);
  const view = new DataView(data.buffer);
  for (const e of entries)
    for (const index of [e.index, e.twapIndex]) {
      const off = SCOPE_HEADER_BYTES + SCOPE_ENTRY_BYTES * index;
      view.setBigUint64(off, e.value, true);
      view.setBigUint64(off + 8, e.exponent, true);
      view.setBigUint64(off + 16, slot, true);
      view.setBigUint64(off + 24, at, true);
    }
  return data;
}

export { ASSOCIATED_TOKEN_PROGRAM };

/** FreezeAccount: the issuer freezes a holder's token account. */
export function freezeAccount(a: {
  account: Address;
  mint: Address;
  tokenProgram: Address;
  authority: Address;
}): IInstruction {
  return {
    programAddress: a.tokenProgram,
    accounts: [w(a.account), ro(a.mint), s(a.authority)],
    data: new Uint8Array([10]),
  };
}
