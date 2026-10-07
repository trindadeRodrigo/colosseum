import { z } from 'zod';
import { Address, AssetId, ChainId, RawAmount, Sourced } from './chain';
import { Provenance } from './enums';
import { ChainMode } from './flags';
import { ORDER_LIMITS } from './order';
import { WalletAccount } from './wallet';

// The bodies of the /v1 routes about the signed-in person and their wallet: who they are and which
// current chain, where their new plans are made (gates ONE-CHAIN and CHAIN-SWITCH), and what the
// wallet is missing there.

/**
 * GET /v1/me, and the answer of PUT /v1/me/chain. `chain` is the current chain: a new plan is made
 * there. Each plan lives on one chain, its own, and stays there when the current chain changes.
 * - Someone who connected an outside wallet starts on the chain of that wallet's family: a Solana
 *   wallet means Solana, an EVM wallet means Robinhood Chain while Base is not deployed. `chainSource`
 *   is `wallet`.
 * - Someone who made a wallet in the app picks the chain. Until then `chain` is null.
 * - Either may switch to any chain in `chainOptions`; after a switch `chainSource` is `picked`.
 */
export const PersonResponse = z.object({
  /** The person, as the sign-in provider names them. */
  userId: z.string().min(1),
  /** The wallets of the verified identity token. Nothing the request says is in here. */
  wallets: z.array(WalletAccount),
  chain: ChainId.nullable(),
  chainSource: z.enum(['picked', 'wallet']).nullable(),
  /** The chains this person holds a wallet for, and so may switch to. An EVM wallet alone: Robinhood Chain. */
  chainOptions: z.array(ChainId),
});
export type PersonResponse = z.infer<typeof PersonResponse>;

/** PUT /v1/me/chain. Switches the current chain; the same chain again answers as before. */
export const PickChainRequest = z.strictObject({ chain: ChainId });
export type PickChainRequest = z.infer<typeof PickChainRequest>;

/**
 * The query of GET /v1/funding. With nothing, the answer is what the wallet holds. With a plan and an
 * amount, it is what a buy of that amount needs: the cash, and the network fee of every step the order
 * would have. The two come together: the fee depends on the plan's steps.
 *
 * `wallet` is the wallet to read, one of the person's on their chain. An order may name any of the
 * person's wallets of that family as its owner, so a caller that holds more than one asks about the
 * one the order will name. Left out, it is the wallet the person's plans are held by: the outside
 * wallet when that is what names the chain, the wallet made in the app when the chain was picked.
 */
export const FundingQuery = z
  .object({
    wallet: Address.optional(),
    amountUsd: z.coerce
      .number()
      .positive()
      .max(ORDER_LIMITS.maxAmountUsd, 'one order buys at most $1,000,000')
      .optional(),
    proposalId: z.uuid().optional(),
    /** A shared portfolio's slug, in place of `proposalId`: a buy that follows it (WEB-4). */
    family: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    /**
     * A vault of the person's, in place of `proposalId` and `family`: adding `amountUsd` to it (a buy
     * that names the vault). Sent with `vaultChain`, the chain it is on, and with `wallet`, its owner.
     */
    vault: Address.optional(),
    vaultChain: ChainId.optional(),
  })
  .refine((q) => [q.proposalId, q.family, q.vault].filter((x) => x !== undefined).length <= 1, {
    message: 'send one of proposalId, family and vault',
  })
  .refine((q) => (q.vault === undefined) === (q.vaultChain === undefined), {
    message: 'send vault and vaultChain together',
  })
  .refine(
    (q) =>
      (q.amountUsd === undefined) ===
      (q.proposalId === undefined && q.family === undefined && q.vault === undefined),
    { message: 'send amountUsd with proposalId, family or vault, or none of them' },
  );
export type FundingQuery = z.infer<typeof FundingQuery>;

