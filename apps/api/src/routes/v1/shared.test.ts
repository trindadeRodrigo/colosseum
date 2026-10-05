import { randomUUID } from 'node:crypto';
import { familyIdOf, metaHash } from '@colosseum/basket';
import { mockRecipeId } from '@colosseum/chain-mock';
import { indexFamilies } from '@colosseum/db';
import {
  type BasketAsset,
  ChainError,
  FamilyResponse,
  OrderDetail,
  PortfolioResponse,
  ShelfResponse,
  VersionsResponse,
} from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import { basketIdOf } from '../../orders/prepare';
import { orderFlow } from '../../testing/flow';
import {
  type Person,
  type PersonKind,
  person,
  planFixture,
  type TestIssuer,
  testApp,
  testDb,
  testIssuer,
} from '../../testing/harness';

// The shared-portfolio routes (API-3) through HTTP on the mock chain and the real database: the shelf,
// a portfolio's page and its versions, a creator's publish, a buy that follows a portfolio, and a
// follow by a vault the person has. Solana only: publishing on Robinhood Chain waits for EVM-3. On
// this mock, gold has no price oracle, as on Solana's test network (TNET-5), so a portfolio that holds
// it offers no auto-follow (gate GOLD-ONE-TAP).

vi.setConfig({ testTimeout: 60_000 });

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
let plans: { solana: string; robinhood: string };
const undo: (() => Promise<unknown>)[] = [];

/** Gold has no oracle on Solana: the mock's list says so, as the deploy's record does on devnet. */
function goldWithoutOracle(inner: ChainRegistry): ChainRegistry {
  const wrap = (entry: ReturnType<ChainRegistry['get']>) => {
    if (entry.chain !== 'solana') return entry;
    const listAssets = async (): Promise<BasketAsset[]> =>
      (await entry.adapter.listAssets()).map((a) =>
        a.cls === 'gold' ? { ...a, autoFollowEligible: false } : a,
      );
    return { ...entry, adapter: { ...entry.adapter, listAssets } };
  };
  return {
    ...inner,
    get: (chain) => wrap(inner.get(chain)),
    active: () => inner.active().map(wrap),
  };
}

beforeAll(async () => {
  issuer = await testIssuer('test');
  data = await testDb();
  undo.push(() => data.cleanUp());
  plans = {
    solana: await data.storePlan(planFixture('solana')),
    robinhood: await data.storePlan(planFixture('robinhood')),
  };
  ({ app, registry } = await testApp({
    issuer: issuer.issuer,
    db: data.db,
    wrap: goldWithoutOracle,
  }));
  undo.push(() => app.close());
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const { post, get, fund, order, build, land, report, settleAll, read } = orderFlow({
  app: () => app,
  registry: () => registry,
  plans: () => plans,
});

const someone = async (kind: PersonKind = 'solana', from: TestIssuer = issuer) =>
  data.track(await person(from, kind));

const WITHOUT_GOLD = [
  { kind: 'asset', asset: 'solana:spy', weightBps: 4000 },
  { kind: 'asset', asset: 'solana:nvda', weightBps: 3000 },
  { kind: 'asset', asset: 'solana:tsla', weightBps: 3000 },
];
const WITH_GOLD = [
  { kind: 'asset', asset: 'solana:spy', weightBps: 4000 },
  { kind: 'asset', asset: 'solana:nvda', weightBps: 3000 },
  { kind: 'asset', asset: 'solana:gold', weightBps: 3000 },
];

/** A name and a slug nobody else has: a name folds to letters, so the run's id is spelled in them. */
function fresh() {
  const id = randomUUID().replaceAll('-', '');
  const letters = id.replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)] ?? 'a').slice(0, 12);
  const slug = `t-${id.slice(0, 16)}`;
  data.trackFamily(familyIdOf(slug));
  return { slug, name: `Test ${letters}`, copy: 'Three test tokens.' };
}

type Text = ReturnType<typeof fresh>;

