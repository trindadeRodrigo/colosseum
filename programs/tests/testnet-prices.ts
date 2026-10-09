import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  type Address,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  getBase64Encoder,
  type RpcTransport,
} from '@solana/kit';
import { REPO_ROOT } from './src/env';
import {
  clusterOf,
  keypairFromFile,
  MAINNET_GENESIS,
  retryOn429,
  rpcChainOver,
  timedOut,
} from './src/testnet/chain';
import { nodeFailure, retryDelayMs, urlList, withFailover } from './src/testnet/failover';
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
// MAINNET_RPC_URL is read only (default: the two public nodes in SOURCE_NODES): the source must answer
// with mainnet's genesis hash, and nothing is ever sent to it. The destination must not: its genesis
// is checked as the set-up checks it. SOLANA_PRICE_WRITER_KEYPAIR is the price writer the exchange
// names, never the deploy key. Each round logs one line.
//
// Either URL variable takes a list, comma separated. Every node of a list is checked at the start; a
// node that stops answering is left for the next one (src/testnet/failover.ts), and a round that
// fails is tried again after 2 s, then 4, 8 and so on up to the interval. A URL may carry a key: no
// line this job logs names one, a node is "source node 2".

/** Mainnet, read only, where nothing else is said: Solana's public node, then PublicNode's. */
const SOURCE_NODES = 'https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com';

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

/**
 * The nodes of one side, each asked for its genesis hash and held to `check`. One that does not
 * answer now is left out and said so by its number; one that answers wrongly stops the job. What is
 * left is one transport that fails over, and the genesis hash they share.
 */
async function nodes(
  side: 'source' | 'destination',
  urls: string[],
  check: (url: string, genesis: string) => void,
): Promise<{ transport: RpcTransport; genesis: string; count: number }> {
  if (urls.length === 0) throw new Error(`no ${side} node is named`);
  // With another node to go to, a rate limit is waited out twice, not eight times.
  const tries = urls.length > 1 ? 3 : 8;
  const answering: RpcTransport[] = [];
  let genesis: string | null = null;
  for (const [i, url] of urls.entries()) {
    const transport = timedOut(retryOn429(createDefaultRpcTransport({ url }), { tries }));
    let found: string;
    try {
      found = await createSolanaRpcFromTransport(transport).getGenesisHash().send();
    } catch (error) {
      const why = nodeFailure(error);
      if (why === null) throw new Error(`${side} node ${i + 1} gave no genesis hash`);
      log(`${side} node ${i + 1} does not answer (${why}): left out`);
      continue;
    }
    try {
      check(url, found);
    } catch {
      // The check's own words may name the host.
      const mainnet = found === MAINNET_GENESIS;
      throw new Error(
        side === 'source'
          ? `source node ${i + 1} does not answer with mainnet: real prices come from mainnet only`
          : `destination node ${i + 1} is ${mainnet ? 'mainnet' : 'neither devnet nor on this machine'}: nothing is sent`,
      );
    }
    if (genesis !== null && found !== genesis)
      throw new Error(`${side} node ${i + 1} is another cluster than node 1`);
    genesis = found;
    answering.push(transport);
  }
  if (genesis === null) throw new Error(`no ${side} node answers`);
  return {
    transport: withFailover(answering, (from, to, why) =>
      log(`${new Date().toISOString()} ${side} node ${from} failed (${why}): asking node ${to}`),
    ) as RpcTransport,
    genesis,
    count: answering.length,
  };
}

/** The source: mainnet over its JSON RPC, read only. There is no way to send through it. */
function readOnly(transport: RpcTransport) {
  const rpc = createSolanaRpcFromTransport(transport);
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

  const urls = urlList(need('SOLANA_RPC_URL'));
  const sourceUrls = urlList(process.env.MAINNET_RPC_URL ?? SOURCE_NODES);
  // No error's words reach the log with a node's address in them.
  const scrub = (text: string) =>
    [...urls, ...sourceUrls]
      .flatMap((url) => [url, new URL(url).host])
      .reduce((clean, secret) => clean.split(secret).join('<node>'), text);
  const destination = await nodes('destination', urls, (url, found) => {
    clusterOf(url, found);
  });
  const genesis = destination.genesis;
  const cluster = clusterOf(urls[0] as string, genesis);
  const chain = rpcChainOver(destination.transport);
  const from = await nodes('source', sourceUrls, (_url, found) => {
    if (found !== MAINNET_GENESIS) throw new Error('not mainnet');
  });
  const source = readOnly(from.transport);

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
    `copying mainnet prices onto ${cluster} as ${writer.address}; ${loop ? `every ${interval} s` : 'once'}${dryRun ? '; dry run: nothing is sent' : ''}${holdLast ? '; holding the last price of a source that has stopped' : ''}; ${from.count} source and ${destination.count} destination node(s); provenance sandbox`,
  );

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      stopping = true;
    });
  let failures = 0;
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
      failures = 0;
    } catch (error) {
      failures += 1;
      // A round that fails is logged and the next one tries again, soon: a node that is down for a
      // minute is no reason to stop, and a held price has 120 s to live.
      log(
        `${new Date().toISOString()} round ${round}: failed: ${scrub((error as Error).message)}; next in ${retryDelayMs(failures, interval * 1000) / 1000} s`,
      );
      if (once) process.exitCode = 1;
    }
    if (once || stopping) break;
    const wait =
      failures > 0
        ? retryDelayMs(failures, interval * 1000)
        : Math.max(0, interval * 1000 - (Date.now() - started));
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (stopping) break;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
