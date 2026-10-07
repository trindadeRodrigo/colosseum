import { view } from '@colosseum/basket';
import {
  ChainError,
  type ChainId,
  DISCLAIMER,
  OrderError,
  PortfolioResponse,
  type WalletAccount,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ChainEntry } from '../../orders/chains';
import { Refusal, refusalFromChainError } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { chainsHeld } from '../../orders/person';
import { cacheVault, everyPersonPlan, vaultNames } from '../../orders/store';
import { loggable } from '../../plugins/loggable';
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
          'Read from every chain this server runs that the person holds a wallet for, whatever their current chain is: each plan lives on its own chain, and `chains` has an entry for each that could be read, in the server’s order. A chain that could not be read is in `unavailable` with its code, why, and whether asking again may help: one switched off here (`CHAIN_UNAVAILABLE`, not retryable) or one whose read failed; the others are answered all the same. Only when none of the person’s chains could be read is the answer 503 `CHAIN_UNAVAILABLE`. The wallets are those of the identity token. `driftBps` is the weight of a position minus its target. The entry and every price carry `provenance`; anything that is not `live` is a test network or MOCK.',
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
        entries.map((entry) => chainPortfolio(deps, entry, principal.wallets)),
      );
      const chains = [];
      for (const [i, result] of settled.entries()) {
        const entry = entries[i] as ChainEntry;
        if (result.status === 'fulfilled') chains.push(result.value);
        else {
          if (!(result.reason instanceof ChainError) && !(result.reason instanceof Refusal))
            req.log.error(
              { err: loggable(result.reason), chain: entry.chain },
              'portfolio read failed',
            );
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
      // Each vault with the name its owner gave it, and the plan of theirs it was opened from: a plan's
      // buys kept its vault's number (`listPersonPlans`), so the join is by chain and number. Every
      // page of the list is read: a vault's plan may be older than the fifty newest.
      const anyVault = chains.some((c) => c.vaults.length > 0);
      const plans = anyVault ? await everyPersonPlan(deps.db, principal) : [];
      const planOf = new Map(
        plans.flatMap((p) => {
          const chain = p.proposal.sheet.chains[0] ?? p.proposal.recipes[0]?.chain;
          return p.basketId !== null && chain ? [[`${chain}:${p.basketId}`, p.id] as const] : [];
        }),
      );
      const named = await Promise.all(
        chains.map(async (c) => {
          const names = await vaultNames(
            deps.db,
            c.chain,
            c.vaults.map((v) => v.address),
          );
          return {
            ...c,
            vaults: c.vaults.map((v) => ({
              ...v,
              name: names.get(v.address) ?? null,
              planId: planOf.get(`${c.chain}:${v.basketId}`) ?? null,
            })),
          };
        }),
      );
      return { chains: named, unavailable, disclaimer: DISCLAIMER.en };
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
