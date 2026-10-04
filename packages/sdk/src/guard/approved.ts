import type { Leg, Order } from '@colosseum/schemas';
import { familyOf, isRawAmount } from './context';
import { GuardRefusal } from './refusal';
import type { ApprovedStep, ApprovedTrade, GuardDeployment, PlanTerms, Withdrawal } from './types';

// The order as the person approved it, turned into what each of its steps may sign. It is worked out
// once, from the order the review screen showed, and never again from what a server says later.
//
// The order type does not yet say everything a step does: it has no plan number, no targets, no
// version, and no amount on a step that trades nothing. Those come in as `PlanTerms`, from what the
// screen showed beside the order. The cash a buy moves is read back from its trades, as the server
// reads it: the trades of a buy add up to exactly the cash it deposits.

const refuse = (message: string, legId?: string) =>
  new GuardRefusal('order', message, legId ?? null);

/**
 * One approved step per leg, in the order they are signed. Throws a `GuardRefusal` with code `order`
 * when the order cannot mean what it says, and `unsupported` for a step this guard signs none of.
 */
export function approvedSteps(
  order: Pick<Order, 'id' | 'owner' | 'legs'>,
  plan: PlanTerms,
  deployment: GuardDeployment,
): ApprovedStep[] {
  const chain = deployment.chain;
  const owner = order.owner[familyOf(chain)];
  if (!owner) throw refuse(`the order's owner has no address on ${chain}`);
  if (!order.legs.length) throw refuse('the order has no steps');
  const legs = [...order.legs].sort((a, b) => a.seq - b.seq);
  if (new Set(legs.map((l) => l.seq)).size !== legs.length)
    throw refuse('two steps of the order have the same place');

  const tradesOf = (leg: Leg): ApprovedTrade[] => {
    if (leg.expected.length !== leg.trades.length)
      throw refuse('a trade was shown with no minimum, so it has none to be held to', leg.id);
    return leg.trades.map((t, i) => ({
      sell: t.sell,
      buy: t.buy,
      inRaw: t.amountInRaw,
      minOutRaw: (leg.expected[i] as Leg['expected'][number]).minOutRaw,
    }));
  };

  for (const leg of legs) {
    // One chain per plan (gate ONE-CHAIN): every step of an order is on it.
    if (leg.chain !== chain)
      throw refuse(`a step is on ${leg.chain}, and this order is on ${chain}`, leg.id);
    if (leg.orderId !== order.id) throw refuse('a step belongs to another order', leg.id);
    if (leg.signer !== 'owner')
      throw new GuardRefusal('unsupported', 'a step the keeper signs is never signed here', leg.id);
  }

  // What a buy deposits is the sum of what its trades sell, and every one of them sells cash.
  const moves = legs.some((l) => ['approve', 'create_vault', 'deposit'].includes(l.kind));
  const all = legs.flatMap((l) => l.trades);
  if (moves && all.some((t) => t.sell !== deployment.cash))
    throw refuse('an order that deposits cash has a trade that sells something else');
  if (all.some((t) => !isRawAmount(t.amountInRaw))) throw refuse('a trade has no amount');
  const cashRaw = all.reduce((sum, t) => sum + BigInt(t.amountInRaw), 0n).toString();
  const funded = (leg: Leg) => {
    if (cashRaw === '0') throw refuse('the order does not say how much cash it moves', leg.id);
    return cashRaw;
  };

  const withdrawLegs = legs.filter((l) => l.kind === 'withdraw');
  const withdrawalsOf = (leg: Leg): Withdrawal[] | 'all' => {
    const listed = plan.withdrawals;
    if (!listed) return 'all';
    if (withdrawLegs.length === 1) return listed;
    if (listed.length !== withdrawLegs.length)
      throw refuse('the withdrawals named are not one per step', leg.id);
    return [listed[withdrawLegs.indexOf(leg)] as Withdrawal];
  };

  return legs.map((leg): ApprovedStep => {
    const base = { legId: leg.id, chain, owner, basketId: plan.basketId };
    switch (leg.kind) {
      case 'approve':
        return { ...base, kind: 'approve', amountRaw: funded(leg) };
      case 'create_vault': {
        if (!plan.follow && !plan.targets?.length)
          throw refuse('the plan has no targets and follows nothing', leg.id);
        return {
          ...base,
          kind: 'create_vault',
          targets: plan.follow ? [] : (plan.targets ?? []),
          follow: plan.follow ?? null,
          autoFollow: plan.autoFollow ?? false,
          depositRaw: cashRaw,
          trades: tradesOf(leg),
        };
      }
      case 'deposit':
        return { ...base, kind: 'deposit', amountRaw: funded(leg), trades: tradesOf(leg) };
      case 'swap':
        return { ...base, kind: 'swap', trades: tradesOf(leg) };
      case 'set_targets':
        if (!plan.targets?.length)
          throw refuse('the step sets targets, and none were given', leg.id);
        return { ...base, kind: 'set_targets', targets: plan.targets };
      case 'accept_version':
        if (!plan.follow) throw refuse('the step accepts a version, and none was given', leg.id);
        return { ...base, kind: 'accept_version', follow: plan.follow };
      case 'set_auto_follow':
        if (plan.autoFollow === undefined)
          throw refuse('the step switches auto-follow, and nothing says which way', leg.id);
        return { ...base, kind: 'set_auto_follow', on: plan.autoFollow };
      case 'withdraw':
        return { ...base, kind: 'withdraw', withdrawals: withdrawalsOf(leg) };
      default:
        throw new GuardRefusal('unsupported', `this guard signs no ${leg.kind} step`, leg.id);
    }
  });
}
