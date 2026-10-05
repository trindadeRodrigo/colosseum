import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acceptVersionInstruction,
  adoptVersionInstruction,
  BASKET_DISCRIMINATORS,
  cancelPendingInstruction,
  createTokenAccountInstruction,
  createVaultInstruction,
  depositInstruction,
  keeperLegInstruction,
  ownerSwapInstruction,
  type ProgramAccounts,
  publishRecipeInstruction,
  ROUTE_SELECTORS,
  routeSelector,
  setAutoFollowInstruction,
  setTargetsInstruction,
  stripSigners,
  syncBalancesInstruction,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  updateRecipeInstruction,
  withdrawInstruction,
} from '@colosseum/chain-solana/vault';
import {
  AccountRole,
  type Address,
  getAddressDecoder,
  type IInstruction,
  isSignerRole,
  isWritableRole,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './world';

// Every instruction the builders write, decoded against the committed interface file
// (DESIGN-VAULT 3.7: "a test decodes every built instruction against the IDL"): the discriminator, the
// accounts in the interface's order with its signer and writable flags, and the arguments read back
// field by field with the interface's own types. Nothing here knows the layouts but the file.

type IdlType =
  | string
  | { array: [IdlType, number] }
  | { vec: IdlType }
  | { defined: { name: string } }
  | { option: IdlType };
type IdlInstruction = {
  name: string;
  discriminator: number[];
  accounts: {
    name: string;
    writable?: boolean;
    signer?: boolean;
    optional?: boolean;
    address?: string;
  }[];
  args: { name: string; type: IdlType }[];
};
type Idl = {
  address: string;
  instructions: IdlInstruction[];
  types: { name: string; type: { kind: string; fields: { name: string; type: IdlType }[] } }[];
};
const idl: Idl = JSON.parse(readFileSync(join(REPO_ROOT, 'idl', 'basket.json'), 'utf8'));
const addressDecoder = getAddressDecoder();

/** Reads one value of an interface type from `data` at `at`: Borsh, as Anchor writes it. */
function read(type: IdlType, data: Uint8Array, at: number): [unknown, number] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (typeof type === 'string') {
    switch (type) {
      case 'u8':
        return [view.getUint8(at), at + 1];
      case 'bool': {
        const byte = view.getUint8(at);
        if (byte > 1) throw new Error(`a bool holds ${byte}`);
        return [byte === 1, at + 1];
      }
      case 'u16':
        return [view.getUint16(at, true), at + 2];
      case 'u32':
        return [view.getUint32(at, true), at + 4];
      case 'u64':
        return [view.getBigUint64(at, true), at + 8];
      case 'i64':
        return [view.getBigInt64(at, true), at + 8];
      case 'pubkey':
        return [addressDecoder.decode(data.subarray(at, at + 32)), at + 32];
      case 'bytes': {
        const length = view.getUint32(at, true);
        return [data.slice(at + 4, at + 4 + length), at + 4 + length];
      }
      default:
        throw new Error(`no reader for ${type}`);
    }
  }
  if ('array' in type) {
    const [inner, size] = type.array;
    const out: unknown[] = [];
    let next = at;
    for (let i = 0; i < size; i++) {
      const [value, after] = read(inner, data, next);
      out.push(value);
      next = after;
    }
    return [out, next];
  }
  if ('vec' in type) {
    const length = view.getUint32(at, true);
    const out: unknown[] = [];
    let next = at + 4;
    for (let i = 0; i < length; i++) {
      const [value, after] = read(type.vec, data, next);
      out.push(value);
      next = after;
    }
    return [out, next];
  }
  if ('defined' in type) {
    const def = idl.types.find((t) => t.name === type.defined.name);
    if (!def) throw new Error(`the interface has no type ${type.defined.name}`);
    const out: Record<string, unknown> = {};
    let next = at;
    for (const field of def.type.fields) {
      const [value, after] = read(field.type, data, next);
      out[field.name] = value;
      next = after;
    }
    return [out, next];
  }
  throw new Error('an option is not used by any instruction the builders write');
}

