import {
  DISCLAIMER,
  OrderError,
  PortfolioRebalancesQuery,
  PortfolioRebalancesResponse,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { OrderDeps } from '../../orders/legs';
import { chainRebalances } from '../../portfolio/rebalances';
import { frame, personScope } from '../../portfolio/scope';
import { signedIn } from './orders';

export function registerPortfolioRebalancesRoute(scope: FastifyInstance, deps: OrderDeps) {
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/v1/portfolio/rebalances',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags: ['portfolio'],
        summary: "The steps that traded in the signed-in person's vaults, newest first",
        description:
          'Read from the database alone, never from a chain: `chains` has an entry for every chain this server runs that the person holds a wallet for, also one with nothing to list, each with the label its figures carry and its entries newest first, at most `limit` a chain (50 unless asked, never more than 200). A chain of theirs that is switched off is in `unavailable`, never an empty list in its place. The wallets are those of the identity token. There are two kinds of entry. `by: owner` is an attempt of one of the person’s own steps that confirmed or failed (a transaction that reverted is `failed`), where the step carries a trade or adopts a version of a shared portfolio: an approval and a deposit with no trade are not listed, nor is anything of a publish. It has its order, why the step was made, and its transaction id and link as they were stored; `at` is when the step was built, since no record says when it confirmed. Each of its trades has `expected`, the quote the step was last built with: a quote, not what the trade paid, which nothing records, and left out for an attempt that is not the step’s latest build, whose quote was not kept. `by: keeper` with `derived: true` is a trade of the keeper’s worked out from two snapshots of the last thirty days between which the vault’s last keeper time on an asset changed. The keeper’s own log is not in the database, so such an entry has no transaction id, no quote and no reason: `rawBefore` and `rawAfter` are what the vault held of the asset in the two snapshots, every trade of the asset between them is in the one entry, and `at` is the chain’s time of the last. On a trade of either kind, `reference` is the asset’s price in the newest snapshot before it, with its own source, time and method, and `before` and `after` are the asset’s weight, target and drift in the snapshots nearest each side; each is left out where there is no such snapshot. `vault` is null where the server has not cached the vault a step was for. `address` narrows the answer to one vault (an EVM address is read in any case) and `chain` to one chain; a vault or a chain that is not the person’s, or text that is no address, narrows it to nothing, with no error. A `limit` under 1 or over 200 is refused with 400. Every entry carries `source`, `method`, `fetchedAt` and `provenance`; anything that is not `live` is a test network or MOCK.',
        querystring: PortfolioRebalancesQuery,
        response: { 200: PortfolioRebalancesResponse, default: OrderError },
      },
    },
    async (req) => {
      const principal = signedIn(req);
      const { chain, address, limit } = req.query;
      const scope = personScope(deps.chains, principal, chain);
      const now = deps.now();
      // Each chain on its own, in the server's order. A chain with nothing to list has an entry too.
      const chains = [];
      for (const scoped of scope.chains)
        chains.push({
          ...frame(scoped.entry),
          entries: await chainRebalances(deps.db, scoped, {
            privyId: principal.userId,
            now,
            limit,
            ...(address === undefined ? {} : { address }),
          }),
        });
      return { chains, unavailable: scope.unavailable, disclaimer: DISCLAIMER.en };
    },
  );
}
