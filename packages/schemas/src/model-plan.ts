import { z } from 'zod';
import { AssetClass, BasketAsset } from './basket-asset';
import { AssetId, Bps, ChainId, Hex32 } from './chain';
import { Provenance } from './enums';
import { VaultAgentProposal, VaultAgentRequest, VaultAgentSource } from './vault-agent';

/** Server identity, not a request-selected network or RPC address. */
export const ModelPlanNetwork = z.strictObject({
  chain: ChainId,
  provenance: Provenance,
  networkId: z.string().min(1).max(160),
  deploymentHash: Hex32.nullable(),
});
export type ModelPlanNetwork = z.infer<typeof ModelPlanNetwork>;

export const ModelPlanTerms = z
  .strictObject({
    chain: ChainId,
    goal: z.enum(['grow', 'income', 'protect']),
    objective: z.string().trim().min(1).max(800),
    amountUsdCents: z.number().int().min(1000).max(100_000_000),
    risk: z.enum(['low', 'medium', 'high']),
    limits: z.strictObject({
      cannotHoldClasses: z.array(AssetClass.exclude(['cash'])).max(7),
      cannotHoldAssets: z.array(AssetId).max(64),
      cannotHoldUnderlyings: z.array(z.string().min(1).max(160)).max(64),
      creditTolerance: z.enum(['none', 'limited', 'accept']),
      /** Existing mustKeep policy: out of stocks, crypto and gold, not a cash guarantee. */
      mustKeepUsdCents: z.number().int().nonnegative(),
      /** Earlier money need; never interpreted as an exit window. */
      mayNeedInMonths: z.number().int().min(1).max(480).nullable(),
    }),
    /** A monthly target is an explicit requirement, not a promised yield. */
    incomeTargetUsdCentsMonthly: z.number().int().positive().max(100_000_000).nullable(),
  })
  .superRefine((terms, context) => {
    if (terms.limits.mustKeepUsdCents > terms.amountUsdCents)
      context.addIssue({
        code: 'custom',
        path: ['limits', 'mustKeepUsdCents'],
        message: 'The set-aside amount cannot exceed the investment amount.',
      });
    if (terms.goal !== 'income' && terms.incomeTargetUsdCentsMonthly !== null)
      context.addIssue({
        code: 'custom',
        path: ['incomeTargetUsdCentsMonthly'],
        message: 'A monthly income target requires an income goal.',
      });
  });
export type ModelPlanTerms = z.infer<typeof ModelPlanTerms>;

export const ModelPlanConfirmationV1 = z.strictObject({
  version: z.literal(1),
  draftId: z.uuid(),
  draftHash: Hex32,
  requestHash: Hex32,
  idempotencyKey: z.string().min(1).max(64),
  /** A UI assertion only; authenticated ownership and the stored receipt are authoritative. */
  reviewed: z.literal(true),
  terms: ModelPlanTerms,
});
export type ModelPlanConfirmationV1 = z.infer<typeof ModelPlanConfirmationV1>;

/** Internal immutable durable row. It is never an executable order or a public transcript. */
export const StoredModelDraftV1 = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  ownerPrivyId: z.string().min(1).max(160),
  network: ModelPlanNetwork,
  createdAt: z.iso.datetime(),
  request: VaultAgentRequest,
  requestHash: Hex32,
  draftHash: Hex32,
  proposal: VaultAgentProposal,
});
export type StoredModelDraftV1 = z.infer<typeof StoredModelDraftV1>;

const line = z.strictObject({
  assetId: AssetId,
  weightBps: Bps.min(1),
  amountUsdCents: z.number().int().nonnegative(),
});

/** Integer cent display/validation amounts; weights and assets remain exactly unchanged. */
export function modelLineAmounts(
  allocations: readonly { assetId: string; weightBps: number }[],
  amountUsdCents: number,
) {
  const lines = allocations.map((row) => ({
    ...row,
    amountUsdCents: Math.floor((amountUsdCents * row.weightBps) / 10000),
  }));
  let remaining = amountUsdCents - lines.reduce((sum, row) => sum + row.amountUsdCents, 0);
  const ordered = [...lines].sort(
    (a, b) =>
      ((amountUsdCents * b.weightBps) % 10000) - ((amountUsdCents * a.weightBps) % 10000) ||
      (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0),
  );
  for (const row of ordered) {
    if (remaining-- <= 0) break;
    row.amountUsdCents++;
  }
  return lines;
}

