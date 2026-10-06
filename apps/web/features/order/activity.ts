import type { ExecutionStatus, LegStatus, OrderDetail } from '@colosseum/schemas';
import type { Execution } from '../../components/ui/ExecutionList';
import type { Dictionary } from '../../i18n';
import { assetName } from './amounts';
import { explorerUrlFor } from './readiness';

// What was done on chain, as his guide writes it (guidelines.html, "Disclaimer and activity"): one
// line per step that reached the chain, with what it was, where it stands, when, and its explorer link.
// Read from the order as the API last said it: a step with no transaction is not activity.

const STATUS: Partial<Record<LegStatus, ExecutionStatus>> = {
  built: 'built',
  sent: 'sent',
  confirmed: 'confirmed',
  failed: 'failed',
};

/** The steps of an order that have a transaction, newest first. */
export function activityOf(
  order: OrderDetail,
  t: Dictionary,
  explorer: string,
  /** The chain runs on the mock: its transactions link to the mock's own address. */
  mock: boolean,
): Execution[] {
  return order.legs
    .filter((leg) => leg.txId !== null && STATUS[leg.status] !== undefined)
    .map((leg) => {
      const attempts = order.attempts.filter((a) => a.legId === leg.id);
      const last = attempts.reduce<(typeof attempts)[number] | null>(
        (latest, a) => (latest === null || a.n > latest.n ? a : latest),
        null,
      );
      return {
        id: leg.id,
        verb: t.order.kind[leg.kind],
        detail: leg.trades
          .map((trade) => `${assetName(trade.sell)} → ${assetName(trade.buy)}`)
          .join(', '),
        status: STATUS[leg.status] as ExecutionStatus,
        error: leg.error?.message ?? null,
        at: last?.builtAt ?? order.createdAt,
        signature: leg.txId,
        explorerUrl: explorerUrlFor(leg.chain, leg.txId, mock),
        explorer,
        provenance: leg.provenance,
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}
