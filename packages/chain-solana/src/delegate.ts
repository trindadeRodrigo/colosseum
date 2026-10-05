import { type Address, address, type Instruction, type KeyPairSigner } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  fetchMaybeToken,
  fetchToken,
  findAssociatedTokenPda,
  getApproveCheckedInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getRevokeInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  buildSignedV0,
  buildUnsignedV0,
  jupiterInstructions,
  type SignedV0,
  type UnsignedV0,
} from './compose';
import { getQuote, getSwapInstructions } from './jupiter';
import type { SolanaRpc } from './rpc';

/**
 * Policy mechanism A (spike D2-PM): the user approves an agent key as SPL delegate for a bounded amount of a leg;
 * the agent then rebalances that leg without a fresh user signature, in one atomic transaction:
 *   delegate transfer (user ATA → agent ATA) → Jupiter swap (agent as user) → output to the USER's ATA.
 * Token-program mints only (USDC, USDY, syrupUSDC). Token-2022 mints with transfer hooks (xStocks) are out of scope here.
 */

export const ata = async (owner: Address, mint: Address) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

/** User-signed, once per policy: approve `amountBase` of `mint` to the agent and fund the agent's fees. */
export async function buildPolicySetupTx(
  rpc: SolanaRpc,
  owner: KeyPairSigner,
  agent: Address,
  mint: Address,
  amountBase: bigint,
  decimals: number,
  agentFeeLamports: bigint,
): Promise<SignedV0> {
  const source = await ata(owner.address, mint);
  const ixs: Instruction[] = [
    getApproveCheckedInstruction({
      source,
      mint,
      delegate: agent,
      owner,
      amount: amountBase,
      decimals,
    }),
    getTransferSolInstruction({ source: owner, destination: agent, amount: agentFeeLamports }),
  ];
  return buildSignedV0(rpc, owner, ixs, []);
}

export type DelegatedSwap = SignedV0 & {
  quote: { inAmount: string; outAmount: string; priceImpactPct: string };
  agentInAta: Address;
  ownerOutAta: Address;
};

/** Agent-signed only: move `amountBase` of `inputMint` from the user via delegate authority, swap, deliver output to the user. */
export async function buildDelegatedSwapTx(
  rpc: SolanaRpc,
  agent: KeyPairSigner,
  owner: Address,
  inputMint: Address,
  outputMint: Address,
  amountBase: bigint,
  decimals: number,
): Promise<DelegatedSwap> {
  const ownerInAta = await ata(owner, inputMint);
  const agentInAta = await ata(agent.address, inputMint);
  const ownerOutAta = await ata(owner, outputMint);
  // Fail early if the user has no output account: Jupiter assumes destinationTokenAccount exists.
  await fetchToken(rpc, ownerOutAta);
  const quote = await getQuote({ inputMint, outputMint, amountBase });
  const swap = await getSwapInstructions({
    quote,
    userPublicKey: agent.address,
    destinationTokenAccount: ownerOutAta,
  });
  const ixs: Instruction[] = [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: agent,
      owner: agent.address,
      mint: inputMint,
    }),
    getTransferCheckedInstruction({
      source: ownerInAta,
      mint: inputMint,
      destination: agentInAta,
      authority: agent,
      amount: amountBase,
      decimals,
    }),
    ...jupiterInstructions(swap),
  ];
  const built = await buildSignedV0(rpc, agent, ixs, swap.addressLookupTableAddresses);
  return {
    ...built,
    quote: {
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      priceImpactPct: quote.priceImpactPct,
    },
    agentInAta,
    ownerOutAta,
  };
}

export const asAddress = (s: string) => address(s);

/** Token balance and delegate state of `owner`'s ATA for `mint` (null if the account does not exist). */
export async function tokenAccountState(
  rpc: SolanaRpc,
  owner: Address,
  mint: Address,
  decimals = 6,
) {
  const t = await fetchMaybeToken(rpc, await ata(owner, mint));
  if (!t.exists) return null;
  return {
    amount: Number(t.data.amount) / 10 ** decimals,
    delegate:
      t.data.delegate.__option === 'Some'
        ? {
            to: t.data.delegate.value as string,
            amount: Number(t.data.delegatedAmount) / 10 ** decimals,
          }
        : null,
  };
}

/** User-signed: approve several mints to the agent in one transaction (policy activation). */
export async function buildApprovalsTx(
  rpc: SolanaRpc,
  owner: KeyPairSigner,
  agent: Address,
  approvals: Array<{ mint: Address; amountBase: bigint; decimals: number }>,
  agentFeeLamports = 0n,
): Promise<SignedV0> {
  const ixs: Instruction[] = [];
  for (const a of approvals) {
    ixs.push(
      getApproveCheckedInstruction({
        source: await ata(owner.address, a.mint),
        mint: a.mint,
        delegate: agent,
        owner,
        amount: a.amountBase,
        decimals: a.decimals,
      }),
    );
  }
  if (agentFeeLamports > 0n)
    ixs.push(
      getTransferSolInstruction({ source: owner, destination: agent, amount: agentFeeLamports }),
    );
  return buildSignedV0(rpc, owner, ixs, []);
}

/** Unsigned revoke of the delegate on several mints (the wallet signs): the policy off-switch. */
export async function buildRevokeUnsigned(
  rpc: SolanaRpc,
  owner: Address,
  mints: Address[],
): Promise<UnsignedV0> {
  const ixs: Instruction[] = [];
  for (const mint of mints)
    ixs.push(getRevokeInstruction({ source: await ata(owner, mint), owner }));
  return buildUnsignedV0(rpc, owner, ixs, []);
}
