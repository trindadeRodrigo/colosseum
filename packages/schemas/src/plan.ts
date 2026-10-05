import { z } from 'zod';
import { YieldObservation } from './asset';
import { ConstraintSheet } from './constraint-sheet';
import { Profile, Provenance } from './enums';
import { LiquidityEntry } from './liquidity';

export const PlanLeg = z.object({
  assetId: z.string(),
  weight: z.number().min(0).max(1),
  amountUsd: z.number().nonnegative(),
  reasoning: z.string(),
  yieldObservation: YieldObservation.optional(),
});
export type PlanLeg = z.infer<typeof PlanLeg>;

export const ScheduleRow = z.object({
  month: z.string(),
  withdrawalBrl: z.number(),
  balanceUsd: z.number(),
  balanceBrl: z.number(),
  fxUsdBrl: z.number(),
  liquidityOk: z.boolean(),
});
export type ScheduleRow = z.infer<typeof ScheduleRow>;

export const StressCase = z.object({
  id: z.string(),
  name: z.string(),
  params: z.record(z.string(), z.number()),
  rows: z.array(ScheduleRow),
  liquidityOk: z.boolean(),
});
export type StressCase = z.infer<typeof StressCase>;

export const RiskSheetEntry = z.object({
  assetId: z.string(),
  quotedYield: z.number().nullable(),
  haircutYield: z.number().nullable(),
  haircutRule: z.string().nullable(),
  yieldSource: z.string().nullable(),
  yieldFetchedAt: z.string().nullable(),
  oracle: z.string().nullable(),
  redemptionPath: z.string().nullable(),
  redemptionTime: z.string().nullable(),
  depthNote: z.string().nullable(),
  gates: z.array(z.string()),
  issuer: z.string().nullable(),
  creditExposure: z.string().nullable(),
  provenance: Provenance,
  label: z.string().nullable(),
  /** Structured liquidity block (risk layer). Absent when no LiquidityProvider was used. */
  liquidity: LiquidityEntry.optional(),
});
export type RiskSheetEntry = z.infer<typeof RiskSheetEntry>;

export const Plan = z.object({
  id: z.string(),
  goalId: z.string(),
  sheet: ConstraintSheet,
  profile: Profile,
  capitalUsd: z.number().nonnegative(),
  legs: z.array(PlanLeg),
  bindingConstraints: z.array(z.string()),
  schedule: z.array(ScheduleRow),
  stresses: z.array(StressCase),
  riskSheet: z.array(RiskSheetEntry),
  solverVersion: z.string(),
  /** Liquidity provider used for this plan (risk layer); null or absent when none. */
  liquidity: z.object({ methodVersion: z.string(), provenance: z.string() }).nullable().optional(),
  disclaimer: z.string(),
  createdAt: z.string().datetime(),
});
export type Plan = z.infer<typeof Plan>;
