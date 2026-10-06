import { type AssetId, ChainError, evmCallPreimage } from '@colosseum/schemas';
import { type Address, type Hex, sha256, stringToBytes } from 'viem';
import { revertToChainError } from './errors';
import { ask, type EvmRpc } from './rpc';

// One EVM transaction from a builder's call: simulated against the chain as it is, its gas limit and
// fee stated, its nonce stated, the token balances it moves read from the simulation, and its message
// hash worked out by the rule of packages/schemas (`evmCallPreimage`).

/** The gas limit is what the node estimates plus a fifth. */
const GAS_HEADROOM_NUM = 6n;
const GAS_HEADROOM_DEN = 5n;
/** keccak256("Transfer(address,address,uint256)"). */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** The SHA-256 of a call, without nonce, gas or fees: what ties signed bytes back to the build. */
export function callHash(call: {
  chainId: number;
  signer: string;
  to: string;
  value: string;
  data: string;
}): string {
  return sha256(stringToBytes(evmCallPreimage(call))).slice(2);
}

export type Composed = {
  to: Address;
  data: Hex;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  feeWei: bigint;
  messageHash: string;
  /** The token balances the simulation moved, by holder. */
  changes: { holder: 'wallet' | 'vault'; asset: AssetId; deltaRaw: string }[];
  gasUsed: bigint;
};

type SimulatedCall = {
  status: string;
  returnData: Hex;
  gasUsed: Hex;
  logs: { address: Address; topics: Hex[]; data: Hex }[];
  error?: { code?: number; message?: string; data?: Hex };
};

/**
 * Runs the call as `signer` against the latest block with `eth_simulateV1`, its token transfers traced,
 * and refuses with the contract's own error if it reverts. Then states a gas limit (the node's estimate
 * plus a fifth), the fee at the node's current price for that gas, and the nonce.
 */
export async function compose(a: {
  rpc: EvmRpc;
  chainId: number;
  signer: Address;
  to: Address;
  data: Hex;
  nonce?: number;
  /** Who is who in the transfers: the signer is the wallet; the vault, where there is one. */
  vault?: Address;
  /** The asset id of a token address, listed or not. */
  idOf: (token: Address) => AssetId;
}): Promise<Composed> {
  const { rpc, signer, to, data } = a;
  const [simulated] = (await ask('eth_simulateV1', () =>
    rpc.request({
      method: 'eth_simulateV1' as never,
      params: [
        {
          blockStateCalls: [{ calls: [{ from: signer, to, data }] }],
          traceTransfers: true,
          validation: false,
        },
        'latest',
      ] as never,
    }),
  )) as { calls: SimulatedCall[] }[];
  const call = simulated?.calls[0];
  if (!call) throw new ChainError('Unavailable', 'the node answered no simulation of the call');
  if (call.status !== '0x1') throw revertToChainError(call.returnData ?? call.error?.data);

  const [estimate, fees, nonce] = await Promise.all([
    ask('eth_estimateGas', () => rpc.estimateGas({ account: signer, to, data })),
    ask('the fee', () => rpc.estimateFeesPerGas()),
    a.nonce !== undefined
      ? Promise.resolve(a.nonce)
      : ask('eth_getTransactionCount', () =>
          rpc.getTransactionCount({ address: signer, blockTag: 'pending' }),
        ),
  ]);
  const gas = (estimate * GAS_HEADROOM_NUM + GAS_HEADROOM_DEN - 1n) / GAS_HEADROOM_DEN;
  const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
  return {
    to,
    data,
    nonce,
    gas,
    maxFeePerGas,
    feeWei: gas * maxFeePerGas,
    messageHash: callHash({ chainId: a.chainId, signer, to, value: '0', data }),
    changes: changesOf(call.logs, signer, a.vault, a.idOf),
    gasUsed: BigInt(call.gasUsed),
  };
}

/** The net of every ERC-20 transfer to or from the wallet or the vault, by token, in the order first seen. */
function changesOf(
  logs: SimulatedCall['logs'],
  wallet: Address,
  vault: Address | undefined,
  idOf: (token: Address) => AssetId,
): Composed['changes'] {
  const net = new Map<string, { holder: 'wallet' | 'vault'; asset: AssetId; delta: bigint }>();
  const holderOf = (who: string): 'wallet' | 'vault' | null =>
    who === wallet.toLowerCase() ? 'wallet' : vault && who === vault.toLowerCase() ? 'vault' : null;
  for (const log of logs) {
    // An ERC-20 transfer has the topic, two indexed addresses and the amount in its data. The native
    // token's transfers that `traceTransfers` adds come from 0xeeee…: not a token here.
    if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (/^0xe{40}$/i.test(log.address)) continue;
    const from = `0x${log.topics[1]?.slice(26)}`.toLowerCase();
    const recipient = `0x${log.topics[2]?.slice(26)}`.toLowerCase();
    const amount = BigInt(log.data);
    const token = log.address.toLowerCase() as Address;
    for (const [who, sign] of [
      [from, -1n],
      [recipient, 1n],
    ] as const) {
      const holder = holderOf(who);
      if (!holder) continue;
      const key = `${holder}:${token}`;
      const entry = net.get(key) ?? { holder, asset: idOf(token), delta: 0n };
      entry.delta += sign * amount;
      net.set(key, entry);
    }
  }
  return [...net.values()]
    .filter((e) => e.delta !== 0n)
    .map((e) => ({ holder: e.holder, asset: e.asset, deltaRaw: e.delta.toString() }));
}
