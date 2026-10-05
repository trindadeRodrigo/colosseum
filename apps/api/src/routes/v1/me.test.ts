import { type Db, users } from '@colosseum/db';
import { FundingResponse, OrderError, PersonResponse, PortfolioResponse } from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import { Refusal } from '../../orders/errors';
import { pickChain } from '../../orders/person';
import { orderFlow } from '../../testing/flow';
import {
  type HomeChain,
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

// API-2: the chain a person's plans live on, and what their wallet is missing there.
// - CHAIN-PICK: someone who makes a wallet in the app picks the chain once, and it is stored on the
//   user. Someone who connected an outside wallet has the chain of that wallet's family.
// - GET /v1/funding: the dollar token and native gas the wallet is missing on that chain, from the
//   adapter's reads, every figure labelled.

vi.setConfig({ testTimeout: 60_000 });

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
let plans: Record<HomeChain, string>;
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('me');
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

const someone = async (kind: PersonKind) => data.track(await person(issuer, kind));
const { post, get, put, fund, order, settleAll } = orderFlow({
  app: () => app,
  registry: () => registry,
  plans: () => plans,
});

const me = async (who: Pick<Person, 'headers'>, on?: FastifyInstance) => {
  const res = await get(who as Person, '/v1/me', on);
  expect(res.statusCode, res.body).toBe(200);
  return PersonResponse.parse(res.json());
};
const pick = (who: Pick<Person, 'headers'>, chain: unknown, on?: FastifyInstance) =>
  put(who as Person, '/v1/me/chain', { chain }, on);
const storedPick = async (who: Person) => {
  const [row] = await data.db.select().from(users).where(eq(users.privyId, who.sub));
  return row ?? null;
};
/** A passkey person who has picked: the same person, now with a chain. */
async function picked(chain: HomeChain): Promise<Person> {
  const who = await someone('passkey');
  expect((await pick(who, chain)).statusCode).toBe(200);
  return { ...who, chain };
}

describe('the chain a person’s plans live on (gates ONE-CHAIN, CHAIN-PICK)', () => {
  it('is the chain of the outside wallet a person connected, with nothing to pick', async () => {
    const [sol, rh] = [await someone('solana'), await someone('robinhood')];
    expect(await me(sol)).toEqual({
      userId: sol.sub,
      wallets: [{ family: 'solana', address: sol.solana, kind: 'external' }],
      chain: 'solana',
      chainSource: 'wallet',
      chainOptions: [],
    });
    // An EVM wallet means Robinhood Chain while Base is not deployed. The address is in its one form.
    expect(await me(rh)).toEqual({
      userId: rh.sub,
      wallets: [{ family: 'evm', address: rh.evm, kind: 'external' }],
      chain: 'robinhood',
      chainSource: 'wallet',
      chainOptions: [],
    });
    // It is stored the first time the wallet names it, with no pick time: it came from the wallet.
    expect(await storedPick(sol)).toMatchObject({ chainId: 'solana', chainPickedAt: null });
    expect(await storedPick(rh)).toMatchObject({ chainId: 'robinhood', chainPickedAt: null });
  });

  it('stands once a wallet has named it, whatever wallets are linked later', async () => {
    // A person signs in with an outside Solana wallet and buys.
    const sol = await someone('solana');
    await fund(sol);
    expect((await settleAll(sol, await order(sol, { amountUsd: 100 }))).status).toBe('done');
    const vaultsOf = async (who: Pick<Person, 'headers'>) => {
      const res = await get(who as Person, '/v1/portfolio');
      expect(res.statusCode, res.body).toBe(200);
      return PortfolioResponse.parse(res.json()).chains.map((c) => [c.chain, c.vaults.length]);
    };
    expect(await vaultsOf(sol)).toEqual([['solana', 1]]);

    // Later their identity token lists an outside EVM wallet as well. The wallets alone would name no
    // single chain now; the chain they have stands, and there is nothing to pick.
    const later = {
      headers: await signIn(issuer, sol.sub, [
        { family: 'solana', address: sol.solana, client: 'phantom' },
        { family: 'evm', address: sol.evm, client: 'metamask' },
      ]),
    };
    expect(await me(later)).toMatchObject({
      chain: 'solana',
      chainSource: 'wallet',
      chainOptions: [],
    });
    const other = await pick(later, 'robinhood');
    expect([other.statusCode, other.json().error]).toEqual([
      409,
      'your plans live on Solana, the chain of the wallet you connected',
    ]);
    // Their vault is still theirs to see, and the plan still theirs to add to.
    expect(await vaultsOf(later)).toEqual([['solana', 1]]);
    const again = await post(later as Person, '/v1/orders', {
      type: 'buy',
      owner: { solana: sol.solana },
      amountUsd: 50,
      proposalId: plans.solana,
    });
    expect(again.statusCode, again.body).toBe(200);
    // Signing in with the EVM wallet alone does not move them either.
    const evmOnly = {
      headers: await signIn(issuer, sol.sub, [
        { family: 'evm', address: sol.evm, client: 'metamask' },
      ]),
    };
    expect(await me(evmOnly)).toMatchObject({ chain: 'solana', chainSource: 'wallet' });
    expect(await me(sol)).toMatchObject({ chain: 'solana', chainSource: 'wallet' });
    expect(await storedPick(sol)).toMatchObject({ chainId: 'solana', chainPickedAt: null });
  });

  it('is nothing yet for a person who made their wallets in the app, until they pick', async () => {
    const who = await someone('passkey');
    expect(await me(who)).toMatchObject({
      chain: null,
      chainSource: null,
      chainOptions: ['solana', 'robinhood'],
    });
    // Until then nothing that needs the chain goes on, and the answer says what to do.
    const refusal = {
      error: 'pick the chain your plans live on first',
      fix: 'Pick Solana or Robinhood Chain once, with PUT /v1/me/chain.',
      details: { retryable: false },
    };
    const buy = await post(who, '/v1/orders', {
      type: 'buy',
      owner: who.owner,
      amountUsd: 1000,
      proposalId: plans.solana,
    });
    expect([buy.statusCode, OrderError.parse(buy.json())]).toEqual([409, refusal]);
    for (const url of ['/v1/portfolio', '/v1/funding']) {
      const res = await get(who, url);
      expect([url, res.statusCode, res.json()]).toEqual([url, 409, refusal]);
    }
  });

  it('is picked once, stored on the user, and never changes', async () => {
    const who = await someone('passkey');
    const before = Date.now();
    const res = await pick(who, 'robinhood');
    expect(res.statusCode, res.body).toBe(200);
    const answer = {
      userId: who.sub,
      chain: 'robinhood',
      chainSource: 'picked',
      chainOptions: [],
    };
    expect(PersonResponse.parse(res.json())).toMatchObject(answer);
    expect(await me(who)).toMatchObject(answer);
    const row = await storedPick(who);
    expect(row?.chainId).toBe('robinhood');
    expect(row?.chainPickedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);

    // The same chain again answers as before and writes nothing.
    const again = await pick(who, 'robinhood');
    expect([again.statusCode, again.json()]).toEqual([200, res.json()]);
    expect((await storedPick(who))?.chainPickedAt).toEqual(row?.chainPickedAt);
    // Another chain is refused, and the pick stands.
    const other = await pick(who, 'solana');
    expect(other.statusCode).toBe(409);
    expect(other.json()).toEqual({
      error: 'the chain is picked once, and it is Robinhood Chain',
      details: { retryable: false },
    });
    expect((await me(who)).chain).toBe('robinhood');
    expect((await storedPick(who))?.chainId).toBe('robinhood');
  });

  it('of two picks at the same moment, one stands', async () => {
    for (let i = 0; i < 8; i++) {
      const who = await someone('passkey');
      const both = await Promise.all([pick(who, 'solana'), pick(who, 'robinhood')]);
      expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const won = both.find((r) => r.statusCode === 200)?.json().chain;
      expect((await me(who)).chain).toBe(won);
      expect((await storedPick(who))?.chainId).toBe(won);
    }
  });

  it('a pick that read the user a moment too early changes nothing: the first one stands', async () => {
    const who = await someone('passkey');
    expect((await pick(who, 'solana')).statusCode).toBe(200);
    const row = await storedPick(who);
    // A second pick whose look at the user was taken before the first one was stored: it sees no
    // chain, goes on to write, and the write is refused by the row itself.
    let stale = true;
    const lagging = new Proxy(data.db, {
      get(target, prop, receiver) {
        if (prop !== 'select' || !stale) return Reflect.get(target, prop, receiver);
        stale = false;
        return () => ({ from: () => ({ where: async () => [] }) });
      },
    }) as Db;
    const principal = {
      kind: 'user' as const,
      userId: who.sub,
      wallets: [
        { family: 'solana' as const, address: who.solana, kind: 'embedded' as const },
        { family: 'evm' as const, address: who.evm, kind: 'embedded' as const },
      ],
      ip: '',
    };
    const late = await pickChain(lagging, registry, principal, 'robinhood', new Date()).catch(
      (e: unknown) => e,
    );
    expect(stale).toBe(false);
    expect(late).toBeInstanceOf(Refusal);
    expect([(late as Refusal).status, (late as Refusal).message]).toEqual([
      409,
      'the chain is picked once, and it is Solana',
    ]);
    expect(await storedPick(who)).toEqual(row);
    expect((await me(who)).chain).toBe('solana');
  });

  it('takes only a chain the person holds a wallet for and this server runs', async () => {
    const who = await someone('passkey');
    // Base is not offered: an EVM wallet means Robinhood Chain.
    const base = await pick(who, 'base');
    expect([base.statusCode, base.json()]).toEqual([
      422,
      { error: 'Base is not a chain you can pick', fix: 'Pick Solana or Robinhood Chain.' },
    ]);
    for (const body of [{ chain: 'ethereum' }, {}, { chain: 'solana', also: 'this' }])
      expect((await put(who, '/v1/me/chain', body)).statusCode).toBe(400);
    // A wallet made in the app of one family only: that family's chain is all there is to pick.
    const sub = `did:privy:test-one-family-${who.sub}`;
    const one = data.track({ ...who, sub });
    const only = {
      headers: await signIn(issuer, sub, [{ family: 'evm', address: who.evm, client: 'privy' }]),
    };
    expect(await me(only)).toMatchObject({ chain: null, chainOptions: ['robinhood'] });
    expect((await pick(only, 'solana')).statusCode).toBe(422);
    expect(await storedPick(one)).toBeNull();
    // A chain that is switched off here cannot be picked, and nothing is stored.
    const off = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      env: { CHAIN_MODE_ROBINHOOD: 'off' },
    });
    const refused = await pick(who, 'robinhood', off.app);
    expect(refused.statusCode).toBe(503);
    expect(refused.json().code).toBe('CHAIN_UNAVAILABLE');
    expect(await storedPick(who)).toBeNull();
    expect((await pick(who, 'solana', off.app)).statusCode).toBe(200);
    await off.app.close();
    // Nobody signed in with a wallet: nothing to pick.
    const nobody = { headers: await signIn(issuer, `did:privy:test-none-${who.sub}`, []) };
    expect(await me(nobody)).toMatchObject({ chain: null, chainOptions: [], wallets: [] });
    const none = await pick(nobody, 'solana');
    expect([none.statusCode, none.json().error]).toEqual([
      422,
      'no wallet is linked to this sign-in',
    ]);
  });

  it('has nothing to pick for a person whose chain is that of their outside wallet', async () => {
    const sol = await someone('solana');
    const same = await pick(sol, 'solana');
    expect(same.statusCode).toBe(200);
    expect(PersonResponse.parse(same.json())).toMatchObject({
      chain: 'solana',
      chainSource: 'wallet',
    });
    const other = await pick(sol, 'robinhood');
    expect([other.statusCode, other.json().error]).toEqual([
      409,
      'your plans live on Solana, the chain of the wallet you connected',
    ]);
    // What is stored is the wallet's chain, with no pick time: the refused pick wrote nothing.
    expect(await storedPick(sol)).toMatchObject({ chainId: 'solana', chainPickedAt: null });
  });

  it('asks for a pick when the wallets connected name no single chain', async () => {
    const who = await someone('passkey');
    const sub = `did:privy:test-two-outside-${who.sub}`;
    const two = data.track({ ...who, sub });
    const headers = await signIn(issuer, sub, [
      { family: 'solana', address: who.solana, client: 'phantom' },
      { family: 'evm', address: who.evm, client: 'metamask' },
    ]);
    expect(await me({ headers })).toMatchObject({
      chain: null,
      chainOptions: ['solana', 'robinhood'],
    });
    expect((await pick({ headers }, 'solana')).statusCode).toBe(200);
    expect((await storedPick(two))?.chainId).toBe('solana');
    // An outside wallet beside wallets made in the app: the outside one names the chain.
    const mixedSub = `did:privy:test-mixed-${who.sub}`;
    data.track({ ...who, sub: mixedSub });
    const mixed = await signIn(issuer, mixedSub, [
      { family: 'solana', address: who.solana, client: 'privy' },
      { family: 'evm', address: who.evm, client: 'privy' },
      { family: 'evm', address: who.evm.replace(/.$/, '0'), client: 'metamask' },
    ]);
    expect(await me({ headers: mixed })).toMatchObject({
      chain: 'robinhood',
      chainSource: 'wallet',
    });
  });

  it('is where the person’s orders, portfolio and funding are, and stays there', async () => {
    const who = await picked('robinhood');
    await fund(who);
    const placed = await order(who);
    expect(placed.summary).toBe('Buy $1,000.00 of your plan on Robinhood Chain');
    expect([...new Set(placed.legs.map((l) => l.chain))]).toEqual(['robinhood']);
    expect((await settleAll(who, placed)).status).toBe('done');
    const portfolio = PortfolioResponse.parse((await get(who, '/v1/portfolio')).json());
    expect(portfolio.chains.map((c) => [c.chain, c.vaults.length])).toEqual([['robinhood', 1]]);
    expect(portfolio.chains[0]?.vaults[0]?.owner).toBe(who.evm);
    // A plan made for the other chain is not theirs to buy, though they hold a wallet there.
    const elsewhere = await post(who, '/v1/orders', {
      type: 'buy',
      owner: who.owner,
      amountUsd: 1000,
      proposalId: plans.solana,
    });
    expect(elsewhere.statusCode).toBe(422);

    // The same person signs in again, now with an outside Solana wallet beside the wallets made in
    // the app. The pick stands: the plan lives where it was put.
    const later = {
      headers: await signIn(issuer, who.sub, [
        { family: 'solana', address: who.solana, client: 'phantom' },
        { family: 'evm', address: who.evm, client: 'privy' },
      ]),
    };
    expect(await me(later)).toMatchObject({ chain: 'robinhood', chainSource: 'picked' });
    const still = PortfolioResponse.parse((await get(later as Person, '/v1/portfolio')).json());
    expect(still.chains.map((c) => [c.chain, c.vaults.length])).toEqual([['robinhood', 1]]);
  });
});

