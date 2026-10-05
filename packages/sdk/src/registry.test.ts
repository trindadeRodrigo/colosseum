import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { base58Decode, base58Encode } from './bytes';
import type { RpcCall } from './executor/chain-read';
import { BASKET_PROGRAM } from './guard/generated/basket-program';
import { recipeAddress } from './guard/solana/addresses';
import { RECIPE_ACCOUNT_SIZE, readSolanaRecipe } from './registry';

// The registry's account as a screen reads it from its own node, against bytes laid out here from the
// program's `Recipe` (idl/basket.json). tests/solana-vault/shared-routes.test.ts reads an account the
// program itself wrote.

const idl = JSON.parse(readFileSync(new URL('../../../idl/basket.json', import.meta.url), 'utf8'));
const CREATOR = base58Encode(new Uint8Array(32).fill(7));
const FAMILY = 'ab'.repeat(32);
const MINT = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const DEPLOYMENT = {
  assets: {
    'solana:spyx': { mint: MINT(1), tokenProgram: 'token' as const, decimals: 8 },
    'solana:nvdax': { mint: MINT(2), tokenProgram: 'token' as const, decimals: 8 },
    'solana:paxg': { mint: MINT(3), tokenProgram: 'token' as const, decimals: 6 },
  },
};

type Version = { version: number; effectiveAt: number; meta: number; lines: [number, number][] };

function writeVersion(b: Uint8Array, at: number, v: Version) {
  const view = new DataView(b.buffer);
  view.setUint32(at, v.version, true);
  view.setBigInt64(at + 4, BigInt(v.effectiveAt), true);
  b.fill(v.meta, at + 12, at + 44);
  b[at + 44] = v.lines.length;
  v.lines.forEach(([mint, weight], i) => {
    b.set(base58Decode(MINT(mint)), at + 45 + i * 34);
    view.setUint16(at + 45 + i * 34 + 32, weight, true);
  });
}

function account(o: { current: Version; pending?: Version; creator?: string; family?: string }) {
  const b = new Uint8Array(RECIPE_ACCOUNT_SIZE);
  b.set(createHash('sha256').update('account:Recipe').digest().subarray(0, 8), 0);
  b.set(base58Decode(o.creator ?? CREATOR), 8);
  b.set(Buffer.from(o.family ?? FAMILY, 'hex'), 40);
  writeVersion(b, 72, o.current);
  if (o.pending) writeVersion(b, 525, o.pending);
  return b;
}

function clockAt(now: number) {
  const b = new Uint8Array(40);
  new DataView(b.buffer).setBigInt64(32, BigInt(now), true);
  return b;
}

const node =
  (recipe: Uint8Array | null, now: number, owner = BASKET_PROGRAM.address): RpcCall =>
  async (method, params) => {
    expect(method).toBe('getMultipleAccounts');
    const [keys] = params as [string[]];
    expect(keys).toEqual([
      recipeAddress(BASKET_PROGRAM.address, CREATOR, FAMILY),
      'SysvarC1ock11111111111111111111111111111111',
    ]);
    const wrap = (data: Uint8Array, by: string) => ({
      data: [Buffer.from(data).toString('base64'), 'base64'],
      owner: by,
    });
    return {
      value: [
        recipe ? wrap(recipe, owner) : null,
        wrap(clockAt(now), 'Sysvar1111111111111111111111111111111111111'),
      ],
    };
  };

const V1: Version = {
  version: 1,
  effectiveAt: 1_000,
  meta: 1,
  lines: [
    [1, 4000],
    [2, 3000],
    [3, 3000],
  ],
};
const V2: Version = {
  version: 3,
  effectiveAt: 2_000,
  meta: 2,
  lines: [
    [1, 3500],
    [2, 3500],
    [3, 3000],
  ],
};

