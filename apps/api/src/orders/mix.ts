import { createHash, randomUUID } from 'node:crypto';
import { batchTrades, RebalanceError, rebalancePlan } from '@colosseum/basket';
import { fixedMix, PERSONAL_PARAMS, reason } from '@colosseum/engine/personal';
import {
  type Address,
  type BasketAsset,
  BasketProposal,
  type BasketSheet,
  type BuiltTx,
  chainFamily,
  DISCLAIMER,
  type IntentRequest,
  type Language,
  type Leg,
  type MixFigure,
  type MixIssueCode,
  type MixLine,
  type MixOrigin,
  type MixReview,
  type MixReviewLine,
  type MixWarning,
  type MixWarningCode,
  normalizeAddress,
  type ObservationRef,
  ORDER_LIMITS,
  type Order,
  type Price,
  type Target,
  type Trade,
  type VaultState,
} from '@colosseum/schemas';
import { assertBuilds, type ChainEntry } from './chains';
import { Refusal } from './errors';
import { type PlanInputs, preparePersonalInputs } from './personalize';
import { expectedOf, MIX_VERSION, ORDER_POLICY } from './prepare';

// A mix taken from the conversation, or chosen by the person, made into something that can be bought
// (gate ANY-COMPOSITION, Thom, Oct 8). Any composition of the chain's listed assets: each once,
// whole basis points, 16 at most, and the chain's cash token for the rest, all adding up to exactly
// 10,000. The client sends the lines back and they are checked again here against the chain as it is
// now. What used to keep a line out (an exit ceiling, the asset list's cap, a stock in an income or
// protect plan) is a warning the person confirms. Every figure is the server's, with its source.
//
// A new vault: the mix is stored as a plan, as the engine's plans are, and bought by `POST /v1/orders`
// with its `proposalId`, unchanged. A vault the person has: an order whose first step sets the
// vault's own targets and whose other steps sell and buy to them at the prices now.

/** The version of this way of making a plan: a stored mix's `engineVersion`. */
export { MIX_VERSION };

/** The figures a mix is checked with, from the chain and the plan inputs, read once. */
export type MixContext = {
  entry: ChainEntry;
  /** The chain's asset list, each with the tier and issuer the plan inputs stand in for its own. */
  assets: BasketAsset[];
  cash: BasketAsset;
  prepared: Awaited<ReturnType<typeof preparePersonalInputs>>;
  now: string;
};

export async function mixContext(
  entry: ChainEntry,
  inputs: (q: Omit<Parameters<PlanInputs>[0], 'db'>) => ReturnType<PlanInputs>,
  now: string,
): Promise<MixContext> {
  const listed = await entry.adapter.listAssets();
  const prepared = await preparePersonalInputs(
    entry.chain,
    listed,
    [],
    entry.provenance,
    (chain, assets, provenance) => inputs({ chain, assets, provenance }),
  );
  const assets = prepared.shelf.assets.filter((a) => a.chain === entry.chain);
  const cash = assets.find((a) => a.cls === 'cash');
  if (!cash) throw new Error(`${entry.chain} lists no cash token`);
  return { entry, assets, cash, prepared, now };
}

/** A mix as checked: cash first where it has a share, then each asset as sent. */
export type CheckedMix = {
  picks: Array<{ asset: BasketAsset; weightBps: number }>;
  targets: Target[];
  cashBps: number;
  /** The reference price of every asset of the mix and every asset the vault holds, by asset. */
  prices: Map<string, Price>;
};

const issue = (code: MixIssueCode, asset?: string) => (asset ? `${code}:${asset}` : code);

/** A price the vault can trade on now: a feed, above zero, and no older than the chain takes. */
const usable = (asset: BasketAsset, price: Price | undefined): price is Price =>
  asset.priceKind !== 'none' &&
  price !== undefined &&
  Number(price.usdPerToken) > 0 &&
  price.ageSeconds <= price.maxAgeSeconds;

/**
 * The checks the money depends on, against the chain's list and prices now. Every issue is named, and
 * any one refuses the mix with 422 `MIX_NOT_VALID`. `vault`, for a vault already open: what it holds
 * is priced too, since it is sold to reach the targets, and all cash is refused.
 */
