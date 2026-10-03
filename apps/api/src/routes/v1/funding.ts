import {
  type Address,
  type Chain,
  type FundingNeed,
  FundingQuery,
  FundingResponse,
  OrderError,
  type Principal,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Refusal, refusing } from '../../orders/errors';
import type { OrderDeps } from '../../orders/legs';
import { homeChain, personChain } from '../../orders/person';
import { planBuy } from '../../orders/prepare';
import { loadFamilies, loadProposal } from '../../orders/store';
import { signedIn } from './orders';

// What the wallet is missing on its chain before a buy can be signed (DESIGN-VAULT section 9): the
// dollar token, and the native token that pays the network fee. Both are read by the chain's adapter.

/** The token that pays the network fee, by wallet family: SOL on Solana, ETH on the EVM chains. */
const NATIVE: Record<Chain, { symbol: string; decimals: number }> = {
  solana: { symbol: 'SOL', decimals: 9 },
  evm: { symbol: 'ETH', decimals: 18 },
};

/**
 * The wallet a person's plans are held by on their chain's family: the outside wallet they connected
 * when that is what names their chain, the wallet made in the app otherwise.
 */
function walletOf(principal: Principal, family: Chain, outside: boolean): Address {
  const mine = principal.wallets.filter((w) => w.family === family);
  const wallet = mine.find((w) => (w.kind === 'external') === outside) ?? mine[0];
  if (!wallet) throw new Refusal(422, `no ${family} wallet is linked to this sign-in`);
  return wallet.address;
}

const missing = (need: string, have: string) =>
  (BigInt(need) > BigInt(have) ? BigInt(need) - BigInt(have) : 0n).toString();

export function registerFundingRoute(scope: FastifyInstance, deps: OrderDeps) {
  scope.withTypeProvider<ZodTypeProvider>().get(
    '/v1/funding',
    {
      config: { auth: 'user', limit: 'standard' },
      schema: {
        tags: ['funding'],
        summary:
          'What the signed-in wallet is missing on its chain: the dollar token and native gas',
        description:
          'For the one chain the person’s plans live on. With `proposalId` and `amountUsd`, the need is that of a buy of that amount: the whole deposit in the chain’s dollar token, and the network fee of every step the order would have. With neither, the need is nothing and the answer is what the wallet holds. `missingRaw` is what to add. Every figure carries its source, its time and its method, and `provenance`: `mock` on the mock chain, `sandbox` on a test network.',
        querystring: FundingQuery,
        response: { 200: FundingResponse, default: OrderError },
      },
    },
    async (req): Promise<FundingResponse> => {
      const principal = signedIn(req);
      const chain = await homeChain(deps.db, principal);
      const entry = deps.chains.get(chain);
      const { family } = entry.config;
      const outside = (await personChain(deps.db, principal)).chainSource === 'wallet';
      const wallet = walletOf(principal, family, outside);

      let need: FundingNeed = { cashRaw: '0', legs: 0, newVault: false, newAccounts: 0 };
      const { amountUsd, proposalId } = req.query;
      if (amountUsd !== undefined && proposalId !== undefined)
        // Planned by the function an order is planned with, so the steps counted are the order's.
        need = (
          await planBuy(
            { type: 'buy', owner: { [family]: wallet }, amountUsd, proposalId },
            {
              principal,
              chains: deps.chains,
              loadProposal: (id) => loadProposal(deps.db, id),
              homeChain: async () => chain,
              loadFamilies: (on) => loadFamilies(deps.db, on),
            },
          )
        ).need;

      const { adapter } = entry;
      const [read, assets] = await refusing(() =>
        Promise.all([adapter.funding(wallet, need), adapter.listAssets()]),
      );
      const cash = assets.find((a) => a.cls === 'cash');
      if (!cash) throw new Error(`${entry.chain} lists no cash token`);
      const stamp = {
        source: entry.source,
        fetchedAt: deps.now().toISOString(),
        provenance: entry.provenance,
      };
      const cashMissing = missing(read.cashNeedRaw, read.cashHaveRaw);
      const gasMissing = missing(read.gasNeedRaw, read.gasHaveRaw);
      const native = NATIVE[family];
      return {
        chain: entry.chain,
        name: entry.config.name,
        mode: entry.mode,
        provenance: entry.provenance,
        wallet,
        cash: {
          ...stamp,
          method: `the wallet's ${cash.symbol} balance, read by the chain adapter, against the deposit`,
          asset: cash.id,
          symbol: cash.symbol,
          decimals: cash.decimals,
          haveRaw: read.cashHaveRaw,
          needRaw: read.cashNeedRaw,
          missingRaw: cashMissing,
        },
        gas: {
          ...stamp,
          method: `the wallet's ${native.symbol} balance, read by the chain adapter, against the network fee of ${need.legs} step(s)${need.newVault ? ' and a new vault' : ''}`,
          symbol: native.symbol,
          decimals: native.decimals,
          haveRaw: read.gasHaveRaw,
          needRaw: read.gasNeedRaw,
          missingRaw: gasMissing,
        },
        steps: need.legs,
        newVault: need.newVault,
        // The adapter's own verdict, and nothing missing by the figures shown.
        ok: read.ok && cashMissing === '0' && gasMissing === '0',
      };
    },
  );
}
