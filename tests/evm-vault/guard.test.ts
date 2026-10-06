import { type BuiltTx, stampTx } from '@colosseum/schemas';
import type { ApprovedStep, GuardDeployment } from '@colosseum/sdk';
import { deploymentsOf, guardTransaction, isGuardRefusal } from '@colosseum/sdk';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNTS,
  buildTestnetWorld,
  DEPOSIT_RAW,
  id,
  type TestnetWorld,
} from '../../packages/chain-evm/test/testnet-world';

// Every owner step the EVM adapter builds, held to the guard of packages/sdk (DESIGN-VAULT section 9)
// with the deployment committed for the test network (packages/sdk/deployments/testnet.json), on a
// copy of Robinhood Chain's test network. The guard reads the bytes and refuses anything that is not
// the step: each build here passes, and the same build held to another step is refused.
//
//   RH_TESTNET_FORK_URL=https://rpc.testnet.chain.robinhood.com pnpm exec vitest run tests/evm-vault/guard.test.ts

const FORK_URL = process.env.RH_TESTNET_FORK_URL;
const PORT = Number(process.env.RH_TESTNET_GUARD_PORT ?? 28_755);
const owner = ACCOUNTS.owner;
/** A step as the review screen holds it, before it is tied to a leg, a chain and an owner. */
type StepOf = ApprovedStep extends infer S
  ? S extends ApprovedStep
    ? Omit<S, 'legId' | 'chain' | 'owner'>
    : never
  : never;