/** The instruction as the interface reads it: its name, its arguments, and every byte used. */
function decode(ix: IInstruction) {
  const data = new Uint8Array(ix.data ?? []);
  const spec = idl.instructions.find((i) => i.discriminator.every((b, n) => data[n] === b));
  if (!spec) throw new Error('no instruction of the interface has this discriminator');
  const args: Record<string, unknown> = {};
  let at = 8;
  for (const arg of spec.args) {
    const [value, after] = read(arg.type, data, at);
    args[arg.name] = value;
    at = after;
  }
  expect(at, `${spec.name}: every byte is an argument`).toBe(data.length);
  const accounts = ix.accounts ?? [];
  expect(accounts.length, `${spec.name}: at least the accounts it names`).toBeGreaterThanOrEqual(
    spec.accounts.length,
  );
  spec.accounts.forEach((a, i) => {
    const meta = accounts[i];
    expect(isSignerRole(meta?.role ?? AccountRole.READONLY), `${spec.name}.${a.name} signer`).toBe(
      Boolean(a.signer),
    );
    expect(
      isWritableRole(meta?.role ?? AccountRole.READONLY),
      `${spec.name}.${a.name} writable`,
    ).toBe(Boolean(a.writable));
    if (a.address) expect(meta?.address, `${spec.name}.${a.name} fixed address`).toBe(a.address);
  });
  return {
    name: spec.name,
    args,
    accounts: Object.fromEntries(spec.accounts.map((a, i) => [a.name, accounts[i]?.address])),
    rest: accounts.slice(spec.accounts.length),
  };
}

const key = (n: number) => addressDecoder.decode(new Uint8Array(32).fill(n)) as Address;
const program = idl.address as Address;
const p: ProgramAccounts = { program, config: key(1), assets: key(2) };
const [owner, vault, recipe, mintA, mintB, accountA, accountB, wallet, keeper, prices, router] = [
  key(3),
  key(4),
  key(5),
  key(6),
  key(7),
  key(8),
  key(9),
  key(10),
  key(11),
  key(12),
  key(13),
];
const cash = { mint: mintA, tokenProgram: TOKEN_PROGRAM };
const stock = { mint: mintB, tokenProgram: TOKEN_2022_PROGRAM };
const sides = { input: cash, output: stock, vaultInput: accountA, vaultOutput: accountB };
const route = {
  router,
  data: new Uint8Array([187, 100, 250, 204, 49, 196, 175, 20, 1, 2, 3]),
  // The vault as the route's trader, which a router marks as a signer.
  accounts: [
    { address: vault, role: AccountRole.READONLY_SIGNER },
    { address: accountA, role: AccountRole.WRITABLE },
    { address: key(14), role: AccountRole.WRITABLE_SIGNER },
  ],
};

