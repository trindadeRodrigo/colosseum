import { randomUUID } from 'node:crypto';
import { legAttempts, legs, orders, proposals, vaults } from '@colosseum/db';
import {
  BasketTx,
  ChainError,
  Order,
  OrderDetail,
  OrderError,
  PortfolioResponse,
} from '@colosseum/schemas';
import { eq, inArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import { basketIdOf } from '../../orders/prepare';
import { chainOf, orderFlow, type Sent, walletOf } from '../../testing/flow';
import {
  type HomeChain,
  type Person,
  type PersonKind,
  person,
  planFixture,
  type TestIssuer,
  testApp,
  testDb,
  testIssuer,
} from '../../testing/harness';

// The order routes through HTTP on the mock chain and the real database: the walking skeleton of M1,
// the identity checks of G-LINK, and what API-2 added to them. An order is on one chain, the chain of
// the person's wallet (gate ONE-CHAIN). Every test makes its own wallets and its own orders; afterAll
// deletes the rows that hang off them and nothing else.

// Every test here makes dozens of requests against a database other sessions may share. A test that
// runs past its time keeps running into the next one's mock chain, so the limit is set well above the
// slowest of them.
vi.setConfig({ testTimeout: 60_000 });

const CHAINS: HomeChain[] = ['solana', 'robinhood'];
const NAME = { solana: 'Solana', robinhood: 'Robinhood Chain' };

let issuer: TestIssuer;
let stranger: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
/** A stored plan per chain: the same three assets, nothing kept in cash. */
let plans: Record<HomeChain, string>;

// What beforeAll has made so far, to be taken away again even if it failed halfway.
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('test');
  stranger = await testIssuer('other');
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

const someone = async (kind: PersonKind = 'solana', from: TestIssuer = issuer) =>
  data.track(await person(from, kind));

const {
  call,
  post,
  get,
  put,
  fund,
  order,
  legUrl,
  build,
  land,
  report,
  read,
  legOf,
  first,
  settleAll,
  toDeposit,
  openVault,
  attemptsOf,
} = orderFlow({ app: () => app, registry: () => registry, plans: () => plans });

const mockOf = (chain: HomeChain, reg = registry) => {
  const { mock } = reg.get(chain);
  if (!mock) throw new Error('not on the mock');
  return mock;
};

describe('the walking skeleton: a buy on the chain of the person’s wallet, on the mock', () => {
  it('goes from an intent to settled legs, and reads back in the portfolio, on each chain', async () => {
    // One leg per step, in the order they are signed, all on the person's own chain. Solana opens the
    // vault with the cash, then trades one asset per transaction; Robinhood Chain approves, then opens
    // and buys in one. The step that moves the cash carries the whole deposit.
    const steps = {
      solana: [
        ['solana', 0, 'create_vault', 0, '1000000000'],
        ['solana', 1, 'swap', 1, undefined],
        ['solana', 2, 'swap', 1, undefined],
        ['solana', 3, 'swap', 1, undefined],
      ],
      robinhood: [
        ['robinhood', 0, 'approve', 0, '1000000000'],
        ['robinhood', 1, 'create_vault', 3, '1000000000'],
      ],
    };
    for (const chain of CHAINS) {
      const a = await someone(chain);
      await fund(a);

      const placed = await order(a);
      expect(Order.parse(placed)).toMatchObject({ type: 'buy', status: 'open', owner: a.owner });
      expect(placed.summary).toBe(`Deposit $1,000.00 into your plan’s vault on ${NAME[chain]}`);
      expect(placed.legs.map((l) => [l.chain, l.seq, l.kind, l.trades.length, l.cashRaw])).toEqual(
        steps[chain],
      );
      expect(placed.legs.every((l) => l.status === 'planned' && l.provenance === 'mock')).toBe(
        true,
      );
      expect(placed.legs.every((l) => l.signer === 'owner' && l.attempt === 0)).toBe(true);
      // The deposit is the dollar token only, and the trades buy the plan's assets in its proportions.
      const trades = placed.legs.flatMap((l) => l.trades);
      expect(trades.map((t) => [t.sell, t.buy, t.amountInRaw])).toEqual([
        [`${chain}:usdc`, `${chain}:spy`, '500000000'],
        [`${chain}:usdc`, `${chain}:nvda`, '300000000'],
        [`${chain}:usdc`, `${chain}:gold`, '200000000'],
      ]);
      expect(placed.attempts).toEqual([]);
      const open = placed.expiresAt - Date.parse(placed.createdAt) / 1000;
      expect(open > 15 * 60 - 2 && open <= 15 * 60).toBe(true);

      // Each leg: build it, the wallet sends it, report it.
      let latest = placed;
      for (const leg of placed.legs) {
        const { tx, attempt } = await build(a, placed, leg.id);
        expect(BasketTx.parse(tx)).toMatchObject({ legId: leg.id, attemptId: attempt.id });
        // The signer of every built transaction is the signed-in wallet of that chain.
        expect(tx.signer).toBe(walletOf(a));
        expect([tx.provenance, tx.preview.provenance, tx.legKind]).toEqual([
          'mock',
          'mock',
          leg.kind,
        ]);
        expect(attempt).toMatchObject({ legId: leg.id, n: 1, status: 'built', txId: null });
        expect(attempt.messageHash).toBe(tx.messageHash);
        // On an EVM chain the attempt is the pair (message, nonce): the nonce the build stated is stored.
        if (chain === 'solana') expect([tx.evm, attempt.nonce]).toEqual([undefined, null]);
        else {
          expect(attempt.nonce).toBe(tx.evm?.nonce);
          expect(tx.evm?.gas).toBeGreaterThan(0);
        }

        // One leg is handed over as signed bytes for the server to relay; the rest are sent by the
        // wallet and reported by id.
        const relayed = chain === 'solana' && leg.seq === 1;
        const sent = relayed ? { signedTx: tx.payload } : { txId: await land(a, placed, leg.id) };
        latest = await report(a, placed, leg.id, sent);
        const settled = legOf(latest, leg.id);
        expect(settled).toMatchObject({ status: 'confirmed', attempt: 1, error: null });
        expect(settled.txId).toBeTruthy();
        expect(settled.explorerUrl).toBe(`mock://${chain}/tx/${settled.txId}`);
      }

      expect(latest.status).toBe('done');
      expect(latest.attempts).toHaveLength(placed.legs.length);
      expect(latest.attempts.every((x) => x.status === 'confirmed' && x.n === 1 && x.txId)).toBe(
        true,
      );
      // Signed once, the order stays open for a day.
      expect(latest.expiresAt - placed.expiresAt).toBeGreaterThan(23 * 60 * 60);
      expect(await read(a, placed)).toEqual(latest);

      // The portfolio, read back from the person's chain and no other: what was bought, at its
      // targets, all labelled MOCK.
      const res = await get(a, '/v1/portfolio');
      expect(res.statusCode, res.body).toBe(200);
      const portfolio = PortfolioResponse.parse(res.json());
      expect(portfolio.chains.map((c) => [c.chain, c.mode, c.provenance, c.vaults.length])).toEqual(
        [[chain, 'mock', 'mock', 1]],
      );
      const [vault] = portfolio.chains[0]?.vaults ?? [];
      // Dollars as the shared view writes them: cut to six places, no trailing zeros.
      expect(vault).toMatchObject({ owner: walletOf(a), valueUsd: '999', provenance: 'mock' });
      // Targets that add up to the whole: nothing stays as cash.
      expect(vault?.cash.raw).toBe('0');
      expect(vault?.positions.map((p) => [p.targetBps, p.weightBps, p.driftBps])).toEqual([
        [5000, 5000, 0],
        [3000, 3000, 0],
        [2000, 2000, 0],
      ]);
      expect(vault?.positions.map((p) => p.valueUsd)).toEqual(['499.5', '299.7', '199.8']);
      const prices = portfolio.chains.flatMap((c) => c.prices);
      expect(prices).toHaveLength(4);
      expect(prices.every((p) => p.provenance === 'mock' && p.source && p.method)).toBe(true);
      expect(res.body).not.toMatch(/"provenance":"(live|sandbox)"/);

      // What was stored: an attempt per build with its label, and the vault cache the read refreshed.
      const stored = await data.db
        .select()
        .from(legAttempts)
        .where(
          inArray(
            legAttempts.legId,
            placed.legs.map((l) => l.id),
          ),
        );
      expect(stored).toHaveLength(placed.legs.length);
      expect(stored.every((r) => r.provenance === 'mock' && r.source === 'chain-mock')).toBe(true);
      const cached = await data.db
        .select()
        .from(vaults)
        .where(or(eq(vaults.owner, a.solana), eq(vaults.owner, a.evm)));
      expect(cached.map((v) => [v.chainId, v.valueUsd, v.provenance])).toEqual([
        [chain, '999.00', 'mock'],
      ]);
    }
  });

  it('buying the same plan again adds to the vault that is already there', async () => {
    const a = await someone();
    await fund(a);
    await settleAll(a, await order(a, { amountUsd: 600 }));

    const again = await order(a, { amountUsd: 100 });
    expect(again.legs.map((l) => l.kind)).toEqual(['deposit', 'swap', 'swap', 'swap']);
    expect((await settleAll(a, again)).status).toBe('done');
    const portfolio = PortfolioResponse.parse((await get(a, '/v1/portfolio')).json());
    expect(portfolio.chains.map((c) => c.vaults.map((v) => v.valueUsd))).toEqual([['699.3']]);
  });

  it('a transaction that reverts fails the leg with the chain’s reason, and a new build is a new attempt', async () => {
    const a = await someone();
    await fund(a);
    const placed = await order(a, { amountUsd: 600 });
    const leg = first(placed);
    await build(a, placed, leg.id);
    mockOf('solana').revertNext({ code: 'ReceivedTooLittle', message: 'price moved' });
    const failed = await report(a, placed, leg.id, { txId: await land(a, placed, leg.id) });
    expect(failed.status).toBe('failed');
    expect(legOf(failed, leg.id)).toMatchObject({
      status: 'failed',
      error: { code: 'ReceivedTooLittle', message: 'price moved', retryable: true },
    });

    const { attempt } = await build(a, placed, leg.id);
    expect(attempt.n).toBe(2);
    const retried = await report(a, placed, leg.id, { txId: await land(a, placed, leg.id) });
    expect(legOf(retried, leg.id)).toMatchObject({ status: 'confirmed', attempt: 2, error: null });
    expect(retried.status).toBe('open');
    expect(retried.attempts.map((x) => [x.n, x.status])).toEqual([
      [1, 'failed'],
      [2, 'confirmed'],
    ]);
  });
});

describe('one chain per order (gate ONE-CHAIN)', () => {
  it('puts every leg of a buy on the chain of the person’s wallet, and refuses a request that names a chain', async () => {
    for (const chain of CHAINS) {
      const a = await someone(chain);
      const buy = { type: 'buy', owner: a.owner, amountUsd: 1000, proposalId: plans[chain] };
      // A request cannot name a chain. The field a buy once took is refused with a sentence, not
      // ignored: a caller that still asks for a split is told, and no order is made.
      for (const chains of [CHAINS, [chain], []]) {
        const res = await post(a, '/v1/orders', { ...buy, chains });
        expect([chain, res.statusCode]).toEqual([chain, 400]);
        expect(res.json().error).toMatch(
          /a buy names no chain: an order is on the chain of the wallet, where the plan lives\. Leave `chains` out/,
        );
      }
      const made = await data.db
        .select({ id: orders.id })
        .from(orders)
        .where(or(eq(orders.ownerSolana, a.solana), eq(orders.ownerEvm, a.evm)));
      expect(made).toEqual([]);

      const placed = await order(a);
      expect([...new Set(placed.legs.map((l) => l.chain))]).toEqual([chain]);
      // The whole amount is on that chain: nothing is split off to another.
      expect(placed.depositRaw).toBe('1000000000');
    }
  });

  it('refuses a plan on a chain the owner has no wallet on, and one spread over several', async () => {
    const a = await someone('solana');
    const buy = (proposalId: string) =>
      post(a, '/v1/orders', { type: 'buy', owner: a.owner, amountUsd: 1000, proposalId });

    // The plan is bought on its own chain (CHAIN-SWITCH), and a Solana wallet cannot own a vault there.
    const elsewhere = await buy(plans.robinhood);
    expect(elsewhere.statusCode).toBe(422);
    expect(elsewhere.json().error).toBe(
      'the owner has no evm address, and this plan is on Robinhood Chain',
    );

    // A plan as API-1 took them: a recipe on each chain, the amount split 600 to 400.
    const split = planFixture('solana');
    const [recipe] = split.recipes;
    if (!recipe) throw new Error('no recipe');
    split.recipes = [
      { ...recipe, amountUsd: 600 },
      {
        chain: 'robinhood',
        amountUsd: 400,
        components: planFixture('robinhood').recipes[0]?.components ?? [],
      },
    ];
    const spread = await buy(await data.storePlan(split));
    expect(spread.statusCode).toBe(422);
    expect(spread.json().error).toMatch(/spread over 2 chains, and a plan lives on one/);

    const none = planFixture('solana');
    none.recipes = [];
    const empty = await buy(await data.storePlan(none));
    expect([empty.statusCode, empty.json().error]).toEqual([422, 'this plan names no chain']);

    // Nothing was stored for any of them.
    const made = await data.db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.ownerSolana, a.solana));
    expect(made).toEqual([]);
  });

  it('an order on one chain with a failed leg is failed, not partial, though an earlier leg settled', async () => {
    const a = await someone('solana');
    await fund(a);
    const placed = await order(a, { amountUsd: 600 });
    const [create, swap] = [first(placed, 0), first(placed, 1)];
    await build(a, placed, create.id);
    await report(a, placed, create.id, { txId: await land(a, placed, create.id) });
    await build(a, placed, swap.id);
    mockOf('solana').revertNext({ code: 'SpentTooMuch', message: 'reverted' });
    const after = await report(a, placed, swap.id, { txId: await land(a, placed, swap.id) });
    expect(after.legs.map((l) => l.status)).toEqual(['confirmed', 'failed', 'planned', 'planned']);
    expect(after.status).toBe('failed');
    const [row] = await data.db.select().from(orders).where(eq(orders.id, placed.id));
    expect(row?.status).toBe('failed');
  });

  it('reads the portfolio of the wallet’s chain only', async () => {
    const [sol, rh] = [await someone('solana'), await someone('robinhood')];
    for (const who of [sol, rh]) {
      const portfolio = PortfolioResponse.parse((await get(who, '/v1/portfolio')).json());
      expect(portfolio.chains.map((c) => [c.chain, c.name])).toEqual([
        [chainOf(who), NAME[chainOf(who)]],
      ]);
    }
  });
});

