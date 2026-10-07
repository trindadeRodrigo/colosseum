import { ChainError, OrderDetail, PersonWithdrawalsResponse } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import { SELL_TO_CASH_NOT_OFFERED } from '../../orders/withdraw';
import { orderFlow, walletOf } from '../../testing/flow';
import {
  type HomeChain,
  type Person,
  person,
  planFixture,
  type TestIssuer,
  testApp,
  testDb,
  testIssuer,
} from '../../testing/harness';

// A withdrawal through HTTP, on both chain families of the mock: an order of type `withdraw` for a vault
// the signed-in person owns, built step by step, landed and reported like any other, with the tokens
// in the owner's wallet at the end. Anybody else's vault is a vault that is not there.

vi.setConfig({ testTimeout: 60_000 });

const CHAINS: HomeChain[] = ['solana', 'robinhood'];

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
let plans: Record<HomeChain, string>;
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('withdraw');
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

const { post, openVault, settleAll, read, build, land, report } = orderFlow({
  app: () => app,
  registry: () => registry,
  plans: () => plans,
});
const someone = async (chain: HomeChain) => data.track(await person(issuer, chain));

/** The person's one vault as the chain has it. */
async function vaultOf(who: Person, chain: HomeChain) {
  const [vault] = await registry.get(chain).adapter.getVaults(walletOf(who));
  if (!vault) throw new Error('no vault');
  return vault;
}
const held = async (who: Person, chain: HomeChain, asset: string) =>
  BigInt(
    (await registry.get(chain).adapter.getWalletHoldings(walletOf(who))).find(
      (h) => h.asset === asset,
    )?.raw ?? '0',
  );
const withdraw = (who: Person | null, vault: string, more: object = {}) =>
  post(who, '/v1/orders', { type: 'withdraw', vaults: [vault], sellToCash: false, ...more });