export async function checkMix(
  ctx: MixContext,
  allocations: readonly MixLine[],
  vault?: VaultState,
): Promise<CheckedMix> {
  const { entry, cash } = ctx;
  const byId = new Map(ctx.assets.map((a) => [a.id, a]));
  const issues: string[] = [];
  const seen = new Set<string>();
  const picks: CheckedMix['picks'] = [];
  let sum = 0;
  for (const line of allocations) {
    if (!Number.isInteger(line.weightBps) || line.weightBps < 1 || line.weightBps > 10_000)
      issues.push(issue('WEIGHT_NOT_WHOLE', line.assetId));
    else sum += line.weightBps;
    if (seen.has(line.assetId)) {
      issues.push(issue('DUPLICATE', line.assetId));
      continue;
    }
    seen.add(line.assetId);
    const asset = byId.get(line.assetId);
    if (!asset) issues.push(issue('NOT_LISTED', line.assetId));
    else if (asset.cls === 'cash' && asset.id !== cash.id)
      issues.push(issue('FOREIGN_CASH', line.assetId));
    else picks.push({ asset, weightBps: line.weightBps });
  }
  if (sum !== 10_000 && !issues.some((i) => i.startsWith('WEIGHT_NOT_WHOLE')))
    issues.push(issue('SUM_NOT_10000'));
  const invested = picks.filter((p) => p.asset.id !== cash.id);
  if (allocations.filter((l) => l.assetId !== cash.id).length > ORDER_POLICY.maxLines)
    issues.push(issue('TOO_MANY_LINES'));
  if (vault && invested.length === 0 && issues.length === 0) issues.push(issue('ALL_CASH'));
  const held = vault ? vault.positions.filter((p) => BigInt(p.raw) > 0n).map((p) => p.asset) : [];
  const priced = [...new Set([...invested.map((p) => p.asset.id), ...held])];
  const prices = new Map<string, Price>();
  if (issues.length === 0 && priced.length) {
    for (const price of await entry.adapter.getPrices(priced.filter((id) => byId.has(id))))
      prices.set(price.asset, price);
    for (const id of priced) {
      const asset = byId.get(id);
      if (!asset || !usable(asset, prices.get(id))) issues.push(issue('NO_PRICE', id));
    }
  }
  // One order moves at most `ORDER_LIMITS.maxAmountUsd`: a rebalance trades up to the vault's value.
  if (vault && issues.length === 0 && vaultValueUsd(vault, prices) > ORDER_LIMITS.maxAmountUsd)
    issues.push(issue('OVER_ORDER_LIMIT'));
  if (issues.length)
    throw new Refusal(422, 'this mix cannot be bought as sent', {
      code: 'MIX_NOT_VALID',
      fix: 'Change the lines named in details.issues, then review the mix again.',
      details: { issues: [...new Set(issues)] },
    });
  const cashBps = picks.find((p) => p.asset.id === cash.id)?.weightBps ?? 0;
  return {
    picks: [...picks.filter((p) => p.asset.id === cash.id), ...invested],
    targets: invested.map((p) => ({ asset: p.asset.id, weightBps: p.weightBps })),
    cashBps,
    prices,
  };
}

type Goal = BasketSheet['goal'];

/** The sheet a mix's figures are read with: the person's goal, amount and term on the one chain. */
export function mixSheet(
  ctx: MixContext,
  a: {
    goal: Goal;
    risk: BasketSheet['risk'];
    amountUsd: number;
    horizonMonths?: number;
    language: Language;
  },
): BasketSheet {
  return {
    basketType: 'standard',
    goal: a.goal,
    amountUsd: a.amountUsd,
    horizonMonths: a.horizonMonths ?? PERSONAL_PARAMS.openEndedHorizonMonths,
    ...(a.horizonMonths === undefined ? { horizonOpen: true } : {}),
    risk: a.risk,
    themes: [],
    chains: [ctx.entry.chain],
    rules: { useHoldings: false, glide: false },
    language: a.language,
  };
}

const sourced = <T extends { source: string | null; fetchedAt: string | null }>(
  o: T,
): o is T & { source: string; fetchedAt: string } => o.source !== null && o.fetchedAt !== null;

/**
 * What the server says about a mix before it is bought or applied: each line's share of the amount,
 * its price and its exit ceiling, each with its source, and the warnings to confirm. `goal` null is
 * a vault whose plan the server does not hold: no line is checked against a goal then.
 */
