import {
  AssetId,
  ChainId,
  DISCLAIMER,
  FactNullReason,
  OrderError,
  Provenance,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Refusal } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import {
  type AssetLookups,
  LOOKUP_PARTS,
  LOOKUP_WINDOWS,
  type LookupAnswer,
  type LookupPart,
} from '../../orders/lookups';

// GET /v1/assets/{id}/facts: the facts the server holds of one listed asset (gate FIGURES-BY-REFERENCE as
// amended 2026-10-14), the reads the conversations make in process, for outside agents (the MCP server's
// `get_asset_facts`). Public and read-only. The reader is handed in (asset-lookups.ts): no file the /v1
// routes reach reads a file or a fixture.

const LookupFactBody = z.object({
  id: z.string(),
  assetId: AssetId,
  label: z.string().describe('What the figure measures, in words; it holds no digit'),
  value: z.number(),
  unit: z.string(),
  source: z.string(),
  method: z.string(),
  fetchedAt: z.string().datetime(),
  provenance: Provenance,
  lowerBound: z.literal(true).optional().describe('The true value is at least this'),
  staleAgeSec: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('The reading is past its age limit: its age, in seconds'),
  missingHours: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "A figure over a window shown with some of its hours not collected (at most 5% of the window's hours): how many are missing",
    ),
  windowHours: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The hours of the window `missingHours` is counted in'),
});
const LookupMissingBody = z.object({
  id: z.string(),
  assetId: AssetId,
  label: z.string(),
  reason: FactNullReason,
  missingHours: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The hours of the window the data does not reach'),
});
const LookupPartBody = z.object({
  facts: z.array(LookupFactBody),
  missing: z.array(LookupMissingBody),
  modelledOn: z
    .string()
    .nullable()
    .describe("The mainnet token a test-network token's facts are read from"),
  unread: z
    .enum(['reading', 'failed'])
    .optional()
    .describe('The read is still running (ask again) or failed: its facts are unknown, not zero'),
});
export const AssetFactsResponse = z.object({
  assetId: AssetId,
  chain: ChainId,
  symbol: z.string(),
  /** The label of the chain's figures as it runs now. */
  provenance: Provenance,
  window: z.enum(LOOKUP_WINDOWS),
  parts: z.object({
    profile: LookupPartBody.optional(),
    price_history: LookupPartBody.optional(),
    pools: LookupPartBody.optional(),
    lending: LookupPartBody.optional(),
    bearing: LookupPartBody.optional(),
  }),
  disclaimer: z.string(),
});
export type AssetFactsResponse = z.infer<typeof AssetFactsResponse>;

const PARTS = new RegExp(`^(?:${LOOKUP_PARTS.join('|')})(?:,(?:${LOOKUP_PARTS.join('|')}))*$`, 'u');

export function registerAssetFactsRoute(
  scope: FastifyInstance,
  deps: OrderDeps,
  lookups: AssetLookups | undefined,
) {
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/v1/assets/:id/facts',
    {
      config: { auth: 'public', limit: 'standard' },
      schema: {
        tags: ['assets'],
        summary: 'The facts the server holds of one listed asset',
        description: `One listed asset of a chain the server runs, by its catalog id (\`solana:tslax\`). Each part answers its facts and the ones that are not measured, with why: \`profile\`, the newest reading of each of the asset's metrics (supply, the issuer's supply, the twenty largest holders' share, pool TVL, DEX volume over a day, protocol TVL, exchange rate, each yield reading), served with \`staleAgeSec\` when it is older than three of its job's intervals; \`price_history\`, over \`window\` from the hourly bars of the asset's DEX pools in dollars: the latest close, the high, the low, the change from the window's first close to its last (a past figure, never a forecast), the volume, the volume traded on the entry side and on the exit side, the swaps and the hours with no priced swap. A window is shown when no more than 5% of its hours were not collected (1 of 24, 8 of 168, 36 of 720), its figures made from the bars it has, each with \`missingHours\` and \`windowHours\` when any hour is missing ("11 of 720 hours missing"); with more missing, with no bar of the asset in it, or with the chain's bars ending more than two hours before now, every figure is \`not_collected\` with \`missingHours\`; \`pools\`, its pools by dollars held, at most five, each pool's volume over the last day under the same rule; \`lending\`, per lending market that lends the asset itself (at most five, the largest by what a lender can withdraw now; markets of one venue that lend from one pool once), its supply and borrow rates, the share lent out and what a lender can withdraw now: a lending figure is always the figure of the token the market lends, so a market that only takes the asset as collateral gives no figure under it, only a missing \`lend:<asset>:<account>:collateral\` entry (\`not_applicable\`) whose label names the token it lends, whose own lending markets carry the rates; \`bearing\`, Bearing's exit, liquidity and market figures at the reference size. DEX prices and oracle prices are never blended. Every fact carries its source, method, \`fetchedAt\` and \`provenance\`: a test-network token's facts are its mainnet model's, labelled \`sandbox\` with the model named (\`modelledOn\`), and a chain on the mock labels them \`mock\`. A part whose read takes longer than a moment answers \`unread: "reading"\`: ask again. A cash token answers only \`lending\` (where it can be lent and at what rates); its other parts are empty. An unknown id is a 404.\n\n${DISCLAIMER.en}`,
        params: z.strictObject({ id: AssetId }),
        querystring: z.strictObject({
          parts: z
            .string()
            .regex(PARTS)
            .optional()
            .describe(
              `A comma-separated list of ${LOOKUP_PARTS.join(', ')}; every part when left out`,
            ),
          window: z.enum(LOOKUP_WINDOWS).default('7d'),
        }),
        response: { 200: AssetFactsResponse, default: OrderError },
      },
    },
    async (req) => {
      const { id } = req.params;
      const chain = ChainId.safeParse(id.split(':')[0]);
      if (!chain.success || deps.chains.mode(chain.data) === 'off')
        throw new Refusal(404, 'no listed asset with that id');
      const entry = deps.chains.get(chain.data);
      const asset = (await entry.adapter.listAssets()).find((listed) => listed.id === id);
      if (!asset) throw new Refusal(404, 'no listed asset with that id');
      if (!lookups)
        throw new Refusal(503, 'the asset facts are not available on this server', {
          code: 'CHAIN_UNAVAILABLE',
          details: { retryable: false },
        });
      const wanted = new Set<LookupPart>(
        (req.query.parts?.split(',') as LookupPart[] | undefined) ?? LOOKUP_PARTS,
      );
      const query = {
        db: deps.db,
        chain: chain.data,
        asset,
        provenance: entry.mock ? ('mock' as const) : entry.provenance,
      };
      const reads: Record<LookupPart, () => Promise<LookupAnswer>> = {
        profile: () => lookups.profile(query),
        price_history: () => lookups.priceHistory({ ...query, window: req.query.window }),
        pools: () => lookups.pools(query),
        lending: () => lookups.lending(query),
        bearing: () => lookups.bearing(query),
      };
      const answered = await Promise.all(
        LOOKUP_PARTS.filter((part) => wanted.has(part)).map(
          async (part) => [part, await reads[part]()] as const,
        ),
      );
      return {
        assetId: asset.id,
        chain: chain.data,
        symbol: asset.symbol,
        provenance: query.provenance,
        window: req.query.window,
        parts: Object.fromEntries(answered),
        disclaimer: DISCLAIMER.en,
      };
    },
  );
}
