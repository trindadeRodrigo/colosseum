import { OrderError, TestFundsRequest, TestFundsResponse } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { TestFunds } from '../../faucet/test-funds';
import { Refusal } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { readFunding } from './funding';
import { signedIn } from './orders';

// POST /v1/testnet/fund: the test faucet (faucet/test-funds.ts). It reads what the wallet is missing for
// the buy as GET /v1/funding does, and sends that with a small margin, on a test network only. A server
// with no faucet key answers 404 here, and GET /v1/funding never says `testFunds` there.

export function registerTestnetRoute(
  scope: FastifyInstance,
  deps: OrderDeps,
  testFunds: TestFunds | null,
) {
  scope.withTypeProvider<ZodTypeProvider>().post(
    '/v1/testnet/fund',
    {
      // Each send costs the faucet; a build's budget on top of the faucet's own daily counts.
      config: { auth: 'user', limit: 'build' },
      schema: {
        tags: ['funding'],
        summary:
          'Test network only: send the signed-in wallet the test tokens and gas a buy is missing',
        description:
          'For the one chain the person’s plans live on, when it runs on a test network and this server holds a faucet key for it (GET /v1/funding says `testFunds: true`). The server works out what is missing for this buy itself, as GET /v1/funding does, and sends that with a small margin: test dollars minted to the wallet, and the native token for fees. Never on mainnet. A person may ask three times a day, the faucet as a whole a hundred; one send is at most $5,000 in test dollars. The answer names what was sent and the test network’s transaction ids, and nothing about the node or the key.',
        body: TestFundsRequest,
        response: { 200: TestFundsResponse, default: OrderError },
      },
    },
    async (req): Promise<TestFundsResponse> => {
      const principal = signedIn(req);
      // Counted per person: a sign-in with no person behind it gets none.
      if (!principal.userId) throw new Refusal(401, 'sign in first');
      if (!testFunds) throw new Refusal(404, 'this server sends no test funds');
      const { entry, read } = await readFunding(deps, principal, req.body);
      return testFunds.send(principal.userId, entry, read);
    },
  );
}
