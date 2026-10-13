import { view } from '@colosseum/basket';
import {
  ChainError,
  chainFamily,
  DISCLAIMER,
  isAddressOf,
  OrderError,
  VaultNameRequest,
  VaultNameResponse,
  VaultResponse,
  VaultRouteParams,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Refusal, refusing } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { sameVaultAddress } from '../../orders/prepare';
import { cacheVault, nameVault } from '../../orders/store';
import { numbered, vaultNumbersOf } from '../../portfolio/numbers';
import { personScope } from '../../portfolio/scope';
import { signedIn } from './orders';

// The public vault page's read (WEB-4, DESIGN-VAULT section 11): any vault, by its chain and address,
// read from the chain for the answer, so a visitor with no funds sees real state. Nothing is written
// for a visitor. The vault's owner, signed in, is answered its number among their vaults as well.
//
// Anybody may ask, so an answer is kept for a few seconds per address: a link opened by many, or a
// page asked again and again, reads the chain once in that time and not once per request.

/** How long an answer is kept, in milliseconds. */
export const VAULT_KEPT_MS = 10_000;
/** The most addresses kept at once: past it, the oldest answer goes first. */
const VAULT_KEPT_MAX = 500;

export function registerVaultRoute(scope: FastifyInstance, deps: OrderDeps) {
  const kept = new Map<string, { at: number; answer: VaultResponse }>();
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/v1/vaults/:chain/:address',
    {
      config: { auth: 'public', limit: 'standard', optionalSignIn: true },
      schema: {
        tags: ['portfolio'],
        summary: 'One vault, read from its chain, for anybody',
        description:
          "The vault's holdings, targets, value, weights and drift, read from its chain for this answer, with the reference prices they were worked out with. Anybody may read it: a vault's state is public on its chain. A chain this server has switched off answers `CHAIN_UNAVAILABLE`; an address in the other chain family's form answers 400, and one where there is no vault 404. Every figure carries `provenance`. A sign-in is never needed. To a signed-in caller one of whose wallets owns the vault, `vault.number` is its number among their vaults, where the server holds one; anybody else is answered none, and nothing of how many vaults the owner has.",
        params: VaultRouteParams,
        response: { 200: VaultResponse, default: OrderError },
      },
    },
    async (req, reply) => {
      // Before anything is read, so a refusal carries them too: the answer depends on who asks (the
      // owner's has the vault's number), and nothing between a caller and the server keeps one
      // caller's answer for the next.
      reply.header('cache-control', 'private, no-store');
      reply.header('vary', 'Authorization');
      const { chain, address } = req.params;
      if (!isAddressOf(chainFamily(chain), address))
        throw new Refusal(400, `that is not an address of ${deps.chains.name(chain)}`);
      const entry = deps.chains.get(chain);
      const key = `${chain}:${address}`;
      const now = deps.now().getTime();
      // The kept answer is anybody's, so the owner's number is never in it: it is added to the answer
      // of the one request, for the owner alone, and that answer is not for the next caller.
      const forCaller = async (answer: VaultResponse): Promise<VaultResponse> => {
        const principal = req.principal;
        if (principal?.kind !== 'user') return answer;
        const { vault } = answer;
        const owns = principal.wallets.some(
          (w) =>
            w.family === entry.config.family && sameVaultAddress(chain, w.address, vault.owner),
        );
        if (!owns) return answer;
        const numbers = await vaultNumbersOf(
          deps.db,
          personScope(deps.chains, principal),
          principal,
          req.log,
        );
        return { ...answer, vault: { ...vault, ...numbered(numbers, chain, vault.address) } };
      };
      const hit = kept.get(key);
      if (hit && now - hit.at < VAULT_KEPT_MS) return forCaller(hit.answer);
      const answer: VaultResponse = await refusing(async () => {
        let state: Awaited<ReturnType<typeof entry.adapter.getVault>>;
        try {
          state = await entry.adapter.getVault(address);
        } catch (e) {
          if (e instanceof ChainError && e.code === 'VaultNotFound') state = null;
          else throw e;
        }
        if (!state) throw new Refusal(404, 'no vault at that address');
        const listed = await entry.adapter.listAssets();
        const known = new Set(listed.map((a) => a.id));
        const assets = [state.cash.asset, ...state.positions.map((p) => p.asset)].filter((id) =>
          known.has(id),
        );
        const prices = assets.length ? await entry.adapter.getPrices([...new Set(assets)]) : [];
        return {
          chain: entry.chain,
          name: entry.config.name,
          mode: entry.mode,
          provenance: entry.provenance,
          vault: { ...view(state, prices, listed), provenance: entry.provenance },
          prices,
          disclaimer: DISCLAIMER.en,
        };
      });
      kept.delete(key);
      kept.set(key, { at: now, answer });
      for (const [k, v] of kept)
        if (kept.size > VAULT_KEPT_MAX || now - v.at >= VAULT_KEPT_MS) kept.delete(k);
        else break;
      return forCaller(answer);
    },
  );
  // The name a person gives a vault of theirs (several vaults, each with its own name). The vault is
  // found among the vaults of the person's wallets on that chain, read from the chain: one that is not
  // among them is answered like one that does not exist, whoever it belongs to. The name is text.
  scope.withTypeProvider<ZodTypeProvider>().put(
    '/v1/vaults/:chain/:address/name',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags: ['portfolio'],
        summary: 'Name a vault of yours, or clear its name',
        description:
          'Owner only: a vault that is not the signed-in person’s answers 404, as one that does not exist. The name is plain text, trimmed, one to sixty characters, with no control character; `null` clears it, and the vault is shown by its plan’s goal again.',
        params: VaultRouteParams,
        body: VaultNameRequest,
        response: { 200: VaultNameResponse, default: OrderError },
      },
    },
    async (req): Promise<VaultNameResponse> => {
      const principal = signedIn(req);
      const { chain, address } = req.params;
      const missing = () => new Refusal(404, 'no vault with that address that is yours');
      const family = chainFamily(chain);
      if (!isAddressOf(family, address)) throw missing();
      const entry = deps.chains.get(chain);
      const owners = principal.wallets.filter((w) => w.family === family).map((w) => w.address);
      const mine = await refusing(async () =>
        (await Promise.all(owners.map((o) => entry.adapter.getVaults(o)))).flat(),
      );
      const state = mine.find((v) => sameVaultAddress(chain, v.address, address));
      if (!state) throw missing();
      // The row the name is kept on is the cache's, written from this read of the chain.
      const seen = await refusing(async () => {
        const listed = await entry.adapter.listAssets();
        const known = new Set(listed.map((a) => a.id));
        const assets = [state.cash.asset, ...state.positions.map((p) => p.asset)].filter((id) =>
          known.has(id),
        );
        const prices = assets.length ? await entry.adapter.getPrices([...new Set(assets)]) : [];
        return view(state, prices, listed);
      });
      await cacheVault(deps.db, seen, entry.provenance);
      await nameVault(deps.db, chain, state.address, req.body.name);
      return { chain, address: state.address, name: req.body.name };
    },
  );
}
