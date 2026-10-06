import type { Asset, AssetClass, AssetKind, BasketAsset, Profile } from '@colosseum/schemas';
import { isEligible } from '../assets/eligibility';
import type { GoalKind, Sleeve } from './types';

// How the personalization engine reads the asset registry. A token on the shelf (`BasketAsset`) has a
// class and no eligibility of its own, so each class is given the registry row the structurer's
// `isEligible` takes, and that function decides. The rule that stock tokens stay out of income plans
// is its rule, applied here to every token, with no case of its own in `compose`. The rule that a
// plan to protect holds dollar yield, gold and cash only (gate PROTECT-NO-STOCKS, Oct 3) is in the
// rows below: the profile a goal to protect is checked under is on those three classes and no other.

/** Which sleeve a class of asset sits in. `growth` is stocks and crypto. */
const SLEEVE_OF_CLASS: Record<AssetClass, Sleeve> = {
  stock: 'growth',
  etf: 'growth',
  crypto: 'growth',
  gold: 'gold',
  commodity: 'gold',
  dollar_yield: 'dollarYield',
  cash: 'cash',
};

/**
 * The registry kind of a class. The registry knows four kinds, and `equity` is the one for what has
 * a price and pays no coupon: its haircut rule reads "stocks and gold pay no coupon".
 */
const KIND_OF_CLASS: Record<AssetClass, AssetKind> = {
  stock: 'equity',
  etf: 'equity',
  crypto: 'equity',
  gold: 'equity',
  commodity: 'equity',
  dollar_yield: 'usd_yield',
  cash: 'cash',
};

const EVERY_PROFILE: Profile[] = ['income', 'accumulation', 'high_risk'];
/**
 * The profiles a class is eligible for. A goal to grow may hold every class. A goal to protect holds
 * dollar yield, gold and cash: no stock token, no crypto, no other commodity. A goal of income is
 * listed only where the class pays: `isEligible` refuses the rest whatever the row says.
 */
const PROFILES_OF_CLASS: Record<AssetClass, Profile[]> = {
  stock: ['high_risk'],
  etf: ['high_risk'],
  crypto: ['high_risk'],
  commodity: ['high_risk'],
  gold: ['accumulation', 'high_risk'],
  dollar_yield: EVERY_PROFILE,
  cash: EVERY_PROFILE,
};

/** The registry profile a goal is checked under. */
const PROFILE_OF_GOAL: Record<GoalKind, Profile> = {
  income: 'income',
  protect: 'accumulation',
  grow: 'high_risk',
};

export const sleeveOfClass = (cls: AssetClass): Sleeve => SLEEVE_OF_CLASS[cls];
export const profileOfGoal = (goal: GoalKind): Profile => PROFILE_OF_GOAL[goal];

/** The registry row of a token on the shelf: what `isEligible` reads. */
export function registryRowOf(
  asset: Pick<BasketAsset, 'cls'>,
): Pick<Asset, 'kind' | 'eligibleProfiles' | 'mintPath'> {
  return {
    kind: KIND_OF_CLASS[asset.cls],
    eligibleProfiles: PROFILES_OF_CLASS[asset.cls],
    mintPath: 'dex_swap',
  };
}

/** Whether a token may be in a plan for this goal, by the registry's own rule. */
export function eligibleForGoal(asset: Pick<BasketAsset, 'cls'>, goal: GoalKind): boolean {
  return isEligible(registryRowOf(asset), profileOfGoal(goal));
}
