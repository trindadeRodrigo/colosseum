import { z } from 'zod';
import { BasketAsset } from './basket-asset';
import type { Shelf } from './basket-sheet';
import { Bps } from './chain';
import type { LiquidityProvider } from './liquidity';
import type { Quote } from './vault';

// DESIGN-VAULT 3.6, the types of packages/basket. The functions (flatten, view, planRebalance,
// checkCreatorLimits, rollUp, metaHash) live there; only their inputs and outputs are here.

export const Share = z.object({ key: z.string().min(1), bps: Bps });
export type Share = z.infer<typeof Share>;

export const LimitContext = z.object({
  assets: z.array(BasketAsset),
  /** Unix seconds. */
  now: z.number().int().nonnegative(),
  lastPublishAt: z.number().int().nonnegative().nullable(),
  hasPending: z.boolean(),
});
export type LimitContext = z.infer<typeof LimitContext>;

export const LimitResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), turnoverBps: Bps }),
  z.object({ ok: z.literal(false), code: z.string().min(1), detail: z.string() }),
]);
export type LimitResult = z.infer<typeof LimitResult>;

/** Holds a provider, so it is a type only. */
export type RollUpContext = { shelf: Shelf; liquidity?: LiquidityProvider; quotes: Quote[] };

export const RiskRollUp = z.object({
  byIssuer: z.array(Share),
  byChain: z.array(Share),
  byClass: z.array(Share),
  flags: z.array(z.string()),
  /** Two exit numbers: the latest stored quote, and the measured worst regime. Null is "not measured". */
  exit: z.object({
    quotedBps: z.number().nullable(),
    quotedAt: z.string().datetime().nullable(),
    measuredWorstBps: z.number().nullable(),
    /** The share of the plan that is measured. */
    measuredShareBps: Bps,
  }),
});
export type RiskRollUp = z.infer<typeof RiskRollUp>;
