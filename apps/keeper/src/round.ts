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
import { type KeeperMemory, newMemory } from './memory';
import { legBlocked, nextTrade, syncDecision } from './policy';

export { type KeeperMemory, newMemory } from './memory';

// One round of the keeper on one chain (DESIGN-VAULT 3.5, section 10): every vault with auto-follow on,
// in random order, planned from the chain as it is now. A vault gets at most one transaction of each
// kind a round: an adoption of a version that adds no asset, a sync of its records, and one leg. Each
// is built, simulated by the builder, signed by the keeper, sent, and tracked until the chain settles
// it. A leg, once handed to the node, is remembered with its signature until its fate is known, and
// nothing more is planned for its vault until then; a leg that reverted is never sent again.

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
  /** Signs a built transaction with the keeper's key: the signed bytes and the transaction's id. */
  sign(tx: BuiltTx): Promise<{ wire: string; txId: string }>;
  /** Sends signed bytes. Default: the adapter's relay, with the node's preflight. */
  send?: (signed: string, tx: BuiltTx) => Promise<unknown>;
  /** Called whenever the memory changes, before anything is sent on the strength of it. */
  save?: (memory: KeeperMemory) => void | Promise<void>;
  /** Builds and plans, and sends nothing. */
  dryRun?: boolean;
  /** No trade worth less than this many dollars. */
  minTradeUsd?: number;
  /** How long to wait for one transaction to settle, in ms. */
  settleMs?: number;
  /** The order vaults are visited in; random by default, so no vault always goes last. */
  shuffle?: <T>(items: T[]) => T[];
  log?: (line: VaultLine) => void;
};

const shuffled = <T>(items: T[]): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const codeOf = (e: unknown) =>
  e instanceof ChainError ? e.code : e instanceof Error ? e.message : String(e);