describe('sign-in', () => {
  /** Every /v1 route that needs a person, with a body that would pass if the caller were signed in. */
  const routes = (o: OrderDetail, who: Person): Sent[] => [
    {
      method: 'POST',
      url: '/v1/orders',
      payload: { type: 'buy', owner: who.owner, amountUsd: 10 },
    },
    { method: 'GET', url: `/v1/orders/${o.id}` },
    { method: 'POST', url: legUrl(o, first(o).id, 'build') },
    { method: 'POST', url: legUrl(o, first(o).id, 'report'), payload: { txId: 'x' } },
    { method: 'POST', url: legUrl(o, first(o).id, 'cancel') },
    { method: 'GET', url: '/v1/portfolio' },
    { method: 'GET', url: '/v1/me' },
    { method: 'GET', url: '/v1/me/withdrawals' },
    { method: 'PUT', url: '/v1/me/chain', payload: { chain: 'solana' } },
    { method: 'GET', url: '/v1/funding' },
    { method: 'POST', url: '/v1/mock/fund', payload: { chain: 'solana', cashUsd: 1 } },
    { method: 'POST', url: `/v1/mock/orders/${o.id}/legs/${first(o).id}/land` },
  ];

  it('refuses every route with no token, a bad token, or a token from another issuer', async () => {
    const a = await someone();
    const placed = await order(a);
    const [bearer = '', token = ''] = [a.headers.authorization, a.headers['privy-id-token']];
    const other = await person(stranger);
    // An access token that is right in everything but the claims given.
    const access = (claims: Record<string, unknown>, expiresAt?: number) =>
      issuer.sign(a.sub, { sid: 'session', ...claims }, expiresAt).then((t) => `Bearer ${t}`);
    const callers: Record<string, Record<string, string>> = {
      'no token': {},
      'no identity token': { authorization: bearer },
      'no access token': { 'privy-id-token': token },
      'not a token': { authorization: 'Bearer not-a-token', 'privy-id-token': token },
      'a token cut short': { authorization: bearer.slice(0, -6), 'privy-id-token': token },
      // Signed by a key this app does not trust, naming an issuer it does not trust.
      'another issuer': other.headers,
      // The other issuer's key, but claiming to be this issuer and this app.
      'a forged issuer': {
        authorization: `Bearer ${await stranger.sign(a.sub, { sid: 'session', iss: issuer.issuer.issuer, aud: issuer.issuer.audience })}`,
        'privy-id-token': token,
      },
      // This issuer's own key, under another issuer's name.
      'another issuer name': {
        authorization: await access({ iss: 'https://someone-else.invalid' }),
        'privy-id-token': token,
      },
      'another app': {
        authorization: await access({ aud: 'another-app' }),
        'privy-id-token': token,
      },
      'an expired token': {
        authorization: await access({}, Math.floor(Date.now() / 1000) - 60),
        'privy-id-token': token,
      },
      // The identity token in both places: it lists wallets, so it is not a session.
      'the identity token as the access token': {
        authorization: `Bearer ${token}`,
        'privy-id-token': token,
      },
      // The access token in both places: it lists no wallets.
      'the access token as the identity token': {
        authorization: bearer,
        'privy-id-token': bearer.replace('Bearer ', ''),
      },
      'an access token with no session': {
        authorization: `Bearer ${await issuer.sign(a.sub)}`,
        'privy-id-token': token,
      },
      'an identity token with no wallet list': {
        authorization: bearer,
        'privy-id-token': await issuer.sign(a.sub),
      },
      // Two valid tokens of this issuer that name different people.
      'two people': {
        authorization: (await person(issuer)).headers.authorization ?? '',
        'privy-id-token': token,
      },
    };
    for (const [name, headers] of Object.entries(callers))
      for (const sent of routes(placed, a)) {
        const res = await call({ headers }, sent);
        expect([name, sent.url, res.statusCode]).toEqual([name, sent.url, 401]);
        expect(res.json().error).toBeTruthy();
      }
    // Nothing moved: no attempt was made and the order reads as it was placed.
    expect(await read(a, placed)).toEqual(placed);
  });

  it('allows a few seconds between its clock and the issuer’s, and no more', async () => {
    const a = await someone();
    const at = (secondsAgo: number) => Math.floor(Date.now() / 1000) - secondsAgo;
    const withAccess = async (exp: number) => ({
      headers: {
        ...a.headers,
        authorization: `Bearer ${await issuer.sign(a.sub, { sid: 's' }, exp)}`,
      },
    });
    const url = '/v1/portfolio';
    expect((await call(await withAccess(at(2)), { method: 'GET', url })).statusCode).toBe(200);
    expect((await call(await withAccess(at(30)), { method: 'GET', url })).statusCode).toBe(401);
  });

  it('answers 503, never a pass, when no issuer is configured', async () => {
    const a = await someone();
    const bare = await testApp({ issuer: null, db: data.db });
    for (const sent of routes(await order(a), a))
      expect((await call(a, sent, bare.app)).statusCode).toBe(503);
    await bare.app.close();
  });

  it('takes wallets from the identity token only, in their one form', async () => {
    const a = await someone('robinhood');
    await fund(a);
    // The token lists the EVM address in upper case; the order and the built transaction carry it
    // lower-case, and a body that spells it the token's way is not an address at all.
    const shouted = { evm: `0x${a.evm.slice(2).toUpperCase()}` };
    const res = await post(a, '/v1/orders', { type: 'buy', owner: shouted, amountUsd: 10 });
    expect(res.statusCode).toBe(400);
    const placed = await order(a);
    const { tx } = await build(a, placed, first(placed).id);
    expect(tx.signer).toBe(a.evm);
  });
});

