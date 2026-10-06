import { createHash } from 'node:crypto';
import { rollUp } from '@colosseum/basket';
import type { Db } from '@colosseum/db';
import {
  compose,
  PersonalInputError,
  type PersonalProposal,
  type PersonalSheet,
} from '@colosseum/engine/personal';
import {
  type AssetTier,
  type BasketAsset,
  BasketProposal,
  type ChainId,
  currencyOf,
  type LiquidityProvider,
  type ObservationRef,
  type RiskRollUp,
  type Shelf,
  type Sourced,
  type YieldObservation,
} from '@colosseum/schemas';
import type { ChainRegistry } from './chains';
import { Refusal, refusing } from './errors';

// DESIGN-VAULT 3.6 and section 7: a person's goal and limits, turned into a plan made to measure by the
// engine's `compose`, on the one chain their plans live on (gates ONE-CHAIN, CHAIN-PICK). The engine
// is pure: this file hands it the shelf of that chain, the time and the figures, and turns what it
// answers into the shared `BasketProposal` that is stored and that the order layer buys.

/**
 * The figures a plan is shaped by besides the shelf, for the tokens of one chain: Bearing's measured
 * exit (gate EXIT-SOURCE) with where it comes from, and the yields. Either may be missing. Without a
 * measured exit a line's ceiling is its tier's and the plan says so (`ceiling_from_tier:<asset>`);
 * without a yield the card counts none for that token.
 */
export type PlanInputs = (q: { db: Db; chain: ChainId; assets: BasketAsset[] }) => Promise<{
  liquidity?: { provider: LiquidityProvider; source: string };
  yields?: YieldObservation[];
  /**
   * A tier that stands in for a token's own where nothing is measured (a test-network token takes its
   * model's, model-exits.ts), with where it comes from: the line's fallback says it, labelled sandbox.
   */
  tiers?: Array<{ assetId: string; tier: AssetTier } & Sourced>;
}>;

export type PersonalizeContext = {
  chains: ChainRegistry;
  /** The chain the person's plans live on. Refuses when there is none yet. */
  homeChain(): Promise<ChainId>;
  /** The shared portfolios that have a recipe on `chain`, each with that recipe as it is in effect. */
  loadFamilies(chain: ChainId): Promise<Shelf['families']>;
  inputs(chain: ChainId, assets: BasketAsset[]): ReturnType<PlanInputs>;
  /** ISO time: the plan is made at it, and the goal's date counts from it. */
  now: string;
};

type Tiers = Awaited<ReturnType<PlanInputs>>['tiers'];

/** The shelf with each tier the plan inputs stand in for a token's own. */
export function withTiers(assets: BasketAsset[], tiers: Tiers): BasketAsset[] {
  const tierOf = new Map((tiers ?? []).map((t) => [t.assetId, t.tier]));
  return assets.map((a) => {
    const tier = tierOf.get(a.id);
    return tier ? { ...a, tier } : a;
  });
}

/** A line held to a tier that is not its token's own says whose tier it is: a flag and its source. */
export function tiersSaid(proposal: BasketProposal, tiers: Tiers): BasketProposal {
  const held = new Set(proposal.lines.map((l) => l.assetId));
  const borrowed = (tiers ?? []).filter((t) => held.has(t.assetId));
  if (!borrowed.length) return proposal;
  return {
    ...proposal,
    flags: [...proposal.flags, ...borrowed.map((t) => `tier_from_model:${t.assetId}`)],
    observations: [
      ...proposal.observations,
      ...borrowed.map(({ assetId, tier: _tier, ...src }) => ({
        id: `tier ${assetId}`,
        kind: 'liquidity' as const,
        ...src,
      })),
    ],
  };
}

/**
 * What the shelf of a chain holds, as a version: the same tokens and the same shared portfolios give
 * the same string. The plan's `inputsHash` pins the content as well.
 */