export function reviewMix(
  ctx: MixContext,
  checked: CheckedMix,
  a: {
    origin: MixOrigin;
    goal: Goal | null;
    risk: BasketSheet['risk'];
    amountUsd: number;
    horizonMonths?: number;
    language: Language;
    accepted: readonly string[];
    vault?: VaultState;
  },
) {
  const { entry, prepared } = ctx;
  // The engine reads a sheet of at least $10; a smaller vault is read at that size, and only its
  // ceilings and the goal's list are used, which the size does not change.
  const sheet = mixSheet(ctx, {
    ...a,
    goal: a.goal ?? 'grow',
    amountUsd: Math.max(a.amountUsd, 10),
  });
  const { figures } = prepared;
  const fixed = fixedMix(
    sheet,
    prepared.shelf,
    {
      now: ctx.now,
      ...(figures.yields ? { yields: figures.yields } : {}),
      ...(figures.liquidity
        ? { liquidity: figures.liquidity.provider, liquiditySource: figures.liquidity.source }
        : {}),
    },
    checked.picks.map((p) => ({ assetId: p.asset.id, weightBps: p.weightBps })),
    a.origin,
  );
  const cents = splitCents(
    Math.round(a.amountUsd * 100),
    checked.picks.map((p) => p.weightBps),
  );
  const liquidityOf = new Map(
    fixed.observations.filter((o) => o.kind === 'liquidity').map((o) => [o.id, o]),
  );
  const tierOf = new Map((figures.tiers ?? []).map((t) => [t.assetId, t]));
  const warnings: MixWarning[] = [];
  const warn = (code: MixWarningCode, text: string, figures: MixFigure[], asset?: string) =>
    warnings.push({
      id: asset ? `${code}:${asset}` : code,
      code,
      ...(asset ? { assetId: asset } : {}),
      text,
      figures,
    });
  const lines: MixReviewLine[] = checked.picks.map(({ asset, weightBps }, i) => {
    const fixedLine = fixed.lines[i];
    if (!fixedLine || fixedLine.line.assetId !== asset.id) throw new Error('the mix lost a line');
    const amountUsd = (cents[i] ?? 0) / 100;
    const price = checked.prices.get(asset.id);
    let exitCeiling: MixReviewLine['exitCeiling'] = null;
    const { ceiling } = fixedLine;
    if (ceiling) {
      const measured = liquidityOf.get(asset.id);
      const tier = tierOf.get(asset.id);
      const from = ceiling.measured
        ? measured && sourced(measured)
          ? {
              source: measured.source,
              method: measured.method,
              fetchedAt: measured.fetchedAt,
              provenance: measured.provenance,
            }
          : null
        : {
            // A tier stands in where nothing is measured, and says so (gate EXIT-SOURCE).
            source: tier?.source ?? entry.source,
            method: `the ceiling of tier ${asset.tier} on the asset list, a fallback where no exit is measured${tier ? ` (tier: ${tier.method})` : ''}`,
            fetchedAt: tier?.fetchedAt ?? ctx.now,
            provenance: tier?.provenance ?? asset.provenance,
          };
      if (from) exitCeiling = { ...from, usd: ceiling.usd, measured: ceiling.measured };
      if (amountUsd > ceiling.usd)
        warn(
          ceiling.measured ? 'EXIT_OVER_CAPACITY' : 'EXIT_OVER_TIER_CEILING',
          // A ceiling whose measurement names no source is not printed: the warning says so instead.
          (from
            ? reason(
                ceiling.measured ? 'MIX_OVER_EXIT' : 'MIX_OVER_TIER',
                { asset: asset.symbol, usd: amountUsd, maxUsd: ceiling.usd },
                a.language,
              )
            : reason('MIX_OVER_EXIT_UNSOURCED', { asset: asset.symbol, usd: amountUsd }, a.language)
          ).text,
          from ? [{ ...from, label: 'exit ceiling', value: ceiling.usd, unit: 'USD' }] : [],
          asset.id,
        );
      if (weightBps > asset.maxWeightBps)
        warn(
          'OVER_LISTED_CAP',
          reason(
            'MIX_OVER_LISTED',
            { asset: asset.symbol, weightBps, maxBps: asset.maxWeightBps },
            a.language,
          ).text,
          [
            {
              label: 'cap on the asset list',
              value: asset.maxWeightBps,
              unit: 'bps',
              source: entry.source,
              method: 'listed asset catalog',
              fetchedAt: ctx.now,
              provenance: asset.provenance,
            },
          ],
          asset.id,
        );
      if (a.goal && !fixedLine.forGoal)
        warn(
          'NOT_FOR_GOAL',
          reason('MIX_NOT_FOR_GOAL', { asset: asset.symbol, goal: a.goal }, a.language).text,
          [],
          asset.id,
        );
    }
    return {
      assetId: asset.id,
      symbol: asset.symbol,
      cls: asset.cls,
      weightBps,
      amountUsd,
      price:
        asset.id === ctx.cash.id || !price
          ? null
          : {
              usdPerToken: price.usdPerToken,
              source: price.source,
              method: price.method,
              fetchedAt: price.fetchedAt,
              provenance: price.provenance,
            },
      exitCeiling,
    };
  });
  if (a.vault && (a.vault.recipeOnchainId !== null || a.vault.autoFollow))
    warn('STOPS_FOLLOWING', reason('MIX_STOPS_FOLLOWING', {}, a.language).text, []);
  const accepted = new Set(a.accepted);
  const body = {
    chain: entry.chain,
    origin: a.origin,
    goal: a.goal,
    amountUsd: a.amountUsd,
    lines,
    targets: checked.targets,
    cashBps: checked.cashBps,
    warnings,
  };
  const review: MixReview = {
    chain: entry.chain,
    origin: a.origin,
    goal: a.goal,
    amountUsd: a.amountUsd,
    lines,
    targets: checked.targets,
    cashBps: checked.cashBps,
    warnings,
    unconfirmed: warnings.map((w) => w.id).filter((id) => !accepted.has(id)),
    reviewHash: reviewHashOf(body, a.vault !== undefined),
    provenance: entry.provenance,
    disclaimer: DISCLAIMER[a.language],
  };
  return { review, sheet, fixed };
}