describe('what a leg is expected to pay out', () => {
  const lessBps = (raw: string, bps: number) =>
    ((BigInt(raw) * BigInt(10_000 - bps)) / 10_000n).toString();

  it('has one figure per trade, in trade order, and none for a step that trades nothing', async () => {
    for (const chain of CHAINS) {
      const a = await someone(chain);
      await fund(a);
      const placed = await order(a);
      for (const leg of placed.legs) {
        expect(leg.expected, `${leg.chain} ${leg.kind}`).toHaveLength(leg.trades.length);
        for (const [i, figure] of leg.expected.entries()) {
          expect(figure.inRaw).toBe(leg.trades[i]?.amountInRaw);
          expect(BigInt(figure.outRaw)).toBeGreaterThan(0n);
          // The server's own slippage where the request names none: 100 bps.
          expect(figure.minOutRaw).toBe(lessBps(figure.outRaw, 100));
        }
      }
      if (chain === 'robinhood') {
        // On the EVM chain the first trades ride in the create: one leg, three trades, three figures.
        expect(placed.legs.find((l) => l.kind === 'create_vault')?.expected).toHaveLength(3);
        expect(first(placed, 0)).toMatchObject({ kind: 'approve', expected: [] });
      }
      // Solana trades one a transaction: three swap legs with one figure each.
      else expect(placed.legs.map((l) => l.expected.length)).toEqual([0, 1, 1, 1]);
    }
  });

  it('shows the minimum that is in the bytes: the built transaction states it per trade', async () => {
    const a = await someone('robinhood');
    await fund(a);
    const placed = await order(a);
    const [approve, create] = [first(placed, 0), first(placed, 1)];
    const approved = await build(a, placed, approve.id);
    expect(approved.tx.preview.minimums).toEqual([]);
    await report(a, placed, approve.id, { txId: await land(a, placed, approve.id) });

    const { tx } = await build(a, placed, create.id);
    const leg = legOf(await read(a, placed), create.id);
    expect(tx.preview.minimums).toEqual(
      leg.trades.map((t, i) => ({
        sell: t.sell,
        buy: t.buy,
        inRaw: t.amountInRaw,
        minOutRaw: leg.expected[i]?.minOutRaw,
      })),
    );
    expect(leg.expected).toHaveLength(3);
  });

  it('builds with the slippage the buy asked for, up to the cap and no further', async () => {
    const a = await someone();
    await fund(a);
    const tight = await order(a, { amountUsd: 600, maxSlippageBps: 25 });
    const swaps = tight.legs.filter((l) => l.kind === 'swap');
    expect(swaps).toHaveLength(3);
    for (const leg of swaps)
      expect(leg.expected[0]?.minOutRaw).toBe(lessBps(leg.expected[0]?.outRaw ?? '0', 25));
    // The same figure is in the bytes of the build.
    const create = first(tight, 0);
    await build(a, tight, create.id);
    await report(a, tight, create.id, { txId: await land(a, tight, create.id) });
    const swap = first(tight, 1);
    const { tx } = await build(a, tight, swap.id);
    const built = legOf(await read(a, tight), swap.id);
    expect(tx.preview.minimums?.[0]?.minOutRaw).toBe(lessBps(built.expected[0]?.outRaw ?? '0', 25));
    expect(built.expected[0]?.minOutRaw).toBe(tx.preview.minimums?.[0]?.minOutRaw);

    const buy = { type: 'buy', owner: a.owner, amountUsd: 600, proposalId: plans.solana };
    expect((await post(a, '/v1/orders', { ...buy, maxSlippageBps: 300 })).statusCode).toBe(200);
    expect((await post(a, '/v1/orders', { ...buy, maxSlippageBps: 301 })).statusCode).toBe(400);
    expect((await post(a, '/v1/orders', { ...buy, maxSlippageBps: -1 })).statusCode).toBe(400);
  });

  it('answers every refusal in the one shared shape', async () => {
    const a = await someone();
    const placed = await order(a);
    // No cash yet: the chain's own code and whether to try again travel in details.
    const refused = await post(a, legUrl(placed, first(placed).id, 'build'));
    expect(refused.statusCode).toBe(409);
    expect(OrderError.parse(refused.json())).toEqual(refused.json());
    expect(refused.json()).toMatchObject({
      code: 'NOT_FUNDED',
      details: { chainCode: 'NotFunded', retryable: false },
    });
    const missing = await get(a, '/v1/orders/4b1c0f0e-3f8e-4d0e-9d2b-0d7a3a6b1c2d');
    expect(OrderError.parse(missing.json())).toEqual({ error: 'no order with that id' });
  });
});

describe('ownership: an order belongs to the wallets that made it', () => {
  it('wallet B cannot read, build, report or land wallet A’s order', async () => {
    const [a, b] = [await someone(), await someone()];
    await fund(a);
    const placed = await order(a);
    const leg = first(placed);
    const { tx } = await build(a, placed, leg.id);
    const before = await read(a, placed);

    const tries: Sent[] = [
      { method: 'GET', url: `/v1/orders/${placed.id}` },
      { method: 'POST', url: legUrl(placed, leg.id, 'build') },
      { method: 'POST', url: legUrl(placed, leg.id, 'report'), payload: { signedTx: tx.payload } },
      { method: 'POST', url: legUrl(placed, leg.id, 'report'), payload: { txId: 'anything' } },
      { method: 'POST', url: legUrl(placed, leg.id, 'cancel') },
      { method: 'POST', url: `/v1/mock/orders/${placed.id}/legs/${leg.id}/land` },
    ];
    // The same answer as for an order that does not exist: B learns nothing from the id.
    const missing = await get(b, '/v1/orders/4b1c0f0e-3f8e-4d0e-9d2b-0d7a3a6b1c2d');
    for (const sent of tries) {
      const res = await call(b, sent);
      expect([sent.url, res.statusCode]).toEqual([sent.url, 404]);
      expect(res.body).toBe(missing.body);
    }
    expect(await read(a, placed)).toEqual(before);
    // B sees nothing of A's in their own portfolio either.
    const mine = PortfolioResponse.parse((await get(b, '/v1/portfolio')).json());
    expect(mine.chains.flatMap((c) => c.vaults)).toEqual([]);
  });

  it('hands out no transaction whose signer is not the order’s own wallet', async () => {
    const [a, b] = [await someone('robinhood'), await someone('robinhood')];
    // An adapter that builds for somebody else, whatever it is asked.
    const wrong = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      wrap: (inner) => ({
        ...inner,
        get: (chain) => {
          const entry = inner.get(chain);
          const buildApprove: typeof entry.adapter.buildApprove = (args) =>
            entry.adapter.buildApprove({ ...args, owner: b.evm });
          return { ...entry, adapter: { ...entry.adapter, buildApprove } };
        },
      }),
    });
    const placed = await order(a, { amountUsd: 400 }, wrong.app);
    const leg = first(placed);
    const res = await post(a, legUrl(placed, leg.id, 'build'), undefined, wrong.app);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(b.evm);
    const after = OrderDetail.parse((await get(a, `/v1/orders/${placed.id}`, wrong.app)).json());
    expect(after.attempts).toEqual([]);
    expect(legOf(after, leg.id).status).toBe('planned');
    await wrong.app.close();
  });

  it('refuses an owner in the body that the token does not carry', async () => {
    // Both hold a wallet of each family, so the owner claimed is the only thing wrong.
    const [a, b] = [await someone('passkey'), await someone('passkey')];
    const claims = [a.owner, { solana: a.solana }, { solana: b.solana, evm: a.evm }];
    for (const owner of claims) {
      const res = await post(b, '/v1/orders', {
        type: 'buy',
        owner,
        amountUsd: 1000,
        proposalId: plans.solana,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/not a wallet of the signed-in person/);
    }
    // An address of the other family that the token does not list is refused the same way.
    const sol = await someone('solana');
    const half = await post(sol, '/v1/orders', {
      type: 'buy',
      owner: { solana: sol.solana, evm: sol.evm },
      amountUsd: 1000,
      proposalId: plans.solana,
    });
    expect(half.statusCode).toBe(403);
    const made = await data.db
      .select({ id: orders.id })
      .from(orders)
      .where(or(eq(orders.ownerSolana, a.solana), eq(orders.ownerEvm, a.evm)));
    expect(made).toEqual([]);
  });
});

