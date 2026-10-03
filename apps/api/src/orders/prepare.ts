import { createHash, randomUUID } from 'node:crypto';
import { FlattenError, flattenReport } from '@colosseum/basket';
import {
  type Address,
  type BasketAsset,
  type BasketProposal,
  type ChainId,
  type Component,
  chainFamily,
  DISCLAIMER,
  type FundingNeed,
  type IntentRequest,
  type Leg,
  ORDER_LIMITS,
  type Order,
  type Principal,
  type Recipe,
  type Shelf,
  type Target,
  Targets,
  type Trade,
} from '@colosseum/schemas';
import { holds } from '../plugins/auth';
import type { ChainEntry, ChainRegistry } from './chains';
import { Refusal, refusing } from './errors';

// DESIGN-VAULT 3.3: the one function behind the web buttons, REST, the SDK and MCP. It plans the legs
// of an order and builds nothing: a leg is built just before it is signed.

/**
 * The numbers the order layer applies. One place, so the review screen and the bytes agree. The most
 * a request may ask for is `ORDER_LIMITS` in packages/schemas, which the request's own schema holds.
 */
export const ORDER_POLICY = {
  /**
   * The slippage a build is given where the buy names none (`maxSlippageBps`), and what a leg's
   * `minOutRaw` is worked out with.
   */
  slippageBps: 100,
  /** An order nobody signed expires after this long. */
  unsignedSeconds: 15 * 60,
  /** Once the chain has seen its first transaction, an order stays open this long. */
  signedSeconds: 24 * 60 * 60,
  /** The most lines a vault holds: 16 in the Solana program and in the EVM vault. */
  maxLines: 16,
} as const;

/** The slippage every trade of an order is built with: the buy's own figure, or the server's. */
export function slippageOf(request: IntentRequest): number {
  return request.type === 'buy' && request.maxSlippageBps !== undefined
    ? request.maxSlippageBps
    : ORDER_POLICY.slippageBps;
}

