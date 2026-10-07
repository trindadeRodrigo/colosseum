import {
  DISCLAIMER,
  HISTORY_MAX_POINTS,
  OrderError,
  PortfolioHistoryQuery,
  PortfolioHistoryResponse,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { OrderDeps } from '../../orders/legs';
import { chainHistory, HISTORY_DEFAULT_DAYS, historyWindow } from '../../portfolio/history';
import { frame, personScope } from '../../portfolio/scope';
import { signedIn } from './orders';

// The signed-in person's vaults over time (PORT-2). Read from the rows the snapshot worker keeps
// (`vault_snapshots`) and from nowhere else: no chain is asked for this answer, so it is as fresh as
// the newest snapshot and says so in each point's `observedAt`.

export function registerPortfolioHistoryRoute(scope: FastifyInstance, deps: OrderDeps) {
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/v1/portfolio/history',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags: ['portfolio'],
        summary: "The signed-in person's vaults over time, from the snapshots kept of them",
        description: `What each of the person’s vaults was worth and held over a window of time: for each vault, a point for each \`step\` (\`10m\`, \`1h\` or \`1d\`) in which it was read. It is read from the snapshots this server keeps of every vault it knows, taken about every ten minutes, and from no chain: a point is as old as its \`observedAt\` says, and a vault opened a moment ago may have none yet. A step’s point is the last snapshot taken in it, and steps are counted on UTC boundaries (the ten minutes, the hour, the day) whatever the window is. \`chains\` has an entry for every chain this server runs that the person holds a wallet for, in the server’s order, also when it holds no vault; a chain of theirs that is switched off is in \`unavailable\` (\`CHAIN_UNAVAILABLE\`, not retryable), never shown as empty. Only the person’s own vaults are read, by the wallets of the identity token: \`chain\` and \`address\` narrow the answer, and an address that is not a vault of theirs narrows it to nothing, with no word on whether it exists. A vault is listed when it has a snapshot in the window, with the \`name\` the person gave it or null, and its points oldest first; a window with no snapshot answers empty lists. \`from\` and \`to\` are ISO instants in UTC that end in \`Z\`, from the year 1 on. Left out, \`to\` is now and \`from\` is ${HISTORY_MAX_POINTS} steps before \`to\`, and never more than ${HISTORY_DEFAULT_DAYS} days; both ends are included, and the answer says the \`from\`, \`to\` and \`step\` it used. Refused with 400 and what to change: a \`from\` that is not before \`to\`, and a window longer than ${HISTORY_MAX_POINTS} steps, which is never cut to fit. \`valueUsd\` is the vault’s value in dollars, cut to cents, and \`cashUsd\` its cash, counted as one dollar each. A position with no price has \`valueUsd: null\` and weighs nothing; \`driftBps\` is the weight of a position minus its target. A vault’s \`source\` and \`method\` say where its newest point was read from and how its values were made, and a point carries its own only where they differ. Every figure under a chain carries that chain’s \`provenance\`: \`mock\` on the mock chain, \`sandbox\` on a test network, and only \`live\` is live.`,
        querystring: PortfolioHistoryQuery,
        response: { 200: PortfolioHistoryResponse, default: OrderError },
      },
    },
    async (req): Promise<PortfolioHistoryResponse> => {
      const principal = signedIn(req);
      const { chain, address } = req.query;
      // Refused before anything is read: a window that is not one, or one too long to answer whole.
      const window = historyWindow(req.query, deps.now());
      // The chains the person holds a wallet for, each with their wallets there. Every one of them
      // that this server runs is in the answer, also when it holds nothing; one that is off is said.
      const own = personScope(deps.chains, principal, chain);
      const chains = await Promise.all(
        own.chains.map(async (scoped) => ({
          ...frame(scoped.entry),
          vaults: await chainHistory(deps.db, scoped, { ...window, address }),
        })),
      );
      return {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        step: window.step,
        chains,
        unavailable: own.unavailable,
        disclaimer: DISCLAIMER.en,
      };
    },
  );
}
