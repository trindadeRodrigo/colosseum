import { PortfolioResponse } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import { orderFlow, walletOf } from '../../testing/flow';
import {
  type HomeChain,
  type PersonKind,
  person,
  planFixture,
  type TestIssuer,
  testApp,
  testDb,
  testIssuer,
} from '../../testing/harness';

// API-2: a buy when the plan keeps cash. A person's targets may add up to less than 10,000 basis
// points, and what they leave is the plan's cash share. A buy deposits the whole amount, trades only
// the invested share, and leaves the rest in the vault as cash. Through HTTP, on both chain families of
// the mock.

vi.setConfig({ testTimeout: 60_000 });

const CHAINS: HomeChain[] = ['solana', 'robinhood'];
/** 95% in three assets, 5% kept as cash. */
const NINETY_FIVE = { spy: 5000, nvda: 2500, gold: 2000 };

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
let plans: Record<HomeChain, string>;
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('cash');
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
const { post, get, fund, order, legUrl, build, land, report, read, first, settleAll } = orderFlow({
  app: () => app,
  registry: () => registry,
  plans: () => plans,
});

/** The person's one vault, as the portfolio reads it back from the chain. */
async function vaultOf(who: Awaited<ReturnType<typeof someone>>) {
  const portfolio = PortfolioResponse.parse((await get(who, '/v1/portfolio')).json());
  const [vault] = portfolio.chains.flatMap((c) => c.vaults);
  if (!vault) throw new Error('no vault');
  return vault;
}
/** What the wallet holds of the chain's dollar token. */
async function walletCash(who: Awaited<ReturnType<typeof someone>>, chain: HomeChain) {
  const held = await registry.get(chain).adapter.getWalletHoldings(walletOf(who));
  return BigInt(held.find((h) => h.asset === `${chain}:usdc`)?.raw ?? '0');
}

