import { type Db, indexFamilies, recipes, recipeVersions, users } from '@colosseum/db';
import type { ChainId, Recipe, RecipeVersionView, Target } from '@colosseum/schemas';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

// The shared-portfolio tables (DESIGN-VAULT section 4): `index_families` holds the text, `recipes` a
// family's recipe on one chain, `recipe_versions` the versions the server has seen. They are a cache:
// the registry onchain is the truth, and a route that reads the chain writes what it read here.

type VersionRow = typeof recipeVersions.$inferSelect;

export type StoredRecipe = {
  id: string;
  chain: ChainId;
  onchainId: string;
  creator: string;
  /** Newest first. */
  versions: VersionRow[];
};

export type StoredFamily = {
  familyId: string;
  slug: string;
  nameKey: string;
  name: string;
  copy: string;
  kind: 'index' | 'single';
  creatorUserId: string | null;
  creatorKind: 'platform' | 'community';
  platform: boolean;
  recipes: StoredRecipe[];
};

type FamilyRow = typeof indexFamilies.$inferSelect;

async function withRecipes(db: Db, rows: FamilyRow[]): Promise<StoredFamily[]> {
  if (!rows.length) return [];
  const recipeRows = await db
    .select()
    .from(recipes)
    .where(
      inArray(
        recipes.familyId,
        rows.map((r) => r.familyId),
      ),
    )
    .orderBy(asc(recipes.chainId));
  const versionRows = recipeRows.length
    ? await db
        .select()
        .from(recipeVersions)
        .where(
          inArray(
            recipeVersions.recipeId,
            recipeRows.map((r) => r.id),
          ),
        )
        .orderBy(desc(recipeVersions.version))
    : [];
  return rows.map((f) => ({
    familyId: f.familyId,
    slug: f.slug,
    nameKey: f.nameKey,
    name: f.name,
    copy: f.copy,
    kind: f.kind,
    creatorUserId: f.creatorUserId,
    creatorKind: f.creatorKind,
    platform: f.platform,
    recipes: recipeRows
      // A recipe with no onchain id was never published: there is nothing to read or follow.
      .filter((r) => r.familyId === f.familyId && r.onchainId !== null)
      .map((r) => ({
        id: r.id,
        chain: r.chainId,
        onchainId: r.onchainId as string,
        creator: r.creator,
        versions: versionRows.filter((v) => v.recipeId === r.id),
      })),
  }));
}

export async function familyBySlug(db: Db, slug: string): Promise<StoredFamily | null> {
  const rows = await db.select().from(indexFamilies).where(eq(indexFamilies.slug, slug));
  return (await withRecipes(db, rows))[0] ?? null;
}

export async function familyByNameKey(db: Db, nameKey: string): Promise<StoredFamily | null> {
  const rows = await db.select().from(indexFamilies).where(eq(indexFamilies.nameKey, nameKey));
  return (await withRecipes(db, rows))[0] ?? null;
}

/** Every family, by slug. The shelf reads this and nothing on a chain. */
export async function allFamilies(db: Db): Promise<StoredFamily[]> {
  return withRecipes(db, await db.select().from(indexFamilies).orderBy(asc(indexFamilies.slug)));
}

/** The person's user row, by the Privy id of a verified sign-in. Null before they have one. */
export async function userIdOf(db: Db, privyId: string | undefined): Promise<string | null> {
  if (!privyId) return null;
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.privyId, privyId));
  return row?.id ?? null;
}

const targetsOf = (r: Recipe): Target[] =>
  r.components.flatMap((c) =>
    c.kind === 'asset' ? [{ asset: c.asset, weightBps: c.weightBps }] : [],
  );

/**
 * A family's text and its recipe on one chain, once a publish has confirmed (DESIGN-VAULT section 6:
 * created or renamed only then). The text is the latest the creator published; the versions keep their
 * own hashes. Answers the recipe's row id, or null when the family is another creator's: two creators
 * can each publish a recipe under one new slug's id onchain, and the first to land keeps the family.
 */
