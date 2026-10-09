import type { Leg, OrderDetail } from '@colosseum/schemas';
import type { Dictionary } from '../../i18n';
import { tokenName } from './amounts';
import { legsInOrder } from './order-view';
import type { ChainUnits } from './units';

// What one press of "Invest" says while its steps run and when they stop (gate INVEST-ONE-PRESS): the
// step that is under way with the one before it ("Deposit confirmed · Buying jlUSDC · 2 of 4"), and,
// when the sequence stops, what landed and what did not, in one sentence. Pure: every word is worked
// out from the order as the person approved it and from where the API says each step stands.

/** What a host of the invest card is told as the steps run. */
export type InvestProgress = {
  orderId: string;
  /** The step under way, from 1; 0 before the first. */
  step: number;
  of: number;
  /** The line the card shows. */
  line: string;
};

type Words = Dictionary['invest'];

/** The tokens a step buys, by the names this repository committed for them. */
const bought = (leg: Leg, units: ChainUnits | null): string[] =>
  leg.trades.map((trade) => units?.tokens[trade.buy]?.symbol ?? tokenName(trade.buy));

const listOf = (names: readonly string[], locale: string) =>
  new Intl.ListFormat(locale, { type: 'conjunction' }).format(names);

/** A step under way, and the same step once it is confirmed. */
function stepWords(
  leg: Leg,
  units: ChainUnits | null,
  t: Dictionary,
  locale: string,
): { doing: string; did: string } {
  const w = t.invest.progress;
  const names = bought(leg, units);
  const deposits = leg.kind === 'create_vault' || leg.kind === 'deposit';
  if (deposits && names.length > 0)
    return {
      doing: w.depositingAndBuying(listOf(names, locale)),
      did: w.depositedAndBought(listOf(names, locale)),
    };
  if (deposits) return { doing: w.depositing, did: w.deposited };
  if (leg.kind === 'approve') return { doing: w.approving, did: w.approved };
  if (names.length > 0)
    return { doing: w.buying(listOf(names, locale)), did: w.bought(listOf(names, locale)) };
  return { doing: t.order.kind[leg.kind], did: w.confirmed(t.order.kind[leg.kind]) };
}

/**
 * The line shown while the steps run: the step before, confirmed, then the one under way and its
 * place in the sequence. `legId` is the step the runner is on.
 */
export function progressOf(
  shown: Pick<OrderDetail, 'id' | 'legs'>,
  legId: string,
  units: ChainUnits | null,
  t: Dictionary,
  locale: string,
): InvestProgress {
  const legs = legsInOrder(shown);
  const at = Math.max(
    0,
    legs.findIndex((l) => l.id === legId),
  );
  const current = legs[at];
  const before = at > 0 ? legs[at - 1] : undefined;
  const doing = current ? stepWords(current, units, t, locale).doing : '';
  const did = before ? stepWords(before, units, t, locale).did : null;
  return {
    orderId: shown.id,
    step: at + 1,
    of: legs.length,
    line: t.invest.progress.line(did, doing, at + 1, legs.length),
  };
}

/** What a step is, as a thing that landed or did not: "the deposit", "jlUSDC". */
function nouns(leg: Leg, units: ChainUnits | null, w: Words): string[] {
  const names = bought(leg, units);
  if (leg.kind === 'create_vault' || leg.kind === 'deposit') return [w.things.deposit, ...names];
  if (leg.kind === 'approve') return [w.things.approval];
  return names.length > 0 ? names : [w.things.step];
}

/**
 * When the sequence stops short: what landed and what did not, in one sentence. A step counts as
 * landed only when the API says it is confirmed; one that was sent and is not confirmed is among
 * what did not land, since nobody can say yet that it did.
 */
export function landedSentence(
  shown: Pick<OrderDetail, 'legs'>,
  now: Pick<OrderDetail, 'legs'>,
  units: ChainUnits | null,
  t: Dictionary,
  locale: string,
): string {
  const standing = new Map(now.legs.map((l) => [l.id, l.status]));
  const landed: string[] = [];
  const not: string[] = [];
  for (const leg of legsInOrder(shown))
    (standing.get(leg.id) === 'confirmed' ? landed : not).push(...nouns(leg, units, t.invest));
  const w = t.invest.stopped;
  if (landed.length === 0) return w.nothing;
  if (not.length === 0) return w.all(listOf(landed, locale));
  return w.some(listOf(landed, locale), listOf(not, locale));
}

/** What the invest card's host passes the order's own screen when it is drawn inside the card. */
export type OrderEmbed = {
  /** Why the press is not offered yet (the trust notice is not ticked): said under the button. */
  blocked: readonly string[];
  /** Called as the person presses, before anything is asked of the wallet. */
  onApprove: () => void;
  /**
   * Called once the run has begun (the executor is on a step, or has answered for the order): the
   * acceptance of the trust notice is kept here, never for a press that could not start.
   */
  onStarted: () => void;
  /** Start again with a new order, in the same card. */
  onAgain: () => void;
  onProgress?: (progress: InvestProgress) => void;
  onDone?: (done: { orderId: string }) => void;
  onStopped?: (stopped: { orderId: string }) => void;
  /**
   * The host says where to go once every step is confirmed (the vault's own page, from /goal): the
   * order's screen then draws no link of its own under the steps.
   */
  hostEnds?: boolean;
  /**
   * The order that finishes this one was made, or is already in this browser: the host shows it in the
   * same card, where it is reviewed and signed. Left out, the order's own page is opened.
   */
  onFinish?: (orderId: string) => void;
};
