import { type Db, users } from '@colosseum/db';
import {
  ChainError,
  FundingResponse,
  OrderDetail,
  OrderError,
  PersonResponse,
  PortfolioResponse,
} from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import { personChain } from '../../orders/person';
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

// API-2: the person's current chain, and what their wallet is missing there.
// - CHAIN-SWITCH: the current chain is where new plans are made. Someone who connected an outside
//   wallet starts on the chain of that wallet's family; someone who made a wallet in the app picks it.
//   Either may switch to a chain a wallet of theirs signs on. Each plan stays on its own chain.
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

describe('the current chain, where new plans are made (gates ONE-CHAIN, CHAIN-SWITCH)', () => {
  const vaultsOf = async (who: Pick<Person, 'headers'>) => {
    const res = await get(who as Person, '/v1/portfolio');
    expect(res.statusCode, res.body).toBe(200);
    return PortfolioResponse.parse(res.json()).chains.map((c) => [c.chain, c.vaults.length]);
  };

  it('starts on the chain of the outside wallet a person connected', async () => {
    const [sol, rh] = [await someone('solana'), await someone('robinhood')];
    expect(await me(sol)).toEqual({
      userId: sol.sub,
      wallets: [{ family: 'solana', address: sol.solana, kind: 'external' }],
      chain: 'solana',
      chainSource: 'wallet',
      chainOptions: ['solana'],
    });
    // An EVM wallet means Robinhood Chain while Base is not deployed. The address is in its one form.
    expect(await me(rh)).toEqual({
      userId: rh.sub,
      wallets: [{ family: 'evm', address: rh.evm, kind: 'external' }],
      chain: 'robinhood',
      chainSource: 'wallet',
      chainOptions: ['robinhood'],
    });
    // It is stored the first time the wallet names it, with no pick time: it came from the wallet.
    expect(await storedPick(sol)).toMatchObject({ chainId: 'solana', chainPickedAt: null });
    expect(await storedPick(rh)).toMatchObject({ chainId: 'robinhood', chainPickedAt: null });
  });

  it('stands whatever wallets are linked later, until the person switches', async () => {
    // A person signs in with an outside Solana wallet, which names their chain, and buys.
    const sol = await someone('solana');
    expect(await me(sol)).toMatchObject({ chain: 'solana', chainSource: 'wallet' });
    await fund(sol);
    expect((await settleAll(sol, await order(sol, { amountUsd: 100 }))).status).toBe('done');
    expect(await vaultsOf(sol)).toEqual([['solana', 1]]);

    // Later their identity token lists an outside EVM wallet as well. The wallets alone would name no
    // single chain now; the chain they have stands, and Robinhood Chain is one they may switch to.
    const later = {
      headers: await signIn(issuer, sol.sub, [
        { family: 'solana', address: sol.solana, client: 'phantom' },
        { family: 'evm', address: sol.evm, client: 'phantom' },
      ]),
    };
    expect(await me(later)).toMatchObject({
      chain: 'solana',
      chainSource: 'wallet',
      chainOptions: ['solana', 'robinhood'],
    });
    // Signing in with the EVM wallet alone does not move them either.
    const evmOnly = {
      headers: await signIn(issuer, sol.sub, [
        { family: 'evm', address: sol.evm, client: 'metamask' },
      ]),
    };
    expect(await me(evmOnly)).toMatchObject({
      chain: 'solana',
      chainSource: 'wallet',
      chainOptions: ['robinhood'],
    });
    expect(await storedPick(sol)).toMatchObject({ chainId: 'solana', chainPickedAt: null });

    // A wallet that signs on both families switches to Robinhood Chain.
    const before = Date.now();
    const switched = await pick(later, 'robinhood');
    expect([switched.statusCode, PersonResponse.parse(switched.json())]).toEqual([
      200,
      expect.objectContaining({
        chain: 'robinhood',
        chainSource: 'picked',
        chainOptions: ['solana', 'robinhood'],
      }),
    ]);
    const row = await storedPick(sol);
    expect(row?.chainId).toBe('robinhood');
    expect(row?.chainPickedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // Their Solana vault is still theirs to see, beside the chain they are on now.
    expect(await vaultsOf(later)).toEqual([
      ['solana', 1],
      ['robinhood', 0],
    ]);
    // And the Solana plan is still bought on Solana.
    const again = await post(later as Person, '/v1/orders', {
      type: 'buy',
      owner: { solana: sol.solana },
      amountUsd: 50,
      proposalId: plans.solana,
    });
    expect(again.statusCode, again.body).toBe(200);
    expect([...new Set(OrderDetail.parse(again.json()).legs.map((l) => l.chain))]).toEqual([
      'solana',
    ]);
  });

  it('is nothing yet for a person who made their wallets in the app, until they pick', async () => {
    const who = await someone('passkey');
    expect(await me(who)).toMatchObject({
      chain: null,
      chainSource: null,
      chainOptions: ['solana', 'robinhood'],
    });
    // Until then nothing that is made on the current chain goes on, and the answer says what to do.
    const refusal = {
      error: 'pick the chain for your new plans first',
      fix: 'Pick Solana or Robinhood Chain with PUT /v1/me/chain. You can switch later.',
      details: { retryable: false },
    };
    const funding = await get(who, '/v1/funding');
    expect([funding.statusCode, OrderError.parse(funding.json())]).toEqual([409, refusal]);
    // What needs no current chain goes on: the portfolio lists every chain they hold a wallet for, and
    // a stored plan is bought on its own chain.
    expect(await vaultsOf(who)).toEqual([
      ['solana', 0],
      ['robinhood', 0],
    ]);
    const buy = await post(who, '/v1/orders', {
      type: 'buy',
      owner: who.owner,
      amountUsd: 1000,
      proposalId: plans.robinhood,
    });
    expect(buy.statusCode, buy.body).toBe(200);
    expect([...new Set(OrderDetail.parse(buy.json()).legs.map((l) => l.chain))]).toEqual([
      'robinhood',
    ]);
  });

  it('is picked, stored on the user, and switched when the person asks', async () => {
    const who = await someone('passkey');
    const before = Date.now();
    const res = await pick(who, 'robinhood');
    expect(res.statusCode, res.body).toBe(200);
    const answer = {
      userId: who.sub,
      chain: 'robinhood',
      chainSource: 'picked',
      chainOptions: ['solana', 'robinhood'],
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
    // Another chain is a switch: stored, with the time of the switch.
    const other = await pick(who, 'solana');
    expect([other.statusCode, other.json()]).toEqual([200, { ...res.json(), chain: 'solana' }]);
    expect((await me(who)).chain).toBe('solana');
    const switched = await storedPick(who);
    expect(switched?.chainId).toBe('solana');
    expect(switched?.chainPickedAt?.getTime()).toBeGreaterThanOrEqual(
      row?.chainPickedAt?.getTime() ?? 0,
    );
    // And back.
    expect((await pick(who, 'robinhood')).json().chain).toBe('robinhood');
    expect((await storedPick(who))?.chainId).toBe('robinhood');
  });

  it('of two switches at the same moment, the row holds one and the person reads it', async () => {
    for (let i = 0; i < 8; i++) {
      const who = await someone('passkey');
      const both = await Promise.all([pick(who, 'solana'), pick(who, 'robinhood')]);
      expect(both.map((r) => r.statusCode)).toEqual([200, 200]);
      const stored = (await storedPick(who))?.chainId;
      expect(['solana', 'robinhood']).toContain(stored);
      expect((await me(who)).chain).toBe(stored);
    }
  });

  it('a chain an outside wallet names never undoes a pick, even read a moment too early', async () => {
    const who = await picked('robinhood');
    const row = await storedPick(who);
    // The person signs in with an outside Solana wallet, and the look at the user is taken as if
    // before the pick was stored: it sees no chain, so the wallet names Solana and it is written.
    // The row refuses that write, and the answer is what the row holds.
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
      wallets: [{ family: 'solana' as const, address: who.solana, kind: 'external' as const }],
      ip: '',
    };
    expect(await personChain(lagging, principal)).toEqual({
      chain: 'robinhood',
      chainSource: 'picked',
      chainOptions: ['solana'],
    });
    expect(stale).toBe(false);
    expect(await storedPick(who)).toEqual(row);
  });

  it('takes only a chain this server offers and runs, and one a wallet of the person signs on', async () => {
    const who = await someone('passkey');
    // Base is not offered: an EVM wallet means Robinhood Chain.
    const base = await pick(who, 'base');
    expect([base.statusCode, base.json()]).toEqual([
      422,
      { error: 'Base is not a chain you can pick', fix: 'Pick Solana or Robinhood Chain.' },
    ]);
    for (const body of [{ chain: 'ethereum' }, {}, { chain: 'solana', also: 'this' }])
      expect((await put(who, '/v1/me/chain', body)).statusCode).toBe(400);
    // A wallet made in the app of one family only: no wallet of theirs signs on the other chain.
    const sub = `did:privy:test-one-family-${who.sub}`;
    const one = data.track({ ...who, sub });
    const only = {
      headers: await signIn(issuer, sub, [{ family: 'evm', address: who.evm, client: 'privy' }]),
    };
    expect(await me(only)).toMatchObject({ chain: null, chainOptions: ['robinhood'] });
    const solana = await pick(only, 'solana');
    expect([solana.statusCode, OrderError.parse(solana.json())]).toEqual([
      409,
      {
        error: 'no wallet you signed in with signs on Solana',
        code: 'NO_WALLET_FOR_CHAIN',
        fix: 'Sign in with a wallet that signs on Solana, or with a passkey.',
        details: { retryable: false },
      },
    ]);
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
    // Nor switched to.
    expect((await pick(who, 'robinhood', off.app)).statusCode).toBe(503);
    expect((await storedPick(who))?.chainId).toBe('solana');
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

  it('keeps an outside wallet of one family on its chain: an EVM wallet alone cannot sign on Solana', async () => {
    for (const [kind, own, other, otherName] of [
      ['solana', 'solana', 'robinhood', 'Robinhood Chain'],
      ['robinhood', 'robinhood', 'solana', 'Solana'],
    ] as const) {
      const who = await someone(kind);
      const same = await pick(who, own);
      expect(same.statusCode).toBe(200);
      expect(PersonResponse.parse(same.json())).toMatchObject({
        chain: own,
        chainSource: 'wallet',
        chainOptions: [own],
      });
      const refused = await pick(who, other);
      expect([refused.statusCode, refused.json()]).toEqual([
        409,
        {
          error: `no wallet you signed in with signs on ${otherName}`,
          code: 'NO_WALLET_FOR_CHAIN',
          fix: `Sign in with a wallet that signs on ${otherName}, or with a passkey.`,
          details: { retryable: false },
        },
      ]);
      // What is stored is the wallet's chain, with no pick time: the refused switch wrote nothing.
      expect(await storedPick(who)).toMatchObject({ chainId: own, chainPickedAt: null });
    }
  });

  it('asks for a pick when the wallets connected name no single chain, and lets them switch', async () => {
    const who = await someone('passkey');
    const sub = `did:privy:test-two-outside-${who.sub}`;
    const two = data.track({ ...who, sub });
    const headers = await signIn(issuer, sub, [
      { family: 'solana', address: who.solana, client: 'phantom' },
      { family: 'evm', address: who.evm, client: 'phantom' },
    ]);
    expect(await me({ headers })).toMatchObject({
      chain: null,
      chainOptions: ['solana', 'robinhood'],
    });
    expect((await pick({ headers }, 'solana')).statusCode).toBe(200);
    expect((await storedPick(two))?.chainId).toBe('solana');
    expect((await pick({ headers }, 'robinhood')).statusCode).toBe(200);
    expect((await storedPick(two))?.chainId).toBe('robinhood');
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
      chainOptions: ['solana', 'robinhood'],
    });
  });

  it('buys each plan on its own chain, whatever the current chain is', async () => {
    const who = await picked('robinhood');
    await fund(who);
    const placed = await order(who);
    expect(placed.summary).toBe('Buy $1,000.00 of your plan on Robinhood Chain');
    expect([...new Set(placed.legs.map((l) => l.chain))]).toEqual(['robinhood']);
    expect((await settleAll(who, placed)).status).toBe('done');
    expect(await vaultsOf(who)).toEqual([
      ['solana', 0],
      ['robinhood', 1],
    ]);
    const portfolio = PortfolioResponse.parse((await get(who, '/v1/portfolio')).json());
    expect(portfolio.chains[1]?.vaults[0]?.owner).toBe(who.evm);

    // The person switches to Solana. The Robinhood plan is still bought on Robinhood Chain, from
    // the EVM wallet, and its vault is still listed.
    expect((await pick(who, 'solana')).statusCode).toBe(200);
    const more = await order(who, { amountUsd: 100 });
    expect(more.summary).toBe('Buy $100.00 of your plan on Robinhood Chain');
    expect([...new Set(more.legs.map((l) => l.chain))]).toEqual(['robinhood']);
    expect(more.owner).toEqual(who.owner);
    expect(await vaultsOf(who)).toEqual([
      ['solana', 0],
      ['robinhood', 1],
    ]);
    // A plan made for Solana is bought there, and its funding is read there.
    const onSolana = { ...who, chain: 'solana' as const };
    await fund(onSolana);
    const sol = await order(onSolana);
    expect([...new Set(sol.legs.map((l) => l.chain))]).toEqual(['solana']);
    expect((await settleAll(onSolana, sol)).status).toBe('done');
    expect(await vaultsOf(who)).toEqual([
      ['solana', 1],
      ['robinhood', 1],
    ]);
  });
});

describe('GET /v1/portfolio: each chain read on its own', () => {
  it('answers the chains it can read when one cannot be read, and 503 only when none can', async () => {
    const who = await picked('solana');
    const failing = [
      vi
        .spyOn(registry.get('robinhood').adapter, 'getVaults')
        .mockRejectedValue(new ChainError('Unavailable', 'the node did not answer', true)),
    ];
    try {
      const res = await get(who, '/v1/portfolio');
      expect(res.statusCode, res.body).toBe(200);
      const body = PortfolioResponse.parse(res.json());
      expect(body.chains.map((c) => c.chain)).toEqual(['solana']);
      expect(body.unavailable).toEqual([
        {
          chain: 'robinhood',
          name: 'Robinhood Chain',
          code: 'CHAIN_UNAVAILABLE',
          error: 'the node did not answer',
          retryable: true,
        },
      ]);
      // A failure of ours is said without its text, and is worth asking again.
      failing.push(
        vi
          .spyOn(registry.get('solana').adapter, 'getVaults')
          .mockRejectedValue(new Error('a bug with a secret in it')),
      );
      const none = await get(who, '/v1/portfolio');
      expect(none.statusCode).toBe(503);
      expect(none.json()).toMatchObject({
        code: 'CHAIN_UNAVAILABLE',
        details: { retryable: true },
      });
      expect(none.body).not.toContain('a bug');
      expect(none.body).toContain('Solana could not be read just now');
    } finally {
      for (const spy of failing) spy.mockRestore();
    }
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

  it('asks about the wallet that holds plans on the plan’s own family, not the current chain’s', async () => {
    // Wallets made in the app on both families, and an outside EVM wallet; Solana was picked, so the
    // current chain names no outside wallet. A plan on Robinhood Chain is bought from the outside one.
    const who = await someone('passkey');
    const outsideEvm = who.evm.replace(/.$/, who.evm.endsWith('0') ? '1' : '0');
    const sub = `did:privy:test-family-${who.sub}`;
    data.track({ ...who, sub });
    const headers = await signIn(issuer, sub, [
      { family: 'solana', address: who.solana, client: 'privy' },
      { family: 'evm', address: who.evm, client: 'privy' },
      { family: 'evm', address: outsideEvm, client: 'metamask' },
    ]);
    const mixed = { ...who, sub, headers } as Person;
    expect((await pick(mixed, 'solana')).statusCode).toBe(200);
    const onRobinhood = (await funding(mixed, buyOf('robinhood'))).body;
    expect(onRobinhood.chain).toBe('robinhood');
    expect(onRobinhood.wallet.toLowerCase()).toBe(outsideEvm.toLowerCase());
    // on the current chain's family the picked chain still means the app's wallet
    expect((await funding(mixed, buyOf('solana'))).body.wallet).toBe(who.solana);
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
    // A plan made for another chain is read on that chain, as a buy of it would be (CHAIN-SWITCH).
    expect((await funding(who, buyOf('robinhood'))).body).toMatchObject({
      chain: 'robinhood',
      wallet: who.evm,
    });
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
