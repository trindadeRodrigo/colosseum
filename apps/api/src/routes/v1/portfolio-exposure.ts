import {
  DISCLAIMER,
  OrderError,
  PortfolioExposureQuery,
  PortfolioExposureResponse,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { OrderDeps } from '../../orders/legs';
import type { PlanInputs } from '../../orders/personalize';
import { chainExposure, totalOf } from '../../portfolio/exposure';
import { personScope } from '../../portfolio/scope';
import { signedIn } from './orders';

/**
 * What the signed-in person holds across their vaults, added up (PORT-2): the sums and what selling
 * them would cost are worked out in portfolio/exposure.ts. `inputs` are the figures a plan is made
 * with (Bearing's measured exits, the tiers and the issuers): the server hands in its reader of the
 * stored ones, a test its own.
 */
export function registerPortfolioExposureRoute(
  scope: FastifyInstance,
  deps: OrderDeps,
  inputs: PlanInputs,
) {
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/v1/portfolio/exposure',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags: ['portfolio'],
        summary: 'What the signed-in person holds across their vaults, by underlying and by issuer',
        description:
          'The person’s holdings added up, read from what the snapshot worker kept (`vault_snapshots`) and never from a chain: the newest snapshot of each vault of the wallets of the identity token, on every chain this server runs that the person holds a wallet for. `chain` narrows the answer to one chain, and `address` to one vault: the sums, the roll-up and the size each exit is costed at are then that vault’s alone, and an address that is not a vault of the person’s narrows the answer to nothing, never to an error. `chains` has an entry for each chain also when it holds nothing; a chain of the person’s that is switched off here is in `unavailable`, never shown as zero, and `total` then adds up only what could be read. In an entry, `valueUsd` is the sum, each position at the value its snapshot gave it and the cash at one dollar each; `byUnderlying` and `byIssuer` are that sum by what each asset stands for and by who issued it, largest first, in dollars and in basis points that add up to 10,000; `vaults` is how many vaults were counted (a vault the worker has not read yet adds nothing) and `observedAt` the oldest snapshot used, so no figure is fresher than it. A holding with no price, or one the asset list does not name, is in `unvalued` with the amount held, and in no sum. On a test network a token is counted under the issuer, and falls back to the tier, of the mainnet token it models where the server holds them, as in a plan made there. `rollUp` is the risk roll-up over the same holdings, null when the chain holds nothing; no stored quote is read, so its quoted exit is null and it says `exit_quote_missing`. `exit` has one entry for each asset in the sums that is not cash, at the whole holding (`usd`). Where Bearing measures the asset, `measured` is true and `costBps` is the measured cost of selling that size in the worst measured time of the week, to a hundredth of a basis point, with its `source`, `method` (the version of the method that measured it), `fetchedAt` (the end of the data behind the measurement, left out where it has none) and `provenance`; it is null where the size is beyond what was measured, and where the measurement names no source or no time, so no cost goes out without them. Where it does not, `measured` is false, `fallbackTier` names the asset’s tier and `costBps` is null: a tier is a ceiling on what a plan may hold and states no cost (gate EXIT-SOURCE). `total` adds the chains up and is null when none holds anything; its `provenance` is the least live of the labels of the chains that add to it, its `source` and `method` those of the chains it adds, and `observedAt` the oldest of their snapshots. Every entry carries `provenance`: `live` is mainnet, `sandbox` a test network and `mock` a chain made up in memory (MOCK); nothing that is not `live` is to be shown as live. A call with no sign-in is refused (401). None of it is advice: see `disclaimer`.',
        querystring: PortfolioExposureQuery,
        response: { 200: PortfolioExposureResponse, default: OrderError },
      },
    },
    async (req, reply) => {
      // The answer is one person's: nothing between them and the server keeps it for the next caller.
      // Set before anything is read, so a refusal carries it too.
      reply.header('cache-control', 'private, no-store');
      const { chain, address } = req.query;
      const person = personScope(deps.chains, signedIn(req), chain);
      const now = deps.now();
      const chains = await Promise.all(
        person.chains.map((scoped) => chainExposure({ deps, scoped, inputs, now, address })),
      );
      return {
        total: totalOf(chains),
        chains: chains.map((read) => read.answer),
        unavailable: person.unavailable,
        disclaimer: DISCLAIMER.en,
      };
    },
  );
}
