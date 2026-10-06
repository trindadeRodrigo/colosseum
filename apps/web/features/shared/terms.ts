import { Hex32, Target } from '@colosseum/schemas';

// What a shared-portfolio order is held to, as the screen that made it showed it (WEB-4). The order
// screen hands these to the executor (features/order/run-order.ts), which turns them into the guard's
// terms: the family id and the text of a publish are the form's; the portfolio and the version a
// follow names are the ones this app read from the chain where it could (`source: 'chain'`), and the
// API's answer, shown as unverified, where it could not (`source: 'api'`). Never the order the API
// answered.

/** The portfolio a vault follows, at the version the person reviewed. */
export type FollowTerms = { recipeOnchainId: string; version: number };

/** Where a follow's terms came from: the chain, read by this app, or the API's word. */
export type TermsSource = 'chain' | 'api';

export type PublishText = { slug: string; name: string; copy: string; kind: 'index' };

export type SharedTerms =
  /** A buy that opens a vault following a shared portfolio. */
  | {
      kind: 'family';
      slug: string;
      familyId: string;
      follow: FollowTerms;
      /** The version's assets and weights, which the buy's trades are held to. */
      targets: Target[];
      source: TermsSource;
    }
  /** A vault the person has, made to follow a portfolio, or its auto-follow switched. */
  | {
      kind: 'follow';
      slug: string;
      familyId: string;
      vault: string;
      /** The plan number of that vault, held to its address where this app can derive it. */
      basketId: string;
      /** Null when the order only switches auto-follow on a vault that follows the version already. */
      follow: FollowTerms | null;
      autoFollow: boolean;
      source: TermsSource;
    }
  /**
   * A withdrawal from a vault the person owns, as its review showed it: each token that leaves, with
   * the amount of it (null: all the vault holds of it), for the owner's own wallet. `everything`: the
   * person asked for all the vault holds, and the list is what it held when they looked.
   */
  | {
      kind: 'withdraw';
      vault: string;
      /** The plan number of that vault, held to its address where this app can derive it. */
      basketId: string;
      /** Where every token goes: the vault's owner, who is the person signing. */
      owner: string;
      everything: boolean;
      items: WithdrawItem[];
    }
  /** A creator's publish, with the text and the weights of the form. */
  | {
      kind: 'publish';
      action: 'publish' | 'update';
      familyId: string;
      components: Target[];
      text: PublishText;
      version: number;
    };

/** One token of a withdrawal: how much leaves (null: all of it), and what the vault held at the review. */
export type WithdrawItem = { asset: string; amountRaw: string | null; heldRaw: string };

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const RAW = /^\d+$/;
const isText = (v: unknown): v is string => typeof v === 'string';
const isSlug = (v: unknown): v is string => isText(v) && SLUG.test(v);
const isVersion = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;
const isFamily = (v: unknown): v is string => Hex32.safeParse(v).success;
const targetsOf = (v: unknown): Target[] | null => {
  const read = Target.array().min(1).safeParse(v);
  return read.success ? read.data : null;
};
const followOf = (v: unknown): FollowTerms | null => {
  const f = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  return isText(f.recipeOnchainId) && f.recipeOnchainId.length > 0 && isVersion(f.version)
    ? { recipeOnchainId: f.recipeOnchainId, version: f.version }
    : null;
};
const sourceOf = (v: unknown): TermsSource | null => (v === 'chain' || v === 'api' ? v : null);

