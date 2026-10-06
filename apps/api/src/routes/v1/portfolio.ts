import { view } from '@colosseum/basket';
import { DISCLAIMER, OrderError, PortfolioResponse, type WalletAccount } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ChainEntry } from '../../orders/chains';
import { refusing } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { chainsHeld } from '../../orders/person';
import { cacheVault } from '../../orders/store';
import { signedIn } from './orders';

async function chainPortfolio(deps: OrderDeps, entry: ChainEntry, wallets: WalletAccount[]) {
  const owners = wallets.filter((w) => w.family === entry.config.family).map((w) => w.address);
  const states = (await Promise.all(owners.map((o) => entry.adapter.getVaults(o)))).flat();
  // Value, weight and drift come from the one place that computes them (packages/basket). It takes the
  // chain's asset list for each token's decimals.
  const listed = states.length ? await entry.adapter.listAssets() : [];
  // Prices for the listed assets a vault holds. A token the chain shows that the list does not have (a
  // shared portfolio's author can name one) has no price here: it is shown with no value, and does
  // not stop the read.
  const known = new Set(listed.map((a) => a.id));
  const assets = [
    ...new Set(states.flatMap((v) => [v.cash.asset, ...v.positions.map((p) => p.asset)])),
  ].filter((id) => known.has(id));
  const prices = assets.length ? await entry.adapter.getPrices(assets) : [];
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
        summary: "The signed-in person's vaults on every chain, with holdings, prices and drift",
        description:
          'Read from every chain this server runs that the person holds a wallet for, whatever their current chain is: each plan lives on its own chain, and `chains` has an entry for each, in the server’s order. A chain switched off here is left out, and when every chain of the person’s is off the answer is 503 `CHAIN_UNAVAILABLE`. The wallets are those of the identity token. `driftBps` is the weight of a position minus its target. The entry and every price carry `provenance`; anything that is not `live` is a test network or MOCK.',
        response: { 200: PortfolioResponse, default: OrderError },
      },
    },
    async (req) => {
      const principal = signedIn(req);
      // Every chain the person can hold a vault on, not only the current one (CHAIN-SWITCH). A chain
      // switched off here is left out; when every one of theirs is off, the first one's refusal says so.
      const held = chainsHeld(principal);
      const entries = deps.chains.active().filter((e) => held.includes(e.chain));
      if (!entries.length && held[0]) deps.chains.get(held[0]);
      const chains = await refusing(() =>
        Promise.all(entries.map((entry) => chainPortfolio(deps, entry, principal.wallets))),
      );
      return { chains, disclaimer: DISCLAIMER.en };
    },
  );
}
