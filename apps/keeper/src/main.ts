import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvmKey, signBuilt } from '@colosseum/chain-evm/server';
import {
  assertNode as assertEvmNode,
  createEvmRpc,
  createEvmVaultAdapter,
  EvmDeploymentRecord,
  deploymentAddresses as evmAddresses,
  deploymentAssets as evmAssets,
  ROBINHOOD_MAINNET_POOLS,
  ROBINHOOD_TESTNET_POOLS,
} from '@colosseum/chain-evm/vault';
import { loadKeypair, signBase64 } from '@colosseum/chain-solana/server';
import {
  assertNode,
  createSolanaVaultAdapter,
  createVaultRpc,
  deploymentAddresses,
  deploymentAssets,
  SolanaDeploymentRecord,
} from '@colosseum/chain-solana/vault';
import { parseChainConfigs } from '@colosseum/schemas';
import { lowGasFromEnv, notifierFromEnv } from './alerts';
import { runKeeper, type Wired } from './keeper';
import { keepRunning } from './loop';
import { loadMemory, lockState, saveMemory } from './memory';
import { PoolFeedsFile, watchRound } from './watch';

// The keeper (DESIGN-VAULT 3.5, section 10): a worker with no HTTP listener, on one chain a process,
// KEEPER_CHAIN=solana (the default) or robinhood.
//
//   SOLANA_RPC_URL=<devnet> KEEPER_SOLANA_KEYPAIR=<path> pnpm --filter @colosseum/keeper start --once
//   KEEPER_CHAIN=robinhood ROBINHOOD_RPC_URL=<46630 node> KEEPER_ROBINHOOD_KEY=<path> ... --once
//   ... --loop [--interval 60]     a round every interval seconds, until stopped; a failed round is
//                                  logged as `round-failed`, alerted, and retried after a back-off (loop.ts)
//   ... --dry-run                  plans and builds, signs and sends nothing; on EVM each vault's line
//                                  carries the feed's price, the average and their distance per position
//   KEEPER_CHAIN=robinhood CHAIN_NETWORK_ROBINHOOD=mainnet ROBINHOOD_RPC_URL=<4663 node> ... --dry-run
//                                  mainnet, read only: no key and no deploy record; one line an asset
//                                  with Chainlink's price, the pool's average and what the keeper's
//                                  price check would decide (watch.ts). Without --dry-run it is refused.
//
// The network is CHAIN_NETWORK_SOLANA (testnet by default; mainnet is refused), and everything it acts
// on comes from that network's deploy record (deployments/solana-<network>.json): the program, the
// router, the price account, the tokens, and the keeper it signs as. The node behind SOLANA_RPC_URL has
// to answer the record's genesis, never mainnet's. It signs with the one key at KEEPER_SOLANA_KEYPAIR,
// and only if that key is the record's default keeper. Neither the key's path nor anything in the file
// is ever printed.
//
// What it remembers between runs (the legs it sent and has not settled, and the legs that reverted) is
// in KEEPER_STATE_DIR (default ~/.tenonfi/keeper), one file per network and genesis, read at start and
// written before anything is sent on the strength of it. One keeper at a time holds it: a second one
// refuses to start.

const DEPLOYMENTS = fileURLToPath(new URL('../../../deployments/', import.meta.url));
const POOL_FEEDS = fileURLToPath(
  new URL('../../../contracts/script/config/pool-feeds/', import.meta.url),
);

function args(argv: string[]) {
  const has = (flag: string) => argv.includes(flag);
  const at = argv.indexOf('--interval');
  const interval = at >= 0 ? Number(argv[at + 1]) : 60;
  if (!Number.isFinite(interval) || interval < 10)
    throw new Error('--interval is seconds, 10 or more');
  if (has('--once') === has('--loop')) throw new Error('say --once or --loop');
  return { loop: has('--loop'), dryRun: has('--dry-run'), interval };
}

