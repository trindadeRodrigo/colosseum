import { recipeAddress } from '@colosseum/chain-solana/vault';
import type { BasketTx, BuiltTx, ConsentKind, Recipe } from '@colosseum/schemas';
import {
  type ApprovedStep,
  type DeploymentFile,
  deploymentsOf,
  type GuardDeployment,
  GuardRefusal,
  guardTransaction,
} from '@colosseum/sdk';
import { type Address, lamports } from '@solana/kit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { withFile } from '../../packages/sdk/test/deployments';
import { priceAccountBytes } from './admin';
import {
  buildContractWorld,
  type ContractWorld,
  id,
  newKey,
  PARAMS,
  priceEntries,
} from './contract-world';
import {
  BASKET_PROGRAM,
  createSvmNode,
  MOCK_ROUTER_PROGRAM,
  PROGRAMS_BUILT,
  type SvmNode,
} from './svm-node';

// The guard (packages/sdk, AGT-4) on what the Solana adapter really builds for a creator: a first
// publish, an update, and taking back the version that waits, in LiteSVM with the real program. Each
// passes the guard held to what the creator saw, and lands; the same bytes held to anything else are
// refused. The deployment is the world's own, loaded the one way the guard takes one: as the file of a
// network, put in place of the package's committed files for this test (test/deployments.ts).

vi.mock(
  '../../packages/sdk/src/guard/generated/deployment-files',
  () => import('../../packages/sdk/test/deployments'),
);

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const FAMILY = '33'.repeat(32);

describe.skipIf(!PROGRAMS_BUILT)(
  'the guard on the registry calls the adapter builds, in LiteSVM',
  () => {
    let w: ContractWorld;
    let node: SvmNode;
    let deployment: GuardDeployment;

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
                {
                  mint: m.address,
                  tokenProgram: m.tokenProgram === TOKEN ? 'token' : 'token-2022',
                },
              ]),
            ),
          },
        },
      };
      const loaded = withFile(file, () => deploymentsOf('local')).solana;
      if (!loaded) throw new Error('the world has no deployment');
      deployment = loaded;
    }, 120_000);

    const owner = () => w.fixture.owner;
    const recipeOf = (version: number, weights: [string, number][]): Recipe => ({
      schemaVersion: 1,
      familyId: FAMILY,
      chain: 'solana',
      onchainId: null,
      creator: owner(),
      kind: 'community',
      version,
      effectiveAt: 0,
      components: weights.map(([name, weightBps]) => ({
        kind: 'asset',
        asset: id(name),
        weightBps,
      })),
      metaHash: `4${version}`.repeat(32),
      maxFeeBps: 0,
      flags: 0,
    });
    const stepOf = (action: 'publish' | 'update' | 'cancel', r: Recipe): ApprovedStep => ({
      legId: 'leg-1',
      chain: 'solana',
      owner: owner(),
      basketId: '0',
      kind: 'publish',
      action,
      familyId: FAMILY,
      components:
        action === 'cancel'
          ? []
          : r.components.map((c) => ({
              asset: c.kind === 'asset' ? c.asset : '',
              weightBps: c.weightBps,
            })),
      metaHash: action === 'cancel' ? null : r.metaHash,
      version: r.version,
    });
    const asLeg = (built: BuiltTx): BasketTx => ({
      ...built,
      legId: 'leg-1',
      attemptId: 'attempt-1',
    });
    const codeOf = (step: ApprovedStep, tx: BasketTx, consents: ConsentKind[] = ['publish']) => {
      try {
        guardTransaction({ step, tx, deployment, consents });
        return null;
      } catch (e) {
        if (e instanceof GuardRefusal) return e.code;
        throw e;
      }
    };

    it('passes a first publish, an update and a cancel as built, each of which lands, and refuses the same bytes held to anything else', async () => {
      const first = recipeOf(1, [
        ['alpha', 4_000],
        ['beta', 3_000],
        ['gamma', 3_000],
      ]);
      const published = asLeg(
        await w.adapter.buildPublishRecipe({ creator: owner(), recipe: first }),
      );
      const publishStep = stepOf('publish', first);
      expect(codeOf(publishStep, published)).toBeNull();
      // What the creator did not see, on the same bytes.
      expect(codeOf({ ...publishStep, familyId: '34'.repeat(32) } as ApprovedStep, published)).toBe(
        'recipe',
      );
      expect(
        codeOf(
          {
            ...publishStep,
            components: [
              { asset: id('alpha'), weightBps: 3_000 },
              { asset: id('beta'), weightBps: 4_000 },
              { asset: id('gamma'), weightBps: 3_000 },
            ],
          } as ApprovedStep,
          published,
        ),
      ).toBe('targets');
      expect(codeOf({ ...publishStep, owner: w.fixture.stranger } as ApprovedStep, published)).toBe(
        'signer',
      );
      expect(codeOf(publishStep, published, [])).toBe('consent');
      expect(codeOf(stepOf('update', first), published)).toBe('instruction');
      await w.must(published);
      const recipe = await recipeAddress(
        BASKET_PROGRAM,
        owner() as Address,
        Buffer.from(FAMILY, 'hex'),
      );
      // It landed: the registry holds the creator's portfolio of this family now.
      const held = node.svm.getAccount(recipe);
      expect(held.exists && held.programAddress).toBe(BASKET_PROGRAM);

      // The next version, a publish delay later: the adapter builds an update, which waits its delay.
      node.advance(PARAMS.publishDelayS + 1);
      const next = recipeOf(2, [
        ['alpha', 3_500],
        ['beta', 3_000],
        ['gamma', 3_500],
      ]);
      const updated = asLeg(await w.adapter.buildPublishRecipe({ creator: owner(), recipe: next }));
      const updateStep = stepOf('update', next);
      expect(codeOf(updateStep, updated)).toBeNull();
      expect(codeOf({ ...updateStep, metaHash: '45'.repeat(32) } as ApprovedStep, updated)).toBe(
        'recipe',
      );
      expect(codeOf(stepOf('publish', next), updated)).toBe('instruction');
      await w.must(updated);

      // The version that waits, taken back.
      const cancelled = asLeg(
        await w.adapter.buildCancelPending({ signer: owner(), recipeOnchainId: recipe }),
      );
      const cancelStep = stepOf('cancel', next);
      expect(codeOf(cancelStep, cancelled)).toBeNull();
      expect(codeOf({ ...cancelStep, familyId: '34'.repeat(32) } as ApprovedStep, cancelled)).toBe(
        'recipe',
      );
      expect(codeOf(cancelStep, cancelled, ['new_asset'])).toBe('consent');
      await w.must(cancelled);
    });
  },
);
