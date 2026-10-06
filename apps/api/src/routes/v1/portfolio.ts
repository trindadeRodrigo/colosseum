import { view } from '@colosseum/basket';
import {
  ChainError,
  type ChainId,
  DISCLAIMER,
  OrderError,
  PortfolioResponse,
  type Principal,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ChainEntry } from '../../orders/chains';
import { Refusal, refusalFromChainError } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { chainsHeld } from '../../orders/person';
import { type JoinLog, plansOf } from '../../orders/plan-join';
import { cacheVault } from '../../orders/store';
import { signedIn } from './orders';

async function chainPortfolio(
  deps: OrderDeps,
  entry: ChainEntry,
  principal: Principal,
  log: JoinLog,
) {
  const owners = principal.wallets
    .filter((w) => w.family === entry.config.family)
    .map((w) => w.address);
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
  // The plan each vault was opened for, where it is the person's own (orders/plan-join.ts). A vault
  // whose join was missed when its order confirmed is joined here, now that it is in the cache.
  const plans = await plansOf(deps.db, entry.chain, vaults, principal, log);
  return {
    chain: entry.chain,
    name: entry.config.name,
    mode: entry.mode,
    provenance: entry.provenance,
    vaults: vaults.map((v) => ({ ...v, ...plans.get(v.address) })),
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
          'Read from every chain this server runs that the person holds a wallet for, whatever their current chain is: each plan lives on its own chain, and `chains` has an entry for each that could be read, in the server’s order. A chain that could not be read is in `unavailable` with its code, why, and whether asking again may help: one switched off here (`CHAIN_UNAVAILABLE`, not retryable) or one whose read failed; the others are answered all the same. Only when none of the person’s chains could be read is the answer 503 `CHAIN_UNAVAILABLE`. The wallets are those of the identity token. `driftBps` is the weight of a position minus its target. The entry and every price carry `provenance`; anything that is not `live` is a test network or MOCK. A vault’s `basketId` is its plan’s number on the chain. A vault that an order of this person opened also carries `planId`, the id of the person’s plan, and `plan`: whether it was made to measure (`personal`, with `proposalId`) or follows a shared portfolio (`follow`, with `familyId`), when the order that opened the vault was made (`placedAt`, which the goal’s date counts from), and for a stored plan its `sheet`, its `card` and, for an income goal, its `verdict`, as they were stored. The server joins the two when the order’s step that opens the vault is confirmed, and on this read for a vault it missed then. A vault opened outside the app, or joined to another person’s plan, carries neither field.',
        response: { 200: PortfolioResponse, default: OrderError },
      },
    },
    async (req) => {
      const principal = signedIn(req);
      // Every chain the person can hold a vault on, not only the current one (CHAIN-SWITCH). Each is
      // read on its own: one that is off, or whose read fails, is said in `unavailable` and does not
      // stop the others.
      const held = chainsHeld(principal);
      const on = new Set(deps.chains.active().map((e) => e.chain));
      const entries = deps.chains.active().filter((e) => held.includes(e.chain));
      const unavailable: Unavailable[] = held
        .filter((chain) => !on.has(chain))
        .map((chain) => ({
          chain,
          name: deps.chains.name(chain),
          code: 'CHAIN_UNAVAILABLE',
          error: `${deps.chains.name(chain)} is switched off on this server`,
          retryable: false,
        }));
      const settled = await Promise.allSettled(
        entries.map((entry) => chainPortfolio(deps, entry, principal, req.log)),
      );
      const chains = [];
      for (const [i, result] of settled.entries()) {
        const entry = entries[i] as ChainEntry;
        if (result.status === 'fulfilled') chains.push(result.value);
        else {
          if (!(result.reason instanceof ChainError) && !(result.reason instanceof Refusal))
            req.log.error({ err: result.reason, chain: entry.chain }, 'portfolio read failed');
          unavailable.push(unavailableOf(entry.chain, entry.config.name, result.reason));
        }
      }
      // In the server's order, as `chains` is.
      const order = deps.chains.active().map((e) => e.chain);
      unavailable.sort((a, b) => rank(order, a.chain) - rank(order, b.chain));
      if (held.length > 0 && chains.length === 0)
        throw new Refusal(
          503,
          `none of your chains could be read: ${unavailable.map((u) => u.error).join('; ')}`,
          {
            code: 'CHAIN_UNAVAILABLE',
            ...(unavailable.some((u) => u.retryable) ? { fix: 'Try again in a moment.' } : {}),
            details: { retryable: unavailable.some((u) => u.retryable) },
          },
        );
      return { chains, unavailable, disclaimer: DISCLAIMER.en };
    },
  );
}

type Unavailable = PortfolioResponse['unavailable'][number];

const rank = (order: ChainId[], chain: ChainId) => {
  const i = order.indexOf(chain);
  return i < 0 ? order.length : i;
};

/**
 * Why a chain's read failed, as the answer says it: a chain's own refusal with its code and whether to
 * ask again; anything else is ours, said without its text and worth asking again.
 */
function unavailableOf(chain: ChainId, name: string, reason: unknown): Unavailable {
  const refusal =
    reason instanceof ChainError
      ? refusalFromChainError(reason)
      : reason instanceof Refusal
        ? reason
        : null;
  if (!refusal)
    return {
      chain,
      name,
      code: 'CHAIN_UNAVAILABLE',
      error: `${name} could not be read just now`,
      retryable: true,
    };
  const details = (refusal.extra.details ?? {}) as { retryable?: unknown };
  return {
    chain,
    name,
    code: refusal.extra.code ?? 'CHAIN_UNAVAILABLE',
    error: refusal.message,
    retryable: details.retryable === true,
  };
}
