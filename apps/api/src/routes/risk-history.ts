import type { Db } from '@colosseum/db';
import type { RegimeParams } from '@colosseum/risk';
import { DISCLAIMER } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { loadAssetHistory, loadLendingHistory, loadPriceHistory } from '../history';

/**
 * Time series for line charts, registered by `registerRiskRoutes`. Stored measurements only (see ../history.ts):
 * one point per stored row (the last of its UTC hour or day), a value that cannot be computed is null.
 */
const Regime = z.enum(['us_market_hours', 'us_offhours_weekday', 'weekend', 'us_holiday']);
const Provenance = z.enum(['live', 'mock', 'sandbox', 'fixture', 'prior_dataset']);
const Envelope = {
  from: z.string().nullable(),
  to: z.string().nullable(),
  days: z.number(),
  source: z.string(),
  method: z.string(),
  methodVersion: z.string(),
  provenance: Provenance,
  disclaimer: z.string(),
};
const NotFound = z.object({ error: z.string() });

export const AssetHistoryResponse = z.object({
  asset: z.string(),
  assetMint: z.string(),
  tau: z.number(),
  resolution: z.literal('hour'),
  points: z.array(
    z.object({
      t: z.string(),
      regime: Regime,
      sellCapacityUsd: z.number().nullable(),
      sellLowerBound: z.boolean(),
      buyCapacityUsd: z.number().nullable(),
      buyLowerBound: z.boolean(),
      refMidUsd: z.number().nullable(),
      pools: z.number(),
    }),
  ),
  ...Envelope,
});
export const PriceHistoryResponse = z.object({
  asset: z.string(),
  assetMint: z.string(),
  resolution: z.enum(['hour', 'day']),
  points: z.array(
    z.object({
      t: z.string(),
      priceUsd: z.number().nullable(),
      regime: Regime,
      quality: z.string().nullable(),
      nullReason: z.string().nullable(),
    }),
  ),
  ...Envelope,
});
export const LendingHistoryResponse = z.object({
  account: z.string(),
  venue: z.string(),
  market: z.string(),
  symbol: z.string().nullable(),
  resolution: z.enum(['hour', 'day']),
  points: z.array(
    z.object({
      t: z.string(),
      suppliedUsd: z.number().nullable(),
      borrowedUsd: z.number().nullable(),
      availableUsd: z.number().nullable(),
      availableBasis: z.enum(['available_x_price', 'supplied_minus_borrowed_usd']).nullable(),
      availableNullReason: z.string().nullable(),
      shareLentOut: z.number().nullable(),
      supplyApy: z.number().nullable(),
      borrowApy: z.number().nullable(),
      usdNullReason: z.string().nullable(),
    }),
  ),
  ...Envelope,
});

export async function registerRiskHistoryRoutes(
  app: FastifyInstance,
  db: Db,
  resolveAsset: (id: string) => Promise<{ mint: string; symbol: string } | null>,
  regimeParams: RegimeParams,
) {
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.get(
    '/risk/assets/:id/history',
    {
      schema: {
        summary:
          'Exit (sell) and entry (buy) capacity at cost tau over time: one point per UTC hour, the last stored routed snapshot of the hour',
        description: `Stored measurements only; a side with no finite point is null, never 0.\n\n${DISCLAIMER.en}`,
        params: z.object({ id: z.string() }),
        querystring: z.object({
          days: z.coerce.number().int().min(1).max(30).default(7),
          tau: z.coerce.number().positive().max(0.5).default(0.01),
        }),
        response: { 200: AssetHistoryResponse, 404: NotFound },
      },
    },
    async (req, reply) => {
      const a = await resolveAsset(req.params.id);
      if (!a) return reply.code(404).send({ error: `unknown asset ${req.params.id}` });
      const h = await loadAssetHistory(db, a.mint, { ...req.query, regimeParams });
      return { asset: a.symbol, assetMint: a.mint, ...h, disclaimer: DISCLAIMER.en };
    },
  );

  f.get(
    '/risk/assets/:id/prices',
    {
      schema: {
        summary:
          'Reference price over time: hourly up to 31 days, else the daily close (last market-hours price of each US trading day)',
        description: `From risk_reference_prices, newest method version. An hour without a price is null with its reason.\n\n${DISCLAIMER.en}`,
        params: z.object({ id: z.string() }),
        querystring: z.object({ days: z.coerce.number().int().min(1).max(400).default(365) }),
        response: { 200: PriceHistoryResponse, 404: NotFound },
      },
    },
    async (req, reply) => {
      const a = await resolveAsset(req.params.id);
      if (!a) return reply.code(404).send({ error: `unknown asset ${req.params.id}` });
      const h = await loadPriceHistory(db, a.mint, req.query);
      return { asset: a.symbol, assetMint: a.mint, ...h, disclaimer: DISCLAIMER.en };
    },
  );

  f.get(
    '/risk/facts/lending/:account/history',
    {
      schema: {
        summary:
          'One lending pool over time: supplied, borrowed, available (USD), share lent out, supply and borrow APY. Hourly up to 14 days, else the last observation of each UTC day',
        description: `Pool aggregates only, no wallet. A figure not stored is null with its reason.\n\n${DISCLAIMER.en}`,
        params: z.object({ account: z.string() }),
        querystring: z.object({ days: z.coerce.number().int().min(1).max(400).default(90) }),
        response: { 200: LendingHistoryResponse, 404: NotFound },
      },
    },
    async (req, reply) => {
      const h = await loadLendingHistory(db, req.params.account, req.query);
      if (!h)
        return reply.code(404).send({ error: `no lending snapshots for ${req.params.account}` });
      return { ...h, disclaimer: DISCLAIMER.en };
    },
  );
}
