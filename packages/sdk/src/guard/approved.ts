import type { Leg, Order } from '@colosseum/schemas';
import { familyOf, isRawAmount } from './context';
import { GuardRefusal } from './refusal';
import type { ApprovedStep, ApprovedTrade, GuardDeployment, PlanTerms, Withdrawal } from './types';

// The order as the person approved it, turned into what each of its steps may sign. It is worked out
// once, from the order the review screen showed, and never again from what a server says later.
//
// The order says what cash it moves (`Order.depositRaw`, repeated as `Leg.cashRaw` on the approval and
// on the step that deposits) and what each step trades. It does not yet say everything else a step
// does: it has no plan number, no targets and no version. Those come in as `PlanTerms`, from what the
// screen showed beside the order.

const refuse = (message: string, legId?: string) =>
  new GuardRefusal('order', message, legId ?? null);

/**
 * One approved step per leg, in the order they are signed. Throws a `GuardRefusal` with code `order`
 * when the order cannot mean what it says, and `unsupported` for a step this guard signs none of.
 */
export function approvedSteps(
  order: Pick<Order, 'id' | 'owner' | 'legs' | 'depositRaw'>,
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
  if (new Set(legs.map((l) => l.id)).size !== legs.length)
    throw refuse('two steps of the order have the same id');

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

  // The cash a step is about is the step's own figure, and where the order states a deposit it is that
  // one: the approval and the step that deposits both repeat it, and neither may say more.
  const { depositRaw } = order;
  if (depositRaw !== undefined && !isRawAmount(depositRaw))
    throw refuse('the deposit the order states is not raw units');
  const cashOf = (leg: Leg): string | null => {
    const cash = leg.cashRaw;
    if (cash === undefined) return null;
    if (!isRawAmount(cash)) throw refuse('the cash a step states is not raw units', leg.id);
    if (depositRaw !== undefined && cash !== depositRaw)
      throw refuse(`a step is about ${cash} of cash, and the order deposits ${depositRaw}`, leg.id);
    return cash;
  };
  const funded = (leg: Leg): string => {
    const cash = cashOf(leg);
    if (cash === null || cash === '0')
      throw refuse('the step does not say how much cash it is about', leg.id);
    return cash;
  };
  for (const leg of legs)
    for (const t of leg.trades)
      if (!isRawAmount(t.amountInRaw)) throw refuse('a trade has no amount', leg.id);

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
        // A plan that is all cash has no target: an empty list, said out loud, and never a missing one.
        if (!plan.follow && !plan.targets)
          throw refuse(
            'nothing says what the vault holds: no targets and nothing followed',
            leg.id,
          );
        return {
          ...base,
          kind: 'create_vault',
          targets: plan.follow ? [] : (plan.targets ?? []),
          follow: plan.follow ?? null,
          autoFollow: plan.autoFollow ?? false,
          depositRaw: cashOf(leg) ?? '0',
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