describe('a buy when the plan keeps cash', () => {
  it('at 10,000: deposits the whole amount and trades all of it', async () => {
    for (const chain of CHAINS) {
      const a = await someone(chain);
      await fund(a);
      const placed = await order(a);
      const moved = placed.legs.filter((l) => l.cashRaw !== undefined);
      expect(moved.map((l) => l.cashRaw)).toEqual(
        chain === 'solana' ? ['1000000000'] : ['1000000000', '1000000000'],
      );
      // The deposit is on the order, once. Where a chain needs an approval the legs repeat it, so
      // their sum is twice what the order moves.
      expect(placed.depositRaw).toBe('1000000000');
      expect(moved.reduce((n, l) => n + BigInt(l.cashRaw ?? '0'), 0n)).toBe(
        chain === 'solana' ? 1_000_000_000n : 2_000_000_000n,
      );
      const traded = placed.legs.flatMap((l) => l.trades).map((t) => BigInt(t.amountInRaw));
      expect(traded.reduce((n, x) => n + x, 0n)).toBe(1_000_000_000n);
      const settled = await settleAll(a, placed);
      // Read back from what is stored, it is the same figure: what left the wallet.
      expect([settled.status, settled.depositRaw]).toEqual(['done', '1000000000']);
      const vault = await vaultOf(a);
      expect([vault.cash.raw, vault.valueUsd]).toEqual(['0', '999']);
      expect(await walletCash(a, chain)).toBe(9_000_000_000n);
      expect(10_000_000_000n - (await walletCash(a, chain))).toBe(BigInt(settled.depositRaw ?? 0));
    }
  });

  it('at 9,500: deposits the whole amount, trades 95% of it, and leaves 5% in the vault as cash', async () => {
    for (const chain of CHAINS) {
      const planId = await data.storePlan(planFixture(chain, NINETY_FIVE));
      const a = await someone(chain);
      await fund(a);
      const placed = await order(a, { proposalId: planId });

      // The step that moves the cash carries the whole deposit: more than its trades spend.
      expect(placed.legs.map((l) => [l.kind, l.cashRaw, l.trades.length])).toEqual(
        chain === 'solana'
          ? [
              ['create_vault', '1000000000', 0],
              ['swap', undefined, 1],
              ['swap', undefined, 1],
              ['swap', undefined, 1],
            ]
          : [
              ['approve', '1000000000', 0],
              ['create_vault', '1000000000', 3],
            ],
      );
      expect(placed.legs.flatMap((l) => l.trades).map((t) => [t.buy, t.amountInRaw])).toEqual([
        [`${chain}:spy`, '500000000'],
        [`${chain}:nvda`, '250000000'],
        [`${chain}:gold`, '200000000'],
      ]);
      expect(placed.summary).toBe(
        `Deposit $1,000.00 into your plan’s vault on ${registry.name(chain)}`,
      );

      // The transaction that opens the vault takes the whole deposit from the wallet.
      let latest = placed;
      for (const leg of placed.legs) {
        const { tx } = await build(a, placed, leg.id);
        if (leg.kind === 'create_vault') {
          const wallet = tx.preview.changes.filter((c) => c.holder === 'wallet');
          expect(wallet).toEqual([
            { holder: 'wallet', asset: `${chain}:usdc`, deltaRaw: '-1000000000' },
          ]);
          const kept = tx.preview.changes.find(
            (c) => c.holder === 'vault' && c.asset === `${chain}:usdc`,
          );
          // Where the trades ride in the create, what is left in the vault is the cash share.
          expect(kept?.deltaRaw).toBe(chain === 'solana' ? '1000000000' : '50000000');
        }
        latest = await report(a, placed, leg.id, { txId: await land(a, placed, leg.id) });
      }
      expect(latest.status).toBe('done');

      // Read back from the chain: $50 of cash, and the three assets at their targets.
      const vault = await vaultOf(a);
      expect(vault.cash.raw).toBe('50000000');
      expect(vault.positions.map((p) => [p.asset, p.targetBps])).toEqual([
        [`${chain}:spy`, 5000],
        [`${chain}:nvda`, 2500],
        [`${chain}:gold`, 2000],
      ]);
      // 950 traded at the mock's ten basis points of cost, and 50 untouched.
      expect(vault.valueUsd).toBe('999.05');
      // The weights are of everything the vault holds, cash included: they leave the cash share out.
      expect(vault.positions.reduce((n, p) => n + p.weightBps, 0)).toBeLessThan(9_600);
      expect(await walletCash(a, chain)).toBe(9_000_000_000n);

      // Buying the plan again adds to the vault the same way: 5% of the new deposit stays as cash.
      const again = await order(a, { proposalId: planId, amountUsd: 200 });
      expect(again.legs.find((l) => l.kind === 'deposit')?.cashRaw).toBe('200000000');
      expect(
        again.legs.flatMap((l) => l.trades).reduce((n, t) => n + BigInt(t.amountInRaw), 0n),
      ).toBe(190_000_000n);
      expect((await settleAll(a, again)).status).toBe('done');
      expect((await vaultOf(a)).cash.raw).toBe('60000000');
      expect(await walletCash(a, chain)).toBe(8_800_000_000n);
    }
  });

  it('all cash: opens the vault with the deposit, trades nothing, and holds it all as cash', async () => {
    for (const chain of CHAINS) {
      const planId = await data.storePlan(planFixture(chain, {}));
      const a = await someone(chain);
      await fund(a);
      const placed = await order(a, { proposalId: planId });
      expect(placed.legs.map((l) => [l.kind, l.cashRaw, l.trades, l.expected])).toEqual(
        chain === 'solana'
          ? [['create_vault', '1000000000', [], []]]
          : [
              ['approve', '1000000000', [], []],
              ['create_vault', '1000000000', [], []],
            ],
      );
      expect(placed.warnings).toEqual([]);
      expect((await settleAll(a, placed)).status).toBe('done');
      const vault = await vaultOf(a);
      expect([vault.cash.raw, vault.positions, vault.valueUsd]).toEqual(['1000000000', [], '1000']);
      expect(await walletCash(a, chain)).toBe(9_000_000_000n);

      // Again: a deposit and nothing else.
      const again = await order(a, { proposalId: planId, amountUsd: 500 });
      expect(again.depositRaw).toBe('500000000');
      expect(again.legs.map((l) => [l.kind, l.cashRaw])).toEqual(
        chain === 'solana'
          ? [['deposit', '500000000']]
          : [
              ['approve', '500000000'],
              ['deposit', '500000000'],
            ],
      );
      expect((await settleAll(a, again)).status).toBe('done');
      expect((await vaultOf(a)).cash.raw).toBe('1500000000');
    }
  });

  it('keeps a cash share of one basis point: a cent in a hundred dollars is not traded', async () => {
    const planId = await data.storePlan(planFixture('solana', { spy: 9998, nvda: 1 }));
    const a = await someone('solana');
    await fund(a);
    const placed = await order(a, { proposalId: planId, amountUsd: 100 });
    expect(placed.legs.flatMap((l) => l.trades).map((t) => t.amountInRaw)).toEqual([
      '99980000',
      '10000',
    ]);
    expect((await settleAll(a, placed)).status).toBe('done');
    expect((await vaultOf(a)).cash.raw).toBe('10000');
  });
});

