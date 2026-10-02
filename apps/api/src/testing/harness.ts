import { randomUUID } from 'node:crypto';
import { mockAddress } from '@colosseum/chain-mock';
import {
  createDb,
  type Db,
  legAttempts,
  legs,
  orders,
  proposals,
  seedChains,
  vaults,
} from '@colosseum/db';
import {
  type BasketProposal,
  type ChainId,
  DISCLAIMER,
  type EnvLike,
  parseChainConfigs,
  parseFlags,
} from '@colosseum/schemas';
import { inArray, or } from 'drizzle-orm';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../app';
import { type ChainRegistry, createChainRegistry } from '../orders/chains';
import { IDENTITY_TOKEN_HEADER, type TokenIssuer } from '../plugins/auth';

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

export type Person = {
  sub: string;
  solana: string;
  evm: string;
  owner: { solana: string; evm: string };
  /** What the web app sends: the access token as a bearer, the identity token in its own header. */
  headers: Record<string, string>;
};

/**
 * A person with a Solana and an EVM wallet nobody else has. The identity token lists the EVM address in
 * upper case, as a wallet provider may, and an email account that is not a wallet.
 */
export async function person(issuer: TestIssuer): Promise<Person> {
  const id = randomUUID();
  const sub = `did:privy:test-${id}`;
  const solana = mockAddress('solana', `api-test:${id}`);
  const evm = mockAddress('robinhood', `api-test:${id}`);
  const linked = [
    { type: 'wallet', address: solana, chain_type: 'solana', wallet_client_type: 'privy' },
    {
      type: 'wallet',
      address: `0x${evm.slice(2).toUpperCase()}`,
      chain_type: 'ethereum',
      wallet_client_type: 'metamask',
    },
    { type: 'email', address: 'someone@example.invalid' },
  ];
  const access = await issuer.sign(sub, { sid: id });
  const identity = await issuer.sign(sub, { linked_accounts: JSON.stringify(linked) });
  return {
    sub,
    solana,
    evm,
    owner: { solana, evm },
    headers: { authorization: `Bearer ${access}`, [IDENTITY_TOKEN_HEADER]: identity },
  };
}

/** A stored plan: the same three assets on Solana (60%) and Robinhood Chain (40%). */
export function planFixture(): BasketProposal {
  const weights = { spy: 5000, nvda: 3000, gold: 2000 };
  const split: [ChainId, number][] = [
    ['solana', 600],
    ['robinhood', 400],
  ];
  return {
    sheet: {
      basketType: 'standard',
      goal: 'grow',
      amountUsd: 1000,
      horizonMonths: 60,
      risk: 'medium',
      themes: [],
      country: 'BR',
      chains: ['solana', 'robinhood'],
      rules: { useHoldings: false, glide: false },
      language: 'en',
    },
    engineVersion: 'test',
    paramsHash: 'test',
    shelfVersion: 'test',
    inputsHash: `api-test:${randomUUID()}`,
    lines: split.flatMap(([chain, amountUsd]) =>
      Object.entries(weights).map(([slug, bps]) => ({
        chain,
        assetId: `${chain}:${slug}`,
        weightBps: (bps * amountUsd) / 1000,
        amountUsd: (amountUsd * bps) / 10_000,
        reasons: [],
      })),
    ),
    recipes: split.map(([chain, amountUsd]) => ({
      chain,
      amountUsd,
      components: Object.entries(weights).map(([slug, weightBps]) => ({
        kind: 'asset' as const,
        asset: `${chain}:${slug}`,
        weightBps,
      })),
    })),
    removed: [],
    card: {
      moneyTodayUsd: 1000,
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
 * The database a test file works in, and the rows it must take away again. Other sessions share this
 * database, so every row a test makes hangs off a wallet or a plan made here, and `cleanUp` deletes
 * exactly those.
 */
export async function testDb() {
  const { db, client } = createDb();
  await seedChains(db, parseChainConfigs({}));
  const owners: string[] = [];
  const plans: string[] = [];
  return {
    db,
    /** Remembers a person's wallets, so their orders and vault rows are deleted at the end. */
    track(p: Person) {
      owners.push(p.solana, p.evm);
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
    async cleanUp() {
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
      if (plans.length) await db.delete(proposals).where(inArray(proposals.id, plans));
      await client.end();
    },
  };
}

/** The app with its /v1 routes on a mock registry the test can reach into. */
export async function testApp(a: {
  issuer: TokenIssuer | null;
  db: Db;
  env?: EnvLike;
  now?: () => Date;
  /** Wraps the registry, to make a chain misbehave. */
  wrap?: (registry: ChainRegistry) => ChainRegistry;
}) {
  const env = a.env ?? {};
  const registry = createChainRegistry(parseFlags(env), parseChainConfigs(env), {
    seed: `test:${randomUUID()}`,
    now: a.now,
  });
  const app = await buildApp({
    v1: { auth: a.issuer, chains: a.wrap ? a.wrap(registry) : registry, db: a.db, now: a.now },
  });
  return { app, registry };
}
