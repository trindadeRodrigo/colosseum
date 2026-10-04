import { adapterContract } from '@colosseum/chain-mock/contract';
import { lamports } from '@solana/kit';
import { describe, it } from 'vitest';
import { priceAccountBytes } from './admin';
import { buildContractWorld, newKey, PRICE_ENTRIES } from './contract-world';
import { createSvmNode, MOCK_ROUTER_PROGRAM, PROGRAMS_BUILT } from './svm-node';

// The Solana adapter held to the whole adapter contract where LiteSVM is enough: the real program and
// the test exchange in memory, a world made through the adapter's own builders, and every group that
// reads, quotes, builds or refuses. Sending signed bytes, tracking and finding a landing nobody
// reported need a node's own answers: those two groups run on a local validator
// (`validator.test.ts`). It needs the built programs:
//
//   anchor build --no-idl -- --tools-version v1.54

const notBefore = new Date().toISOString();

if (!PROGRAMS_BUILT)
  describe.skip('adapter contract: solana, in LiteSVM (target/deploy is not built)', () => {
    it('needs the built programs', () => {});
  });
else
  adapterContract(
    'solana, in LiteSVM',
    async () => {
      const deployer = await newKey();
      const start = BigInt(Math.floor(Date.now() / 1000));
      const node = await createSvmNode(deployer.address, start);
      node.svm.airdrop(deployer.address, lamports(1_000_000_000_000n));
      const priceAccount = (await newKey()).address;
      const writePrices = (at: bigint) => {
        const data = priceAccountBytes(PRICE_ENTRIES, at, node.svm.getClock().slot);
        node.svm.setAccount({
          address: priceAccount,
          data,
          executable: false,
          lamports: lamports(node.svm.minimumBalanceForRentExemption(BigInt(data.length))),
          programAddress: MOCK_ROUTER_PROGRAM,
          space: BigInt(data.length),
        });
      };
      writePrices(start);
      const world = await buildContractWorld(
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
        { deployer, priceAccount, pendingVersion: true, network: 'testnet', notBefore },
      );
      return world.fixture;
    },
    { groups: ['reads', 'shared portfolios', 'quotes', 'builds', 'refusals'] },
  );
