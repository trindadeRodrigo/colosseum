import { rebalancePlan } from '@colosseum/basket';
import type { KeeperContext, SolanaVaultAdapter } from '@colosseum/chain-solana/vault';
import {
  type AssetId,
  type BuiltTx,
  ChainError,
  type Target,
  type Trade,
  type TxStatus,
} from '@colosseum/schemas';
import { legBlocked, nextTrade, syncDecision } from './policy';

// One round of the keeper on one chain (DESIGN-VAULT 3.5, section 10): every vault with auto-follow on,
// in random order, planned from the chain as it is now. A vault gets at most one transaction of each
// kind a round: an adoption of a version that adds no asset, a sync of its records, and one leg. Each
// is built, simulated by the builder, signed by the keeper, sent, and tracked until the chain settles
// it. A leg that reverted is never sent again in this process: the next one waits for a person.

export type Outcome = 'acted' | 'adopted' | 'synced' | 'skipped' | 'would-act';

/** One line per vault per round: what the keeper did, or why it did nothing. */
export type VaultLine = {
  vault: string;
  outcome: Outcome;
  reason: string;
  /** The transactions this round sent for the vault, in order. */
  txIds: string[];
  /** Something a person should look at. */
  alert: boolean;
};

export type KeeperOptions = {
  adapter: SolanaVaultAdapter;
  /** Signs a built transaction with the keeper's key and hands back the signed bytes. */
  sign(tx: BuiltTx): Promise<string>;
  /** Sends signed bytes. Default: the adapter's relay, with the node's preflight. */
  send?: (signed: string, tx: BuiltTx) => Promise<{ txId: string }>;
  /** Builds and plans, and sends nothing. */
  dryRun?: boolean;
  /** No trade worth less than this many dollars. */
  minTradeUsd?: number;
  /** How long to wait for one transaction to settle, in ms. */
  settleMs?: number;
  /** The order vaults are visited in; random by default, so no vault always goes last. */
  shuffle?: <T>(items: T[]) => T[];
  log?: (line: VaultLine) => void;
  now?: () => Date;
};

/** What the keeper remembers between rounds of one process. */
export type KeeperMemory = {
  /** `vault sell->buy` of a leg that reverted: not sent again. */
  reverted: Set<string>;
};

export const newMemory = (): KeeperMemory => ({ reverted: new Set() });