/** Standalone contract only: no current production store, funding or order reader accepts it. */
export const ModelPlanV2 = z
  .strictObject({
    version: z.literal(2),
    kind: z.literal('model'),
    network: ModelPlanNetwork,
    terms: ModelPlanTerms,
    draft: z.strictObject({ id: z.uuid(), hash: Hex32, requestHash: Hex32 }),
    proposal: VaultAgentProposal,
    lines: z.array(line).min(1).max(17),
    /** Direct non-cash targets; their sum can be below 10000 because cash remains in the vault. */
    targets: z.array(z.strictObject({ asset: AssetId, weightBps: Bps.min(1) })).max(16),
    cashAssetId: AssetId,
    /** Server catalog definition; every consumer must also revalidate against the current catalog. */
    cashAsset: BasketAsset,
    sources: z.array(VaultAgentSource).max(1024),
    unknowns: z.array(z.string().min(1).max(1000)).max(128),
    validation: z.strictObject({
      version: z.literal(1),
      policyHash: Hex32,
      catalogHash: Hex32,
      evidenceHash: Hex32,
      termsHash: Hex32,
      validatedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
    }),
  })
  .superRefine((plan, context) => {
    const issue = (message: string) => context.addIssue({ code: 'custom', message });
    if (plan.network.chain !== plan.terms.chain) issue('The network and confirmed chain differ.');
    if (
      plan.cashAsset.cls !== 'cash' ||
      plan.cashAsset.id !== plan.cashAssetId ||
      plan.cashAsset.chain !== plan.network.chain ||
      (plan.cashAsset.currency && plan.cashAsset.currency !== 'USD')
    )
      issue('The residual asset must be the server-listed dollar cash asset on this chain.');
    if (plan.lines.some((row) => !row.assetId.startsWith(`${plan.network.chain}:`)))
      issue('Every line must belong to the confirmed chain.');
    if (plan.lines.reduce((sum, row) => sum + row.weightBps, 0) !== 10000)
      issue('Line weights must total 10000.');
    if (plan.lines.reduce((sum, row) => sum + row.amountUsdCents, 0) !== plan.terms.amountUsdCents)
      issue('Line amounts must total the confirmed amount.');
    const exactAmounts = modelLineAmounts(
      plan.proposal.allocations.map(({ assetId, weightBps }) => ({ assetId, weightBps })),
      plan.terms.amountUsdCents,
    );
    if (
      exactAmounts.some(
        (expected) =>
          !plan.lines.some(
            (row) =>
              row.assetId === expected.assetId && row.amountUsdCents === expected.amountUsdCents,
          ),
      )
    )
      issue(
        'Every line amount must match its exact preserved weight and deterministic cent rounding.',
      );
    if (new Set(plan.lines.map((row) => row.assetId)).size !== plan.lines.length)
      issue('Assets cannot repeat.');
    if (
      plan.proposal.allocations.length !== plan.lines.length ||
      plan.proposal.allocations.some(
        (allocation) =>
          !plan.lines.some(
            (row) => row.assetId === allocation.assetId && row.weightBps === allocation.weightBps,
          ),
      )
    )
      issue('Lines must preserve every exact model weight.');
    const expected = plan.lines.filter((row) => row.assetId !== plan.cashAssetId);
    if (
      plan.targets.length !== expected.length ||
      expected.some(
        (row) =>
          !plan.targets.some(
            (target) => target.asset === row.assetId && target.weightBps === row.weightBps,
          ),
      )
    )
      issue('Targets must preserve non-cash weights and cash residual.');
  });
export type ModelPlanV2 = z.infer<typeof ModelPlanV2>;

/** Helpers receive the actual catalog, never a model-supplied asset definition. */
export const ModelPlanCatalog = z.array(BasketAsset).min(1);