async function main() {
  const { loop, dryRun, interval } = args(process.argv.slice(2));
  const chain = process.env.KEEPER_CHAIN?.trim() || 'solana';
  // Robinhood Chain mainnet: a dry run only, which reads prices and holds no key. Without --dry-run
  // it falls through to `robinhood()`, which refuses mainnet as it always has.
  if (chain === 'robinhood' && process.env.CHAIN_NETWORK_ROBINHOOD?.trim() === 'mainnet' && dryRun)
    return watchMainnet({ loop, intervalMs: interval * 1000 });
  const wired =
    chain === 'robinhood' ? await robinhood() : chain === 'solana' ? await solana() : null;
  if (!wired) throw new Error(`KEEPER_CHAIN is solana or robinhood, not ${chain}`);
  const stateFile = join(
    process.env.KEEPER_STATE_DIR?.trim() || join(homedir(), '.tenonfi', 'keeper'),
    `${wired.stateName}.json`,
  );
  lockState(stateFile, (line) => console.error(line));
  // Stopped by a signal, the process still exits through its exit handlers, which release the lock.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => process.exit(1));
  const memory = loadMemory(stateFile);
  await runKeeper({
    wired,
    loop,
    dryRun,
    intervalMs: interval * 1000,
    memory,
    save: (m) => saveMemory(stateFile, m),
    notify: notifierFromEnv(process.env, { label: `keeper ${wired.network}` }),
    hide: hideNodes,
  });
}

const hideNodes = (text: string) =>
  // A failed round's reason never carries a node's address: a private node's has its key in it.
  (['SOLANA_RPC_URL', 'ROBINHOOD_RPC_URL'] as const).reduce((t, name) => {
    const url = process.env[name]?.trim();
    return url ? t.split(url).join(`<${name}>`) : t;
  }, text);

/**
 * Robinhood Chain mainnet, `--dry-run` only: no deploy record, no key, no state file, nothing signed
 * and nothing sent. Each round reads the Chainlink feed and the Uniswap v3 pool of every asset in the
 * chain's pool-feed file (KEEPER_POOL_FEEDS, by default contracts/script/config/pool-feeds/4663.json)
 * and prints one line an asset: the spot, the pool's average, their distance in bps, and why the
 * keeper's price check would refuse (watch.ts). The session it holds them to is that file's `watch`
 * section.
 */
async function watchMainnet(o: { loop: boolean; intervalMs: number }): Promise<void> {
  const path = process.env.KEEPER_POOL_FEEDS?.trim() || `${POOL_FEEDS}4663.json`;
  if (!existsSync(path)) throw new Error('no pool-feed file for Robinhood Chain mainnet');
  const file = PoolFeedsFile.parse(JSON.parse(readFileSync(path, 'utf8')));
  const url = process.env.ROBINHOOD_RPC_URL?.trim();
  if (!url) throw new Error('ROBINHOOD_RPC_URL is not set');
  const rpc = createEvmRpc(url);
  const chainId = await rpc.getChainId();
  if (chainId !== file.chainId)
    throw new Error(
      `the node answers chain ${chainId}, and the pool-feed file is for ${file.chainId}`,
    );
  const network = 'robinhood-mainnet';
  const say = (fields: object) =>
    console.log(
      JSON.stringify({ at: new Date().toISOString(), network, mode: 'dry-run', ...fields }),
    );
  const notify = notifierFromEnv(process.env, { label: `keeper ${network} dry run` });
  await keepRunning({
    loop: o.loop,
    intervalMs: o.intervalMs,
    failed: async (f) => {
      say({ ...f, reason: hideNodes(f.reason) });
      await notify.ping(false);
    },
    round: async () => {
      const lines = await watchRound({ rpc, file, log: say });
      await notify.ping(true);
      say({
        round: 'done',
        assets: lines.length,
        wouldPass: lines.filter((l) => l.outcome === 'would-pass').length,
        sent: 0,
      });
    },
  });
}

/**
 * Robinhood Chain: CHAIN_NETWORK_ROBINHOOD (testnet by default; mainnet is refused), its deploy record
 * (deployments/robinhood-<network>.json), the node behind ROBINHOOD_RPC_URL held to the record's chain
 * id, and the key at KEEPER_ROBINHOOD_KEY, which has to be the factory's keeper.
 */