const shuffled = <T>(items: T[]): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runRound(
  o: KeeperOptions,
  memory: KeeperMemory = newMemory(),
): Promise<VaultLine[]> {
  const { adapter } = o;
  const log = o.log ?? (() => {});
  const send = o.send ?? ((signed: string) => adapter.relay(signed));
  const settleMs = o.settleMs ?? 90_000;
  const now = o.now ?? (() => new Date());
  const assets = await adapter.listAssets();
  const cash = assets.find((a) => a.cls === 'cash')?.id as AssetId;
  const vaults = (o.shuffle ?? shuffled)(await adapter.listAutoFollowVaults());
  const lines: VaultLine[] = [];

  /** Signs, sends and waits for the chain to settle it. */
  async function land(tx: BuiltTx): Promise<{ txId: string; status: TxStatus }> {
    const signed = await o.sign(tx);
    const { txId } = await send(signed, tx);
    const until = Date.now() + settleMs;
    for (;;) {
      const status = await adapter.track(txId, String(tx.lastValidBlockHeight));
      if (status.status !== 'pending' || Date.now() >= until) return { txId, status };
      await sleep(1_500);
    }
  }

  const line = (
    vault: string,
    outcome: Outcome,
    reason: string,
    txIds: string[],
    alert = false,
  ) => {
    const l: VaultLine = { vault, outcome, reason, txIds, alert };
    lines.push(l);
    log(l);
    return l;
  };

  for (const vault of vaults) {
    const txIds: string[] = [];
    try {
      let ctx = await adapter.getKeeperContext(vault);
      if (!ctx) {
        line(vault, 'skipped', 'the vault is gone', txIds);
        continue;
      }

      // 1. A version that waits for the vault and adds no asset is adopted; one that adds an asset waits
      // for the owner. Not while the keeper is paused: the program refuses it then.
      const pending = ctx.vault.pending;
      if (pending && pending.effectiveAt * 1000 <= now().getTime()) {
        if (pending.newAssets.length) {
          line(
            vault,
            'skipped',
            `version ${pending.version} adds ${pending.newAssets.join(', ')}: the owner accepts it`,
            txIds,
          );
          continue;
        }
        if (ctx.rules.paused) {
          line(vault, 'skipped', 'the keeper is paused', txIds, true);
          continue;
        }
        const adopt = await adapter.buildAdoptVersion(vault);
        if (o.dryRun) {
          line(vault, 'would-act', `would adopt version ${pending.version}`, txIds);
          continue;
        }
        const adopted = await land(adopt);
        txIds.push(adopted.txId);
        if (adopted.status.status !== 'confirmed') {
          line(
            vault,
            'skipped',
            `the adoption of version ${pending.version} ${adopted.status.status}: ${adopted.status.error?.code ?? ''}`,
            txIds,
            true,
          );
          continue;
        }
        ctx = (await adapter.getKeeperContext(vault)) as KeeperContext;
      }

      // 2. Records that differ from the accounts are synced, if the policy lets it.
      const sync = syncDecision(ctx);
      if ('skip' in sync) {
        line(vault, 'skipped', sync.skip, txIds, sync.alert);
        continue;
      }
      if (sync.sync) {
        if (o.dryRun) {
          line(vault, 'would-act', 'would sync its records', txIds);
          continue;
        }
        const synced = await land(await adapter.buildSyncBalances(vault));
        txIds.push(synced.txId);
        if (synced.status.status !== 'confirmed') {
          line(vault, 'skipped', `the sync ${synced.status.status}`, txIds, true);
          continue;
        }
        ctx = (await adapter.getKeeperContext(vault)) as KeeperContext;
      }

      // 3. One leg toward the targets, if the program would take one now.
      const blocked = legBlocked(ctx);
      if (blocked) {
        line(vault, txIds.length ? 'adopted' : 'skipped', blocked.skip, txIds, blocked.alert);
        continue;
      }
      const targets: Target[] = ctx.vault.positions
        .filter((p) => p.targetBps > 0)
        .map((p) => ({ asset: p.asset, weightBps: p.targetBps }));
      const priced = assets.filter((a) => a.priceKind !== 'none').map((a) => a.id);
      const prices = await adapter.getPrices(priced);
      const plan = rebalancePlan(
        ctx.vault,
        targets,
        prices,
        { bandBps: ctx.rules.bandBps, minTradeUsd: o.minTradeUsd ?? 1 },
        assets,
      );
      if (!plan.weighed) {
        line(
          vault,
          'skipped',
          `it cannot be weighed: no price for ${plan.unpriced.join(', ')}`,
          txIds,
          true,
        );
        continue;
      }
      if (plan.trades.length === 0) {
        line(
          vault,
          txIds.length ? 'adopted' : 'skipped',
          'every position is inside the band',
          txIds,
        );
        continue;
      }
      const key = (t: Trade) => `${vault} ${t.sell}->${t.buy}`;
      const { trade, skipped } = nextTrade(
        plan.trades,
        ctx,
        cash,
        (t) => !memory.reverted.has(key(t)),
      );
      if (!trade) {
        line(
          vault,
          txIds.length ? 'adopted' : 'skipped',
          `no trade can go now: ${skipped.join('; ')}`,
          txIds,
        );
        continue;
      }
      let leg: BuiltTx;
      try {
        leg = await adapter.buildKeeperLeg(vault, trade);
      } catch (e) {
        // The builder simulated it and the program would refuse it: no fee is spent.
        if (!(e instanceof ChainError)) throw e;
        line(
          vault,
          'skipped',
          `the leg ${trade.sell} -> ${trade.buy} would be refused: ${e.code}`,
          txIds,
          !e.retryable,
        );
        continue;
      }
      if (o.dryRun) {
        line(
          vault,
          'would-act',
          `would sell ${trade.amountInRaw} raw ${trade.sell} for ${trade.buy}`,
          txIds,
        );
        continue;
      }
      let sent: { txId: string; status: TxStatus };
      try {
        sent = await land(leg);
      } catch (e) {
        // Refused before it landed (the node's preflight): nothing was spent, and the next round plans
        // again from the chain.
        if (!(e instanceof ChainError)) throw e;
        line(vault, 'skipped', `the leg was not taken: ${e.code}`, txIds, !e.retryable);
        continue;
      }
      txIds.push(sent.txId);
      if (sent.status.status === 'reverted') {
        memory.reverted.add(key(trade));
        line(
          vault,
          'skipped',
          `the leg ${trade.sell} -> ${trade.buy} reverted: ${sent.status.error?.code}; it is not sent again`,
          txIds,
          true,
        );
        continue;
      }
      if (sent.status.status !== 'confirmed') {
        line(
          vault,
          'skipped',
          `the leg is ${sent.status.status}; the next round plans again`,
          txIds,
        );
        continue;
      }
      line(vault, 'acted', `sold ${trade.amountInRaw} raw ${trade.sell} for ${trade.buy}`, txIds);
    } catch (e) {
      line(vault, 'skipped', `failed: ${e instanceof Error ? e.message : String(e)}`, txIds, true);
    }
  }
  return lines;
}
