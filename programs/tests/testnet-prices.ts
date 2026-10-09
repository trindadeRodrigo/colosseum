import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  type Address,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  getBase64Encoder,
} from '@solana/kit';
import { REPO_ROOT } from './src/env';
import {
  clusterOf,
  keypairFromFile,
  MAINNET_GENESIS,
  retryOn429,
  rpcChain,
} from './src/testnet/chain';
import { copyRound, loadSources, readPrices, roundLine } from './src/testnet/prices';
import type { Deployment } from './src/testnet/setup';

// Copies real prices onto the Solana test network's price account (TNET-5). Run it from the repo root:
//
//   SOLANA_RPC_URL=<devnet> SOLANA_PRICE_WRITER_KEYPAIR=<path> \
//     pnpm exec tsx scripts/testnet/solana/prices.ts --once | --loop [options]
//
//   --once                 one round, then exit
//   --loop                 a round every --interval seconds (default 30) until stopped
//   --dry-run              read and print what would be written; send nothing
//   --interval <s>         seconds between rounds in --loop
//   --max-jump-bps <bps>   refuse a value further than this from what devnet holds, per hour since
//                          devnet's entry was stamped (default 1000; at least an hour's worth, at most 5000)
//   --record <file>        the deployment record (default deployments/solana-devnet.json)
//   --hold-last            while a source posts nothing new (a closed market), write its last value
//                          again with the cluster's time so the price does not go stale; each one is
//                          logged as `held <token> at <price> (source last posted <time>)`
//
// MAINNET_RPC_URL is read only (default https://api.mainnet-beta.solana.com): the source must answer
// with mainnet's genesis hash, and nothing is ever sent to it. The destination must not: its genesis
// is checked as the set-up checks it. SOLANA_PRICE_WRITER_KEYPAIR is the price writer the exchange
// names, never the deploy key. Each round logs one line.

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const at = args.lastIndexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const fromRoot = (path: string) => (isAbsolute(path) ? path : join(REPO_ROOT, path));
const log = (line: string) => console.log(line);

function need(name: string): string {
  const found = process.env[name];
  if (!found)
    throw new Error(`${name} is not set (see the top of programs/tests/testnet-prices.ts)`);
  return found;
}

/** The source: mainnet over its JSON RPC, read only. There is no way to send through it. */
function readOnly(url: string) {
  const rpc = createSolanaRpcFromTransport(retryOn429(createDefaultRpcTransport({ url })));
  const base64 = getBase64Encoder();
  return {
    genesisHash: () => rpc.getGenesisHash().send(),
    async account(target: Address) {
      const { value: found } = await rpc
        .getAccountInfo(target, { encoding: 'base64', commitment: 'confirmed' })
        .send();
      if (!found) return null;
      return {
        data: new Uint8Array(base64.encode(found.data[0])),
        owner: found.owner,
        lamports: found.lamports,
      };
    },
  };
}

async function main(): Promise<void> {
  const once = flag('--once');
  const loop = flag('--loop');
  if (once === loop) throw new Error('say --once or --loop');
  const dryRun = flag('--dry-run');
  const holdLast = flag('--hold-last');
  const interval = Number(value('--interval') ?? 30);
  const maxJumpBps = Number(value('--max-jump-bps') ?? 1000);
  if (!(interval >= 5) || !(maxJumpBps > 0))
    throw new Error('--interval is at least 5 s, --max-jump-bps above 0');

  const url = need('SOLANA_RPC_URL');
  const chain = rpcChain(url);
  const genesis = await chain.genesisHash();
  const cluster = clusterOf(url, genesis);
  const source = readOnly(process.env.MAINNET_RPC_URL ?? 'https://api.mainnet-beta.solana.com');
  if ((await source.genesisHash()) !== MAINNET_GENESIS)
    throw new Error(
      'MAINNET_RPC_URL does not answer with mainnet: real prices come from mainnet only',
    );

  const deployment: Deployment = JSON.parse(
    readFileSync(fromRoot(value('--record') ?? 'deployments/solana-devnet.json'), 'utf8'),
  );
  if (deployment.genesisHash && deployment.genesisHash !== genesis)
    throw new Error(
      `the record is for genesis ${deployment.genesisHash}, and this cluster is ${genesis}`,
    );
  const writer = await keypairFromFile(need('SOLANA_PRICE_WRITER_KEYPAIR'));
  const sources = loadSources();
  log(
    `copying mainnet prices onto ${cluster} as ${writer.address}; ${loop ? `every ${interval} s` : 'once'}${dryRun ? '; dry run: nothing is sent' : ''}${holdLast ? '; holding the last price of a source that has stopped' : ''}; provenance sandbox`,
  );

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      stopping = true;
    });
  for (let round = 1; ; round++) {
    const started = Date.now();
    try {
      const readings = await readPrices(source, sources);
      const result = await copyRound(chain, writer, deployment, readings, {
        dryRun,
        maxJumpBps,
        holdLast,
        log,
      });
      log(roundLine(new Date(), round, result, dryRun));
    } catch (error) {
      // A round that fails is logged and the next one tries again: a node that is down for a minute
      // is no reason to stop.
      log(`${new Date().toISOString()} round ${round}: failed: ${(error as Error).message}`);
      if (once) process.exitCode = 1;
    }
    if (once || stopping) break;
    const wait = Math.max(0, interval * 1000 - (Date.now() - started));
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (stopping) break;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
