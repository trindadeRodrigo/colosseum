import { OrderError, PersonResponse, PickChainRequest } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { OrderDeps } from '../../orders/legs';
import { personChain, switchChain } from '../../orders/person';
import { signedIn } from './orders';

// Who is signed in, and their current chain, where new plans are made (gates ONE-CHAIN and CHAIN-SWITCH).

export function registerMeRoutes(scope: FastifyInstance, deps: OrderDeps) {
  const f = scope.withTypeProvider<ZodTypeProvider>();
  const tags = ['person'];

  f.get(
    '/v1/me',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags,
        summary: 'The signed-in person: their wallets, and the chain their new plans are made on',
        description:
          '`chain` is the current chain: a new plan is made there. Each plan lives on one chain, its own, and stays there when the current chain changes. Someone who connected an outside wallet starts on the chain of that wallet’s family: Solana, or Robinhood Chain for an EVM wallet (`chainSource` is `wallet`). Someone who made a wallet in the app picks the chain: until then `chain` is null. `chainOptions` lists the chains the person holds a wallet for, which they may switch to with `PUT /v1/me/chain`. The wallets are those of the verified identity token.',
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
        summary: 'Pick or switch the chain your new plans are made on',
        description:
          'Sets the current chain. It may be changed at any time; plans already made stay on their own chains, and are bought there. The chain has to be one this server offers (Solana or Robinhood Chain; another answers 422) and one the person holds a wallet for: a chain none of their wallets signs on answers 409 with code `NO_WALLET_FOR_CHAIN`, so someone signed in with an EVM wallet alone cannot switch to Solana. The same chain again answers as before and writes nothing.',
        body: PickChainRequest,
        response: { 200: PersonResponse, default: OrderError },
      },
    },
    async (req): Promise<PersonResponse> => {
      const principal = signedIn(req);
      const picked = await switchChain(deps.db, deps.chains, principal, req.body.chain, deps.now());
      return { userId: principal.userId ?? '', wallets: principal.wallets, ...picked };
    },
  );
}
