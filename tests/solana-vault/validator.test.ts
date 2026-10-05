import { randomUUID } from 'node:crypto';
import { adapterContract } from '@colosseum/chain-mock/contract';
import {
  assertNode,
  createVaultRpc,
  MAINNET_GENESIS_HASH,
  type SolanaDeploymentRecord,
} from '@colosseum/chain-solana/vault';
import {
  type OrderDetail,
  type PortfolioResponse,
  parseChainConfigs,
  parseFlags,
} from '@colosseum/schemas';
import {
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
} from '@solana/kit';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../apps/api/src/app';
import { createChainRegistry } from '../../apps/api/src/orders/chains';
import {
  type Person,
  planFixture,
  ROOMY,
  signIn,
  testDb,
  testIssuer,
} from '../../apps/api/src/testing/harness';
import { mintTo, transferSol } from './admin';
import { id, newKey } from './contract-world';
import { BASKET_PROGRAM, MOCK_ROUTER_PROGRAM, PROGRAMS_BUILT } from './svm-node';
import { type Started, sleep, startValidator } from './validator';

// Then the API itself on the same validator: the real route handlers, the registry taking the Solana
// adapter, and a person's order to open a vault with a deposit and buy each asset, each step built by
// the API, signed here with a key made for the run and reported back, ending with the portfolio read
// from the chain. It needs the database the other API tests use (`pnpm db:up`).
//
// The adapter contract's two groups that need a node's own answers, on a local validator: signed bytes
// read back, relayed and found on the chain, a landing nobody reported found by `fate`, and the state
// each kind of transaction leaves once it lands, read back over RPC. The other five groups run in
// LiteSVM (contract.test.ts). Nothing leaves the machine. It needs the Solana tools and the built
// programs, and only runs when asked:
//
//   anchor build --no-idl -- --tools-version v1.54
//   SOLANA_LOCAL_VALIDATOR=1 pnpm exec vitest run tests/solana-vault/validator.test.ts
//
// SOLANA_ADAPTER_VALIDATOR_PORT moves it off 28999 and the forty ports above it.

const RUN = process.env.SOLANA_LOCAL_VALIDATOR === '1' && PROGRAMS_BUILT;
const PORT = Number(process.env.SOLANA_ADAPTER_VALIDATOR_PORT ?? 28_999);
const notBefore = new Date().toISOString();

let started: Promise<Started> | undefined;
/** One validator for the file, started the first time a setup asks for it. */
const validator = () => {
  started ??= startValidator(PORT, notBefore);
  return started;
};