describe('a leg settles only on the transaction that was built for it', () => {
  it('an unrelated transaction, successful or not, does not confirm a leg, on both chain families', async () => {
    for (const chain of CHAINS) {
      const [a, b] = [await someone(chain), await someone(chain)];
      await fund(a);
      await fund(b);
      const placed = await order(a);
      // The first step lands and is reported; the second is built and waits.
      const [one, two] = [first(placed, 0), first(placed, 1)];
      await build(a, placed, one.id);
      const oneTx = await land(a, placed, one.id);
      await report(a, placed, one.id, { txId: oneTx });
      const built = await build(a, placed, two.id);
      const before = await read(a, placed);

      // Another person's transaction for the same step of the same plan: the same call in every
      // argument but the wallet that signs it.
      const theirs = await order(b);
      await build(b, theirs, first(theirs, 0).id);
      await report(b, theirs, first(theirs, 0).id, {
        txId: await land(b, theirs, first(theirs, 0).id),
      });
      const theirBuilt = await build(b, theirs, first(theirs, 1).id);
      const theirTx = await land(b, theirs, first(theirs, 1).id);

      // The chain has both of these and they are another call or another signer's: refused for good.
      for (const txId of [oneTx, theirTx]) {
        const wrong = await post(a, legUrl(placed, two.id, 'report'), { txId });
        expect([chain, wrong.statusCode]).toEqual([chain, 409]);
        expect(wrong.json()).toEqual({
          error: 'that transaction is not the one built for this step',
        });
      }
      // It has never seen this one: that is not a verdict on it, so the answer says to ask again,
      // and is a different one.
      const unseen = await post(a, legUrl(placed, two.id, 'report'), {
        txId: 'no-such-transaction',
      });
      expect(unseen.statusCode).toBe(409);
      expect(unseen.json()).toEqual({
        error: 'the chain has not seen that transaction yet',
        fix: 'Report it again in a moment.',
        details: { retryable: true },
      });
      // Signed bytes that are not this leg's are not relayed: bytes of nothing, and the other
      // person's signed transaction for their own step.
      const theirBytes = mockOf(chain).sign(theirBuilt.tx);
      for (const signedTx of ['bm90IG91cnM=', '0x6e6f74206f757273', theirBytes]) {
        const other = await post(a, legUrl(placed, two.id, 'report'), { signedTx });
        expect([chain, signedTx, other.statusCode]).toEqual([chain, signedTx, 409]);
        expect(other.json().details).toEqual({ chainCode: 'NotBuiltHere', retryable: false });
      }
      // Both at once is neither.
      const both = { txId: oneTx, signedTx: built.tx.payload };
      expect((await post(a, legUrl(placed, two.id, 'report'), both)).statusCode).toBe(400);

      const after = await read(a, placed);
      expect(legOf(after, two.id)).toEqual(legOf(before, two.id));
      expect(legOf(after, two.id)).toMatchObject({ status: 'built', txId: null });
      expect(attemptsOf(after, two.id)).toEqual([[1, 'built']]);
    }
  });

  it('a transaction reported before the chain has seen it settles when it is reported again', async () => {
    const a = await someone();
    // A node a moment behind the wallet: the first time it is asked, it has not seen the transaction.
    let asked = 0;
    const behind = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      wrap: (inner) => ({
        ...inner,
        get: (chain) => {
          const entry = inner.get(chain);
          const carries: typeof entry.adapter.carries = async (txId, hash) => {
            asked += 1;
            return asked === 1 ? 'unseen' : entry.adapter.carries(txId, hash);
          };
          return { ...entry, adapter: { ...entry.adapter, carries } };
        },
      }),
    });
    const on = behind.app;
    await fund(a, on);
    const placed = await order(a, { amountUsd: 600 }, on);
    const leg = first(placed);
    await build(a, placed, leg.id, on);
    const txId = await land(a, placed, leg.id, on);

    const early = await post(a, legUrl(placed, leg.id, 'report'), { txId }, on);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({
      error: 'the chain has not seen that transaction yet',
      details: { retryable: true },
    });
    // Nothing was written: the step is as it was built.
    const waiting = await read(a, placed, on);
    expect(legOf(waiting, leg.id)).toMatchObject({ status: 'built', txId: null, error: null });
    // The same report a moment later settles it.
    const done = await report(a, placed, leg.id, { txId }, on);
    expect(legOf(done, leg.id)).toMatchObject({ status: 'confirmed', txId, attempt: 1 });
    expect(asked).toBe(2);
    await on.close();
  });

  it('a leg reported twice settles once', async () => {
    const a = await someone();
    await fund(a);
    const placed = await order(a, { amountUsd: 600 });
    const leg = first(placed);
    const { tx } = await build(a, placed, leg.id);
    const txId = await land(a, placed, leg.id);
    const once = await report(a, placed, leg.id, { txId });
    expect(await report(a, placed, leg.id, { txId })).toEqual(once);
    expect(await report(a, placed, leg.id, { signedTx: tx.payload })).toEqual(once);
    expect(once.attempts).toHaveLength(1);
    // A different transaction for a settled leg is refused.
    expect((await post(a, legUrl(placed, leg.id, 'report'), { txId: 'another' })).statusCode).toBe(
      409,
    );
    // And a settled leg is not built again.
    expect((await post(a, legUrl(placed, leg.id, 'build'))).statusCode).toBe(409);
    // The cash went in once.
    const vaultsNow = await registry.get('solana').adapter.getVaults(a.solana);
    expect(vaultsNow.map((v) => v.cash.raw)).toEqual(['600000000']);
  });

  it('relays signed bytes once, and never the same bytes again', async () => {
    const a = await someone();
    let relays = 0;
    const counted = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      wrap: (inner) => ({
        ...inner,
        get: (chain) => {
          const entry = inner.get(chain);
          const relay: typeof entry.adapter.relay = (signedTx) => {
            relays += 1;
            return entry.adapter.relay(signedTx);
          };
          return { ...entry, adapter: { ...entry.adapter, relay } };
        },
      }),
    });
    const on = counted.app;
    await fund(a, on);
    const placed = await order(a, { amountUsd: 600 }, on);
    const leg = first(placed);

    // The first attempt reverts. Handing the same bytes over again sends nothing.
    const one = await build(a, placed, leg.id, on);
    mockOf('solana', counted.registry).revertNext({ code: 'SpentTooMuch', message: 'reverted' });
    const failed = await report(a, placed, leg.id, { signedTx: one.tx.payload }, on);
    expect(legOf(failed, leg.id)).toMatchObject({ status: 'failed', error: { retryable: false } });
    expect(await report(a, placed, leg.id, { signedTx: one.tx.payload }, on)).toEqual(failed);
    expect(relays).toBe(1);

    // A new build is new bytes; those are relayed once too, and the old ones are never sent again.
    const two = await build(a, placed, leg.id, on);
    const built = await read(a, placed, on);
    expect(await report(a, placed, leg.id, { signedTx: one.tx.payload }, on)).toEqual(built);
    expect(relays).toBe(1);
    const done = await report(a, placed, leg.id, { signedTx: two.tx.payload }, on);
    expect(legOf(done, leg.id)).toMatchObject({ status: 'confirmed', attempt: 2 });
    expect(await report(a, placed, leg.id, { signedTx: two.tx.payload }, on)).toEqual(done);
    expect(relays).toBe(2);
    await on.close();
  });

  it('does not build a leg again while the transaction built before can still land', async () => {
    // The review's sequence, on the leg that moves cash: build, build again, land the first, report it.
    for (const chain of CHAINS) {
      const a = await someone(chain);
      const cash = await openVault(a);
      const { placed, deposit } = await toDeposit(a);
      const before = await cash();
      await build(a, placed, deposit.id);
      const again = await post(a, legUrl(placed, deposit.id, 'build'));
      expect([chain, again.statusCode]).toEqual([chain, 409]);
      expect(again.json().error).toMatch(/can still land/);
      expect(attemptsOf(await read(a, placed), deposit.id)).toEqual([[1, 'built']]);

      const landed = await land(a, placed, deposit.id);
      expect(landed).toBeTruthy();
      const done = await report(a, placed, deposit.id, { txId: landed });
      expect(legOf(done, deposit.id)).toMatchObject({ status: 'confirmed', attempt: 1 });
      expect(attemptsOf(done, deposit.id)).toEqual([[1, 'confirmed']]);
      // The cash left the wallet once.
      expect(before - (await cash())).toBe(10_000_000n);
    }
  }, 60_000);

  it('on Solana, builds again once the first transaction can no longer land', async () => {
    const a = await someone();
    let clock = Date.now();
    const timed = await testApp({ issuer: issuer.issuer, db: data.db, now: () => new Date(clock) });
    const on = timed.app;
    const cash = await openVault(a, on, timed.registry);
    const { placed, deposit } = await toDeposit(a, on);
    const before = await cash();
    const one = await build(a, placed, deposit.id, on);
    expect((await post(a, legUrl(placed, deposit.id, 'build'), undefined, on)).statusCode).toBe(
      409,
    );

    // Past its last valid block the first transaction is dead, and the mock chain refuses it.
    clock += 2 * 60 * 1000;
    const two = await build(a, placed, deposit.id, on);
    expect(two.attempt.n).toBe(2);
    const rebuilt = await read(a, placed, on);
    expect(attemptsOf(rebuilt, deposit.id)).toEqual([
      [1, 'expired'],
      [2, 'built'],
    ]);
    const mock = mockOf('solana', timed.registry);
    await expect(mock.send({ messageHash: one.tx.messageHash })).rejects.toMatchObject({
      code: 'Expired',
    });
    const done = await report(
      a,
      placed,
      deposit.id,
      { txId: await land(a, placed, deposit.id, on) },
      on,
    );
    expect(attemptsOf(done, deposit.id)).toEqual([
      [1, 'expired'],
      [2, 'confirmed'],
    ]);
    expect(before - (await cash())).toBe(10_000_000n);
    await on.close();
  });

  it('settles on a transaction that landed and was never reported, instead of building again', async () => {
    const a = await someone();
    let clock = Date.now();
    const timed = await testApp({ issuer: issuer.issuer, db: data.db, now: () => new Date(clock) });
    const on = timed.app;
    const cash = await openVault(a, on, timed.registry);
    const { placed, deposit } = await toDeposit(a, on);
    const before = await cash();
    await build(a, placed, deposit.id, on);
    // The wallet sent it and it landed, but nobody told the API. Then its validity ran out.
    const txId = await land(a, placed, deposit.id, on);
    clock += 2 * 60 * 1000;
    const again = await post(a, legUrl(placed, deposit.id, 'build'), undefined, on);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/has landed/);
    // by its code, so a client reads the order again and shows no sentence for it
    expect(again.json().code).toBe('STEP_LANDED');
    const after = await read(a, placed, on);
    expect(legOf(after, deposit.id)).toMatchObject({ status: 'confirmed', attempt: 1, txId });
    expect(attemptsOf(after, deposit.id)).toEqual([[1, 'confirmed']]);
    expect(before - (await cash())).toBe(10_000_000n);
    await on.close();
  });

  it('cancels only an attempt that was built and has not landed', async () => {
    const a = await someone('robinhood');
    await openVault(a);
    const { placed, deposit } = await toDeposit(a);
    // Nothing built yet.
    expect((await post(a, legUrl(placed, deposit.id, 'cancel'))).statusCode).toBe(409);
    await build(a, placed, deposit.id);
    // It landed, unreported: the cancel finds it and the leg settles instead.
    const txId = await land(a, placed, deposit.id);
    const res = await post(a, legUrl(placed, deposit.id, 'cancel'));
    expect(res.statusCode).toBe(409);
    expect(legOf(await read(a, placed), deposit.id)).toMatchObject({ status: 'confirmed', txId });

    // On Solana an attempt cannot be cancelled while it can still land: only time closes it.
    const s = await someone('solana');
    await openVault(s);
    const sol = await toDeposit(s);
    await build(s, sol.placed, sol.deposit.id);
    const early = await post(s, legUrl(sol.placed, sol.deposit.id, 'cancel'));
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatch(/can still land/);
    expect(attemptsOf(await read(s, sol.placed), sol.deposit.id)).toEqual([[1, 'built']]);
  }, 60_000);

  it('racing a build against the report of a landed transaction loses nothing, on both chains', async () => {
    for (const chain of CHAINS) {
      const a = await someone(chain);
      const cash = await openVault(a);
      const before = await cash();
      const rounds = 12;
      for (let i = 0; i < rounds; i++) {
        const { placed, deposit } = await toDeposit(a);
        await build(a, placed, deposit.id);
        const txId = await land(a, placed, deposit.id);
        const url = (step: string) => legUrl(placed, deposit.id, step);
        const [rebuilt, ...reports] = await Promise.all([
          post(a, url('build')),
          post(a, url('report'), { txId }),
          post(a, url('report'), { txId }),
          get(a, `/v1/orders/${placed.id}`),
        ]);
        expect([chain, i, rebuilt.statusCode]).toEqual([chain, i, 409]);
        expect(reports.map((r) => r.statusCode)).toEqual([200, 200, 200]);
        const after = await read(a, placed);
        expect(legOf(after, deposit.id)).toMatchObject({ status: 'confirmed', attempt: 1, txId });
        expect(attemptsOf(after, deposit.id)).toEqual([[1, 'confirmed']]);
      }
      expect(before - (await cash())).toBe(BigInt(rounds) * 10_000_000n);
    }
  }, 60_000);

  it('two builds at once make one attempt', async () => {
    const a = await someone();
    await fund(a);
    for (let i = 0; i < 8; i++) {
      const placed = await order(a, { amountUsd: 600 });
      const leg = first(placed);
      const both = await Promise.all([
        post(a, legUrl(placed, leg.id, 'build')),
        post(a, legUrl(placed, leg.id, 'build')),
        post(a, legUrl(placed, leg.id, 'build')),
      ]);
      expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
      expect(attemptsOf(await read(a, placed), leg.id)).toEqual([[1, 'built']]);
    }
  }, 60_000);

  it('a transaction that never lands leaves the leg sent, then expired, and it is built again', async () => {
    const a = await someone();
    let clock = Date.now();
    const timed = await testApp({ issuer: issuer.issuer, db: data.db, now: () => new Date(clock) });
    const on = timed.app;
    await fund(a, on);
    const placed = await order(a, { amountUsd: 600 }, on);
    const leg = first(placed);
    await build(a, placed, leg.id, on);
    mockOf('solana', timed.registry).dropNext();
    const txId = await land(a, placed, leg.id, on);
    const waiting = await report(a, placed, leg.id, { txId }, on);
    expect(legOf(waiting, leg.id)).toMatchObject({ status: 'sent', txId });
    expect(waiting.status).toBe('open');
    // While it may still land, it is not built again.
    expect((await post(a, legUrl(placed, leg.id, 'build'), undefined, on)).statusCode).toBe(409);

    // Its validity runs out. The next read tracks it again and finds it expired.
    clock += 2 * 60 * 1000;
    const late = await read(a, placed, on);
    expect(legOf(late, leg.id)).toMatchObject({ status: 'expired', txId, error: null });
    expect(late.status).toBe('open');
    const { attempt } = await build(a, placed, leg.id, on);
    expect(attempt.n).toBe(2);
    const done = await report(a, placed, leg.id, { txId: await land(a, placed, leg.id, on) }, on);
    expect(done.attempts.map((x) => [x.n, x.status])).toEqual([
      [1, 'expired'],
      [2, 'confirmed'],
    ]);
    await on.close();
  });

  it('builds the legs in order, and not before the one before has settled', async () => {
    const a = await someone();
    await fund(a);
    const placed = await order(a, { amountUsd: 600 });
    const res = await post(a, legUrl(placed, first(placed, 1).id, 'build'));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/earlier step/);
    // A report before any build has nothing to settle.
    const early = await post(a, legUrl(placed, first(placed).id, 'report'), {
      txId: 'x',
    });
    expect(early.statusCode).toBe(409);
  });
});