/**
 * What a confirmation is bound to: the mix, the goal, the amount and every warning with the figures
 * it stands on, as the server reads them now. A confirm that sends another hash, or none, saw other
 * numbers or none, and is answered with the review again. What moves on every read is left out, or
 * no confirm could ever match: the time of a price or of the request, and, for a vault, its value at
 * the prices now (a value that moves a line past a ceiling changes the warnings, and so the hash).
 */
function reviewHashOf(
  review: Pick<
    MixReview,
    'chain' | 'origin' | 'goal' | 'amountUsd' | 'lines' | 'targets' | 'cashBps' | 'warnings'
  >,
  vault: boolean,
): string {
  return hash({
    kind: 'mix-review-1',
    chain: review.chain,
    origin: review.origin,
    goal: review.goal,
    amountUsd: vault ? null : review.amountUsd,
    lines: review.lines.map((l) => [
      l.assetId,
      l.weightBps,
      vault ? null : l.amountUsd,
      l.exitCeiling ? [l.exitCeiling.usd, l.exitCeiling.measured, l.exitCeiling.source] : null,
    ]),
    targets: review.targets,
    cashBps: review.cashBps,
    warnings: review.warnings.map((w) => [
      w.id,
      w.figures.map((f) => [f.label, f.value, f.unit, f.source, f.method, f.provenance]),
    ]),
  });
}

/** The person confirmed this review: `confirm`, its hash, and every warning it carries accepted. */
export const confirmedReview = (
  review: MixReview,
  body: { confirm: boolean; reviewHash?: string | undefined },
) => body.confirm && body.reviewHash === review.reviewHash && review.unconfirmed.length === 0;