const publishBody = (who: Person, text: Text, components: object[] = WITHOUT_GOLD, more = {}) => ({
  type: 'publish',
  creator: { solana: who.solana },
  family: text.slug,
  name: text.name,
  copy: text.copy,
  recipes: [{ chain: 'solana', components }],
  ...more,
});

async function publish(who: Person, text: Text, components: object[] = WITHOUT_GOLD) {
  const res = await post(who, '/v1/orders', publishBody(who, text, components));
  expect(res.statusCode, res.body).toBe(200);
  return OrderDetail.parse(res.json());
}

/** Publishes and settles: the shared portfolio is on the mock chain and in the store. */
async function published(who: Person, text: Text, components: object[] = WITHOUT_GOLD) {
  // A publish moves no cash, and its transaction pays the network fee.
  await fund(who);
  return settleAll(who, await publish(who, text, components));
}

const page = async (slug: string, query = '') => {
  const res = await get(null, `/v1/indexes/${slug}${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return FamilyResponse.parse(res.json()).family;
};

describe('a creator publishes a shared portfolio', () => {
  it('as an order of one publish step, with its own consent and no word of the creator in the summary', async () => {
    const creator = await someone();
    const text = fresh();
    const placed = await publish(creator, text);
    expect(placed.type).toBe('publish');
    expect(placed.needsConsent).toEqual(['publish']);
    expect(placed.legs.map((l) => [l.chain, l.kind, l.trades.length])).toEqual([
      ['solana', 'publish', 0],
    ]);
    expect(placed.legs[0]?.description).toMatch(/version 1, in effect at once/);
    expect(placed.summary).toBe('Publish your shared portfolio on Solana');
    expect(placed.summary).not.toContain(text.name);
    expect(placed.depositRaw).toBeUndefined();
    expect(placed.legs[0]?.provenance).toBe('mock');
  });

  it('is written to the shelf once its step confirms, as the chain has it', async () => {
    const creator = await someone();
    const text = fresh();
    const placed = await publish(creator, text);
    // Not before: a family is created only after its publish lands.
    expect((await get(null, `/v1/indexes/${text.slug}`)).statusCode).toBe(404);
    await fund(creator);
    const done = await settleAll(creator, placed);
    expect(done.status).toBe('done');

    const family = await page(text.slug);
    const familyId = familyIdOf(text.slug);
    expect(family).toMatchObject({
      familyId,
      slug: text.slug,
      name: text.name,
      copy: text.copy,
      kind: 'index',
      platform: false,
      creatorKind: 'community',
      chains: ['solana'],
    });
    const [recipe] = family.recipes;
    expect(recipe).toMatchObject({
      chain: 'solana',
      creator: creator.solana,
      source: 'chain',
      provenance: 'mock',
      pending: null,
      textMatches: 'active',
      autoFollow: { offered: true },
    });
    expect(recipe?.active.version).toBe(1);
    expect(recipe?.active.metaHash).toBe(
      metaHash({ familyId, slug: text.slug, name: text.name, copy: text.copy, kind: 'index' }),
    );
    expect(recipe?.active.components).toEqual(
      WITHOUT_GOLD.map(({ asset, weightBps }) => ({ asset, weightBps })),
    );
    // The onchain id is the registry's for this creator and family.
    const onchain = await registry.get('solana').adapter.getRecipe(recipe?.onchainId ?? '');
    expect(onchain.active.creator).toBe(creator.solana);

    const shelf = ShelfResponse.parse((await get(null, '/v1/shelf?chain=solana')).json());
    const card = shelf.families.find((f) => f.slug === text.slug);
    expect(card?.recipes[0]).toMatchObject({ source: 'cache', textMatches: 'active' });
    const elsewhere = ShelfResponse.parse((await get(null, '/v1/shelf?chain=robinhood')).json());
    expect(elsewhere.families.some((f) => f.slug === text.slug)).toBe(false);
  });

  it('publishes the next version on the same family, which waits the delay and then takes effect', async () => {
    const creator = await someone();
    const text = fresh();
    await published(creator, text);
    // One version per publish delay: the next may be published once it has passed.
    registry.get('solana').mock?.advance(301);
    const next = [
      { kind: 'asset', asset: 'solana:spy', weightBps: 3500 },
      { kind: 'asset', asset: 'solana:nvda', weightBps: 3000 },
      { kind: 'asset', asset: 'solana:tsla', weightBps: 3500 },
    ];
    const placed = await publish(creator, { ...text, name: `${text.name} two` }, next);
    expect(placed.legs[0]?.description).toMatch(/next version.*publish delay/);
    await settleAll(creator, placed);
    let family = await page(text.slug);
    expect(family.name).toBe(`${text.name} two`);
    expect(family.recipes[0]?.active.version).toBe(1);
    expect(family.recipes[0]?.pending?.version).toBe(2);
    // The text is the new version's, which has not taken effect yet.
    expect(family.recipes[0]?.textMatches).toBe('pending');

    // Another version while one waits is refused before anything is built.
    const third = await post(creator, '/v1/orders', publishBody(creator, text, WITHOUT_GOLD));
    expect([third.statusCode, third.json().code]).toEqual([422, 'CREATOR_LIMIT']);

    registry.get('solana').mock?.advance(301);
    family = await page(text.slug);
    expect(family.recipes[0]?.active.version).toBe(2);
    expect(family.recipes[0]?.pending).toBeNull();
    const versions = VersionsResponse.parse(
      (await get(null, `/v1/indexes/${text.slug}/versions`)).json(),
    );
    expect(versions.chains[0]?.versions.map((v) => [v.version, v.status])).toEqual([
      [2, 'active'],
      [1, 'superseded'],
    ]);
  });

  it('marks a version taken back before it took effect as cancelled', async () => {
    const creator = await someone();
    const text = fresh();
    await published(creator, text);
    registry.get('solana').mock?.advance(301);
    const next = [
      { kind: 'asset', asset: 'solana:spy', weightBps: 3000 },
      { kind: 'asset', asset: 'solana:nvda', weightBps: 3500 },
      { kind: 'asset', asset: 'solana:tsla', weightBps: 3500 },
    ];
    await settleAll(creator, await publish(creator, text, next));
    const onchainId = (await page(text.slug)).recipes[0]?.onchainId ?? '';
    registry.get('solana').mock?.cancelPending(onchainId);
    const versions = VersionsResponse.parse(
      (await get(null, `/v1/indexes/${text.slug}/versions`)).json(),
    );
    expect(versions.chains[0]?.versions.map((v) => [v.version, v.status])).toEqual([
      [2, 'cancelled'],
      [1, 'active'],
    ]);
  });

  it("refuses another creator's portfolio, whatever slug or id it is sent under", async () => {
    const creator = await someone();
    const text = fresh();
    await published(creator, text);
    const other = await someone();
    const res = await post(other, '/v1/orders', publishBody(other, text));
    expect([res.statusCode, res.json().error]).toEqual([
      409,
      "this shared portfolio is another creator's",
    ]);
    // Its family id under a slug of one's own is not the id of that slug.
    const mine = fresh();
    const named = await post(
      other,
      '/v1/orders',
      publishBody(other, mine, WITHOUT_GOLD, { familyId: familyIdOf(text.slug) }),
    );
    expect([named.statusCode, named.json().error]).toEqual([
      409,
      'the family id is not the one of this shared portfolio',
    ]);
    // A name that reads as the first one's: digits for letters, other spaces and case.
    const look = await post(
      other,
      '/v1/orders',
      publishBody(other, {
        ...mine,
        name: text.name.toUpperCase().replace(/O/g, '0').replace(' ', '  '),
      }),
    );
    expect([look.statusCode, look.json().error]).toEqual([
      409,
      'another shared portfolio has this name, or one that reads the same',
    ]);
  });

  it('answers the order while the chain does not, and writes the family on a later read', async () => {
    let down = false;
    const flaky: (r: ChainRegistry) => ChainRegistry = (inner) => {
      const wrap = (entry: ReturnType<ChainRegistry['get']>) => ({
        ...entry,
        adapter: {
          ...entry.adapter,
          getRecipe: async (id: string) => {
            if (down) throw new ChainError('Unavailable', 'the node did not answer');
            return entry.adapter.getRecipe(id);
          },
        },
      });
      return { ...inner, get: (c) => wrap(inner.get(c)), active: () => inner.active().map(wrap) };
    };
    const shaky = await testApp({ issuer: issuer.issuer, db: data.db, wrap: flaky });
    try {
      const creator = await someone();
      const text = fresh();
      await fund(creator, shaky.app);
      const placed = OrderDetail.parse(
        (await post(creator, '/v1/orders', publishBody(creator, text), shaky.app)).json(),
      );
      const leg = placed.legs[0];
      if (!leg) throw new Error('no step');
      await build(creator, placed, leg.id, shaky.app);
      down = true;
      const done = await report(
        creator,
        placed,
        leg.id,
        { txId: await land(creator, placed, leg.id, shaky.app) },
        shaky.app,
      );
      expect(done.status).toBe('done');
      expect((await get(null, `/v1/indexes/${text.slug}`, shaky.app)).statusCode).toBe(404);
      down = false;
      expect((await read(creator, placed, shaky.app)).status).toBe('done');
      const after = FamilyResponse.parse(
        (await get(null, `/v1/indexes/${text.slug}`, shaky.app)).json(),
      );
      expect(after.family.recipes[0]?.active.version).toBe(1);
    } finally {
      await shaky.app.close();
    }
  });

  it('keeps a new slug for the creator whose publish landed first, when two raced for it', async () => {
    const text = fresh();
    const first = await someone();
    const second = await someone();
    await fund(first);
    await fund(second);
    // Neither is stored yet, so both orders are made: each publishes under the slug's id with its key.
    const a = await publish(first, text);
    const b = await publish(second, { ...text, copy: 'Other words, for the same slug.' });
    await settleAll(first, a);
    expect((await settleAll(second, b)).status).toBe('done');
    const family = await page(text.slug);
    expect([family.copy, family.recipes.map((r) => r.creator)]).toEqual([
      text.copy,
      [first.solana],
    ]);
  });

  it('refuses a publish it cannot plan, and says why', async () => {
    const creator = await someone();
    const text = fresh();
    const stranger = await someone();
    const cases: [object, number, RegExp | string][] = [
      [{ creator: { solana: stranger.solana } }, 403, /not a wallet of the signed-in person/],
      [{ copy: 'See https://example.invalid for more' }, 422, /holds a link/],
      [{ name: 'Gold café' }, 422, /plain ASCII/],
      [{ name: ' Padded' }, 422, /no space at either end/],
      [{ copy: 'x'.repeat(281) }, 422, /281 characters, and the most is 280/],
      [{ family: 'Not-A-Slug' }, 422, /lower-case letters/],
      [{ familyId: 'ab'.repeat(32) }, 409, /family id is not the one/],
      [
        {
          recipes: [
            {
              chain: 'robinhood',
              components: WITHOUT_GOLD.map((c) => ({
                ...c,
                asset: c.asset.replace('solana', 'robinhood'),
              })),
            },
          ],
        },
        501,
        /Robinhood Chain is not built yet/,
      ],
      [
        {
          recipes: [
            { chain: 'solana', components: WITHOUT_GOLD },
            { chain: 'solana', components: WITHOUT_GOLD },
          ],
        },
        422,
        /one recipe per chain/,
      ],
      [
        {
          recipes: [
            {
              chain: 'solana',
              components: [
                { kind: 'asset', asset: 'solana:spy', weightBps: 5000 },
                { kind: 'asset', asset: 'solana:nvda', weightBps: 5000 },
              ],
            },
          ],
        },
        422,
        /at least 3 assets/,
      ],
      [
        {
          recipes: [
            {
              chain: 'solana',
              components: [
                { kind: 'asset', asset: 'solana:spy', weightBps: 4000 },
                { kind: 'asset', asset: 'solana:nvda', weightBps: 3000 },
                { kind: 'asset', asset: 'solana:usdc', weightBps: 3000 },
              ],
            },
          ],
        },
        422,
        // The cash token's ceiling is nothing: rule 9 breaks before the cash rule, and the lowest names it.
        /solana:usdc is at 30%; its ceiling is 0%/,
      ],
    ];
    for (const [change, status, error] of cases) {
      const res = await post(creator, '/v1/orders', { ...publishBody(creator, text), ...change });
      expect([JSON.stringify(change), res.statusCode]).toEqual([JSON.stringify(change), status]);
      expect(res.json().error).toMatch(error);
    }
    const limit = await post(creator, '/v1/orders', {
      ...publishBody(creator, text),
      recipes: [
        {
          chain: 'solana',
          components: [
            { kind: 'asset', asset: 'solana:spy', weightBps: 4000 },
            { kind: 'asset', asset: 'solana:nvda', weightBps: 3000 },
            { kind: 'asset', asset: 'solana:usdc', weightBps: 3000 },
          ],
        },
      ],
    });
    expect(limit.json().code).toBe('CREATOR_LIMIT');
    expect((await post(null, '/v1/orders', publishBody(creator, text))).statusCode).toBe(401);
  });

  it('writes nothing when the bytes that landed published other text than the order', async () => {
    // A server that builds the publish with the hash of other words: the guard refuses such bytes on
    // the creator's side (AGT-4). Here they are signed anyway, as an outside wallet with no guard
    // would, and the shelf does not take the order's words for what the chain holds.
    const swapped: (r: ChainRegistry) => ChainRegistry = (inner) => {
      const wrap = (entry: ReturnType<ChainRegistry['get']>) => ({
        ...entry,
        adapter: {
          ...entry.adapter,
          buildPublishRecipe: (a: Parameters<typeof entry.adapter.buildPublishRecipe>[0]) =>
            entry.adapter.buildPublishRecipe({
              ...a,
              recipe: { ...a.recipe, metaHash: 'ee'.repeat(32) },
            }),
        },
      });
      return { ...inner, get: (c) => wrap(inner.get(c)), active: () => inner.active().map(wrap) };
    };
    const lying = await testApp({ issuer: issuer.issuer, db: data.db, wrap: swapped });
    try {
      const creator = await someone();
      const text = fresh();
      const res = await post(creator, '/v1/orders', publishBody(creator, text), lying.app);
      const placed = OrderDetail.parse(res.json());
      await fund(creator, lying.app);
      const done = await settleAll(creator, placed, lying.app);
      expect(done.status).toBe('done');
      expect((await get(null, `/v1/indexes/${text.slug}`, lying.app)).statusCode).toBe(404);
      const [row] = await data.db
        .select()
        .from(indexFamilies)
        .where(eq(indexFamilies.familyId, familyIdOf(text.slug)));
      expect(row).toBeUndefined();
      // The chain holds the recipe, with the other hash.
      const onchain = await lying.registry
        .get('solana')
        .adapter.getRecipe(mockRecipeId('solana', creator.solana, familyIdOf(text.slug)));
      expect(onchain.active.metaHash).toBe('ee'.repeat(32));
    } finally {
      await lying.app.close();
    }
  });
});

describe('a person buys a shared portfolio, following it on their own chain', () => {
  it('opens a vault that follows the version in effect, with auto-follow off, and buys each asset', async () => {
    const creator = await someone();
    const text = fresh();
    await published(creator, text);
    const buyer = await someone();
    await fund(buyer);
    const res = await post(buyer, '/v1/orders', {
      type: 'buy',
      owner: buyer.owner,
      amountUsd: 100,
      family: text.slug,
    });
    expect(res.statusCode, res.body).toBe(200);
    const placed = OrderDetail.parse(res.json());
    expect(placed.summary).toBe('Buy $100.00 of a shared portfolio on Solana, following it');
    expect(placed.needsConsent).toEqual([]);
    expect(placed.legs.map((l) => [l.kind, l.trades.map((t) => t.buy)])).toEqual([
      ['create_vault', []],
      ['swap', ['solana:spy']],
      ['swap', ['solana:nvda']],
      ['swap', ['solana:tsla']],
    ]);
    const done = await settleAll(buyer, placed);
    expect(done.status).toBe('done');
    const portfolio = PortfolioResponse.parse((await get(buyer, '/v1/portfolio')).json());
    const vault = portfolio.chains[0]?.vaults.find(
      (v) => v.basketId === basketIdOf(familyIdOf(text.slug)),
    );
    const recipe = (await page(text.slug)).recipes[0];
    expect(vault).toMatchObject({
      recipeOnchainId: recipe?.onchainId,
      acceptedVersion: 1,
      autoFollow: false,
    });
    expect(vault?.positions.map((p) => [p.asset, p.targetBps])).toEqual(
      expect.arrayContaining([
        ['solana:spy', 4000],
        ['solana:nvda', 3000],
        ['solana:tsla', 3000],
      ]),
    );

    // The funding read plans the same buy of the portfolio: a deposit into the vault that is there.
    const funding = await get(buyer, `/v1/funding?amountUsd=10&family=${text.slug}`);
    expect(funding.statusCode, funding.body).toBe(200);
    expect([funding.json().cash.needRaw, funding.json().steps, funding.json().newVault]).toEqual([
      '10000000',
      4,
      false,
    ]);
    expect(
      (await get(buyer, `/v1/funding?amountUsd=10&family=${text.slug}&proposalId=${plans.solana}`))
        .statusCode,
    ).toBe(400);

    // A second buy adds to the same vault.
    const again = OrderDetail.parse(
      (
        await post(buyer, '/v1/orders', {
          type: 'buy',
          owner: buyer.owner,
          amountUsd: 10,
          family: text.slug,
        })
      ).json(),
    );
    expect(again.legs[0]?.kind).toBe('deposit');
  });

  it('refuses a stale version: when the order is made, and when its vault is built', async () => {
    const creator = await someone();
    const text = fresh();
    await published(creator, text);
    const buyer = await someone();
    await fund(buyer);
    const body = { type: 'buy', owner: buyer.owner, amountUsd: 100, family: text.slug };
    const named = await post(buyer, '/v1/orders', { ...body, version: 2 });
    expect([named.statusCode, named.json().code]).toEqual([409, 'VERSION_CHANGED']);

    const placed = OrderDetail.parse((await post(buyer, '/v1/orders', body)).json());
    // The creator moves the portfolio, and the new version takes effect before the vault is built.
    registry.get('solana').mock?.advance(301);
    await settleAll(
      creator,
      await publish(creator, text, [
        { kind: 'asset', asset: 'solana:spy', weightBps: 3000 },
        { kind: 'asset', asset: 'solana:nvda', weightBps: 4000 },
        { kind: 'asset', asset: 'solana:tsla', weightBps: 3000 },
      ]),
    );
    registry.get('solana').mock?.advance(301);
    const stale = await post(buyer, `/v1/orders/${placed.id}/legs/${placed.legs[0]?.id}/build`);
    expect([stale.statusCode, stale.json().code]).toEqual([409, 'VERSION_CHANGED']);
    expect(stale.json().error).toMatch(
      /version 2 of this shared portfolio is in effect, not version 1/,
    );
  });

  it('refuses a portfolio that is not on the chain the person is on (ONE-CHAIN)', async () => {
    const creator = await someone();
    const text = fresh();
    await published(creator, text);
    const evm = await someone('robinhood');
    const res = await post(evm, '/v1/orders', {
      type: 'buy',
      owner: evm.owner,
      amountUsd: 100,
      family: text.slug,
    });
    expect([res.statusCode, res.json().error]).toEqual([
      422,
      'this shared portfolio is not published on Robinhood Chain, where your plans live',
    ]);
    // The shelf of that chain does not offer it.
    const shelf = ShelfResponse.parse((await get(evm, '/v1/shelf?chain=robinhood')).json());
    expect(shelf.families.some((f) => f.slug === text.slug)).toBe(false);
    const both = await post(evm, '/v1/orders', {
      type: 'buy',
      owner: evm.owner,
      amountUsd: 100,
      family: text.slug,
      proposalId: plans.robinhood,
    });
    expect(both.statusCode).toBe(400);
    const missing = await post(evm, '/v1/orders', {
      type: 'buy',
      owner: evm.owner,
      amountUsd: 100,
      family: 'no-such-portfolio',
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('a vault follows a shared portfolio, and auto-follow where it is offered (GOLD-ONE-TAP)', () => {
  /** A person with a vault of their own plan, which follows nothing. */
  async function withVault() {
    const who = await someone();
    await fund(who);
    await settleAll(who, await order(who, { amountUsd: 100 }));
    const portfolio = PortfolioResponse.parse((await get(who, '/v1/portfolio')).json());
    const vault = portfolio.chains[0]?.vaults[0];
    if (!vault) throw new Error('no vault');
    return { who, vault: vault.address };
  }

  it('offers no auto-follow on a portfolio that holds an asset with no oracle, and refuses one asked for', async () => {
    const creator = await someone();
    const text = fresh();
    await published(creator, text, WITH_GOLD);
    const family = await page(text.slug);
    expect(family.recipes[0]?.autoFollow).toEqual({
      offered: false,
      reason: 'no_oracle',
      assets: ['solana:gold'],
    });
    const shelf = ShelfResponse.parse((await get(null, '/v1/shelf?chain=solana')).json());
    expect(shelf.families.find((f) => f.slug === text.slug)?.recipes[0]?.autoFollow.offered).toBe(
      false,
    );

    const { who, vault } = await withVault();
    const on = await post(who, '/v1/orders', {
      type: 'follow',
      vault,
      family: text.slug,
      autoFollow: true,
    });
    expect(on.statusCode).toBe(422);
    expect(on.json().error).toMatch(/holds solana:gold, which has no price oracle on Solana/);
    expect(on.json().fix).toMatch(/one tap/);

    // Following it by hand is open: the vault takes its weights, and the person is asked to rebalance.
    const off = await post(who, '/v1/orders', {
      type: 'follow',
      vault,
      family: text.slug,
      autoFollow: false,
    });
    expect(off.statusCode, off.body).toBe(200);
    const placed = OrderDetail.parse(off.json());
    expect(placed.type).toBe('follow');
    expect(placed.legs.map((l) => l.kind)).toEqual(['accept_version']);
    expect(placed.needsConsent).toEqual(['new_asset']);
    await settleAll(who, placed);
    const state = await registry.get('solana').adapter.getVault(vault);
    expect([state?.recipeOnchainId, state?.acceptedVersion, state?.autoFollow]).toEqual([
      family.recipes[0]?.onchainId,
      1,
      false,
    ]);
  });

  it('follows with auto-follow on where every asset has an oracle, with the consent it needs', async () => {
    const creator = await someone();
    const text = fresh();
    await published(creator, text);
    const { who, vault } = await withVault();
    const res = await post(who, '/v1/orders', {
      type: 'follow',
      vault,
      family: text.slug,
      autoFollow: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    const placed = OrderDetail.parse(res.json());
    expect(placed.legs.map((l) => l.kind)).toEqual(['accept_version', 'set_auto_follow']);
    expect(placed.needsConsent).toEqual(['new_asset', 'auto_follow_on']);
    await settleAll(who, placed);
    const state = await registry.get('solana').adapter.getVault(vault);
    expect(state?.autoFollow).toBe(true);
    // Asked again, there is nothing to change.
    const same = await post(who, '/v1/orders', {
      type: 'follow',
      vault,
      family: text.slug,
      autoFollow: true,
    });
    expect([same.statusCode, same.json().error]).toEqual([
      409,
      'the vault already follows this shared portfolio as asked',
    ]);
  });

  it('checks the offer again when the switch is built: a version that waits with gold stops it', async () => {
    const creator = await someone();
    const text = fresh();
    await published(creator, text);
    const { who, vault } = await withVault();
    const placed = OrderDetail.parse(
      (
        await post(who, '/v1/orders', {
          type: 'follow',
          vault,
          family: text.slug,
          autoFollow: true,
        })
      ).json(),
    );
    const [accept, autoFollow] = placed.legs;
    if (!accept || !autoFollow) throw new Error('two steps');
    await build(who, placed, accept.id);
    await report(who, placed, accept.id, { txId: await land(who, placed, accept.id) });
    // The creator publishes a version with gold, which waits: once it takes effect the keeper could
    // not rebalance this vault, so the switch is not built.
    registry.get('solana').mock?.advance(301);
    await settleAll(
      creator,
      await publish(creator, text, [
        { kind: 'asset', asset: 'solana:spy', weightBps: 4000 },
        { kind: 'asset', asset: 'solana:nvda', weightBps: 3000 },
        { kind: 'asset', asset: 'solana:tsla', weightBps: 1000 },
        { kind: 'asset', asset: 'solana:gold', weightBps: 2000 },
      ]),
    );
    const res = await post(who, `/v1/orders/${placed.id}/legs/${autoFollow.id}/build`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/holds solana:gold, which has no price oracle/);
  });

  it("refuses another person's vault, a vault on another chain, and a stale version", async () => {
    const creator = await someone();
    const text = fresh();
    await published(creator, text);
    const { vault } = await withVault();
    const stranger = await someone();
    const theirs = await post(stranger, '/v1/orders', {
      type: 'follow',
      vault,
      family: text.slug,
      autoFollow: false,
    });
    expect([theirs.statusCode, theirs.json().error]).toEqual([
      404,
      'no vault of yours at that address',
    ]);
    const evm = await someone('robinhood');
    const wrongChain = await post(evm, '/v1/orders', {
      type: 'follow',
      vault,
      family: text.slug,
      autoFollow: false,
    });
    expect([wrongChain.statusCode, wrongChain.json().error]).toEqual([
      422,
      'that vault is not on Robinhood Chain, where your plans live',
    ]);
    const { who, vault: own } = await withVault();
    const stale = await post(who, '/v1/orders', {
      type: 'follow',
      vault: own,
      family: text.slug,
      autoFollow: false,
      version: 7,
    });
    expect([stale.statusCode, stale.json().code]).toEqual([409, 'VERSION_CHANGED']);
    // The order holds to the version it was made with: once another takes effect, its step is refused.
    const placed = OrderDetail.parse(
      (
        await post(who, '/v1/orders', {
          type: 'follow',
          vault: own,
          family: text.slug,
          autoFollow: false,
        })
      ).json(),
    );
    registry.get('solana').mock?.advance(301);
    await settleAll(
      creator,
      await publish(creator, text, [
        { kind: 'asset', asset: 'solana:spy', weightBps: 3500 },
        { kind: 'asset', asset: 'solana:nvda', weightBps: 3500 },
        { kind: 'asset', asset: 'solana:tsla', weightBps: 3000 },
      ]),
    );
    registry.get('solana').mock?.advance(301);
    const built = await post(who, `/v1/orders/${placed.id}/legs/${placed.legs[0]?.id}/build`);
    expect([built.statusCode, built.json().code]).toEqual([409, 'VERSION_CHANGED']);
    expect((await read(who, placed)).legs[0]?.status).toBe('planned');
  });
});

describe('the reads need no sign-in, and each declares its rule', () => {
  it('answers the shelf, a page and its versions to anybody, and 404 for a slug nobody published', async () => {
    expect((await get(null, '/v1/shelf')).statusCode).toBe(200);
    expect((await get(null, '/v1/indexes/no-such-portfolio')).statusCode).toBe(404);
    expect((await get(null, '/v1/indexes/no-such-portfolio/versions')).statusCode).toBe(404);
    expect((await get(null, '/v1/indexes/Not_A_Slug')).statusCode).toBe(400);
    expect((await get(null, '/v1/shelf?chain=nowhere')).statusCode).toBe(400);
    const res = await get(null, '/v1/shelf');
    expect(res.headers['ratelimit-limit']).toBeDefined();
  });
});
