import {
  CreatorLimitReason,
  type LimitContext,
  type LimitResult,
  type Target,
} from '@colosseum/schemas';

// The four limits on what an author may publish as a shared portfolio (DESIGN-VAULT section 6, decided
// on Oct 2): 3 to 12 listed assets, never the cash token, each from 2% up to its ceiling in 50 bps
// steps and adding up to 100%; one version per publish delay and none while one is pending; a version
// moves at most 20% of the portfolio; a later version takes effect one publish delay after it is
// published. There is one delay: it is both the notice a follower gets and the least time between two
// versions. The first version takes effect at once and is exempt from the delay and from turnover.
//
// The Solana program and the EVM registry enforce the same rules. All three are tested against
// fixtures/creator-limits/vectors.json, and the README beside it defines each rule.

export const CREATOR_LIMITS = {
  minAssets: 3,
  maxAssets: 12,
  minWeightBps: 200,
  /** No asset is above 50%, whatever its own ceiling. */
  maxWeightBps: 5000,
  stepBps: 50,
  sumBps: 10_000,
  maxTurnoverBps: 2000,
} as const;

/**
 * The rules, in the order a refusal names them: the lowest one a version breaks is its reason. The
 * list is `CreatorLimitReason` of packages/schemas, which holds the names and their numbering.
 */
export const LIMIT_REASONS = CreatorLimitReason.options;

/** What a chain answers for any of them (`ChainErrorCode`); the reason goes in the message. */
export const CREATOR_LIMIT_ERROR = 'CreatorLimit' as const;

/** The two values a first publish carries beside the weights. Both must be zero in the MVP. */
export type RecipeHeader = { flags: number; maxFeeBps: number };

type Refusal = Extract<LimitResult, { ok: false }>;
const refuse = (code: CreatorLimitReason, detail: string): Refusal => ({
  ok: false,
  code,
  detail,
});

const pct = (bps: number) => `${bps / 100}%`;

/** The ceiling of one asset: 50%, or its own `maxWeightBps` when that is lower. */
export function ceilingBps(maxWeightBps: number): number {
  return Math.min(CREATOR_LIMITS.maxWeightBps, maxWeightBps);
}

/**
 * The sum of the absolute weight changes over every asset in either version, in bps. An added asset
 * counts from zero and a removed one to zero. This is the number the limit is on: at most 4,000,
 * twice `maxTurnoverBps`, so no division is needed to check it.
 */
export function movedBps(prev: readonly Target[], next: readonly Target[]): number {
  const before = new Map<string, number>();
  for (const t of prev) before.set(t.asset, (before.get(t.asset) ?? 0) + t.weightBps);
  const after = new Map<string, number>();
  for (const t of next) after.set(t.asset, (after.get(t.asset) ?? 0) + t.weightBps);
  let moved = 0;
  for (const [asset, weight] of after) moved += Math.abs(weight - (before.get(asset) ?? 0));
  for (const [asset, weight] of before) if (!after.has(asset)) moved += weight;
  return moved;
}

/**
 * How much of the portfolio a version moves, in bps: half of `movedBps`. Both versions add up to
 * 10,000, so the sum is even; for any other input the half is rounded up.
 */
export function turnoverBps(prev: readonly Target[], next: readonly Target[]): number {
  return Math.ceil(movedBps(prev, next) / 2);
}

/** When a version published now takes effect: at once for the first, one delay later after it. */
export function versionEffectiveAt(
  prev: readonly Target[] | null,
  ctx: Pick<LimitContext, 'now' | 'publishDelay'>,
): number {
  return prev === null ? ctx.now : ctx.now + ctx.publishDelay;
}

/**
 * Whether `next` may be published over `prev` (null for a first version). Pure: the time, the asset
 * list and the registry's state come in through `ctx`. A refusal carries the lowest-numbered rule
 * broken, in `LIMIT_REASONS` order, and a sentence with the numbers.
 *
 * The platform list in `ctx.assets` marks the chain's cash token with `cls: 'cash'`; a shared
 * portfolio may not hold it. `ctx.publishDelay` is the seconds between two versions, and between a
 * later version and its taking effect.
 *
 * A version refused only for being too soon carries `allowedAt`: published at or after that time,
 * with nothing else changed, it is accepted. A version that is too soon and breaks a later rule as
 * well carries none, and neither does any other refusal.
 *
 * Nothing here trusts the input to have passed a schema: a weight of zero, a repeated asset and a sum
 * that is off are refused by name.
 */
