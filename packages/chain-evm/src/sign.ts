import { readFileSync } from 'node:fs';
import type { BuiltTx } from '@colosseum/schemas';
import { type Abi, encodeFunctionData, type Hex, keccak256, type PublicClient } from 'viem';
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';

// The one place an EVM key becomes a signer (DESIGN-VAULT section 2, rule 5), behind
// '@colosseum/chain-evm/server'. Only apps/keeper and scripts/ import it. Neither a key's path nor
// anything in its file is ever part of a message.

/** The account in a file holding one 0x private key in hex. Test networks only. */
export function loadEvmKey(path: string): PrivateKeyAccount {
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error('the key file cannot be read');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) throw new Error('the key file does not hold one EVM key');
  return privateKeyToAccount(text as Hex);
}

/**
 * A fresh EVM key for a test-network wallet, with its address: for a file outside every checkout
 * (scripts/testnet/faucet-keys.ts). The caller writes the key and prints only the address.
 */
export function newEvmKey(): { key: Hex; address: string } {
  const key = generatePrivateKey();
  return { key, address: privateKeyToAccount(key).address };
}

/**
 * Signs what an EVM builder built, as built: its target, data and chain, on the nonce and gas limit it
 * states, at the fee per gas its preview states (the fee over the gas), with no tip. Refuses a
 * transaction for another signer. Answers the signed bytes and the transaction's id.
 */
export async function signBuilt(
  account: PrivateKeyAccount,
  tx: BuiltTx,
): Promise<{ wire: Hex; txId: Hex }> {
  if (tx.signer !== account.address.toLowerCase())
    throw new Error(`a transaction for ${tx.signer}, not this key`);
  const evm = tx.evm;
  if (!evm || evm.nonce === undefined || evm.gas === undefined)
    throw new Error('the transaction states no nonce or gas limit');
  const maxFeePerGas = BigInt(tx.preview.feeNativeRaw) / BigInt(evm.gas);
  const wire = await account.signTransaction({
    type: 'eip1559',
    chainId: evm.chainId,
    to: evm.to as Hex,
    data: tx.payload as Hex,
    value: BigInt(evm.value),
    nonce: evm.nonce,
    gas: BigInt(evm.gas),
    maxFeePerGas,
    maxPriorityFeePerGas: 0n,
  });
  return { wire, txId: keccak256(wire) };
}

/** One call a script makes as a test-network key: its target, and the function with its arguments. */
export type ScriptCall = {
  to: Hex;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  /** Native coin sent with the call, in wei. */
  value?: bigint;
  /** What the call does, in words, for the script's printout. */
  what: string;
};

/**
 * Runs a call as `account` on a test network: simulated first (a refusal says why and sends nothing),
 * then, only with `send`, signed on the account's next nonce at twice the node's gas price and sent,
 * and waited for. Refuses any chain but the one named: a key of a test network never signs for
 * another. Answers the transaction's id, or null for a dry run.
 */
export async function callAs(
  account: PrivateKeyAccount,
  rpc: PublicClient,
  chainId: number,
  call: ScriptCall,
  send: boolean,
): Promise<string | null> {
  const answered = await rpc.getChainId();
  if (answered !== chainId) throw new Error(`the node is chain ${answered}, not ${chainId}`);
  const data = call.abi.length
    ? encodeFunctionData({
        abi: call.abi,
        functionName: call.functionName,
        args: call.args ?? [],
      } as Parameters<typeof encodeFunctionData>[0])
    : '0x';
  const request = { account: account.address, to: call.to, data, value: call.value ?? 0n };
  await rpc.call(request);
  if (!send) return null;
  const [gas, gasPrice, nonce] = await Promise.all([
    rpc.estimateGas(request),
    rpc.getGasPrice(),
    rpc.getTransactionCount({ address: account.address, blockTag: 'pending' }),
  ]);
  const wire = await account.signTransaction({
    type: 'eip1559',
    chainId,
    to: call.to,
    data,
    value: call.value ?? 0n,
    nonce,
    gas: (gas * 6n) / 5n,
    maxFeePerGas: gasPrice * 2n,
    maxPriorityFeePerGas: 0n,
  });
  const hash = await rpc.sendRawTransaction({ serializedTransaction: wire });
  const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`${call.what} reverted: ${hash}`);
  return hash;
}
