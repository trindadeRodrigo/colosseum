import type {
  ChainId,
  ExecutionStatus,
  LegStatus,
  LegWithdrawal,
  OrderDetail,
  PersonWithdrawal,
} from '@colosseum/schemas';
import type { Execution } from '../../components/ui/ExecutionList';
import type { Dictionary } from '../../i18n';
import { tokenName } from './amounts';
import { explorerUrlFor } from './readiness';
import { unitsFor } from './units';

// What was done on chain, as his guide writes it (guidelines.html, "Disclaimer and activity"): one
// line per step that reached the chain, with what it was, the chain it is on, where it stands, when, and
// its explorer link with the explorer's name.
// Read from the order as the API last said it: a step with no transaction is not activity.

const STATUS: Partial<Record<LegStatus, ExecutionStatus>> = {
  built: 'built',
  sent: 'sent',
  confirmed: 'confirmed',
  failed: 'failed',
};

/**
 * The tokens a withdrawal's step took out, by name: "USDC, tSPYx". The amounts are on the order and on
 * the vault, where each is shown as the portfolio shows it; a line has no room for a figure's source.
 */
function takenWords(taken: readonly LegWithdrawal[], chain: ChainId, mock: boolean): string {
  const tokens = unitsFor(chain, mock)?.tokens;
  return taken.map((w) => tokens?.[w.asset]?.symbol ?? tokenName(w.asset)).join(', ');
}

/**
 * The steps of the person's withdrawals that have a transaction, from the server's list
 * (`GET /v1/me/withdrawals`), newest first: a withdrawal placed on another device is a line here too.
 */
export function activityOfWithdrawals(
  withdrawals: readonly PersonWithdrawal[],
  t: Dictionary,
  mock: (chain: ChainId) => boolean,
): Execution[] {
  return withdrawals
    .flatMap((w) =>
      w.steps
        .filter((s) => s.txId !== null && STATUS[s.status] !== undefined)
        .map((s) => ({
          id: s.legId,
          verb: t.order.kind.withdraw,
          detail: takenWords(s.withdrawals, w.chain, mock(w.chain)),
          status: STATUS[s.status] as ExecutionStatus,
          error: null,
          at: s.at,
          signature: s.txId,
          explorerUrl: explorerUrlFor(w.chain, s.txId, mock(w.chain)),
          explorer: t.chain.explorers[w.chain],
          chain: w.chain,
          provenance: s.provenance,
        })),
    )
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** The steps of an order that have a transaction, newest first. */
export function activityOf(
  order: OrderDetail,
  t: Dictionary,
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
      // a token by the symbol this repository committed for it, as the review names it
      const tokens = unitsFor(leg.chain, mock)?.tokens;
      const name = (asset: string) => tokens?.[asset]?.symbol ?? tokenName(asset);
      return {
        id: leg.id,
        verb: t.order.kind[leg.kind],
        detail:
          leg.kind === 'withdraw'
            ? takenWords(leg.withdrawals ?? [], leg.chain, mock)
            : leg.trades.map((trade) => `${name(trade.sell)} → ${name(trade.buy)}`).join(', '),
        status: STATUS[leg.status] as ExecutionStatus,
        error: leg.error?.message ?? null,
        at: last?.builtAt ?? order.createdAt,
        signature: leg.txId,
        explorerUrl: explorerUrlFor(leg.chain, leg.txId, mock),
        explorer: t.chain.explorers[leg.chain],
        chain: leg.chain,
        provenance: leg.provenance,
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}
