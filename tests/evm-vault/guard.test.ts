import { callHash } from '@colosseum/chain-evm/vault';
import { type BuiltTx, stampTx } from '@colosseum/schemas';
import type { ApprovedStep, GuardDeployment } from '@colosseum/sdk';
import {
  deploymentsOf,
  familyIdOf,
  familyTextHash,
  guardTransaction,
  isGuardRefusal,
} from '@colosseum/sdk';
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
      consents: ['auto_follow_on', 'new_asset', 'publish'],
    });
  };
  const passes = (step: Parameters<typeof guard>[0], tx: BuiltTx) =>
    expect(guard(step, tx).tx.messageHash).toBe(tx.messageHash);
  const refused = (step: Parameters<typeof guard>[0], tx: BuiltTx, code?: string) => {
    let outcome: unknown = 'passed';
    try {
      guard(step, tx);
    } catch (e) {
      outcome = e;
    }
    expect(isGuardRefusal(outcome), 'the guard refuses it').toBe(true);
    if (code) expect((outcome as { code: string }).code).toBe(code);
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
    // A create that trades states its deadline as the attempt's `validUntil`, a few minutes ahead.
    const wall = Math.floor(Date.now() / 1000);
    expect(buy.lastValidBlockHeight).toBeGreaterThan(wall);
    expect(buy.lastValidBlockHeight).toBeLessThanOrEqual(wall + 1_800);
    expect(own.lastValidBlockHeight).toBeGreaterThan(wall);
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
    // Only the bytes differ: the first minimum in the call data one unit lower, the preview and the
    // step as built, and the message hash worked out again so it is the hash of the bytes. The guard
    // reads the minimum from the bytes and refuses them.
    const first = trades[0];
    if (!first) throw new Error('no trade');
    const word = (n: bigint) => n.toString(16).padStart(64, '0');
    expect(swap.payload.split(word(BigInt(first.minOutRaw))).length).toBe(2);
    const payload = swap.payload.replace(
      word(BigInt(first.minOutRaw)),
      word(BigInt(first.minOutRaw) - 1n),
    );
    const bytesOnly = {
      ...swap,
      payload,
      messageHash: callHash({
        chainId: swap.evm?.chainId ?? 0,
        signer: swap.signer,
        to: swap.evm?.to ?? '',
        value: '0',
        data: payload,
      }),
    };
    refused({ kind: 'swap', basketId: '1', trades }, bytesOnly, 'minimum');
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

  it('passes a creator’s registry calls: a create, the next version, and taking back the one that waits', async () => {
    const world = await start();
    const { adapter } = world;
    const text = {
      slug: 'rh-guard',
      name: 'RH guard',
      copy: 'Three test tokens.',
      kind: 'index' as const,
    };
    const component = (symbol: string, weightBps: number) => ({ asset: id(symbol), weightBps });
    const recipe = (familyId: string, components: { asset: string; weightBps: number }[]) => ({
      schemaVersion: 1 as const,
      familyId,
      chain: 'robinhood' as const,
      onchainId: null,
      creator: owner,
      kind: 'community' as const,
      version: 1,
      effectiveAt: 0,
      components: components.map((c) => ({ kind: 'asset' as const, ...c })),
      metaHash: familyTextHash({ familyId, ...text }),
      maxFeeBps: 0 as const,
      flags: 0 as const,
    });
    const step = (
      action: 'publish' | 'update' | 'cancel',
      familyId: string,
      components: { asset: string; weightBps: number }[],
      shown = text,
    ) => ({
      kind: 'publish' as const,
      basketId: '0',
      action,
      familyId,
      components: action === 'cancel' ? [] : components,
      text: action === 'cancel' ? null : shown,
      version: action === 'publish' ? 1 : 2,
    });

    // a new family: the adapter builds `create`
    const familyId = familyIdOf(text.slug);
    const first = [component('tspy', 4000), component('tqqq', 3000), component('tgld', 3000)];
    const create = await adapter.buildPublishRecipe({
      creator: owner,
      recipe: recipe(familyId, first),
    });
    passes(step('publish', familyId, first), create);
    refused(step('publish', familyId, first, { ...text, copy: 'Other words.' }), create, 'recipe');
    refused(step('publish', familyIdOf('another'), first), create, 'recipe');
    refused(
      step('publish', familyId, [
        component('tspy', 5000),
        component('tqqq', 2500),
        component('tgld', 2500),
      ]),
      create,
      'targets',
    );
    refused(step('update', familyId, first), create, 'function');

    // A's next version: the adapter builds `publish`, held to the same text and the creator's id
    const next = [component('tspy', 3500), component('tqqq', 3500), component('tnvda', 3000)];
    const update = await adapter.buildPublishRecipe({
      creator: owner,
      recipe: recipe(world.familyA, next),
    });
    passes(step('update', world.familyA, next), update);
    refused(step('update', world.familyB, next), update, 'recipe');

    // B's version 3 waits: the adapter's cancel is held to B, and to no other family
    const cancel = await adapter.buildCancelPending({
      signer: owner,
      recipeOnchainId: world.recipeB,
    });
    passes(step('cancel', world.familyB, []), cancel);
    refused(step('cancel', world.familyA, []), cancel, 'recipe');
  });
});
