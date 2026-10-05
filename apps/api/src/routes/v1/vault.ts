import { view } from '@colosseum/basket';
import {
  ChainError,
  chainFamily,
  DISCLAIMER,
  isAddressOf,
  OrderError,
  VaultResponse,
  VaultRouteParams,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Refusal, refusing } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';

// The public vault page's read (WEB-4, DESIGN-VAULT section 11): any vault, by its chain and address,
// read from the chain for the answer, so a visitor with no funds sees real state. Nothing is written.

export function registerVaultRoute(scope: FastifyInstance, deps: OrderDeps) {
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/v1/vaults/:chain/:address',
    {
      config: { auth: 'public', limit: 'standard' },
      schema: {
        tags: ['portfolio'],
        summary: 'One vault, read from its chain, for anybody',
        description:
          "The vault's holdings, targets, value, weights and drift, read from its chain for this answer, with the reference prices they were worked out with. Anybody may read it: a vault's state is public on its chain. A chain this server has switched off answers `CHAIN_UNAVAILABLE`; an address in the other chain family's form answers 400, and one where there is no vault 404. Every figure carries `provenance`.",
        params: VaultRouteParams,
        response: { 200: VaultResponse, default: OrderError },
      },
    },
    async (req) => {
      const { chain, address } = req.params;
      if (!isAddressOf(chainFamily(chain), address))
        throw new Refusal(400, `that is not an address of ${deps.chains.name(chain)}`);
      const entry = deps.chains.get(chain);
      return refusing(async () => {
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
    },
  );
}
