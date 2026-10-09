import { mockCashId } from '@colosseum/chain-mock';
import { baskets, users, vaultNumbers, vaults } from '@colosseum/db';
import {
  type ChainId,
  PortfolioHistoryResponse,
  PortfolioPlan,
  PortfolioPlansResponse,
  PortfolioResponse,
  VaultResponse,
} from '@colosseum/schemas';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import { orderFlow } from '../../testing/flow';
import {
  type Person,
  type PersonKind,
  person,
  planFixture,
  signIn,
  type TestIssuer,
  testApp,
  testDb,
  testIssuer,
} from '../../testing/harness';
import { seedSnapshot, seedVault } from '../../testing/portfolio-world';

// A vault's number among its person's vaults (gate VAULT-NUMBER): what a vault with no name is called
// by, "Vault #N". Through HTTP on the mock chains and the real database: that the count runs across
// both chains, that a number once given never changes, and that only the owner is answered it. The
// order and the arithmetic alone are portfolio/numbers.test.ts.

vi.setConfig({ testTimeout: 60_000 });

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
let plans: { solana: string; robinhood: string };
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('vault-number');
  data = await testDb();
  undo.push(() => data.cleanUp());
  plans = {
    solana: await data.storePlan(planFixture('solana')),
    robinhood: await data.storePlan(planFixture('robinhood')),
  };
  ({ app, registry } = await testApp({ issuer: issuer.issuer, db: data.db }));
  undo.push(() => app.close());
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const { put, fund, order, settleAll } = orderFlow({
  app: () => app,
  registry: () => registry,
  // Every buy here names a plan of its own (`open`): a plan opens one vault, and these people hold
  // several. These two are the flow's defaults and nothing buys them.
  plans: () => plans,
});

const someone = async (kind: PersonKind = 'solana') => data.track(await person(issuer, kind));
/** A person with a wallet of each family, as they act on one of their chains. */
const on = (p: Person, chain: 'solana' | 'robinhood'): Person => ({ ...p, chain });
const day = (n: number) => new Date(Date.UTC(2026, 8, n));

/**
 * A vault the person opens by buying a plan of its own, taken through every step: the cache holds it,
 * joined to the plan, from the step that opens it. `openedAt` moves the time the join holds for the
 * order that opened it, which is what vaults numbered together are put in order by.
 */
async function open(who: Person, openedAt?: Date) {
  const chain = who.chain;
  if (!chain) throw new Error('say which chain');
  const proposalId = await data.storePlan(planFixture(chain));
  const placed = await order(who, { amountUsd: 100, proposalId });
  expect((await settleAll(who, placed)).status).toBe('done');
  const [vault] = await data.db
    .select()
    .from(vaults)
    .where(inArray(vaults.owner, [who.solana, who.evm]))
    .then((rows) => rows.filter((v) => v.onchainBasketId === placed.basketId));
  if (!vault?.basketId) throw new Error('the cache has no joined vault for this buy');
  if (openedAt)
    await data.db
      .update(baskets)
      .set({ createdAt: openedAt })
      .where(eq(baskets.id, vault.basketId));
  return { chain, address: vault.address };
}

type Who = Pick<Person, 'headers'>;
const ask = (who: Who | null, url: string) =>
  app.inject({ method: 'GET', url, headers: who?.headers ?? {} });

async function plansOf(who: Who, query = '') {
  const res = await ask(who, `/v1/portfolio/plans${query}`);
  expect(res.statusCode, res.body).toBe(200);
  const plans = PortfolioPlansResponse.parse(res.json()).chains.flatMap((c) => c.plans);
  return { plans, body: res.body, numbers: new Map(plans.map((p) => [p.address, p.number])) };
}

async function portfolioOf(who: Who) {
  const res = await ask(who, '/v1/portfolio');
  expect(res.statusCode, res.body).toBe(200);
  const answer = PortfolioResponse.parse(res.json());
  const held = answer.chains.flatMap((c) => c.vaults);
  return { answer, body: res.body, numbers: new Map(held.map((v) => [v.address, v.number])) };
}

async function vaultOf(who: Who | null, vault: { chain: ChainId; address: string }) {
  const res = await ask(who, `/v1/vaults/${vault.chain}/${vault.address}`);
  expect(res.statusCode, res.body).toBe(200);
  return { answer: VaultResponse.parse(res.json()), raw: res.json(), headers: res.headers };
}

/** The rows the person's numbers are kept in. */
const kept = async (who: Person) =>
  data.db
    .select({ address: vaultNumbers.address, number: vaultNumbers.number })
    .from(vaultNumbers)
    .innerJoin(users, eq(users.id, vaultNumbers.userId))
    .where(eq(users.privyId, who.sub));

