import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Address, address, generateKeyPairSigner, isSome, lamports } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { decodeMint } from '@solana-program/token-2022';
import type { LiteSVM } from 'litesvm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ASSET_KEEPER,
  PRICES_SIZE,
  readAssets,
  readConfig,
  readRecipe,
  readVault,
} from './src/basket';
import {
  createWorld,
  expectOk,
  MOCK_ROUTER_PROGRAM,
  REPO_ROOT,
  SYSTEM_PROGRAM,
  send,
} from './src/env';
import { ata, balance, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './src/tokens';
import {
  buildWorld,
  type Ledger,
  type MintName,
  type RecipeName,
  type VaultName,
  WORLD_EMPTY_INDEX,
  WORLD_KEEPER_ON,
  WORLD_PRICES,
  type World,
  type WorldExpected,
  type WorldNames,
  worldPriceAccount,
  worldPricesExpected,
} from './src/world';

// Writes the account bytes the built program leaves behind to fixtures/solana-vault/world.json, so the
// root test suite can decode them with no Solana toolchain:
//
//   pnpm --dir programs/tests fixtures
//
// Run without that, it builds the same world again and fails when the committed file no longer has the
// shape the program writes today: regenerate it in the change that moved the layout.

const FIXTURE = join(REPO_ROOT, 'fixtures', 'solana-vault', 'world.json');
const WRITE = process.env.WRITE_FIXTURES === '1';

/** Mon 2026-10-05 15:00 UTC: inside the US session, so a stock token's market reads as open. The
 * world ends one publish delay later, which is still inside it. */
const NOW = BigInt(Date.parse('2026-10-05T15:00:00.000Z') / 1000);
const SYSVAR_CLOCK = address('SysvarC1ock11111111111111111111111111111111');

type FixtureAccount = {
  role: string;
  address: Address;
  owner: Address;
  lamports: string;
  data: string;
};
type Fixture = {
  provenance: 'fixture';
  about: string;
  names: WorldNames;
  expected: WorldExpected;
  clock: { slot: string; unixTimestamp: string };
  prices: {
    account: Address;
    owner: Address;
    entries: ReturnType<typeof worldPricesExpected>;
    emptyIndex: number;
  };
  /** An address where a token account would be, holding lamports and nothing else. */
  strayLamports: { vault: VaultName; mint: MintName; address: Address };
  accounts: FixtureAccount[];
};

/** What must not change without the file being written again: each account's role, owner and size. */
const shape = (fixture: Fixture) =>
  fixture.accounts
    .map((a) => `${a.role} ${a.owner} ${Buffer.from(a.data, 'base64').length}`)
    .sort();

describe('the vault fixtures for the adapter', () => {
  let svm: LiteSVM;
  let world: World;
  let fixture: Fixture;

  beforeAll(async () => {
    const created = await createWorld();
    svm = created.svm;
    const clock = svm.getClock();
    clock.unixTimestamp = NOW;
    svm.setClock(clock);
    const ledger: Ledger = {
      send: async (payer, instructions) => {
        expectOk(await send(svm, payer, instructions));
      },
      rent: async (bytes) => svm.minimumBalanceForRentExemption(bytes),
      advanceClock: (seconds) => {
        const moved = svm.getClock();
        moved.unixTimestamp += seconds;
        svm.setClock(moved);
        return moved.unixTimestamp;
      },
    };
    // The price account is there before the world is built: the asset list has to name one that
    // exists. Its entries are written at the end, as old as they say at the world's last second.
    const priceAccount = (await generateKeyPairSigner()).address;
    const priceBytes = (data: Uint8Array) =>
      svm.setAccount({
        address: priceAccount,
        data,
        executable: false,
        lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(PRICES_SIZE))),
        programAddress: MOCK_ROUTER_PROGRAM,
        space: BigInt(PRICES_SIZE),
      });
    priceBytes(new Uint8Array(PRICES_SIZE));
    world = await buildWorld(ledger, created.deployer, priceAccount);
    const { names, mints } = world;

    const stray = await ata(names.vaults.manual, mints.gold);
    await ledger.send(created.deployer, [
      getTransferSolInstruction({
        source: created.deployer,
        destination: stray,
        amount: lamports(await ledger.rent(0n)),
      }),
    ]);

    // The world moved the clock on by one publish delay; the prices are as old as they say now.
    priceBytes(
      worldPriceAccount(svm.getClock().slot, svm.getClock().unixTimestamp, MOCK_ROUTER_PROGRAM),
    );

    const roles: [string, Address][] = [
      ['config', names.config],
      ['assets', names.assets],
      ['clock', SYSVAR_CLOCK],
      ['price', priceAccount],
      ['wallet:owner', names.owner],
      ['wallet:other', names.other],
      ['stray', stray],
    ];
    for (const [name, mint] of Object.entries(names.mints)) roles.push([`mint:${name}`, mint]);
    for (const [name, vault] of Object.entries(names.vaults)) roles.push([`vault:${name}`, vault]);
    for (const [name, recipe] of Object.entries(names.recipes))
      roles.push([`recipe:${name}`, recipe]);
    const holders = { owner: names.owner, other: names.other, ...names.vaults };
    for (const [holder, who] of Object.entries(holders))
      for (const [name, mint] of Object.entries(mints)) {
        const token = await ata(who, mint);
        if (token !== stray && svm.getAccount(token).exists)
          roles.push([`token:${holder}/${name}`, token]);
      }

    const now = svm.getClock();
    fixture = {
      provenance: 'fixture',
      about:
        'Account bytes written by programs/basket in LiteSVM (programs/tests/solana-vault-fixtures.test.ts). The price account is hand-written in Scope layout with round numbers. Not market data.',
      names,
      expected: world.expected,
      clock: { slot: now.slot.toString(), unixTimestamp: now.unixTimestamp.toString() },
      prices: {
        account: priceAccount,
        owner: MOCK_ROUTER_PROGRAM,
        entries: worldPricesExpected(),
        emptyIndex: WORLD_EMPTY_INDEX,
      },
      strayLamports: { vault: 'manual', mint: 'gold', address: stray },
      accounts: roles.map(([role, at]) => {
        const account = svm.getAccount(at);
        if (!account.exists) throw new Error(`${role} has no account`);
        return {
          role,
          address: at,
          owner: account.programAddress,
          lamports: account.lamports.toString(),
          data: Buffer.from(account.data).toString('base64'),
        };
      }),
    };
  });

  it("holds what `expected` says, read with the suite's own decoders", async () => {
    const { names, expected, mints } = world;
    const config = await readConfig(svm);
    expect({
      admin: config.admin,
      guardian: config.guardian,
      defaultKeeper: config.defaultKeeper,
      routerProgram: config.routerProgram,
      priceOwner: config.priceOwner,
      cashMint: config.cashMint,
    }).toEqual({
      admin: names.admin,
      guardian: names.guardian,
      defaultKeeper: names.keeper,
      routerProgram: names.router,
      priceOwner: names.priceOwner,
      cashMint: names.mints.usdc,
    });

    const holders = { owner: names.owner, other: names.other, ...names.vaults };
    const holdings = async (holder: Address) => {
      const out: Record<string, string> = {};
      for (const [name, mint] of Object.entries(mints)) {
        const account = svm.getAccount(await ata(holder, mint));
        // Lamports alone at that address are not a token account.
        if (account.exists && account.programAddress === mint.program)
          out[name] = balance(svm, account.address).toString();
      }
      return out;
    };

    for (const [name, want] of Object.entries(expected.vaults)) {
      const address = names.vaults[name as VaultName];
      const vault = readVault(svm, address);
      expect([vault.owner, vault.basketId.toString(), vault.autoFollow, vault.count]).toEqual([
        holders[want.owner],
        want.basketId,
        want.autoFollow,
        want.targets.length,
      ]);
      expect([vault.recipe, vault.acceptedVersion]).toEqual([
        want.recipe ? names.recipes[want.recipe] : SYSTEM_PROGRAM,
        want.acceptedVersion,
      ]);
      const positions = vault.positions.slice(0, vault.count);
      expect(positions.map((p) => [p.mint, p.targetBps])).toEqual(
        want.targets.map((t) => [names.mints[t.mint], t.targetBps]),
      );
      expect(
        Object.fromEntries(want.targets.map((t, i) => [t.mint, positions[i]?.tracked.toString()])),
      ).toEqual(want.tracked);
      expect(await holdings(address)).toEqual(want.held);
    }
    expect(await holdings(names.owner)).toEqual(expected.wallets.owner);
    expect(await holdings(names.other)).toEqual(expected.wallets.other);

    // The asset list holds the four assets, and never the cash mint. Each points at its price
    // entry and its average in the one price account, and three are switched on for the keeper.
    const registry = await readAssets(svm);
    const listed = ['spyx', 'nvdax', 'gold', 'tslax'] as const;
    expect(registry.assets.map((a) => a.mint)).toEqual(listed.map((name) => names.mints[name]));
    expect(registry.priceAccounts[0]).toBe(fixture.prices.account);
    expect(
      registry.assets.map((a) => [a.priceKind, a.priceIndex, a.twapIndex, a.flags, a.session]),
    ).toEqual(
      listed.map((name) => [
        1,
        WORLD_PRICES[name].index,
        WORLD_PRICES[name].twapIndex,
        WORLD_KEEPER_ON.includes(name) ? ASSET_KEEPER : 0,
        name === 'gold' ? 0 : 1,
      ]),
    );
    for (const [name, want] of Object.entries(expected.recipes)) {
      const recipe = readRecipe(svm, names.recipes[name as RecipeName]);
      const weights = (version: typeof recipe.current) =>
        version.components.map((c) => [c.mint, c.weightBps]);
      const wanted = (list: { mint: MintName; weightBps: number }[]) =>
        list.map((c) => [names.mints[c.mint], c.weightBps]);
      expect(recipe.creator).toBe(names.creator);
      expect(Buffer.from(recipe.familyId).toString('hex')).toBe(want.familyId);
      expect([recipe.current.version, weights(recipe.current)]).toEqual([
        want.active.version,
        wanted(want.active.components),
      ]);
      if (!want.pending) throw new Error('the fixture world has a version that waits');
      expect([
        recipe.pending.version,
        recipe.pending.effectiveAt.toString(),
        weights(recipe.pending),
      ]).toEqual([want.pending.version, want.pending.effectiveAt, wanted(want.pending.components)]);
      // It still waits at the fixture's clock.
      expect(recipe.pending.effectiveAt).toBeGreaterThan(svm.getClock().unixTimestamp);
    }

    for (const [name, want] of Object.entries(expected.mints)) {
      const mint = mints[name as MintName];
      const account = svm.getAccount(mint.address);
      if (!account.exists) throw new Error(`no mint ${name}`);
      expect(account.programAddress).toBe(
        want.tokenProgram === 'token' ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM,
      );
      const decoded = decodeMint(account).data;
      expect(decoded.decimals).toBe(want.decimals);
      const extensions = isSome(decoded.extensions) ? decoded.extensions.value : [];
      const scaled = extensions.find((e) => e.__kind === 'ScaledUiAmountConfig');
      if (want.multiplier === null) {
        expect(scaled).toBeUndefined();
        continue;
      }
      if (scaled?.__kind !== 'ScaledUiAmountConfig') throw new Error(`${name} has no multiplier`);
      // In force now: the scheduled one only after its time.
      const inForce =
        NOW >= scaled.newMultiplierEffectiveTimestamp ? scaled.newMultiplier : scaled.multiplier;
      expect(inForce).toBe(want.multiplier);
      expect(
        NOW >= scaled.newMultiplierEffectiveTimestamp
          ? null
          : {
              multiplier: scaled.newMultiplier,
              effectiveAt: scaled.newMultiplierEffectiveTimestamp.toString(),
            },
      ).toEqual(want.scheduled);
    }
  });

  it('is the committed fixture in everything but the addresses', () => {
    // `pnpm fixtures` writes the file first, so this then compares the file with itself.
    if (WRITE) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
    }
    if (!existsSync(FIXTURE)) throw new Error('no fixture: pnpm --dir programs/tests fixtures');
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
    expect(committed.expected).toEqual(fixture.expected);
    expect(committed.clock).toEqual(fixture.clock);
    expect({ ...committed.prices, account: '' }).toEqual({ ...fixture.prices, account: '' });
    expect(shape(committed)).toEqual(shape(fixture));
  });
});
