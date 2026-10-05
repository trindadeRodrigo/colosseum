import { randomUUID } from 'node:crypto';
import { recipeAddress } from '@colosseum/chain-solana/vault';
import {
  type BuildLegResponse,
  type ConsentKind,
  type FamilyResponse,
  type OrderDetail,
  type PortfolioResponse,
  parseChainConfigs,
  parseFlags,
} from '@colosseum/schemas';
import {
  approvedSteps,
  basketIdOfPlan,
  type DeploymentFile,
  deploymentsOf,
  familyIdOf,
  type GuardDeployment,
  GuardRefusal,
  guardTransaction,
  type PlanTerms,
} from '@colosseum/sdk';
import {
  type Address,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  lamports,
  partiallySignTransaction,
} from '@solana/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../apps/api/src/app';
import { createChainRegistry } from '../../apps/api/src/orders/chains';
import { type Person, ROOMY, signIn, testDb, testIssuer } from '../../apps/api/src/testing/harness';
import { withFile } from '../../packages/sdk/test/deployments';
import { mintTo, priceAccountBytes, transferSol } from './admin';
import {
  buildContractWorld,
  type ContractWorld,
  id,
  type Key,
  newKey,
  priceEntries,
} from './contract-world';
import {
  BASKET_PROGRAM,
  createSvmNode,
  MOCK_ROUTER_PROGRAM,
  PROGRAMS_BUILT,
  type SvmNode,
} from './svm-node';

// The shared-portfolio orders of the API (API-3) on the Solana adapter, in LiteSVM with the built
// programs: a creator's publish and a person's buy that follows it, each step built by the API's own
// routes, held by the guard (packages/sdk) to what the creator's form or the follower's screen showed,
// signed here with a key made for the run, relayed by the API and settled from the chain. The family
// id and the text the guard is given are the screen's, never the API's answer: bytes the API built
// for other words are refused. It needs the built programs and the database the API tests use.

vi.mock(
  '../../packages/sdk/src/guard/generated/deployment-files',
  () => import('../../packages/sdk/test/deployments'),
);

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

