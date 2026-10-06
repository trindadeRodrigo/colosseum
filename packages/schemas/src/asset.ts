import { z } from 'zod';
import { AssetKind, Chain, MintPathKind, Profile, Provenance } from './enums';

/** Static, provenance-carrying description of an eligible asset. Numbers live in observations, not here. */
export const Asset = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1),
  name: z.string().min(1),
  kind: AssetKind,
  chain: Chain,
  mint: z.string().optional(),
  tokenProgram: z.string().optional(),
  decimals: z.number().int().min(0).max(18).optional(),
  /**
   * The profiles a plan may hold it under. Empty: no plan holds it. That is the row of an asset the
   * risk layer measures and the structurer does not offer (the tracked EVM stocks, PLAN-UNIVERSE RU.8).
   */
  eligibleProfiles: z.array(Profile),
  /** Max portfolio weight, 0..1. For the BRL leg this is a parameter, not a fact. */
  capWeight: z.number().min(0).max(1),
  mintPath: MintPathKind,
  metadata: z.object({
    issuer: z.string().optional(),
    creditExposure: z.string().optional(),
    oracle: z.string().optional(),
    redemptionPath: z.string().optional(),
    redemptionTime: z.string().optional(),
    gates: z.array(z.string()).default([]),
    /** True for legs whose return depends on borrowers repaying (private credit); counted against the credit budget. */
    creditLeg: z.boolean().optional(),
    docsUrl: z.string().url().optional(),
    label: z.string().optional(),
  }),
  provenance: Provenance,
});
export type Asset = z.infer<typeof Asset>;

const ObservationBase = {
  source: z.string().min(1),
  method: z.string().min(1),
  fetchedAt: z.string().datetime(),
  provenance: Provenance,
};

export const YieldObservation = z.object({
  assetId: z.string(),
  quotedYield: z.number(),
  haircutYield: z.number(),
  haircutRule: z.string(),
  ...ObservationBase,
});
export type YieldObservation = z.infer<typeof YieldObservation>;

export const FxObservation = z.object({
  pair: z.string(),
  value: z.number().positive(),
  ...ObservationBase,
});
export type FxObservation = z.infer<typeof FxObservation>;

export const DepthObservation = z.object({
  assetId: z.string(),
  side: z.enum(['buy', 'sell']),
  notionalUsd: z.number().positive(),
  priceImpactPct: z.number(),
  outAmount: z.string(),
  ...ObservationBase,
});
export type DepthObservation = z.infer<typeof DepthObservation>;