/** Cents split by weights: each rounded down, the rest a cent at a time to the largest remainders. */
function splitCents(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((n, w) => n + w, 0);
  const shares = weights.map((w) => Math.floor((total * w) / sum));
  let left = total - shares.reduce((n, s) => n + s, 0);
  const order = weights
    .map((w, i) => ({ i, rest: (total * w) % sum }))
    .sort((x, y) => y.rest - x.rest || x.i - y.i);
  for (const { i } of order) {
    if (left-- <= 0) break;
    shares[i] = (shares[i] ?? 0) + 1;
  }
  return shares;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * The mix as a stored plan in the engine's shape, so `POST /v1/orders` buys it as it buys any plan:
 * one recipe on the chain whose components are the targets, the cash share left out of them. The
 * lines are the person's weights unchanged. `inputsHash` takes the person, so the same mix stored
 * again by them is the same plan, and nobody else's.
 */
export function mixProposal(
  ctx: MixContext,
  reviewed: ReturnType<typeof reviewMix>,
  checked: CheckedMix,
  a: { person: string; origin: MixOrigin; accepted: readonly string[]; language: Language },
): BasketProposal {
  const { review, sheet, fixed } = reviewed;
  const accepted = [...new Set(a.accepted)].filter((id) =>
    review.warnings.some((w) => w.id === id),
  );
  const lines = fixed.lines.map((l) => l.line);
  const prices: ObservationRef[] = [...checked.prices.values()]
    .filter((p) => checked.targets.some((t) => t.asset === p.asset))
    .map((p) => ({
      id: p.asset,
      kind: 'price',
      source: p.source,
      method: p.method,
      fetchedAt: p.fetchedAt,
      provenance: p.provenance,
    }));
  const observations = [
    ...fixed.observations.filter(sourced).map((o) => ({ ...o })),
    ...prices,
  ] as ObservationRef[];
  return BasketProposal.parse({
    sheet,
    engineVersion: MIX_VERSION,
    paramsHash: hash(PERSONAL_PARAMS),
    shelfVersion: ctx.prepared.shelf.version,
    inputsHash: hash({
      kind: MIX_VERSION,
      person: a.person,
      sheet,
      origin: a.origin,
      lines: lines.map((l) => [l.assetId, l.weightBps]),
      accepted: [...accepted].sort(),
      shelf: ctx.prepared.shelf.version,
    }),
    lines,
    recipes: [
      {
        chain: ctx.entry.chain,
        amountUsd: sheet.amountUsd,
        components: checked.targets.map((t) => ({
          kind: 'asset',
          asset: t.asset,
          weightBps: t.weightBps,
        })),
      },
    ],
    removed: [],
    card: fixed.card,
    flags: [
      ...fixed.flags,
      `origin:${a.origin}`,
      ...review.warnings.map((w) => `confirmed:${w.id}`),
    ],
    observations,
    disclaimer: DISCLAIMER[a.language],
    origin: a.origin,
  });
}

/** What the vault is worth at the review's prices: cash at one dollar, as the vault counts it. */
export function vaultValueUsd(vault: VaultState, prices: Map<string, Price>): number {
  const cents = [vault.cash, ...vault.positions].reduce((n, h) => {
    if (BigInt(h.raw) === 0n) return n;
    const usd = h.asset === vault.cash.asset ? 1 : Number(prices.get(h.asset)?.usdPerToken ?? NaN);
    return n + Math.floor(Number(h.display) * usd * 100);
  }, 0);
  if (!Number.isFinite(cents)) throw new Error('a held asset was not priced');
  return cents / 100;
}

const pct = (bps: number) =>
  `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

/**
 * The order that gives a vault the person owns its own targets, and trades it to them: `set_targets`,
 * then the sales and then the purchases of `rebalancePlan` at the prices now, as many per step as the
 * chain takes. Purchases count on each sale losing up to the order's slippage, so the cash is there.
 * Every trade states its minimum, as a buy's do. The vault's auto-follow goes off with its own targets,
 * on chain, so the keeper does not trade it meanwhile.
 */
export async function planRetarget(
  ctx: MixContext,
  vault: VaultState,
  checked: CheckedMix,
  a: {
    slippageBps: number;
    now: string;
    /** The signed-in wallet that owns the vault, as the sign-in names it: the order's owner. */
    owner: Address;
  },
): Promise<{ order: Order; request: Extract<IntentRequest, { type: 'rebalance' }> }> {
  const { entry } = ctx;
  assertBuilds(entry);
  if (vaultValueUsd(vault, checked.prices) > ORDER_LIMITS.maxAmountUsd)
    throw new Refusal(422, 'this vault is worth more than one order may move', {
      code: 'MIX_NOT_VALID',
      details: { issues: ['OVER_ORDER_LIMIT'] },
    });
  let trades: Trade[];
  try {
    const plan = rebalancePlan(
      vault,
      checked.targets,
      [...checked.prices.values()],
      { bandBps: 0, minTradeUsd: 1, costBps: a.slippageBps },
      ctx.assets,
    );
    if (!plan.weighed || plan.unpriced.length)
      throw new Refusal(409, 'the vault cannot be valued now: an asset it holds has no price', {
        details: { retryable: true },
      });
    trades = plan.trades;
  } catch (e) {
    if (e instanceof RebalanceError)
      throw new Refusal(409, `the vault cannot be planned: ${e.message}`);
    throw e;
  }
  const symbol = (id: string) => ctx.assets.find((x) => x.id === id)?.symbol ?? id;
  const id = randomUUID();
  const { owner } = a;
  const steps: Array<Pick<Leg, 'kind' | 'description' | 'trades'>> = [
    {
      kind: 'set_targets',
      description: `Set your vault's targets: ${checked.targets
        .map((t) => `${symbol(t.asset)} ${pct(t.weightBps)}`)
        .join(', ')}${checked.cashBps ? `, and ${pct(checked.cashBps)} in cash` : ''}`,
      trades: [],
    },
    ...batchTrades(trades, entry.adapter.capabilities.maxTradesPerTx).map((group) => ({
      kind: 'swap' as const,
      description: group
        .map((t) =>
          t.buy === ctx.cash.id ? `Sell ${symbol(t.sell)} for cash` : `Buy ${symbol(t.buy)}`,
        )
        .join(', '),
      trades: group,
    })),
  ];
  const legs: Leg[] = [];
  for (const [seq, step] of steps.entries())
    legs.push({
      id: randomUUID(),
      orderId: id,
      chain: entry.chain,
      seq,
      ...step,
      signer: 'owner',
      expected: await expectedOf(entry, step.trades, owner, a.slippageBps),
      status: 'planned',
      attempt: 0,
      txId: null,
      explorerUrl: null,
      validUntil: null,
      error: null,
      trigger: 'manual',
      provenance: entry.provenance,
    });
  const order: Order = {
    id,
    type: 'rebalance',
    owner: { [chainFamily(entry.chain)]: owner },
    summary: `Apply your new targets to your vault on ${entry.config.name}`,
    basketId: vault.basketId,
    legs,
    warnings: [],
    needsConsent: [],
    fees: [],
    preparedBy: 'app',
    status: 'open',
    approvalUrl: `/orders/${id}`,
    expiresAt: Math.floor(Date.parse(a.now) / 1000) + ORDER_POLICY.unsignedSeconds,
    createdAt: a.now,
    disclaimer: DISCLAIMER.en,
  };
  return {
    order,
    request: {
      type: 'rebalance',
      vaults: [vault.address],
      reason: 'manual',
      targets: checked.targets,
      maxSlippageBps: a.slippageBps,
    },
  };
}

/**
 * One step of an order that applies a vault's own targets, built from the vault as it is now. The
 * vault is held to the order's owner again; the targets are the ones the order was made with, and a
 * trade carries the minimum the order stated, never another.
 */
export async function buildRetarget(
  request: Extract<IntentRequest, { type: 'rebalance' }>,
  leg: Leg,
  entry: ChainEntry,
  owner: Address,
  nonce: number | undefined,
): Promise<BuiltTx> {
  const [address] = request.vaults;
  if (!address || !request.targets?.length || request.maxSlippageBps === undefined)
    throw new Refusal(501, 'a rebalance order cannot be built yet');
  const vault = await entry.adapter.getVault(address);
  const family = entry.config.family;
  const same = (x: string, y: string) => {
    try {
      return normalizeAddress(family, x) === normalizeAddress(family, y);
    } catch {
      return false;
    }
  };
  if (!vault || !same(vault.owner, owner))
    throw new Refusal(404, 'no vault of yours at that address');
  const at = nonce === undefined ? {} : { nonce };
  if (leg.kind === 'set_targets')
    return entry.adapter.buildSetTargets({ vault: vault.address, targets: request.targets, ...at });
  if (leg.kind !== 'swap' || !leg.trades.length)
    throw new Refusal(501, `a ${leg.kind} step of a rebalance cannot be built`);
  if (leg.expected.length !== leg.trades.length)
    throw new Refusal(409, 'this step states no minimum for its trades: make the order again');
  return entry.adapter.buildOwnerSwap({
    vault: vault.address,
    trades: leg.trades,
    slippageBps: request.maxSlippageBps,
    minimums: leg.expected.map((e) => e.minOutRaw),
    ...at,
  });
}
