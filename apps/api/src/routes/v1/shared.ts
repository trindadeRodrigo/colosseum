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
import { figuresOf } from '../../orders/figures';
import type { OrderDeps } from '../../orders/legs';
import type { PlanInputs } from '../../orders/personalize';
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

/**
 * The plan inputs of a chain (the stored yields, Bearing's sell depth), read once for an answer
 * however many recipes it has on that chain. A read that fails is no figures, never a failed answer.
 */
type Figures = (entry: ChainEntry) => Promise<Awaited<ReturnType<PlanInputs>> | null>;
function figuresReader(deps: OrderDeps, planInputs: PlanInputs): Figures {
  const byChain = new Map<string, ReturnType<Figures>>();
  return (entry) => {
    const kept = byChain.get(entry.chain);
    if (kept) return kept;
    const read = (async () => {
      try {
        const assets = await entry.adapter.listAssets();
        return await planInputs({
          db: deps.db,
          chain: entry.chain,
          assets,
          provenance: entry.provenance,
        });
      } catch {
        return null;
      }
    })();
    byChain.set(entry.chain, read);
    return read;
  };
}

async function recipeOf(
  deps: OrderDeps,
  family: StoredFamily,
  recipe: StoredRecipe,
  read: boolean,
  figures: Figures,
): Promise<SharedRecipe | null> {
  const entry = entryOf(deps, recipe);
  if (!entry) return null;
  const versions = read ? await onChain(deps, entry, recipe) : cached(recipe);
  if (!versions) return null;
  const { active, pending } = versions;
  const assets = await refusing(() => entry.adapter.listAssets());
  const inputs = await figures(entry);
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
    ...(inputs
      ? { figures: figuresOf(active.components, assets, inputs, deps.now().toISOString()) }
      : {}),
  };
}

async function familyOf(
  deps: OrderDeps,
  family: StoredFamily,
  chain: SharedChainQuery['chain'],
  read: boolean,
  figures: Figures,
): Promise<SharedFamily> {
  const recipes: SharedRecipe[] = [];
  for (const r of family.recipes) {
    if (chain && r.chain !== chain) continue;
    const view = await recipeOf(deps, family, r, read, figures);
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

export function registerSharedRoutes(
  scope: FastifyInstance,
  deps: OrderDeps,
  planInputs: PlanInputs = async () => ({}),
) {
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
          "From the server's store, not the chains: each recipe's versions are the last the server read (`source: 'cache'`). With no `chain`, every portfolio, each with the chains it has a recipe on (`chains`): the app lists them together, each labelled with its chains (gate CHAIN-AT-THE-PLAN). `chain` limits the answer to the portfolios with a recipe on that chain. A recipe on a chain this server has switched off is left out. `autoFollow` says whether the auto-follow switch is offered: not on a portfolio that holds an asset with no price oracle on that chain, whose followers get the one-tap prompt instead. `name` and `copy` are the creator's words: `textMatches` says which version's hash they match, if any. `figures` is what the server has measured about the version in effect, the readings a plan is made from: each holding's stored yield and the most of it that can be sold within the exit window (each null where the server has none, never zero). Nothing is added up across the holdings.",
        querystring: SharedChainQuery,
        response: { 200: ShelfResponse, default: OrderError },
      },
    },
    async (req) => {
      const { chain } = req.query;
      const families: SharedFamily[] = [];
      const figures = figuresReader(deps, planInputs);
      for (const stored of await allFamilies(deps.db)) {
        const family = await familyOf(deps, stored, chain, false, figures);
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
      family: await familyOf(
        deps,
        await familyNamed(deps, req.params.slug),
        req.query.chain,
        true,
        figuresReader(deps, planInputs),
      ),
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