async function robinhood(): Promise<Wired> {
  const network = process.env.CHAIN_NETWORK_ROBINHOOD?.trim() || 'testnet';
  if (network !== 'testnet' && network !== 'local')
    throw new Error(
      'the keeper runs Robinhood Chain on its test network or a local copy only; on mainnet it reads prices with --dry-run and sends nothing',
    );
  // 0.0005 ETH
  const low = lowGasFromEnv(process.env, 500_000_000_000_000n);
  const name = `robinhood-${network}`;
  const file = `${DEPLOYMENTS}${name}.json`;
  if (!existsSync(file)) throw new Error(`no deploy record for CHAIN_NETWORK_ROBINHOOD=${network}`);
  const record = EvmDeploymentRecord.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (record.network !== name) throw new Error(`${file} is the record of ${record.network}`);
  const url = process.env.ROBINHOOD_RPC_URL?.trim();
  if (!url) throw new Error('ROBINHOOD_RPC_URL is not set');
  const rpc = createEvmRpc(url);
  await assertEvmNode(rpc, record);
  const keyPath = process.env.KEEPER_ROBINHOOD_KEY?.trim();
  if (!keyPath) throw new Error('KEEPER_ROBINHOOD_KEY is not set');
  const key = loadEvmKey(keyPath);
  const { factory, registry, router } = evmAddresses(record);
  const config = parseChainConfigs(
    { CHAIN_NETWORK_ROBINHOOD: network, ...(router ? { CHAIN_ROUTER_ROBINHOOD: router } : {}) },
    { robinhood: { factory, registry } },
  ).robinhood;
  const adapter = createEvmVaultAdapter({
    config,
    rpc,
    assets: evmAssets(record),
    pools: network === 'local' ? ROBINHOOD_MAINNET_POOLS : ROBINHOOD_TESTNET_POOLS,
    trade: 'live',
    autoFollow: true,
  });
  // The factory names the keeper; the record's copy is only what the deploy set.
  const { keeper } = await adapter.getPlatform();
  if (keeper !== key.address.toLowerCase())
    throw new Error(
      `the key at KEEPER_ROBINHOOD_KEY is not the keeper the factory names (${keeper})`,
    );
  return {
    network: record.network,
    adapter,
    sign: (tx) => signBuilt(key, tx),
    stateName: `${record.network}-${record.evmChainId}-${record.contracts.factory}`,
    gas: async () => ({
      have: await rpc.getBalance({ address: key.address }),
      low,
      unit: 'wei',
    }),
  };
}

/** Solana: as KEEP-1 built it. */
async function solana(): Promise<Wired> {
  const network = process.env.CHAIN_NETWORK_SOLANA?.trim() || 'testnet';
  if (network === 'mainnet') throw new Error('the keeper does not run on mainnet in this slot');
  // 0.05 SOL
  const low = lowGasFromEnv(process.env, 50_000_000n);
  const name =
    network === 'testnet' ? 'solana-devnet' : network === 'local' ? 'solana-local' : null;
  const file = name ? `${DEPLOYMENTS}${name}.json` : null;
  if (!file || !existsSync(file))
    throw new Error(`no deploy record for CHAIN_NETWORK_SOLANA=${network}`);
  const record = SolanaDeploymentRecord.parse(JSON.parse(readFileSync(file, 'utf8')));
  if (record.network !== name) throw new Error(`${file} is the record of ${record.network}`);

  const url = process.env.SOLANA_RPC_URL?.trim();
  if (!url) throw new Error('SOLANA_RPC_URL is not set');
  const rpc = createVaultRpc(url);
  await assertNode(rpc, record);

  const keyPath = process.env.KEEPER_SOLANA_KEYPAIR?.trim();
  if (!keyPath) throw new Error('KEEPER_SOLANA_KEYPAIR is not set');
  // The loader's own errors can name the path or quote the file: none of it is passed on.
  const key = await loadKeypair(keyPath).catch(() => {
    throw new Error(
      'the file at KEEPER_SOLANA_KEYPAIR is not a Solana keypair this keeper can read',
    );
  });
  if (key.address !== record.roles.defaultKeeper)
    throw new Error(`the key at KEEPER_SOLANA_KEYPAIR is not ${record.network}'s default keeper`);

  const { program, router, priceAccount } = deploymentAddresses(record);
  const config = parseChainConfigs(
    {
      CHAIN_NETWORK_SOLANA: network,
      CHAIN_ROUTER_SOLANA: router,
      CHAIN_PRICE_SOURCE_SOLANA: priceAccount,
    },
    { solana: { program } },
  ).solana;
  const adapter = createSolanaVaultAdapter({
    config,
    rpc,
    assets: deploymentAssets(record),
    autoFollow: true,
  });
  return {
    network: record.network,
    adapter,
    sign: async (tx) => {
      // Only what the keeper itself builds, as the keeper.
      if (tx.signer !== key.address)
        throw new Error(`a transaction for ${tx.signer}, not the keeper`);
      const { wire, signature } = await signBase64(tx.payload, key);
      return { wire, txId: signature };
    },
    // The node's genesis, which assertNode held to the record's: a reset local validator starts afresh.
    stateName: `${record.network}-${await rpc.getGenesisHash().send()}`,
    gas: async () => ({
      have: BigInt((await rpc.getBalance(key.address).send()).value),
      low,
      unit: 'lamports',
    }),
  };
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