describe.each(CHAINS)('POST /v1/orders, a withdrawal on %s', (chain) => {
  it('takes everything out to the owner’s wallet, step by step, and the order is done', async () => {
    const a = await someone(chain);
    await openVault(a);
    const vault = await vaultOf(a, chain);
    const tokens = [vault.cash, ...vault.positions].filter((h) => BigInt(h.raw) > 0n);
    expect(tokens.length).toBeGreaterThan(1);
    const before = await Promise.all(tokens.map((t) => held(a, chain, t.asset)));

    const res = await withdraw(a, vault.address);
    expect(res.statusCode, res.body).toBe(200);
    const order = OrderDetail.parse(res.json());
    expect(order.type).toBe('withdraw');
    expect(order.legs.every((l) => l.kind === 'withdraw' && l.signer === 'owner')).toBe(true);
    expect(order.legs.flatMap((l) => l.withdrawals ?? []).map((w) => w.asset)).toEqual(
      tokens.map((t) => t.asset),
    );
    // read back as it was stored, withdrawals and all
    expect((await read(a, order)).legs.map((l) => l.withdrawals)).toEqual(
      order.legs.map((l) => l.withdrawals),
    );

    const done = await settleAll(a, order);
    expect(done.status).toBe('done');
    const after = await vaultOf(a, chain);
    expect([after.cash, ...after.positions].every((h) => BigInt(h.raw) === 0n)).toBe(true);
    for (const [i, t] of tokens.entries())
      expect((await held(a, chain, t.asset)) - (before[i] ?? 0n)).toBe(BigInt(t.raw));
  });

  it('takes part of the cash, exactly as asked, and refuses a unit more than the vault holds', async () => {
    const a = await someone(chain);
    await openVault(a);
    // a plan that is all invested keeps no cash: put some in, as a second buy's deposit does
    const vault = await vaultOf(a, chain);
    const most = [vault.cash, ...vault.positions].reduce((x, y) =>
      BigInt(y.raw) > BigInt(x.raw) ? y : x,
    );
    const part = (BigInt(most.raw) / 2n).toString();
    const before = await held(a, chain, most.asset);
    const over = await withdraw(a, vault.address, {
      withdrawals: [{ asset: most.asset, amountRaw: (BigInt(most.raw) + 1n).toString() }],
    });
    expect(over.statusCode).toBe(409);
    const res = await withdraw(a, vault.address, {
      withdrawals: [{ asset: most.asset, amountRaw: part }],
    });
    expect(res.statusCode, res.body).toBe(200);
    const order = OrderDetail.parse(res.json());
    expect(order.legs.map((l) => l.withdrawals)).toMatchObject([
      [{ asset: most.asset, amountRaw: part, heldRaw: most.raw }],
    ]);
    await settleAll(a, order);

    // The person's withdrawals, from the server: this one, valued as it was ordered, and nobody else's.
    const listed = await app.inject({ url: '/v1/me/withdrawals', headers: a.headers });
    expect(listed.statusCode, listed.body).toBe(200);
    const { withdrawals } = PersonWithdrawalsResponse.parse(listed.json());
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0]).toMatchObject({ orderId: order.id, chain, vault: vault.address });
    expect(withdrawals[0]?.steps).toMatchObject([
      {
        legId: order.legs[0]?.id,
        status: 'confirmed',
        withdrawals: [{ asset: most.asset, amountRaw: part }],
      },
    ]);
    const [took] = withdrawals[0]?.steps[0]?.withdrawals ?? [];
    expect(took?.valued?.usd).toMatch(/^\d+\.\d{2}$/);
    expect(Number(took?.valued?.usd)).toBeGreaterThan(0);
    expect(took?.valued?.source).toBeTruthy();
    expect(withdrawals[0]?.steps[0]?.txId).toBeTruthy();
    const b = await someone(chain);
    const other = await app.inject({ url: '/v1/me/withdrawals', headers: b.headers });
    expect(other.json()).toEqual({ withdrawals: [] });
    expect((await app.inject({ url: '/v1/me/withdrawals' })).statusCode).toBe(401);
    const after = await vaultOf(a, chain);
    const left = [after.cash, ...after.positions].find((h) => h.asset === most.asset);
    expect(BigInt(left?.raw ?? '0')).toBe(BigInt(most.raw) - BigInt(part));
    expect((await held(a, chain, most.asset)) - before).toBe(BigInt(part));
  });

  it('needs a sign-in, and answers a stranger as it answers a vault that is not there', async () => {
    const a = await someone(chain);
    const b = await someone(chain);
    await openVault(a);
    const vault = await vaultOf(a, chain);
    expect((await withdraw(null, vault.address)).statusCode).toBe(401);
    const theirs = await withdraw(b, vault.address);
    expect(theirs.statusCode).toBe(404);
    // nothing of the vault is said to them, and nothing left it
    expect(theirs.body).not.toContain(walletOf(a));
    expect((await vaultOf(a, chain)).cash.raw).toBe(vault.cash.raw);
  });

  it('refuses selling to cash with the sentence the screen shows', async () => {
    const a = await someone(chain);
    await openVault(a);
    const res = await withdraw(a, (await vaultOf(a, chain)).address, { sellToCash: true });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe(SELL_TO_CASH_NOT_OFFERED);
  });

  it('switches auto-follow off as the first step where the vault has it on', async () => {
    const a = await someone(chain);
    await openVault(a);
    const vault = await vaultOf(a, chain);
    const { adapter, mock } = registry.get(chain);
    await mock?.send(await adapter.buildSetAutoFollow({ vault: vault.address, on: true }));
    const order = OrderDetail.parse((await withdraw(a, vault.address)).json());
    expect(order.legs[0]?.kind).toBe('set_auto_follow');
    expect(order.legs.slice(1).every((l) => l.kind === 'withdraw')).toBe(true);
    expect(order.warnings).toEqual([]);
    const done = await settleAll(a, order);
    expect(done.status).toBe('done');
    const after = await vaultOf(a, chain);
    expect(after.autoFollow).toBe(false);
    expect(await adapter.listAutoFollowVaults()).not.toContain(vault.address);
  });

  it('two orders for the same vault: the second builds nothing once the first has emptied it', async () => {
    const a = await someone(chain);
    await openVault(a);
    const vault = await vaultOf(a, chain);
    const first = OrderDetail.parse((await withdraw(a, vault.address)).json());
    const second = OrderDetail.parse((await withdraw(a, vault.address)).json());
    await settleAll(a, first);
    const leg = second.legs[0];
    if (!leg) throw new Error('no step');
    const late = await post(a, `/v1/orders/${second.id}/legs/${leg.id}/build`);
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toMatch(/nothing was built/);
  });
});

