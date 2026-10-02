import { createHash, randomUUID } from 'node:crypto';
import {
  type Address,
  type BasketAsset,
  type BasketProposal,
  type ChainId,
  type Component,
  chainFamily,
  DISCLAIMER,
  type IntentRequest,
  type Leg,
  type Order,
  type Principal,
  type Target,
  type Trade,
} from '@colosseum/schemas';
import { holds } from '../plugins/auth';
import type { ChainEntry, ChainRegistry } from './chains';
import { Refusal, refusing } from './errors';

// DESIGN-VAULT 3.3: the one function behind the web buttons, REST, the SDK and MCP. It plans the legs
// of an order and builds nothing: a leg is built just before it is signed.

/** The numbers the order layer applies. One place, so the review screen and the bytes agree. */
export const ORDER_POLICY = {
  /** The slippage every build is given, and what a leg's `minOutRaw` is worked out with. */
  slippageBps: 100,
  /** An order nobody signed expires after this long. */
  unsignedSeconds: 15 * 60,
  /** Once its first leg is signed, an order stays open this long. */
  signedSeconds: 24 * 60 * 60,
} as const;

export type PrepareContext = {
  principal: Principal;
  chains: ChainRegistry;
  /** A stored plan by its id, or null when there is none. */
  loadProposal(id: string): Promise<BasketProposal | null>;
  /** ISO time. */
  now: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A plan's number onchain: the first 8 bytes of the SHA-256 of its id, as a decimal string. The same
 * person buying the same plan again reaches the same vault, with nothing stored to say so.
 */
export function basketIdOf(proposalId: string): string {
  const hex = createHash('sha256').update(`plan:${proposalId.toLowerCase()}`).digest('hex');
  return BigInt(`0x${hex.slice(0, 16)}`).toString();
}

export const lessBps = (amount: bigint, bps: number) => (amount * BigInt(10_000 - bps)) / 10_000n;

const usd = (cents: bigint) =>
  `$${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;

/** A plan's components on one chain as vault targets. A shared portfolio inside a plan is not flattened here. */
export function targetsOf(components: Component[]): Target[] {
  return components.map((c) => {
    if (c.kind !== 'asset')
      throw new Refusal(
        422,
        `this plan holds the shared portfolio "${c.family}" as one line, and the API cannot open it into its assets yet`,
      );
    return { asset: c.asset, weightBps: c.weightBps };
  });
}

/** Splits `total` by integer weights. Each share is rounded down; what is left goes to the largest. */
function split(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((n, w) => n + w, 0n);
  if (sum === 0n) throw new Refusal(422, 'this plan puts nothing on the chains asked for');
  const shares = weights.map((w) => (total * w) / sum);
  const largest = weights.indexOf(weights.reduce((a, b) => (b > a ? b : a), 0n));
  shares[largest] = (shares[largest] ?? 0n) + total - shares.reduce((n, s) => n + s, 0n);
  return shares;
}

const chunk = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

type ChainPlan = { legs: Leg[]; closed: boolean };

/**
 * The legs of a buy on one chain, split by what the chain can put in one transaction:
 *   approve          where the chain needs one
 *   create_vault     with the cash, when the owner has no vault for this plan yet; or
 *   deposit          the cash into the vault that is there
 *   swap             the trades that buy each asset in the plan's proportions, as many per leg as the
 *                    chain takes. Where the chain can trade inside the create, the first of them ride
 *                    in the create or the deposit.
 * The trades add up to exactly the cash deposited, so a later build can read the amount back from them.
 */
async function planChainBuy(a: {
  entry: ChainEntry;
  orderId: string;
  owner: Address;
  basketId: string;
  components: Component[];
  cents: bigint;
}): Promise<ChainPlan> {
  const { entry, owner } = a;
  const { adapter } = entry;
  const assets = await adapter.listAssets();
  const byId = new Map<string, BasketAsset>(assets.map((x) => [x.id, x]));
  const cash = assets.find((x) => x.cls === 'cash');
  if (!cash) throw new Error(`${entry.chain} lists no cash token`);
  const targets = targetsOf(a.components);
  for (const t of targets) {
    const listed = byId.get(t.asset);
    if (!listed || listed.cls === 'cash')
      throw new Refusal(422, `${t.asset} cannot be bought on ${entry.config.name}`, {
        code: 'ASSET_NOT_ELIGIBLE',
      });
  }
  // Dollars and cents into the cash token's raw units.
  const cashRaw = (a.cents * 10n ** BigInt(cash.decimals)) / 100n;
  const amounts = split(
    cashRaw,
    targets.map((t) => BigInt(t.weightBps)),
  );
  if (amounts.some((x) => x === 0n))
    throw new Refusal(422, `the amount is too small to buy every asset on ${entry.config.name}`);
  const trades: Trade[] = targets.map((t, i) => ({
    sell: cash.id,
    buy: t.asset,
    amountInRaw: String(amounts[i]),
  }));

  const existing = (await adapter.getVaults(owner)).find((v) => v.basketId === a.basketId);
  const caps = adapter.capabilities;
  const groups = chunk(trades, caps.maxTradesPerTx);
  const riding = caps.tradesInCreate ? (groups.shift() ?? []) : [];
  const symbols = (list: Trade[]) => list.map((t) => byId.get(t.buy)?.symbol ?? t.buy).join(', ');
  const steps: Pick<Leg, 'kind' | 'description' | 'trades'>[] = [];
  if (caps.needsApprove)
    steps.push({
      kind: 'approve',
      description: `Allow your vault to take ${usd(a.cents)} of cash`,
      trades: [],
    });
  const andBuy = riding.length ? ` and buy ${symbols(riding)}` : '';
  steps.push(
    existing
      ? {
          kind: 'deposit',
          description: `Add ${usd(a.cents)} to the vault${andBuy}`,
          trades: riding,
        }
      : {
          kind: 'create_vault',
          description: `Open the vault for this plan with ${usd(a.cents)}${andBuy}`,
          trades: riding,
        },
  );
  for (const group of groups)
    steps.push({ kind: 'swap', description: `Buy ${symbols(group)}`, trades: group });

  const prices = await adapter.getPrices(targets.map((t) => t.asset));
  const legs: Leg[] = [];
  for (const [seq, step] of steps.entries())
    legs.push({
      id: randomUUID(),
      orderId: a.orderId,
      chain: entry.chain,
      seq,
      ...step,
      signer: 'owner',
      expected: await expectedOf(entry, step.trades, owner),
      status: 'planned',
      attempt: 0,
      txId: null,
      explorerUrl: null,
      validUntil: null,
      error: null,
      trigger: 'manual',
      provenance: entry.provenance,
    });
  return { legs, closed: prices.some((p) => p.market === 'closed') };
}

/**
 * What a leg with one trade is expected to pay out, from a quote taken now. `minOutRaw` is the quote
 * less the slippage every build is given. Null for a leg with no trade or with several: one figure
 * cannot stand for trades into different assets.
 */
export async function expectedOf(
  entry: ChainEntry,
  trades: Trade[],
  taker: Address,
): Promise<Leg['expected']> {
  const [trade, ...more] = trades;
  if (!trade || more.length) return null;
  const quote = await entry.adapter.quote(trade, taker);
  return {
    inRaw: trade.amountInRaw,
    outRaw: quote.outRaw,
    minOutRaw: lessBps(BigInt(quote.outRaw), ORDER_POLICY.slippageBps).toString(),
    costBps: quote.costBps,
  };
}

const list = (names: string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

export async function prepareIntent(req: IntentRequest, ctx: PrepareContext): Promise<Order> {
  if (req.type !== 'buy')
    throw new Refusal(501, `a ${req.type} order is not built yet: this API prepares buys only`);
  // The owner in the body is a claim. It stands only where the verified tokens say the same.
  if (!holds(ctx.principal, req.owner))
    throw new Refusal(403, 'the owner in the request is not a wallet of the signed-in person');
  if (req.family)
    throw new Refusal(501, 'buying a shared portfolio by its name is not built yet: name a plan');
  if (!req.proposalId) throw new Refusal(400, 'a buy names the plan it buys: send proposalId');
  const proposal = UUID.test(req.proposalId) ? await ctx.loadProposal(req.proposalId) : null;
  if (!proposal) throw new Refusal(404, 'no plan with that id');

  const planned = new Map(proposal.recipes.map((r) => [r.chain, r]));
  const chains: ChainId[] = [...new Set(req.chains ?? proposal.recipes.map((r) => r.chain))];
  if (!chains.length) throw new Refusal(422, 'this plan names no chain');
  const picked = chains.map((chain) => {
    const recipe = planned.get(chain);
    if (!recipe) throw new Refusal(422, `this plan has nothing on ${chain}`);
    // Refuses a chain that is off before anything is planned.
    const entry = ctx.chains.get(chain);
    const owner = req.owner[chainFamily(chain)];
    if (!owner)
      throw new Refusal(422, `the owner has no ${chainFamily(chain)} address for ${chain}`);
    return { entry, recipe, owner };
  });

  const cents = BigInt(Math.round(req.amountUsd * 100));
  if (cents <= 0n) throw new Refusal(422, 'the amount is less than one cent');
  // Each chain gets the share of the amount that the plan gives it.
  const shares = split(
    cents,
    picked.map((p) => BigInt(Math.round(p.recipe.amountUsd * 100))),
  );
  const id = randomUUID();
  const basketId = basketIdOf(req.proposalId);
  const plans = await refusing(() =>
    Promise.all(
      picked.map((p, i) =>
        planChainBuy({
          entry: p.entry,
          orderId: id,
          owner: p.owner,
          basketId,
          components: p.recipe.components,
          cents: shares[i] ?? 0n,
        }),
      ),
    ),
  );

  const nowSeconds = Math.floor(Date.parse(ctx.now) / 1000);
  return {
    id,
    type: 'buy',
    owner: req.owner,
    summary: `Buy ${usd(cents)} of your plan on ${list(picked.map((p) => p.entry.config.name))}`,
    legs: plans.flatMap((p) => p.legs),
    warnings: plans.some((p) => p.closed)
      ? [
          {
            code: 'MARKET_CLOSED',
            text: 'The US stock market is closed now. You can still buy; stock tokens may trade at a wider price.',
          },
        ]
      : [],
    needsConsent: [],
    fees: [],
    preparedBy: ctx.principal.kind === 'service' ? 'mcp' : 'app',
    status: 'open',
    approvalUrl: `/orders/${id}`,
    expiresAt: nowSeconds + ORDER_POLICY.unsignedSeconds,
    createdAt: ctx.now,
    disclaimer: DISCLAIMER.en,
  };
}