describe.skipIf(!PROGRAMS_BUILT)('shared portfolios through the API on Solana, in LiteSVM', () => {
  vi.setConfig({ testTimeout: 120_000 });
  let node: SvmNode;
  let w: ContractWorld;
  let deployment: GuardDeployment;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let store: Awaited<ReturnType<typeof testDb>>;
  let issuer: Awaited<ReturnType<typeof testIssuer>>;
  const undo: (() => Promise<unknown>)[] = [];

  beforeAll(async () => {
    const deployer = await newKey();
    const start = BigInt(Math.floor(Date.now() / 1000));
    node = await createSvmNode(deployer.address, start);
    node.svm.airdrop(deployer.address, lamports(1_000_000_000_000n));
    const priceAccount = (await newKey()).address;
    const writePrices = (at: bigint, header = true) => {
      const data = priceAccountBytes(priceEntries(0), at, node.svm.getClock().slot, header);
      node.svm.setAccount({
        address: priceAccount,
        data,
        executable: false,
        lamports: lamports(node.svm.minimumBalanceForRentExemption(BigInt(data.length))),
        programAddress: MOCK_ROUTER_PROGRAM,
        space: BigInt(data.length),
      });
    };
    writePrices(start, false);
    w = await buildContractWorld(
      {
        rpc: node.rpc,
        land: async (tx) => {
          const landed = node.land(tx);
          return { signature: landed.signature, failed: landed.err !== null, logs: landed.logs };
        },
        advance: async (seconds) => {
          node.advance(seconds);
        },
        now: async () => node.now(),
        refreshPrices: writePrices,
      },
      {
        deployer,
        priceAccount,
        pendingVersion: false,
        network: 'local',
        notBefore: new Date().toISOString(),
      },
    );
    const file: DeploymentFile = {
      format: 'guard-deployment/1',
      network: 'local',
      chains: {
        solana: {
          family: 'solana',
          program: BASKET_PROGRAM,
          router: MOCK_ROUTER_PROGRAM,
          cash: id('cash'),
          assets: Object.fromEntries(
            Object.entries(w.mints).map(([name, m]) => [
              id(name),
              { mint: m.address, tokenProgram: m.tokenProgram === TOKEN ? 'token' : 'token-2022' },
            ]),
          ),
        },
      },
    };
    const loaded = withFile(file, () => deploymentsOf('local')).solana;
    if (!loaded) throw new Error('the world has no deployment');
    deployment = loaded;

    const env = {
      CHAIN_MODE_SOLANA: 'live',
      CHAIN_NETWORK_SOLANA: 'local',
      CHAIN_ROUTER_SOLANA: MOCK_ROUTER_PROGRAM,
      CHAIN_PRICE_SOURCE_SOLANA: w.priceAccount,
      CHAIN_MODE_ROBINHOOD: 'off',
      CHAIN_MODE_BASE: 'off',
      AUTO_FOLLOW_SOLANA: 'true',
    };
    const contracts = { solana: { program: BASKET_PROGRAM } };
    const chains = createChainRegistry(parseFlags(env), parseChainConfigs(env, contracts), {
      seed: `shared:${randomUUID()}`,
      solana: { rpc: node.rpc, assets: w.assets },
    });
    issuer = await testIssuer('solana-shared');
    store = await testDb();
    undo.push(() => store.cleanUp());
    app = await buildApp({
      env,
      v1: { auth: issuer.issuer, chains, contracts, db: store.db, limits: ROOMY },
    });
    undo.push(() => app.close());
  }, 180_000);
  afterAll(async () => {
    for (const step of undo.reverse()) await step();
  });

  /** A person with an outside Solana wallet: a key made for the run, with SOL and test dollars. */
  async function someone(): Promise<{ key: Key; person: Person }> {
    const key = await newKey();
    const { deployer } = w.keys;
    const cash = w.mints.cash;
    if (!cash) throw new Error('the world has no cash mint');
    await w.run(deployer, [
      transferSol(deployer.address, key.address, 2_000_000_000n),
      ...(await mintTo({
        mint: cash.address,
        tokenProgram: cash.tokenProgram,
        holder: key.address,
        authority: deployer.address,
        amount: 500_000_000n,
      })),
    ]);
    const sub = `did:privy:shared-${randomUUID()}`;
    const headers = await signIn(issuer, sub, [
      { family: 'solana', address: key.address, client: 'phantom' },
    ]);
    const person: Person = {
      sub,
      kind: 'solana',
      chain: 'solana',
      solana: key.address,
      // An EVM address nobody else has: the person has none, and the clean-up keys on it.
      evm: `0x${randomUUID().replaceAll('-', '')}${'0'.repeat(8)}`,
      owner: { solana: key.address },
      headers,
    };
    store.track(person);
    return { key, person };
  }

  async function call<T>(
    who: Person | null,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
  ) {
    const res = await app.inject({
      method,
      url,
      headers: who?.headers ?? {},
      ...(payload ? { payload: payload as object } : {}),
    });
    if (res.statusCode >= 300) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
    return res.json() as T;
  }

  /** The guard on one built step, held to what the screen showed: null when it passes, else its code. */
  function guarded(
    order: OrderDetail,
    legId: string,
    built: BuildLegResponse,
    plan: PlanTerms,
    consents: ConsentKind[],
  ): string | null {
    try {
      const step = approvedSteps(order, plan, deployment).find((s) => s.legId === legId);
      if (!step) throw new Error('no such step');
      guardTransaction({ step, tx: built.tx, deployment, consents });
      return null;
    } catch (e) {
      if (e instanceof GuardRefusal) return e.code;
      throw e;
    }
  }

  /** Every step in order: built by the API, held by the guard, signed with the key, relayed, settled. */
  async function walk(
    who: { key: Key; person: Person },
    placed: OrderDetail,
    plan: PlanTerms,
    consents: ConsentKind[],
    /** Steps the test built already: built once, as a step is not built again while it can land. */
    prebuilt: Record<string, BuildLegResponse> = {},
  ): Promise<OrderDetail> {
    let order = placed;
    for (const leg of placed.legs) {
      const built =
        prebuilt[leg.id] ??
        (await call<BuildLegResponse>(
          who.person,
          'POST',
          `/v1/orders/${order.id}/legs/${leg.id}/build`,
        ));
      expect([leg.kind, guarded(placed, leg.id, built, plan, consents)]).toEqual([leg.kind, null]);
      const signed = await partiallySignTransaction(
        [who.key.pair],
        getTransactionDecoder().decode(new Uint8Array(Buffer.from(built.tx.payload, 'base64'))),
      );
      await call(who.person, 'POST', `/v1/orders/${order.id}/legs/${leg.id}/report`, {
        signedTx: getBase64EncodedWireTransaction(signed),
      });
      order = await call<OrderDetail>(who.person, 'GET', `/v1/orders/${order.id}`);
      const settled = order.legs.find((l) => l.id === leg.id);
      expect([leg.kind, settled?.status, settled?.error]).toEqual([leg.kind, 'confirmed', null]);
    }
    return order;
  }

  const COMPONENTS = [
    { kind: 'asset', asset: id('alpha'), weightBps: 4_000 },
    { kind: 'asset', asset: id('beta'), weightBps: 3_000 },
    { kind: 'asset', asset: id('gamma'), weightBps: 3_000 },
  ];

  it('publishes a portfolio the guard holds to the form, and a person buys it, following it', async () => {
    const creator = await someone();
    const slug = `t-${randomUUID().slice(0, 8)}`;
    // What the creator's form shows: the id it works out from the slug, the words typed, the weights.
    const familyId = familyIdOf(slug);
    store.trackFamily(familyId);
    const text = {
      slug,
      name: `Shared ${slug.replace(/[0-9-]/g, 'x')}`,
      copy: 'Three test tokens.',
      kind: 'index' as const,
    };
    const screen: PlanTerms = {
      basketId: '0',
      publish: {
        action: 'publish',
        familyId,
        components: COMPONENTS.map(({ asset, weightBps }) => ({ asset, weightBps })),
        text,
        version: 1,
      },
    };
    const body = {
      type: 'publish',
      creator: { solana: creator.key.address },
      family: slug,
      name: text.name,
      copy: text.copy,
      familyId,
      recipes: [{ chain: 'solana', components: COMPONENTS }],
    };

    // An order made with other words than the form shows: its bytes carry their hash, and the guard,
    // which hashes the form's text itself, refuses them.
    const other = await call<OrderDetail>(creator.person, 'POST', '/v1/orders', {
      ...body,
      copy: 'Words the form did not show.',
    });
    const otherLeg = other.legs[0];
    if (!otherLeg) throw new Error('no step');
    const otherBuilt = await call<BuildLegResponse>(
      creator.person,
      'POST',
      `/v1/orders/${other.id}/legs/${otherLeg.id}/build`,
    );
    expect(guarded(other, otherLeg.id, otherBuilt, screen, ['publish'])).toBe('recipe');

    const placed = await call<OrderDetail>(creator.person, 'POST', '/v1/orders', body);
    expect([placed.type, placed.needsConsent, placed.legs.map((l) => l.kind)]).toEqual([
      'publish',
      ['publish'],
      ['publish'],
    ]);
    const leg = placed.legs[0];
    if (!leg) throw new Error('no step');
    const built = await call<BuildLegResponse>(
      creator.person,
      'POST',
      `/v1/orders/${placed.id}/legs/${leg.id}/build`,
    );
    // The same bytes, held to anything but what the form showed, or with no consent: refused.
    const held = (plan: PlanTerms, consents: ConsentKind[] = ['publish']) =>
      guarded(placed, leg.id, built, plan, consents);
    const terms = screen.publish;
    if (!terms) throw new Error('no terms');
    expect(held({ ...screen, publish: { ...terms, familyId: familyIdOf(`${slug}x`) } })).toBe(
      'recipe',
    );
    expect(
      held({ ...screen, publish: { ...terms, text: { ...text, name: `${text.name}!` } } }),
    ).toBe('recipe');
    expect(held(screen, [])).toBe('consent');

    const done = await walk(creator, placed, screen, ['publish'], { [leg.id]: built });
    expect(done.status).toBe('done');

    // On the shelf now, as the chain has it.
    const { family } = await call<FamilyResponse>(null, 'GET', `/v1/indexes/${slug}`);
    const recipe = family.recipes[0];
    const onchainId = await recipeAddress(
      BASKET_PROGRAM,
      creator.key.address as Address,
      Buffer.from(familyId, 'hex'),
    );
    expect([family.familyId, recipe?.onchainId, recipe?.creator]).toEqual([
      familyId,
      onchainId,
      creator.key.address,
    ]);
    expect(recipe).toMatchObject({
      source: 'chain',
      provenance: 'sandbox',
      textMatches: 'active',
      pending: null,
      autoFollow: { offered: true },
    });
    expect(recipe?.active.version).toBe(1);
    expect(recipe?.active.components).toEqual(screen.publish?.components);

    // A person buys it on Solana, following the version the screen read.
    const buyer = await someone();
    const buy = await call<OrderDetail>(buyer.person, 'POST', '/v1/orders', {
      type: 'buy',
      owner: { solana: buyer.key.address },
      amountUsd: 10,
      family: slug,
      version: 1,
    });
    expect(buy.legs.map((l) => [l.kind, l.trades.map((t) => t.buy)])).toEqual([
      ['create_vault', []],
      ['swap', [id('alpha')]],
      ['swap', [id('beta')]],
      ['swap', [id('gamma')]],
    ]);
    const follow: PlanTerms = {
      basketId: basketIdOfPlan(familyId),
      follow: { recipeOnchainId: onchainId, version: 1 },
      autoFollow: false,
    };
    // A create that follows another version than the one the screen read: refused.
    const first = buy.legs[0];
    if (!first) throw new Error('no step');
    const create = await call<BuildLegResponse>(
      buyer.person,
      'POST',
      `/v1/orders/${buy.id}/legs/${first.id}/build`,
    );
    expect(
      guarded(
        buy,
        first.id,
        create,
        { ...follow, follow: { recipeOnchainId: onchainId, version: 2 } },
        [],
      ),
    ).not.toBeNull();
    const bought = await walk(buyer, buy, follow, [], { [first.id]: create });
    expect(bought.status).toBe('done');
    const portfolio = await call<PortfolioResponse>(buyer.person, 'GET', '/v1/portfolio');
    const vault = portfolio.chains[0]?.vaults[0];
    expect([vault?.recipeOnchainId, vault?.acceptedVersion, vault?.autoFollow]).toEqual([
      onchainId,
      1,
      false,
    ]);
    expect(vault?.positions.map((p) => [p.asset, p.targetBps])).toEqual(
      expect.arrayContaining([
        [id('alpha'), 4_000],
        [id('beta'), 3_000],
        [id('gamma'), 3_000],
      ]),
    );
  });
});
