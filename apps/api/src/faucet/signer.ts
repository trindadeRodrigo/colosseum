import type { ChainId } from '@colosseum/schemas';
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type IInstruction,
  type KeyPairSigner,
  pipe,
  type Signature,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
} from '@solana-program/token';
import { type Abi, encodeFunctionData, type Hex, isAddress, type PublicClient } from 'viem';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import type { ChainEntry, EvmInputs, SolanaInputs } from '../orders/chains';
import { onTestNetwork, type TestFundsSend, type TestFundsSender } from './test-funds';

// The one file of apps/api that holds a key (DESIGN-VAULT section 2, rule 5, held to a condition): the
// test faucet's. Nothing loads it but one dynamic import in routes/v1/index.ts, inside
// `if (faucetKeys)`, which is set only when a faucet key is configured for a chain that runs on its
// real adapter on a test network. A key is read from the value handed in, never from a file, and is
// never part of a message. Each sender checks the network again before it signs anything.

const WAIT_MS = 60_000;

/** The senders for every chain a faucet key was handed in for. Refuses a chain not on a test network. */
export async function createFaucetSenders(
  keys: Partial<Record<ChainId, string>>,
  entries: ChainEntry[],
  inputs: { solana?: SolanaInputs; robinhood?: EvmInputs },
): Promise<TestFundsSender[]> {
  const senders: TestFundsSender[] = [];
  for (const entry of entries) {
    const key = keys[entry.chain];
    if (!key) continue;
    if (!onTestNetwork(entry))
      throw new Error(
        `a faucet key is set for ${entry.config.name}, which is not on a test network`,
      );
    if (entry.chain === 'solana' && inputs.solana)
      senders.push(solanaSender(await solanaKey(key), inputs.solana.rpc));
    else if (entry.chain === 'robinhood' && inputs.robinhood && entry.config.evmChainId)
      senders.push(evmSender(evmKey(key), inputs.robinhood.rpc, entry.config.evmChainId));
  }
  return senders;
}

/** A Solana key as `solana-keygen` writes it: a JSON array of 64 bytes. */
async function solanaKey(text: string): Promise<KeyPairSigner> {
  let bytes: Uint8Array;
  try {
    const list = JSON.parse(text) as unknown;
    if (!Array.isArray(list) || list.length !== 64) throw new Error();
    bytes = Uint8Array.from(list as number[]);
  } catch {
    throw new Error('the Solana faucet key is not a JSON array of 64 bytes');
  }
  return createKeyPairSignerFromBytes(bytes);
}

/** An EVM key: 0x and 64 hex digits. */
function evmKey(text: string): PrivateKeyAccount {
  if (!/^0x[0-9a-fA-F]{64}$/.test(text))
    throw new Error('the EVM faucet key is not 0x and 64 hex digits');
  return privateKeyToAccount(text as Hex);
}

/**
 * The instructions of one Solana send: the wallet's token account for the test dollar (made if it is
 * not there), the test dollar minted into it by the faucet as the mint's authority, and SOL for fees.
 */
export async function solanaTestFundsInstructions(
  faucet: TransactionSigner,
  order: TestFundsSend,
  tokenProgram: Address,
): Promise<IInstruction[]> {
  const to = address(order.to);
  const mint = address(order.cashAddress);
  const ixs: IInstruction[] = [];
  if (order.cashRaw > 0n) {
    const create = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: faucet,
      owner: to,
      mint,
      tokenProgram,
    });
    const ata = create.accounts[1].address;
    ixs.push(
      create,
      getMintToInstruction(
        { mint, token: ata, mintAuthority: faucet, amount: order.cashRaw },
        { programAddress: tokenProgram },
      ),
    );
  }
  if (order.gasRaw > 0n)
    ixs.push(getTransferSolInstruction({ source: faucet, destination: to, amount: order.gasRaw }));
  return ixs;
}

