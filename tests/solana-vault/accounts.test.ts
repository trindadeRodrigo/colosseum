import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_DISCRIMINATOR,
  CONFIG_SIZE,
  configAddress,
  decodeConfig,
  decodeVault,
  isAccount,
  MAX_POSITIONS,
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

/** How many bytes Borsh writes for a type of the IDL. Every type these two accounts use is fixed-size. */
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

function planted(name: 'Config' | 'Vault', tag: Uint8Array, size: number) {
  const data = new Uint8Array(size);
  data.set(tag, 0);
  const want = plant({ defined: { name } }, data, 8, { n: 5 }) as Record<string, unknown>;
  return { data, want };
}

const anchorTag = (name: string) =>
  new Uint8Array(createHash('sha256').update(`account:${name}`).digest().subarray(0, 8));

describe('the Config and Vault layouts against idl/basket.json', () => {
  it("uses the discriminators the IDL lists, which are Anchor's for those names", () => {
    const listed = (name: string) =>
      new Uint8Array(idl.accounts.find((a) => a.name === name)?.discriminator ?? []);
    expect(CONFIG_DISCRIMINATOR).toEqual(listed('Config'));
    expect(VAULT_DISCRIMINATOR).toEqual(listed('Vault'));
    expect(CONFIG_DISCRIMINATOR).toEqual(anchorTag('Config'));
    expect(VAULT_DISCRIMINATOR).toEqual(anchorTag('Vault'));
  });

  it('has the sizes and the frozen offsets the IDL adds up to', () => {
    expect(offsetsOf('Config').$end).toBe(CONFIG_SIZE);
    expect(offsetsOf('Vault').$end).toBe(VAULT_SIZE);
    expect([CONFIG_SIZE, VAULT_SIZE]).toEqual([396, 1063]);
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
        recipe: ZERO_ADDRESS,
        acceptedVersion: 0,
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
    expect(at(VAULT_RECIPE_OFFSET)).toBe(ZERO_ADDRESS);
    expect(account.data[VAULT_AUTO_FOLLOW_OFFSET]).toBe(1);
    expect(accountOf(fixture, 'vault:manual').data[VAULT_AUTO_FOLLOW_OFFSET]).toBe(0);
  });
});