describe('GET /v1/funding: what the wallet is missing on its chain', () => {
  const funding = async (who: Person, query = '', on?: FastifyInstance) => {
    const res = await get(who, `/v1/funding${query}`, on);
    expect(res.statusCode, res.body).toBe(200);
    return { body: FundingResponse.parse(res.json()), raw: res.body };
  };
  const buyOf = (chain: HomeChain, amountUsd = 1000, planId = plans[chain]) =>
    `?amountUsd=${amountUsd}&proposalId=${planId}`;

  it('with nothing asked: what the wallet holds, every figure labelled', async () => {
    const who = await someone('solana');
    const before = new Date();
    const { body, raw } = await funding(who);
    expect(body).toMatchObject({
      chain: 'solana',
      name: 'Solana',
      mode: 'mock',
      provenance: 'mock',
      wallet: who.solana,
      steps: 0,
      newVault: false,
      ok: true,
    });
    for (const figure of [body.cash, body.gas]) {
      // Source, time, method and the chain's label, on each figure.
      expect(figure).toMatchObject({
        source: 'chain-mock',
        provenance: 'mock',
        haveRaw: '0',
        needRaw: '0',
        missingRaw: '0',
      });
      expect(figure.method).toMatch(/read by the chain adapter/);
      expect(new Date(figure.fetchedAt).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    }
    expect(body.cash).toMatchObject({ asset: 'solana:usdc', symbol: 'USDC', decimals: 6 });
    expect(body.gas).toMatchObject({ symbol: 'SOL', decimals: 9 });
    // Nothing from the mock is ever labelled live or as a test network.
    expect(raw).not.toMatch(/"provenance":"(live|sandbox)"/);
  });

  it('for a buy: the whole deposit in the dollar token, and the fee of every step the order would have', async () => {
    // What the mock charges: 5,000 lamports a step and 6,000,000 for a new vault on Solana; twenty
    // thousand gwei a step on an EVM chain.
    const expected = {
      solana: { steps: 4, gas: '6020000', symbol: 'SOL', decimals: 9 },
      robinhood: { steps: 2, gas: '40000000000000', symbol: 'ETH', decimals: 18 },
    };
    for (const chain of ['solana', 'robinhood'] as const) {
      const who = await someone(chain);
      const want = expected[chain];
      const { body } = await funding(who, buyOf(chain));
      expect(body).toMatchObject({ chain, steps: want.steps, newVault: true, ok: false });
      expect(body.cash).toMatchObject({
        haveRaw: '0',
        needRaw: '1000000000',
        missingRaw: '1000000000',
      });
      expect(body.gas).toMatchObject({
        symbol: want.symbol,
        decimals: want.decimals,
        haveRaw: '0',
        needRaw: want.gas,
        missingRaw: want.gas,
      });
      expect(body.gas.method).toMatch(
        new RegExp(`fee of ${want.steps} step\\(s\\) and a new vault`),
      );
      // The steps counted are the order's own.
      await fund(who);
      expect((await order(who)).legs).toHaveLength(want.steps);
      // Funded: nothing is missing, and the figures say what is there.
      const funded = (await funding(who, buyOf(chain))).body;
      expect(funded.ok).toBe(true);
      expect(funded.cash).toMatchObject({ haveRaw: '10000000000', missingRaw: '0' });
      expect(funded.gas.missingRaw).toBe('0');
      expect(BigInt(funded.gas.haveRaw)).toBeGreaterThan(BigInt(want.gas));
    }
  });

  it('counts what is short of the need, and the steps of a second buy into the vault that is there', async () => {
    const who = await someone('solana');
    await fund(who, undefined, 250);
    const short = (await funding(who, buyOf('solana'))).body;
    expect(short.cash).toMatchObject({ haveRaw: '250000000', missingRaw: '750000000' });
    expect([short.gas.missingRaw, short.ok]).toEqual(['0', false]);
    // An amount the wallet covers.
    expect((await funding(who, buyOf('solana', 200))).body.ok).toBe(true);
    await settleAll(who, await order(who, { amountUsd: 200 }));
    // The vault is open now: no new vault, a deposit and three trades.
    const next = (await funding(who, buyOf('solana', 40))).body;
    expect(next).toMatchObject({ steps: 4, newVault: false, ok: true });
    expect(next.gas.needRaw).toBe('20000');
    expect(next.cash).toMatchObject({ haveRaw: '50000000', needRaw: '40000000' });
  });

  it('needs the whole deposit for a plan that keeps cash, and one step for a plan that is all cash', async () => {
    const who = await someone('solana');
    const keeps = await data.storePlan(
      planFixture('solana', { spy: 5000, nvda: 2500, gold: 2000 }),
    );
    expect((await funding(who, buyOf('solana', 1000, keeps))).body).toMatchObject({
      steps: 4,
      cash: { needRaw: '1000000000' },
    });
    const allCash = await data.storePlan(planFixture('solana', {}));
    expect((await funding(who, buyOf('solana', 1000, allCash))).body).toMatchObject({
      steps: 1,
      newVault: true,
      cash: { needRaw: '1000000000' },
      gas: { needRaw: '6005000' },
    });
  });

  it('is for the wallet’s chain, and for the wallet that holds the plan there', async () => {
    const rh = await someone('robinhood');
    expect((await funding(rh)).body).toMatchObject({
      chain: 'robinhood',
      name: 'Robinhood Chain',
      wallet: rh.evm,
      cash: { asset: 'robinhood:usdc' },
    });
    // A person who picked: the wallet made in the app, of the picked chain's family.
    const who = await picked('solana');
    expect((await funding(who)).body).toMatchObject({ chain: 'solana', wallet: who.solana });
    // Two wallets of one family: the outside one when it is what names the chain, the one made in
    // the app when the chain was picked.
    const other = (await someone('robinhood')).evm;
    const outsideSub = `did:privy:test-outside-first-${rh.sub}`;
    data.track({ ...rh, sub: outsideSub });
    const outside = {
      headers: await signIn(issuer, outsideSub, [
        { family: 'evm', address: other, client: 'metamask' },
        { family: 'evm', address: rh.evm, client: 'privy' },
      ]),
    };
    expect((await funding(outside as Person)).body.wallet).toBe(other);
    const robin = await picked('robinhood');
    const both = {
      headers: await signIn(issuer, robin.sub, [
        { family: 'evm', address: robin.evm, client: 'privy' },
        { family: 'evm', address: other, client: 'metamask' },
      ]),
    };
    expect((await funding(both as Person)).body).toMatchObject({
      chain: 'robinhood',
      wallet: robin.evm,
    });
    // A plan made for another chain is refused, as a buy of it would be.
    const elsewhere = await get(who, `/v1/funding${buyOf('robinhood')}`);
    expect(elsewhere.statusCode).toBe(422);
    expect(elsewhere.json().error).toMatch(/made for Robinhood Chain/);
  });

  it('reads the wallet the query names when it is one of the person’s, the one an order will name', async () => {
    // One person, two wallets of one family: the one made in the app holds the plan, the other is
    // an outside wallet linked beside it. An order may name either as its owner.
    const robin = await picked('robinhood');
    const outsideWallet = (await someone('robinhood')).evm;
    const both = {
      ...robin,
      headers: await signIn(issuer, robin.sub, [
        { family: 'evm', address: robin.evm, client: 'privy' },
        { family: 'evm', address: outsideWallet, client: 'metamask' },
      ]),
    } as Person;
    // Only the outside wallet is funded.
    const { adapter, mock } = registry.get('robinhood');
    if (!mock) throw new Error('robinhood is not on the mock');
    mock.fund(outsideWallet, {
      gasRaw: '1000000000000000000',
      assets: { [mock.cash]: '700000000' },
    });
    expect((await adapter.getWalletHoldings(robin.evm)).find((h) => h.asset === mock.cash)).toBe(
      undefined,
    );

    // With no wallet named, it is the one the plan is held by, and it is short.
    const held = (await funding(both, buyOf('robinhood', 500))).body;
    expect([held.wallet, held.cash.haveRaw, held.ok]).toEqual([robin.evm, '0', false]);
    // Named, the answer is for that wallet: what it holds, against the same need.
    const named = (await funding(both, `${buyOf('robinhood', 500)}&wallet=${outsideWallet}`)).body;
    expect([named.wallet, named.cash.haveRaw, named.cash.needRaw, named.cash.missingRaw]).toEqual([
      outsideWallet,
      '700000000',
      '500000000',
      '0',
    ]);
    expect(named.ok).toBe(true);
    expect((await funding(both, `?wallet=${robin.evm}`)).body.wallet).toBe(robin.evm);
    // The order that names it as its owner is the one the answer was for.
    const placed = await post(both, '/v1/orders', {
      type: 'buy',
      owner: { evm: outsideWallet },
      amountUsd: 500,
      proposalId: plans.robinhood,
    });
    expect([placed.statusCode, placed.json().owner]).toEqual([200, { evm: outsideWallet }]);

    // A wallet that is not the person's is refused before anything is read: nobody learns another
    // wallet's balance here.
    const stranger = (await someone('robinhood')).evm;
    const reads = vi.spyOn(adapter, 'funding');
    const refused = await get(both, `/v1/funding?wallet=${stranger}`);
    expect([refused.statusCode, refused.json()]).toEqual([
      403,
      { error: 'the wallet in the request is not a wallet of the signed-in person' },
    ]);
    // The person's own wallet of the other family: theirs, and not one their chain takes.
    const other = await get(robin, `/v1/funding?wallet=${robin.solana}`);
    expect([other.statusCode, other.json().error]).toEqual([
      422,
      'the wallet in the request is not an EVM wallet, and the plans of this person are on an EVM chain',
    ]);
    // Not an address at all: refused as a query that cannot be read.
    expect((await get(both, '/v1/funding?wallet=mine')).statusCode).toBe(400);
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
  });

  it('takes its figures from the adapter’s read, its time from the clock and its label from the chain', async () => {
    const who = await someone('solana');
    const at = new Date('2026-10-05T15:00:00.000Z');
    const asked: unknown[] = [];
    const wrapped = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      now: () => at,
      wrap: (inner) => ({
        ...inner,
        get: (chain) => {
          const entry = inner.get(chain);
          const read: typeof entry.adapter.funding = async (owner, need) => {
            asked.push([owner, need]);
            return {
              chain,
              cashHaveRaw: '7',
              cashNeedRaw: need.cashRaw,
              gasHaveRaw: '11',
              gasNeedRaw: '13',
              ok: false,
            };
          };
          // As a real adapter on a test network would be wired: its figures are labelled sandbox.
          return {
            ...entry,
            provenance: 'sandbox',
            source: 'solana devnet node',
            adapter: { ...entry.adapter, funding: read },
          };
        },
      }),
    });
    const { body } = await funding(who, buyOf('solana'), wrapped.app);
    expect(asked).toEqual([
      [who.solana, { cashRaw: '1000000000', legs: 4, newVault: true, newAccounts: 4 }],
    ]);
    expect(body.provenance).toBe('sandbox');
    expect(body.cash).toMatchObject({
      source: 'solana devnet node',
      provenance: 'sandbox',
      fetchedAt: at.toISOString(),
      haveRaw: '7',
      needRaw: '1000000000',
      missingRaw: '999999993',
    });
    expect(body.gas).toMatchObject({
      source: 'solana devnet node',
      provenance: 'sandbox',
      fetchedAt: at.toISOString(),
      haveRaw: '11',
      needRaw: '13',
      missingRaw: '2',
    });
    expect(body.ok).toBe(false);
    await wrapped.app.close();
  });

  it('refuses a query it cannot read, and a plan that is not there', async () => {
    const who = await someone('solana');
    const bad = [
      '?amountUsd=1000',
      `?proposalId=${plans.solana}`,
      `?amountUsd=0&proposalId=${plans.solana}`,
      `?amountUsd=1000000.01&proposalId=${plans.solana}`,
      `?amountUsd=lots&proposalId=${plans.solana}`,
      '?amountUsd=10&proposalId=not-an-id',
    ];
    for (const query of bad) {
      const res = await get(who, `/v1/funding${query}`);
      expect([query, res.statusCode]).toEqual([query, 400]);
    }
    const missing = await get(
      who,
      '/v1/funding?amountUsd=10&proposalId=4b1c0f0e-3f8e-4d0e-9d2b-0d7a3a6b1c2d',
    );
    expect([missing.statusCode, missing.json().error]).toEqual([404, 'no plan with that id']);
  });
});