function solanaSender(faucet: KeyPairSigner, rpc: SolanaInputs['rpc']): TestFundsSender {
  return {
    chain: 'solana',
    async send(order) {
      // The mint's program, and that this key may mint it: a key that may not sends nothing.
      const { value } = await rpc
        .getMultipleAccounts([address(order.cashAddress)], { encoding: 'base64' })
        .send();
      const mint = value[0];
      if (!mint) throw new Error('the test dollar mint is not on this network');
      const data = Buffer.from(mint.data[0], 'base64');
      const authority =
        data.readUInt32LE(0) === 1 ? getAddressDecoder().decode(data.subarray(4, 36)) : null;
      if (authority !== faucet.address) throw new Error('the faucet key is not the mint authority');
      const ixs = await solanaTestFundsInstructions(faucet, order, mint.owner);
      const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      const signed = await signTransactionMessageWithSigners(
        pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayerSigner(faucet, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
          (m) => appendTransactionMessageInstructions(ixs, m),
        ),
      );
      const signature = getSignatureFromTransaction(signed);
      await rpc
        .sendTransaction(getBase64EncodedWireTransaction(signed), {
          encoding: 'base64',
          preflightCommitment: 'confirmed',
        })
        .send();
      const deadline = Date.now() + WAIT_MS;
      while (Date.now() < deadline) {
        const { value: st } = await rpc.getSignatureStatuses([signature as Signature]).send();
        const s = st[0];
        if (s?.err) throw new Error(`the transfer failed on chain: ${signature}`);
        if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized')
          return [signature];
        await new Promise((r) => setTimeout(r, 1_000));
      }
      throw new Error(`the transfer was not confirmed in time: ${signature}`);
    },
  };
}

/** The test dollar's mint call (tUSDG): the faucet key needs its MINTER_ROLE. */
const MINT_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

/** The calls of one EVM send: the test dollar minted to the wallet, then ETH for fees. */
export function evmTestFundsCalls(order: TestFundsSend): { to: Hex; data: Hex; value: bigint }[] {
  if (!isAddress(order.to) || !isAddress(order.cashAddress)) throw new Error('not an EVM address');
  const calls: { to: Hex; data: Hex; value: bigint }[] = [];
  if (order.cashRaw > 0n)
    calls.push({
      to: order.cashAddress,
      data: encodeFunctionData({
        abi: MINT_ABI,
        functionName: 'mint',
        args: [order.to, order.cashRaw],
      }),
      value: 0n,
    });
  if (order.gasRaw > 0n) calls.push({ to: order.to, data: '0x', value: order.gasRaw });
  return calls;
}

function evmSender(
  account: PrivateKeyAccount,
  rpc: PublicClient,
  chainId: number,
): TestFundsSender {
  return {
    chain: 'robinhood',
    async send(order) {
      // A key of a test network never signs for another chain.
      const answered = await rpc.getChainId();
      if (answered !== chainId) throw new Error(`the node is chain ${answered}, not ${chainId}`);
      const hashes: string[] = [];
      for (const call of evmTestFundsCalls(order)) {
        const request = { account: account.address, ...call };
        // Simulated first: a refusal (no minter role) sends nothing.
        await rpc.call(request);
        const [gas, gasPrice, nonce] = await Promise.all([
          rpc.estimateGas(request),
          rpc.getGasPrice(),
          rpc.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        ]);
        const wire = await account.signTransaction({
          type: 'eip1559',
          chainId,
          ...call,
          nonce,
          gas: (gas * 6n) / 5n,
          maxFeePerGas: gasPrice * 2n,
          maxPriorityFeePerGas: 0n,
        });
        const hash = await rpc.sendRawTransaction({ serializedTransaction: wire });
        const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: WAIT_MS });
        if (receipt.status !== 'success') throw new Error(`the transfer reverted: ${hash}`);
        hashes.push(hash);
      }
      return hashes;
    },
  };
}
