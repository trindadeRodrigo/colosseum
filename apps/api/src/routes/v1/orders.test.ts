import { legAttempts, legs, orders, proposals, vaults } from '@colosseum/db';
import { BasketTx, BuildLegResponse, ChainError, type ChainId, Order } from '@colosseum/schemas';
import { eq, inArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import {
  type Person,
  person,
  planFixture,
  type TestIssuer,
  testApp,
  testDb,
  testIssuer,
} from '../../testing/harness';
import { OrderDetail } from './orders';
import { PortfolioResponse } from './portfolio';

// API-1, the walking skeleton of M1 and the identity checks of G-LINK, through HTTP on the mock chain
// and the real database. Every test makes its own wallets and its own orders; afterAll deletes the
// rows that hang off them and nothing else.

let issuer: TestIssuer;
let stranger: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
let planId: string;

// What beforeAll has made so far, to be taken away again even if it failed halfway.
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('test');
  stranger = await testIssuer('other');
  data = await testDb();
  undo.push(() => data.cleanUp());
  planId = await data.storePlan();
  ({ app, registry } = await testApp({ issuer: issuer.issuer, db: data.db }));
  undo.push(() => app.close());
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const someone = async (from: TestIssuer = issuer) => data.track(await person(from));

type Sent = { method: 'GET' | 'POST'; url: string; payload?: unknown };
const call = (who: Pick<Person, 'headers'> | null, sent: Sent, on: FastifyInstance = app) =>
  on.inject({
    method: sent.method,
    url: sent.url,
    headers: who?.headers ?? {},
    ...(sent.payload === undefined ? {} : { payload: sent.payload as object }),
  });
const post = (who: Person | null, url: string, payload?: unknown, on?: FastifyInstance) =>
  call(who, { method: 'POST', url, payload }, on);
const get = (who: Person | null, url: string, on?: FastifyInstance) =>
  call(who, { method: 'GET', url }, on);

async function fund(
  who: Person,
  chains: ChainId[] = ['solana', 'robinhood'],
  on?: FastifyInstance,
) {
  for (const chain of chains) {
    const res = await post(who, '/v1/mock/fund', { chain, cashUsd: 10_000 }, on);
    expect(res.statusCode).toBe(200);
    expect(res.json().provenance).toBe('mock');
  }
}

async function order(
  who: Person,
  body: { amountUsd?: number; chains?: ChainId[] } = {},
  on?: FastifyInstance,
): Promise<OrderDetail> {
  const res = await post(
    who,
    '/v1/orders',
    { type: 'buy', owner: who.owner, amountUsd: 1000, proposalId: planId, ...body },
    on,
  );
  expect(res.statusCode, res.body).toBe(200);
  return OrderDetail.parse(res.json());
}

const legUrl = (o: { id: string }, legId: string, step: string) =>
  `/v1/orders/${o.id}/legs/${legId}/${step}`;

async function build(who: Person, o: OrderDetail, legId: string, on?: FastifyInstance) {
  const res = await post(who, legUrl(o, legId, 'build'), undefined, on);
  expect(res.statusCode, res.body).toBe(200);
  return BuildLegResponse.parse(res.json());
}

/** Stands in for the wallet: the mock chain lands the leg's latest attempt and gives its id. */
async function land(who: Person, o: OrderDetail, legId: string, on?: FastifyInstance) {
  const res = await post(who, `/v1/mock/orders/${o.id}/legs/${legId}/land`, undefined, on);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().txId as string;
}

async function report(
  who: Person,
  o: OrderDetail,
  legId: string,
  body: object,
  on?: FastifyInstance,
) {
  const res = await post(who, legUrl(o, legId, 'report'), body, on);
  expect(res.statusCode, res.body).toBe(200);
  return OrderDetail.parse(res.json());
}

const read = async (who: Person, o: { id: string }) =>
  OrderDetail.parse((await get(who, `/v1/orders/${o.id}`)).json());
const legOf = (o: OrderDetail, legId: string) => {
  const leg = o.legs.find((l) => l.id === legId);
  if (!leg) throw new Error('no such leg');
  return leg;
};
const first = (o: OrderDetail, chain: ChainId, seq = 0) => {
  const leg = o.legs.find((l) => l.chain === chain && l.seq === seq);
  if (!leg) throw new Error('no such leg');
  return leg;
};

/** Builds, lands and reports every leg in order. Returns the order as the last report left it. */
async function settleAll(
  who: Person,
  o: OrderDetail,
  on?: FastifyInstance,
  until?: (leg: OrderDetail['legs'][number]) => boolean,
): Promise<OrderDetail> {
  let latest = o;
  for (const leg of o.legs) {
    if (until?.(leg)) break;
    await build(who, o, leg.id, on);
    latest = await report(who, o, leg.id, { txId: await land(who, o, leg.id, on) }, on);
    expect(legOf(latest, leg.id).status).toBe('confirmed');
  }
  return latest;
}

/**
 * A second buy of the plan on one chain, taken up to its deposit: the vault is open and every leg
 * before the deposit has settled. The deposit is the leg that moves the person's cash.
 */
async function toDeposit(who: Person, chain: ChainId, on?: FastifyInstance, amountUsd = 10) {
  const placed = await order(who, { amountUsd, chains: [chain] }, on);
  const deposit = placed.legs.find((l) => l.kind === 'deposit');
  if (!deposit) throw new Error('the vault is not open yet');
  await settleAll(who, placed, on, (leg) => leg.id === deposit.id);
  return { placed, deposit };
}

/** Opens the person's vault for the plan on one chain with a first, settled buy. */
async function openVault(who: Person, chain: ChainId, on?: FastifyInstance, reg = registry) {
  await fund(who, [chain], on);
  await settleAll(who, await order(who, { amountUsd: 100, chains: [chain] }, on), on);
  const wallet = chain === 'solana' ? who.solana : who.evm;
  return async () => {
    const held = await reg.get(chain).adapter.getWalletHoldings(wallet);
    return BigInt(held.find((h) => h.asset === `${chain}:usdc`)?.raw ?? '0');
  };
}

const attemptsOf = (o: OrderDetail, legId: string) =>
  o.attempts.filter((x) => x.legId === legId).map((x) => [x.n, x.status]);

describe('the walking skeleton: a buy across two chains on the mock', () => {
  it('goes from an intent to settled legs, and reads back in the portfolio', async () => {
    const a = await someone();
    await fund(a);

    const placed = await order(a);
    expect(Order.parse(placed)).toMatchObject({ type: 'buy', status: 'open', owner: a.owner });
    expect(placed.summary).toBe('Buy $1,000.00 of your plan on Solana and Robinhood Chain');
    // One leg per step per chain, in the order they are signed. Solana opens the vault with the cash,
    // then trades one asset per transaction; Robinhood Chain approves, then opens and buys in one.
    expect(placed.legs.map((l) => [l.chain, l.seq, l.kind, l.trades.length])).toEqual([
      ['solana', 0, 'create_vault', 0],
      ['solana', 1, 'swap', 1],
      ['solana', 2, 'swap', 1],
      ['solana', 3, 'swap', 1],
      ['robinhood', 0, 'approve', 0],
      ['robinhood', 1, 'create_vault', 3],
    ]);
    expect(placed.legs.every((l) => l.status === 'planned' && l.provenance === 'mock')).toBe(true);
    expect(placed.legs.every((l) => l.signer === 'owner' && l.attempt === 0)).toBe(true);
    // The deposit is the dollar token only, and the trades buy the plan's assets in its proportions.
    const cashIn = (chain: ChainId) =>
      placed.legs.filter((l) => l.chain === chain).flatMap((l) => l.trades);
    expect(cashIn('solana').map((t) => [t.sell, t.buy, t.amountInRaw])).toEqual([
      ['solana:usdc', 'solana:spy', '300000000'],
      ['solana:usdc', 'solana:nvda', '180000000'],
      ['solana:usdc', 'solana:gold', '120000000'],
    ]);
    expect(cashIn('robinhood').map((t) => t.amountInRaw)).toEqual([
      '200000000',
      '120000000',
      '80000000',
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
      expect(tx.signer).toBe(leg.chain === 'solana' ? a.solana : a.evm);
      expect([tx.provenance, tx.preview.provenance, tx.legKind]).toEqual([
        'mock',
        'mock',
        leg.kind,
      ]);
      expect(attempt).toMatchObject({ legId: leg.id, n: 1, status: 'built', txId: null });
      expect(attempt.messageHash).toBe(tx.messageHash);

      // One leg is handed over as signed bytes for the server to relay; the rest are sent by the
      // wallet and reported by id.
      const relayed = leg.chain === 'solana' && leg.seq === 1;
      const sent = relayed ? { signedTx: tx.payload } : { txId: await land(a, placed, leg.id) };
      latest = await report(a, placed, leg.id, sent);
      const settled = legOf(latest, leg.id);
      expect(settled).toMatchObject({ status: 'confirmed', attempt: 1, error: null });
      expect(settled.txId).toBeTruthy();
      expect(settled.explorerUrl).toBe(`mock://${leg.chain}/tx/${settled.txId}`);
    }

    expect(latest.status).toBe('done');
    expect(latest.attempts).toHaveLength(placed.legs.length);
    expect(latest.attempts.every((x) => x.status === 'confirmed' && x.n === 1 && x.txId)).toBe(
      true,
    );
    // Signed once, the order stays open for a day.
    expect(latest.expiresAt - placed.expiresAt).toBeGreaterThan(23 * 60 * 60);
    expect(await read(a, placed)).toEqual(latest);

    // The portfolio, read back from the chain: what was bought, at its targets, all labelled MOCK.
    const res = await get(a, '/v1/portfolio');
    expect(res.statusCode, res.body).toBe(200);
    const portfolio = PortfolioResponse.parse(res.json());
    expect(portfolio.chains.map((c) => [c.chain, c.mode, c.provenance, c.vaults.length])).toEqual([
      ['solana', 'mock', 'mock', 1],
      ['robinhood', 'mock', 'mock', 1],
    ]);
    const [solana, robinhood] = portfolio.chains.map((c) => c.vaults[0]);
    expect(solana).toMatchObject({ owner: a.solana, valueUsd: '599.40', provenance: 'mock' });
    expect(robinhood).toMatchObject({ owner: a.evm, valueUsd: '399.60', provenance: 'mock' });
    for (const vault of [solana, robinhood]) {
      expect(vault?.cash.raw).toBe('0');
      expect(vault?.positions.map((p) => [p.targetBps, p.weightBps, p.driftBps])).toEqual([
        [5000, 5000, 0],
        [3000, 3000, 0],
        [2000, 2000, 0],
      ]);
    }
    expect(solana?.positions.map((p) => p.valueUsd)).toEqual(['299.70', '179.82', '119.88']);
    const prices = portfolio.chains.flatMap((c) => c.prices);
    expect(prices).toHaveLength(8);
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
    expect(stored).toHaveLength(6);
    expect(stored.every((r) => r.provenance === 'mock' && r.source === 'chain-mock')).toBe(true);
    const cached = await data.db
      .select()
      .from(vaults)
      .where(or(eq(vaults.owner, a.solana), eq(vaults.owner, a.evm)));
    expect(cached.map((v) => [v.chainId, v.valueUsd, v.provenance]).sort()).toEqual([
      ['robinhood', '399.60', 'mock'],
      ['solana', '599.40', 'mock'],
    ]);
  });

  it('buying the same plan again adds to the vault that is already there', async () => {
    const a = await someone();
    await fund(a, ['solana']);
    await settleAll(a, await order(a, { amountUsd: 600, chains: ['solana'] }));

    const again = await order(a, { amountUsd: 100, chains: ['solana'] });
    expect(again.legs.map((l) => l.kind)).toEqual(['deposit', 'swap', 'swap', 'swap']);
    expect((await settleAll(a, again)).status).toBe('done');
    const portfolio = PortfolioResponse.parse((await get(a, '/v1/portfolio')).json());
    expect(portfolio.chains.map((c) => c.vaults.map((v) => v.valueUsd))).toEqual([['699.30'], []]);
  });

  it('a transaction that reverts fails the leg with the chain’s reason, and a new build is a new attempt', async () => {
    const a = await someone();
    await fund(a, ['solana']);
    const placed = await order(a, { amountUsd: 600, chains: ['solana'] });
    const leg = first(placed, 'solana');
    await build(a, placed, leg.id);
    registry.get('solana').mock?.revertNext({ code: 'ReceivedTooLittle', message: 'price moved' });
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

describe('sign-in', () => {
  /** Every /v1 route that needs a person, with a body that would pass if the caller were signed in. */
  const routes = (o: OrderDetail, who: Person): Sent[] => [
    {
      method: 'POST',
      url: '/v1/orders',
      payload: { type: 'buy', owner: who.owner, amountUsd: 10 },
    },
    { method: 'GET', url: `/v1/orders/${o.id}` },
    { method: 'POST', url: legUrl(o, first(o, 'solana').id, 'build') },
    { method: 'POST', url: legUrl(o, first(o, 'solana').id, 'report'), payload: { txId: 'x' } },
    { method: 'POST', url: legUrl(o, first(o, 'solana').id, 'cancel') },
    { method: 'GET', url: '/v1/portfolio' },
    { method: 'POST', url: '/v1/mock/fund', payload: { chain: 'solana', cashUsd: 1 } },
    { method: 'POST', url: `/v1/mock/orders/${o.id}/legs/${first(o, 'solana').id}/land` },
  ];

  it('refuses every route with no token, a bad token, or a token from another issuer', async () => {
    const a = await someone();
    const placed = await order(a);
    const [bearer = '', token = ''] = [a.headers.authorization, a.headers['privy-id-token']];
    const other = await person(stranger);
    const access = (claims: Record<string, unknown>, expiresAt?: number) =>
      issuer.sign(a.sub, claims, expiresAt).then((t) => `Bearer ${t}`);
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
        authorization: `Bearer ${await stranger.sign(a.sub, { iss: issuer.issuer.issuer, aud: issuer.issuer.audience })}`,
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
    const a = await someone();
    await fund(a, ['robinhood']);
    // The token lists the EVM address in upper case; the order and the built transaction carry it
    // lower-case, and a body that spells it the token's way is not an address at all.
    const shouted = { ...a.owner, evm: `0x${a.evm.slice(2).toUpperCase()}` };
    const res = await post(a, '/v1/orders', { type: 'buy', owner: shouted, amountUsd: 10 });
    expect(res.statusCode).toBe(400);
    const placed = await order(a, { chains: ['robinhood'] });
    const { tx } = await build(a, placed, first(placed, 'robinhood').id);
    expect(tx.signer).toBe(a.evm);
  });
});

describe('ownership: an order belongs to the wallets that made it', () => {
  it('wallet B cannot read, build, report or land wallet A’s order', async () => {
    const [a, b] = [await someone(), await someone()];
    await fund(a);
    const placed = await order(a);
    const leg = first(placed, 'solana');
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
    const [a, b] = [await someone(), await someone()];
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
    const placed = await order(a, { amountUsd: 400, chains: ['robinhood'] }, wrong.app);
    const leg = first(placed, 'robinhood');
    const res = await post(a, legUrl(placed, leg.id, 'build'), undefined, wrong.app);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(b.evm);
    const after = OrderDetail.parse((await get(a, `/v1/orders/${placed.id}`, wrong.app)).json());
    expect(after.attempts).toEqual([]);
    expect(legOf(after, leg.id).status).toBe('planned');
    await wrong.app.close();
  });

  it('refuses an owner in the body that the token does not carry', async () => {
    const [a, b] = [await someone(), await someone()];
    const claims = [a.owner, { solana: a.solana }, { solana: b.solana, evm: a.evm }];
    for (const owner of claims) {
      const res = await post(b, '/v1/orders', {
        type: 'buy',
        owner,
        amountUsd: 1000,
        proposalId: planId,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/not a wallet of the signed-in person/);
    }
    const made = await data.db
      .select({ id: orders.id })
      .from(orders)
      .where(or(eq(orders.ownerSolana, a.solana), eq(orders.ownerEvm, a.evm)));
    expect(made).toEqual([]);
  });
});

describe('a leg settles only on the transaction that was built for it', () => {
  it('an unrelated transaction, successful or not, does not confirm a leg', async () => {
    const a = await someone();
    await fund(a);
    const placed = await order(a);
    const [create, swap] = [first(placed, 'solana', 0), first(placed, 'solana', 1)];
    await build(a, placed, create.id);
    const createTx = await land(a, placed, create.id);
    await report(a, placed, create.id, { txId: createTx });
    const built = await build(a, placed, swap.id);
    const before = await read(a, placed);

    // A confirmed transaction of the same wallet, one of another chain, and one that never existed.
    await build(a, placed, first(placed, 'robinhood').id);
    const approveTx = await land(a, placed, first(placed, 'robinhood').id);
    for (const txId of [createTx, approveTx, 'no-such-transaction']) {
      const res = await post(a, legUrl(placed, swap.id, 'report'), { txId });
      expect([txId, res.statusCode]).toEqual([txId, 409]);
      expect(res.json().error).toBe('that transaction is not the one built for this step');
    }
    // Signed bytes that are not this leg's are not relayed.
    const other = await post(a, legUrl(placed, swap.id, 'report'), { signedTx: 'bm90IG91cnM=' });
    expect(other.statusCode).toBe(409);
    expect(other.json().details).toEqual({ chainCode: 'NotBuiltHere', retryable: false });
    // Both at once is neither.
    const both = { txId: createTx, signedTx: built.tx.payload };
    expect((await post(a, legUrl(placed, swap.id, 'report'), both)).statusCode).toBe(400);

    const after = await read(a, placed);
    expect(legOf(after, swap.id)).toEqual(legOf(before, swap.id));
    expect(legOf(after, swap.id)).toMatchObject({ status: 'built', txId: null });
  });

  it('a leg reported twice settles once', async () => {
    const a = await someone();
    await fund(a, ['solana']);
    const placed = await order(a, { amountUsd: 600, chains: ['solana'] });
    const leg = first(placed, 'solana');
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
          const relay: typeof entry.probe.relay = (signedTx, hash) => {
            relays += 1;
            return entry.probe.relay(signedTx, hash);
          };
          return { ...entry, probe: { ...entry.probe, relay } };
        },
      }),
    });
    const on = counted.app;
    await fund(a, ['solana'], on);
    const placed = await order(a, { amountUsd: 600, chains: ['solana'] }, on);
    const leg = first(placed, 'solana');

    // The first attempt reverts. Handing the same bytes over again sends nothing.
    const one = await build(a, placed, leg.id, on);
    counted.registry.get('solana').mock?.revertNext({ code: 'SpentTooMuch', message: 'reverted' });
    const failed = await report(a, placed, leg.id, { signedTx: one.tx.payload }, on);
    expect(legOf(failed, leg.id)).toMatchObject({ status: 'failed', error: { retryable: false } });
    expect(await report(a, placed, leg.id, { signedTx: one.tx.payload }, on)).toEqual(failed);
    expect(relays).toBe(1);

    // A new build is new bytes; those are relayed once too, and the old ones are never sent again.
    const two = await build(a, placed, leg.id, on);
    const built = OrderDetail.parse((await get(a, `/v1/orders/${placed.id}`, on)).json());
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
    for (const chain of ['solana', 'robinhood'] as const) {
      const a = await someone();
      const cash = await openVault(a, chain);
      const { placed, deposit } = await toDeposit(a, chain);
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
  });

  it('on Solana, builds again once the first transaction can no longer land', async () => {
    const a = await someone();
    let clock = Date.now();
    const timed = await testApp({ issuer: issuer.issuer, db: data.db, now: () => new Date(clock) });
    const on = timed.app;
    const cash = await openVault(a, 'solana', on, timed.registry);
    const { placed, deposit } = await toDeposit(a, 'solana', on);
    const before = await cash();
    const one = await build(a, placed, deposit.id, on);
    expect((await post(a, legUrl(placed, deposit.id, 'build'), undefined, on)).statusCode).toBe(
      409,
    );

    // Past its last valid block the first transaction is dead, and the mock chain refuses it.
    clock += 2 * 60 * 1000;
    const two = await build(a, placed, deposit.id, on);
    expect(two.attempt.n).toBe(2);
    const mock = timed.registry.get('solana').mock;
    await expect(mock?.send({ messageHash: one.tx.messageHash })).rejects.toMatchObject({
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
    const cash = await openVault(a, 'solana', on, timed.registry);
    const { placed, deposit } = await toDeposit(a, 'solana', on);
    const before = await cash();
    await build(a, placed, deposit.id, on);
    // The wallet sent it and it landed, but nobody told the API. Then its validity ran out.
    const txId = await land(a, placed, deposit.id, on);
    clock += 2 * 60 * 1000;
    const again = await post(a, legUrl(placed, deposit.id, 'build'), undefined, on);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/has landed/);
    const after = OrderDetail.parse((await get(a, `/v1/orders/${placed.id}`, on)).json());
    expect(legOf(after, deposit.id)).toMatchObject({ status: 'confirmed', attempt: 1, txId });
    expect(attemptsOf(after, deposit.id)).toEqual([[1, 'confirmed']]);
    expect(before - (await cash())).toBe(10_000_000n);
    await on.close();
  });

  it('on an EVM chain, builds again only after a cancel, and still settles on the attempt that landed', async () => {
    const a = await someone();
    const cash = await openVault(a, 'robinhood');
    const { placed, deposit } = await toDeposit(a, 'robinhood');
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
    const two = await build(a, placed, deposit.id);
    expect(two.attempt.n).toBe(2);

    // The wallet sends the cancelled one anyway. It lands, and its id is reported.
    const stale = await registry.get('robinhood').mock?.send({ messageHash: one.tx.messageHash });
    const done = await report(a, placed, deposit.id, { txId: stale?.txId });
    expect(legOf(done, deposit.id)).toMatchObject({
      status: 'confirmed',
      attempt: 1,
      txId: stale?.txId,
      error: null,
    });
    // The second attempt is closed: the server will not relay it, and the leg is not built again.
    expect(attemptsOf(done, deposit.id)).toEqual([
      [1, 'confirmed'],
      [2, 'expired'],
    ]);
    const late = await post(a, legUrl(placed, deposit.id, 'report'), { signedTx: two.tx.payload });
    expect(late.statusCode).toBe(409);
    expect((await post(a, legUrl(placed, deposit.id, 'build'))).statusCode).toBe(409);
    expect(done.status).toBe('done');
    expect(before - (await cash())).toBe(10_000_000n);
  });

  it('cancels only an attempt that was built and has not landed', async () => {
    const a = await someone();
    await openVault(a, 'robinhood');
    const { placed, deposit } = await toDeposit(a, 'robinhood');
    // Nothing built yet.
    expect((await post(a, legUrl(placed, deposit.id, 'cancel'))).statusCode).toBe(409);
    await build(a, placed, deposit.id);
    // It landed, unreported: the cancel finds it and the leg settles instead.
    const txId = await land(a, placed, deposit.id);
    const res = await post(a, legUrl(placed, deposit.id, 'cancel'));
    expect(res.statusCode).toBe(409);
    expect(legOf(await read(a, placed), deposit.id)).toMatchObject({ status: 'confirmed', txId });

    // On Solana an attempt cannot be cancelled while it can still land: only time closes it.
    await openVault(a, 'solana');
    const sol = await toDeposit(a, 'solana');
    await build(a, sol.placed, sol.deposit.id);
    const early = await post(a, legUrl(sol.placed, sol.deposit.id, 'cancel'));
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatch(/can still land/);
    expect(attemptsOf(await read(a, sol.placed), sol.deposit.id)).toEqual([[1, 'built']]);
  });

  it('racing a build against the report of a landed transaction loses nothing, on both chains', async () => {
    for (const chain of ['solana', 'robinhood'] as const) {
      const a = await someone();
      const cash = await openVault(a, chain);
      const before = await cash();
      const rounds = 12;
      for (let i = 0; i < rounds; i++) {
        const { placed, deposit } = await toDeposit(a, chain);
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
  });

  it('finds a cancelled transaction that landed before the leg is built again', async () => {
    const a = await someone();
    await openVault(a, 'robinhood');
    for (let i = 0; i < 6; i++) {
      const { placed, deposit } = await toDeposit(a, 'robinhood');
      const one = await build(a, placed, deposit.id);
      expect((await post(a, legUrl(placed, deposit.id, 'cancel'))).statusCode).toBe(200);
      const sent = await registry.get('robinhood').mock?.send({ messageHash: one.tx.messageHash });
      const [rebuilt, reported] = await Promise.all([
        post(a, legUrl(placed, deposit.id, 'build')),
        post(a, legUrl(placed, deposit.id, 'report'), { txId: sent?.txId }),
      ]);
      expect([i, rebuilt.statusCode, reported.statusCode]).toEqual([i, 409, 200]);
      const after = await read(a, placed);
      expect(legOf(after, deposit.id)).toMatchObject({ status: 'confirmed', attempt: 1 });
      expect(attemptsOf(after, deposit.id)).toEqual([[1, 'confirmed']]);
    }
  });

  it('two builds at once make one attempt', async () => {
    const a = await someone();
    await fund(a, ['solana']);
    for (let i = 0; i < 8; i++) {
      const placed = await order(a, { amountUsd: 600, chains: ['solana'] });
      const leg = first(placed, 'solana');
      const both = await Promise.all([
        post(a, legUrl(placed, leg.id, 'build')),
        post(a, legUrl(placed, leg.id, 'build')),
        post(a, legUrl(placed, leg.id, 'build')),
      ]);
      expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
      expect(attemptsOf(await read(a, placed), leg.id)).toEqual([[1, 'built']]);
    }
  });

  it('a transaction that never lands leaves the leg sent, then expired, and it is built again', async () => {
    const a = await someone();
    let clock = Date.now();
    const timed = await testApp({ issuer: issuer.issuer, db: data.db, now: () => new Date(clock) });
    const on = timed.app;
    await fund(a, ['solana'], on);
    const placed = await order(a, { amountUsd: 600, chains: ['solana'] }, on);
    const leg = first(placed, 'solana');
    await build(a, placed, leg.id, on);
    timed.registry.get('solana').mock?.dropNext();
    const txId = await land(a, placed, leg.id, on);
    const waiting = await report(a, placed, leg.id, { txId }, on);
    expect(legOf(waiting, leg.id)).toMatchObject({ status: 'sent', txId });
    expect(waiting.status).toBe('open');
    // While it may still land, it is not built again.
    expect((await post(a, legUrl(placed, leg.id, 'build'), undefined, on)).statusCode).toBe(409);

    // Its validity runs out. The next read tracks it again and finds it expired.
    clock += 2 * 60 * 1000;
    const late = OrderDetail.parse((await get(a, `/v1/orders/${placed.id}`, on)).json());
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

  it('builds the legs of one chain in order, and not before the one before has settled', async () => {
    const a = await someone();
    await fund(a, ['solana']);
    const placed = await order(a, { amountUsd: 600, chains: ['solana'] });
    const res = await post(a, legUrl(placed, first(placed, 'solana', 1).id, 'build'));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/earlier step/);
    // A report before any build has nothing to settle.
    const early = await post(a, legUrl(placed, first(placed, 'solana').id, 'report'), {
      txId: 'x',
    });
    expect(early.statusCode).toBe(409);
  });
});

describe('refusals', () => {
  it('refuses a chain that is switched off, with the order code', async () => {
    const a = await someone();
    const off = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      env: { CHAIN_MODE_ROBINHOOD: 'off' },
    });
    const res = await post(
      a,
      '/v1/orders',
      { type: 'buy', owner: a.owner, amountUsd: 1000, proposalId: planId },
      off.app,
    );
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      error: 'Robinhood Chain is switched off on this server',
      code: 'CHAIN_UNAVAILABLE',
      details: { retryable: false },
    });
    // The chain that is on still works on that server, and the one that is off is not in the portfolio.
    const solanaOnly = await order(a, { amountUsd: 600, chains: ['solana'] }, off.app);
    expect(solanaOnly.legs.every((l) => l.chain === 'solana')).toBe(true);
    const portfolio = PortfolioResponse.parse((await get(a, '/v1/portfolio', off.app)).json());
    expect(portfolio.chains.map((c) => c.chain)).toEqual(['solana']);
    await off.app.close();
  });

  it('maps a refused build onto the order code and keeps `retryable`', async () => {
    const a = await someone();
    // Not funded: the chain refuses, and nothing the person does not change will fix it.
    const placed = await order(a, { amountUsd: 600, chains: ['solana'] });
    const leg = first(placed, 'solana');
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
      [{ chains: ['base'] }, 422, /nothing on base/],
      [{ proposalId: undefined, family: 'core' }, 501, /not built yet/],
      [{ amountUsd: 0.0001, chains: ['solana'] }, 422, /less than one cent/],
    ];
    for (const [change, status, error] of cases) {
      const res = await post(a, '/v1/orders', {
        type: 'buy',
        owner: a.owner,
        amountUsd: 1000,
        proposalId: planId,
        ...change,
      });
      expect([JSON.stringify(change), res.statusCode]).toEqual([JSON.stringify(change), status]);
      expect(res.json().error).toMatch(error);
    }
    const other = await post(a, '/v1/orders', { type: 'settings', vault: a.evm, autoFollow: true });
    expect(other.statusCode).toBe(501);
    // An owner with no address for a chain of the plan.
    const half = await post(a, '/v1/orders', {
      type: 'buy',
      owner: { solana: a.solana },
      amountUsd: 1000,
      proposalId: planId,
    });
    expect(half.statusCode).toBe(422);
    expect((await get(a, '/v1/orders/not-an-id')).statusCode).toBe(400);
    expect((await get(a, '/v1/orders/4b1c0f0e-3f8e-4d0e-9d2b-0d7a3a6b1c2d')).statusCode).toBe(404);
  });

  it('refuses a stored plan it cannot use when the order is made, not at every build', async () => {
    const a = await someone();
    const buy = (proposalId: string, more: object = {}) =>
      post(a, '/v1/orders', { type: 'buy', owner: a.owner, amountUsd: 1000, proposalId, ...more });

    // Weights that do not add up to a whole are not targets a vault can take.
    const short = planFixture();
    for (const recipe of short.recipes)
      recipe.components = recipe.components.map((c, i) =>
        i === 0 ? { ...c, weightBps: c.weightBps - 1000 } : c,
      );
    const res = await buy(await data.storePlan(short));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/weights/);

    // A stored plan that no longer reads as a plan: a conflict with what is stored, not a server fault.
    const brokenId = await data.storePlan();
    await data.db
      .update(proposals)
      .set({ proposal: { not: 'a plan' } as never })
      .where(eq(proposals.id, brokenId));
    const broken = await buy(brokenId);
    expect(broken.statusCode).toBe(409);
    expect(broken.json().error).toMatch(/cannot be read/);

    // The most one order may buy.
    expect((await buy(planId, { amountUsd: 1_000_000 })).statusCode).toBe(200);
    const over = await buy(planId, { amountUsd: 1_000_000.01 });
    expect(over.statusCode).toBe(422);
    expect(over.json().error).toMatch(/1,000,000/);
    expect((await buy(planId, { amountUsd: 1e300 })).statusCode).toBe(422);
  });

  it('answers a request it cannot read with a 4xx, never a 500', async () => {
    const a = await someone();
    const placed = await order(a);
    const json = { ...a.headers, 'content-type': 'application/json' };
    const send = (url: string, headers: Record<string, string>, payload?: string) =>
      app.inject({ method: 'POST', url, headers, ...(payload === undefined ? {} : { payload }) });
    const buildUrl = legUrl(placed, first(placed, 'solana').id, 'build');
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
    const a = await someone();
    let clock = Date.now();
    const timed = await testApp({ issuer: issuer.issuer, db: data.db, now: () => new Date(clock) });
    const on = timed.app;
    await fund(a, ['robinhood'], on);
    const state = async (o: OrderDetail) =>
      OrderDetail.parse((await get(a, `/v1/orders/${o.id}`, on)).json());

    // An id that matches the attempt but was never sent: the chain has not seen it, the clock stays.
    const unsent = await order(a, { amountUsd: 400, chains: ['robinhood'] }, on);
    const approve = first(unsent, 'robinhood');
    const built = await build(a, unsent, approve.id, on);
    const mock = timed.registry.get('robinhood').mock;
    mock?.dropNext();
    const never = await mock?.send({ messageHash: built.tx.messageHash });
    const waiting = await report(a, unsent, approve.id, { txId: never?.txId }, on);
    expect(legOf(waiting, approve.id).status).toBe('sent');
    expect(waiting.expiresAt).toBe(unsent.expiresAt);
    clock += 20 * 60 * 1000;
    expect((await state(unsent)).status).toBe('expired');

    // A transaction that lands after the order expired is recorded, and the order stays expired.
    const late = await order(a, { amountUsd: 400, chains: ['robinhood'] }, on);
    const leg = first(late, 'robinhood');
    await build(a, late, leg.id, on);
    const txId = await land(a, late, leg.id, on);
    clock += 20 * 60 * 1000;
    const after = await report(a, late, leg.id, { txId }, on);
    expect(legOf(after, leg.id).status).toBe('confirmed');
    expect([after.status, after.expiresAt]).toEqual(['expired', late.expiresAt]);
    const next = await post(a, legUrl(late, first(late, 'robinhood', 1).id, 'build'), {}, on);
    expect(next.statusCode).toBe(410);
    await on.close();
  });

  it('an order nobody signed expires after 15 minutes', async () => {
    const a = await someone();
    let clock = Date.now();
    const timed = await testApp({ issuer: issuer.issuer, db: data.db, now: () => new Date(clock) });
    const placed = await order(a, { amountUsd: 600, chains: ['solana'] }, timed.app);
    clock += 16 * 60 * 1000;
    const res = await post(a, legUrl(placed, first(placed, 'solana').id, 'build'), {}, timed.app);
    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe('ORDER_EXPIRED');
    const after = OrderDetail.parse((await get(a, `/v1/orders/${placed.id}`, timed.app)).json());
    expect(after.status).toBe('expired');
    const [row] = await data.db.select().from(orders).where(eq(orders.id, placed.id));
    expect(row?.status).toBe('expired');
    expect(await data.db.select().from(legs).where(eq(legs.orderId, placed.id))).toHaveLength(4);
    await timed.app.close();
  });
});
