import { orders, vaultLifetimes } from '@colosseum/db';
import {
  ClosedVaultsResponse,
  OrderDetail,
  OrderError,
  PortfolioHistoryResponse,
  PortfolioPlansResponse,
  PortfolioResponse,
  VaultLifetimeResponse,
  VaultResponse,
} from '@colosseum/schemas';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainEntry, ChainRegistry } from '../../orders/chains';
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
import { seedSnapshot } from '../../testing/portfolio-world';

// Closing a vault and opening it again (gate VAULT-CLOSE-REUSE), through HTTP on both mock chains and
// the real database: only the owner closes, only an empty vault closes, a closed vault is in none of
// the person's lists and sums, and one opened again counts its figures from then on.

vi.setConfig({ testTimeout: 60_000 });

const CHAINS: HomeChain[] = ['solana', 'robinhood'];

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
let plans: Record<HomeChain, string>;
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('vault-close');
  data = await testDb();
  undo.push(() => data.cleanUp());
  plans = {
    solana: await data.storePlan(planFixture('solana')),
    robinhood: await data.storePlan(planFixture('robinhood')),
  };
  ({ app, registry } = await testApp({ issuer: issuer.issuer, db: data.db, wrap: pricing }));
  undo.push(() => app.close());
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

/** Assets a chain answers no price for, where a test says so: what such a holding is worth is unknown. */
let priceless = new Set<string>();
afterEach(() => {
  priceless = new Set();
});
const pricing = (inner: ChainRegistry): ChainRegistry => {
  const dress = (e: ChainEntry): ChainEntry => ({
    ...e,
    adapter: {
      ...e.adapter,
      getPrices: async (assets) =>
        (await e.adapter.getPrices(assets)).filter((p) => !priceless.has(p.asset)),
    } as ChainEntry['adapter'],
  });
  return { ...inner, get: (c) => dress(inner.get(c)), active: () => inner.active().map(dress) };
};

