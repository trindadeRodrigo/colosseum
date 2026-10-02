import { z } from 'zod';
import { Address, AssetId, Bps, ChainId, Hex32 } from './chain';

// DESIGN-VAULT 3.1. A shared portfolio is a `Recipe` with `kind: 'community'`.

export const Component = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('asset'), asset: AssetId, weightBps: Bps }),
  /** `family` is the slug. Personal recipes only; flattened before a vault sees it. */
  z.object({ kind: z.literal('index'), family: z.string().min(1), weightBps: Bps }),
]);
export type Component = z.infer<typeof Component>;

/** What a vault stores. */
export const Target = z.object({ asset: AssetId, weightBps: Bps });
export type Target = z.infer<typeof Target>;

const sumBps = (rows: { weightBps: number }[]) => rows.reduce((n, r) => n + r.weightBps, 0);

/** A full set of targets: the weights add up to exactly 10,000. */
export const Targets = z
  .array(Target)
  .min(1)
  .refine((t) => sumBps(t) === 10_000, 'weights must add up to exactly 10,000');
export type Targets = z.infer<typeof Targets>;

export const Recipe = z
  .object({
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
    components: z.array(Component).min(1),
    metaHash: Hex32,
    /** Stored onchain and required to be zero in the MVP. */
    maxFeeBps: z.literal(0),
    /** Stored onchain and required to be zero in the MVP. */
    flags: z.literal(0),
  })
  .refine((r) => sumBps(r.components) === 10_000, {
    message: 'weights must add up to exactly 10,000',
    path: ['components'],
  })
  // Design 3.1 says index components are for personal recipes only; enforced here.
  .refine((r) => r.kind === 'personal' || r.components.every((c) => c.kind === 'asset'), {
    message: 'a shared portfolio lists assets only',
    path: ['components'],
  });
export type Recipe = z.infer<typeof Recipe>;

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
