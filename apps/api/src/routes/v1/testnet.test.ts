import { randomUUID } from 'node:crypto';
import { familyIdOf } from '@colosseum/basket';
import {
  FundingResponse,
  OrderDetail,
  PortfolioResponse,
  TestFundsResponse,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestFundsSend, TestFundsSender } from '../../faucet/test-funds';
import type { ChainRegistry } from '../../orders/chains';
import { NO_SUCH_VAULT } from '../../orders/prepare';
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

// POST /v1/testnet/fund over HTTP: signed in only, refused on the mock and where no faucet key is
// configured (and GET /v1/funding then says nothing of it), and on a test network it sends what the
// funding read says is missing, to the person's own wallet. The chain is the mock's adapter dressed as
// a test network's, with a sender that records what it was asked.

vi.setConfig({ testTimeout: 60_000 });

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let bare: FastifyInstance;
let faucetApp: FastifyInstance;
let mockApp: FastifyInstance;
let registry: ChainRegistry;
let plans: Record<HomeChain, string>;
const sent: TestFundsSend[] = [];
const sender: TestFundsSender = {
  chain: 'solana',
  float: async () => ({ cashRaw: 10n ** 15n, gasRaw: 10n ** 20n }),
  send: async (order) => {
    sent.push(order);
    return ['devnet-signature'];
  },
};
const undo: (() => Promise<unknown>)[] = [];

/** Off while a test opens a vault through the mock's own routes, on the same chain state. */
let dressed = true;
/** The registry, with Solana's entry dressed as a test network's real adapter. */
const onTestnet = (inner: ChainRegistry): ChainRegistry => {
  const dress = <T extends ReturnType<ChainRegistry['get']>>(e: T): T =>
    dressed && e.chain === 'solana'
      ? { ...e, mode: 'live', provenance: 'sandbox', mock: undefined }
      : e;
  return { ...inner, get: (c) => dress(inner.get(c)), active: () => inner.active().map(dress) };
};

beforeAll(async () => {
  issuer = await testIssuer('testnet');
  data = await testDb();
  undo.push(() => data.cleanUp());
  plans = {
    solana: await data.storePlan(planFixture('solana')),
    robinhood: await data.storePlan(planFixture('robinhood')),
  };
  ({ app: bare } = await testApp({ issuer: issuer.issuer, db: data.db, wrap: onTestnet }));
  undo.push(() => bare.close());
  ({ app: faucetApp, registry } = await testApp({
    issuer: issuer.issuer,
    db: data.db,
    wrap: onTestnet,
    testFunds: [sender],
  }));
  undo.push(() => faucetApp.close());
  ({ app: mockApp } = await testApp({ issuer: issuer.issuer, db: data.db, testFunds: [sender] }));
  undo.push(() => mockApp.close());
});
afterAll(async () => {
  for (const step of undo.reverse()) await step();
});

const { post, get, put, fund, order, settleAll } = orderFlow({
  app: () => faucetApp,
  registry: () => registry,
  plans: () => plans,
});
const someone = async () => data.track(await person(issuer, 'solana'));
const ask = () => ({ amountUsd: 200, proposalId: plans.solana });

