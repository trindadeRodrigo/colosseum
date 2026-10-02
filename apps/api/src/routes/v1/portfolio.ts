import {
  ChainId,
  ChainMode,
  DISCLAIMER,
  Price,
  Provenance,
  VaultView,
  type WalletAccount,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ChainEntry } from '../../orders/chains';
import { RefusalBody, refusing } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { cacheVault } from '../../orders/store';
import { view } from '../../orders/view';
import { signedIn } from './orders';

/**
 * WORKAROUND: GET /v1/portfolio, named here until it moves beside the other bodies in packages/schemas. One entry
 * per chain that is not switched off. `provenance` is the label on every figure under it: `mock` when
 * the chain runs on the mock, `sandbox` on a test network, `live` on mainnet only.
 */
export const PortfolioResponse = z.object({
  chains: z.array(
    z.object({
      chain: ChainId,
      name: z.string(),
      mode: ChainMode,
      provenance: Provenance,
      /** The caller's vaults, each with its value, and the weight and drift of every position. */
      vaults: z.array(VaultView.extend({ provenance: Provenance })),
      /** The reference prices the values were worked out with, each with its source and time. */
      prices: z.array(Price),
    }),
  ),
  disclaimer: z.string(),
});
export type PortfolioResponse = z.infer<typeof PortfolioResponse>;

async function chainPortfolio(deps: OrderDeps, entry: ChainEntry, wallets: WalletAccount[]) {
  const owners = wallets.filter((w) => w.family === entry.config.family).map((w) => w.address);
  const states = (await Promise.all(owners.map((o) => entry.adapter.getVaults(o)))).flat();
  const assets = [
    ...new Set(states.flatMap((v) => [v.cash.asset, ...v.positions.map((p) => p.asset)])),
  ];
  const prices = assets.length ? await entry.adapter.getPrices(assets) : [];
  const vaults = states.map((v) => ({ ...view(v, prices), provenance: entry.provenance }));
  // The cache follows what was just read from the chain.
  for (const v of vaults) await cacheVault(deps.db, v, entry.provenance);
  return {
    chain: entry.chain,
    name: entry.config.name,
    mode: entry.mode,
    provenance: entry.provenance,
    vaults,
    prices,
  };
}

export function registerPortfolioRoute(scope: FastifyInstance, deps: OrderDeps) {
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/v1/portfolio',
    {
      config: { auth: 'user' },
      schema: {
        tags: ['portfolio'],
        summary: "The signed-in person's vaults on every chain, with holdings, prices and drift",
        description:
          'Read from the chains, for the wallets in the identity token. `driftBps` is the weight of a position minus its target. Every chain entry and every price carries `provenance`; anything that is not `live` is a test network or MOCK.',
        response: { 200: PortfolioResponse, default: RefusalBody },
      },
    },
    async (req) => {
      const { wallets } = signedIn(req);
      const chains = await refusing(() =>
        Promise.all(deps.chains.active().map((entry) => chainPortfolio(deps, entry, wallets))),
      );
      return { chains, disclaimer: DISCLAIMER.en };
    },
  );
}