export type PrepareContext = {
  principal: Principal;
  chains: ChainRegistry;
  /** A stored plan by its id, or null when there is none. */
  loadProposal(id: string): Promise<BasketProposal | null>;
  /** The chain the person's plans live on (gates ONE-CHAIN, CHAIN-PICK). Refuses when there is none yet. */
  homeChain(): Promise<ChainId>;
  /** The shared portfolios that have a recipe on `chain`, each with that recipe as it is in effect. */
  loadFamilies(chain: ChainId): Promise<Shelf['families']>;
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

/** Dollars as whole cents. */
export const centsOf = (amountUsd: number) => BigInt(Math.round(amountUsd * 100));
/** Cents in the raw units of a dollar token with that many decimals. */
export const cashRawOf = (cents: bigint, decimals: number) =>
  (cents * 10n ** BigInt(decimals)) / 100n;

/** A family id and a meta hash are 32 bytes of hex. A plan's own recipe has neither: all zeros. */
const NO_HASH = '0'.repeat(64);

/**
 * A plan's components on its chain as the targets a vault takes: each asset once, the weights adding up
 * to at most 10,000. What is left of 10,000 is the plan's cash share, which stays in the vault as cash
 * and is no target. A plan that is all cash has no component and no target.
 *
 * A component that is a shared portfolio is opened into that portfolio's own assets on the same chain,
 * weighted through (`flatten` of packages/basket). Nothing is dropped on the way: a plan with more
 * lines than a vault holds is refused, not trimmed.
 */
export async function targetsOf(
  chain: ChainId,
  components: Component[],
  assets: BasketAsset[],
  loadFamilies: PrepareContext['loadFamilies'],
): Promise<Target[]> {
  if (components.length === 0) return [];
  const families = components.some((c) => c.kind === 'index') ? await loadFamilies(chain) : [];
  // What `flatten` reads of a recipe is its chain and its components. The rest is a personal recipe
  // that was never published.
  const recipe: Recipe = {
    schemaVersion: 1,
    familyId: NO_HASH,
    chain,
    onchainId: null,
    creator: assets[0]?.address ?? '',
    kind: 'personal',
    version: 1,
    effectiveAt: 0,
    components,
    metaHash: NO_HASH,
    maxFeeBps: 0,
    flags: 0,
  };
  let flat: ReturnType<typeof flattenReport>;
  try {
    flat = flattenReport(
      recipe,
      { version: 'order', assets, families },
      { minLineBps: 1, maxLines: ORDER_POLICY.maxLines },
    );
  } catch (e) {
    if (e instanceof FlattenError)
      throw new Refusal(422, `this plan cannot be opened into its assets: ${e.message}`);
    throw e;
  }
  if (flat.dropped.length)
    throw new Refusal(
      422,
      `this plan has ${flat.targets.length + flat.dropped.length} lines, and a vault holds at most ${ORDER_POLICY.maxLines} of at least one basis point each`,
    );
  const checked = Targets.safeParse(flat.targets);
  if (!checked.success)
    throw new Refusal(
      422,
      `this plan's weights cannot be a vault's targets: ${checked.error.issues[0]?.message ?? 'not valid'}`,
    );
  return checked.data;
}

/** Splits `total` by integer weights. Each share is rounded down; what is left goes to the largest. */
function split(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((n, w) => n + w, 0n);
  if (sum === 0n) return weights.map(() => 0n);
  const shares = weights.map((w) => (total * w) / sum);
  const largest = weights.indexOf(weights.reduce((a, b) => (b > a ? b : a), 0n));
  shares[largest] = (shares[largest] ?? 0n) + total - shares.reduce((n, s) => n + s, 0n);
  return shares;
}

/**
 * The trades a deposit of `cashRaw` makes for these targets. Only the invested share is traded: the
 * deposit times the sum of the targets, rounded down. Each asset gets its part of that in proportion to
 * its weight. The rest of the deposit is the plan's cash share and is not traded: with targets that add
 * up to 10,000 the trades spend the whole deposit, with 9,500 they leave a twentieth of it as cash, and
 * with none there is no trade.
 */
export function tradesFor(targets: Target[], cashRaw: bigint, cash: BasketAsset['id']): Trade[] {
  const invested = (cashRaw * BigInt(targets.reduce((n, t) => n + t.weightBps, 0))) / 10_000n;
  const amounts = split(
    invested,
    targets.map((t) => BigInt(t.weightBps)),
  );
  return targets.map((t, i) => ({
    sell: cash,
    buy: t.asset,
    amountInRaw: String(amounts[i] ?? 0n),
  }));
}

const chunk = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

type Step = Pick<Leg, 'kind' | 'description' | 'trades' | 'cashRaw'>;

/** A buy on the person's chain, before it is an order: its steps, and what they need of the wallet. */
export type BuyPlan = {
  entry: ChainEntry;
  owner: Address;
  basketId: string;
  cents: bigint;
  cash: BasketAsset;
  targets: Target[];
  steps: Step[];
  /** What the adapter's funding read is asked about. */
  need: FundingNeed;
};

/**
 * The plan of a buy: the one chain it is on, the vault it reaches, and its steps. Nothing is quoted and
 * nothing is stored, so the funding check plans with the same function the order does.
 *
 * A buy is on one chain, the chain of the person's wallet, and so is the plan it buys: a stored plan
 * with recipes on several chains, or one made for another chain, is refused.
 */
export async function planBuy(
  req: Extract<IntentRequest, { type: 'buy' }>,
  ctx: Omit<PrepareContext, 'now'>,
): Promise<BuyPlan> {
  // The owner in the body is a claim. It stands only where the verified tokens say the same.
  if (!holds(ctx.principal, req.owner))
    throw new Refusal(403, 'the owner in the request is not a wallet of the signed-in person');
  if (req.family)
    throw new Refusal(501, 'buying a shared portfolio by its name is not built yet: name a plan');
  if (!req.proposalId) throw new Refusal(400, 'a buy names the plan it buys: send proposalId');
  const proposal = UUID.test(req.proposalId) ? await ctx.loadProposal(req.proposalId) : null;
  if (!proposal) throw new Refusal(404, 'no plan with that id');

  const chain = await ctx.homeChain();
  const [recipe, ...more] = proposal.recipes;
  if (!recipe) throw new Refusal(422, 'this plan names no chain');
  if (more.length)
    throw new Refusal(
      422,
      `this plan is spread over ${proposal.recipes.length} chains, and a plan lives on one: make the plan again`,
    );
  if (recipe.chain !== chain)
    throw new Refusal(
      422,
      `this plan was made for ${ctx.chains.name(recipe.chain)}, and your plans live on ${ctx.chains.name(chain)}: make the plan again`,
    );
  // Refuses a chain that is off before anything is planned.
  const entry = ctx.chains.get(chain);
  const owner = req.owner[chainFamily(chain)];
  if (!owner)
    throw new Refusal(
      422,
      `the owner has no ${chainFamily(chain)} address, and this plan is on ${entry.config.name}`,
    );

  // The route's schema already holds a request to both; this is for a caller that comes another way.
  if (!(req.amountUsd <= ORDER_LIMITS.maxAmountUsd))
    throw new Refusal(
      422,
      `one order buys at most $${ORDER_LIMITS.maxAmountUsd.toLocaleString('en-US')}`,
    );
  const slippageBps = slippageOf(req);
  if (!(slippageBps >= 0 && slippageBps <= ORDER_LIMITS.maxSlippageBps))
    throw new Refusal(422, `a trade takes at most ${ORDER_LIMITS.maxSlippageBps} bps of slippage`);
  const cents = centsOf(req.amountUsd);
  if (cents <= 0n) throw new Refusal(422, 'the amount is less than one cent');

  return refusing(async () => {
    const { adapter } = entry;
    const assets = await adapter.listAssets();
    const byId = new Map<string, BasketAsset>(assets.map((x) => [x.id, x]));
    const cash = assets.find((x) => x.cls === 'cash');
    if (!cash) throw new Error(`${entry.chain} lists no cash token`);
    const targets = await targetsOf(chain, recipe.components, assets, ctx.loadFamilies);
    for (const t of targets) {
      const listed = byId.get(t.asset);
      if (!listed || listed.cls === 'cash')
        throw new Refusal(422, `${t.asset} cannot be bought on ${entry.config.name}`, {
          code: 'ASSET_NOT_ELIGIBLE',
        });
    }
    // Where the plan holds a shared portfolio, its lines are what the person was shown. If the
    // portfolio has changed since, the plan opens into other assets than those: it is made again.
    if (recipe.components.some((c) => c.kind === 'index')) {
      const shown = proposal.lines.filter(
        (l) => l.chain === chain && l.assetId !== cash.id && l.weightBps > 0,
      );
      const same =
        shown.length === targets.length &&
        shown.every((l) =>
          targets.some((t) => t.asset === l.assetId && t.weightBps === l.weightBps),
        );
      if (!same)
        throw new Refusal(
          409,
          'a shared portfolio in this plan has changed since the plan was made',
          {
            code: 'VERSION_CHANGED',
            fix: 'Make the plan again.',
          },
        );
    }

    // The whole amount is deposited, in the chain's dollar token. The trades spend the invested share.
    const cashRaw = cashRawOf(cents, cash.decimals);
    const trades = tradesFor(targets, cashRaw, cash.id);
    if (trades.some((t) => t.amountInRaw === '0'))
      throw new Refusal(422, `the amount is too small to buy every asset on ${entry.config.name}`);

    const basketId = basketIdOf(req.proposalId ?? '');
    const existing = (await adapter.getVaults(owner)).find((v) => v.basketId === basketId);
    const caps = adapter.capabilities;
    const groups = chunk(trades, caps.maxTradesPerTx);
    const riding = caps.tradesInCreate ? (groups.shift() ?? []) : [];
    const symbols = (list: Trade[]) => list.map((t) => byId.get(t.buy)?.symbol ?? t.buy).join(', ');
    const deposit = String(cashRaw);
    const steps: Step[] = [];
    if (caps.needsApprove)
      steps.push({
        kind: 'approve',
        description: `Allow your vault to take ${usd(cents)} of cash`,
        cashRaw: deposit,
        trades: [],
      });
    const andBuy = riding.length ? ` and buy ${symbols(riding)}` : '';
    steps.push(
      existing
        ? {
            kind: 'deposit',
            description: `Add ${usd(cents)} to the vault${andBuy}`,
            cashRaw: deposit,
            trades: riding,
          }
        : {
            kind: 'create_vault',
            description: `Open the vault for this plan with ${usd(cents)}${andBuy}`,
            cashRaw: deposit,
            trades: riding,
          },
    );
    for (const group of groups)
      steps.push({ kind: 'swap', description: `Buy ${symbols(group)}`, trades: group });

    // On a chain with rent, each token account a step opens locks some: the vault's cash account when
    // the vault is new, and one for each asset the vault does not hold yet.
    const held = new Set(
      existing?.positions.filter((p) => p.raw !== '0').map((p) => p.asset) ?? [],
    );
    const newAccounts = (existing ? 0 : 1) + targets.filter((t) => !held.has(t.asset)).length;
    return {
      entry,
      owner,
      basketId,
      cents,
      cash,
      targets,
      steps,
      need: { cashRaw: deposit, legs: steps.length, newVault: !existing, newAccounts },
    };
  });
}

/**
 * What each trade of a leg is expected to pay out, from a quote taken now: one entry per trade, in the
 * order of the trades, and none for a leg that trades nothing. `minOutRaw` is the quote less the
 * slippage the order is built with.
 */
export async function expectedOf(
  entry: ChainEntry,
  trades: Trade[],
  taker: Address,
  slippageBps: number,
): Promise<Leg['expected']> {
  const expected: Leg['expected'] = [];
  for (const trade of trades) {
    const quote = await entry.adapter.quote(trade, taker);
    expected.push({
      inRaw: trade.amountInRaw,
      outRaw: quote.outRaw,
      minOutRaw: lessBps(BigInt(quote.outRaw), slippageBps).toString(),
      costBps: quote.costBps,
    });
  }
  return expected;
}

export async function prepareIntent(req: IntentRequest, ctx: PrepareContext): Promise<Order> {
  if (req.type !== 'buy')
    throw new Refusal(501, `a ${req.type} order is not built yet: this API prepares buys only`);
  const plan = await planBuy(req, ctx);
  const { entry, owner, cents } = plan;
  const slippageBps = slippageOf(req);
  const id = randomUUID();

  // The legs of a buy, all on the one chain, in the order they are signed:
  //   approve          where the chain needs one, for the whole deposit
  //   create_vault     with the deposit, when the owner has no vault for this plan yet; or
  //   deposit          the same amount into the vault that is there
  //   swap             the trades that buy each asset with the invested share, as many per leg as the
  //                    chain takes. Where the chain can trade inside the create, the first of them
  //                    ride in the create or the deposit.
  const { legs, closed } = await refusing(async () => {
    const legs: Leg[] = [];
    for (const [seq, step] of plan.steps.entries())
      legs.push({
        id: randomUUID(),
        orderId: id,
        chain: entry.chain,
        seq,
        ...step,
        signer: 'owner',
        expected: await expectedOf(entry, step.trades, owner, slippageBps),
        status: 'planned',
        attempt: 0,
        txId: null,
        explorerUrl: null,
        validUntil: null,
        error: null,
        trigger: 'manual',
        provenance: entry.provenance,
      });
    const prices = plan.targets.length
      ? await entry.adapter.getPrices(plan.targets.map((t) => t.asset))
      : [];
    return { legs, closed: prices.some((p) => p.market === 'closed') };
  });

  const nowSeconds = Math.floor(Date.parse(ctx.now) / 1000);
  return {
    id,
    type: 'buy',
    owner: req.owner,
    summary: `Buy ${usd(cents)} of your plan on ${entry.config.name}`,
    legs,
    warnings: closed
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
