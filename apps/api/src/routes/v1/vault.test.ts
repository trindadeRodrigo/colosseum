import { mockAddress } from '@colosseum/chain-mock';
import { PortfolioResponse, VaultResponse } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChainRegistry } from '../../orders/chains';
import { orderFlow } from '../../testing/flow';
import {
  person,
  planFixture,
  type TestIssuer,
  testApp,
  testDb,
  testIssuer,
} from '../../testing/harness';

// The public vault page's read (WEB-4): any vault by its chain and address, for anybody, as its chain
// has it now.

vi.setConfig({ testTimeout: 60_000 });

let issuer: TestIssuer;
let data: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let registry: ChainRegistry;
let plans: { solana: string; robinhood: string };
const undo: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  issuer = await testIssuer('test');
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

const { get, fund, order, settleAll } = orderFlow({
  app: () => app,
  registry: () => registry,
  plans: () => plans,
});

describe('a vault, read by anybody', () => {
  it('answers the vault as the owner reads it, with no sign-in', async () => {
    const owner = data.track(await person(issuer, 'solana'));
    await fund(owner);
    await settleAll(owner, await order(owner, { amountUsd: 100 }));
    const mine = PortfolioResponse.parse((await get(owner, '/v1/portfolio')).json());
    const vault = mine.chains[0]?.vaults[0];
    if (!vault) throw new Error('no vault');
    const res = await get(null, `/v1/vaults/solana/${vault.address}`);
    expect(res.statusCode, res.body).toBe(200);
    const read = VaultResponse.parse(res.json());
    expect([read.chain, read.provenance, read.vault.owner]).toEqual([
      'solana',
      'mock',
      owner.solana,
    ]);
    expect(read.vault.positions.map((p) => [p.asset, p.targetBps])).toEqual(
      vault.positions.map((p) => [p.asset, p.targetBps]),
    );
    expect(read.vault.valueUsd).toBe(vault.valueUsd);
    expect(read.prices.every((p) => p.provenance === 'mock')).toBe(true);
  });

  it('answers 404 where there is no vault, and 400 for an address of the other family or chain', async () => {
    expect(
      (await get(null, `/v1/vaults/solana/${mockAddress('solana', 'no vault here')}`)).statusCode,
    ).toBe(404);
    expect((await get(null, `/v1/vaults/solana/0x${'1'.repeat(40)}`)).statusCode).toBe(400);
    expect((await get(null, '/v1/vaults/nowhere/abc')).statusCode).toBe(400);
  });
});