export async function writePublished(
  db: Db,
  w: {
    familyId: string;
    slug: string;
    nameKey: string;
    name: string;
    copy: string;
    creatorUserId: string | null;
    chain: ChainId;
    onchainId: string;
    creator: string;
  },
): Promise<string | null> {
  return db.transaction(async (tx) => {
    // The family row first, locked, so two landings of one family are written one after the other.
    const [family] = await tx
      .select()
      .from(indexFamilies)
      .where(eq(indexFamilies.familyId, w.familyId))
      .for('update');
    const [held] = await tx
      .select({ creator: recipes.creator })
      .from(recipes)
      .where(and(eq(recipes.familyId, w.familyId), eq(recipes.chainId, w.chain)));
    const theirs = held
      ? held.creator !== w.creator
      : family?.creatorUserId != null && family.creatorUserId !== w.creatorUserId;
    if (theirs) return null;
    await tx
      .insert(indexFamilies)
      .values({
        familyId: w.familyId,
        slug: w.slug,
        nameKey: w.nameKey,
        name: w.name,
        copy: w.copy,
        creatorUserId: w.creatorUserId,
        creatorKind: 'community',
        kind: 'index',
      })
      .onConflictDoUpdate({
        target: indexFamilies.familyId,
        set: { nameKey: w.nameKey, name: w.name, copy: w.copy, updatedAt: new Date() },
      });
    await tx
      .insert(recipes)
      .values({
        familyId: w.familyId,
        chainId: w.chain,
        onchainId: w.onchainId,
        creator: w.creator,
        kind: 'community',
      })
      .onConflictDoNothing({ target: [recipes.familyId, recipes.chainId] });
    const [row] = await tx
      .select({ id: recipes.id })
      .from(recipes)
      .where(and(eq(recipes.familyId, w.familyId), eq(recipes.chainId, w.chain)));
    if (!row) throw new Error('the recipe row vanished');
    return row.id;
  });
}

/**
 * Writes what the chain says of a recipe's versions: the one in effect and the one that waits. A
 * version the server had as in effect and the chain no longer has is `superseded`. One it had as
 * waiting that the chain no longer has is `cancelled` when nothing later has taken effect since (it can
 * only have been taken back), and `superseded` otherwise: it took effect, or was taken back before a
 * later one was published, and with no events read the two are not told apart.
 */
export async function syncVersions(
  db: Db,
  recipeId: string,
  onchain: { active: Recipe; pending: Recipe | null },
): Promise<void> {
  await db.transaction(async (tx) => {
    const seen = [
      { r: onchain.active, status: 'active' as const },
      ...(onchain.pending ? [{ r: onchain.pending, status: 'pending' as const }] : []),
    ];
    for (const { r, status } of seen)
      await tx
        .insert(recipeVersions)
        .values({
          recipeId,
          version: r.version,
          components: r.components,
          metaHash: r.metaHash,
          effectiveAt: new Date(r.effectiveAt * 1000),
          status,
        })
        .onConflictDoUpdate({
          target: [recipeVersions.recipeId, recipeVersions.version],
          set: {
            components: r.components,
            metaHash: r.metaHash,
            effectiveAt: new Date(r.effectiveAt * 1000),
            status,
          },
        });
    const current = new Set(seen.map((s) => s.r.version));
    const rows = await tx
      .select()
      .from(recipeVersions)
      .where(eq(recipeVersions.recipeId, recipeId));
    for (const row of rows) {
      if (current.has(row.version)) continue;
      const status =
        row.status === 'pending' && row.version > onchain.active.version
          ? 'cancelled'
          : row.status === 'cancelled'
            ? 'cancelled'
            : 'superseded';
      if (status !== row.status)
        await tx.update(recipeVersions).set({ status }).where(eq(recipeVersions.id, row.id));
    }
  });
}

/** A stored version as the routes answer it. */
export const versionView = (row: VersionRow): RecipeVersionView => ({
  version: row.version,
  effectiveAt: Math.floor(row.effectiveAt.getTime() / 1000),
  components: row.components.flatMap((c) =>
    c.kind === 'asset' ? [{ asset: c.asset, weightBps: c.weightBps }] : [],
  ),
  metaHash: row.metaHash,
  status: row.status,
});

/** A version as the chain gives it, in the same shape. */
export const recipeView = (r: Recipe, status: 'active' | 'pending'): RecipeVersionView => ({
  version: r.version,
  effectiveAt: r.effectiveAt,
  components: targetsOf(r),
  metaHash: r.metaHash,
  status,
});

/** True when the newest version the server has of this family's recipe on `chain` carries this text hash. */
export async function hasVersion(
  db: Db,
  familyId: string,
  chain: ChainId,
  metaHash: string,
): Promise<boolean> {
  const [row] = await db
    .select({ metaHash: recipeVersions.metaHash })
    .from(recipeVersions)
    .innerJoin(recipes, eq(recipeVersions.recipeId, recipes.id))
    .where(and(eq(recipes.familyId, familyId), eq(recipes.chainId, chain)))
    .orderBy(desc(recipeVersions.version))
    .limit(1);
  return row?.metaHash === metaHash;
}