describe('the vault program instructions, against the interface file', () => {
  it('names each instruction by the discriminator the interface gives it', () => {
    for (const [name, bytes] of Object.entries(BASKET_DISCRIMINATORS)) {
      const spec = idl.instructions.find((i) => i.name === name);
      expect(spec?.discriminator, name).toEqual([...bytes]);
      const hash = createHash('sha256').update(`global:${name}`).digest();
      expect([...hash.subarray(0, 8)], name).toEqual([...bytes]);
    }
  });

  it('opens a vault: with targets of its own, or following a shared portfolio', () => {
    const own = decode(
      createVaultInstruction(p, {
        owner,
        vault,
        basketId: 77n,
        targets: [
          { mint: mintB, targetBps: 6_000 },
          { mint: mintA, targetBps: 2_500 },
        ],
        autoFollow: false,
        expectedVersion: 0,
      }),
    );
    expect(own.name).toBe('create_vault');
    expect(own.args).toEqual({
      basket_id: 77n,
      targets: [
        { mint: mintB, target_bps: 6_000 },
        { mint: mintA, target_bps: 2_500 },
      ],
      auto_follow: false,
      expected_version: 0,
    });
    // No shared portfolio: the program's own id stands in the optional account's place.
    expect(own.accounts).toMatchObject({
      owner,
      vault,
      config: p.config,
      assets: p.assets,
      recipe: program,
    });
    const following = decode(
      createVaultInstruction(p, {
        owner,
        vault,
        basketId: 2n ** 64n - 1n,
        targets: [],
        autoFollow: true,
        expectedVersion: 3,
        recipe,
      }),
    );
    expect(following.args).toEqual({
      basket_id: 2n ** 64n - 1n,
      targets: [],
      auto_follow: true,
      expected_version: 3,
    });
    expect(following.accounts.recipe).toBe(recipe);
    expect(following.rest).toEqual([]);
  });

  it('deposits cash from the owner into the vault', () => {
    const d = decode(
      depositInstruction(p, {
        owner,
        vault,
        cash,
        vaultAccount: accountA,
        source: wallet,
        amount: 5n,
      }),
    );
    expect([d.name, d.args]).toEqual(['deposit', { amount: 5n }]);
    expect(d.accounts).toMatchObject({
      mint: mintA,
      vault_token_account: accountA,
      source: wallet,
      token_program: TOKEN_PROGRAM,
    });
  });

  it("swaps through the router with its accounts after the vault's, and no signer among them", () => {
    const swap = decode(
      ownerSwapInstruction(p, { owner, vault, sides, maxIn: 10n, minOut: 9n, route }),
    );
    expect(swap.name).toBe('owner_swap');
    expect(swap.args).toMatchObject({ max_in: 10n, min_out: 9n });
    expect([...(swap.args.data as Uint8Array)]).toEqual([...route.data]);
    expect(swap.accounts).toMatchObject({
      input_mint: mintA,
      output_mint: mintB,
      vault_input: accountA,
      vault_output: accountB,
      input_token_program: TOKEN_PROGRAM,
      output_token_program: TOKEN_2022_PROGRAM,
      router_program: router,
    });
    expect(swap.rest).toEqual([
      { address: vault, role: AccountRole.READONLY },
      { address: accountA, role: AccountRole.WRITABLE },
      { address: key(14), role: AccountRole.WRITABLE },
    ]);
    expect(stripSigners(route.accounts).some((a) => isSignerRole(a.role))).toBe(false);
  });

  it('runs a keeper leg with the price account after the router, and the route after that', () => {
    const leg = decode(
      keeperLegInstruction(p, { keeper, vault, sides, amountIn: 42n, priceAccount: prices, route }),
    );
    expect(leg.name).toBe('keeper_leg');
    expect(leg.args.amount_in).toBe(42n);
    expect(leg.accounts).toMatchObject({ keeper, router_program: router, price_account: prices });
    expect(leg.rest.map((a) => a.address)).toEqual(route.accounts.map((a) => a.address));
  });

  it("writes the owner's other steps", () => {
    expect(
      decode(
        setTargetsInstruction(p, { owner, vault, targets: [{ mint: mintB, targetBps: 10_000 }] }),
      ).args,
    ).toEqual({ targets: [{ mint: mintB, target_bps: 10_000 }] });
    const w = decode(
      withdrawInstruction(p, {
        owner,
        vault,
        token: stock,
        vaultAccount: accountB,
        destination: wallet,
        amount: 7n,
      }),
    );
    expect([w.name, w.args, w.accounts.destination]).toEqual(['withdraw', { amount: 7n }, wallet]);
    const accept = decode(
      acceptVersionInstruction(p, { owner, vault, recipe, expectedVersion: 4 }),
    );
    expect([accept.name, accept.args, accept.accounts.recipe]).toEqual([
      'accept_version',
      { expected_version: 4 },
      recipe,
    ]);
    expect(decode(setAutoFollowInstruction(p, { owner, vault, on: true })).args).toEqual({
      on: true,
    });
  });

  it("writes the registry's steps, with no fee and no flags", () => {
    const familyId = new Uint8Array(32).fill(9);
    const metaHash = new Uint8Array(32).fill(8);
    const components = [
      { mint: mintB, weightBps: 5_000 },
      { mint: key(15), weightBps: 5_000 },
    ];
    const publish = decode(
      publishRecipeInstruction(p, { creator: owner, recipe, familyId, components, metaHash }),
    );
    expect(publish.args).toEqual({
      family_id: [...familyId],
      components: components.map((c) => ({ mint: c.mint, weight_bps: c.weightBps })),
      meta_hash: [...metaHash],
      max_fee_bps: 0,
      flags: 0,
    });
    const update = decode(
      updateRecipeInstruction(p, { creator: owner, recipe, components, metaHash }),
    );
    expect(update.name).toBe('update_recipe');
    expect(decode(cancelPendingInstruction(p, { signer: owner, recipe })).name).toBe(
      'cancel_pending',
    );
  });

  it("writes the keeper's adopt and sync, with the token accounts to read after the named ones", () => {
    const adopt = decode(adoptVersionInstruction(p, { vault, recipe }));
    expect(adopt.accounts).toMatchObject({ vault, recipe, config: p.config });
    const sync = decode(
      syncBalancesInstruction(p, { signer: keeper, vault, accounts: [accountA, accountB] }),
    );
    expect(sync.rest).toEqual([
      { address: accountA, role: AccountRole.READONLY },
      { address: accountB, role: AccountRole.READONLY },
    ]);
  });

  it('opens a token account with the create-if-missing instruction the guard allows', () => {
    const ix = createTokenAccountInstruction({
      payer: owner,
      account: accountB,
      holder: vault,
      token: stock,
    });
    expect([...(ix.data ?? [])]).toEqual([1]);
    expect(ix.accounts?.map((a) => a.address)).toEqual([
      owner,
      accountB,
      vault,
      mintB,
      '11111111111111111111111111111111',
      TOKEN_2022_PROGRAM,
    ]);
  });

  it('knows the four route selectors the vault forwards, and no other', () => {
    for (const name of ['route', 'shared_accounts_route', 'route_v2', 'shared_accounts_route_v2']) {
      const selector = createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
      expect(routeSelector(new Uint8Array(selector))).toBe(name);
    }
    expect(Object.keys(ROUTE_SELECTORS)).toHaveLength(4);
    const exactOut = createHash('sha256').update('global:exact_out_route').digest().subarray(0, 8);
    expect(routeSelector(new Uint8Array(exactOut))).toBeNull();
  });
});
