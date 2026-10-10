import {
  type Address,
  BuiltTx,
  type ChainAdapter,
  Order,
  parseChainConfigs,
  stampTx,
} from '@colosseum/schemas';
import type { GuardDeployment } from '@colosseum/sdk';
import { approvedSteps, deploymentsOf, guardTransaction } from '@colosseum/sdk';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ChainEntry } from '../../apps/api/src/orders/chains';
import { buildRetarget, checkMix, mixContext, planRetarget } from '../../apps/api/src/orders/mix';
import { nonFinitePaths } from '../../apps/api/src/plugins/finite';
import {
  ACCOUNTS,
  buildTestnetWorld,
  id,
  TESTNET_RECORD,
  type TestnetWorld,
} from '../../packages/chain-evm/test/testnet-world';
import { fixtureLiquidity } from '../../packages/engine/src/personal/testing';

// A change of targets on an EVM vault that holds all of one stock and no cash, to all of another: the
// order the vault's chat makes, built step by step by the adapter on a copy of Robinhood Chain's test
// network and held to the guard. Its swap step sells the stock and spends that sale's cash in the same
// transaction (the product owner's report of Oct 9: the step was refused, the vault holding no cash
// before the sale).
//
//   RH_TESTNET_FORK_URL=https://rpc.testnet.chain.robinhood.com pnpm exec vitest run tests/evm-vault/change-targets.test.ts

const FORK_URL = process.env.RH_TESTNET_FORK_URL;
const PORT = Number(process.env.RH_TESTNET_CHANGE_PORT ?? 28_765);
const owner = ACCOUNTS.owner;
const DEPOSIT = '100000000';

describe.skipIf(!FORK_URL)('a change of targets, all of one stock into all of another', () => {
  vi.setConfig({ hookTimeout: 600_000, testTimeout: 300_000 });
  let started: Promise<TestnetWorld> | undefined;
  const start = () => {
    started ??= buildTestnetWorld(FORK_URL ?? '', PORT);
    return started;
  };
  afterAll(async () => (await started)?.stop());

  it('sets the targets, then sells and spends the sale in one step the guard passes', async () => {
    const w = await start();
    const { adapter } = w;
    const land = async (tx: BuiltTx) => {
      const { txId } = await w.send(tx);
      const receipt = await w.client.getTransactionReceipt({ hash: txId as `0x${string}` });
      expect(receipt.status, tx.description).toBe('success');
    };
    // The prices of both stocks as fresh as the vault takes them, as the price writer keeps them.
    for (const asset of [id('ttsla'), id('tgoogl')]) await w.movePrice(asset, 0);

    // A vault holding all TSLA and no cash.
    await land(await adapter.buildApprove({ owner, basketId: '91', amountRaw: DEPOSIT }));
    await land(
      await adapter.buildCreateVault({
        owner,
        basketId: '91',
        targets: [{ asset: id('ttsla'), weightBps: 10_000 }],
        autoFollow: false,
        depositRaw: DEPOSIT,
        trades: [{ sell: id('tusdg'), buy: id('ttsla'), amountInRaw: DEPOSIT }],
        slippageBps: 100,
      }),
    );
    const vault = (await adapter.getVaults(owner)).find((v) => v.basketId === '91');
    if (!vault) throw new Error('no vault');
    expect(vault.cash.raw).toBe('0');

    const config = parseChainConfigs(
      { CHAIN_NETWORK_ROBINHOOD: 'testnet' },
      {
        robinhood: {
          factory: TESTNET_RECORD.contracts.factory,
          registry: TESTNET_RECORD.contracts.registry,
        },
      },
    ).robinhood;
    const entry: ChainEntry = {
      chain: 'robinhood',
      mode: 'live',
      provenance: 'sandbox',
      source: 'a local copy of the test network',
      config,
      adapter: adapter as ChainAdapter,
    };
    const now = new Date().toISOString();
    const ctx = await mixContext(
      entry,
      async () => ({
        liquidity: { provider: fixtureLiquidity({}), source: 'fixture exit table' },
      }),
      now,
    );
    const checked = await checkMix(ctx, [{ assetId: id('tgoogl'), weightBps: 10_000 }], vault);
    const { order, request } = await planRetarget(ctx, vault, checked, {
      slippageBps: 100,
      now,
      owner: owner as Address,
    });
    expect(nonFinitePaths(order)).toEqual([]);
    Order.parse(order);
    expect(order.legs.map((l) => l.kind)).toEqual(['set_targets', 'swap']);
    const [targets, swap] = order.legs;
    if (!targets || !swap) throw new Error('no steps');
    // The sale first, of the stock, in its own 18 decimals; then the purchase with cash.
    expect(swap.trades.map((t) => [t.sell, t.buy])).toEqual([
      [id('ttsla'), id('tusdg')],
      [id('tusdg'), id('tgoogl')],
    ]);
    expect(swap.trades[0]?.amountInRaw).toBe(vault.positions[0]?.raw);

    const deployment = deploymentsOf('testnet').robinhood as GuardDeployment;
    const steps = approvedSteps(order, { basketId: '91', targets: request.targets }, deployment);
    const signed = async (leg: (typeof order.legs)[number]) => {
      const tx = BuiltTx.parse(
        await buildRetarget(request, leg, entry, owner as Address, undefined),
      );
      expect(nonFinitePaths(tx)).toEqual([]);
      const step = steps.find((s) => s.legId === leg.id);
      if (!step) throw new Error('no approved step');
      guardTransaction({
        step,
        tx: stampTx(tx, { legId: leg.id, attemptId: `${leg.id}-a` }),
        deployment,
        consents: [],
      });
      return tx;
    };
    await land(await signed(targets));
    // The step the report saw refused: the vault holds no cash until the sale in it has run.
    const tx = await signed(swap);
    // What the bytes hold each trade to is what the order stated, asset for asset.
    expect(tx.preview.minimums).toEqual(
      swap.trades.map((t, i) => ({
        sell: t.sell,
        buy: t.buy,
        inRaw: t.amountInRaw,
        minOutRaw: swap.expected[i]?.minOutRaw,
      })),
    );
    await land(tx);
    const after = await adapter.getVault(vault.address);
    expect(after?.positions.find((p) => p.asset === id('ttsla'))?.raw ?? '0').toBe('0');
    expect(
      BigInt(after?.positions.find((p) => p.asset === id('tgoogl'))?.raw ?? '0'),
    ).toBeGreaterThan(BigInt(swap.expected[1]?.minOutRaw ?? '0') - 1n);
  });
});