describe('POST /v1/testnet/fund', () => {
  it('needs a sign-in', async () => {
    const res = await post(null, '/v1/testnet/fund', ask());
    expect(res.statusCode).toBe(401);
  });

  it('is not offered, and refuses, on a server with no faucet key', async () => {
    const a = await someone();
    const read = await get(a, `/v1/funding?amountUsd=200&proposalId=${plans.solana}`, bare);
    expect(read.statusCode, read.body).toBe(200);
    expect(FundingResponse.parse(read.json()).testFunds).toBeUndefined();
    const res = await post(a, '/v1/testnet/fund', ask(), bare);
    expect(res.statusCode).toBe(404);
  });

  it('is refused on the mock chain, which has its own MOCK route', async () => {
    const a = await someone();
    const read = await get(a, `/v1/funding?amountUsd=200&proposalId=${plans.solana}`, mockApp);
    expect(FundingResponse.parse(read.json()).testFunds).toBeUndefined();
    const res = await post(a, '/v1/testnet/fund', ask(), mockApp);
    expect(res.statusCode).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('on a test network: offers it, and sends what the buy is missing to the person’s wallet', async () => {
    const a = await someone();
    const read = FundingResponse.parse(
      (await get(a, `/v1/funding?amountUsd=200&proposalId=${plans.solana}`)).json(),
    );
    expect(read.testFunds).toBe(true);
    expect(read.ok).toBe(false);
    const res = await post(a, '/v1/testnet/fund', ask());
    expect(res.statusCode, res.body).toBe(200);
    const answer = TestFundsResponse.parse(res.json());
    expect(answer.wallet).toBe(a.solana);
    expect(answer.txIds).toEqual(['devnet-signature']);
    expect(sent.at(-1)?.to).toBe(a.solana);
    // The missing cash with its 1% margin, never an amount the request named.
    const cash = BigInt(read.cash.missingRaw);
    expect(sent.at(-1)?.cashRaw).toBe(cash + (cash + 99n) / 100n);
    // Nothing in the answer names a node or a key.
    expect(res.body).not.toMatch(/https?:|key/i);
  });

  it('refuses a wallet that is not the person’s, and a body that names an amount to send', async () => {
    const a = await someone();
    const other = await someone();
    const theirs = await post(a, '/v1/testnet/fund', { ...ask(), wallet: other.solana });
    expect(theirs.statusCode).toBe(403);
    const extra = await post(a, '/v1/testnet/fund', { ...ask(), cashRaw: '1000000000000' });
    expect(extra.statusCode).toBe(400);
  });
});

// A deposit into a shared portfolio names the chain of its recipe (gate CHAIN-AT-THE-PLAN): the faucet
// reads the need on that chain, as GET /v1/funding does, whatever the person's current chain is.
describe('POST /v1/testnet/fund for a shared portfolio on a named chain', () => {
  /** A portfolio published on Solana through the mock's routes, by a Solana creator. */
  async function published() {
    const creator = await someone();
    const slug = `t-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    data.trackFamily(familyIdOf(slug));
    const letters = slug.replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)] ?? 'a').slice(2, 14);
    dressed = false;
    try {
      await fund(creator);
      const res = await post(creator, '/v1/orders', {
        type: 'publish',
        creator: { solana: creator.solana },
        family: slug,
        name: `Test ${letters}`,
        copy: 'Three test tokens.',
        recipes: [
          {
            chain: 'solana',
            components: [
              { kind: 'asset', asset: 'solana:spy', weightBps: 4000 },
              { kind: 'asset', asset: 'solana:nvda', weightBps: 3000 },
              { kind: 'asset', asset: 'solana:tsla', weightBps: 3000 },
            ],
          },
        ],
      });
      expect(res.statusCode, res.body).toBe(200);
      await settleAll(creator, OrderDetail.parse(res.json()));
    } finally {
      dressed = true;
    }
    return slug;
  }

  it('sends to the person’s wallet on the chain named, though their new plans start on another', async () => {
    const slug = await published();
    const who = data.track(await person(issuer, 'passkey'));
    expect((await put(who, '/v1/me/chain', { chain: 'robinhood' })).statusCode).toBe(200);
    const body = { amountUsd: 50, family: slug };
    // with no chain named it is asked of the current chain, where the portfolio has no recipe
    expect((await post(who, '/v1/testnet/fund', body)).statusCode).toBe(422);
    const before = sent.length;
    const res = await post(who, '/v1/testnet/fund', { ...body, chain: 'solana' });
    expect(res.statusCode, res.body).toBe(200);
    expect(TestFundsResponse.parse(res.json()).wallet).toBe(who.solana);
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)?.to).toBe(who.solana);
    expect(sent.at(-1)?.cashRaw).toBeGreaterThan(50_000_000n);
  });

  it('refuses a chain no wallet of the person signs on, and a chain sent with a plan, and sends nothing', async () => {
    const slug = await published();
    const evm = data.track(await person(issuer, 'robinhood'));
    const before = sent.length;
    const res = await post(evm, '/v1/testnet/fund', {
      amountUsd: 50,
      family: slug,
      chain: 'solana',
    });
    expect([res.statusCode, res.json().code]).toEqual([409, 'NO_WALLET_FOR_CHAIN']);
    const a = await someone();
    expect((await post(a, '/v1/testnet/fund', { ...ask(), chain: 'solana' })).statusCode).toBe(400);
    expect(sent.length).toBe(before);
  });
});

// An add to a vault (API-ADD-MONEY): the faucet reads the need as GET /v1/funding does, so the vault is
// one of the caller's own, the funds go to the caller's wallet, and the person's daily sends count.
describe('POST /v1/testnet/fund for an add to a vault', () => {
  /** A person with one vault on Solana, opened through the mock's routes, and $500 of cash left. */
  async function withVault() {
    const who = await someone();
    dressed = false;
    try {
      await fund(who, undefined, 1_500);
      await settleAll(who, await order(who, { amountUsd: 1_000 }));
    } finally {
      dressed = true;
    }
    const read = await get(who, '/v1/portfolio');
    expect(read.statusCode, read.body).toBe(200);
    const [vault] = PortfolioResponse.parse(read.json()).chains.flatMap((c) => c.vaults);
    if (!vault) throw new Error('the buy opened no vault');
    return { who, add: { amountUsd: 2_000, vault: vault.address, vaultChain: 'solana' } };
  }

  it('sends what the add is missing to the caller’s own wallet, three times a day and no more', async () => {
    const { who, add } = await withVault();
    const read = FundingResponse.parse(
      (await get(who, `/v1/funding?amountUsd=2000&vault=${add.vault}&vaultChain=solana`)).json(),
    );
    expect(read.testFunds).toBe(true);
    expect(read.newVault).toBe(false);
    const before = sent.length;
    const res = await post(who, '/v1/testnet/fund', add);
    expect(res.statusCode, res.body).toBe(200);
    expect(TestFundsResponse.parse(res.json()).wallet).toBe(who.solana);
    expect(sent).toHaveLength(before + 1);
    expect(sent.at(-1)?.to).toBe(who.solana);
    const cash = BigInt(read.cash.missingRaw);
    expect(cash).toBeGreaterThan(0n);
    expect(sent.at(-1)?.cashRaw).toBe(cash + (cash + 99n) / 100n);
    // The person's daily sends count for an add as for a buy: the sender here moves nothing, so the
    // need stands, and the fourth ask of the day is refused.
    expect((await post(who, '/v1/testnet/fund', add)).statusCode).toBe(200);
    expect((await post(who, '/v1/testnet/fund', add)).statusCode).toBe(200);
    const fourth = await post(who, '/v1/testnet/fund', add);
    expect(fourth.statusCode, fourth.body).toBe(429);
    expect(sent).toHaveLength(before + 3);
  });

  it('answers another person’s vault as unknown, and sends nothing', async () => {
    const { who, add } = await withVault();
    const other = await someone();
    const before = sent.length;
    const theirs = await post(other, '/v1/testnet/fund', add);
    expect(theirs.statusCode, theirs.body).toBe(404);
    expect(theirs.json().error).toBe(NO_SUCH_VAULT);
    // the same answer as for a vault that does not exist
    const none = await post(other, '/v1/testnet/fund', { ...add, vault: other.solana });
    expect([none.statusCode, none.json().error]).toEqual([404, NO_SUCH_VAULT]);
    // nor to the owner's wallet when another person names it, nor to another wallet for the owner
    const forOwner = await post(other, '/v1/testnet/fund', { ...add, wallet: who.solana });
    expect(forOwner.statusCode).toBe(403);
    const elsewhere = await post(who, '/v1/testnet/fund', { ...add, wallet: other.solana });
    expect(elsewhere.statusCode).toBe(403);
    expect(sent).toHaveLength(before);
  });
});