export async function runRound(
  o: KeeperOptions,
  memory: KeeperMemory = newMemory(),
): Promise<VaultLine[]> {
  const { adapter } = o;
  const log = o.log ?? (() => {});
  const send = o.send ?? ((signed: string) => adapter.relay(signed));
  const save = async () => {
    await o.save?.(memory);
  };
  const settleMs = o.settleMs ?? 90_000;
  const assets = await adapter.listAssets();
  const cash = assets.find((a) => a.cls === 'cash')?.id as AssetId;
  const priced = new Set<string>(assets.filter((a) => a.priceKind !== 'none').map((a) => a.id));
  const vaults = (o.shuffle ?? shuffled)(await adapter.listAutoFollowVaults());
  const lines: VaultLine[] = [];

  /** Polls a sent transaction until the chain settles it or the wait is over. */
  async function settle(txId: string, validUntil: string): Promise<TxStatus> {
    const until = Date.now() + settleMs;
    for (;;) {
      const status = await adapter.track(txId, validUntil);
      if (status.status !== 'pending' || Date.now() >= until) return status;
      await sleep(1_500);
    }
  }

  /** Signs, sends and waits: an adoption or a sync, which the next round plans again from the chain. */
  async function land(tx: BuiltTx): Promise<{ txId: string; status: TxStatus }> {
    const signed = await o.sign(tx);
    await send(signed.wire, tx);
    return {
      txId: signed.txId,
      status: await settle(signed.txId, String(tx.lastValidBlockHeight)),
    };
  }

  /**
   * The fate of the leg sent earlier for this vault, if there is one. A leg that landed or expired
   * frees the vault, one that reverted joins the reverted set, one that is still open holds the vault.
   */
  async function earlier(vault: string): Promise<{ hold: string | null; note: string | null }> {
    const sent = memory.inFlight.get(vault);
    if (!sent) return { hold: null, note: null };
    let status: TxStatus;
    try {
      status = await adapter.track(sent.txId, sent.validUntil);
    } catch (e) {
      return { hold: `the fate of leg ${sent.txId} could not be read (${codeOf(e)})`, note: null };
    }
    if (status.status === 'pending')
      return { hold: `leg ${sent.txId} is not settled yet`, note: null };
    if (status.status === 'reverted') memory.reverted.add(sent.key);
    memory.inFlight.delete(vault);
    await save();
    return {
      hold: null,
      note:
        status.status === 'reverted'
          ? `leg ${sent.txId} reverted: ${status.error?.code ?? ''}; it is not sent again`
          : `leg ${sent.txId} ${status.status}`,
    };
  }

  for (const vault of vaults) {
    const txIds: string[] = [];
    const did: string[] = [];
    let synced = false;
    let alert = false;
    let budget = '';
    const line = (outcome: Outcome, reason: string, raise = false) => {
      const l: VaultLine = {
        vault,
        outcome,
        reason: [...did, reason].join('; ') + budget,
        txIds,
        alert: alert || raise,
      };
      lines.push(l);
      log(l);
    };
    /** Nothing more for the vault this round: what was done before says what the line is. */
    const stop = (reason: string, raise = false) =>
      line(synced ? 'synced' : did.length ? 'adopted' : 'skipped', reason, raise);

    try {
      const before = await earlier(vault);
      if (before.hold) {
        stop(before.hold, true);
        continue;
      }
      if (before.note) {
        did.push(before.note);
        alert ||= before.note.includes('reverted');
      }

      let ctx = await adapter.getKeeperContext(vault);
      if (!ctx) {
        stop('the vault is gone');
        continue;
      }
      // Past half the loss budget, every line for the vault is an alert.
      if (ctx.rules.lossCapBps > 0 && ctx.vault.lossUsedBps * 2 >= ctx.rules.lossCapBps) {
        alert = true;
        budget = ` (loss budget: ${ctx.vault.lossUsedBps} of ${ctx.rules.lossCapBps} bps used)`;
      }

      // 1. A version that waits for the vault and adds no asset is adopted, once the cluster's clock
      // has reached its time; one that adds an asset waits for the owner. Not while the keeper is
      // paused: the program refuses it then.
      const pending = ctx.vault.pending;
      if (pending && pending.effectiveAt <= ctx.clock) {
        if (pending.newAssets.length) {
          stop(
            `version ${pending.version} adds ${pending.newAssets.join(', ')}: the owner accepts it`,
          );
          continue;
        }
        if (ctx.rules.paused) {
          stop('the keeper is paused', true);
          continue;
        }
        const adopt = await adapter.buildAdoptVersion(vault);
        if (o.dryRun) {
          line('would-act', `would adopt version ${pending.version}`);
          continue;
        }
        const adopted = await land(adopt);
        txIds.push(adopted.txId);
        if (adopted.status.status !== 'confirmed') {
          stop(
            `the adoption of version ${pending.version} ${adopted.status.status}: ${adopted.status.error?.code ?? ''}`,
            true,
          );
          continue;
        }
        did.push(`adopted version ${pending.version}`);
        ctx = (await adapter.getKeeperContext(vault)) as KeeperContext;
      }

      // 2. Records that differ from the accounts are synced, if the policy lets it.
      const sync = syncDecision(ctx);
      if ('skip' in sync) {
        stop(sync.skip, sync.alert);
        continue;
      }
      if (sync.sync) {
        if (o.dryRun) {
          line('would-act', 'would sync its records');
          continue;
        }
        const done = await land(await adapter.buildSyncBalances(vault));
        txIds.push(done.txId);
        if (done.status.status !== 'confirmed') {
          stop(`the sync ${done.status.status}`, true);
          continue;
        }
        did.push('synced its records');
        synced = true;
        ctx = (await adapter.getKeeperContext(vault)) as KeeperContext;
      }

      // 3. One leg toward the targets, if the program would take one now.
      const blocked = legBlocked(ctx);
      if (blocked) {
        stop(blocked.skip, blocked.alert);
        continue;
      }
      const targets: Target[] = ctx.vault.positions
        .filter((p) => p.targetBps > 0)
        .map((p) => ({ asset: p.asset, weightBps: p.targetBps }));
      // The prices of this vault's own holdings only: an asset another vault holds cannot stop it.
      const mine = [cash, ...ctx.positions.map((p) => p.asset)].filter((a) => priced.has(a));
      const prices = await adapter.getPrices([...new Set(mine)]);
      const plan = rebalancePlan(
        ctx.vault,
        targets,
        prices,
        { bandBps: ctx.rules.bandBps, minTradeUsd: o.minTradeUsd ?? 1 },
        assets,
      );
      if (!plan.weighed) {
        stop(`it cannot be weighed: no price for ${plan.unpriced.join(', ')}`, true);
        continue;
      }
      if (plan.trades.length === 0) {
        stop('every position is inside the band');
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
        stop(`no trade can go now: ${skipped.join('; ')}`);
        continue;
      }
      let leg: BuiltTx;
      try {
        leg = await adapter.buildKeeperLeg(vault, trade);
      } catch (e) {
        // The builder simulated it and the program would refuse it: no fee is spent.
        if (!(e instanceof ChainError)) throw e;
        stop(`the leg ${trade.sell} -> ${trade.buy} would be refused: ${e.code}`, !e.retryable);
        continue;
      }
      if (o.dryRun) {
        line('would-act', `would sell ${trade.amountInRaw} raw ${trade.sell} for ${trade.buy}`);
        continue;
      }

      // From here the leg may land whatever the node answers: it is remembered before it is sent,
      // and only its fate on the chain takes it out of memory.
      const signed = await o.sign(leg);
      const validUntil = String(leg.lastValidBlockHeight);
      memory.inFlight.set(vault, {
        vault,
        key: key(trade),
        txId: signed.txId,
        validUntil,
        sentAt: new Date().toISOString(),
      });
      await save();
      txIds.push(signed.txId);
      let status: TxStatus;
      try {
        await send(signed.wire, leg);
        status = await settle(signed.txId, validUntil);
      } catch (e) {
        stop(
          `the leg ${trade.sell} -> ${trade.buy} was sent and no answer settled it (${codeOf(e)}); its fate is read before the vault is planned again`,
          true,
        );
        continue;
      }
      if (status.status === 'pending') {
        stop(
          `the leg ${trade.sell} -> ${trade.buy} is still pending; its fate is read before the vault is planned again`,
        );
        continue;
      }
      memory.inFlight.delete(vault);
      if (status.status === 'reverted') memory.reverted.add(key(trade));
      await save();
      if (status.status === 'reverted') {
        stop(
          `the leg ${trade.sell} -> ${trade.buy} reverted: ${status.error?.code}; it is not sent again`,
          true,
        );
        continue;
      }
      if (status.status !== 'confirmed') {
        stop(`the leg ${status.status} without landing; the next round plans again`);
        continue;
      }
      line('acted', `sold ${trade.amountInRaw} raw ${trade.sell} for ${trade.buy}`);
    } catch (e) {
      stop(`failed: ${codeOf(e)}`, true);
    }
  }
  return lines;
}