describe.skipIf(!FORK_URL)('the guard, on what the EVM adapter builds', () => {
  vi.setConfig({ hookTimeout: 600_000, testTimeout: 180_000 });
  let started: Promise<TestnetWorld> | undefined;
  const start = () => {
    started ??= buildTestnetWorld(FORK_URL ?? '', PORT);
    return started;
  };
  afterAll(async () => (await started)?.stop());

  const deployment = () => {
    const robinhood = deploymentsOf('testnet').robinhood;
    if (!robinhood) throw new Error('the guard has no Robinhood Chain test network');
    return robinhood as GuardDeployment;
  };
  let leg = 0;
  const guard = (step: StepOf, tx: BuiltTx) => {
    leg += 1;
    const legId = `leg-${leg}`;
    return guardTransaction({
      step: { ...step, legId, chain: 'robinhood', owner } as ApprovedStep,
      tx: stampTx(tx, { legId, attemptId: `${legId}-a` }),
      deployment: deployment(),
      consents: ['auto_follow_on', 'new_asset'],
    });
  };
  const passes = (step: Parameters<typeof guard>[0], tx: BuiltTx) =>
    expect(guard(step, tx).tx.messageHash).toBe(tx.messageHash);
  const refused = (step: Parameters<typeof guard>[0], tx: BuiltTx) => {
    let outcome: unknown = 'passed';
    try {
      guard(step, tx);
    } catch (e) {
      outcome = e;
    }
    expect(isGuardRefusal(outcome), 'the guard refuses it').toBe(true);
  };
  const trade = (tx: BuiltTx) =>
    tx.preview.minimums.map((m) => ({
      sell: m.sell,
      buy: m.buy,
      inRaw: m.inRaw,
      minOutRaw: m.minOutRaw,
    }));

  it('passes an approval for the plan, and no other amount', async () => {
    const { adapter } = await start();
    const tx = await adapter.buildApprove({ owner, basketId: '77', amountRaw: '1000000' });
    passes({ kind: 'approve', basketId: '77', amountRaw: '1000000' }, tx);
    refused({ kind: 'approve', basketId: '77', amountRaw: '999999' }, tx);
    refused({ kind: 'approve', basketId: '78', amountRaw: '1000000' }, tx);
  });

  it('passes a create with its own targets and a deposit, and one that follows and buys', async () => {
    const { adapter, recipeA } = await start();
    const targets = [{ asset: id('tspy'), weightBps: 5000 }];
    const own = await adapter.buildCreateVault({
      owner,
      basketId: '77',
      targets,
      autoFollow: false,
      depositRaw: DEPOSIT_RAW.toString(),
      slippageBps: 100,
    });
    const step = {
      kind: 'create_vault' as const,
      basketId: '77',
      targets,
      follow: null,
      autoFollow: false,
      depositRaw: DEPOSIT_RAW.toString(),
      trades: [],
    };
    passes(step, own);
    refused({ ...step, depositRaw: '1' }, own);
    refused({ ...step, autoFollow: true }, own);

    const buy = await adapter.buildCreateVault({
      owner,
      basketId: '77',
      targets: [],
      recipeOnchainId: recipeA,
      expectedVersion: 1,
      autoFollow: false,
      depositRaw: DEPOSIT_RAW.toString(),
      trades: [{ sell: id('tusdg'), buy: id('tspy'), amountInRaw: '5000000' }],
      slippageBps: 100,
    });
    const follows = {
      ...step,
      targets: [],
      follow: { recipeOnchainId: recipeA, version: 1 },
      trades: trade(buy),
    };
    passes(follows, buy);
    refused({ ...follows, trades: [] }, buy);
  });

  it('passes a deposit, alone and with trades, and a swap of two trades', async () => {
    const { adapter, vault } = await start();
    const alone = await adapter.buildDeposit({ vault, amountRaw: '1000000', slippageBps: 100 });
    passes({ kind: 'deposit', basketId: '1', amountRaw: '1000000', trades: [] }, alone);
    refused({ kind: 'deposit', basketId: '2', amountRaw: '1000000', trades: [] }, alone);

    const buying = await adapter.buildDeposit({
      vault,
      amountRaw: '2000000',
      trades: [{ sell: id('tusdg'), buy: id('tqqq'), amountInRaw: '2000000' }],
      slippageBps: 100,
    });
    passes({ kind: 'deposit', basketId: '1', amountRaw: '2000000', trades: trade(buying) }, buying);

    const swap = await adapter.buildOwnerSwap({
      vault,
      trades: [
        { sell: id('tusdg'), buy: id('tspy'), amountInRaw: '1000000' },
        { sell: id('tusdg'), buy: id('tnvda'), amountInRaw: '1000000' },
      ],
      slippageBps: 100,
    });
    const trades = trade(swap);
    passes({ kind: 'swap', basketId: '1', trades }, swap);
    const lower = trades.map((t, i) =>
      i === 0 ? { ...t, minOutRaw: (BigInt(t.minOutRaw) + 1n).toString() } : t,
    );
    refused({ kind: 'swap', basketId: '1', trades: lower }, swap);
  });

  it('passes targets, an accept, the auto-follow switch and both withdrawals', async () => {
    const { adapter, vault, manualVault, newAssetVault, recipeB } = await start();
    const targets = [
      { asset: id('tspy'), weightBps: 6000 },
      { asset: id('tqqq'), weightBps: 2500 },
    ];
    passes(
      { kind: 'set_targets', basketId: '2', targets },
      await adapter.buildSetTargets({ vault: manualVault, targets }),
    );
    const accept = await adapter.buildAcceptVersion({
      vault: newAssetVault,
      recipeOnchainId: recipeB,
      expectedVersion: 2,
    });
    passes(
      { kind: 'accept_version', basketId: '3', follow: { recipeOnchainId: recipeB, version: 2 } },
      accept,
    );
    refused(
      { kind: 'accept_version', basketId: '3', follow: { recipeOnchainId: recipeB, version: 3 } },
      accept,
    );
    passes(
      { kind: 'set_auto_follow', basketId: '2', on: true },
      await adapter.buildSetAutoFollow({ vault: manualVault, on: true }),
    );
    const [all] = await adapter.buildWithdrawInKind({ vault });
    if (!all) throw new Error('nothing to withdraw');
    passes({ kind: 'withdraw', basketId: '1', withdrawals: 'all' }, all);
    const [cash] = await adapter.buildWithdrawInKind({ vault, assets: [id('tusdg')] });
    if (!cash) throw new Error('no cash to withdraw');
    passes(
      { kind: 'withdraw', basketId: '1', withdrawals: [{ asset: id('tusdg'), amountRaw: null }] },
      cash,
    );
    refused(
      { kind: 'withdraw', basketId: '1', withdrawals: [{ asset: id('tspy'), amountRaw: null }] },
      cash,
    );
  });
});
