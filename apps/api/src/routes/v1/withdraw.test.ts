import { OrderDetail } from '@colosseum/schemas';
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

const { post, openVault, settleAll, read } = orderFlow({
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