/** Terms as they were written, or null when any part does not read. */
export function readTerms(value: unknown): SharedTerms | null {
  if (typeof value !== 'object' || value === null) return null;
  const t = value as Record<string, unknown>;
  if (t.kind === 'family') {
    const follow = followOf(t.follow);
    const targets = targetsOf(t.targets);
    const source = sourceOf(t.source);
    if (!isSlug(t.slug) || !isFamily(t.familyId) || !follow || !targets || !source) return null;
    return { kind: 'family', slug: t.slug, familyId: t.familyId, follow, targets, source };
  }
  if (t.kind === 'follow') {
    const follow = t.follow === null ? null : followOf(t.follow);
    const source = sourceOf(t.source);
    if (
      !isSlug(t.slug) ||
      !isFamily(t.familyId) ||
      !isText(t.vault) ||
      !t.vault ||
      !isText(t.basketId) ||
      !/^\d+$/.test(t.basketId) ||
      (t.follow !== null && !follow) ||
      typeof t.autoFollow !== 'boolean' ||
      !source
    )
      return null;
    return {
      kind: 'follow',
      slug: t.slug,
      familyId: t.familyId,
      vault: t.vault,
      basketId: t.basketId,
      follow,
      autoFollow: t.autoFollow,
      source,
    };
  }
  if (t.kind === 'withdraw') {
    const items = Array.isArray(t.items) ? (t.items as Record<string, unknown>[]) : null;
    if (
      !isText(t.vault) ||
      !t.vault ||
      !isText(t.basketId) ||
      !RAW.test(t.basketId) ||
      !isText(t.owner) ||
      !t.owner ||
      typeof t.everything !== 'boolean' ||
      !items?.length ||
      !items.every(
        (i) =>
          typeof i === 'object' &&
          i !== null &&
          isText(i.asset) &&
          i.asset.includes(':') &&
          (i.amountRaw === null || (isText(i.amountRaw) && RAW.test(i.amountRaw))) &&
          isText(i.heldRaw) &&
          RAW.test(i.heldRaw),
      ) ||
      new Set(items.map((i) => i.asset)).size !== items.length ||
      // Everything names no amount: each token leaves in full.
      (t.everything && items.some((i) => i.amountRaw !== null))
    )
      return null;
    return {
      kind: 'withdraw',
      vault: t.vault,
      basketId: t.basketId,
      owner: t.owner,
      everything: t.everything,
      items: items.map((i) => ({
        asset: i.asset as string,
        amountRaw: i.amountRaw as string | null,
        heldRaw: i.heldRaw as string,
      })),
    };
  }
  if (t.kind === 'publish') {
    const components = targetsOf(t.components);
    const x = (typeof t.text === 'object' && t.text !== null ? t.text : {}) as Record<
      string,
      unknown
    >;
    if (
      (t.action !== 'publish' && t.action !== 'update') ||
      !isFamily(t.familyId) ||
      !components ||
      !isSlug(x.slug) ||
      !isText(x.name) ||
      !x.name ||
      !isText(x.copy) ||
      x.kind !== 'index' ||
      !isVersion(t.version)
    )
      return null;
    return {
      kind: 'publish',
      action: t.action,
      familyId: t.familyId,
      components,
      text: { slug: x.slug, name: x.name, copy: x.copy, kind: 'index' },
      version: t.version,
    };
  }
  return null;
}

/**
 * The trades a deposit makes for these targets, as the API plans them (`tradesFor` of
 * apps/api/src/orders/prepare.ts): the invested share of the deposit split by weight, each share
 * rounded down and what is left given to the first of the largest weights. A buy of a portfolio is
 * held to this, so the API cannot spend the deposit on other weights than the ones read.
 */
export function tradesOf(
  targets: readonly Target[],
  depositRaw: bigint,
): { asset: string; amountInRaw: string }[] {
  const sum = targets.reduce((n, t) => n + t.weightBps, 0);
  if (sum === 0) return targets.map((t) => ({ asset: t.asset, amountInRaw: '0' }));
  const invested = (depositRaw * BigInt(sum)) / 10_000n;
  const shares = targets.map((t) => (invested * BigInt(t.weightBps)) / BigInt(sum));
  let largest = 0;
  targets.forEach((t, i) => {
    if (t.weightBps > (targets[largest]?.weightBps ?? 0)) largest = i;
  });
  shares[largest] = (shares[largest] ?? 0n) + invested - shares.reduce((n, s) => n + s, 0n);
  return targets.map((t, i) => ({ asset: t.asset, amountInRaw: String(shares[i] ?? 0n) }));
}
