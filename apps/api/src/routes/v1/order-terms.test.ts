import { orders } from '@colosseum/db';
import { OrderDetail, OrderError, PortfolioResponse } from '@colosseum/schemas';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import { ORDER_LOCK_WAIT_MS } from '../../orders/store';
import { orderFlow } from '../../testing/flow';
import {
  type HomeChain,
  person,
  planFixture,
  type TestIssuer,
  testApp,
  testDb,
  testIssuer,
} from '../../testing/harness';

// The terms an order stated are the terms every step is built with (the guard holds a built step to
// them: packages/sdk/src/guard/run.ts), however the price moves between the order and a build. A step
// whose stated minimum the price can no longer meet is refused, never built at another figure; and a
// buy that stopped after its deposit is finished with the cash already in the vault
// (POST /v1/orders/{id}/continue), by its owner alone, with no second deposit.
//
// Its own app, so its own mock chain: these tests move prices.

vi.setConfig({ testTimeout: 60_000 });

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
let plans: Record<HomeChain, string>;
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('terms');
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

const { post, get, fund, order, legUrl, build, land, report, read, settleAll } = orderFlow({
  app: () => app,
  registry: () => registry,
  plans: () => plans,
});
const someone = async () => data.track(await person(issuer, 'solana'));
const mock = () => {
  const found = registry.get('solana').mock;
  if (!found) throw new Error('not on the mock');
  return found;
};
/** The asset's price times `by`, set on the mock; answers what it was, to put back. */
async function move(asset: string, by: number): Promise<string> {
  const [price] = await registry.get('solana').adapter.getPrices([asset]);
  if (!price) throw new Error(`no price for ${asset}`);
  mock().setPrice(asset, (Number(price.usdPerToken) * by).toFixed(6));
  return price.usdPerToken;
}
const vaultOf = async (who: Awaited<ReturnType<typeof someone>>) =>
  PortfolioResponse.parse((await get(who, '/v1/portfolio')).json()).chains[0]?.vaults[0];
const walletCash = async (who: Awaited<ReturnType<typeof someone>>) =>
  (
    await registry.get('solana').adapter.funding(who.owner.solana ?? '', {
      cashRaw: '0',
      legs: 0,
      newVault: false,
      newAccounts: 0,
    })
  ).cashHaveRaw;

describe('the minimum an order stated', () => {
  it('is the one every step is built with, though the price ticks before each build', async () => {
    const a = await someone();
    await fund(a);
    const placed = await order(a, { amountUsd: 900 });
    const swaps = placed.legs.filter((l) => l.kind === 'swap');
    expect(swaps.length).toBeGreaterThan(0);
    const put: [string, string][] = [];
    try {
      await settleAll(a, placed, undefined, (leg) => leg.kind === 'swap');
      for (const [i, leg] of swaps.entries()) {
        // thirty seconds on, and the token a little cheaper or a little dearer than at the order
        mock().advance(30);
        const asset = leg.trades[0]?.buy ?? '';
        put.push([asset, await move(asset, i % 2 === 0 ? 0.9995 : 1.0005)]);
        const { tx } = await build(a, placed, leg.id);
        // to the unit: what the bytes state is what the order stated, not today's quote less slippage
        expect(tx.preview.minimums.map((m) => m.minOutRaw)).toEqual(
          leg.expected.map((e) => e.minOutRaw),
        );
        const after = await report(a, placed, leg.id, { txId: await land(a, placed, leg.id) });
        const settled = after.legs.find((l) => l.id === leg.id);
        expect(settled?.status).toBe('confirmed');
        // and the order still reads with the minimum it was approved with
        expect(settled?.expected.map((e) => e.minOutRaw)).toEqual(
          leg.expected.map((e) => e.minOutRaw),
        );
      }
      expect((await read(a, placed)).status).toBe('done');
    } finally {
      for (const [asset, was] of put.reverse()) mock().setPrice(asset, was);
    }
  });

  it('is never lowered for a price that moved past it: the step is refused, and nothing is built', async () => {
    const a = await someone();
    await fund(a);
    const placed = await order(a, { amountUsd: 900 });
    const swap = placed.legs.find((l) => l.kind === 'swap');
    if (!swap) throw new Error('the plan has no swap');
    await settleAll(a, placed, undefined, (leg) => leg.kind === 'swap');
    const asset = swap.trades[0]?.buy ?? '';
    const was = await move(asset, 1.05);
    try {
      const res = await post(a, legUrl(placed, swap.id, 'build'));
      expect(res.statusCode).toBe(409);
      const said = OrderError.parse(res.json());
      expect(said).toMatchObject({
        code: 'PRICE_MOVED',
        details: { chainCode: 'PriceMoved', retryable: false },
      });
      expect(said.error).toMatch(/the price has moved since the order was made/);
      expect(said.fix).toMatch(/Make the order again/);
      const now = await read(a, placed);
      const leg = now.legs.find((l) => l.id === swap.id);
      // no attempt was recorded, and the stated terms stand
      expect(now.attempts.filter((x) => x.legId === swap.id)).toEqual([]);
      expect(leg?.expected).toEqual(swap.expected);
    } finally {
      mock().setPrice(asset, was);
    }
  });
});

