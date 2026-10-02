import { legAttempts, legs, orders, vaults } from '@colosseum/db';
import { BasketTx, BuildLegResponse, ChainError, type ChainId, Order } from '@colosseum/schemas';
import { eq, inArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import {
  type Person,
  person,
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

beforeAll(async () => {
  issuer = await testIssuer('test');
  stranger = await testIssuer('other');
  data = await testDb();
  planId = await data.storePlan();
  ({ app, registry } = await testApp({ issuer: issuer.issuer, db: data.db }));
});
afterAll(async () => {
  await app.close();
  await data.cleanUp();
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
async function settleAll(who: Person, o: OrderDetail): Promise<OrderDetail> {
  let latest = o;
  for (const leg of o.legs) {
    await build(who, o, leg.id);
    latest = await report(who, o, leg.id, { txId: await land(who, o, leg.id) });
    expect(legOf(latest, leg.id).status).toBe('confirmed');
  }
  return latest;
}

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
      { method: 'POST', url: `/v1/mock/orders/${placed.id}/legs/${leg.id}/land` },
    ];
    for (const sent of tries) {
      const res = await call(b, sent);
      expect([sent.url, res.statusCode]).toEqual([sent.url, 403]);
      expect(res.body).not.toContain(a.solana);
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

    // A new build is new bytes; those are relayed once too, and the old ones are refused.
    const two = await build(a, placed, leg.id, on);
    const old = await post(a, legUrl(placed, leg.id, 'report'), { signedTx: one.tx.payload }, on);
    expect(old.statusCode).toBe(409);
    const done = await report(a, placed, leg.id, { signedTx: two.tx.payload }, on);
    expect(legOf(done, leg.id)).toMatchObject({ status: 'confirmed', attempt: 2 });
    expect(await report(a, placed, leg.id, { signedTx: two.tx.payload }, on)).toEqual(done);
    expect(relays).toBe(2);
    await on.close();
  });

  it('a leg built twice: the second attempt supersedes, and the first cannot settle it', async () => {
    const a = await someone();
    await fund(a, ['robinhood']);
    const placed = await order(a, { amountUsd: 400, chains: ['robinhood'] });
    const leg = first(placed, 'robinhood');
    expect(leg.kind).toBe('approve');
    const one = await build(a, placed, leg.id);
    const two = await build(a, placed, leg.id);
    expect([one.attempt.n, two.attempt.n]).toEqual([1, 2]);
    expect(two.tx.messageHash).not.toBe(one.tx.messageHash);
    expect((await read(a, placed)).attempts.map((x) => [x.n, x.status])).toEqual([
      [1, 'expired'],
      [2, 'built'],
    ]);

    // The wallet sends the first one anyway, and it lands.
    const mock = registry.get('robinhood').mock;
    const stale = await mock?.send({ messageHash: one.tx.messageHash });
    expect((await registry.get('robinhood').adapter.track(stale?.txId ?? '')).status).toBe(
      'confirmed',
    );
    for (const body of [{ txId: stale?.txId }, { signedTx: one.tx.payload }]) {
      const res = await post(a, legUrl(placed, leg.id, 'report'), body);
      expect(res.statusCode).toBe(409);
    }
    expect(legOf(await read(a, placed), leg.id)).toMatchObject({ status: 'built', attempt: 2 });

    const done = await report(a, placed, leg.id, { txId: await land(a, placed, leg.id) });
    expect(legOf(done, leg.id)).toMatchObject({ status: 'confirmed', attempt: 2 });
    expect(done.attempts.map((x) => [x.n, x.status, x.txId === stale?.txId])).toEqual([
      [1, 'expired', false],
      [2, 'confirmed', false],
    ]);
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
