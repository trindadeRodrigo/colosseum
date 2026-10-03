import { DISCLAIMER, OrderError, PortfolioResponse, type WalletAccount } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ChainEntry } from '../../orders/chains';
import { refusing } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { cacheVault } from '../../orders/store';
import { view } from '../../orders/view';
import { signedIn } from './orders';

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
        response: { 200: PortfolioResponse, default: OrderError },
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
