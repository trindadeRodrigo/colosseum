import { randomUUID } from 'node:crypto';
import { chainFamily, DISCLAIMER, type Leg, type Order } from '@colosseum/schemas';
import { assertBuilds, type ChainRegistry } from './chains';
import { Refusal, refusing } from './errors';
import { expectedOf, ORDER_POLICY, type Prepared, slippageOf } from './prepare';
import type { StoredOrder } from './store';

// Finishing a buy with the cash already in the vault. A buy on a chain that trades after the deposit
// (Solana: the vault is opened with the cash, then one swap per asset) can stop between the two: the
// deposit has landed and a swap was not signed, or could not be built any more at the terms the order
// stated (`PriceMoved`). The cash is the person's, in their vault, and nothing is lost; but the order's
// terms are never changed after it is made, so its swaps cannot be made again at another price.
//
// The continuation is a new order: the swaps the first one left, with the same amounts, quoted now and
// stating new minimums for the person to review and approve. It deposits nothing and opens nothing.
// It spends only cash the vault holds, and is refused when the vault holds less than its steps spend.

const done = (leg: Leg) => leg.status === 'confirmed' || leg.status === 'skipped';

/** The swaps an order left undone, in their order: what a continuation of it would make. */
export function leftOf(order: Order): Leg[] {
  return order.legs
    .filter((leg) => leg.kind === 'swap' && !done(leg))
    .sort((a, b) => a.seq - b.seq);
}

/**
 * The order that finishes `stored`: its unfinished swaps as a new order of the same owner for the same
 * vault, with what each trade pays quoted now. Refuses an order that is not a buy, one whose cash is
 * not in the vault yet, one with nothing left, and a vault that holds less cash than the steps left
 * would spend. The caller first makes sure no transaction built for a step left can still land
 * (`assertNoneInFlight` in legs.ts). Nothing is stored here.
 */
export async function continueBuy(
  stored: StoredOrder,
  ctx: { chains: ChainRegistry; now: string },
): Promise<Prepared> {
  const { order, request } = stored;
  if (order.type !== 'buy' || request.type !== 'buy')
    throw new Refusal(409, 'only a buy is finished with the cash in its vault', {
      code: 'CONTINUE_NOT_SUPPORTED',
    });
  const first = order.legs[0]?.chain;
  if (first && chainFamily(first) === 'evm') {
    const entry = ctx.chains.get(first);
    // Where a buy trades inside the step that deposits, a buy that stopped has deposited nothing:
    // there is no cash in a vault to finish with, and a swap left over is not this route's to remake.
    throw new Refusal(
      409,
      `a buy on ${entry.config.name} trades in the same step that deposits: nothing is left in a vault to finish`,
      { code: 'CONTINUE_NOT_SUPPORTED', fix: 'Make the buy again.' },
    );
  }
  const funding = order.legs.filter((leg) => leg.kind !== 'swap');
  if (funding.some((leg) => !done(leg)))
    throw new Refusal(409, 'this order has not put its cash in the vault yet', {
      code: 'DEPOSIT_NOT_LANDED',
      fix: 'Sign its steps in order; there is nothing to finish before the deposit has landed.',
    });
  const left = leftOf(order);
  if (left.length === 0)
    throw new Refusal(409, 'this order has nothing left to buy', { code: 'NOTHING_LEFT' });
  const basketId = order.basketId;
  if (!basketId)
    throw new Refusal(409, 'this order was made before it kept its vault’s number', {
      code: 'CONTINUE_NOT_SUPPORTED',
      fix: 'Make a new buy.',
    });
  const chain = left[0]?.chain;
  if (!chain || left.some((leg) => leg.chain !== chain))
    throw new Refusal(409, 'the steps left are not on one chain', {
      code: 'CONTINUE_NOT_SUPPORTED',
    });
  const entry = ctx.chains.get(chain);
  assertBuilds(entry);
  const owner = order.owner[chainFamily(chain)];
  if (!owner)
    throw new Refusal(409, 'this order names no wallet on the chain of its steps', {
      code: 'CONTINUE_NOT_SUPPORTED',
    });
  const slippageBps = slippageOf(request);
  const id = randomUUID();

  const legs = await refusing(async () => {
    const assets = await entry.adapter.listAssets();
    const cash = assets.find((asset) => asset.cls === 'cash');
    if (!cash) throw new Error(`${entry.chain} lists no cash token`);
    const vault = (await entry.adapter.getVaults(owner)).find((v) => v.basketId === basketId);
    if (!vault)
      throw new Refusal(409, 'the vault of this order is not open', {
        code: 'CONTINUE_NOT_SUPPORTED',
      });
    const trades = left.flatMap((leg) => leg.trades);
    if (trades.some((trade) => trade.sell !== cash.id))
      throw new Refusal(409, 'a step left sells something other than cash', {
        code: 'CONTINUE_NOT_SUPPORTED',
      });
    // Only what the vault holds: no step of this order moves anything from the wallet.
    const spend = trades.reduce((sum, trade) => sum + BigInt(trade.amountInRaw), 0n);
    if (spend > BigInt(vault.cash.raw))
      throw new Refusal(
        409,
        `the vault holds ${vault.cash.raw} raw ${cash.symbol} in cash, less than the ${spend} the steps left would spend`,
        {
          code: 'VAULT_CASH_SHORT',
          fix: 'The cash was spent or withdrawn since. Make a new buy for what you want to add.',
        },
      );
    const made: Leg[] = [];
    for (const [seq, leg] of left.entries())
      made.push({
        id: randomUUID(),
        orderId: id,
        chain,
        seq,
        kind: 'swap',
        description: leg.description,
        trades: leg.trades,
        signer: 'owner',
        // Quoted now: these are the terms the person reviews, and every build is held to them.
        expected: await expectedOf(entry, leg.trades, owner, slippageBps),
        status: 'planned',
        attempt: 0,
        txId: null,
        explorerUrl: null,
        validUntil: null,
        error: null,
        trigger: 'manual',
        provenance: entry.provenance,
      });
    return made;
  });

  const continued: Order = {
    id,
    type: 'buy',
    owner: order.owner,
    summary: `Finish buying your plan on ${entry.config.name} with the cash in your vault`,
    // No deposit: `depositRaw` is absent for an order that moves nothing from the wallet.
    basketId,
    continues: order.id,
    legs,
    warnings: [],
    needsConsent: [],
    fees: [],
    preparedBy: order.preparedBy,
    status: 'open',
    approvalUrl: `/orders/${id}`,
    expiresAt: Math.floor(Date.parse(ctx.now) / 1000) + ORDER_POLICY.unsignedSeconds,
    createdAt: ctx.now,
    disclaimer: DISCLAIMER.en,
  };
  // The request is the first order's own: which order this one finishes is the order's to say
  // (`continues`), and is stored beside the request, never taken from one (store.ts).
  return { order: continued, request };
}