describe('a vault’s number', () => {
  it('counts a person’s vaults from 1 across both chains, oldest first, whatever the request narrows to', async () => {
    const p = await someone('passkey');
    await fund(on(p, 'solana'));
    await fund(on(p, 'robinhood'));
    // Bought on Solana first, but the order that opened the Robinhood Chain vault is the older one.
    const solana = await open(on(p, 'solana'), day(20));
    const robinhood = await open(on(p, 'robinhood'), day(10));
    // And a vault no order of theirs opened: one made outside the app.
    const outside = await seedVault(data.db, { chain: 'solana', owner: p.solana });

    // The first read ever, and it asks for one chain only: the count is still the person's whole one.
    const narrowed = await plansOf(p, '?chain=solana');
    expect(Object.fromEntries(narrowed.numbers)).toEqual({ [solana.address]: 2, [outside]: 3 });
    const whole = await plansOf(p);
    expect(whole.numbers.get(robinhood.address)).toBe(1);
    expect(whole.numbers.get(solana.address)).toBe(2);
    expect(whole.numbers.get(outside)).toBe(3);

    // The portfolio reads the chains, and says the same numbers of the vaults they show.
    const read = await portfolioOf(p);
    expect(read.numbers.get(robinhood.address)).toBe(1);
    expect(read.numbers.get(solana.address)).toBe(2);

    // And so does a vault's history.
    await seedSnapshot(data.db, {
      chain: 'solana',
      address: solana.address,
      owner: p.solana,
      observedAt: new Date(Date.now() - 60_000),
    });
    const history = await ask(p, '/v1/portfolio/history?step=10m');
    expect(history.statusCode, history.body).toBe(200);
    const series = PortfolioHistoryResponse.parse(history.json()).chains.flatMap((c) => c.vaults);
    expect(series.map((s) => [s.address, s.number])).toEqual([[solana.address, 2]]);
  });

  it('is there for a vault with a name too: what to show is the reader’s to decide', async () => {
    const a = await someone();
    await fund(a);
    const vault = await open(a);
    expect((await plansOf(a)).numbers.get(vault.address)).toBe(1);
    const named = await put(a, `/v1/vaults/solana/${vault.address}/name`, { name: 'House fund' });
    expect(named.statusCode, named.body).toBe(200);
    const [plan] = (await plansOf(a)).plans;
    expect([plan?.name, plan?.number]).toEqual(['House fund', 1]);
    const [held] = (await portfolioOf(a)).answer.chains.flatMap((c) => c.vaults);
    expect([held?.name, held?.number]).toEqual(['House fund', 1]);
  });

  it('adds the number to an entry and changes nothing else of it', async () => {
    const a = await someone();
    const address = await seedVault(data.db, { chain: 'solana', owner: a.solana });
    const res = await ask(a, '/v1/portfolio/plans');
    const [entry] = (
      res.json() as { chains: { plans: Record<string, unknown>[] }[] }
    ).chains.flatMap((c) => c.plans);
    expect(entry?.address).toBe(address);
    expect(entry?.number).toBe(1);
    expect(Object.keys(entry ?? {}).sort()).toEqual(Object.keys(PortfolioPlan.shape).sort());
  });
});

