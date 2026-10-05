import type { KeeperContext, KeeperPosition } from '@colosseum/chain-solana/vault';
import type { AssetId, Trade } from '@colosseum/schemas';

// What the keeper decides before it spends a fee: whether a vault's records may be synced, whether a
// leg can be sent at all, and which planned trade goes first. Pure: the vault as the chain has it now
// (`getKeeperContext`) comes in, a decision comes out. The program still has the last word.

export type Skip = { skip: string; alert?: boolean };

/**
 * The sync policy. A leg values the positions it does not trade by what the program has recorded, so
 * records that differ from the accounts (a clawback, a gift, a token sent in) are synced before a leg,
 * and the builder refuses a leg until they are. But a sync records whatever is there, a stranger's dust
 * included, and once recorded, a position with no reference stops every leg in the vault. So the
 * keeper syncs only when every position whose record differs has a reference the program would take
 * now: priced, switched on, in its range, fresh. Otherwise it leaves the vault and raises an alert:
 * a person looks (the owner can withdraw or sell the dust; the admin can price or range the asset).
 */
export function syncDecision(ctx: KeeperContext): { sync: boolean } | Skip {
  const changed = ctx.positions.filter((p) => p.needsSync);
  if (changed.length === 0) return { sync: false };
  const unpriced = changed.filter((p) => p.reference !== null);
  if (unpriced.length)
    return {
      skip: `records differ for ${changed.map((p) => p.asset).join(', ')}, and ${unpriced
        .map((p) => `${p.asset} (${p.reference})`)
        .join(', ')} has no reference the program would take: not synced`,
      alert: true,
    };
  return { sync: true };
}

/** Why no leg can be sent in this vault now, by what the chain says; null when one may. */
export function legBlocked(ctx: KeeperContext): Skip | null {
  if (ctx.blocked)
    return { skip: `no leg would pass: ${ctx.blocked}`, alert: ctx.blocked !== 'AutoFollowOff' };
  if (!ctx.priceAccount)
    return { skip: 'its positions are not priced in one account', alert: true };
  // A leg that loses anything is held to the weekly cap; at the cap the program refuses it.
  if (ctx.vault.lossUsedBps >= ctx.rules.lossCapBps)
    return {
      skip: `the weekly loss cap is used (${ctx.vault.lossUsedBps} of ${ctx.rules.lossCapBps} bps)`,
    };
  return null;
}

/** The asset of a trade that is not the cash token. */
const assetOf = (t: Trade, cash: AssetId) => (t.sell === cash ? t.buy : t.sell);

/**
 * The first planned trade the program would let through now: sales come first in the plan, and a
 * trade in an asset switched off for the keeper, with no reference the program takes, under its
 * cooldown, outside its session, or in its multiplier window waits.
 * `skipped` says why each earlier one waits.
 */
export function nextTrade(
  trades: Trade[],
  ctx: KeeperContext,
  cash: AssetId,
  held: (t: Trade) => boolean,
): { trade: Trade | null; skipped: string[] } {
  const skipped: string[] = [];
  const byAsset = new Map<string, KeeperPosition>(ctx.positions.map((p) => [p.asset, p]));
  for (const t of trades) {
    const asset = assetOf(t, cash);
    const position = byAsset.get(asset);
    if (!position) {
      skipped.push(`${asset}: not a position of the vault`);
      continue;
    }
    // An asset the admin has not switched on for the keeper (gate UNIVERSE: no oracle, so the owner
    // trades it), or one the program would not value now: the program refuses the leg.
    if (!position.keeperOn) {
      skipped.push(`${asset}: off for the keeper, the owner trades it`);
      continue;
    }
    if (position.reference) {
      skipped.push(`${asset}: no reference the program would take (${position.reference})`);
      continue;
    }
    if (position.trade) {
      skipped.push(`${asset}: ${position.trade}`);
      continue;
    }
    if (!held(t)) {
      skipped.push(`${asset}: not sent again after it reverted`);
      continue;
    }
    return { trade: t, skipped };
  }
  return { trade: null, skipped };
}
