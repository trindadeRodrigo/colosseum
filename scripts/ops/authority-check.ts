import { readFileSync } from 'node:fs';
import {
  CallReverted,
  type ChainLog,
  checkAuthority,
  formatLine,
  parseRecord,
  type Reader,
  verdict,
} from './authority';

// Who holds every role of the EVM vault contracts on one chain, against that chain's deployment record
// (ledger row SEC-1). Read-only: eth_chainId, eth_blockNumber, eth_call, eth_getCode, eth_getStorageAt
// and eth_getLogs, all at one block. It takes no key and sends nothing.
//
//   pnpm ops:authority-check --record deployments/robinhood-testnet.json --rpc-env ROBINHOOD_RPC_URL
//   pnpm ops:authority-check --record <file> --rpc <url> [--log-chunk 50000]
//
// `--rpc-env` names the environment variable that holds the node's URL; `--rpc` gives a URL that is
// public. The URL is never printed. One line per fact, then a verdict. Exits 0 when the chain is as the
// record says, 1 when anything differs, breaks a mainnet rule or could not be read, 2 on a bad
// command line.

type Json = { result?: unknown; error?: { code?: number; message?: string } };

/** A reader over one node's JSON-RPC, every state read at the block it found first. */
export function jsonRpcReader(url: string): Reader {
  let id = 0;
  // The node's own words are not passed on: they can carry the URL.
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    let body: Json;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      body = (await response.json()) as Json;
    } catch {
      throw new Error(`the RPC did not answer ${method}`);
    }
    if (body.error) {
      if (
        method === 'eth_call' &&
        (body.error.code === 3 || /revert/i.test(body.error.message ?? ''))
      )
        throw new CallReverted();
      throw new Error(`the RPC refused ${method}`);
    }
    if (body.result === undefined || body.result === null)
      throw new Error(`the RPC gave no result for ${method}`);
    return body.result;
  }
  const hex = (n: number) => `0x${n.toString(16)}`;
  let head: Promise<number> | undefined;
  const blockNumber = () => {
    head ??= rpc('eth_blockNumber', []).then((r) => Number(BigInt(r as string)));
    return head;
  };
  const at = async () => hex(await blockNumber());
  return {
    chainId: async () => Number(BigInt((await rpc('eth_chainId', [])) as string)),
    blockNumber,
    call: async (to, data) => (await rpc('eth_call', [{ to, data }, await at()])) as string,
    code: async (address) => (await rpc('eth_getCode', [address, await at()])) as string,
    storageAt: async (address, slot) =>
      (await rpc('eth_getStorageAt', [address, slot, await at()])) as string,
    logs: async (filter) =>
      (await rpc('eth_getLogs', [
        {
          address: filter.address,
          fromBlock: hex(filter.fromBlock),
          toBlock: hex(filter.toBlock),
          topics: filter.topics,
        },
      ])) as ChainLog[],
  };
}

const USAGE =
  'say --record <deployments/file.json> and one of --rpc-env <NAME of the variable holding the URL> or --rpc <url>';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const recordFile = flag('--record');
  const rpcEnv = flag('--rpc-env');
  const rpcUrl = flag('--rpc');
  const chunk = flag('--log-chunk');
  if (!recordFile || (rpcEnv === undefined) === (rpcUrl === undefined)) {
    console.error(USAGE);
    return 2;
  }
  if (chunk !== undefined && !/^[1-9]\d*$/.test(chunk)) {
    console.error('--log-chunk is a number of blocks');
    return 2;
  }
  const url = rpcUrl ?? process.env[rpcEnv as string]?.trim();
  if (!url) {
    console.error(`${rpcEnv} is not set`);
    return 2;
  }
  if (!/^https?:\/\//.test(url)) {
    console.error('the RPC URL is not http(s)');
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(recordFile, 'utf8');
  } catch {
    console.error(`${recordFile} cannot be read`);
    return 2;
  }
  const record = parseRecord(text);
  const reader = jsonRpcReader(url);
  console.log(`record\t${recordFile}\tchain id ${record.evmChainId}`);
  const result = await checkAuthority(record, reader, {
    logChunk: chunk === undefined ? undefined : Number(chunk),
  });
  for (const line of result.lines) console.log(formatLine(line));
  console.log(verdict(result));
  for (const failure of result.failures) console.log(`  - ${failure}`);
  return result.failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