describe('a number never changes', () => {
  it('when a chain cannot be read, and a vault opened meanwhile takes the next one', async () => {
    const p = await someone('passkey');
    await fund(on(p, 'solana'));
    await fund(on(p, 'robinhood'));
    const robinhood = await open(on(p, 'robinhood'), day(1));
    const solana = await open(on(p, 'solana'), day(2));
    const before = await portfolioOf(p);
    expect([before.numbers.get(robinhood.address), before.numbers.get(solana.address)]).toEqual([
      1, 2,
    ]);

    const down = vi
      .spyOn(registry.get('robinhood').adapter, 'getVaults')
      .mockRejectedValue(new Error('the node did not answer'));
    try {
      const without = await portfolioOf(p);
      expect(without.answer.unavailable.map((u) => u.chain)).toEqual(['robinhood']);
      expect(without.answer.chains.map((c) => c.chain)).toEqual(['solana']);
      // The one vault the answer lists is not "Vault #1" for being the only one listed.
      expect([...without.numbers]).toEqual([[solana.address, 2]]);
      // A vault opened while the other chain is down takes the next number, not a counted one.
      const second = await open(on(p, 'solana'));
      const now = await portfolioOf(p);
      expect(now.numbers.get(solana.address)).toBe(2);
      expect(now.numbers.get(second.address)).toBe(3);
      down.mockRestore();
      const after = await portfolioOf(p);
      expect(after.numbers.get(robinhood.address)).toBe(1);
      expect(after.numbers.get(solana.address)).toBe(2);
      expect(after.numbers.get(second.address)).toBe(3);
    } finally {
      down.mockRestore();
    }
  });

  it('when a vault is emptied, and a vault that is gone leaves its number unused', async () => {
    const a = await someone();
    await fund(a);
    const first = await open(a, day(1));
    const second = await open(a, day(2));
    expect([...(await plansOf(a)).numbers.values()].sort()).toEqual([1, 2]);

    // Emptied: it holds nothing and is worth nothing, and it is still the person's first vault.
    await data.db
      .update(vaults)
      .set({
        valueUsd: '0.00',
        targets: [],
        balances: {
          cash: { asset: mockCashId('solana'), raw: '0', multiplier: '1', display: '0' },
          positions: [],
        },
      })
      .where(eq(vaults.address, first.address));
    expect((await plansOf(a)).numbers.get(first.address)).toBe(1);

    // Gone from what the server holds: the vaults left keep their numbers, and the next vault does
    // not take the one that was given.
    await data.db.delete(vaults).where(eq(vaults.address, second.address));
    expect([...(await plansOf(a)).numbers]).toEqual([[first.address, 1]]);
    const third = await open(a);
    const read = await plansOf(a);
    expect(read.numbers.get(first.address)).toBe(1);
    expect(read.numbers.get(third.address)).toBe(3);
    expect((await kept(a)).map((row) => row.number).sort()).toEqual([1, 2, 3]);
  });

  it('when a wallet is added to the person later: its vaults take the next numbers, however old they are', async () => {
    const p = await someone('passkey');
    // First the person signs in with their Solana wallet alone.
    const solo: Person = {
      ...p,
      chain: 'solana',
      owner: { solana: p.solana },
      headers: await signIn(issuer, p.sub, [
        { family: 'solana', address: p.solana, client: 'privy' },
      ]),
    };
    await fund(solo);
    const solana = await open(solo, day(20));
    expect([...(await plansOf(solo)).numbers]).toEqual([[solana.address, 1]]);

    // A vault of their EVM wallet, opened long before, which the server holds from before the wallet
    // was theirs here.
    const [user] = await data.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.privyId, p.sub));
    if (!user) throw new Error('the person has no user row');
    const [older] = await data.db
      .insert(baskets)
      .values({ userId: user.id, kind: 'personal', createdAt: day(1) })
      .returning({ id: baskets.id });
    const evm = await seedVault(data.db, {
      chain: 'robinhood',
      owner: p.evm,
      basketId: older?.id ?? null,
    });
    // While the wallet is not theirs, its vault is not counted, and nothing says it is there.
    const still = await plansOf(solo);
    expect([...still.numbers]).toEqual([[solana.address, 1]]);
    expect(still.body).not.toContain(evm);

    // With both wallets: the older vault is their second, and the first keeps its number.
    const both = await plansOf(p);
    expect(both.numbers.get(solana.address)).toBe(1);
    expect(both.numbers.get(evm)).toBe(2);
    // And signed in with the one wallet again, the answer is as it was.
    expect([...(await plansOf(solo)).numbers]).toEqual([[solana.address, 1]]);
  });

  it('when the person’s reads arrive together: each vault is numbered once', async () => {
    const a = await someone();
    const addresses = await Promise.all(
      [1, 2, 3].map(() => seedVault(data.db, { chain: 'solana', owner: a.solana })),
    );
    const reads = await Promise.all([1, 2, 3, 4, 5].map(() => plansOf(a)));
    const [first] = reads;
    for (const read of reads)
      expect(Object.fromEntries(read.numbers)).toEqual(Object.fromEntries(first?.numbers ?? []));
    expect([...(first?.numbers.values() ?? [])].sort()).toEqual([1, 2, 3]);
    const rows = await kept(a);
    expect(rows.map((row) => row.address).sort()).toEqual([...addresses].sort());
    expect(rows.map((row) => row.number).sort()).toEqual([1, 2, 3]);
  });
});

describe('a number is its owner’s alone', () => {
  it('is answered on the vault’s own page to the owner, and to nobody else', async () => {
    const owner = await someone();
    await fund(owner);
    await open(owner, day(1));
    const vault = await open(owner, day(2));
    const visitor = await someone();
    await fund(visitor);
    const theirs = await open(visitor);

    const mine = await vaultOf(owner, vault);
    expect(mine.answer.vault.number).toBe(2);
    expect(mine.headers['cache-control']).toBe('private, no-store');

    // Asked a moment later, so from the answer the route keeps: the owner's number is not in it.
    const anybody = await vaultOf(null, vault);
    expect(anybody.raw.vault).not.toHaveProperty('number');
    // A signed-in person who has vaults and numbers of their own is a visitor here all the same.
    const signedIn = await vaultOf(visitor, vault);
    expect(signedIn.raw.vault).not.toHaveProperty('number');
    expect((await vaultOf(visitor, theirs)).answer.vault.number).toBe(1);

    // The number is all the owner's answer adds.
    const { number: _number, ...rest } = mine.raw.vault;
    expect({ ...mine.raw, vault: rest }).toEqual(anybody.raw);
    expect(signedIn.raw).toEqual(anybody.raw);

    // And no list of the visitor's says anything of the owner's vaults.
    for (const body of [(await plansOf(visitor)).body, (await portfolioOf(visitor)).body])
      expect(body).not.toContain(vault.address);
    expect([...(await plansOf(visitor)).numbers]).toEqual([[theirs.address, 1]]);
  });

  it('gives a vault the owner has not been shown by the server no number, and still answers it', async () => {
    const owner = await someone();
    await fund(owner);
    const vault = await open(owner);
    // As a vault the cache does not hold: the chain shows it, the server never listed it.
    await data.db.delete(vaults).where(eq(vaults.address, vault.address));
    const read = await vaultOf(owner, vault);
    expect(read.raw.vault).not.toHaveProperty('number');
    expect(read.answer.vault.owner).toBe(owner.solana);
  });
});