export function shelfVersionOf(
  chain: ChainId,
  assets: BasketAsset[],
  families: Shelf['families'],
): string {
  const byKey = <T>(items: T[], key: (t: T) => string) =>
    [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const content = JSON.stringify({
    assets: byKey(assets, (a) => a.id),
    families: byKey(families, (f) => f.meta.slug),
  });
  return `${chain}:${createHash('sha256').update(content).digest('hex').slice(0, 16)}`;
}

/**
 * The plan in the shared shape. The limits leave the sheet (its lines already hold them), the sleeves
 * and the verdict's sentence beside the ways are not in the shape, and a figure that names no source
 * or no time is not stated as one: the plan's flags already say it (`liquidity_unsourced`,
 * `liquidity_undated:<asset>`). The result is held to the shared schema, lines adding up to 10,000.
 */
export function sharedProposal(plan: PersonalProposal): BasketProposal {
  const { limits: _limits, ...sheet } = plan.sheet;
  const { sleeves: _sleeves, ...rest } = plan;
  const observations = plan.observations.filter(
    (o): o is ObservationRef => o.source !== null && o.fetchedAt !== null,
  );
  const verdict = plan.verdict && {
    met: plan.verdict.met,
    gapUsdMonthly: plan.verdict.gapUsdMonthly,
    ways: plan.verdict.ways,
  };
  return BasketProposal.parse({
    ...rest,
    sheet,
    observations,
    ...(verdict ? { verdict } : {}),
  });
}

/**
 * A plan for this sheet on the person's chain, and its risk roll-up: concentration by issuer, chain
 * and class, and the exit figures, from the same shelf, measurements and time the plan was made with.
 * A plan not bought yet has no stored quote, so the roll-up's quoted exit is null. The sheet has been
 * validated by the route's schema, and `compose` validates it again before it computes anything. A
 * sheet for another chain than the person's is refused: a plan lives on the chain of their wallet.
 */
export async function personalize(
  sheet: PersonalSheet,
  ctx: PersonalizeContext,
): Promise<{ proposal: BasketProposal; rollUp: RiskRollUp }> {
  // Plans are in US dollars for now (gate USD-ONLY): a goal or a withdrawal in another currency is
  // refused before anything is read, rather than answered with a plan that cannot pay it.
  const other = [currencyOf(sheet), ...(sheet.obligations ?? []).map((o) => o.currency)].some(
    (c) => c !== 'USD',
  );
  if (other)
    throw new Refusal(422, 'Plans are in US dollars for now', {
      code: 'CURRENCY_UNSUPPORTED',
      fix: 'Send the goal and every withdrawal in USD.',
    });
  const chain = await ctx.homeChain();
  const asked = sheet.chains[0];
  if (sheet.chains.length !== 1 || asked !== chain)
    throw new Refusal(
      422,
      `your plans live on ${ctx.chains.name(chain)}, and this sheet names ${sheet.chains.map((c) => ctx.chains.name(c)).join(' and ')}`,
      { fix: `Make the plan for ${ctx.chains.name(chain)}: send chains ["${chain}"].` },
    );
  // Refuses a chain that is off before anything is read.
  const entry = ctx.chains.get(chain);
  const listed = await refusing(() => entry.adapter.listAssets());
  const families = await ctx.loadFamilies(chain);
  const figures = await ctx.inputs(chain, listed);
  const assets = withTiers(listed, figures.tiers);
  const shelf: Shelf = { version: shelfVersionOf(chain, assets, families), assets, families };
  let plan: PersonalProposal;
  try {
    plan = compose(sheet, shelf, {
      now: ctx.now,
      ...(figures.yields ? { yields: figures.yields } : {}),
      ...(figures.liquidity
        ? { liquidity: figures.liquidity.provider, liquiditySource: figures.liquidity.source }
        : {}),
    });
  } catch (e) {
    // The sheet is the caller's to fix. A shelf, a figure or a parameter the engine cannot run on is
    // the server's, and fails as one.
    if (e instanceof PersonalInputError && e.code === 'InvalidSheet')
      throw new Refusal(422, `no plan can be made from this sheet: ${e.message}`);
    // A withdrawal in another currency needs an exchange rate, and this server reads none yet: the
    // sheet is the caller's to change, so it is refused as one, never a server error.
    if (
      e instanceof PersonalInputError &&
      e.code === 'InvalidContext' &&
      e.issues.length > 0 &&
      e.issues.every((i) => i.path === 'fx')
    )
      throw new Refusal(422, `no plan can be made from this sheet: ${e.message}`, {
        fix: 'Send the withdrawals in USD: this server does not read exchange rates yet.',
      });
    throw e;
  }
  const proposal = tiersSaid(sharedProposal(plan), figures.tiers);
  return {
    proposal,
    rollUp: rollUp(
      proposal.lines.map((l) => ({ asset: l.assetId, amountUsd: l.amountUsd })),
      {
        shelf,
        ...(figures.liquidity ? { liquidity: figures.liquidity.provider } : {}),
        quotes: [],
        now: ctx.now,
      },
    ),
  };
}
