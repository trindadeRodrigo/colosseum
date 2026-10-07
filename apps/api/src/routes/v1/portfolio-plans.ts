import { statusOf } from '@colosseum/basket';
import {
  DISCLAIMER,
  OrderError,
  type PortfolioPlan,
  PortfolioPlansQuery,
  PortfolioPlansResponse,
  type Principal,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { OrderDeps } from '../../orders/legs';
import { plansOf } from '../../orders/plan-join';
import { vaultNames } from '../../orders/store';
import { familiesOf, followsOf, newestOf, putInOf } from '../../portfolio/plans';
import { frame, personScope, type ScopedChain } from '../../portfolio/scope';
import { chainAnsweredAt, knownVaults, trackSnapshotOf } from '../../portfolio/snapshots';
import { signedIn } from './orders';

// The person's plans (PORT-2): one entry for each vault of theirs, with the plan it was opened for,
// what they put in, its newest snapshot, its status and the shared portfolio it follows. Read from the
// database alone: the vault cache, the snapshot worker's tables and the order tables. No chain is
// asked anything.

/** One chain's entry: when the worker last got through on it, and the person's vaults there. */
async function chainPlans(
  deps: OrderDeps,
  scoped: ScopedChain,
  principal: Principal,
  a: { now: Date; address?: string },
): Promise<PortfolioPlansResponse['chains'][number]> {
  const { entry } = scoped;
  const answeredAt = (await chainAnsweredAt(deps.db, entry))?.toISOString() ?? null;
  const known = await knownVaults(deps.db, scoped, a);
  // What a vault is (its owner and its plan's number on the chain) is said by its newest snapshot, and
  // by its cache row where the worker has not read it yet.
  const vaults = known.flatMap(({ address, cached, newest }) => {
    const said = newest ?? cached;
    return said ? [{ address, owner: said.owner, basketId: said.onchainBasketId, newest }] : [];
  });
  const addresses = vaults.map((v) => v.address);
  const followed = vaults.flatMap((v) =>
    v.newest?.recipeOnchainId ? [v.newest.recipeOnchainId] : [],
  );
  // One read a chain for each of the four, never one a vault.
  const [plans, names, putIn, families] = await Promise.all([
    plansOf(deps.db, entry.chain, addresses, principal.userId),
    vaultNames(deps.db, entry.chain, addresses),
    putInOf(deps.db, scoped, vaults, principal.userId),
    familiesOf(deps.db, entry.chain, followed),
  ]);
  const now = a.now.toISOString();
  return {
    ...frame(entry),
    answeredAt,
    plans: vaults.map(
      ({ address, owner, basketId, newest }): PortfolioPlan => ({
        chain: entry.chain,
        address,
        owner,
        name: names.get(address) ?? null,
        basketId,
        plan: plans.get(address)?.plan ?? null,
        putIn: putIn.get(address) ?? null,
        newest: newest ? newestOf(newest, a.now) : null,
        // No verdict is handed in. The verdict stored with a plan is a figure from when the plan was
        // built, not the engine's word on the vault today, and must not stand in for the rule.
        status: statusOf({
          snapshot: newest ? trackSnapshotOf(newest) : null,
          now,
          chainAnsweredAt: answeredAt,
        }),
        follows: followsOf(newest, families),
        provenance: entry.provenance,
      }),
    ),
  };
}

export function registerPortfolioPlansRoute(scope: FastifyInstance, deps: OrderDeps) {
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/v1/portfolio/plans',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags: ['portfolio'],
        summary:
          "The signed-in person's plans, each with what was put in, its value and its status",
        description:
          'One entry for each vault of the signed-in person, on every chain this server runs that they hold a wallet for, each chain on its own and in the server’s order: the vault’s address and owner, the plan’s number on the chain (`basketId`) and the name its owner gave it. It is read from the database alone, never from a chain: the vaults are the ones the vault cache names for the person’s wallets and the ones the snapshot worker read in the last seven days, and `answeredAt` is when a pass of that worker last went through on the chain. `plan` is the plan the vault was opened for, as the server joined it, and null for a vault no order of the person’s opened; what a plan says (its goal, its card, its verdict) is answered to the person who made it, to a buyer of a plan made from a link, and to nobody else. `putIn` is what the person put in through this app: the cash of each buy of theirs whose deposit confirmed on that chain, counted once an order and listed in `deposits`, oldest first, each with the time the server learned of it. It is gross: a withdrawal is not taken off, and money that reached the vault any other way is not in it. It is null where no deposit of theirs is confirmed. `newest` is the newest snapshot of the vault, whole, with its age in `ageSeconds` and `stale` once it is more than an hour old; it is null where the worker has not read the vault yet. `status` is `on_track`, `watch` or `off_track`, or null where the rule gives none yet, always with the rule that gave it (`ON-TRACK-V1`), the line of the rule that holds and its sentence in `text`. The verdict stored with a plan is a figure from when the plan was built and never changes the status. `follows` is the shared portfolio the vault follows as its newest snapshot says, with the family’s name where the server holds one. `chain` narrows the answer to one chain and `address` to one vault; an address that is not a vault of the person’s narrows it to nothing and is never an error. A chain of the person’s that is switched off here is in `unavailable` (`CHAIN_UNAVAILABLE`), never shown as empty. Every chain, every entry, every snapshot with its prices, and `putIn` carry `provenance`: `mock` is the mock chain, `sandbox` a test network, and only `live` is mainnet. A call with no sign-in is answered 401, and a `chain` that is no chain, or an `address` that is empty or longer than 64 characters, 400.',
        querystring: PortfolioPlansQuery,
        response: { 200: PortfolioPlansResponse, default: OrderError },
      },
    },
    async (req): Promise<PortfolioPlansResponse> => {
      const principal = signedIn(req);
      const { chain, address } = req.query;
      const mine = personScope(deps.chains, principal, chain);
      const now = deps.now();
      const chains = await Promise.all(
        mine.chains.map((scoped) => chainPlans(deps, scoped, principal, { now, address })),
      );
      return { chains, unavailable: mine.unavailable, disclaimer: DISCLAIMER.en };
    },
  );
}
