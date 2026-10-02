import { z } from 'zod';
import { Address, AssetId, Bps, ChainId, Hex32 } from './chain';

// DESIGN-VAULT 3.1. A shared portfolio is a `Recipe` with `kind: 'community'`.
// zod 4 refuses .omit(), .pick() and .partial() on an object that carries refinements, so each refined
// schema here has its plain object exported beside it as `<Name>Base`.

/** A weight that is in the list at all: 1 to 10,000 bps. */
const Weight = Bps.min(1);

export const Component = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('asset'), asset: AssetId, weightBps: Weight }),
  /** `family` is the slug. Personal recipes only; flattened before a vault sees it. */
  z.object({ kind: z.literal('index'), family: z.string().min(1), weightBps: Weight }),
]);
export type Component = z.infer<typeof Component>;

/** What a vault stores. */
export const Target = z.object({ asset: AssetId, weightBps: Weight });
export type Target = z.infer<typeof Target>;

const sumBps = (rows: { weightBps: number }[]) => rows.reduce((n, r) => n + r.weightBps, 0);
const unique = (keys: string[]) => new Set(keys).size === keys.length;
const componentKey = (c: Component) => (c.kind === 'asset' ? c.asset : `index:${c.family}`);

/** A full set of targets: each asset once, and the weights add up to exactly 10,000. */
export const Targets = z
  .array(Target)
  .min(1)
  .refine((t) => sumBps(t) === 10_000, 'weights must add up to exactly 10,000')
  .refine((t) => unique(t.map((x) => x.asset)), 'an asset appears once');
export type Targets = z.infer<typeof Targets>;

/** The components of a recipe: each asset or family once, adding up to exactly 10,000. */
export const Components = z
  .array(Component)
  .min(1)
  .refine((c) => sumBps(c) === 10_000, 'weights must add up to exactly 10,000')
  .refine((c) => unique(c.map(componentKey)), 'an asset appears once');
export type Components = z.infer<typeof Components>;

type ChainScoped = { chain: string; components: Component[] };
const onOwnChain = (r: ChainScoped) =>
  r.components.every((c) => c.kind !== 'asset' || c.asset.startsWith(`${r.chain}:`));
const assetsOnly = (r: { components: Component[] }) =>
  r.components.every((c) => c.kind === 'asset');

export const RecipeBase = z.object({
  schemaVersion: z.literal(1),
  familyId: Hex32,
  chain: ChainId,
  /** Solana: the recipe account. EVM: keccak256(abi.encode(creator, familyId)). Null before the first publish. */
  onchainId: z.string().min(1).nullable(),
  creator: Address,
  kind: z.enum(['community', 'personal']),
  version: z.number().int().min(1),
  /** Unix seconds. */
  effectiveAt: z.number().int().nonnegative(),
  components: Components,
  metaHash: Hex32,
  /** Stored onchain and required to be zero in the MVP. */
  maxFeeBps: z.literal(0),
  /** Stored onchain and required to be zero in the MVP. */
  flags: z.literal(0),
});

export const Recipe = RecipeBase.refine(onOwnChain, {
  message: "every asset is on the recipe's own chain",
  path: ['components'],
})
  // Design 3.1 says index components are for personal recipes only; enforced here.
  .refine((r) => r.kind === 'personal' || assetsOnly(r), {
    message: 'a shared portfolio lists assets only',
    path: ['components'],
  });
export type Recipe = z.infer<typeof Recipe>;

/**
 * What a creator sends to publish on one chain: the chain and the weights. The family id, the version,
 * the effective time, the onchain id and the meta hash are assigned by the server and the registry.
 */
export const RecipeDraft = z
  .object({ chain: ChainId, components: Components })
  .refine(onOwnChain, { message: "every asset is on the recipe's own chain", path: ['components'] })
  .refine(assetsOnly, { message: 'a shared portfolio lists assets only', path: ['components'] });
export type RecipeDraft = z.infer<typeof RecipeDraft>;

/** Off-chain text of a family. `metaHash` is the SHA-256 of its canonical JSON. */
export const FamilyMeta = z.object({
  familyId: Hex32,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  copy: z.string(),
  kind: z.enum(['index', 'single']),
  chains: z.array(ChainId).min(1),
});
export type FamilyMeta = z.infer<typeof FamilyMeta>;