const { post, get, fund, order, openVault, settleAll } = orderFlow({
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

/** Takes everything out of the vault, so that it is empty. */
async function empty(who: Person, chain: HomeChain, address: string) {
  const res = await post(who, '/v1/orders', {
    type: 'withdraw',
    vaults: [address],
    sellToCash: false,
  });
  expect(res.statusCode, res.body).toBe(200);
  expect((await settleAll(who, OrderDetail.parse(res.json()))).status).toBe('done');
  const after = await vaultOf(who, chain);
  expect([after.cash, ...after.positions].every((h) => h.raw === '0')).toBe(true);
}

const close = (who: Person | null, chain: HomeChain, address: string) =>
  post(who, `/v1/vaults/${chain}/${address}/close`);
const reopen = (who: Person | null, chain: HomeChain, address: string) =>
  post(who, `/v1/vaults/${chain}/${address}/reopen`);

async function listed(who: Person) {
  const res = await get(who, '/v1/portfolio');
  expect(res.statusCode, res.body).toBe(200);
  return PortfolioResponse.parse(res.json()).chains.flatMap((c) => c.vaults.map((v) => v.address));
}
async function plansOf(who: Person) {
  const res = await get(who, '/v1/portfolio/plans');
  expect(res.statusCode, res.body).toBe(200);
  return PortfolioPlansResponse.parse(res.json()).chains.flatMap((c) => c.plans);
}
async function closedOf(who: Person) {
  const res = await get(who, '/v1/portfolio/closed');
  expect(res.statusCode, res.body).toBe(200);
  return ClosedVaultsResponse.parse(res.json()).vaults;
}
async function historyOf(who: Person, address: string) {
  const from = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const res = await get(who, `/v1/portfolio/history?step=10m&from=${from}&address=${address}`);
  expect(res.statusCode, res.body).toBe(200);
  return PortfolioHistoryResponse.parse(res.json()).chains.flatMap((c) => c.vaults);
}

describe.each(CHAINS)('closing a vault on %s', (chain) => {
  it('closes only an empty vault, and only for its owner', async () => {
    const a = await someone(chain);
    const b = await someone(chain);
    await openVault(a);
    const { address } = await vaultOf(a, chain);

    // what it holds is withdrawn first
    const full = await close(a, chain, address);
    expect(full.statusCode).toBe(409);
    expect(OrderError.parse(full.json()).code).toBe('NOT_EMPTY');
    await empty(a, chain, address);

    // another person's vault is answered as one that does not exist, and nobody signed out is asked
    expect((await close(b, chain, address)).statusCode).toBe(404);
    expect((await reopen(b, chain, address)).statusCode).toBe(404);
    expect((await close(null, chain, address)).statusCode).toBe(401);
    expect((await reopen(null, chain, address)).statusCode).toBe(401);
    const [untouched] = await data.db
      .select()
      .from(vaultLifetimes)
      .where(and(eq(vaultLifetimes.chainId, chain), eq(vaultLifetimes.address, address)));
    expect(untouched).toBeUndefined();

    const res = await close(a, chain, address);
    expect(res.statusCode, res.body).toBe(200);
    const closed = VaultLifetimeResponse.parse(res.json());
    expect(closed).toMatchObject({ chain, address, reopenedAt: null });
    expect(closed.closedAt).not.toBeNull();
    // a second close is the first: its time stands
    const again = VaultLifetimeResponse.parse((await close(a, chain, address)).json());
    expect(again.closedAt).toBe(closed.closedAt);
  });

  it('does not close a vault that holds a token with no price, however little; dust it can value, it does', async () => {
    const a = await someone(chain);
    await openVault(a);
    const vault = await vaultOf(a, chain);
    // everything out but one unit of one holding: dust, worth well under a cent
    const [kept] = vault.positions.filter((p) => BigInt(p.raw) > 1n);
    if (!kept) throw new Error('the vault holds no position');
    const res = await post(a, '/v1/orders', {
      type: 'withdraw',
      vaults: [vault.address],
      sellToCash: false,
      withdrawals: [vault.cash, ...vault.positions]
        .filter((h) => BigInt(h.raw) > 0n)
        .map((h) => ({
          asset: h.asset,
          amountRaw: (h.asset === kept.asset ? BigInt(h.raw) - 1n : BigInt(h.raw)).toString(),
        })),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await settleAll(a, OrderDetail.parse(res.json()))).status).toBe('done');

    // with no price for it, what it holds is not known to be nothing
    priceless = new Set([kept.asset]);
    const unpriced = await close(a, chain, vault.address);
    expect(unpriced.statusCode).toBe(409);
    expect(OrderError.parse(unpriced.json()).code).toBe('NOT_EMPTY');
    // priced, the unit is dust under a cent, and the vault closes
    priceless = new Set();
    expect((await close(a, chain, vault.address)).statusCode).toBe(200);
  });

  it('does not close a vault while an order on it is unfinished, and does once it has run out', async () => {
    const a = await someone(chain);
    await openVault(a);
    const { address } = await vaultOf(a, chain);
    await empty(a, chain, address);
    // a deposit into it, made and not signed: its steps could still put money in it
    await fund(a);
    const pending = await order(a, { amountUsd: 40 });
    const refused = await close(a, chain, address);
    expect(refused.statusCode).toBe(409);
    expect(OrderError.parse(refused.json()).code).toBe('ORDER_UNFINISHED');
    // run out, it moves nothing more
    await data.db
      .update(orders)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(orders.id, pending.id));
    expect((await close(a, chain, address)).statusCode).toBe(200);
  });

  it('leaves a closed vault out of every list and sum, and names it among the closed ones', async () => {
    const a = await someone(chain);
    await openVault(a);
    const { address } = await vaultOf(a, chain);
    expect(await listed(a)).toContain(address);
    const numberBefore = (await plansOf(a)).find((p) => p.address === address)?.number;
    expect(numberBefore).toBeGreaterThan(0);
    await empty(a, chain, address);
    expect((await close(a, chain, address)).statusCode).toBe(200);

    expect(await listed(a)).not.toContain(address);
    expect((await plansOf(a)).map((p) => p.address)).not.toContain(address);
    await seedSnapshot(data.db, {
      chain,
      address,
      owner: walletOf(a),
      observedAt: new Date(Date.now() - 60_000),
    });
    expect(await historyOf(a, address)).toEqual([]);
    const exposure = await get(a, `/v1/portfolio/exposure?chain=${chain}&address=${address}`);
    expect(exposure.statusCode, exposure.body).toBe(200);
    expect(JSON.stringify(exposure.json())).not.toContain(address);

    // its own list: with the number it keeps, and when it was closed
    const [entry] = (await closedOf(a)).filter((v) => v.address === address);
    expect(entry).toMatchObject({ chain, address, number: numberBefore, provenance: 'mock' });

    // its page still reads, and tells its owner alone that it is closed
    const own = VaultResponse.parse((await get(a, `/v1/vaults/${chain}/${address}`)).json());
    expect(own.vault.closedAt).toBe(entry?.closedAt);
    const visitor = (await get(null, `/v1/vaults/${chain}/${address}`)).json();
    expect(visitor.vault.closedAt).toBeUndefined();
  });

  it('opened again, counts from then: nothing it held or took in before is added up', async () => {
    const a = await someone(chain);
    await openVault(a);
    const { address } = await vaultOf(a, chain);
    await empty(a, chain, address);
    expect((await close(a, chain, address)).statusCode).toBe(200);
    const before = new Date(Date.now() - 60_000);
    await seedSnapshot(data.db, { chain, address, owner: walletOf(a), observedAt: before });

    const res = await reopen(a, chain, address);
    expect(res.statusCode, res.body).toBe(200);
    const life = VaultLifetimeResponse.parse(res.json());
    expect(life.closedAt).toBeNull();
    expect(life.reopenedAt).not.toBeNull();
    expect(await listed(a)).toContain(address);
    expect((await closedOf(a)).map((v) => v.address)).not.toContain(address);

    const [plan] = (await plansOf(a)).filter((p) => p.address === address);
    expect(plan?.countsFrom).toBe(life.reopenedAt);
    // the first life's deposit is not put in again, and its snapshots are not its history
    expect(plan?.putIn).toBeNull();
    expect(await historyOf(a, address)).toEqual([]);
    const after = new Date(Date.now() + 1_000);
    await seedSnapshot(data.db, { chain, address, owner: walletOf(a), observedAt: after });
    const res2 = await get(
      a,
      `/v1/portfolio/history?step=10m&from=${before.toISOString()}&to=${new Date(Date.now() + 60_000).toISOString()}&address=${address}`,
    );
    const [series] = PortfolioHistoryResponse.parse(res2.json()).chains.flatMap((c) => c.vaults);
    expect(series?.points.map((p) => Date.parse(p.observedAt))).toEqual([after.getTime()]);
  });

  it('a deposit into a closed vault opens it again, and only that deposit is put in', async () => {
    const a = await someone(chain);
    await openVault(a);
    const { address } = await vaultOf(a, chain);
    await empty(a, chain, address);
    expect((await close(a, chain, address)).statusCode).toBe(200);

    // the same plan again goes into the same vault: it is not hidden while money is in it
    await fund(a);
    const placed = await order(a, { amountUsd: 40 });
    expect(placed.legs.map((l) => l.kind)).not.toContain('create_vault');
    expect(await listed(a)).toContain(address);
    expect((await settleAll(a, placed)).status).toBe('done');
    const [plan] = (await plansOf(a)).filter((p) => p.address === address);
    expect(plan?.countsFrom).not.toBeNull();
    expect(plan?.putIn?.orders).toBe(1);
    expect(Number(plan?.putIn?.usd)).toBe(40);
  });
});
