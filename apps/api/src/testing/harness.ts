import { randomUUID } from 'node:crypto';
import { mockAddress } from '@colosseum/chain-mock';
import {
  createDb,
  type Db,
  indexFamilies,
  legAttempts,
  legs,
  orders,
  proposals,
  recipes,
  recipeVersions,
  seedChains,
  users,
  vaults,
} from '@colosseum/db';
import {
  type BasketProposal,
  type ChainId,
  type Component,
  DISCLAIMER,
  type EnvLike,
  parseChainConfigs,
  parseFlags,
} from '@colosseum/schemas';
import { inArray, or } from 'drizzle-orm';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../app';
import type { TestFundsSender } from '../faucet/test-funds';
import { type ChainRegistry, createChainRegistry } from '../orders/chains';
import type { PlanInputs } from '../orders/personalize';
import { IDENTITY_TOKEN_HEADER, type TokenIssuer } from '../plugins/auth';
import { LIMITS, type Limits } from '../plugins/limits';
import type { LinkedPlanLimits } from '../routes/v1/baskets';

// For tests only. Nothing the server runs imports this file: the tokens here are signed with a key
// pair made in the test, and the app under test is handed that pair's public half as its only issuer.

export type TestIssuer = {
  issuer: TokenIssuer;
  /**
   * A token signed with this issuer's key. `claims` may replace `iss` and `aud`; `expiresAt` is a
   * span from now ('10m') or a time in unix seconds.
   */
  sign(sub: string, claims?: Record<string, unknown>, expiresAt?: string | number): Promise<string>;
};

export async function testIssuer(name: string): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const kid = `${name}-${randomUUID()}`;
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const issuer: TokenIssuer = {
    issuer: `https://${name}.issuer.invalid`,
    audience: `${name}-app`,
    keys: createLocalJWKSet({ keys: [jwk] }),
  };
  return {
    issuer,
    sign: (sub, claims = {}, expiresAt = '10m') =>
      new SignJWT({ iss: issuer.issuer, aud: issuer.audience, sub, ...claims })
        .setProtectedHeader({ alg: 'ES256', kid })
        .setIssuedAt()
        .setExpirationTime(expiresAt)
        .sign(privateKey),
  };
}

/**
 * How a test person signed in, which is what decides the chain they start on (gates ONE-CHAIN,
 * CHAIN-SWITCH):
 * - `solana`: connected an outside Solana wallet. They are on Solana.
 * - `robinhood`: connected an outside EVM wallet. They are on Robinhood Chain.
 * - `passkey`: made their wallets in the app, one of each family. No chain until they pick one.
 */
export type PersonKind = 'solana' | 'robinhood' | 'passkey';
/** The two chains a person can be on while Base is not deployed. */
export type HomeChain = 'solana' | 'robinhood';

export type Person = {
  sub: string;
  kind: PersonKind;
  /** The chain of the outside wallet. Null for a passkey person: theirs is the one they pick. */
  chain: HomeChain | null;
  /**
   * A Solana and an EVM address nobody else has. Only the ones of the person's kind are in the
   * identity token: the other is an address the token does not carry.
   */
  solana: string;
  evm: string;
  /** The wallets the identity token lists, as the owner of an order. */
  owner: { solana?: string; evm?: string };
  /** What the web app sends: the access token as a bearer, the identity token in its own header. */
  headers: Record<string, string>;
};

/**
 * A person with wallets nobody else has. The identity token lists an EVM address in upper case, as a
 * wallet provider may, and an email account that is not a wallet.
 */
export async function person(issuer: TestIssuer, kind: PersonKind = 'solana'): Promise<Person> {
  const id = randomUUID();
  const sub = `did:privy:test-${id}`;
  const solana = mockAddress('solana', `api-test:${id}`);
  const evm = mockAddress('robinhood', `api-test:${id}`);
  const client = kind === 'passkey' ? 'privy' : kind === 'solana' ? 'phantom' : 'metamask';
  const wallets = [
    { type: 'wallet', address: solana, chain_type: 'solana', wallet_client_type: client },
    {
      type: 'wallet',
      address: `0x${evm.slice(2).toUpperCase()}`,
      chain_type: 'ethereum',
      wallet_client_type: client,
    },
  ];
  const has = { solana: kind !== 'robinhood', evm: kind !== 'solana' };
  const linked = [
    ...wallets.filter((w) => (w.chain_type === 'solana' ? has.solana : has.evm)),
    { type: 'email', address: 'someone@example.invalid' },
  ];
  const access = await issuer.sign(sub, { sid: id });
  const identity = await issuer.sign(sub, { linked_accounts: JSON.stringify(linked) });
  return {
    sub,
    kind,
    chain: kind === 'passkey' ? null : kind,
    solana,
    evm,
    owner: { ...(has.solana ? { solana } : {}), ...(has.evm ? { evm } : {}) },
    headers: { authorization: `Bearer ${access}`, [IDENTITY_TOKEN_HEADER]: identity },
  };
}

