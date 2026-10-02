import type { ChainId } from '@colosseum/schemas';
import type { WalletChain, WalletChains } from '../chains';
import type { EvmRequest } from '../driver';

// Reads and sends for the dev page, straight to each network's public RPC. The product does neither
// from the browser: the API reads the chain and relays what the wallet signed.

/** A figure with where it came from, when and how, as every figure in this repo carries. */
export type Reading<T> = {
  value: T;
  source: string;
  fetchedAt: string;
  method: string;
  provenance: 'live' | 'sandbox';
};

async function call<T>(chain: WalletChain, method: string, params: unknown[]): Promise<Reading<T>> {
  const res = await fetch(chain.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error || body.result === undefined)
    throw new Error(`${method}: ${body.error?.message ?? 'no result'}`);
  return {
    value: body.result,
    source: new URL(chain.rpcUrl).host,
    fetchedAt: new Date().toISOString(),
    method,
    provenance: chain.provenance,
  };
}

const map = <A, B>(r: Reading<A>, f: (a: A) => B): Reading<B> => ({ ...r, value: f(r.value) });

export function solanaRpc(chain: WalletChain) {
  return {
    /** Lamports. */
    balance: async (address: string) =>
      map(
        await call<{ value: number }>(chain, 'getBalance', [address, { commitment: 'confirmed' }]),
        (r) => BigInt(r.value),
      ),
    latestBlockhash: async () =>
      map(
        await call<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
          chain,
          'getLatestBlockhash',
          [{ commitment: 'confirmed' }],
        ),
        (r) => r.value,
      ),
    /** Sends a signed transaction (base64) and returns its signature. */
    send: async (signed: string) =>
      (await call<string>(chain, 'sendTransaction', [signed, { encoding: 'base64' }])).value,
  };
}

export function evmRpc(chain: WalletChain) {
  const big = async (method: string, params: unknown[]) =>
    map(await call<string>(chain, method, params), (hex) => BigInt(hex));
  return {
    /** Wei. */
    balance: (address: string) => big('eth_getBalance', [address, 'latest']),
    /** What a wallet fills in by itself: the nonce, the gas and the fee. For the throwaway wallet. */
    fees: async (from: string, request: EvmRequest) => {
      const call_ = { from, to: request.to, data: request.data, value: hex(request.value) };
      const [nonce, gas, price] = await Promise.all([
        big('eth_getTransactionCount', [from, 'pending']),
        big('eth_estimateGas', [call_]),
        big('eth_gasPrice', []),
      ]);
      return {
        nonce: Number(nonce.value),
        gas: gas.value,
        maxFeePerGas: price.value * 2n,
        maxPriorityFeePerGas: price.value,
      };
    },
    /** Sends a signed transaction (0x) and returns its hash. */
    send: async (signed: string) =>
      (await call<`0x${string}`>(chain, 'eth_sendRawTransaction', [signed])).value,
  };
}

const hex = (n: bigint) => `0x${n.toString(16)}`;

/** The chain in the table that is set to this EVM chain id. */
export function chainOfEvmId(chains: WalletChains, evmChainId: number): WalletChain {
  const id = (Object.keys(chains) as ChainId[]).find(
    (c) => chains[c].config.evmChainId === evmChainId,
  );
  if (!id) throw new Error(`no chain here is set to chain id ${evmChainId}`);
  return chains[id];
}
