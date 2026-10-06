import { txIdOf } from '@colosseum/chain-evm/vault';
import type { BuiltTx } from '@colosseum/schemas';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { KeeperAdapter } from '../../apps/keeper/src/chain';
import { REVERTED } from '../../apps/keeper/src/policy';
import { newMemory, runRound, type VaultLine } from '../../apps/keeper/src/round';
import {
  ACCOUNTS,
  buildTestnetWorld,
  id,
  type TestnetWorld,
} from '../../packages/chain-evm/test/testnet-world';

// The keeper on Robinhood Chain (KEEP-2), on a copy of the test network (46630) as TNET-1 and TNET-2
// deployed it: the round of KEEP-1 on the EVM adapter, with anvil's keeper account signing what the
// adapter builds. The world is ADE-2's: a vault that follows a shared portfolio with auto-follow on,
// bought under its targets. Nothing is sent to the test network.
//
//   RH_TESTNET_FORK_URL=https://rpc.testnet.chain.robinhood.com pnpm exec vitest run tests/keeper/evm.test.ts

const FORK_URL = process.env.RH_TESTNET_FORK_URL;
const PORT = Number(process.env.RH_TESTNET_KEEPER_PORT ?? 28_765);

describe.skipIf(!FORK_URL)('the keeper on a copy of Robinhood Chain test network', () => {
  vi.setConfig({ hookTimeout: 600_000, testTimeout: 300_000 });
  let started: Promise<TestnetWorld> | undefined;
  const start = () => {
    started ??= buildTestnetWorld(FORK_URL ?? '', PORT);
    return started;
  };
  afterAll(async () => (await started)?.stop());
  const memory = newMemory();
  const sign = (w: TestnetWorld) => async (tx: BuiltTx) => {
    const wire = await w.sign(tx);
    return { wire, txId: txIdOf(wire) };
  };
  const round = async (
    w: TestnetWorld,
    more: { send?: (wire: string) => Promise<unknown>; dryRun?: boolean } = {},
  ) => {
    const lines: VaultLine[] = [];
    await runRound(
      {
        adapter: w.adapter as KeeperAdapter,
        sign: sign(w),
        settleMs: 20_000,
        shuffle: (v) => v,
        log: (l) => lines.push(l),
        ...more,
      },
      memory,
    );
    return lines;
  };
  const of = (lines: VaultLine[], vault: string) => {
    const line = lines.find((l) => l.vault === vault);
    if (!line) throw new Error(`no line for ${vault}`);
    return line;
  };

  it("reads a vault as keeperSwap would: each target valued, tradable, and the factory's rules", async () => {
    const w = await start();
    const ctx = await w.adapter.getKeeperContext(w.vault);
    expect(ctx?.blocked).toBeNull();
    expect(ctx?.rules).toMatchObject({
      paused: false,
      lossCapBps: 100,
      bandBps: 50,
      priceDevBps: 200,
    });
    const targets = ctx?.positions.filter((p) => p.targetBps > 0) ?? [];
    // every target is one of the vault's targets() and on the factory's list
    expect(targets.every((p) => p.target && p.listed)).toBe(true);
    expect(targets.map((p) => p.asset).sort()).toEqual([id('tnvda'), id('tqqq'), id('tspy')]);
    for (const p of targets) {
      expect([p.asset, p.keeperOn, p.reference, p.trade, p.needsSync]).toEqual([
        p.asset,
        true,
        null,
        null,
        false,
      ]);
      expect(Number(p.price?.usdPerToken)).toBeGreaterThan(0);
    }
    expect(await w.adapter.getKeeperContext(ACCOUNTS.owner)).toBeNull();
  });

  it('plans and builds in a dry run, and sends nothing', async () => {
    const w = await start();
    const before = await w.adapter.getVault(w.vault);
    const line = of(await round(w, { dryRun: true }), w.vault);
    expect(line.outcome).toBe('would-act');
    expect(line.txIds).toEqual([]);
    expect(await w.adapter.getVault(w.vault)).toEqual({
      ...before,
      observedAt: expect.any(String),
    });
  });

  it('sends one leg toward the targets, and the next round waits out that asset’s cooldown', async () => {
    const w = await start();
    const line = of(await round(w), w.vault);
    expect(line.outcome).toBe('acted');
    expect(line.txIds).toHaveLength(1);
    expect(memory.inFlight.size).toBe(0);
    const bought = /for (robinhood:[a-z]+)/.exec(line.reason)?.[1];
    const after = await w.adapter.getVault(w.vault);
    expect(after?.positions.find((p) => p.asset === bought)?.lastKeeperAt).not.toBeNull();
    const ctx = await w.adapter.getKeeperContext(w.vault);
    expect(ctx?.positions.find((p) => p.asset === bought)?.trade).toBe('Cooldown');
    const next = of(await round(w), w.vault);
    expect(next.reason).not.toContain(`for ${bought}`);
  });

  it('remembers a leg that landed and reverted, and does not send it again on that version', async () => {
    const w = await start();
    // Past every cooldown, so the plan's first trade can go again.
    await w.later(3_700);
    const plan = of(await round(w, { dryRun: true }), w.vault);
    const asset = /for (robinhood:[a-z]+)/.exec(plan.reason)?.[1];
    if (!asset) throw new Error(`no leg planned: ${plan.reason}`);
    // Between the build and the send, the price jumps 3%: past what the average allows, so the vault
    // refuses the leg, which lands and reverts. The price goes back afterwards.
    const line = of(
      await round(w, {
        send: async (wire) => {
          await w.movePrice(asset, 300);
          await w.sendRaw(wire);
          await w.movePrice(asset, -291);
        },
      }),
      w.vault,
    );
    expect(line.alert).toBe(true);
    expect(line.reason).toContain('reverted');
    expect([...memory.reverted].some((k) => k.endsWith(`->${asset}`))).toBe(true);
    const again = of(await round(w, { dryRun: true }), w.vault);
    expect(again.alert).toBe(true);
    expect(again.reason).toContain(REVERTED);
    expect(again.reason).not.toContain(`for ${asset}`);
  });

  it('adopts a version that only changes weights, once its time has come, and forgets the reverted legs', async () => {
    const w = await start();
    const { active } = await w.adapter.getRecipe(w.recipeA);
    const next = active.components.map((c) =>
      c.kind === 'asset' && c.asset === id('tspy')
        ? { ...c, weightBps: c.weightBps - 500 }
        : c.kind === 'asset' && c.asset === id('tqqq')
          ? { ...c, weightBps: c.weightBps + 500 }
          : c,
    );
    await w.send(
      await w.adapter.buildPublishRecipe({
        creator: ACCOUNTS.owner,
        recipe: {
          ...active,
          version: active.version + 1,
          components: next,
          metaHash: 'cd'.repeat(32),
        },
      }),
    );
    await w.later(61);
    const line = of(await round(w), w.vault);
    expect(line.reason).toContain(`adopted version ${active.version + 1}`);
    expect((await w.adapter.getVault(w.vault))?.acceptedVersion).toBe(active.version + 1);
    expect([...memory.reverted].some((k) => k.startsWith(`${w.vault} v${active.version} `))).toBe(
      false,
    );
  });
  it('forgets a leg the node refused at its preflight: nothing was sent, and the vault is free', async () => {
    const w = await start();
    await w.later(3_700);
    const plan = of(await round(w, { dryRun: true }), w.vault);
    const asset = /for (robinhood:[a-z]+)/.exec(plan.reason)?.[1];
    if (!asset) throw new Error(`no leg planned: ${plan.reason}`);
    // The price jumps 3% between the build and the relay: the relay's own preflight refuses the leg,
    // so it never reaches the node. The price goes back afterwards.
    const line = of(
      await round(w, {
        send: async (wire) => {
          await w.movePrice(asset, 300);
          try {
            await w.adapter.relay(wire);
          } finally {
            await w.movePrice(asset, -291);
          }
        },
      }),
      w.vault,
    );
    expect(line.reason).toContain('was refused before it was sent');
    expect(memory.inFlight.has(w.vault)).toBe(false);
    expect([...memory.reverted].some((k) => k.endsWith(`->${asset}`))).toBe(false);
  });

  it('pins the next leg to the nonce of a held leg the node never saw: that one lands, the first never can', async () => {
    const w = await start();
    await w.later(3_700);
    // The first leg is signed and remembered, and its bytes never reach the node.
    let dropped = '';
    const first = of(
      await round(w, {
        send: async (wire) => {
          dropped = wire;
        },
      }),
      w.vault,
    );
    expect(first.reason).toContain('is still pending');
    const held = memory.inFlight.get(w.vault);
    if (held?.nonce === undefined || !held.signer) throw new Error('no leg held on a nonce');
    const count = () =>
      w.client.getTransactionCount({ address: held.signer as `0x${string}`, blockTag: 'latest' });
    expect(await count()).toBe(held.nonce);
    const second = of(await round(w), w.vault);
    expect(second.reason).toContain(
      `leg ${held.txId} is not held by the node; the next leg takes its nonce ${held.nonce}`,
    );
    expect(second.outcome).toBe('acted');
    expect(memory.inFlight.has(w.vault)).toBe(false);
    // The second leg took the nonce: the first one's bytes, sent now, cannot land.
    expect(await count()).toBe(held.nonce + 1);
    await expect(w.sendRaw(dropped)).rejects.toThrow();
    expect(await count()).toBe(held.nonce + 1);
  });

  it('holds every leg while a dropped asset the vault still holds, at weight zero, cannot be valued', async () => {
    const w = await start();
    const { active } = await w.adapter.getRecipe(w.recipeA);
    const gone = id('tnvda');
    const freed = active.components.find((c) => c.kind === 'asset' && c.asset === gone)?.weightBps;
    if (!freed) throw new Error(`${gone} is not in the portfolio`);
    const half = Math.floor(freed / 2);
    const kept = active.components
      .filter((c) => !(c.kind === 'asset' && c.asset === gone))
      .map((c, i) =>
        c.kind === 'asset' ? { ...c, weightBps: c.weightBps + (i === 0 ? half : freed - half) } : c,
      );
    await w.send(
      await w.adapter.buildPublishRecipe({
        creator: ACCOUNTS.owner,
        recipe: {
          ...active,
          version: active.version + 1,
          components: kept,
          metaHash: 'ce'.repeat(32),
        },
      }),
    );
    await w.later(61);
    const adopted = of(await round(w, {}), w.vault);
    expect(adopted.reason).toContain(`adopted version ${active.version + 1}`);
    const ctx = await w.adapter.getKeeperContext(w.vault);
    const dropped = ctx?.positions.find((p) => p.asset === gone);
    // still one of the vault's targets(), at weight zero, and held
    expect([dropped?.target, dropped?.targetBps, dropped?.raw !== '0']).toEqual([true, 0, true]);
    // Its price jumps past what the average allows: it cannot be valued, so no leg can pass.
    await w.movePrice(gone, 300);
    try {
      const now = await w.adapter.getKeeperContext(w.vault);
      const reference = now?.positions.find((p) => p.asset === gone)?.reference;
      expect(reference).toBeTruthy();
      expect(now?.blocked).toBe(reference);
      const line = of(await round(w, { dryRun: true }), w.vault);
      expect(line.reason).toContain(`no leg would pass: ${reference}`);
      expect(line.txIds).toEqual([]);
    } finally {
      await w.movePrice(gone, -291);
    }
  });
});
