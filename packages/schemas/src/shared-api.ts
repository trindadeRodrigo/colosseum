import { z } from 'zod';
import { Address, AssetId, ChainId, Hex32 } from './chain';
import { Provenance } from './enums';
import { Target } from './recipe';

// The shared-portfolio routes (API-3, DESIGN-VAULT section 6): the shelf, a shared portfolio's page and
// its versions. Publishing and following are orders (POST /v1/orders, order.ts). Named once so the API,
// the SDK and the web read the same shapes.

/** The path of the two routes of one shared portfolio: GET /v1/indexes/{slug} and .../versions. */
export const FamilyRouteParams = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) });
export type FamilyRouteParams = z.infer<typeof FamilyRouteParams>;

/** The query of the shelf and of a shared portfolio's page: only what has a recipe on this chain. */
export const SharedChainQuery = z.object({ chain: ChainId.optional() });
export type SharedChainQuery = z.infer<typeof SharedChainQuery>;

/** One version of a recipe: the registry's numbers, and where it stands. */
export const RecipeVersionView = z.object({
  version: z.number().int().min(1),
  /** Unix seconds. */
  effectiveAt: z.number().int().nonnegative(),
  components: z.array(Target),
  /** The hash of the text the creator published with this version (DESIGN-VAULT 3.1). */
  metaHash: Hex32,
  /**
   * `active` is in effect, `pending` waits for its time. `superseded` was in effect, or waited and is
   * no longer seen on the chain while a later version is: without events the two are not told apart.
   * `cancelled` waited and was taken back before any later version took effect.
   */
  status: z.enum(['active', 'pending', 'superseded', 'cancelled']),
});
export type RecipeVersionView = z.infer<typeof RecipeVersionView>;

/**
 * Whether the app offers the auto-follow switch on this recipe (gate `GOLD-ONE-TAP`). Not offered
 * when a version holds an asset with no oracle (`no_oracle`, with those assets): its followers get the
 * one-tap prompt instead. Not offered either where the chain runs no keeper path (`switched_off`).
 */
export const AutoFollowOffer = z.discriminatedUnion('offered', [
  z.object({ offered: z.literal(true) }),
  z.object({
    offered: z.literal(false),
    reason: z.enum(['no_oracle', 'switched_off']),
    /** For `no_oracle`: the assets with no oracle on this chain. Empty otherwise. */
    assets: z.array(AssetId),
  }),
]);
export type AutoFollowOffer = z.infer<typeof AutoFollowOffer>;

/** A family's recipe on one chain. */
export const SharedRecipe = z.object({
  chain: ChainId,
  /** The chain's name as a person reads it. */
  name: z.string(),
  /** The recipe's id on the chain: on Solana the recipe account. What a follow's guard terms name. */
  onchainId: z.string().min(1),
  creator: Address,
  /** The version in effect. */
  active: RecipeVersionView,
  /** The version that waits for its time, with the time. */
  pending: RecipeVersionView.nullable(),
  autoFollow: AutoFollowOffer,
  /**
   * Which of the two versions the family's text (`name`, `copy`) is the text of: the one whose hash it
   * matches. Null when it matches neither, which a screen shows as text it cannot vouch for.
   */
  textMatches: z.enum(['active', 'pending']).nullable(),
  /**
   * `chain` when the versions were read from the chain for this answer; `cache` when they are the last
   * the server stored (the shelf, a chain that is off or did not answer).
   */
  source: z.enum(['chain', 'cache']),
  /** When the versions were read from the chain, or, from the cache, when the newest was stored. ISO time. */
  observedAt: z.string().datetime(),
  /** The label of the chain the recipe is on: `mock`, `sandbox` (a test network) or `live`. */
  provenance: Provenance,
});
export type SharedRecipe = z.infer<typeof SharedRecipe>;

/**
 * A shared portfolio as the shelf and its page show it. Its text (`name`, `copy`) is the creator's and
 * untrusted: each recipe says which of its versions the text is the text of (`textMatches`).
 */
export const SharedFamily = z.object({
  familyId: Hex32,
  slug: z.string(),
  name: z.string(),
  copy: z.string(),
  kind: z.enum(['index', 'single']),
  /** The platform badge: published by the platform's own creator address. */
  platform: z.boolean(),
  creatorKind: z.enum(['platform', 'community']),
  /** The chains it has a recipe on. */
  chains: z.array(ChainId),
  recipes: z.array(SharedRecipe),
});
export type SharedFamily = z.infer<typeof SharedFamily>;

/** GET /v1/shelf: every shared portfolio, or those with a recipe on `chain`, from the server's store. */
export const ShelfResponse = z.object({ families: z.array(SharedFamily), disclaimer: z.string() });
export type ShelfResponse = z.infer<typeof ShelfResponse>;

/** GET /v1/indexes/{slug}: one shared portfolio, its recipes read from their chains. */
export const FamilyResponse = z.object({ family: SharedFamily, disclaimer: z.string() });
export type FamilyResponse = z.infer<typeof FamilyResponse>;

/** GET /v1/indexes/{slug}/versions: every version the server has seen, per chain, newest first. */
export const VersionsResponse = z.object({
  familyId: Hex32,
  slug: z.string(),
  chains: z.array(
    z.object({
      chain: ChainId,
      onchainId: z.string().min(1),
      source: z.enum(['chain', 'cache']),
      observedAt: z.string().datetime(),
      provenance: Provenance,
      versions: z.array(RecipeVersionView),
    }),
  ),
});
export type VersionsResponse = z.infer<typeof VersionsResponse>;