describe("a shared portfolio, read from the caller's own node", () => {
  it('is the layout of the program, its size and its discriminator', () => {
    const recipe = idl.accounts.find((a: { name: string }) => a.name === 'Recipe');
    expect(recipe.discriminator).toEqual([
      ...createHash('sha256').update('account:Recipe').digest().subarray(0, 8),
    ]);
    expect(RECIPE_ACCOUNT_SIZE).toBe(1022);
  });

  it('answers the version in effect and the one that waits, by the cluster clock', async () => {
    const at = { creator: CREATOR, familyId: FAMILY };
    const before = await readSolanaRecipe(
      node(account({ current: V1, pending: V2 }), 1_500),
      DEPLOYMENT,
      at,
    );
    expect(before?.address).toBe(recipeAddress(BASKET_PROGRAM.address, CREATOR, FAMILY));
    expect([before?.active.version, before?.pending?.version, before?.clock]).toEqual([
      1, 3, 1_500,
    ]);
    expect(before?.active.components).toEqual([
      { asset: 'solana:spyx', mint: MINT(1), weightBps: 4000 },
      { asset: 'solana:nvdax', mint: MINT(2), weightBps: 3000 },
      { asset: 'solana:paxg', mint: MINT(3), weightBps: 3000 },
    ]);
    expect(before?.active.metaHash).toBe('01'.repeat(32));
    expect(before?.active.effectiveAt).toBe(1_000);
    // Its time has come: in effect, with nothing written to the account.
    const after = await readSolanaRecipe(
      node(account({ current: V1, pending: V2 }), 2_000),
      DEPLOYMENT,
      at,
    );
    expect([after?.active.version, after?.pending]).toEqual([3, null]);
    const alone = await readSolanaRecipe(node(account({ current: V1 }), 5_000), DEPLOYMENT, at);
    expect([alone?.active.version, alone?.pending]).toEqual([1, null]);
  });

  it('names a token the deployment does not list by its mint, with no asset id', async () => {
    const odd = {
      ...V1,
      lines: [
        [1, 5000],
        [9, 5000],
      ] as [number, number][],
    };
    const read = await readSolanaRecipe(node(account({ current: odd }), 5_000), DEPLOYMENT, {
      creator: CREATOR,
      familyId: FAMILY,
    });
    expect(read?.active.components[1]).toEqual({ asset: null, mint: MINT(9), weightBps: 5000 });
  });

  it('answers null where there is none, and refuses an account that is not the registry’s', async () => {
    const at = { creator: CREATOR, familyId: FAMILY };
    expect(await readSolanaRecipe(node(null, 5_000), DEPLOYMENT, at)).toBeNull();
    await expect(
      readSolanaRecipe(node(account({ current: V1 }), 5_000, MINT(4)), DEPLOYMENT, at),
    ).rejects.toThrow('not a shared portfolio of the vault program');
    const wrongTag = account({ current: V1 });
    wrongTag[0] = 0;
    await expect(readSolanaRecipe(node(wrongTag, 5_000), DEPLOYMENT, at)).rejects.toThrow(
      'not a shared portfolio',
    );
    await expect(
      readSolanaRecipe(
        node(account({ current: V1, family: 'cd'.repeat(32) }), 5_000),
        DEPLOYMENT,
        at,
      ),
    ).rejects.toThrow('another creator or family');
    await expect(
      readSolanaRecipe(node(account({ current: V1, creator: MINT(5) }), 5_000), DEPLOYMENT, at),
    ).rejects.toThrow('another creator or family');
    await expect(
      readSolanaRecipe(node(account({ current: V1 }), 5_000), DEPLOYMENT, {
        ...at,
        familyId: 'AB',
      }),
    ).rejects.toThrow('32 bytes');
  });
});

describe('the vault a plan number names, as the guard derives it', () => {
  it('is the program’s account on Solana and the mock’s own on the mock, and none on EVM', async () => {
    const { vaultAddress } = await import('./guard/solana/addresses');
    const { mockVaultAddress } = await import('./guard/mock/check');
    const { vaultOf } = await import('./registry');
    expect(vaultOf({ family: 'solana', chain: 'solana' }, CREATOR, '42')).toBe(
      vaultAddress(BASKET_PROGRAM.address, CREATOR, '42'),
    );
    expect(vaultOf({ family: 'mock', chain: 'solana' }, CREATOR, '42')).toBe(
      mockVaultAddress('solana', CREATOR, '42'),
    );
    expect(vaultOf({ family: 'solana', chain: 'solana' }, CREATOR, '43')).not.toBe(
      vaultOf({ family: 'solana', chain: 'solana' }, CREATOR, '42'),
    );
    expect(vaultOf({ family: 'evm', chain: 'robinhood' }, `0x${'1'.repeat(40)}`, '42')).toBeNull();
  });
});