/**
 * The headers of a sign-in whose identity token lists exactly these wallets: for a mix `person` has no
 * kind for, or the same person signing in again with other wallets. `client` is what made the wallet:
 * `privy` is one made in the app, anything else an outside wallet.
 */
export async function signIn(
  issuer: TestIssuer,
  sub: string,
  wallets: { family: 'solana' | 'evm'; address: string; client: string }[],
): Promise<Record<string, string>> {
  const linked = wallets.map((w) => ({
    type: 'wallet',
    address: w.address,
    chain_type: w.family === 'solana' ? 'solana' : 'ethereum',
    wallet_client_type: w.client,
  }));
  const access = await issuer.sign(sub, { sid: randomUUID() });
  const identity = await issuer.sign(sub, { linked_accounts: JSON.stringify(linked) });
  return { authorization: `Bearer ${access}`, [IDENTITY_TOKEN_HEADER]: identity };
}

/** The weights of the default test plan: three assets, nothing kept in cash. */
export const WHOLE = { spy: 5000, nvda: 3000, gold: 2000 };

/**
 * A stored plan on one chain. `weights` are the plan's assets in basis points; what they leave of
 * 10,000 is the plan's cash share, which the lines carry as the chain's cash token and the recipe
 * leaves out. `components` replaces the recipe's components, for a plan that holds a shared portfolio
 * as one line: the lines stay those of `weights`, which is what the person was shown.
 */
export function planFixture(
  chain: ChainId = 'solana',
  weights: Record<string, number> = WHOLE,
  components?: Component[],
): BasketProposal {
  const amountUsd = 1000;
  const invested = Object.values(weights).reduce((n, bps) => n + bps, 0);
  const line = (slug: string, weightBps: number) => ({
    chain,
    assetId: `${chain}:${slug}`,
    weightBps,
    amountUsd: (amountUsd * weightBps) / 10_000,
    reasons: [],
  });
  return {
    sheet: {
      basketType: 'standard',
      goal: 'grow',
      amountUsd,
      horizonMonths: 60,
      risk: 'medium',
      themes: [],
      country: 'BR',
      chains: [chain],
      rules: { useHoldings: false, glide: false },
      language: 'en',
    },
    engineVersion: 'test',
    paramsHash: 'test',
    shelfVersion: 'test',
    inputsHash: `api-test:${randomUUID()}`,
    lines: [
      ...Object.entries(weights).map(([slug, bps]) => line(slug, bps)),
      ...(invested < 10_000 ? [line('usdc', 10_000 - invested)] : []),
    ],
    recipes: [
      {
        chain,
        amountUsd,
        components:
          components ??
          Object.entries(weights).map(([slug, weightBps]) => ({
            kind: 'asset' as const,
            asset: `${chain}:${slug}`,
            weightBps,
          })),
      },
    ],
    removed: [],
    card: {
      moneyTodayUsd: amountUsd,
      termMonths: 60,
      cashFlow: 'none',
      expectedReturn: { lowPct: 0, highPct: 0, basis: 'test fixture', lossInFallUsd: 0 },
      exit: { text: 'not measured', costBps: null },
    },
    flags: [],
    observations: [],
    disclaimer: DISCLAIMER.en,
  };
}

/**
 * The database a test file works in, and the rows it must take away again. Other sessions may share
 * this database, so every row a test makes hangs off a person, a plan or a shared portfolio made here,
 * and `cleanUp` deletes exactly those.
 */
