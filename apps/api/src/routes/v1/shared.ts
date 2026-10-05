import { metaHash } from '@colosseum/basket';
import {
  ChainError,
  DISCLAIMER,
  FamilyResponse,
  FamilyRouteParams,
  OrderError,
  type RecipeVersionView,
  SharedChainQuery,
  type SharedFamily,
  type SharedRecipe,
  ShelfResponse,
  VersionsResponse,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ChainEntry } from '../../orders/chains';
import { Refusal, refusing } from '../../orders/errors';
import {
  allFamilies,
  familyBySlug,
  recipeView,
  type StoredFamily,
  type StoredRecipe,
  syncVersions,
  versionView,
} from '../../orders/families';
import type { OrderDeps } from '../../orders/legs';
import { autoFollowOffer, readRecipe } from '../../orders/shared';

// The shared-portfolio reads (API-3, DESIGN-VAULT sections 6 and 11): the shelf, a shared portfolio's
// page and its versions. Nobody has to sign in: they are the same for everyone. Publishing and
// following are orders (POST /v1/orders).

/** The adapter of a chain the server runs, or null for one that is off: its recipes are not served. */
function entryOf(deps: OrderDeps, recipe: StoredRecipe): ChainEntry | null {
  try {
    return deps.chains.get(recipe.chain);
  } catch (e) {
    if (e instanceof Refusal) return null;
    throw e;
  }
}

type Versions = {
  active: RecipeVersionView;
  pending: RecipeVersionView | null;
  source: 'chain' | 'cache';
  observedAt: string;
};

/** The versions as the server last stored them, or null when it has none in effect. */
function cached(recipe: StoredRecipe): Versions | null {
  const active = recipe.versions.find((v) => v.status === 'active');
  if (!active) return null;
  const pending = recipe.versions.find((v) => v.status === 'pending');
  const newest = Math.max(...recipe.versions.map((v) => v.createdAt.getTime()));
  return {
    active: versionView(active),
    pending: pending ? versionView(pending) : null,
    source: 'cache',
    observedAt: new Date(newest).toISOString(),
  };
}

/**
 * The versions as the chain has them now, written to the store on the way. A chain that does not
 * answer gives the stored ones; a chain that has no such recipe gives none.
 */
async function onChain(
  deps: OrderDeps,
  entry: ChainEntry,
  recipe: StoredRecipe,
): Promise<Versions | null> {
  let read: Awaited<ReturnType<typeof readRecipe>>;
  try {
    read = await readRecipe(entry, recipe.onchainId);
  } catch (e) {
    if (e instanceof ChainError) return cached(recipe);
    throw e;
  }
  if (!read) return null;
  await syncVersions(deps.db, recipe.id, read);
  return {
    active: recipeView(read.active, 'active'),
    pending: read.pending ? recipeView(read.pending, 'pending') : null,
    source: 'chain',
    observedAt: deps.now().toISOString(),
  };
}

async function recipeOf(
  deps: OrderDeps,
  family: StoredFamily,
  recipe: StoredRecipe,
  read: boolean,
): Promise<SharedRecipe | null> {
  const entry = entryOf(deps, recipe);
  if (!entry) return null;
  const versions = read ? await onChain(deps, entry, recipe) : cached(recipe);
  if (!versions) return null;
  const { active, pending } = versions;
  const assets = await refusing(() => entry.adapter.listAssets());
  const hash = metaHash({
    familyId: family.familyId,
    slug: family.slug,
    name: family.name,
    copy: family.copy,
    kind: family.kind,
  });
  return {
    chain: recipe.chain,
    name: entry.config.name,
    onchainId: recipe.onchainId,
    creator: recipe.creator,
    active,
    pending,
    autoFollow: autoFollowOffer(
      entry,
      [active, ...(pending ? [pending] : [])].map((v) => v.components),
      assets,
    ),
    textMatches:
      active.metaHash === hash ? 'active' : pending?.metaHash === hash ? 'pending' : null,
    source: versions.source,
    observedAt: versions.observedAt,
    provenance: entry.provenance,
  };
}

async function familyOf(
  deps: OrderDeps,
  family: StoredFamily,
  chain: SharedChainQuery['chain'],
  read: boolean,
): Promise<SharedFamily> {
  const recipes: SharedRecipe[] = [];
  for (const r of family.recipes) {
    if (chain && r.chain !== chain) continue;
    const view = await recipeOf(deps, family, r, read);
    if (view) recipes.push(view);
  }
  return {
    familyId: family.familyId,
    slug: family.slug,
    name: family.name,
    copy: family.copy,
    kind: family.kind,
    platform: family.platform,
    creatorKind: family.creatorKind,
    chains: family.recipes.map((r) => r.chain),
    recipes,
  };
}

