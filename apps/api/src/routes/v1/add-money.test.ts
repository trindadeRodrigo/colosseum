import {
  type BasketSheet,
  FundingResponse,
  OrderDetail,
  PersonPlansResponse,
  PortfolioResponse,
  VaultNameResponse,
  YieldObservation,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import type { PlanInputs } from '../../orders/personalize';
import { KEEPER_INVESTS, NO_SUCH_VAULT, tradesFor } from '../../orders/prepare';
import { bearingPlanInputs } from '../../plan-inputs';
import mockYields from '../../testing/fixtures/mock-yields.json';
import { orderFlow } from '../../testing/flow';
import { person, type TestIssuer, testApp, testDb, testIssuer } from '../../testing/harness';
import { PersonalizeResponse } from './baskets';

// Several vaults for one person, and more money into one of them (add money): a buy that names a vault
// of the person's deposits into THAT vault and buys to the targets it has on chain now. A vault that
// is not the caller's is answered like one that does not exist. Each vault has the plan it was opened
// from and the name its owner gave it. On the mock chains, over HTTP, as the web does it.

vi.setConfig({ testTimeout: 90_000 });

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
const undo: (() => Promise<unknown>)[] = [];
const withMockYield: PlanInputs = async (q) => ({
  ...(await bearingPlanInputs(q)),
  yields: YieldObservation.array()
    .parse(mockYields)
    .filter((y) => q.assets.some((a) => a.id === y.assetId)),
});

/** While set: every vault reads as one with auto-follow on, as the keeper's chains will have them. */
let autoFollow = false;
const withAutoFollow = (inner: ChainRegistry): ChainRegistry => {
  const dress = <T extends ReturnType<ChainRegistry['get']>>(e: T): T => ({
    ...e,
    adapter: new Proxy(e.adapter, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === 'getVaults')
          return async (owner: string) => {
            const vaults = await target.getVaults(owner);
            return autoFollow ? vaults.map((v) => ({ ...v, autoFollow: true })) : vaults;
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  });
  return { ...inner, get: (c) => dress(inner.get(c)), active: () => inner.active().map(dress) };
};

beforeAll(async () => {
  issuer = await testIssuer('add-money');
  data = await testDb();
  undo.push(() => data.cleanUp());
  ({ app, registry } = await testApp({
    issuer: issuer.issuer,
    db: data.db,
    planInputs: withMockYield,
    wrap: withAutoFollow,
  }));
  undo.push(() => app.close());
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const { post, get, put, fund, order, settleAll } = orderFlow({
  app: () => app,
  registry: () => registry,
  plans: () => ({ solana: '', robinhood: '' }),
});

type Chain = 'solana' | 'robinhood';
const sheet = (chain: Chain, over: Partial<BasketSheet> = {}): BasketSheet => ({
  basketType: 'standard',
  goal: 'grow',
  amountUsd: 5_000,
  horizonMonths: 60,
  risk: 'high',
  themes: [],
  country: 'BR',
  chains: [chain],
  rules: { useHoldings: false, glide: true },
  language: 'en',
  ...over,
});
const someone = async (chain: Chain = 'solana') => data.track(await person(issuer, chain));
type Person = Awaited<ReturnType<typeof someone>>;
const make = async (who: Person, chain: Chain, over: Partial<BasketSheet> = {}) => {
  const res = await post(who, '/v1/baskets/personalize', { sheet: sheet(chain, over) });
  expect(res.statusCode, res.body).toBe(200);
  return PersonalizeResponse.parse(res.json());
};
const vaultsOf = async (who: Person, chain: Chain) => {
  const res = await get(who, '/v1/portfolio');
  expect(res.statusCode, res.body).toBe(200);
  return PortfolioResponse.parse(res.json()).chains.find((c) => c.chain === chain)?.vaults ?? [];
};
/** A person with a vault from each of two plans on their chain, both bought and settled. */
async function withTwoVaults(chain: Chain = 'solana') {
  const who = await someone(chain);
  await fund(who, undefined, 50_000);
  const grow = await make(who, chain);
  const protect = await make(who, chain, { goal: 'protect', risk: 'low', horizonMonths: 18 });
  await settleAll(who, await order(who, { amountUsd: 1_000, proposalId: grow.id }));
  await settleAll(who, await order(who, { amountUsd: 2_000, proposalId: protect.id }));
  const vaults = await vaultsOf(who, chain);
  const of = (planId: string) => {
    const v = vaults.find((x) => x.planId === planId);
    if (!v) throw new Error('the plan has no vault in the portfolio');
    return v;
  };
  return { who, grow, protect, vaults, growVault: of(grow.id), protectVault: of(protect.id) };
}
/** Dollars in the raw units of the chain's cash token. */
async function raw(chain: Chain, usd: number): Promise<bigint> {
  const cash = (await registry.get(chain).adapter.listAssets()).find((a) => a.cls === 'cash');
  if (!cash) throw new Error('the chain lists no cash token');
  return BigInt(usd) * 10n ** BigInt(cash.decimals);
}
const addTo = (
  who: Person,
  vault: { chain: string; address: string },
  amountUsd: number,
  more: object = {},
) =>
  post(who, '/v1/orders', {
    type: 'buy',
    owner: who.owner,
    amountUsd,
    vault: { chain: vault.chain, address: vault.address },
    ...more,
  });

describe.each(['solana', 'robinhood'] as const)('several vaults on %s', (chain) => {
  it('one person holds a vault per plan, each with its plan and no name until given one', async () => {
    const { vaults, grow, protect, growVault, protectVault } = await withTwoVaults(chain);
    expect(vaults).toHaveLength(2);
    expect(new Set(vaults.map((v) => v.address)).size).toBe(2);
    expect(new Set(vaults.map((v) => v.basketId)).size).toBe(2);
    expect([growVault.planId, protectVault.planId]).toEqual([grow.id, protect.id]);
    expect(vaults.map((v) => v.name)).toEqual([null, null]);
    expect(Number(growVault.valueUsd)).toBeGreaterThan(900);
    expect(Number(protectVault.valueUsd)).toBeGreaterThan(1_900);
  });

  it('adding money deposits into the vault named, buys to its targets, and leaves the other alone', async () => {
    const { who, grow, protect, growVault, protectVault } = await withTwoVaults(chain);
    const res = await addTo(who, growVault, 500);
    expect(res.statusCode, res.body).toBe(200);
    const placed = OrderDetail.parse(res.json());
    // the vault's own number, a deposit of the whole amount, and no vault opened
    expect(placed.basketId).toBe(growVault.basketId);
    expect(placed.legs.map((l) => l.kind)).not.toContain('create_vault');
    const deposit = placed.legs.find((l) => l.kind === 'deposit');
    expect(deposit?.cashRaw).toBe(placed.depositRaw);
    const added = await raw(chain, 500);
    expect(BigInt(placed.depositRaw ?? '0')).toBe(added);
    // the trades are the vault's targets on chain, applied to this deposit
    const targets = growVault.positions
      .filter((p) => p.targetBps > 0)
      .map((p) => ({ asset: p.asset, weightBps: p.targetBps }));
    expect(placed.legs.flatMap((l) => l.trades)).toEqual(
      tradesFor(targets, added, growVault.cash.asset),
    );

    const done = await settleAll(who, placed);
    expect(done.status).toBe('done');
    const after = await vaultsOf(who, chain);
    const grown = after.find((v) => v.address === growVault.address);
    const other = after.find((v) => v.address === protectVault.address);
    expect(Number(grown?.valueUsd)).toBeGreaterThan(Number(growVault.valueUsd) + 450);
    expect(other?.valueUsd).toBe(protectVault.valueUsd);
    expect(after).toHaveLength(2);

    // the add is counted under the vault's plan: its buys, and what was put in
    const plans = PersonPlansResponse.parse((await get(who, '/v1/me/plans')).json()).plans;
    const plan = plans.find((p) => p.id === grow.id);
    expect(plan?.orders.map((o) => [o.amountUsd, o.deposited]).sort()).toEqual(
      [
        [1_000, true],
        [500, true],
      ].sort(),
    );
    // newest first, and under no other plan: the other vault's plan lists its one buy
    expect(plan?.orders.map((o) => o.amountUsd)).toEqual([500, 1_000]);
    expect(plans.find((p) => p.id === protect.id)?.orders.map((o) => o.amountUsd)).toEqual([2_000]);
  });

  it('says what the wallet is missing for an add, with no new vault to pay for', async () => {
    const { who, growVault } = await withTwoVaults(chain);
    const res = await get(
      who,
      `/v1/funding?amountUsd=300&vault=${growVault.address}&vaultChain=${chain}&wallet=${growVault.owner}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    const read = FundingResponse.parse(res.json());
    expect(read.chain).toBe(chain);
    expect(read.wallet).toBe(growVault.owner);
    expect(read.newVault).toBe(false);
    expect(BigInt(read.cash.needRaw)).toBe(await raw(chain, 300));
  });
});

describe('a person with more plans than one page of the list holds', () => {
  it('still has each vault joined to its plan, and the add counted under it on the page it is on', async () => {
    const { who, grow, growVault } = await withTwoVaults('solana');
    // 51 plans made after the two that were bought: those two are past the first page of fifty
    for (let batch = 0; batch < 3; batch += 1)
      await Promise.all(
        Array.from({ length: 17 }, (_, i) =>
          make(who, 'solana', { amountUsd: 6_000 + batch * 100 + i }),
        ),
      );
    const first = PersonPlansResponse.parse((await get(who, '/v1/me/plans')).json());
    expect(first.plans).toHaveLength(50);
    expect(first.plans.map((p) => p.id)).not.toContain(grow.id);
    expect(first.next).not.toBeNull();

    // the portfolio reads every page: both vaults keep their plan
    const vaults = await vaultsOf(who, 'solana');
    expect(vaults.map((v) => v.planId).every((id) => id !== null && id !== undefined)).toBe(true);
    expect(vaults.find((v) => v.address === growVault.address)?.planId).toBe(grow.id);

    // and an add is listed under its vault's plan, on the page that plan is on
    const added = await addTo(who, growVault, 200);
    expect(added.statusCode, added.body).toBe(200);
    const second = PersonPlansResponse.parse(
      (await get(who, `/v1/me/plans?before=${encodeURIComponent(first.next as string)}`)).json(),
    );
    expect(second.plans.find((p) => p.id === grow.id)?.orders.map((o) => o.amountUsd)).toEqual([
      200, 1_000,
    ]);
    // no plan of the first page took the add for its own
    const again = PersonPlansResponse.parse((await get(who, '/v1/me/plans')).json());
    expect(again.plans.flatMap((p) => p.orders)).toEqual([]);
  });
});

describe('a vault that is not the caller’s to add to', () => {
  it.each(['solana', 'robinhood'] as const)(
    'on %s: another person’s vault is answered like one that does not exist, and nothing is made',
    async (chain) => {
      const { growVault } = await withTwoVaults(chain);
      const thief = await someone(chain);
      await fund(thief, undefined, 5_000);
      const theirs = await addTo(thief, growVault, 100);
      expect(theirs.statusCode).toBe(404);
      expect(theirs.json().error).toBe(NO_SUCH_VAULT);
      // the same answer as for an address nobody has a vault at
      const wallet = thief.owner[chain === 'solana' ? 'solana' : 'evm'] as string;
      const nobody = await addTo(thief, { chain, address: wallet }, 100);
      expect(nobody.statusCode).toBe(404);
      expect(nobody.json().error).toBe(theirs.json().error);
      // naming the victim as the owner is refused before anything is read: the owner is the caller's
      const claimed = await post(thief, '/v1/orders', {
        type: 'buy',
        owner: { [chain === 'solana' ? 'solana' : 'evm']: growVault.owner },
        amountUsd: 100,
        vault: { chain, address: growVault.address },
      });
      expect(claimed.statusCode).toBe(403);
      const orders = await get(thief, '/v1/orders');
      if (orders.statusCode === 200) expect(orders.json().orders ?? []).toEqual([]);
    },
  );

  it.each(['solana', 'robinhood'] as const)(
    'on %s: an add to a vault with auto-follow on only deposits, and its review says the keeper invests it',
    async (chain) => {
      const { who, growVault } = await withTwoVaults(chain);
      autoFollow = true;
      try {
        const res = await addTo(who, growVault, 300);
        expect(res.statusCode, res.body).toBe(200);
        const placed = OrderDetail.parse(res.json());
        expect(placed.legs.map((l) => l.kind).filter((k) => k !== 'approve')).toEqual(['deposit']);
        expect(placed.legs.flatMap((l) => l.trades)).toEqual([]);
        expect(placed.depositRaw).toBe(String(await raw(chain, 300)));
        expect(placed.warnings).toContainEqual(KEEPER_INVESTS);
        const done = await settleAll(who, placed);
        expect(done.status).toBe('done');
        // the funding read plans the same order: the deposit, and no trade's fee
        const funding = FundingResponse.parse(
          (
            await get(
              who,
              `/v1/funding?amountUsd=300&vault=${growVault.address}&vaultChain=${chain}&wallet=${growVault.owner}`,
            )
          ).json(),
        );
        expect(funding.steps).toBe(placed.legs.length);
      } finally {
        autoFollow = false;
      }
      // every dollar of it is in the vault as cash, and nothing was bought
      const after = (await vaultsOf(who, chain)).find((v) => v.address === growVault.address);
      expect(BigInt(after?.cash.raw ?? '0') - BigInt(growVault.cash.raw)).toBe(
        await raw(chain, 300),
      );
      expect(after?.positions.map((p) => p.raw)).toEqual(growVault.positions.map((p) => p.raw));
    },
  );

  it('a vault named on another chain than its own is not found', async () => {
    const { who, growVault } = await withTwoVaults('solana');
    const res = await addTo(who, { chain: 'robinhood', address: growVault.address }, 100);
    expect([400, 404]).toContain(res.statusCode);
    if (res.statusCode === 404) expect(res.json().error).toBe(NO_SUCH_VAULT);
  });

  it('a buy names one thing: a vault with a plan, or with a version, is refused', async () => {
    const { who, grow, growVault } = await withTwoVaults('solana');
    expect((await addTo(who, growVault, 100, { proposalId: grow.id })).statusCode).toBe(400);
    expect((await addTo(who, growVault, 100, { family: 'some-portfolio' })).statusCode).toBe(400);
    expect((await addTo(who, growVault, 100, { version: 1 })).statusCode).toBe(400);
  });

  it('holds an order to the amount it was made with: its deposit is the order’s, to the unit', async () => {
    const { who, growVault } = await withTwoVaults('solana');
    const placed = OrderDetail.parse((await addTo(who, growVault, 250)).json());
    const again = OrderDetail.parse((await get(who, `/v1/orders/${placed.id}`)).json());
    // the order is read back as it was made: a caller cannot change its amount afterwards
    const amount = String(await raw('solana', 250));
    expect(again.depositRaw).toBe(amount);
    expect(again.legs.find((l) => l.kind === 'deposit')?.cashRaw).toBe(amount);
    expect(again.basketId).toBe(growVault.basketId);
  });
});

describe('a vault’s name', () => {
  const nameUrl = (v: { chain: string; address: string }) =>
    `/v1/vaults/${v.chain}/${v.address}/name`;

  it('is given by its owner, trimmed, shown in the portfolio, and cleared with null', async () => {
    const { who, growVault, protectVault } = await withTwoVaults('solana');
    const res = await put(who, nameUrl(growVault), { name: '  House fund  ' });
    expect(res.statusCode, res.body).toBe(200);
    expect(VaultNameResponse.parse(res.json())).toEqual({
      chain: 'solana',
      address: growVault.address,
      name: 'House fund',
    });
    const named = await vaultsOf(who, 'solana');
    expect(named.find((v) => v.address === growVault.address)?.name).toBe('House fund');
    expect(named.find((v) => v.address === protectVault.address)?.name).toBeNull();
    // The name is its owner's alone (gate VAULT-NAME): the vault's public page reads none, for
    // anybody, and neither does another person's portfolio.
    const open = await get(null, `/v1/vaults/solana/${growVault.address}`);
    expect(open.statusCode, open.body).toBe(200);
    expect(open.body).not.toContain('House fund');
    const visitor = await someone();
    const seen = await get(visitor, `/v1/vaults/solana/${growVault.address}`);
    expect(seen.body).not.toContain('House fund');
    expect((await get(visitor, '/v1/portfolio')).body).not.toContain('House fund');
    // a read of the chain does not lose the name
    expect((await vaultsOf(who, 'solana')).find((v) => v.address === growVault.address)?.name).toBe(
      'House fund',
    );
    expect((await put(who, nameUrl(growVault), { name: null })).statusCode).toBe(200);
    expect(
      (await vaultsOf(who, 'solana')).find((v) => v.address === growVault.address)?.name,
    ).toBeNull();
  });

  it('is text and nothing else: markup is kept as written, never read as markup', async () => {
    const { who, growVault } = await withTwoVaults('solana');
    const markup = '<img src=x onerror=alert(1)>';
    expect((await put(who, nameUrl(growVault), { name: markup })).statusCode).toBe(200);
    expect((await vaultsOf(who, 'solana')).find((v) => v.address === growVault.address)?.name).toBe(
      markup,
    );
  });

  it('refuses a name that is empty, too long or has a control character', async () => {
    const { who, growVault } = await withTwoVaults('solana');
    for (const name of ['', '   ', 'x'.repeat(61), 'two\nlines', 'tab\there', 'rtl‮evil', 7])
      expect((await put(who, nameUrl(growVault), { name })).statusCode, String(name)).toBe(400);
    expect((await put(who, nameUrl(growVault), { name: 'x'.repeat(60) })).statusCode).toBe(200);
    expect((await put(who, nameUrl(growVault), {})).statusCode).toBe(400);
  });

  it('is its owner’s alone: anybody else, signed in or not, changes nothing', async () => {
    const { who, growVault } = await withTwoVaults('solana');
    const other = await someone('solana');
    const res = await put(other, nameUrl(growVault), { name: 'mine now' });
    expect(res.statusCode).toBe(404);
    const unknown = await put(other, nameUrl({ chain: 'solana', address: other.solana }), {
      name: 'x',
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe(res.json().error);
    expect((await put(null, nameUrl(growVault), { name: 'x' })).statusCode).toBe(401);
    expect(
      (await vaultsOf(who, 'solana')).find((v) => v.address === growVault.address)?.name,
    ).toBeNull();
  });
});