/**
 * One balance against what is needed of it, in raw units, with where the reading came from. `missingRaw`
 * is the need less the holding and never under zero: what to add before the steps can be signed.
 */
export const FundingFigure = Sourced.extend({
  symbol: z.string().min(1),
  decimals: z.number().int().nonnegative(),
  haveRaw: RawAmount,
  needRaw: RawAmount,
  missingRaw: RawAmount,
});
export type FundingFigure = z.infer<typeof FundingFigure>;

/**
 * GET /v1/funding: what the signed-in wallet is missing on its chain, the dollar token and the native
 * token that pays the network fee. Every figure carries its source, time and method, and the chain's
 * provenance: `mock` on the mock chain, `sandbox` on a test network, `live` on mainnet only.
 */
export const FundingResponse = z.object({
  chain: ChainId,
  name: z.string(),
  mode: ChainMode,
  provenance: Provenance,
  wallet: Address,
  /** The chain's dollar token: the only token a deposit is made in. */
  cash: FundingFigure.extend({ asset: AssetId }),
  /** The chain's native token, which pays the network fee of every step. */
  gas: FundingFigure,
  /** How many transactions the need was worked out for, and whether the first of them opens a vault. */
  steps: z.number().int().nonnegative(),
  newVault: z.boolean(),
  /** True when nothing is missing. */
  ok: z.boolean(),
  /**
   * True when this server can send the missing test tokens and gas itself (POST /v1/testnet/fund): a
   * test network only, with a faucet key configured for the chain. Left out or false: it cannot.
   */
  testFunds: z.boolean().optional(),
});
export type FundingResponse = z.infer<typeof FundingResponse>;

/**
 * POST /v1/testnet/fund: send the signed-in wallet what it is missing for this buy, on a test network
 * only. The same buy as GET /v1/funding names: the server works out what is missing itself, and sends
 * that with a small margin, never an amount the request states.
 */
export const TestFundsRequest = z
  .strictObject({
    wallet: Address.optional(),
    amountUsd: z
      .number()
      .positive()
      .max(ORDER_LIMITS.maxAmountUsd, 'one order buys at most $1,000,000'),
    proposalId: z.uuid().optional(),
    family: FundingQuery.shape.family,
    /** A vault of the person's that the buy adds to, with the chain it is on (as GET /v1/funding). */
    vault: FundingQuery.shape.vault,
    vaultChain: FundingQuery.shape.vaultChain,
  })
  .refine((q) => [q.proposalId, q.family, q.vault].filter((x) => x !== undefined).length === 1, {
    message: 'send proposalId, family or vault, one of them',
  })
  .refine((q) => (q.vault === undefined) === (q.vaultChain === undefined), {
    message: 'send vault and vaultChain together',
  });
export type TestFundsRequest = z.infer<typeof TestFundsRequest>;

/**
 * What POST /v1/testnet/fund answers, with 409, when its float cannot cover a send: the faucet is a
 * wallet holding test tokens, and a person tops it up. `error` tells these from the other 409 (nothing
 * missing) and the gas from the test dollars.
 */
export const TEST_FUNDS_LOW = {
  gas: 'test gas is low; ask the team',
  cash: 'test funds are low; ask the team',
} as const;

/** One token sent by the test faucet, in raw units. */
export const TestFundsSent = z.object({
  symbol: z.string().min(1),
  decimals: z.number().int().nonnegative(),
  raw: RawAmount,
});

/** What POST /v1/testnet/fund sent: test tokens on a test network, never anything of value. */
export const TestFundsResponse = z.object({
  chain: ChainId,
  provenance: z.literal('sandbox'),
  wallet: Address,
  cash: TestFundsSent,
  gas: TestFundsSent,
  /** The test network's transaction ids, in the order they were sent. */
  txIds: z.array(z.string().min(1)),
  /** How many more times this person may ask today. */
  left: z.number().int().nonnegative(),
});
export type TestFundsResponse = z.infer<typeof TestFundsResponse>;
