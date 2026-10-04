import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSET_KEEPER,
  ASSETS_DISCRIMINATOR,
  ASSETS_SIZE,
  assetsAddress,
  CONFIG_DISCRIMINATOR,
  CONFIG_SIZE,
  configAddress,
  decodeAssetRegistry,
  decodeConfig,
  decodeRecipe,
  decodeVault,
  isAccount,
  keeperOn,
  MAX_ASSETS,
  MAX_COMPONENTS,
  MAX_POSITIONS,
  RECIPE_DISCRIMINATOR,
  RECIPE_SIZE,
  recipeAddress,
  VAULT_ACCEPTED_VERSION_OFFSET,
  VAULT_AUTO_FOLLOW_OFFSET,
  VAULT_DISCRIMINATOR,
  VAULT_ERROR_BASE,
  VAULT_ERRORS,
  VAULT_OWNER_OFFSET,
  VAULT_RECIPE_OFFSET,
  VAULT_SIZE,
  vaultAddress,
  vaultErrorName,
  versionsAt,
  ZERO_ADDRESS,
} from '@colosseum/chain-solana/vault';
import { type Address, getAddressDecoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { accountOf, loadFixture, type MintName, REPO_ROOT, type VaultName } from './world';

// The decoders against the two things they must agree with: the committed interface file, and bytes
// the built program wrote (fixtures/solana-vault, out of LiteSVM).

type IdlType =
  | string
  | { array: [IdlType, number] }
  | { defined: { name: string } }
  | { option: IdlType };
type Idl = {
  address: string;
  accounts: { name: string; discriminator: number[] }[];
  errors: { code: number; name: string }[];
  types: { name: string; type: { kind: string; fields: { name: string; type: IdlType }[] } }[];
};
const idl: Idl = JSON.parse(readFileSync(join(REPO_ROOT, 'idl', 'basket.json'), 'utf8'));

const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const fieldsOf = (name: string) => {
  const found = idl.types.find((t) => t.name === name);
  if (!found) throw new Error(`the IDL has no type ${name}`);
  return found.type.fields;
};

const SCALAR_BYTES: Record<string, number> = {
  bool: 1,
  u8: 1,
  u16: 2,
  u32: 4,
  u64: 8,
  i64: 8,
  pubkey: 32,
};

/** How many bytes a type of the IDL takes. Every type these accounts use is fixed-size, and none is
 * padded: Borsh writes the fields one after another, and the asset list is packed. */
function sizeOf(type: IdlType): number {
  if (typeof type === 'string') {
    const bytes = SCALAR_BYTES[type];
    if (!bytes) throw new Error(`no size for ${type}`);
    return bytes;
  }
  if ('array' in type) return sizeOf(type.array[0]) * type.array[1];
  if ('defined' in type) return fieldsOf(type.defined.name).reduce((n, f) => n + sizeOf(f.type), 0);
  throw new Error('an option has no fixed size');
}

/** Where each field of an account starts, counting Anchor's 8-byte discriminator. */
function offsetsOf(name: string): Record<string, number> {
  let at = 8;
  const out: Record<string, number> = {};
  for (const field of fieldsOf(name)) {
    out[field.name] = at;
    at += sizeOf(field.type);
  }
  out.$end = at;
  return out;
}

/**
 * Writes a value of an IDL type that is different at every byte position, and returns what a correct
 * decoder must read back. A decoder with a field in the wrong place, of the wrong width, or under the
 * wrong name cannot return the same.
 */
function plant(type: IdlType, data: Uint8Array, at: number, seed: { n: number }): unknown {
  const view = new DataView(data.buffer);
  const next = () => (seed.n = (seed.n * 31 + 17) % 251);
  if (typeof type === 'string') {
    if (type === 'bool') {
      const bit = next() % 2;
      data[at] = bit;
      return bit === 1;
    }
    if (type === 'pubkey') {
      for (let i = 0; i < 32; i++) data[at + i] = next();
      return getAddressDecoder().decode(data.subarray(at, at + 32));
    }
    const bytes = sizeOf(type);
    for (let i = 0; i < bytes; i++) data[at + i] = next();
    // The top byte stays small, so a signed 64-bit value reads the same as an unsigned one.
    if (bytes === 8) data[at + 7] = next() % 100;
    if (type === 'u8') return view.getUint8(at);
    if (type === 'u16') return view.getUint16(at, true);
    if (type === 'u32') return view.getUint32(at, true);
    return view.getBigUint64(at, true);
  }
  if ('array' in type) {
    const [element, length] = type.array;
    const items = Array.from({ length }, (_, i) =>
      plant(element, data, at + i * sizeOf(element), seed),
    );
    // A byte array is decoded as bytes, not as a list of numbers.
    return element === 'u8' ? new Uint8Array(items as number[]) : items;
  }
  if ('defined' in type) {
    let offset = at;
    const out: Record<string, unknown> = {};
    for (const field of fieldsOf(type.defined.name)) {
      out[camel(field.name)] = plant(field.type, data, offset, seed);
      offset += sizeOf(field.type);
    }
    return out;
  }
  throw new Error('unsupported type');
}

function planted(
  name: 'Config' | 'Vault' | 'AssetRegistry' | 'Recipe',
  tag: Uint8Array,
  size: number,
) {
  const data = new Uint8Array(size);
  data.set(tag, 0);
  const want = plant({ defined: { name } }, data, 8, { n: 5 }) as Record<string, unknown>;
  return { data, want };
}

const anchorTag = (name: string) =>
  new Uint8Array(createHash('sha256').update(`account:${name}`).digest().subarray(0, 8));

describe('the account layouts against idl/basket.json', () => {
  it("uses the discriminators the IDL lists, which are Anchor's for those names", () => {
    const listed = (name: string) =>
      new Uint8Array(idl.accounts.find((a) => a.name === name)?.discriminator ?? []);
    for (const [name, tag] of [
      ['Config', CONFIG_DISCRIMINATOR],
      ['Vault', VAULT_DISCRIMINATOR],
      ['AssetRegistry', ASSETS_DISCRIMINATOR],
      ['Recipe', RECIPE_DISCRIMINATOR],
    ] as const) {
      expect([name, tag]).toEqual([name, listed(name)]);
      expect([name, tag]).toEqual([name, anchorTag(name)]);
    }
    expect(idl.accounts).toHaveLength(4);
  });

  it('has the sizes and the frozen offsets the IDL adds up to', () => {
    expect(offsetsOf('Config').$end).toBe(CONFIG_SIZE);
    expect(offsetsOf('Vault').$end).toBe(VAULT_SIZE);
    expect(offsetsOf('AssetRegistry').$end).toBe(ASSETS_SIZE);
    expect(offsetsOf('Recipe').$end).toBe(RECIPE_SIZE);
    expect([CONFIG_SIZE, VAULT_SIZE, ASSETS_SIZE, RECIPE_SIZE]).toEqual([396, 1063, 6281, 1022]);
    // The asset list: the count at byte 136, entry i at 137 + 96·i.
    expect([offsetsOf('AssetRegistry').count, offsetsOf('AssetRegistry').assets]).toEqual([
      136, 137,
    ]);
    expect(sizeOf({ defined: { name: 'AssetEntry' } })).toBe(96);
    expect(sizeOf({ defined: { name: 'RecipeVersion' } })).toBe(453);
    const vault = offsetsOf('Vault');
    expect([vault.owner, vault.recipe, vault.accepted_version, vault.auto_follow]).toEqual([
      VAULT_OWNER_OFFSET,
      VAULT_RECIPE_OFFSET,
      VAULT_ACCEPTED_VERSION_OFFSET,
      VAULT_AUTO_FOLLOW_OFFSET,
    ]);
    expect([VAULT_OWNER_OFFSET, VAULT_RECIPE_OFFSET, VAULT_AUTO_FOLLOW_OFFSET]).toEqual([
      8, 40, 76,
    ]);
  });

  it('decodes every Config field the IDL names, from where the IDL puts it', () => {
    const { data, want } = planted('Config', CONFIG_DISCRIMINATOR, CONFIG_SIZE);
    expect(decodeConfig(data)).toEqual(want);
  });

  it('decodes every Vault field the IDL names, and only the positions in use', () => {
    const { data, want } = planted('Vault', VAULT_DISCRIMINATOR, VAULT_SIZE);
    const count = 11;
    data[offsetsOf('Vault').count ?? 0] = count;
    const decoded = decodeVault(data);
    expect(decoded).toEqual({
      ...want,
      count,
      positions: (want.positions as unknown[]).slice(0, count),
    });
    expect((want.positions as unknown[]).length).toBe(MAX_POSITIONS);
  });

  it('decodes every field of the asset list the IDL names, and only the entries in use', () => {
    const { data, want } = planted('AssetRegistry', ASSETS_DISCRIMINATOR, ASSETS_SIZE);
    const count = 37;
    data[offsetsOf('AssetRegistry').count ?? 0] = count;
    expect(decodeAssetRegistry(data)).toEqual({
      ...want,
      count,
      assets: (want.assets as unknown[]).slice(0, count),
    });
    expect((want.assets as unknown[]).length).toBe(MAX_ASSETS);
  });

  it('decodes every field of a shared portfolio the IDL names, and only the lines in use', () => {
    const { data, want } = planted('Recipe', RECIPE_DISCRIMINATOR, RECIPE_SIZE);
    const recipe = offsetsOf('Recipe');
    const countAt = (version: 'current' | 'pending') => (recipe[version] ?? 0) + 4 + 8 + 32;
    data[countAt('current')] = 5;
    data[countAt('pending')] = MAX_COMPONENTS;
    type Version = { count: number; components: unknown[] };
    const used = (version: unknown, count: number) => ({
      ...(version as Version),
      count,
      components: (version as Version).components.slice(0, count),
    });
    expect(decodeRecipe(data)).toEqual({
      ...want,
      current: used(want.current, 5),
      pending: used(want.pending, MAX_COMPONENTS),
    });
  });

  it("names the program's errors in the IDL's order", () => {
    expect(idl.errors.map((e) => e.name)).toEqual([...VAULT_ERRORS]);
    for (const e of idl.errors) expect(vaultErrorName(e.code)).toBe(e.name);
    expect(idl.errors[0]?.code).toBe(VAULT_ERROR_BASE);
    expect(vaultErrorName(VAULT_ERROR_BASE - 1)).toBeNull();
    expect(vaultErrorName(VAULT_ERROR_BASE + VAULT_ERRORS.length)).toBeNull();
  });

  it('refuses bytes that are not the account: another size, another discriminator, a count past 16', () => {
    const config = planted('Config', CONFIG_DISCRIMINATOR, CONFIG_SIZE).data;
    const vault = planted('Vault', VAULT_DISCRIMINATOR, VAULT_SIZE).data;
    expect(() => decodeConfig(vault)).toThrow(/not a Config/);
    expect(() => decodeVault(config)).toThrow(/not a Vault/);
    expect(() => decodeConfig(config.subarray(0, CONFIG_SIZE - 1))).toThrow(/not a Config/);
    expect(() => decodeVault(new Uint8Array([...vault, 0]))).toThrow(/not a Vault/);
    const swapped = new Uint8Array(vault);
    swapped.set(CONFIG_DISCRIMINATOR, 0);
    expect(() => decodeVault(swapped)).toThrow(/not a Vault/);
    expect(isAccount('vault', swapped)).toBe(false);
    const overfull = new Uint8Array(vault);
    overfull[offsetsOf('Vault').count ?? 0] = MAX_POSITIONS + 1;
    expect(() => decodeVault(overfull)).toThrow(/positions in use/);

    const assets = planted('AssetRegistry', ASSETS_DISCRIMINATOR, ASSETS_SIZE).data;
    const recipe = planted('Recipe', RECIPE_DISCRIMINATOR, RECIPE_SIZE).data;
    recipe[(offsetsOf('Recipe').current ?? 0) + 44] = 3;
    recipe[(offsetsOf('Recipe').pending ?? 0) + 44] = 3;
    assets[offsetsOf('AssetRegistry').count ?? 0] = 3;
    expect(() => decodeAssetRegistry(recipe)).toThrow(/not an asset list/);
    expect(() => decodeRecipe(vault)).toThrow(/not a Recipe/);
    expect(() => decodeRecipe(recipe.subarray(0, RECIPE_SIZE - 1))).toThrow(/not a Recipe/);
    expect(isAccount('recipe', recipe)).toBe(true);
    expect(isAccount('assets', recipe)).toBe(false);
    const tooMany = new Uint8Array(assets);
    tooMany[offsetsOf('AssetRegistry').count ?? 0] = MAX_ASSETS + 1;
    expect(() => decodeAssetRegistry(tooMany)).toThrow(/entries/);
    const tooLong = new Uint8Array(recipe);
    tooLong[(offsetsOf('Recipe').pending ?? 0) + 44] = MAX_COMPONENTS + 1;
    expect(() => decodeRecipe(tooLong)).toThrow(/lines/);
  });
});

describe('flags', () => {
  it('refuses a flag byte that is neither 0 nor 1, in Config and in Vault', () => {
    const fixture = loadFixture();
    const config = accountOf(fixture, 'config').data;
    const vault = accountOf(fixture, 'vault:following').data;
    const withByte = (data: Uint8Array, at: number, byte: number) => {
      const copy = new Uint8Array(data);
      copy[at] = byte;
      return copy;
    };
    const { keeper_paused: paused = 0, launched = 0 } = offsetsOf('Config');
    expect(decodeConfig(withByte(config, paused, 1)).keeperPaused).toBe(true);
    expect(decodeConfig(withByte(config, launched, 1)).launched).toBe(true);
    expect(decodeVault(withByte(vault, VAULT_AUTO_FOLLOW_OFFSET, 0)).autoFollow).toBe(false);
    for (const byte of [2, 255]) {
      expect(() => decodeConfig(withByte(config, paused, byte))).toThrow(/neither true nor false/);
      expect(() => decodeConfig(withByte(config, launched, byte))).toThrow(
        /neither true nor false/,
      );
      expect(() => decodeVault(withByte(vault, VAULT_AUTO_FOLLOW_OFFSET, byte))).toThrow(
        /neither true nor false/,
      );
    }
  });
});

describe('the decoders against bytes the program wrote', () => {
  const fixture = loadFixture();
  const { names, expected } = fixture;

  it("reads the fixture as the IDL's program", () => {
    expect(names.program).toBe(idl.address);
    expect(fixture.provenance).toBe('fixture');
  });

  it('decodes Config: every address the script set, the default parameters, and its own bump', async () => {
    const account = accountOf(fixture, 'config');
    expect(account.owner).toBe(names.program);
    expect(account.data.length).toBe(CONFIG_SIZE);
    const config = decodeConfig(account.data);
    expect(config).toMatchObject({
      admin: names.admin,
      pendingAdmin: ZERO_ADDRESS,
      guardian: names.guardian,
      defaultKeeper: names.keeper,
      routerProgram: names.router,
      priceOwner: names.priceOwner,
      cashMint: names.mints.usdc,
      keeperPaused: false,
      launched: false,
      // DEFAULT_PARAMS in programs/tests/src/basket.ts: the starting values of DESIGN-VAULT section 5.
      toleranceBps: 75,
      lossCapBps: 200,
      bandBps: 50,
      twapDevBps: 200,
      maxPriceAgeS: 120,
      assetCooldownS: 3_600,
      publishDelayS: 60,
      sessionOpenUtcS: 52_200,
      sessionCloseUtcS: 72_000,
      closedUntil: 0n,
    });
    expect(config.closedDays).toEqual(Array.from({ length: 32 }, () => 0));
    expect(config.reserved).toEqual(new Uint8Array(63));
    expect(await configAddress(names.program as Address)).toBe(names.config);
    expect(account.address).toBe(names.config);
  });

  it.each(Object.keys(expected.vaults) as VaultName[])(
    'decodes the vault "%s": owner, plan id, targets, and what the program recorded',
    async (name) => {
      const want = expected.vaults[name];
      const account = accountOf(fixture, `vault:${name}`);
      expect(account.owner).toBe(names.program);
      expect(account.data.length).toBe(VAULT_SIZE);
      const vault = decodeVault(account.data);
      expect(vault).toMatchObject({
        owner: names[want.owner],
        recipe: want.recipe ? names.recipes[want.recipe] : ZERO_ADDRESS,
        acceptedVersion: want.acceptedVersion,
        autoFollow: want.autoFollow,
        basketId: BigInt(want.basketId),
        keeper: ZERO_ADDRESS,
        count: want.targets.length,
        lossAccum: 0n,
        lossTs: 0n,
      });
      expect(vault.positions).toEqual(
        want.targets.map((t) => ({
          mint: names.mints[t.mint],
          targetBps: t.targetBps,
          tracked: BigInt(want.tracked[t.mint as MintName] ?? 'missing'),
          lastKeeperTs: 0n,
        })),
      );
      expect(vault.reserved).toEqual(new Uint8Array(128));
      // The address is the one the seeds give, so the plan id and the owner were read from the right bytes.
      expect(await vaultAddress(names.program as Address, vault.owner, vault.basketId)).toBe(
        account.address,
      );
      expect(account.address).toBe(names.vaults[name]);
    },
  );

  it('finds the owner, the recipe and the auto-follow flag at the offsets a filter uses', () => {
    const account = accountOf(fixture, 'vault:following');
    const at = (offset: number) =>
      getAddressDecoder().decode(account.data.subarray(offset, offset + 32));
    expect(at(VAULT_OWNER_OFFSET)).toBe(names.owner);
    expect(at(VAULT_RECIPE_OFFSET)).toBe(names.recipes.core);
    expect(new DataView(account.data.buffer).getUint32(VAULT_ACCEPTED_VERSION_OFFSET, true)).toBe(
      1,
    );
    expect(account.data[VAULT_AUTO_FOLLOW_OFFSET]).toBe(1);
    const manual = accountOf(fixture, 'vault:manual').data;
    expect(manual[VAULT_AUTO_FOLLOW_OFFSET]).toBe(0);
    expect(
      manual.subarray(VAULT_RECIPE_OFFSET, VAULT_RECIPE_OFFSET + 32).every((b) => b === 0),
    ).toBe(true);
  });

  it('decodes the asset list: the four assets in the order they were listed, at its own address', async () => {
    const account = accountOf(fixture, 'assets');
    expect(account.owner).toBe(names.program);
    expect(account.data.length).toBe(ASSETS_SIZE);
    expect(await assetsAddress(names.program as Address)).toBe(account.address);
    expect(account.address).toBe(names.assets);
    const list = decodeAssetRegistry(account.data);
    expect(list.count).toBe(4);
    // The first of the four slots names the price account; the others are empty.
    expect(list.priceAccounts).toEqual([
      fixture.prices.account,
      ZERO_ADDRESS,
      ZERO_ADDRESS,
      ZERO_ADDRESS,
    ]);
    expect(list.assets).toEqual(
      (['spyx', 'nvdax', 'gold', 'tslax'] as const).map((name) => ({
        mint: names.mints[name],
        priceSlot: 0,
        priceIndex: fixture.prices.entries[name].index,
        twapIndex: fixture.prices.entries[name].twapIndex,
        decimals: expected.mints[name].decimals,
        priceKind: 1,
        session: name === 'gold' ? 0 : 1,
        maxWeightBps: 5_000,
        // Bit 0: the keeper may trade it. TSLAx is listed and priced, and off.
        flags: fixture.prices.entries[name].keeperOn ? ASSET_KEEPER : 0,
        sourceCheck: new Uint8Array(32),
        // In millionths of a dollar; TSLAx, which the keeper does not trade, has none.
        minPrice: BigInt((fixture.prices.entries[name].range?.min ?? 0) * 1_000_000),
        maxPrice: BigInt((fixture.prices.entries[name].range?.max ?? 0) * 1_000_000),
        reserved: new Uint8Array(5),
      })),
    );
    expect(list.assets.map(keeperOn)).toEqual([true, true, true, false]);
  });

  it('decodes the shared portfolio: its creator, its family, the version in effect and the one that waits', async () => {
    const account = accountOf(fixture, 'recipe:core');
    const want = expected.recipes.core;
    expect(account.owner).toBe(names.program);
    expect(account.data.length).toBe(RECIPE_SIZE);
    const recipe = decodeRecipe(account.data);
    const familyId = new Uint8Array(Buffer.from(want.familyId, 'hex'));
    expect(recipe.creator).toBe(names.creator);
    expect(recipe.familyId).toEqual(familyId);
    expect(await recipeAddress(names.program as Address, names.creator as Address, familyId)).toBe(
      account.address,
    );
    expect(account.address).toBe(names.recipes.core);
    const lines = (list: { mint: MintName; weightBps: number }[]) =>
      list.map((c) => ({ mint: names.mints[c.mint], weightBps: c.weightBps }));
    expect([recipe.current.version, recipe.current.components]).toEqual([
      want.active.version,
      lines(want.active.components),
    ]);
    if (!want.pending) throw new Error('the fixture has a version that waits');
    expect([recipe.pending.version, recipe.pending.effectiveAt, recipe.pending.components]).toEqual(
      [want.pending.version, BigInt(want.pending.effectiveAt), lines(want.pending.components)],
    );
    // One publish delay after the second publish, which is the fixture's clock.
    const clock = BigInt(fixture.clock.unixTimestamp);
    expect(recipe.lastPublishTs).toBe(clock);
    expect(recipe.pending.effectiveAt - clock).toBe(60n);
    expect([recipe.maxFeeBps, recipe.flags, recipe.vetoed]).toEqual([0, 0, false]);
    // The highest version number given out: the one that waits.
    expect(recipe.lastVersion).toBe(want.pending.version);
    expect(recipe.reserved).toEqual(new Uint8Array(28));

    // In effect by the clock: the waiting version from the second its time comes, the first until then.
    const before = versionsAt(recipe, recipe.pending.effectiveAt - 1n);
    expect([before.active.version, before.pending?.version]).toEqual([1, 2]);
    const from = versionsAt(recipe, recipe.pending.effectiveAt);
    expect([from.active.version, from.pending]).toEqual([2, null]);
  });
});
