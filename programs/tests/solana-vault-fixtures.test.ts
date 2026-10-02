import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type Address,
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  isSome,
  lamports,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { decodeMint } from '@solana-program/token-2022';
import type { LiteSVM } from 'litesvm';
import { beforeAll, describe, expect, it } from 'vitest';
import { readConfig, readVault } from './src/basket';
import { createWorld, expectOk, MOCK_ROUTER_PROGRAM, REPO_ROOT, send } from './src/env';
import { ata, balance, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './src/tokens';
import {
  buildWorld,
  type Ledger,
  type MintName,
  type VaultName,
  type World,
  type WorldExpected,
  type WorldNames,
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

/** Mon 2026-10-05 15:00 UTC: inside the US session, so a stock token's market reads as open. */
const NOW = BigInt(Date.parse('2026-10-05T15:00:00.000Z') / 1000);
const SYSVAR_CLOCK = address('SysvarC1ock11111111111111111111111111111111');

const SCOPE_BYTES = 28_712;
const SCOPE_HEADER = 40;
const SCOPE_ENTRY = 56;
/** Round numbers, so nobody reads one as a market price. The indexes are free choices, 0 to 511. */
const PRICES: Record<MintName, { index: number; value: bigint; exponent: bigint; age: bigint }> = {
  usdc: { index: 13, value: 100_000_000n, exponent: 8n, age: 20n },
  spyx: { index: 344, value: 10_000_000_000n, exponent: 8n, age: 30n },
  nvdax: { index: 332, value: 500_000n, exponent: 4n, age: 45n },
  // Older than the 120 s the keeper accepts: the reader still reports it, with its age.
  gold: { index: 100, value: 2_005n, exponent: 1n, age: 400n },
  tslax: { index: 338, value: 20n, exponent: 0n, age: 0n },
};
/** An entry nobody wrote. */
const EMPTY_INDEX = 7;

/** A price account with Scope's layout, written by hand as the design says for LiteSVM. */
function scopeAccount(slot: bigint): Uint8Array {
  const data = new Uint8Array(SCOPE_BYTES);
  // Scope's own header: Anchor's discriminator for `OraclePrices`, then the mappings account.
  data.set(createHash('sha256').update('account:OraclePrices').digest().subarray(0, 8), 0);
  data.set(getAddressEncoder().encode(MOCK_ROUTER_PROGRAM), 8);
  const view = new DataView(data.buffer);
  for (const { index, value, exponent, age } of Object.values(PRICES)) {
    const at = SCOPE_HEADER + SCOPE_ENTRY * index;
    view.setBigUint64(at, value, true);
    view.setBigUint64(at + 8, exponent, true);
    view.setBigUint64(at + 16, slot, true);
    view.setBigUint64(at + 24, NOW - age, true);
  }
  return data;
}

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
    entries: Record<MintName, { index: number; usdPerToken: string; ageSeconds: number }>;
    emptyIndex: number;
  };
  /** An address where a token account would be, holding lamports and nothing else. */
  strayLamports: { vault: VaultName; mint: MintName; address: Address };
  accounts: FixtureAccount[];
};

const decimal = (value: bigint, exponent: bigint) => {
  const digits = value.toString().padStart(Number(exponent) + 1, '0');
  const whole = digits.slice(0, digits.length - Number(exponent));
  const frac = digits.slice(digits.length - Number(exponent)).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
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
    };
    world = await buildWorld(ledger, created.deployer);
    const { names, mints } = world;

    const stray = await ata(names.vaults.manual, mints.gold);
    await ledger.send(created.deployer, [
      getTransferSolInstruction({
        source: created.deployer,
        destination: stray,
        amount: lamports(await ledger.rent(0n)),
      }),
    ]);

    const priceAccount = (await generateKeyPairSigner()).address;
    const prices = scopeAccount(svm.getClock().slot);
    svm.setAccount({
      address: priceAccount,
      data: prices,
      executable: false,
      lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(prices.length))),
      programAddress: MOCK_ROUTER_PROGRAM,
      space: BigInt(prices.length),
    });

    const roles: [string, Address][] = [
      ['config', names.config],
      ['clock', SYSVAR_CLOCK],
      ['price', priceAccount],
      ['wallet:owner', names.owner],
      ['wallet:other', names.other],
      ['stray', stray],
    ];
    for (const [name, mint] of Object.entries(names.mints)) roles.push([`mint:${name}`, mint]);
    for (const [name, vault] of Object.entries(names.vaults)) roles.push([`vault:${name}`, vault]);
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
        entries: Object.fromEntries(
          Object.entries(PRICES).map(([name, p]) => [
            name,
            {
              index: p.index,
              usdPerToken: decimal(p.value, p.exponent),
              ageSeconds: Number(p.age),
            },
          ]),
        ) as Fixture['prices']['entries'],
        emptyIndex: EMPTY_INDEX,
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