describe('a plan that holds a shared portfolio as one line', () => {
  /** Half in a shared portfolio of spy and nvda, some gold and nvda of its own, 20% cash. */
  async function planWith(chain: HomeChain) {
    const asset = (slug: string, weightBps: number) => ({
      kind: 'asset' as const,
      asset: `${chain}:${slug}`,
      weightBps,
    });
    const family = await data.storeFamily(chain, [asset('spy', 6000), asset('nvda', 4000)]);
    const components = [
      { kind: 'index' as const, family: family.slug, weightBps: 5000 },
      asset('gold', 2000),
      asset('nvda', 1000),
    ];
    // The lines are what the person was shown: the shared portfolio already opened into its assets.
    const shown = { spy: 3000, nvda: 3000, gold: 2000 };
    const planId = await data.storePlan(planFixture(chain, shown, components));
    return { family, planId, asset };
  }

  it('opens it into its assets on the same chain, and buys those', async () => {
    for (const chain of CHAINS) {
      const { planId } = await planWith(chain);
      const a = await someone(chain);
      await fund(a);
      const placed = await order(a, { proposalId: planId });
      // An asset reached twice is one line. Largest first, ties by name.
      expect(placed.legs.flatMap((l) => l.trades).map((t) => [t.buy, t.amountInRaw])).toEqual([
        [`${chain}:nvda`, '300000000'],
        [`${chain}:spy`, '300000000'],
        [`${chain}:gold`, '200000000'],
      ]);
      expect((await settleAll(a, placed)).status).toBe('done');
      const vault = await vaultOf(a);
      // The vault holds assets only, with the weights the plan's lines showed, and 20% as cash.
      expect(vault.positions.map((p) => [p.asset, p.targetBps])).toEqual([
        [`${chain}:nvda`, 3000],
        [`${chain}:spy`, 3000],
        [`${chain}:gold`, 2000],
      ]);
      expect([vault.cash.raw, vault.recipeOnchainId, vault.autoFollow]).toEqual([
        '200000000',
        null,
        false,
      ]);
    }
  });

  it('refuses the buy when the shared portfolio has changed since the plan was made', async () => {
    const { planId, family, asset } = await planWith('solana');
    const a = await someone('solana');
    await fund(a);
    await family.publish([asset('spy', 5000), asset('tsla', 5000)]);
    const res = await post(a, '/v1/orders', {
      type: 'buy',
      owner: a.owner,
      amountUsd: 1000,
      proposalId: planId,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'a shared portfolio in this plan has changed since the plan was made',
      code: 'VERSION_CHANGED',
      fix: 'Make the plan again.',
    });
  });

  it('refuses to open the vault when it changed between the order and the build', async () => {
    const { planId, family, asset } = await planWith('solana');
    const a = await someone('solana');
    await fund(a);
    const placed = await order(a, { proposalId: planId });
    await family.publish([asset('spy', 5000), asset('tsla', 5000)]);
    const res = await post(a, legUrl(placed, first(placed).id, 'build'));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'VERSION_CHANGED', fix: 'Make the order again.' });
    expect((await read(a, placed)).attempts).toEqual([]);
    // Back as it was, the same order builds.
    await family.publish([asset('spy', 6000), asset('nvda', 4000)]);
    expect((await build(a, placed, first(placed).id)).attempt.n).toBe(1);
  });

  it('refuses a shared portfolio that is not on the person’s chain', async () => {
    // Made on Robinhood Chain only; the plan is on Solana.
    const elsewhere = await data.storeFamily('robinhood', [
      { kind: 'asset', asset: 'robinhood:spy', weightBps: 10_000 },
    ]);
    const components = [{ kind: 'index' as const, family: elsewhere.slug, weightBps: 10_000 }];
    const planId = await data.storePlan(planFixture('solana', { spy: 10_000 }, components));
    const a = await someone('solana');
    const res = await post(a, '/v1/orders', {
      type: 'buy',
      owner: a.owner,
      amountUsd: 1000,
      proposalId: planId,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/cannot be opened into its assets: no shared portfolio/);
  });
});