describe('a buy that stopped after its deposit, finished with the cash in the vault', () => {
  /** A buy whose deposit landed and whose swaps did not: the price moved past the first one. */
  async function stopped() {
    const a = await someone();
    await fund(a, undefined, 5_000);
    const placed = await order(a, { amountUsd: 900 });
    await settleAll(a, placed, undefined, (leg) => leg.kind === 'swap');
    const left = placed.legs.filter((l) => l.kind === 'swap');
    return { a, placed, left };
  }
  const finish = (who: Awaited<ReturnType<typeof someone>> | null, id: string) =>
    post(who, `/v1/orders/${id}/continue`);

  it('is a new order of the swaps left, quoted now, that deposits nothing and spends only the vault’s cash', async () => {
    const { a, placed, left } = await stopped();
    const asset = left[0]?.trades[0]?.buy ?? '';
    const was = await move(asset, 1.05);
    try {
      expect((await post(a, legUrl(placed, left[0]?.id ?? '', 'build'))).statusCode).toBe(409);
      const cashBefore = await walletCash(a);
      const vaultBefore = await vaultOf(a);
      const res = await finish(a, placed.id);
      expect(res.statusCode, res.body).toBe(200);
      const next = OrderDetail.parse(res.json());
      expect(next.id).not.toBe(placed.id);
      expect(next).toMatchObject({
        type: 'buy',
        owner: placed.owner,
        basketId: placed.basketId,
        continues: placed.id,
        status: 'open',
      });
      // no deposit, no approval, no create: swaps only, the same trades in the same order
      expect(next.depositRaw).toBeUndefined();
      expect(next.legs.map((l) => l.kind)).toEqual(left.map(() => 'swap'));
      expect(next.legs.map((l) => l.trades)).toEqual(left.map((l) => l.trades));
      expect(next.legs.every((l) => l.cashRaw === undefined || l.cashRaw === null)).toBe(true);
      // what they spend is in the vault as cash, and no more than that
      const spend = next.legs
        .flatMap((l) => l.trades)
        .reduce((sum, t) => sum + BigInt(t.amountInRaw), 0n);
      expect(spend).toBeLessThanOrEqual(BigInt(vaultBefore?.cash.raw ?? '0'));
      expect(spend).toBe(
        left.flatMap((l) => l.trades).reduce((sum, t) => sum + BigInt(t.amountInRaw), 0n),
      );
      // quoted at the price now: the moved asset's minimum is another figure than the first order's
      expect(next.legs[0]?.expected[0]?.minOutRaw).not.toBe(left[0]?.expected[0]?.minOutRaw);

      // asked again, it is the same order; and the first order builds nothing more
      expect(OrderDetail.parse((await finish(a, placed.id)).json()).id).toBe(next.id);
      const old = await post(a, legUrl(placed, left[0]?.id ?? '', 'build'));
      expect(old.statusCode).toBe(409);
      expect(OrderError.parse(old.json())).toMatchObject({
        error: expect.stringMatching(/another order finishes this one/),
        code: 'ORDER_CONTINUED',
        details: { continuedBy: next.id },
      });

      // signed to its end: the vault holds the assets, and the wallet paid no second deposit
      const done = await settleAll(a, next);
      expect(done.status).toBe('done');
      const vaultAfter = await vaultOf(a);
      expect(
        vaultAfter?.positions
          .filter((p) => p.raw !== '0')
          .map((p) => p.asset)
          .sort(),
      ).toEqual(left.flatMap((l) => l.trades.map((t) => t.buy)).sort());
      expect(BigInt(vaultAfter?.cash.raw ?? '0')).toBe(
        BigInt(vaultBefore?.cash.raw ?? '0') - spend,
      );
      expect(await walletCash(a)).toBe(cashBefore);
    } finally {
      mock().setPrice(asset, was);
    }
  });

  it('is the owner’s alone: anybody else gets the answer an unknown order gets', async () => {
    const { a, placed } = await stopped();
    const b = await someone();
    const answers = [
      await finish(b, placed.id),
      await finish(null, placed.id),
      await finish(a, crypto.randomUUID()),
    ];
    expect(answers.map((r) => r.statusCode)).toEqual([404, 401, 404]);
    // and `continues` is the server's to write: it is no field of a request, so one a buy sends is
    // dropped unread, and the order made finishes nothing
    await fund(b, undefined, 5_000);
    const sent = await post(b, '/v1/orders', {
      type: 'buy',
      owner: b.owner,
      amountUsd: 10,
      proposalId: plans.solana,
      continues: placed.id,
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const made = OrderDetail.parse(sent.json());
    expect(made.continues).toBeUndefined();
    expect((await read(b, made)).continues).toBeUndefined();
    // so the first order is still its owner's to finish
    expect((await finish(a, placed.id)).statusCode).toBe(200);
  });

  it('is refused before the deposit has landed, when nothing is left, and while a built step can still land', async () => {
    const a = await someone();
    await fund(a, undefined, 5_000);
    const placed = await order(a, { amountUsd: 900 });
    const early = await finish(a, placed.id);
    expect(early.statusCode).toBe(409);
    expect(OrderError.parse(early.json())).toMatchObject({
      error: expect.stringMatching(/has not put its cash in the vault yet/),
      code: 'DEPOSIT_NOT_LANDED',
    });

    await settleAll(a, placed, undefined, (leg) => leg.kind === 'swap');
    const swap = placed.legs.find((l) => l.kind === 'swap');
    if (!swap) throw new Error('the plan has no swap');
    // built and not signed: its transaction can still land, so its cash is not planned a second time
    await build(a, placed, swap.id);
    const open = await finish(a, placed.id);
    expect(open.statusCode).toBe(409);
    expect(OrderError.parse(open.json())).toMatchObject({
      code: 'STEP_IN_FLIGHT',
      details: { retryable: true },
    });
    // past its time it can no longer land, and the buy is finished
    mock().advance(10_000);
    expect((await finish(a, placed.id)).statusCode).toBe(200);

    const whole = await someone();
    await fund(whole, undefined, 5_000);
    const all = await order(whole, { amountUsd: 900 });
    await settleAll(whole, all);
    const none = await finish(whole, all.id);
    expect(none.statusCode).toBe(409);
    expect(OrderError.parse(none.json())).toMatchObject({
      error: expect.stringMatching(/nothing left to buy/),
      code: 'NOTHING_LEFT',
    });
  });

  it('is made once for an order: what a continuation left is that continuation’s to finish', async () => {
    const { a, placed, left } = await stopped();
    const next = OrderDetail.parse((await finish(a, placed.id)).json());
    // one of its swaps signed, the rest not
    const [one, ...rest] = next.legs;
    if (!one) throw new Error('the continuation has no step');
    await build(a, next, one.id);
    await report(a, next, one.id, { txId: await land(a, next, one.id) });
    // finishing it is a third order, of the swaps it left alone: the first swap is not bought twice
    const third = OrderDetail.parse((await finish(a, next.id)).json());
    expect(third.continues).toBe(next.id);
    expect(third.legs.map((l) => l.trades)).toEqual(rest.map((l) => l.trades));
    expect(third.legs).toHaveLength(left.length - 1);
    // and the first order is never continued a second time, whatever cash the vault holds by then
    const done = await settleAll(a, third);
    expect(done.status).toBe('done');
    const again = await finish(a, placed.id);
    expect(again.statusCode).toBe(409);
    expect(OrderError.parse(again.json())).toMatchObject({
      error: expect.stringMatching(/another order finishes this one/),
      code: 'ORDER_CONTINUED',
      fix: expect.stringContaining(next.id),
      details: { continuedBy: next.id },
    });
    // and the second names the third
    const second = await finish(a, next.id);
    expect(second.statusCode).toBe(409);
    expect(OrderError.parse(second.json())).toMatchObject({
      code: 'ORDER_CONTINUED',
      details: { continuedBy: third.id },
    });
  });

  it('is refused when the vault no longer holds the cash the steps left would spend', async () => {
    const { a, placed } = await stopped();
    // the owner takes everything out of the vault in between
    const vault = await vaultOf(a);
    const out = await registry.get('solana').adapter.buildWithdrawInKind({
      vault: vault?.address ?? '',
    });
    for (const tx of out) await mock().send(tx);
    const res = await finish(a, placed.id);
    expect(res.statusCode).toBe(409);
    expect(OrderError.parse(res.json())).toMatchObject({
      error: expect.stringMatching(/less than the \d+ the steps left would spend/),
      code: 'VAULT_CASH_SHORT',
    });
  });

  it('says the order is busy, and to try again, when another request holds it past the wait', async () => {
    const { a, placed } = await stopped();
    // another request's transaction holds the order's lock for longer than this one waits
    await data.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`order:${placed.id}`}, 0))`,
      );
      const started = Date.now();
      const res = await finish(a, placed.id);
      expect(res.statusCode).toBe(409);
      expect(OrderError.parse(res.json())).toMatchObject({
        code: 'ORDER_BUSY',
        details: { retryable: true },
      });
      // it waited its bound and no longer
      expect(Date.now() - started).toBeLessThan(ORDER_LOCK_WAIT_MS + 8_000);
    });
    // nothing was stored for it, and once the lock is free the same request goes through
    expect((await finish(a, placed.id)).statusCode).toBe(200);
  });

  it('answers an id that is not one with 400 and a sentence, before anything is looked up', async () => {
    const a = await someone();
    for (const id of ['not-an-id', '123', `${crypto.randomUUID()}x`]) {
      const res = await finish(a, id);
      expect(res.statusCode, id).toBe(400);
      expect(Object.keys(res.json())).toEqual(['error']);
      expect(typeof res.json().error).toBe('string');
    }
  });

  it('is made once when it is asked for twice at the same moment', async () => {
    for (let round = 0; round < 4; round++) {
      const { a, placed } = await stopped();
      const answers = await Promise.all([
        finish(a, placed.id),
        finish(a, placed.id),
        finish(a, placed.id),
      ]);
      // every answer is the one order: the first to hold the lock made it, the others were handed it
      expect(answers.map((r) => r.statusCode)).toEqual([200, 200, 200]);
      const ids = new Set(answers.map((r) => OrderDetail.parse(r.json()).id));
      expect(ids.size).toBe(1);
      const rows = await data.db
        .select({ id: orders.id })
        .from(orders)
        .where(sql`${orders.request}->>'continues' = ${placed.id}`);
      expect(rows).toHaveLength(1);
    }
  });

  it('never lets a step of the first order be built as it is finished: one of the two is refused', async () => {
    for (let round = 0; round < 4; round++) {
      const { a, placed, left } = await stopped();
      const step = left[0]?.id ?? '';
      const [built, finished] = await Promise.all([
        post(a, legUrl(placed, step, 'build')),
        finish(a, placed.id),
      ]);
      // either the step was built first, and the buy is not finished while it can land; or the buy
      // was finished first, and the first order builds nothing more. Never both.
      expect([built.statusCode, finished.statusCode].sort()).toEqual([200, 409]);
      const vault = await vaultOf(a);
      // whichever went through, what can now be signed spends the vault's cash once
      const next = finished.statusCode === 200 ? OrderDetail.parse(finished.json()) : null;
      const planned = (next?.legs ?? [])
        .flatMap((l) => l.trades)
        .reduce((n, t) => n + BigInt(t.amountInRaw), 0n);
      expect(planned).toBeLessThanOrEqual(BigInt(vault?.cash.raw ?? '0'));
    }
  });

  it('is refused on a chain that trades inside its deposit: nothing is in a vault to finish', async () => {
    const r = data.track(await person(issuer, 'robinhood'));
    await fund(r, undefined, 5_000);
    const placed = await order(r, { amountUsd: 900 });
    expect(placed.legs.some((l) => l.kind === 'swap')).toBe(false);
    const res = await finish(r, placed.id);
    expect(res.statusCode).toBe(409);
    expect(OrderError.parse(res.json())).toMatchObject({
      error: expect.stringMatching(/trades in the same step that deposits/),
      code: 'CONTINUE_NOT_SUPPORTED',
    });
  });
});

describe('many requests at once', () => {
  // The database client holds ten connections (postgres.js's default; packages/db). A lock that kept
  // one for each waiting request, with the work on another, stopped everything at ten requests.
  const MORE_THAN_THE_POOL = 15;
  const within = async <T>(ms: number, work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    });
    try {
      return await Promise.race([work, late]);
    } finally {
      clearTimeout(timer);
    }
  };

  it('all answer when more steps are built at once than the pool has connections, on as many orders', async () => {
    const a = await someone();
    await fund(a, undefined, 50_000);
    const placed = [];
    for (let i = 0; i < MORE_THAN_THE_POOL; i++)
      placed.push(await order(a, { amountUsd: 100 + i }));
    const answers = await within(
      30_000,
      Promise.all(placed.map((o) => post(a, legUrl(o, o.legs[0]?.id ?? '', 'build')))),
    );
    // one wallet, one vault: the first to be recorded opens it, and each of the rest is answered,
    // built or refused, never left waiting
    expect(answers).toHaveLength(MORE_THAN_THE_POOL);
    for (const res of answers) expect([200, 409]).toContain(res.statusCode);
    expect(answers.some((res) => res.statusCode === 200)).toBe(true);
    // and the pool is whole afterwards: a read that needs the database answers
    expect((await within(10_000, get(a, `/v1/orders/${placed[0]?.id}`))).statusCode).toBe(200);
  });

  it('all answer when one step is built by more requests at once than the pool has connections', async () => {
    const a = await someone();
    await fund(a, undefined, 5_000);
    const placed = await order(a, { amountUsd: 900 });
    const step = placed.legs[0]?.id ?? '';
    const answers = await within(
      30_000,
      Promise.all(
        Array.from({ length: MORE_THAN_THE_POOL }, () => post(a, legUrl(placed, step, 'build'))),
      ),
    );
    expect(answers.filter((res) => res.statusCode === 200)).toHaveLength(1);
    expect(answers.filter((res) => res.statusCode === 409)).toHaveLength(MORE_THAN_THE_POOL - 1);
    expect((await read(a, placed)).attempts).toHaveLength(1);
    expect((await within(10_000, get(a, `/v1/orders/${placed.id}`))).statusCode).toBe(200);
  });

  it('all answer when a buy is finished by more requests at once than the pool has connections', async () => {
    const a = await someone();
    await fund(a, undefined, 5_000);
    const placed = await order(a, { amountUsd: 900 });
    await settleAll(a, placed, undefined, (leg) => leg.kind === 'swap');
    const answers = await within(
      30_000,
      Promise.all(
        Array.from({ length: MORE_THAN_THE_POOL }, () =>
          post(a, `/v1/orders/${placed.id}/continue`),
        ),
      ),
    );
    // every one is answered: with the one order, or told the order is busy and to try again
    for (const res of answers) expect([200, 409]).toContain(res.statusCode);
    const ids = new Set(
      answers
        .filter((res) => res.statusCode === 200)
        .map((res) => OrderDetail.parse(res.json()).id),
    );
    expect(ids.size).toBe(1);
    const rows = await data.db
      .select({ id: orders.id })
      .from(orders)
      .where(sql`${orders.request}->>'continues' = ${placed.id}`);
    expect(rows).toHaveLength(1);
  });
});