export async function testDb() {
  const { db, client } = createDb();
  await seedChains(db, parseChainConfigs({}));
  const owners: string[] = [];
  const people: string[] = [];
  const plans: string[] = [];
  const families: string[] = [];
  return {
    db,
    /** Remembers a person, so their orders, vault rows and picked chain are deleted at the end. */
    track(p: Person) {
      owners.push(p.solana, p.evm);
      people.push(p.sub);
      return p;
    },
    async storePlan(proposal = planFixture()): Promise<string> {
      const [row] = await db
        .insert(proposals)
        .values({
          inputsHash: proposal.inputsHash,
          proposal,
          engineVersion: proposal.engineVersion,
          shelfVersion: proposal.shelfVersion,
          paramsHash: proposal.paramsHash,
        })
        .returning({ id: proposals.id });
      if (!row) throw new Error('plan insert');
      plans.push(row.id);
      return row.id;
    },
    /**
     * A shared portfolio as the cache tables hold one: a family, its recipe on `chain`, and the
     * version in effect. Answers the slug a plan names it by, and a way to put another version in
     * effect.
     */
    async storeFamily(chain: ChainId, components: Component[]) {
      const familyId = randomUUID().replaceAll('-', '').padEnd(64, '0');
      const slug = `test-${familyId.slice(0, 12)}`;
      families.push(familyId);
      await db.insert(indexFamilies).values({
        familyId,
        slug,
        nameKey: slug,
        name: `Test ${slug}`,
        copy: '',
        creatorKind: 'platform',
        kind: 'index',
      });
      const [recipe] = await db
        .insert(recipes)
        .values({
          familyId,
          chainId: chain,
          onchainId: `test:${familyId}`,
          creator: mockAddress(chain, 'creator'),
          kind: 'community',
        })
        .returning({ id: recipes.id });
      if (!recipe) throw new Error('recipe insert');
      let version = 0;
      const publish = async (next: Component[]) => {
        await db
          .update(recipeVersions)
          .set({ status: 'superseded' })
          .where(inArray(recipeVersions.recipeId, [recipe.id]));
        version += 1;
        await db.insert(recipeVersions).values({
          recipeId: recipe.id,
          version,
          components: next,
          metaHash: '0'.repeat(64),
          effectiveAt: new Date(),
          status: 'active',
        });
      };
      await publish(components);
      return { slug, publish };
    },
    /** Remembers a shared portfolio a test published through the API, so its rows go at the end. */
    trackFamily(familyId: string) {
      families.push(familyId);
    },
    async cleanUp() {
      // Before the people: a family a test published names its creator's user row.
      if (families.length) {
        const mine = await db
          .select({ id: recipes.id })
          .from(recipes)
          .where(inArray(recipes.familyId, families));
        const recipeIds = mine.map((r) => r.id);
        if (recipeIds.length) {
          await db.delete(recipeVersions).where(inArray(recipeVersions.recipeId, recipeIds));
          await db.delete(recipes).where(inArray(recipes.id, recipeIds));
        }
        await db.delete(indexFamilies).where(inArray(indexFamilies.familyId, families));
      }
      if (owners.length) {
        const mine = await db
          .select({ id: orders.id })
          .from(orders)
          .where(or(inArray(orders.ownerSolana, owners), inArray(orders.ownerEvm, owners)));
        const orderIds = mine.map((r) => r.id);
        if (orderIds.length) {
          const legIds = (
            await db.select({ id: legs.id }).from(legs).where(inArray(legs.orderId, orderIds))
          ).map((r) => r.id);
          if (legIds.length) await db.delete(legAttempts).where(inArray(legAttempts.legId, legIds));
          await db.delete(legs).where(inArray(legs.orderId, orderIds));
          await db.delete(orders).where(inArray(orders.id, orderIds));
        }
        await db.delete(vaults).where(inArray(vaults.owner, owners));
      }
      if (people.length) {
        // The plans a person made through the API name them: those go before the person does.
        const mine = await db
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.privyId, people));
        if (mine.length)
          await db.delete(proposals).where(
            inArray(
              proposals.userId,
              mine.map((u) => u.id),
            ),
          );
        await db.delete(users).where(inArray(users.privyId, people));
      }
      if (plans.length) await db.delete(proposals).where(inArray(proposals.id, plans));
      await client.end();
    },
  };
}

/**
 * Limits no test reaches by accident: a test file makes hundreds of requests a minute from one
 * address. The limiter runs all the same. A test of the limits passes `LIMITS`, the server's own.
 */
export const ROOMY: Limits = {
  windowSeconds: LIMITS.windowSeconds,
  caller: { anonymous: 1_000_000, signedIn: 1_000_000 },
  class: { standard: null, build: 1_000_000, parse: 1_000_000 },
};

/** The app with its /v1 routes on a mock registry the test can reach into. */
export async function testApp(a: {
  issuer: TokenIssuer | null;
  db: Db;
  env?: EnvLike;
  now?: () => Date;
  limits?: Limits;
  /** The daily cap and keeping time of plans made from a link. */
  linkedPlans?: LinkedPlanLimits;
  /** Wraps the registry, to make a chain misbehave. */
  wrap?: (registry: ChainRegistry) => ChainRegistry;
  /** The figures a plan is made with. Default: the server's reader of the stored ones. */
  planInputs?: PlanInputs;
  /** The test faucet's senders (POST /v1/testnet/fund). Default: none. */
  testFunds?: TestFundsSender[];
}) {
  const env = a.env ?? {};
  const registry = createChainRegistry(parseFlags(env), parseChainConfigs(env), {
    seed: `test:${randomUUID()}`,
    now: a.now,
  });
  const app = await buildApp({
    env,
    v1: {
      auth: a.issuer,
      chains: a.wrap ? a.wrap(registry) : registry,
      db: a.db,
      now: a.now,
      limits: a.limits ?? ROOMY,
      ...(a.linkedPlans ? { linkedPlans: a.linkedPlans } : {}),
      ...(a.planInputs ? { planInputs: a.planInputs } : {}),
      ...(a.testFunds ? { testFunds: a.testFunds } : {}),
    },
  });
  return { app, registry };
}