describe('on an EVM chain an attempt is the pair (message, nonce)', () => {
  it('builds again only after a cancel, on the same nonce, and settles on the newest attempt of the pair', async () => {
    const a = await someone('robinhood');
    const cash = await openVault(a);
    const { placed, deposit } = await toDeposit(a);
    const before = await cash();
    const one = await build(a, placed, deposit.id);
    // No expiry on EVM: time does not free the leg. The person cancels the attempt.
    const refused = await post(a, legUrl(placed, deposit.id, 'build'));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().fix).toMatch(/cancel/);
    const cancelled = await post(a, legUrl(placed, deposit.id, 'cancel'));
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(legOf(OrderDetail.parse(cancelled.json()), deposit.id)).toMatchObject({
      status: 'expired',
      error: { code: 'rejected', retryable: true },
    });
    // Cancelled once; there is nothing left to cancel.
    expect((await post(a, legUrl(placed, deposit.id, 'cancel'))).statusCode).toBe(409);
    const two = await build(a, placed, deposit.id);
    expect(two.attempt.n).toBe(2);
    // The same call, built on the cancelled attempt's nonce: whichever of the two is sent, at most
    // one transaction can land.
    expect([two.tx.messageHash, two.tx.evm?.nonce]).toEqual([
      one.tx.messageHash,
      one.tx.evm?.nonce,
    ]);
    expect([one.attempt.nonce, two.attempt.nonce]).toEqual([one.tx.evm?.nonce, one.tx.evm?.nonce]);

    // The wallet sends what it signed first. The two attempts are one transaction: the same call on
    // the same nonce. It lands, its id is reported, and the leg settles on the newer of the two, the
    // one that was still open.
    const sent = await mockOf('robinhood').send({ messageHash: one.tx.messageHash });
    const done = await report(a, placed, deposit.id, { txId: sent.txId });
    expect(legOf(done, deposit.id)).toMatchObject({
      status: 'confirmed',
      attempt: 2,
      txId: sent.txId,
      error: null,
    });
    expect(attemptsOf(done, deposit.id)).toEqual([
      [1, 'expired'],
      [2, 'confirmed'],
    ]);
    // Its bytes are the bytes of the transaction that landed: handing them over sends nothing, and
    // answers with the order as it stands.
    for (const signedTx of [two.tx.payload, mockOf('robinhood').sign(two.tx)]) {
      const late = await post(a, legUrl(placed, deposit.id, 'report'), { signedTx });
      expect(late.statusCode, late.body).toBe(200);
      expect(OrderDetail.parse(late.json())).toEqual(done);
    }
    expect((await post(a, legUrl(placed, deposit.id, 'build'))).statusCode).toBe(409);
    expect(done.status).toBe('done');
    expect(before - (await cash())).toBe(10_000_000n);
  });

  it('after a cancel and a rebuild, the signed bytes are relayed for the attempt that is open', async () => {
    const a = await someone('robinhood');
    const cash = await openVault(a);
    const { placed, deposit } = await toDeposit(a);
    const before = await cash();
    await build(a, placed, deposit.id);
    expect((await post(a, legUrl(placed, deposit.id, 'cancel'))).statusCode).toBe(200);
    const two = await build(a, placed, deposit.id);
    // The wallet signs what it was handed last, with the nonce it states.
    const done = await report(a, placed, deposit.id, {
      signedTx: mockOf('robinhood').sign(two.tx),
    });
    expect(legOf(done, deposit.id)).toMatchObject({ status: 'confirmed', attempt: 2 });
    expect(attemptsOf(done, deposit.id)).toEqual([
      [1, 'expired'],
      [2, 'confirmed'],
    ]);
    expect(before - (await cash())).toBe(10_000_000n);
  });

  it('after a revert and a rebuild, the new attempt has its own nonce and is the one that settles', async () => {
    const a = await someone('robinhood');
    await fund(a);
    const placed = await order(a, { amountUsd: 400 });
    const approve = first(placed);
    const one = await build(a, placed, approve.id);
    mockOf('robinhood').revertNext({ code: 'GasTooLow', message: 'out of gas' });
    const failed = await report(a, placed, approve.id, {
      txId: await land(a, placed, approve.id),
    });
    expect(legOf(failed, approve.id)).toMatchObject({ status: 'failed', attempt: 1 });

    // The same approval again: the same call, so the same message, on the nonce after the one the
    // revert used.
    const two = await build(a, placed, approve.id);
    expect(two.tx.messageHash).toBe(one.tx.messageHash);
    expect(two.attempt.nonce).toBe((one.attempt.nonce ?? 0) + 1);
    // The reverted transaction, reported again, is the first attempt's and moves nothing.
    const again = await report(a, placed, approve.id, { txId: legOf(failed, approve.id).txId });
    expect(attemptsOf(again, approve.id)).toEqual([
      [1, 'failed'],
      [2, 'built'],
    ]);
    // The wallet signs the new one. Its bytes are relayed: they are not taken for the reverted
    // attempt, which shares their message and not their nonce.
    const done = await report(a, placed, approve.id, {
      signedTx: mockOf('robinhood').sign(two.tx),
    });
    expect(legOf(done, approve.id)).toMatchObject({ status: 'confirmed', attempt: 2, error: null });
    expect(attemptsOf(done, approve.id)).toEqual([
      [1, 'failed'],
      [2, 'confirmed'],
    ]);
    expect(done.attempts.map((x) => x.nonce)).toEqual([one.attempt.nonce, two.attempt.nonce]);
  });

  it('leaves the attempt carrying the nonce the wallet really used', async () => {
    const a = await someone('robinhood');
    await fund(a);
    const mock = mockOf('robinhood');
    const { adapter } = registry.get('robinhood');
    /** A transaction of the same wallet that is no step of any order: it takes the next nonce. */
    const elsewhere = async (basketId: string) =>
      mock.send(await adapter.buildApprove({ owner: a.evm, basketId, amountRaw: '1' }));

    // Reported by id. The build states nonce N; the wallet's own transaction takes N first, and the
    // wallet then sends the step on the nonce after.
    const byId = await order(a, { amountUsd: 400 });
    const one = await build(a, byId, first(byId).id);
    await elsewhere('901');
    const sent = await mock.send({ messageHash: one.tx.messageHash });
    const reported = await report(a, byId, first(byId).id, { txId: sent.txId });
    expect(legOf(reported, first(byId).id)).toMatchObject({ status: 'confirmed', txId: sent.txId });
    expect(reported.attempts.map((x) => x.nonce)).toEqual([(one.attempt.nonce ?? 0) + 1]);

    // Handed over as signed bytes: an outside wallet signed with its own nonce, not the stated one.
    const byBytes = await order(a, { amountUsd: 300 });
    const two = await build(a, byBytes, first(byBytes).id);
    await elsewhere('902');
    const own = (two.attempt.nonce ?? 0) + 1;
    if (!two.tx.evm) throw new Error('not an EVM transaction');
    const signedTx = mock.sign({ ...two.tx, evm: { ...two.tx.evm, nonce: own } });
    const relayed = await report(a, byBytes, first(byBytes).id, { signedTx });
    expect(legOf(relayed, first(byBytes).id).status).toBe('confirmed');
    expect(relayed.attempts.map((x) => x.nonce)).toEqual([own]);
    expect(await adapter.nonceOf({ txId: legOf(relayed, first(byBytes).id).txId ?? '' })).toBe(own);
  });

  it('does not take an older identical call of the same wallet for a step built after it', async () => {
    const a = await someone('robinhood');
    await fund(a);
    const mock = mockOf('robinhood');
    const { adapter } = registry.get('robinhood');
    const basketId = basketIdOf(plans.robinhood);
    const placed = await order(a, { amountUsd: 400 });
    const approve = first(placed);
    // The wallet made the very same approval before, by another route: the same call, so the same
    // message, landed on a nonce that was used before this step was built.
    const old = await mock.send(
      await adapter.buildApprove({ owner: a.evm, basketId, amountRaw: approve.cashRaw ?? '' }),
    );
    const built = await build(a, placed, approve.id);
    const oldNonce = await adapter.nonceOf({ txId: old.txId });
    expect(await adapter.carries(old.txId, built.tx.messageHash)).toBe('this');
    expect(oldNonce).toBeLessThan(built.attempt.nonce ?? -1);

    const wrong = await post(a, legUrl(placed, approve.id, 'report'), { txId: old.txId });
    expect([wrong.statusCode, wrong.json()]).toEqual([
      409,
      { error: 'that transaction is not the one built for this step' },
    ]);
    // Neither are bytes of that call signed on the old nonce.
    if (!built.tx.evm) throw new Error('not an EVM transaction');
    const stale = mock.sign({ ...built.tx, evm: { ...built.tx.evm, nonce: oldNonce ?? 0 } });
    const bytes = await post(a, legUrl(placed, approve.id, 'report'), { signedTx: stale });
    expect([bytes.statusCode, bytes.json().details]).toEqual([
      409,
      { chainCode: 'NotBuiltHere', retryable: false },
    ]);
    const after = await read(a, placed);
    expect(legOf(after, approve.id)).toMatchObject({ status: 'built', txId: null });
    expect(after.attempts.map((x) => [x.status, x.nonce])).toEqual([
      ['built', built.attempt.nonce],
    ]);
    // The step settles on its own transaction.
    const done = await report(a, placed, approve.id, { txId: await land(a, placed, approve.id) });
    expect(legOf(done, approve.id).status).toBe('confirmed');
  });

  it('an identical deposit made before the order existed does not settle it: no cash, no done', async () => {
    const a = await someone('robinhood');
    const cash = await openVault(a);
    const mock = mockOf('robinhood');
    const { adapter } = registry.get('robinhood');
    // What a $10 buy of this plan deposits and trades, read from an order that is then left alone.
    const probe = await order(a, { amountUsd: 10 });
    const like = probe.legs.find((l) => l.kind === 'deposit');
    const [vault] = await adapter.getVaults(a.evm);
    if (!like?.cashRaw || !vault) throw new Error('no deposit to copy');
    // The wallet makes the very same approval and deposit by another route, with no order.
    await mock.send(
      await adapter.buildApprove({
        owner: a.evm,
        basketId: basketIdOf(plans.robinhood),
        amountRaw: like.cashRaw,
      }),
    );
    const old = await mock.send(
      await adapter.buildDeposit({
        vault: vault.address,
        amountRaw: like.cashRaw,
        trades: like.trades,
        slippageBps: 100,
      }),
    );
    const before = await cash();

    // Now the order: its approval settles, its deposit is built, and the older deposit's id is reported.
    const { placed, deposit } = await toDeposit(a);
    const built = await build(a, placed, deposit.id);
    expect(await adapter.carries(old.txId, built.tx.messageHash)).toBe('this');
    const wrong = await post(a, legUrl(placed, deposit.id, 'report'), { txId: old.txId });
    expect([wrong.statusCode, wrong.json().error]).toEqual([
      409,
      'that transaction is not the one built for this step',
    ]);
    const after = await read(a, placed);
    expect([after.status, legOf(after, deposit.id).status]).toEqual(['open', 'built']);
    expect(before - (await cash())).toBe(0n);
    // The step is still there to be signed, and the order is done only when its own cash has moved.
    const done = await report(a, placed, deposit.id, { txId: await land(a, placed, deposit.id) });
    expect([done.status, legOf(done, deposit.id).status]).toEqual(['done', 'confirmed']);
    expect(before - (await cash())).toBe(10_000_000n);
  });

  it('does not take one order’s transaction for another order’s identical step', async () => {
    const a = await someone('robinhood');
    const cash = await openVault(a);
    const before = await cash();
    // The first order's deposit lands. Nobody reports it yet.
    const one = await toDeposit(a);
    const first1 = await build(a, one.placed, one.deposit.id);
    const firstTx = await land(a, one.placed, one.deposit.id);

    // The same person buys the same amount again: the deposit is the same call, so the same message.
    // It is told apart from the first by its nonce.
    const two = await toDeposit(a);
    const second = await build(a, two.placed, two.deposit.id);
    expect(second.tx.messageHash).toBe(first1.tx.messageHash);
    expect(second.attempt.nonce).toBeGreaterThan(first1.attempt.nonce ?? -1);
    // It has not landed because the first one did: a read leaves it built, and a second build is
    // refused because it can still land, not because it has.
    expect(legOf(await read(a, two.placed), two.deposit.id)).toMatchObject({
      status: 'built',
      txId: null,
    });
    const refused = await post(a, legUrl(two.placed, two.deposit.id, 'build'));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/can still land/);

    // The first order's transaction, reported to the second order's step: it carries the same call,
    // but on a nonce that was used before this step was built. It is refused here.
    const wrong = await post(a, legUrl(two.placed, two.deposit.id, 'report'), { txId: firstTx });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toEqual({ error: 'that transaction is not the one built for this step' });
    expect(legOf(await read(a, two.placed), two.deposit.id)).toMatchObject({
      status: 'built',
      txId: null,
    });
    // Reported where it belongs, it settles the first order.
    const settled = await report(a, one.placed, one.deposit.id, { txId: firstTx });
    expect(legOf(settled, one.deposit.id)).toMatchObject({ status: 'confirmed', txId: firstTx });

    // The second can be cancelled, and built again on the nonce it had.
    const cancelled = await post(a, legUrl(two.placed, two.deposit.id, 'cancel'));
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const again = await build(a, two.placed, two.deposit.id);
    expect([again.attempt.n, again.attempt.nonce]).toEqual([2, second.attempt.nonce]);
    expect(again.tx.evm?.nonce).toBe(second.tx.evm?.nonce);
    // And it lands as its own transaction.
    const secondTx = await land(a, two.placed, two.deposit.id);
    expect(secondTx).not.toBe(firstTx);
    const done = await report(a, two.placed, two.deposit.id, { txId: secondTx });
    expect(legOf(done, two.deposit.id)).toMatchObject({ status: 'confirmed', txId: secondTx });
    expect(done.status).toBe('done');
    expect(before - (await cash())).toBe(20_000_000n);
  });

  it('a transaction another order stated on a later nonce is that order’s, and is refused here', async () => {
    const a = await someone('robinhood');
    await openVault(a);
    const mock = mockOf('robinhood');
    const { adapter } = registry.get('robinhood');
    // This step is built first, then cancelled: it stated nonce N.
    const here = await toDeposit(a);
    const mine = await build(a, here.placed, here.deposit.id);
    expect((await post(a, legUrl(here.placed, here.deposit.id, 'cancel'))).statusCode).toBe(200);
    // Something else of the wallet takes that nonce, and then another order's identical deposit is
    // built on a later one and lands, unreported.
    await mock.send(await adapter.buildApprove({ owner: a.evm, basketId: '77', amountRaw: '1' }));
    const other = await toDeposit(a);
    const theirs = await build(a, other.placed, other.deposit.id);
    expect(theirs.tx.messageHash).toBe(mine.tx.messageHash);
    expect(theirs.attempt.nonce).toBeGreaterThan(mine.attempt.nonce ?? -1);
    const theirTx = await land(a, other.placed, other.deposit.id);

    // Reported here, it carries this step's call on a nonce this step never stated. It is not the
    // wallet's own choice of nonce: the other order's attempt stated that very pair.
    const wrong = await post(a, legUrl(here.placed, here.deposit.id, 'report'), { txId: theirTx });
    expect([wrong.statusCode, wrong.json()]).toEqual([
      409,
      {
        error: 'that transaction was built for another step',
        details: { chainCode: 'NotBuiltHere', retryable: false },
      },
    ]);
    expect(attemptsOf(await read(a, here.placed), here.deposit.id)).toEqual([[1, 'expired']]);
    // Where it belongs, it settles.
    const settled = await report(a, other.placed, other.deposit.id, { txId: theirTx });
    expect(legOf(settled, other.deposit.id)).toMatchObject({ status: 'confirmed', txId: theirTx });
  });

  it('one transaction settles one step: an attempt whose nonce another step’s transaction used is closed', async () => {
    const a = await someone('robinhood');
    const cash = await openVault(a);
    const before = await cash();
    // Two orders with the identical deposit, both ready for it.
    const [one, two] = [await toDeposit(a), await toDeposit(a)];
    // The first is built and cancelled. The second is then built on the same nonce: the same call on
    // the same nonce, so the two attempts are one transaction, and at most one deposit can land.
    const first1 = await build(a, one.placed, one.deposit.id);
    expect((await post(a, legUrl(one.placed, one.deposit.id, 'cancel'))).statusCode).toBe(200);
    const second = await build(a, two.placed, two.deposit.id);
    expect([second.tx.messageHash, second.attempt.nonce]).toEqual([
      first1.tx.messageHash,
      first1.attempt.nonce,
    ]);
    // It lands, and is reported to the first order: that step settles on it.
    const sent = await mockOf('robinhood').send({ messageHash: first1.tx.messageHash });
    const settled = await report(a, one.placed, one.deposit.id, { txId: sent.txId });
    expect(legOf(settled, one.deposit.id)).toMatchObject({ status: 'confirmed', txId: sent.txId });

    // The same transaction cannot settle the second order's step as well.
    const again = await post(a, legUrl(two.placed, two.deposit.id, 'report'), { txId: sent.txId });
    expect([again.statusCode, again.json().error]).toEqual([
      409,
      'that transaction is already recorded for another step',
    ]);
    expect(attemptsOf(await read(a, two.placed), two.deposit.id)).toEqual([[1, 'built']]);
    // Its attempt can no longer land: the nonce is used. The next build finds that and closes it,
    // so the step is not left waiting for a transaction that will never come.
    const rebuilt = await post(a, legUrl(two.placed, two.deposit.id, 'build'));
    expect(rebuilt.statusCode).toBe(409);
    const after = await read(a, two.placed);
    expect(attemptsOf(after, two.deposit.id)).toEqual([[1, 'expired']]);
    expect(legOf(after, two.deposit.id)).toMatchObject({ status: 'expired', txId: null });
    // One deposit left the wallet.
    expect(before - (await cash())).toBe(10_000_000n);
  });

  it('does not build two orders of one wallet on the same nonce: the second waits for the first', async () => {
    const a = await someone('robinhood');
    await fund(a);
    const [one, two] = [await order(a, { amountUsd: 400 }), await order(a, { amountUsd: 300 })];
    const built = await build(a, one, first(one).id);

    // The first order holds a transaction that can still land on the wallet's next nonce.
    const blocked = await post(a, legUrl(two, first(two).id, 'build'));
    expect(blocked.statusCode).toBe(409);
    expect(OrderError.parse(blocked.json())).toEqual({
      error:
        'another order of this wallet has a transaction on Robinhood Chain that can still land',
      fix: 'Report that step or cancel it, then build this one again.',
      details: { retryable: true, blocking: { orderId: one.id, legId: first(one).id } },
    });
    expect((await read(a, two)).attempts).toEqual([]);

    // Once it has landed and is reported, the second is built on the nonce after it.
    await report(a, one, first(one).id, { txId: await land(a, one, first(one).id) });
    const next = await build(a, two, first(two).id);
    expect(next.attempt.nonce).toBe((built.attempt.nonce ?? 0) + 1);

    // The other way out is a cancel. The first order's next step is blocked by the second's now.
    const stuck = await post(a, legUrl(one, first(one, 1).id, 'build'));
    expect(stuck.json().details.blocking).toEqual({ orderId: two.id, legId: first(two).id });
    expect((await post(a, legUrl(two, first(two).id, 'cancel'))).statusCode).toBe(200);
    const freed = await build(a, one, first(one, 1).id);
    // A cancelled transaction can still be sent, so the next build shares its nonce: one can land.
    expect(freed.attempt.nonce).toBe(next.attempt.nonce);

    // A transaction of a step that has landed, unreported, does not stand in the way either.
    const three = await order(a, { amountUsd: 200 });
    await land(a, one, first(one, 1).id);
    const after = await build(a, three, first(three).id);
    expect(after.attempt.nonce).toBe((freed.attempt.nonce ?? 0) + 1);
    // Solana has no nonce: two orders of one wallet are built side by side.
    const s = await someone('solana');
    await fund(s);
    const [x, y] = [await order(s, { amountUsd: 400 }), await order(s, { amountUsd: 300 })];
    await build(s, x, first(x).id);
    await build(s, y, first(y).id);
  });

  it('two orders of one wallet built at the same moment: one is built, the other is refused', async () => {
    const a = await someone('robinhood');
    await fund(a);
    for (let i = 0; i < 6; i++) {
      const [one, two] = [
        await order(a, { amountUsd: 400 + i }),
        await order(a, { amountUsd: 300 + i }),
      ];
      const both = await Promise.all([
        post(a, legUrl(one, first(one).id, 'build')),
        post(a, legUrl(two, first(two).id, 'build')),
      ]);
      expect([i, ...both.map((r) => r.statusCode).sort()]).toEqual([i, 200, 409]);
      const [won, lost] = both[0].statusCode === 200 ? [one, two] : [two, one];
      const refused = both.find((r) => r.statusCode === 409);
      expect(refused?.json().details.blocking).toEqual({
        orderId: won.id,
        legId: first(won).id,
      });
      expect((await read(a, lost)).attempts).toEqual([]);
      // Cleared for the next round: the one that was built is cancelled.
      expect((await post(a, legUrl(won, first(won).id, 'cancel'))).statusCode).toBe(200);
    }
  }, 60_000);

  it('finds a cancelled transaction that landed before the leg is built again', async () => {
    const a = await someone('robinhood');
    await openVault(a);
    for (let i = 0; i < 6; i++) {
      const { placed, deposit } = await toDeposit(a);
      const one = await build(a, placed, deposit.id);
      expect((await post(a, legUrl(placed, deposit.id, 'cancel'))).statusCode).toBe(200);
      const sent = await mockOf('robinhood').send({ messageHash: one.tx.messageHash });
      const [rebuilt, reported] = await Promise.all([
        post(a, legUrl(placed, deposit.id, 'build')),
        post(a, legUrl(placed, deposit.id, 'report'), { txId: sent.txId }),
      ]);
      expect([i, rebuilt.statusCode, reported.statusCode]).toEqual([i, 409, 200]);
      const after = await read(a, placed);
      expect(legOf(after, deposit.id)).toMatchObject({ status: 'confirmed', attempt: 1 });
      expect(attemptsOf(after, deposit.id)).toEqual([[1, 'confirmed']]);
    }
  }, 60_000);
});