describe('a withdrawal with a token that cannot move', () => {
  it('skips that token’s step with its reason, signs the rest, and the order is done with the skip on it', async () => {
    const a = await someone('solana');
    await openVault(a);
    const vault = await vaultOf(a, 'solana');
    const stuck = vault.positions.find((p) => BigInt(p.raw) > 0n)?.asset;
    if (!stuck) throw new Error('the vault holds no position');
    // The same chain, with that one token frozen by its issuer, as the Solana adapter says it.
    const { app: frozen } = await testApp({
      issuer: issuer.issuer,
      db: data.db,
      wrap: (inner) => ({
        ...inner,
        get: (c) => {
          const entry = inner.get(c);
          return {
            ...entry,
            adapter: {
              ...entry.adapter,
              buildWithdrawInKind: async (args) => {
                if (args.assets?.includes(stuck))
                  throw new ChainError(
                    'BalanceUnreadable',
                    "the vault's account of it is frozen by its issuer",
                  );
                return entry.adapter.buildWithdrawInKind(args);
              },
            },
          };
        },
      }),
    });
    undo.push(() => frozen.close());
    const res = await post(
      a,
      '/v1/orders',
      { type: 'withdraw', vaults: [vault.address], sellToCash: false },
      frozen,
    );
    const order = OrderDetail.parse(res.json());
    const leg = order.legs.find((l) => l.withdrawals?.[0]?.asset === stuck);
    if (!leg) throw new Error('no step for the frozen token');
    // In order, as a wallet signs them: the frozen token's step is refused and skipped, the others land.
    let latest = order;
    for (const step of order.legs) {
      if (step.id !== leg.id) {
        await build(a, order, step.id, frozen);
        latest = await report(
          a,
          order,
          step.id,
          { txId: await land(a, order, step.id, frozen) },
          frozen,
        );
        continue;
      }
      const built = await post(a, `/v1/orders/${order.id}/legs/${leg.id}/build`, undefined, frozen);
      expect(built.statusCode).toBe(409);
      expect(built.json().error).toMatch(/skipped: .*frozen by its issuer/);
      latest = await read(a, order, frozen);
      const skipped = latest.legs.find((l) => l.id === leg.id);
      expect(skipped?.status).toBe('skipped');
      expect(skipped?.error).toEqual({
        code: 'BalanceUnreadable',
        message: "the vault's account of it is frozen by its issuer",
        retryable: false,
      });
    }
    // the steps after it did not wait for it, and the order is done once they are
    const done = await read(a, order, frozen);
    expect(latest.legs.filter((l) => l.status === 'confirmed')).toHaveLength(order.legs.length - 1);
    expect(done.status).toBe('done');
    expect(done.legs.filter((l) => l.status === 'skipped').map((l) => l.id)).toEqual([leg.id]);
    const after = await vaultOf(a, 'solana');
    expect(BigInt(after.cash.raw)).toBe(0n);
    expect(after.positions.find((p) => p.asset === stuck)?.raw).toBe(
      vault.positions.find((p) => p.asset === stuck)?.raw,
    );
  });
});
