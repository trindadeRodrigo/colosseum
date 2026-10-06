import type { ChainId } from '@colosseum/schemas';
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
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
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import { type Abi, encodeFunctionData, type Hex, isAddress, type PublicClient } from 'viem';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import type { ChainEntry, EvmInputs, SolanaInputs } from '../orders/chains';
import { onTestNetwork, type TestFundsSend, type TestFundsSender } from './test-funds';

// The one file of apps/api that holds a key (DESIGN-VAULT section 2, rule 5, held to a condition): the
// test faucet's, a wallet of its own made for it (scripts/testnet/faucet-keys.ts) that holds a float of
// test tokens and transfers from it. It mints nothing and holds no authority or role: never the admin,
// upgrade or deployer key. Nothing loads it but one dynamic import in routes/v1/index.ts, inside
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

/** A mint's token program and decimals, read from its account: the same offsets in both programs. */
async function mintOf(rpc: SolanaInputs['rpc'], mint: Address) {
  const { value } = await rpc.getMultipleAccounts([mint], { encoding: 'base64' }).send();
  const account = value[0];
  if (!account) throw new Error('the test dollar mint is not on this network');
  const data = Buffer.from(account.data[0], 'base64');
  if (data.length < 82) throw new Error('the test dollar mint is not a mint');
  return { tokenProgram: account.owner, decimals: data[44] ?? 0 };
}

/** The faucet's token account for a mint: the associated one. */
const ataOf = async (owner: Address, mint: Address, tokenProgram: Address) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram }))[0];

/**
 * The instructions of one Solana send, all from the faucet's float: the wallet's token account for
 * the test dollar (made if it is not there), the test dollar moved into it from the faucet's own
 * account (`transferChecked`, the faucet as owner), and SOL for fees. Nothing is minted.
 */
export async function solanaTestFundsInstructions(
  faucet: TransactionSigner,
  order: TestFundsSend,
  mint: { tokenProgram: Address; decimals: number },
): Promise<IInstruction[]> {
  const to = address(order.to);
  const cash = address(order.cashAddress);
  const { tokenProgram, decimals } = mint;
  const ixs: IInstruction[] = [];
  if (order.cashRaw > 0n) {
    const create = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: faucet,
      owner: to,
      mint: cash,
      tokenProgram,
    });
    ixs.push(
      create,
      getTransferCheckedInstruction(
        {
          source: await ataOf(faucet.address, cash, tokenProgram),
          mint: cash,
          destination: create.accounts[1].address,
          authority: faucet,
          amount: order.cashRaw,
          decimals,
        },
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
    async float(cashAddress) {
      const mint = address(cashAddress);
      const { tokenProgram } = await mintOf(rpc, mint);
      const ata = await ataOf(faucet.address, mint, tokenProgram);
      const [{ value: lamports }, { value: accounts }] = await Promise.all([
        rpc.getBalance(faucet.address, { commitment: 'confirmed' }).send(),
        rpc.getMultipleAccounts([ata], { encoding: 'base64' }).send(),
      ]);
      const data = accounts[0] ? Buffer.from(accounts[0].data[0], 'base64') : null;
      // A token account's amount: a u64 after the mint and the owner.
      const cashRaw = data && data.length >= 72 ? data.readBigUInt64LE(64) : 0n;
      return { cashRaw, gasRaw: BigInt(lamports) };
    },
    async send(order) {
      const ixs = await solanaTestFundsInstructions(
        faucet,
        order,
        await mintOf(rpc, address(order.cashAddress)),
      );
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

/** The test dollar's two calls the faucet makes (tUSDG, an ERC-20): a balance, and a transfer. */
const TOKEN_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const satisfies Abi;

/** The calls of one EVM send, from the faucet's float: the test dollar transferred, then ETH for fees. */
export function evmTestFundsCalls(order: TestFundsSend): { to: Hex; data: Hex; value: bigint }[] {
  if (!isAddress(order.to) || !isAddress(order.cashAddress)) throw new Error('not an EVM address');
  const calls: { to: Hex; data: Hex; value: bigint }[] = [];
  if (order.cashRaw > 0n)
    calls.push({
      to: order.cashAddress,
      data: encodeFunctionData({
        abi: TOKEN_ABI,
        functionName: 'transfer',
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
    async float(cashAddress) {
      if (!isAddress(cashAddress)) throw new Error('not an EVM address');
      const [cashRaw, gasRaw] = await Promise.all([
        rpc.readContract({
          address: cashAddress,
          abi: TOKEN_ABI,
          functionName: 'balanceOf',
          args: [account.address],
        }),
        rpc.getBalance({ address: account.address }),
      ]);
      return { cashRaw, gasRaw };
    },
    async send(order) {
      // A key of a test network never signs for another chain.
      const answered = await rpc.getChainId();
      if (answered !== chainId) throw new Error(`the node is chain ${answered}, not ${chainId}`);
      const hashes: string[] = [];
      for (const call of evmTestFundsCalls(order)) {
        const request = { account: account.address, ...call };
        // Simulated first: a refusal sends nothing.
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
