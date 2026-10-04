import { OrderError, PersonResponse, PickChainRequest } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { OrderDeps } from '../../orders/legs';
import { personChain, pickChain } from '../../orders/person';
import { signedIn } from './orders';

// Who is signed in, and the one chain their plans live on (gates ONE-CHAIN and CHAIN-PICK).

export function registerMeRoutes(scope: FastifyInstance, deps: OrderDeps) {
  const f = scope.withTypeProvider<ZodTypeProvider>();
  const tags = ['person'];

  f.get(
    '/v1/me',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags,
        summary: 'The signed-in person: their wallets, and the chain their plans live on',
        description:
          'A plan lives on one chain, the chain of the person’s wallet. Someone who connected an outside wallet is on the chain of that wallet’s family: Solana, or Robinhood Chain for an EVM wallet (`chainSource` is `wallet`). Someone who made a wallet in the app picks the chain once: until then `chain` is null and `chainOptions` lists what may be picked. The wallets are those of the verified identity token.',
        response: { 200: PersonResponse, default: OrderError },
      },
    },
    async (req): Promise<PersonResponse> => {
      const principal = signedIn(req);
      return {
        userId: principal.userId ?? '',
        wallets: principal.wallets,
        ...(await personChain(deps.db, principal)),
      };
    },
  );

  f.put(
    '/v1/me/chain',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags,
        summary: 'Pick the chain your plans live on. Once',
        description:
          'For someone who made a wallet in the app. The chain has to be one they hold a wallet for and one this server runs: Solana or Robinhood Chain. The pick is stored once and never changes: the same chain again answers as before, another chain answers 409. Someone whose chain is that of the outside wallet they connected has nothing to pick, and another chain answers 409 too.',
        body: PickChainRequest,
        response: { 200: PersonResponse, default: OrderError },
      },
    },
    async (req): Promise<PersonResponse> => {
      const principal = signedIn(req);
      const picked = await pickChain(deps.db, deps.chains, principal, req.body.chain, deps.now());
      return { userId: principal.userId ?? '', wallets: principal.wallets, ...picked };
    },
  );
}
