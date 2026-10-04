import { view } from '@colosseum/basket';
import { DISCLAIMER, OrderError, PortfolioResponse, type WalletAccount } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ChainEntry } from '../../orders/chains';
import { refusing } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { homeChain } from '../../orders/person';
import { cacheVault } from '../../orders/store';
import { signedIn } from './orders';

async function chainPortfolio(deps: OrderDeps, entry: ChainEntry, wallets: WalletAccount[]) {
  const owners = wallets.filter((w) => w.family === entry.config.family).map((w) => w.address);
  const states = (await Promise.all(owners.map((o) => entry.adapter.getVaults(o)))).flat();
  const assets = [
    ...new Set(states.flatMap((v) => [v.cash.asset, ...v.positions.map((p) => p.asset)])),
  ];
  const prices = assets.length ? await entry.adapter.getPrices(assets) : [];
  // Value, weight and drift come from the one place that computes them (packages/basket). It takes the
  // chain's asset list for each token's decimals.
  const listed = states.length ? await entry.adapter.listAssets() : [];
  const vaults = states.map((v) => ({
    ...view(v, prices, listed),
    provenance: entry.provenance,
  }));
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
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags: ['portfolio'],
        summary: "The signed-in person's vaults on their chain, with holdings, prices and drift",
        description:
          'Read from the one chain the person’s plans live on (`GET /v1/me`), for the wallets in the identity token: `chains` has that one entry. `driftBps` is the weight of a position minus its target. The entry and every price carry `provenance`; anything that is not `live` is a test network or MOCK.',
        response: { 200: PortfolioResponse, default: OrderError },
      },
    },
    async (req) => {
      const principal = signedIn(req);
      // One chain: a plan lives where the person's wallet is, and so does every vault of theirs.
      const entry = deps.chains.get(await homeChain(deps.db, principal));
      const chain = await refusing(() => chainPortfolio(deps, entry, principal.wallets));
      return { chains: [chain], disclaimer: DISCLAIMER.en };
    },
  );
}
