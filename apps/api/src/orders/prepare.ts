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
  isAddressOf,
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
import { assertBuilds, type ChainEntry, type ChainRegistry } from './chains';
import { Refusal, refusing } from './errors';
import { chainsHeld } from './person';
import { followedOn, planFollow, planPublish, recipeTargets, type SharedContext } from './shared';
import { planWithdraw } from './withdraw';

// DESIGN-VAULT 3.3: the one function behind the web buttons, REST, the SDK and MCP. It plans the legs
// of an order and builds nothing: a leg is built just before it is signed.

/**
 * The numbers the order layer applies. One place, so the review screen and the bytes agree. The most
 * a request may ask for is `ORDER_LIMITS` in packages/schemas, which the request's own schema holds.
 */
/** The `engineVersion` of a plan stored from a mix the person confirmed (orders/mix.ts). */
export const MIX_VERSION = 'mix-1';

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

/** The slippage every trade of an order is built with: the buy's or the rebalance's own figure, or the server's. */
export function slippageOf(request: IntentRequest): number {
  return (request.type === 'buy' || request.type === 'rebalance') &&
    request.maxSlippageBps !== undefined
    ? request.maxSlippageBps
    : ORDER_POLICY.slippageBps;
}

export type PrepareContext = {
  principal: Principal;
  chains: ChainRegistry;
  /** A stored plan by its id, or null when there is none. */
  loadProposal(id: string): Promise<BasketProposal | null>;
  /**
   * True when the plan was made from a link (stored with no person, gate `AGENT-LINK`): its vault's
   * number then takes the buyer too (`basketIdOfLinked`). Left out, no plan is.
   */
  isLinkedPlan?(id: string): Promise<boolean>;
  /**
   * The person's current chain, where a new plan is made when the request names none (CHAIN-SWITCH).
   * Refuses when there is none yet.
   */
  homeChain(): Promise<ChainId>;
  /** The shared portfolios that have a recipe on `chain`, each with that recipe as it is in effect. */
  loadFamilies(chain: ChainId): Promise<Shelf['families']>;
  /**
   * The store of shared portfolios, for a buy of one, a follow and a publish. Left out, those three
   * are refused.
   */
  shared?: Pick<SharedContext, 'db' | 'bySlug' | 'byNameKey'>;
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

/**
 * The number of a vault bought from a plan made from a link (gate `AGENT-LINK`): from the plan's id and
 * the buyer's user id, the first 8 bytes of the SHA-256 of `linked-plan:<id>:<user id>`. A link is
 * shared by design, and the number is a seed of the vault's address and is stored in it: from the
 * plan's id alone, nobody can find the vaults its buyers opened. The same person buying it again
 * reaches the same vault. `basketIdOfLinkedPlan` in packages/sdk repeats it.
 */
export function basketIdOfLinked(proposalId: string, userId: string): string {
  const hex = createHash('sha256')
    .update(`linked-plan:${proposalId.toLowerCase()}:${userId}`)
    .digest('hex');
  return BigInt(`0x${hex.slice(0, 16)}`).toString();
}

/** The vault number of a buy of a stored plan: the buyer's own for a plan made from a link. */
export function basketIdOfBuy(proposalId: string, linked: boolean, userId: string | undefined) {
  if (!linked) return basketIdOf(proposalId);
  if (!userId)
    throw new Refusal(
      403,
      'a plan made from a link takes a deposit from a signed-in person, as themselves',
    );
  return basketIdOfLinked(proposalId, userId);
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

/** A buy on one chain, before it is an order: its steps, and what they need of the wallet. */
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
  /** For a buy of a shared portfolio: the version in effect, which the order holds to. */
  version?: number;
  /** What the review says about this buy, beside what any buy is told. */
  warnings?: Order['warnings'];
};

/** An add to a vault with auto-follow on only deposits: said on the order's review. */
export const KEEPER_INVESTS = {
  code: 'KEEPER_INVESTS',
  text: 'This vault has auto-follow on, so this order only deposits the cash. The keeper puts it into the vault’s assets when it next rebalances this vault.',
} as const;

/**
 * The one recipe of a stored plan, and so its chain (ONE-CHAIN). A plan is bought on its own chain,
 * whatever the person's current chain is now (CHAIN-SWITCH).
 */
export function recipeOf(proposal: BasketProposal): BasketProposal['recipes'][number] {
  const [recipe, ...more] = proposal.recipes;
  if (!recipe) throw new Refusal(422, 'this plan names no chain');
  if (more.length)
    throw new Refusal(
      422,
      `this plan is spread over ${proposal.recipes.length} chains, and a plan lives on one: make the plan again`,
    );
  return recipe;
}

/**
 * The plan of a buy: the one chain it is on, the vault it reaches, and its steps. Nothing is quoted and
 * nothing is stored, so the funding check plans with the same function the order does.
 *
 * A buy of a stored plan is on the plan's own chain, whatever the person's current chain is; a plan with
 * recipes on several chains is refused. A buy of a shared portfolio opens a vault, so it is a new plan:
 * on the chain the request names (`chain`), else on the current chain.
 */
export async function planBuy(
  req: Extract<IntentRequest, { type: 'buy' }>,
  ctx: Omit<PrepareContext, 'now'>,
): Promise<BuyPlan> {
  // The owner in the body is a claim. It stands only where the verified tokens say the same.
  if (!holds(ctx.principal, req.owner))
    throw new Refusal(403, 'the owner in the request is not a wallet of the signed-in person');
  const named = [req.proposalId, req.family, req.vault].filter((x) => x !== undefined).length;
  if (named > 1)
    throw new Refusal(
      400,
      'a deposit names one thing: a plan, a shared portfolio or a vault of yours',
    );
  // A plan is bought on its own chain and a vault added to on its own: only a shared portfolio,
  // which may have a recipe on more than one, is told which (gate CHAIN-AT-THE-PLAN).
  if (req.chain !== undefined && req.family === undefined)
    throw new Refusal(
      400,
      '`chain` is the chain of a shared portfolio’s recipe: send it with `family`',
    );
  if (req.vault !== undefined) {
    if (req.version !== undefined)
      throw new Refusal(
        400,
        '`version` is the version of a shared portfolio: send it with `family`',
      );
    return planVaultBuy(req, req.vault, ctx);
  }
  if (req.family !== undefined) return planFamilyBuy(req, req.family, ctx);
  if (req.version !== undefined)
    throw new Refusal(400, '`version` is the version of a shared portfolio: send it with `family`');
  if (!req.proposalId) throw new Refusal(400, 'a deposit names its plan: send proposalId');
  const proposal = UUID.test(req.proposalId) ? await ctx.loadProposal(req.proposalId) : null;
  if (!proposal) throw new Refusal(404, 'no plan with that id');

  const recipe = recipeOf(proposal);
  const chain = recipe.chain;
  // Refuses a chain that is off before anything is planned.
  const entry = ctx.chains.get(chain);
  const owner = req.owner[chainFamily(chain)];
  if (!owner)
    throw new Refusal(
      422,
      `the owner has no ${chainFamily(chain)} address, and this plan is on ${entry.config.name}`,
    );

  const cents = amountOf(req);
  // A mix's warnings were confirmed at the amount it was reviewed at (gate ANY-COMPOSITION): an exit
  // ceiling that was no warning then can be one at a larger size, so it is bought at no more.
  if (proposal.engineVersion === MIX_VERSION && cents > centsOf(proposal.sheet.amountUsd))
    throw new Refusal(
      422,
      `this vault was reviewed at ${usd(centsOf(proposal.sheet.amountUsd))}: a deposit into it is no more than that`,
      { code: 'AMOUNT_OVER_REVIEW', fix: 'Review the deposit again at the new amount.' },
    );

  return refusing(async () => {
    const assets = await entry.adapter.listAssets();
    const targets = await targetsOf(chain, recipe.components, assets, ctx.loadFamilies);
    const { cash } = eligible(entry, assets, targets);
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

    const id = req.proposalId ?? '';
    const linked = (await ctx.isLinkedPlan?.(id)) ?? false;
    const basketId = basketIdOfBuy(id, linked, ctx.principal.userId);
    return buySteps(entry, owner, basketId, cents, assets, targets);
  });
}

/** The amount of a buy in cents, held to the limits a request has. */
function amountOf(req: Extract<IntentRequest, { type: 'buy' }>): bigint {
  // The route's schema already holds a request to both; this is for a caller that comes another way.
  if (!(req.amountUsd <= ORDER_LIMITS.maxAmountUsd))
    throw new Refusal(
      422,
      `one deposit is at most $${ORDER_LIMITS.maxAmountUsd.toLocaleString('en-US')}`,
    );
  const slippageBps = slippageOf(req);
  if (!(slippageBps >= 0 && slippageBps <= ORDER_LIMITS.maxSlippageBps))
    throw new Refusal(422, `a trade takes at most ${ORDER_LIMITS.maxSlippageBps} bps of slippage`);
  const cents = centsOf(req.amountUsd);
  if (cents <= 0n) throw new Refusal(422, 'the amount is less than one cent');
  return cents;
}

/** Every target is a listed asset of the chain that is not its cash. Answers the chain's cash. */
function eligible(entry: ChainEntry, assets: BasketAsset[], targets: Target[]) {
  const byId = new Map<string, BasketAsset>(assets.map((x) => [x.id, x]));
  const cash = assets.find((x) => x.cls === 'cash');
  if (!cash) throw new Error(`${entry.chain} lists no cash token`);
  for (const t of targets) {
    const listed = byId.get(t.asset);
    if (!listed || listed.cls === 'cash')
      throw new Refusal(422, `${t.asset} is not available on ${entry.config.name}`, {
        code: 'ASSET_NOT_ELIGIBLE',
      });
  }
  return { byId, cash };
}

/**
 * A buy of a shared portfolio on one chain (gate ONE-CHAIN): the chain of the recipe the request
 * names, which a wallet of the person has to sign on, else the person's current chain (gate
 * CHAIN-AT-THE-PLAN). A vault that follows the version in effect, opened with the whole deposit, then a swap per asset. The vault's number is
 * `basketIdOf(familyId)`, so buying the same portfolio again adds to the vault that follows it. The
 * vault opens with auto-follow off: with it on, the keeper could trade the deposit before the person's
 * own buys land. A follow order switches it on afterwards, where the portfolio offers it.
 */
async function planFamilyBuy(
  req: Extract<IntentRequest, { type: 'buy' }>,
  slug: string,
  ctx: Omit<PrepareContext, 'now'>,
): Promise<BuyPlan> {
  const shared = ctx.shared;
  if (!shared)
    throw new Refusal(501, 'a deposit into a shared portfolio is not served here: name a plan');
  const chain = req.chain ?? (await ctx.homeChain());
  // A chain the request names is held to the person's wallets, as a switch of the current chain is.
  if (req.chain !== undefined && !chainsHeld(ctx.principal).includes(chain))
    throw new Refusal(409, `no wallet you signed in with signs on ${ctx.chains.name(chain)}`, {
      code: 'NO_WALLET_FOR_CHAIN',
      fix: `Sign in with a wallet that signs on ${ctx.chains.name(chain)}, or with a passkey.`,
      details: { retryable: false },
    });
  const { family, entry, onchain } = await refusing(() =>
    followedOn(slug, chain, { chains: ctx.chains, bySlug: shared.bySlug }, req.version),
  );
  assertBuilds(entry);
  const owner = req.owner[chainFamily(chain)];
  if (!owner)
    throw new Refusal(
      422,
      `the owner has no ${chainFamily(chain)} address, and this portfolio is on ${entry.config.name}`,
    );
  const cents = amountOf(req);
  return refusing(async () => {
    const assets = await entry.adapter.listAssets();
    const targets = recipeTargets(onchain.active);
    eligible(entry, assets, targets);
    const basketId = basketIdOf(family.familyId);
    const existing = (await entry.adapter.getVaults(owner)).find((v) => v.basketId === basketId);
    if (
      existing &&
      (existing.recipeOnchainId !== onchain.active.onchainId ||
        existing.acceptedVersion !== onchain.active.version)
    )
      throw new Refusal(
        409,
        `your vault for this shared portfolio does not follow version ${onchain.active.version}, the one in effect`,
        {
          code: 'VERSION_CHANGED',
          fix: 'Accept the version in effect first, then add to the vault.',
        },
      );
    const plan = await buySteps(entry, owner, basketId, cents, assets, targets);
    return { ...plan, version: onchain.active.version };
  });
}

/** One answer for a vault that is not there, one on another chain and one that is another person's. */
export const NO_SUCH_VAULT = 'no vault with that address that you can add to';

/** Two addresses of one chain are the same vault: an EVM address in any case. */
export const sameVaultAddress = (chain: ChainId, a: string, b: string) =>
  chainFamily(chain) === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * More money into a vault the person already has (add money): the amount is deposited into THAT vault
 * and buys to the targets the vault has on chain now, so a vault that follows a shared portfolio buys
 * the version it follows and a plan's vault its plan's lines; the cash share the targets leave stays
 * as cash. The vault is found among the vaults of the signing wallet, read from the chain: one that
 * is not there is answered like one that does not exist, whoever it belongs to. The order is the
 * vault's number and no plan's: its steps are the deposit, then the swaps, as for any buy into an open
 * vault.
 */
async function planVaultBuy(
  req: Extract<IntentRequest, { type: 'buy' }>,
  named: { chain: ChainId; address: string },
  ctx: Omit<PrepareContext, 'now'>,
): Promise<BuyPlan> {
  const family = chainFamily(named.chain);
  if (!isAddressOf(family, named.address)) throw new Refusal(404, NO_SUCH_VAULT);
  // Refuses a chain that is off before anything is read.
  const entry = ctx.chains.get(named.chain);
  assertBuilds(entry);
  const owner = req.owner[family];
  if (!owner) throw new Refusal(404, NO_SUCH_VAULT);
  const cents = amountOf(req);
  return refusing(async () => {
    const vault = (await entry.adapter.getVaults(owner)).find((v) =>
      sameVaultAddress(named.chain, v.address, named.address),
    );
    if (!vault) throw new Refusal(404, NO_SUCH_VAULT);
    const assets = await entry.adapter.listAssets();
    // The targets the vault has on chain now, whatever newer version the portfolio it follows has
    // (gate ADD-CURRENT-TARGETS). With auto-follow on the keeper keeps the vault at its targets, so
    // the add is the deposit alone: trades of the owner's beside the keeper's would cross.
    if (vault.autoFollow)
      return {
        ...(await buySteps(entry, owner, vault.basketId, cents, assets, [])),
        warnings: [KEEPER_INVESTS],
      };
    const targets: Target[] = vault.positions
      .filter((p) => p.targetBps > 0)
      .map((p) => ({ asset: p.asset, weightBps: p.targetBps }));
    return buySteps(entry, owner, vault.basketId, cents, assets, targets);
  });
}

/**
 * The steps of a buy of these targets into the vault `basketId`: an approval where the chain needs
 * one, the create or the deposit with the whole amount, then the swaps.
 */
async function buySteps(
  entry: ChainEntry,
  owner: Address,
  basketId: string,
  cents: bigint,
  assets: BasketAsset[],
  targets: Target[],
): Promise<BuyPlan> {
  const { adapter } = entry;
  const { byId, cash } = eligible(entry, assets, targets);
  // The whole amount is deposited, in the chain's dollar token. The trades spend the invested share.
  const cashRaw = cashRawOf(cents, cash.decimals);
  const trades = tradesFor(targets, cashRaw, cash.id);
  if (trades.some((t) => t.amountInRaw === '0'))
    throw new Refusal(422, `the amount is too small to reach every asset on ${entry.config.name}`);

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
  const andBuy = riding.length ? ` and swap into ${symbols(riding)}` : '';
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
    steps.push({ kind: 'swap', description: `Swap cash into ${symbols(group)}`, trades: group });

  // On a chain with rent, each token account a step opens locks some: the vault's cash account when
  // the vault is new, and one for each asset the vault does not hold yet.
  const held = new Set(existing?.positions.filter((p) => p.raw !== '0').map((p) => p.asset) ?? []);
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
}

/**
 * What each trade of a leg is expected to pay out, from a quote taken now: one entry per trade, in the
 * order of the trades, and none for a leg that trades nothing. `minOutRaw` is the quote less the
 * slippage the order is built with. Two trades of one pair in one leg follow each other: the second is
 * quoted after the first, as the quote of both less the quote of the first, as the EVM builder quotes
 * them.
 */
export async function expectedOf(
  entry: ChainEntry,
  trades: Trade[],
  taker: Address,
  slippageBps: number,
): Promise<Leg['expected']> {
  const expected: Leg['expected'] = [];
  const before = new Map<string, { in: bigint; out: bigint }>();
  for (const trade of trades) {
    const pair = `${trade.sell}>${trade.buy}`;
    const prior = before.get(pair) ?? { in: 0n, out: 0n };
    const total = prior.in + BigInt(trade.amountInRaw);
    const quote = await entry.adapter.quote({ ...trade, amountInRaw: total.toString() }, taker);
    const out = BigInt(quote.outRaw) - prior.out;
    before.set(pair, { in: total, out: BigInt(quote.outRaw) });
    // A trade that quotes nothing, or whose minimum rounds to nothing, would state a minimum that
    // accepts any price: the order is not made.
    if (out <= 0n || lessBps(out, slippageBps) <= 0n)
      throw new Refusal(
        422,
        `${trade.amountInRaw} raw ${trade.sell} swaps into no ${trade.buy} that can be held to a minimum: the amount is too small`,
        { fix: 'Deposit a larger amount.' },
      );
    expected.push({
      inRaw: trade.amountInRaw,
      outRaw: (out > 0n ? out : 0n).toString(),
      minOutRaw: lessBps(out > 0n ? out : 0n, slippageBps).toString(),
      costBps: quote.costBps,
    });
  }
  return expected;
}

/** An order and the request it is stored with: the caller's, with what the order holds to filled in. */
export type Prepared = { order: Order; request: IntentRequest };

export async function prepareIntent(req: IntentRequest, ctx: PrepareContext): Promise<Order> {
  return (await prepareOrder(req, ctx)).order;
}

/**
 * Plans an order from an intent. A buy (of a stored plan, or of a shared portfolio by its slug), a
 * follow of a shared portfolio by a vault the person has, a creator's publish, and a withdrawal in
 * kind from a vault the person has. The rest answer 501.
 */
export async function prepareOrder(req: IntentRequest, ctx: PrepareContext): Promise<Prepared> {
  if (req.type === 'buy') return prepareBuy(req, ctx);
  if (req.type === 'follow' || req.type === 'publish') {
    const shared = ctx.shared;
    if (!shared) throw new Refusal(501, `a ${req.type} order is not served here`);
    const sctx: SharedContext = {
      ...shared,
      principal: ctx.principal,
      chains: ctx.chains,
    };
    if (req.type === 'publish') {
      const { familyId, steps } = await refusing(() => planPublish(req, sctx));
      return {
        order: sharedOrder(ctx, req.creator, 'publish', 'Publish your shared portfolio', steps, [
          'publish',
        ]),
        request: { ...req, familyId },
      };
    }
    const plan = await refusing(() => planFollow(req, sctx));
    const owner = { [chainFamily(plan.entry.chain)]: plan.owner };
    return {
      order: sharedOrder(
        ctx,
        owner,
        'follow',
        `Follow a shared portfolio with your vault on ${plan.entry.config.name}`,
        plan.steps,
        plan.needsConsent,
        plan.entry.provenance,
      ),
      request: { ...req, version: plan.version },
    };
  }
  if (req.type === 'withdraw') {
    const plan = await refusing(() => planWithdraw(req, ctx));
    return {
      order: sharedOrder(
        ctx,
        { [chainFamily(plan.entry.chain)]: plan.owner },
        'withdraw',
        `Withdraw from your vault on ${plan.entry.config.name} to your own wallet`,
        plan.steps,
        [],
        plan.entry.provenance,
      ),
      request: req,
    };
  }
  throw new Refusal(501, `a ${req.type} order is not built yet`);
}

/** An order of steps that trade nothing: a publish, a follow or a withdrawal. */
function sharedOrder(
  ctx: PrepareContext,
  owner: Order['owner'],
  type: 'publish' | 'follow' | 'withdraw',
  summary: string,
  steps: {
    chain: ChainId;
    kind: Leg['kind'];
    description: string;
    withdrawals?: Leg['withdrawals'];
  }[],
  needsConsent: Order['needsConsent'],
  provenance?: Leg['provenance'],
  warnings: Order['warnings'] = [],
): Order {
  const id = randomUUID();
  const seqs = new Map<ChainId, number>();
  const legs: Leg[] = steps.map((step) => {
    const seq = seqs.get(step.chain) ?? 0;
    seqs.set(step.chain, seq + 1);
    return {
      id: randomUUID(),
      orderId: id,
      chain: step.chain,
      seq,
      kind: step.kind,
      description: step.description,
      ...(step.withdrawals ? { withdrawals: step.withdrawals } : {}),
      trades: [],
      signer: 'owner',
      expected: [],
      status: 'planned',
      attempt: 0,
      txId: null,
      explorerUrl: null,
      validUntil: null,
      error: null,
      trigger: 'manual',
      provenance: provenance ?? ctx.chains.get(step.chain).provenance,
    };
  });
  const names = [...seqs.keys()].map((c) => ctx.chains.name(c)).join(' and ');
  return {
    id,
    type,
    owner,
    // Written by the server: no word of the creator's text is in it.
    summary: type === 'publish' ? `${summary} on ${names}` : summary,
    legs,
    warnings,
    needsConsent,
    fees: [],
    preparedBy: ctx.principal.kind === 'service' ? 'mcp' : 'app',
    status: 'open',
    approvalUrl: `/orders/${id}`,
    expiresAt: Math.floor(Date.parse(ctx.now) / 1000) + ORDER_POLICY.unsignedSeconds,
    createdAt: ctx.now,
    disclaimer: DISCLAIMER.en,
  };
}

async function prepareBuy(
  req: Extract<IntentRequest, { type: 'buy' }>,
  ctx: PrepareContext,
): Promise<Prepared> {
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
  const order: Order = {
    id,
    type: 'buy',
    owner: req.owner,
    summary: req.family
      ? `Deposit ${usd(cents)} into a vault on ${entry.config.name} that follows a shared portfolio`
      : `Deposit ${usd(cents)} into your plan’s vault on ${entry.config.name}`,
    // Once, whatever the steps repeat: the approval and the deposit both carry it.
    depositRaw: plan.need.cashRaw,
    // The vault it is for, kept with it: a step is built for this number whatever becomes of the plan.
    basketId: plan.basketId,
    legs,
    warnings: [
      ...(closed
        ? [
            {
              code: 'MARKET_CLOSED',
              text: 'The US stock market is closed now. You can still deposit; stock tokens may trade at a wider price.',
            },
          ]
        : []),
      ...(plan.warnings ?? []),
    ],
    needsConsent: [],
    fees: [],
    preparedBy: ctx.principal.kind === 'service' ? 'mcp' : 'app',
    status: 'open',
    approvalUrl: `/orders/${id}`,
    expiresAt: nowSeconds + ORDER_POLICY.unsignedSeconds,
    createdAt: ctx.now,
    disclaimer: DISCLAIMER.en,
  };
  return { order, request: plan.version === undefined ? req : { ...req, version: plan.version } };
}
