import { vaultSnapshots, vaults } from '@colosseum/db';
import { type EnvLike, type Principal, parseChainConfigs, parseFlags } from '@colosseum/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChainRegistry } from '../orders/chains';
import { type Person, person, type TestIssuer, testDb, testIssuer } from '../testing/harness';
import { seedSnapshot, seedVault, vaultAddress } from '../testing/portfolio-world';
import { frame, ownedOn, personScope } from './scope';

// Whose rows the portfolio section's routes read (scope.ts): the wallets of the identity token, on the
// chains this server runs, under each chain's own label. On the real database: other sessions write to
// it at the same time, so every test reads only the rows of the people it made.

const registryOf = (env: EnvLike = {}) =>
  createChainRegistry(parseFlags(env), parseChainConfigs(env), { seed: 'scope-test' });

/** The principal the auth plugin makes of a test person's identity token. */
const principalOf = (p: Person): Principal => ({
  kind: 'user',
  userId: p.sub,
  ip: '127.0.0.1',
  wallets: [
    ...(p.owner.solana
      ? [{ family: 'solana' as const, address: p.owner.solana, kind: 'external' as const }]
      : []),
    ...(p.owner.evm
      ? [{ family: 'evm' as const, address: p.owner.evm, kind: 'external' as const }]
      : []),
  ],
});

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;

beforeAll(async () => {
  issuer = await testIssuer('test');
  data = await testDb();
});
afterAll(() => data.cleanUp());

describe('the chains a person is read on', () => {
  it('lists only the chains of the families the person holds a wallet for', async () => {
    const solana = await person(issuer, 'solana');
    const scope = personScope(registryOf(), principalOf(solana));
    expect(scope.chains.map((c) => c.entry.chain)).toEqual(['solana']);
    expect(scope.chains[0]?.owners).toEqual([solana.solana]);
    expect(scope.unavailable).toEqual([]);
  });

  it('gives each chain the wallets of its own family and no other', async () => {
    const both = await person(issuer, 'passkey');
    const scope = personScope(registryOf(), principalOf(both));
    expect(scope.chains.map((c) => [c.entry.chain, c.owners])).toEqual([
      ['solana', [both.solana]],
      ['robinhood', [both.evm]],
    ]);
  });

  it('says a chain of the person that is switched off, and reads nothing on it', async () => {
    const both = await person(issuer, 'passkey');
    const scope = personScope(registryOf({ CHAIN_MODE_ROBINHOOD: 'off' }), principalOf(both));
    expect(scope.chains.map((c) => c.entry.chain)).toEqual(['solana']);
    expect(scope.unavailable).toEqual([
      {
        chain: 'robinhood',
        name: 'Robinhood Chain',
        code: 'CHAIN_UNAVAILABLE',
        error: 'Robinhood Chain is switched off on this server',
        retryable: false,
      },
    ]);
    // A chain the person holds no wallet for is neither read nor said to be unavailable.
    const solana = await person(issuer, 'solana');
    expect(personScope(registryOf({ CHAIN_MODE_ROBINHOOD: 'off' }), principalOf(solana))).toEqual({
      chains: [expect.objectContaining({ owners: [solana.solana] })],
      unavailable: [],
    });
  });

  it('narrows to one chain when one is named', async () => {
    const both = await person(issuer, 'passkey');
    const principal = principalOf(both);
    expect(
      personScope(registryOf(), principal, 'robinhood').chains.map((c) => c.entry.chain),
    ).toEqual(['robinhood']);
    const off = personScope(registryOf({ CHAIN_MODE_ROBINHOOD: 'off' }), principal, 'solana');
    expect(off.chains.map((c) => c.entry.chain)).toEqual(['solana']);
    expect(off.unavailable).toEqual([]);
    // A chain that is not the person's narrows the answer to nothing.
    const solana = await person(issuer, 'solana');
    expect(personScope(registryOf(), principalOf(solana), 'robinhood')).toEqual({
      chains: [],
      unavailable: [],
    });
  });

  it('opens a chain in an answer with its id, its name and the label of its figures', async () => {
    const solana = await person(issuer, 'solana');
    const [scoped] = personScope(registryOf(), principalOf(solana)).chains;
    if (!scoped) throw new Error('no chain');
    expect(frame(scoped.entry)).toEqual({ chain: 'solana', name: 'Solana', provenance: 'mock' });
  });
});

describe('the rows that are a person’s', () => {
  it('are their wallet’s, on the chain, under the chain’s label: never another person’s', async () => {
    const ann = data.track(await person(issuer, 'solana'));
    const bob = data.track(await person(issuer, 'solana'));
    const at = new Date('2026-10-01T12:00:00.000Z');
    const annVault = await seedVault(data.db, { chain: 'solana', owner: ann.solana });
    const bobVault = await seedVault(data.db, { chain: 'solana', owner: bob.solana });
    await seedSnapshot(data.db, {
      chain: 'solana',
      address: annVault,
      owner: ann.solana,
      observedAt: at,
    });
    await seedSnapshot(data.db, {
      chain: 'solana',
      address: bobVault,
      owner: bob.solana,
      observedAt: at,
    });
    // Ann's own wallet read on a test network: the same owner under another label.
    const sandboxVault = vaultAddress('solana');
    await seedVault(data.db, {
      chain: 'solana',
      owner: ann.solana,
      address: sandboxVault,
      provenance: 'sandbox',
    });
    await seedSnapshot(data.db, {
      chain: 'solana',
      address: sandboxVault,
      owner: ann.solana,
      observedAt: at,
      provenance: 'sandbox',
    });

    const [scoped] = personScope(registryOf(), principalOf(ann)).chains;
    if (!scoped) throw new Error('no chain');
    const snapshots = await data.db
      .select({ address: vaultSnapshots.address })
      .from(vaultSnapshots)
      .where(ownedOn(vaultSnapshots, scoped));
    expect(snapshots).toEqual([{ address: annVault }]);
    const cached = await data.db
      .select({ address: vaults.address })
      .from(vaults)
      .where(ownedOn(vaults, scoped));
    expect(cached).toEqual([{ address: annVault }]);

    // Bob, asking in his own name, gets his own and nothing of Ann's.
    const [bobs] = personScope(registryOf(), principalOf(bob)).chains;
    if (!bobs) throw new Error('no chain');
    const his = await data.db
      .select({ address: vaultSnapshots.address })
      .from(vaultSnapshots)
      .where(ownedOn(vaultSnapshots, bobs));
    expect(his).toEqual([{ address: bobVault }]);
  });
});