describe('refusals', () => {
  it('refuses a chain that is switched off, with the order code', async () => {
    const [rh, sol] = [await someone('robinhood'), await someone('solana')];
    const off = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      env: { CHAIN_MODE_ROBINHOOD: 'off' },
    });
    const refusal = {
      error: 'Robinhood Chain is switched off on this server',
      code: 'CHAIN_UNAVAILABLE',
      details: { retryable: false },
    };
    const res = await post(
      rh,
      '/v1/orders',
      { type: 'buy', owner: rh.owner, amountUsd: 1000, proposalId: plans.robinhood },
      off.app,
    );
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject(refusal);
    // Their funding is on that chain too, and answers the same.
    const funding = await get(rh, '/v1/funding', off.app);
    expect(funding.statusCode).toBe(503);
    expect(funding.json()).toMatchObject(refusal);
    // Their portfolio has no other chain to read: 503, saying which chain could not be and why.
    const portfolio503 = await get(rh, '/v1/portfolio', off.app);
    expect(portfolio503.statusCode).toBe(503);
    expect(portfolio503.json()).toMatchObject({
      ...refusal,
      error: `none of your chains could be read: ${refusal.error}`,
    });
    // A person on the chain that is on still buys on that server, and reads their portfolio.
    const solanaOnly = await order(sol, { amountUsd: 600 }, off.app);
    expect(solanaOnly.legs.every((l) => l.chain === 'solana')).toBe(true);
    const portfolio = PortfolioResponse.parse((await get(sol, '/v1/portfolio', off.app)).json());
    expect(portfolio.chains.map((c) => c.chain)).toEqual(['solana']);
    // A person with wallets of both families reads the chain that is on (CHAIN-SWITCH).
    const both = await someone('passkey');
    const theirs = await get(both, '/v1/portfolio', off.app);
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect(PortfolioResponse.parse(theirs.json()).chains.map((c) => c.chain)).toEqual(['solana']);
    await off.app.close();
  });

  it('maps a refused build onto the order code and keeps `retryable`', async () => {
    const a = await someone();
    // Not funded: the chain refuses, and nothing the person does not change will fix it.
    const placed = await order(a, { amountUsd: 600 });
    const leg = first(placed);
    const res = await post(a, legUrl(placed, leg.id, 'build'));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'NOT_FUNDED',
      details: { chainCode: 'NotFunded', retryable: false },
    });
    expect(res.json().fix).toBeTruthy();
    const after = await read(a, placed);
    // The chain's own name stays on the leg; the leg is still to be built, and nothing was attempted.
    expect(legOf(after, leg.id)).toMatchObject({
      status: 'planned',
      attempt: 0,
      error: { code: 'NotFunded', retryable: false },
    });
    expect(after.attempts).toEqual([]);

    // A chain that does not answer: the same request can work later, and the answer says so.
    const refusals: [ChainError, number, string | undefined][] = [
      [new ChainError('Unavailable', 'the RPC did not answer'), 503, 'CHAIN_UNAVAILABLE'],
      [new ChainError('PriceStale', 'the price is too old'), 409, undefined],
      [new ChainError('VersionMismatch', 'the active version is 3'), 409, 'VERSION_CHANGED'],
    ];
    for (const [error, status, code] of refusals) {
      const flaky = await testApp({
        issuer: issuer.issuer,
        db: data.db,
        wrap: (inner) => ({
          ...inner,
          get: (chain) => {
            const entry = inner.get(chain);
            const buildCreateVault = () => Promise.reject(error);
            return { ...entry, adapter: { ...entry.adapter, buildCreateVault } };
          },
        }),
      });
      const again = await post(a, legUrl(placed, leg.id, 'build'), undefined, flaky.app);
      expect([error.code, again.statusCode, again.json().code]).toEqual([error.code, status, code]);
      expect(again.json().details).toEqual({ chainCode: error.code, retryable: error.retryable });
      expect(again.json().error).toBe(error.message);
      await flaky.app.close();
    }
    expect(legOf(await read(a, placed), leg.id).error).toEqual({
      code: 'VersionMismatch',
      message: 'the active version is 3',
      retryable: false,
    });
  });

  it('refuses what it cannot plan, and says why', async () => {
    const a = await someone();
    const cases: [object, number, RegExp][] = [
      [{ proposalId: undefined }, 400, /names the plan/],
      [{ proposalId: '4b1c0f0e-3f8e-4d0e-9d2b-0d7a3a6b1c2d' }, 404, /no plan/],
      [{ proposalId: plans.robinhood }, 422, /no evm address, and this plan is on Robinhood Chain/],
      [{ proposalId: undefined, family: 'core' }, 404, /no shared portfolio with that slug/],
      [{ amountUsd: 0.0001 }, 422, /less than one cent/],
    ];
    for (const [change, status, error] of cases) {
      const res = await post(a, '/v1/orders', {
        type: 'buy',
        owner: a.owner,
        amountUsd: 1000,
        proposalId: plans.solana,
        ...change,
      });
      expect([JSON.stringify(change), res.statusCode]).toEqual([JSON.stringify(change), status]);
      expect(res.json().error).toMatch(error);
    }
    const other = await post(a, '/v1/orders', { type: 'settings', vault: a.evm, autoFollow: true });
    expect(other.statusCode).toBe(501);
    // An owner with no address on the chain the plan lives on.
    const both = await someone('passkey');
    expect((await put(both, '/v1/me/chain', { chain: 'robinhood' })).statusCode).toBe(200);
    const half = await post(both, '/v1/orders', {
      type: 'buy',
      owner: { solana: both.solana },
      amountUsd: 1000,
      proposalId: plans.robinhood,
    });
    expect(half.statusCode).toBe(422);
    expect(half.json().error).toMatch(/the owner has no evm address/);
    expect((await get(a, '/v1/orders/not-an-id')).statusCode).toBe(400);
    expect((await get(a, '/v1/orders/4b1c0f0e-3f8e-4d0e-9d2b-0d7a3a6b1c2d')).statusCode).toBe(404);
  });

  it('refuses a stored plan it cannot use when the order is made, not at every build', async () => {
    const a = await someone();
    const buy = (proposalId: string, more: object = {}) =>
      post(a, '/v1/orders', { type: 'buy', owner: a.owner, amountUsd: 1000, proposalId, ...more });

    // Weights that add up to more than the whole are not targets a vault can take. Less than the
    // whole is a plan that keeps cash, and is bought (cash.test.ts).
    const over = planFixture('solana', { spy: 6000, nvda: 3000, gold: 2000 });
    over.lines = planFixture('solana').lines;
    const res = await buy(await data.storePlan(over));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/weights must add up to at most 10,000/);

    // A stored plan that no longer reads as a plan: a conflict with what is stored, not a server fault.
    const brokenId = await data.storePlan();
    await data.db
      .update(proposals)
      .set({ proposal: { not: 'a plan' } as never })
      .where(eq(proposals.id, brokenId));
    const broken = await buy(brokenId);
    expect(broken.statusCode).toBe(409);
    expect(broken.json().error).toMatch(/cannot be read/);

    // The most one order may buy. The ceiling is in the request's own schema, so a request over it
    // is one the server cannot take (400), with the same sentence.
    expect((await buy(plans.solana, { amountUsd: 1_000_000 })).statusCode).toBe(200);
    const tooMuch = await buy(plans.solana, { amountUsd: 1_000_000.01 });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().error).toMatch(/1,000,000/);
    expect((await buy(plans.solana, { amountUsd: 1e300 })).statusCode).toBe(400);
  });

  it('answers a request it cannot read with a 4xx, never a 500', async () => {
    const a = await someone();
    const placed = await order(a);
    const json = { ...a.headers, 'content-type': 'application/json' };
    const send = (url: string, headers: Record<string, string>, payload?: string) =>
      app.inject({ method: 'POST', url, headers, ...(payload === undefined ? {} : { payload }) });
    const buildUrl = legUrl(placed, first(placed).id, 'build');
    const huge = JSON.stringify({ type: 'buy', owner: a.owner, pad: 'x'.repeat(2_000_000) });
    const cases: [string, Awaited<ReturnType<typeof send>>, number][] = [
      ['malformed JSON', await send('/v1/orders', json, '{"type":'), 400],
      ['an empty JSON body', await send(buildUrl, json), 400],
      ['an empty JSON body, on create', await send('/v1/orders', json, ''), 400],
      [
        'another content type',
        await send('/v1/orders', { ...a.headers, 'content-type': 'application/xml' }, '<a/>'),
        415,
      ],
      ['a body too large', await send('/v1/orders', json, huge), 413],
      [
        'a __proto__ key',
        await send('/v1/orders', json, '{"type":"buy","__proto__":{"admin":true}}'),
        400,
      ],
    ];
    for (const [name, res, status] of cases) {
      expect([name, res.statusCode]).toEqual([name, status]);
      expect(typeof res.json().error).toBe('string');
      expect(res.body).not.toMatch(/the server failed|stack|node_modules/);
    }
    // The leg was not touched by any of it.
    expect(await read(a, placed)).toEqual(placed);
  });

  it('a report does not reopen an expired order, and only a transaction the chain has seen extends one', async () => {
    const a = await someone('robinhood');
    let clock = Date.now();
    const timed = await testApp({ issuer: issuer.issuer, db: data.db, now: () => new Date(clock) });
    const on = timed.app;
    await fund(a, on);

    // An id that matches the attempt but was never sent: the chain has not seen it, the clock stays.
    const unsent = await order(a, { amountUsd: 400 }, on);
    const approve = first(unsent);
    const built = await build(a, unsent, approve.id, on);
    const mock = mockOf('robinhood', timed.registry);
    mock.dropNext();
    const never = await mock.send({ messageHash: built.tx.messageHash });
    const waiting = await report(a, unsent, approve.id, { txId: never.txId }, on);
    expect(legOf(waiting, approve.id).status).toBe('sent');
    expect(waiting.expiresAt).toBe(unsent.expiresAt);
    clock += 20 * 60 * 1000;
    expect((await read(a, unsent, on)).status).toBe('expired');

    // A transaction that lands after the order expired is recorded, and the order stays expired. It
    // is for another amount than the first: on an EVM chain the same approval built on the same nonce
    // would be the same transaction as the one that never landed. The order that expired does not
    // stand in the way of this one, though its transaction was never closed.
    const late = await order(a, { amountUsd: 300 }, on);
    const leg = first(late);
    await build(a, late, leg.id, on);
    const txId = await land(a, late, leg.id, on);
    clock += 20 * 60 * 1000;
    const after = await report(a, late, leg.id, { txId }, on);
    expect(legOf(after, leg.id).status).toBe('confirmed');
    expect([after.status, after.expiresAt]).toEqual(['expired', late.expiresAt]);
    const next = await post(a, legUrl(late, first(late, 1).id, 'build'), {}, on);
    expect(next.statusCode).toBe(410);
    await on.close();
  });

  it('refuses an order stored with steps on two chains, on every route, and writes nothing', async () => {
    const a = await someone('passkey');
    // As API-1 stored a buy across two chains: one row in orders, a step on each chain.
    const id = randomUUID();
    await data.db.insert(orders).values({
      id,
      type: 'buy',
      ownerSolana: a.solana,
      ownerEvm: a.evm,
      summary: 'Buy $1,000.00 of your plan on Solana and Robinhood Chain',
      request: { type: 'buy', owner: a.owner, amountUsd: 1000, proposalId: plans.solana },
      preparedBy: 'app',
      status: 'open',
      expiresAt: new Date(Date.now() + 600_000),
      disclaimer: 'x',
    });
    const step = (chainId: HomeChain, kind: 'create_vault' | 'approve') => ({
      id: randomUUID(),
      orderId: id,
      chainId,
      seq: 0,
      kind,
      signer: 'owner' as const,
      description: 'old',
      trades: [],
      expected: [],
      status: 'planned' as const,
      attempt: 0,
      trigger: 'manual' as const,
      provenance: 'mock' as const,
    });
    const rows = [step('solana', 'create_vault'), step('robinhood', 'approve')];
    await data.db.insert(legs).values(rows);
    const legId = rows[0]?.id ?? '';

    const refusal = {
      error: 'this order has steps on 2 chains, and an order is on one: it can no longer be used',
      fix: 'Make the order again.',
      details: { retryable: false },
    };
    const tries: Sent[] = [
      { method: 'GET', url: `/v1/orders/${id}` },
      { method: 'POST', url: legUrl({ id }, legId, 'build') },
      { method: 'POST', url: legUrl({ id }, legId, 'report'), payload: { txId: 'x' } },
      { method: 'POST', url: legUrl({ id }, legId, 'cancel') },
      { method: 'POST', url: `/v1/mock/orders/${id}/legs/${legId}/land` },
    ];
    for (const sent of tries) {
      const res = await call(a, sent);
      expect([sent.url, res.statusCode, OrderError.parse(res.json())]).toEqual([
        sent.url,
        409,
        refusal,
      ]);
    }
    // To anybody else it is still an id that does not exist.
    expect((await get(await someone(), `/v1/orders/${id}`)).statusCode).toBe(404);
    // Nothing was written: the order and its steps are as they were stored, and nothing was built.
    const [row] = await data.db.select().from(orders).where(eq(orders.id, id));
    expect(row?.status).toBe('open');
    const stored = await data.db.select().from(legs).where(eq(legs.orderId, id));
    expect(stored.map((l) => [l.status, l.attempt, l.error]).sort()).toEqual([
      ['planned', 0, null],
      ['planned', 0, null],
    ]);
    const attempts = await data.db
      .select()
      .from(legAttempts)
      .where(
        inArray(
          legAttempts.legId,
          rows.map((r) => r.id),
        ),
      );
    expect(attempts).toEqual([]);

    // An older order on one chain whose step carries no deposit still reads; building it is refused.
    const old = randomUUID();
    await data.db.insert(orders).values({
      id: old,
      type: 'buy',
      ownerSolana: a.solana,
      ownerEvm: null,
      summary: 'old',
      request: {
        type: 'buy',
        owner: { solana: a.solana },
        amountUsd: 1000,
        proposalId: plans.solana,
      },
      preparedBy: 'app',
      status: 'open',
      expiresAt: new Date(Date.now() + 600_000),
      disclaimer: 'x',
    });
    const only = { ...step('solana', 'create_vault'), orderId: old };
    await data.db.insert(legs).values([only]);
    expect((await get(a, `/v1/orders/${old}`)).statusCode).toBe(200);
    const build = await post(a, legUrl({ id: old }, only.id, 'build'));
    expect([build.statusCode, build.json().error]).toEqual([
      409,
      'this order was planned before a step carried its deposit: make it again',
    ]);
  });

  it('does not relay signed bytes for an order that has expired', async () => {
    let clock = Date.now();
    const timed = await testApp({ issuer: issuer.issuer, db: data.db, now: () => new Date(clock) });
    const on = timed.app;
    const expired = {
      error: 'this order has expired: nothing was sent',
      code: 'ORDER_EXPIRED',
      fix: 'Make the order again.',
    };

    // The last step of an order that was signed once: a day and an hour on, its bytes arrive.
    const a = await someone('robinhood');
    const cash = await openVault(a, on, timed.registry);
    const { placed, deposit } = await toDeposit(a, on);
    const built = await build(a, placed, deposit.id, on);
    const before = await cash();
    clock += 25 * 60 * 60 * 1000;
    expect((await read(a, placed, on)).status).toBe('expired');
    const signedTx = mockOf('robinhood', timed.registry).sign(built.tx);
    const late = await post(a, legUrl(placed, deposit.id, 'report'), { signedTx }, on);
    expect([late.statusCode, late.json()]).toEqual([410, expired]);
    // Nothing was sent: the cash is in the wallet, the step is as it was, the order is still expired.
    expect(before - (await cash())).toBe(0n);
    const after = await read(a, placed, on);
    expect([after.status, legOf(after, deposit.id).status]).toEqual(['expired', 'built']);
    expect(attemptsOf(after, deposit.id)).toEqual([[1, 'built']]);

    // A step that is not the last, of an order nobody signed: relayed, its cash would sit in a vault
    // whose trades are then refused.
    const s = await someone('solana');
    await fund(s, on);
    const unsigned = await order(s, { amountUsd: 600 }, on);
    const create = await build(s, unsigned, first(unsigned).id, on);
    clock += 16 * 60 * 1000;
    const bytes = await post(
      s,
      legUrl(unsigned, first(unsigned).id, 'report'),
      { signedTx: create.tx.payload },
      on,
    );
    expect([bytes.statusCode, bytes.json()]).toEqual([410, expired]);
    expect(await timed.registry.get('solana').adapter.getVaults(s.solana)).toEqual([]);
    await on.close();
  });

  it('an order nobody signed expires after 15 minutes', async () => {
    const a = await someone();
    let clock = Date.now();
    const timed = await testApp({ issuer: issuer.issuer, db: data.db, now: () => new Date(clock) });
    const placed = await order(a, { amountUsd: 600 }, timed.app);
    clock += 16 * 60 * 1000;
    const res = await post(a, legUrl(placed, first(placed).id, 'build'), {}, timed.app);
    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe('ORDER_EXPIRED');
    const after = await read(a, placed, timed.app);
    expect(after.status).toBe('expired');
    const [row] = await data.db.select().from(orders).where(eq(orders.id, placed.id));
    expect(row?.status).toBe('expired');
    expect(await data.db.select().from(legs).where(eq(legs.orderId, placed.id))).toHaveLength(4);
    await timed.app.close();
  });
});