if (RUN) {
  // Starting the validator and building the world takes a few minutes: two publish delays are waited.
  vi.setConfig({ hookTimeout: 600_000, testTimeout: 120_000 });
  afterAll(async () => {
    (await started)?.stop();
  });
  adapterContract('solana, on a local validator', async () => (await validator()).world.fixture, {
    groups: ['signed bytes', 'state after a transaction lands'],
  });

  describe("the node check a server makes at start, on the validator's own genesis", () => {
    it('passes a local validator, and a record naming its genesis, and refuses a record naming another', async () => {
      const { rpcUrl } = await validator();
      const rpc = createVaultRpc(rpcUrl);
      await expect(assertNode(rpc, null)).resolves.toBeUndefined();
      const genesis = await rpc.getGenesisHash().send();
      expect(genesis).not.toBe(MAINNET_GENESIS_HASH);
      // Only the two fields the check reads.
      const record = {
        genesisHash: genesis,
        network: 'solana-local',
      } as unknown as SolanaDeploymentRecord;
      await expect(assertNode(rpc, record)).resolves.toBeUndefined();
      await expect(
        assertNode(rpc, { ...record, genesisHash: MOCK_ROUTER_PROGRAM }),
      ).rejects.toThrow('not the network of the record solana-local');
    });
  });

  describe('the API on the Solana adapter, on the same validator', () => {
    it("builds a person's buy step by step, relays each signed step, and reads the vault back from the chain", async () => {
      const { world, rpc } = await validator();
      const { deployer } = world.keys;
      // The person's outside wallet: a key made for this run, with SOL and test dollars on the chain.
      const wallet = await newKey();
      const cash = world.mints.cash;
      if (!cash) throw new Error('the world has no cash mint');
      await world.run(deployer, [
        transferSol(deployer.address, wallet.address, 2_000_000_000n),
        ...(await mintTo({
          mint: cash.address,
          tokenProgram: cash.tokenProgram,
          holder: wallet.address,
          authority: deployer.address,
          amount: 500_000_000n,
        })),
      ]);

      const env = {
        CHAIN_MODE_SOLANA: 'live',
        CHAIN_NETWORK_SOLANA: 'testnet',
        CHAIN_ROUTER_SOLANA: MOCK_ROUTER_PROGRAM,
        CHAIN_PRICE_SOURCE_SOLANA: world.priceAccount,
        CHAIN_MODE_ROBINHOOD: 'off',
        CHAIN_MODE_BASE: 'off',
      };
      const contracts = { solana: { program: BASKET_PROGRAM } };
      // The registry as the server makes it, with this validator's RPC and the world's assets.
      const chains = createChainRegistry(parseFlags(env), parseChainConfigs(env, contracts), {
        seed: `e2e:${randomUUID()}`,
        solana: { rpc, assets: world.assets },
      });
      const issuer = await testIssuer('solana-e2e');
      const store = await testDb();
      const sub = `did:privy:e2e-${randomUUID()}`;
      const app = await buildApp({
        env,
        v1: { auth: issuer.issuer, chains, contracts, db: store.db, limits: ROOMY },
      });
      try {
        const headers = await signIn(issuer, sub, [
          { family: 'solana', address: wallet.address, client: 'phantom' },
        ]);
        // So the clean-up takes away the person's orders, vault rows and stored chain.
        const person: Person = {
          sub,
          kind: 'solana',
          chain: 'solana',
          solana: wallet.address,
          // An EVM address nobody else has: the person has none, and the clean-up keys on it.
          evm: `0x${randomUUID().replaceAll('-', '')}${'0'.repeat(8)}`,
          owner: { solana: wallet.address },
          headers,
        };
        store.track(person);
        const call = async <T>(method: 'GET' | 'POST', url: string, payload?: unknown) => {
          const res = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
          if (res.statusCode >= 300)
            throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
          return res.json() as T;
        };

        const proposalId = await store.storePlan(
          planFixture('solana', { alpha: 4_000, beta: 3_000, gamma: 3_000 }),
        );
        let order = await call<OrderDetail>('POST', '/v1/orders', {
          type: 'buy',
          owner: { solana: wallet.address },
          amountUsd: 100,
          proposalId,
        });
        expect(order.legs.map((l) => [l.kind, l.trades.map((t) => t.buy)])).toEqual([
          ['create_vault', []],
          ['swap', [id('alpha')]],
          ['swap', [id('beta')]],
          ['swap', [id('gamma')]],
        ]);
        expect(order.legs.every((l) => l.provenance === 'sandbox')).toBe(true);

        for (const leg of order.legs) {
          const built = await call<{ tx: { payload: string; messageHash: string } }>(
            'POST',
            `/v1/orders/${order.id}/legs/${leg.id}/build`,
          );
          const signed = await partiallySignTransaction(
            [wallet.pair],
            getTransactionDecoder().decode(new Uint8Array(Buffer.from(built.tx.payload, 'base64'))),
          );
          order = await call<OrderDetail>('POST', `/v1/orders/${order.id}/legs/${leg.id}/report`, {
            signedTx: getBase64EncodedWireTransaction(signed),
          });
          // The API relayed the bytes; a read tracks the step until the chain has confirmed it.
          for (let i = 0; i < 120; i++) {
            const now = order.legs.find((l) => l.id === leg.id);
            if (now?.status === 'confirmed' || now?.status === 'failed') break;
            await sleep(500);
            order = await call<OrderDetail>('GET', `/v1/orders/${order.id}`);
          }
          const settled = order.legs.find((l) => l.id === leg.id);
          expect([leg.kind, settled?.status, settled?.error]).toEqual([
            leg.kind,
            'confirmed',
            null,
          ]);
          expect(settled?.txId).toBeTruthy();
        }
        expect(order.status).toBe('done');

        const portfolio = await call<PortfolioResponse>('GET', '/v1/portfolio');
        const [solana] = portfolio.chains;
        expect([solana?.chain, solana?.provenance, solana?.vaults.length]).toEqual([
          'solana',
          'sandbox',
          1,
        ]);
        const vault = solana?.vaults[0];
        // $100 in: $40, $30 and $30 of the three assets at the test exchange's prices, nothing left in cash.
        expect(vault?.owner).toBe(wallet.address);
        expect(vault?.cash.raw).toBe('0');
        expect(
          Object.fromEntries((vault?.positions ?? []).map((p) => [p.asset, [p.targetBps, p.raw]])),
        ).toEqual({
          [id('alpha')]: [4_000, '80000000'],
          [id('beta')]: [3_000, '150000000'],
          [id('gamma')]: [3_000, '15000000'],
          [id('delta')]: undefined,
        });
      } finally {
        await app.close();
        await store.cleanUp();
      }
    });
  });
} else
  describe.skip('adapter contract: solana, on a local validator (SOLANA_LOCAL_VALIDATOR=1 runs it)', () => {
    it('needs a validator and the built programs', () => {});
  });
