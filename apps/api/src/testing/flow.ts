import { BuildLegResponse, OrderDetail } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import type { ChainRegistry } from '../orders/chains';
import type { HomeChain, Person } from './harness';

// For tests only: an order taken through its steps over HTTP, as the web does it. One set of helpers
// for every test file that walks an order, bound to the app and the plans the file works with.

export type Sent = { method: 'GET' | 'POST' | 'PUT'; url: string; payload?: unknown };

/** The chain a test person is on. A passkey person has none until a test picks one and says so. */
export function chainOf(who: Person): HomeChain {
  if (!who.chain) throw new Error('this person has no chain yet: pick one first');
  return who.chain;
}
/** The person's wallet on their chain. */
export const walletOf = (who: Person) => (chainOf(who) === 'solana' ? who.solana : who.evm);

export function orderFlow(defaults: {
  app: () => FastifyInstance;
  registry: () => ChainRegistry;
  /** The plan a buy names when the test names none: one made for the person's chain. */
  plans: () => Record<HomeChain, string>;
}) {
  const call = (
    who: Pick<Person, 'headers'> | null,
    sent: Sent,
    on: FastifyInstance = defaults.app(),
  ) =>
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
  const put = (who: Person | null, url: string, payload?: unknown, on?: FastifyInstance) =>
    call(who, { method: 'PUT', url, payload }, on);

  /** Mock cash and mock gas for the person's wallet on their chain. */
  async function fund(who: Person, on?: FastifyInstance, cashUsd = 10_000) {
    const res = await post(who, '/v1/mock/fund', { chain: chainOf(who), cashUsd }, on);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().provenance).toBe('mock');
  }

  async function order(
    who: Person,
    body: { amountUsd?: number; maxSlippageBps?: number; proposalId?: string } = {},
    on?: FastifyInstance,
  ): Promise<OrderDetail> {
    const res = await post(
      who,
      '/v1/orders',
      {
        type: 'buy',
        owner: who.owner,
        amountUsd: 1000,
        proposalId: defaults.plans()[chainOf(who)],
        ...body,
      },
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

  const read = async (who: Person, o: { id: string }, on?: FastifyInstance) =>
    OrderDetail.parse((await get(who, `/v1/orders/${o.id}`, on)).json());
  const legOf = (o: OrderDetail, legId: string) => {
    const leg = o.legs.find((l) => l.id === legId);
    if (!leg) throw new Error('no such leg');
    return leg;
  };
  /** The step at `seq`: an order is on one chain, so its steps are numbered once. */
  const first = (o: OrderDetail, seq = 0) => {
    const leg = o.legs.find((l) => l.seq === seq);
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
   * A second buy of the plan, taken up to its deposit: the vault is open and every leg before the
   * deposit has settled. The deposit is the leg that moves the person's cash.
   */
  async function toDeposit(who: Person, on?: FastifyInstance, amountUsd = 10) {
    const placed = await order(who, { amountUsd }, on);
    const deposit = placed.legs.find((l) => l.kind === 'deposit');
    if (!deposit) throw new Error('the vault is not open yet');
    await settleAll(who, placed, on, (leg) => leg.id === deposit.id);
    return { placed, deposit };
  }

  /** Opens the person's vault for the plan with a first, settled buy. Answers a read of their cash. */
  async function openVault(who: Person, on?: FastifyInstance, reg = defaults.registry()) {
    await fund(who, on);
    await settleAll(who, await order(who, { amountUsd: 100 }, on), on);
    const chain = chainOf(who);
    return async () => {
      const held = await reg.get(chain).adapter.getWalletHoldings(walletOf(who));
      return BigInt(held.find((h) => h.asset === `${chain}:usdc`)?.raw ?? '0');
    };
  }

  const attemptsOf = (o: OrderDetail, legId: string) =>
    o.attempts.filter((x) => x.legId === legId).map((x) => [x.n, x.status]);

  return {
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
  };
}