async function familyNamed(deps: OrderDeps, slug: string): Promise<StoredFamily> {
  const family = await familyBySlug(deps.db, slug);
  if (!family) throw new Refusal(404, 'no shared portfolio with that slug');
  return family;
}

export function registerSharedRoutes(scope: FastifyInstance, deps: OrderDeps) {
  const f = scope.withTypeProvider<ZodTypeProvider>();
  const tags = ['shared portfolios'];

  f.get(
    '/v1/shelf',
    {
      config: { auth: 'public', limit: 'standard' },
      schema: {
        tags,
        summary: 'Every shared portfolio, or those with a recipe on one chain',
        description:
          "From the server's store, not the chains: each recipe's versions are the last the server read (`source: 'cache'`). A signed-in person is offered only the portfolios with a recipe on their own chain: pass `chain`. A recipe on a chain this server has switched off is left out. `autoFollow` says whether the auto-follow switch is offered: not on a portfolio that holds an asset with no price oracle on that chain, whose followers get the one-tap prompt instead. `name` and `copy` are the creator's words: `textMatches` says which version's hash they match, if any.",
        querystring: SharedChainQuery,
        response: { 200: ShelfResponse, default: OrderError },
      },
    },
    async (req) => {
      const { chain } = req.query;
      const families: SharedFamily[] = [];
      for (const stored of await allFamilies(deps.db)) {
        if (chain && !stored.recipes.some((r) => r.chain === chain)) continue;
        const family = await familyOf(deps, stored, chain, false);
        if (chain && !family.recipes.length) continue;
        families.push(family);
      }
      return { families, disclaimer: DISCLAIMER.en };
    },
  );

  f.get(
    '/v1/indexes/:slug',
    {
      config: { auth: 'public', limit: 'standard' },
      schema: {
        tags,
        summary: 'A shared portfolio, its recipes read from their chains',
        description:
          "Each recipe is read from its chain for this answer (`source: 'chain'`): the version in effect and the one that waits, with its time. Where the chain does not answer, the last versions the server read (`source: 'cache'`). `onchainId` and the version in effect are what a follow names. `chain` limits the answer to one chain's recipe. `autoFollow.offered` is false on a portfolio that holds an asset with no price oracle (gate GOLD-ONE-TAP).",
        params: FamilyRouteParams,
        querystring: SharedChainQuery,
        response: { 200: FamilyResponse, default: OrderError },
      },
    },
    async (req) => ({
      family: await familyOf(deps, await familyNamed(deps, req.params.slug), req.query.chain, true),
      disclaimer: DISCLAIMER.en,
    }),
  );

  f.get(
    '/v1/indexes/:slug/versions',
    {
      config: { auth: 'public', limit: 'standard' },
      schema: {
        tags,
        summary: 'Every version of a shared portfolio the server has seen, per chain, newest first',
        description:
          "The version in effect and the one that waits are read from the chain for this answer; older ones are the server's record. A version taken back before anything later took effect is `cancelled`; one no longer seen on the chain while a later one is in effect is `superseded`, whether it took effect or was taken back, since no event is read.",
        params: FamilyRouteParams,
        querystring: SharedChainQuery,
        response: { 200: VersionsResponse, default: OrderError },
      },
    },
    async (req) => {
      const family = await familyNamed(deps, req.params.slug);
      const chains: VersionsResponse['chains'] = [];
      for (const recipe of family.recipes) {
        if (req.query.chain && recipe.chain !== req.query.chain) continue;
        const entry = entryOf(deps, recipe);
        if (!entry) continue;
        const read = await onChain(deps, entry, recipe);
        if (!read) continue;
        // Read again: the chain's answer was just written beside what the server had.
        const fresh = (await familyBySlug(deps.db, family.slug))?.recipes.find(
          (r) => r.id === recipe.id,
        );
        chains.push({
          chain: recipe.chain,
          onchainId: recipe.onchainId,
          source: read.source,
          observedAt: read.observedAt,
          provenance: entry.provenance,
          versions: (fresh ?? recipe).versions.map(versionView),
        });
      }
      return { familyId: family.familyId, slug: family.slug, chains };
    },
  );
}