export function checkCreatorLimits(
  prev: Target[] | null,
  next: Target[],
  ctx: LimitContext,
  header: RecipeHeader = { flags: 0, maxFeeBps: 0 },
): LimitResult {
  const L = CREATOR_LIMITS;
  // A missing delay or time would make every comparison below false and let a version through.
  for (const [name, value] of [
    ['publishDelay', ctx.publishDelay],
    ['now', ctx.now],
    ['lastPublishAt', ctx.lastPublishAt ?? 0],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(`${name} must be a whole number of seconds, 0 or more`);
  if (header.maxFeeBps !== 0) return refuse('FeeNotZero', 'a shared portfolio charges no fee');
  if (header.flags !== 0) return refuse('FlagsNotZero', 'flags must be zero');

  if (next.length < L.minAssets)
    return refuse(
      'TooFewAssets',
      `a shared portfolio holds at least ${L.minAssets} assets; this one has ${next.length}`,
    );
  if (next.length > L.maxAssets)
    return refuse(
      'TooManyAssets',
      `a shared portfolio holds at most ${L.maxAssets} assets; this one has ${next.length}`,
    );

  const listed = new Map(ctx.assets.map((a) => [a.id, a.maxWeightBps]));
  const unlisted = next.find((t) => !listed.has(t.asset));
  if (unlisted) return refuse('AssetNotListed', `${unlisted.asset} is not on the platform list`);

  const seen = new Set<string>();
  for (const t of next) {
    if (seen.has(t.asset)) return refuse('DuplicateAsset', `${t.asset} appears more than once`);
    seen.add(t.asset);
  }

  const low = next.find((t) => t.weightBps < L.minWeightBps);
  if (low)
    return refuse(
      'WeightBelowMin',
      `${low.asset} is at ${pct(low.weightBps)}; the least is ${pct(L.minWeightBps)}`,
    );
  // Not `% step !== 0` alone: a weight that is not a whole number is off the step too.
  const offStep = next.find((t) => !Number.isInteger(t.weightBps / L.stepBps));
  if (offStep)
    return refuse(
      'WeightOffStep',
      `${offStep.asset} is at ${offStep.weightBps} bps; weights move in steps of ${L.stepBps} bps`,
    );
  for (const t of next) {
    const ceiling = ceilingBps(listed.get(t.asset) ?? 0);
    if (t.weightBps > ceiling)
      return refuse(
        'WeightAboveCeiling',
        `${t.asset} is at ${pct(t.weightBps)}; its ceiling is ${pct(ceiling)}`,
      );
  }

  const sum = next.reduce((n, t) => n + t.weightBps, 0);
  if (sum !== L.sumBps)
    return refuse('WeightSum', `the weights add up to ${pct(sum)}, not ${pct(L.sumBps)}`);

  // Rules 11 to 13 are about a version that follows another. The first takes effect at once and has
  // nothing to wait for and nothing to be measured against, whatever the context says.
  if (prev !== null && ctx.hasPending)
    return refuse('VersionPending', 'a version is already published and not yet in effect');
  const allowedAt =
    prev !== null && ctx.lastPublishAt !== null ? ctx.lastPublishAt + ctx.publishDelay : null;
  const tooSoon = allowedAt !== null && ctx.now < allowedAt;

  // Rules 13 and 14 do not depend on the time, so they say whether waiting is all a version needs.
  const later = ((): LimitResult => {
    let turnover = 0;
    if (prev !== null) {
      const moved = movedBps(prev, next);
      if (moved > 2 * L.maxTurnoverBps)
        return refuse(
          'TurnoverTooHigh',
          `this version moves ${pct(moved / 2)} of the portfolio; the most is ${pct(L.maxTurnoverBps)}`,
        );
      turnover = Math.ceil(moved / 2);
    }
    const cash = new Set(ctx.assets.filter((a) => a.cls === 'cash').map((a) => a.id));
    const held = next.find((t) => cash.has(t.asset));
    if (held)
      return refuse(
        'CashNotAllowed',
        `${held.asset} is the cash token; a shared portfolio holds assets`,
      );
    return { ok: true, turnoverBps: turnover };
  })();

  if (tooSoon)
    return {
      ...refuse(
        'VersionTooSoon',
        `the next version can be published in ${allowedAt - ctx.now} seconds, at ${allowedAt}`,
      ),
      ...(later.ok ? { allowedAt } : {}),
    };
  return later;
}
