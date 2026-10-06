import { FundingResponse, TestFundsResponse } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestFundsSend, TestFundsSender } from '../../faucet/test-funds';
import type { ChainRegistry } from '../../orders/chains';
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

/** The registry, with Solana's entry dressed as a test network's real adapter. */
const onTestnet = (inner: ChainRegistry): ChainRegistry => {
  const dress = <T extends ReturnType<ChainRegistry['get']>>(e: T): T =>
    e.chain === 'solana' ? { ...e, mode: 'live', provenance: 'sandbox', mock: undefined } : e;
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

const { post, get } = orderFlow({
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
