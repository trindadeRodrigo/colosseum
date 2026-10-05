import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { loadMemory, saveMemory } from './memory';
import { runRound, type VaultLine } from './round';

// The keeper on Solana (DESIGN-VAULT 3.5, section 10): a worker with no HTTP listener.
//
//   SOLANA_RPC_URL=<devnet> KEEPER_SOLANA_KEYPAIR=<path> pnpm --filter @colosseum/keeper start --once
//   ... --loop [--interval 60]     a round every interval seconds, until stopped
//   ... --dry-run                  plans and builds, signs and sends nothing
//
// The network is CHAIN_NETWORK_SOLANA (testnet by default; mainnet is refused), and everything it acts
// on comes from that network's deploy record (deployments/solana-<network>.json): the program, the
// router, the price account, the tokens, and the keeper it signs as. The node behind SOLANA_RPC_URL has
// to answer the record's genesis, never mainnet's. It signs with the one key at KEEPER_SOLANA_KEYPAIR,
// and only if that key is the record's default keeper. Neither the key's path nor anything in the file
// is ever printed.
//
// What it remembers between runs (the legs it sent and has not settled, and the legs that reverted) is
// in KEEPER_STATE_DIR (default ~/.tenonfi/keeper), one file per network, read at start and written
// before anything is sent on the strength of it.

const DEPLOYMENTS = fileURLToPath(new URL('../../../deployments/', import.meta.url));

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
  const network = process.env.CHAIN_NETWORK_SOLANA?.trim() || 'testnet';
  if (network === 'mainnet') throw new Error('the keeper does not run on mainnet in this slot');
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
  const stateFile = join(
    process.env.KEEPER_STATE_DIR?.trim() || join(homedir(), '.tenonfi', 'keeper'),
    `${record.network}.json`,
  );
  const memory = loadMemory(stateFile);
  const log = (line: VaultLine) =>
    console.log(JSON.stringify({ at: new Date().toISOString(), network: record.network, ...line }));

  for (;;) {
    const lines = await runRound(
      {
        adapter,
        dryRun,
        log,
        sign: async (tx) => {
          // Only what the keeper itself builds, as the keeper.
          if (tx.signer !== key.address)
            throw new Error(`a transaction for ${tx.signer}, not the keeper`);
          const { wire, signature } = await signBase64(tx.payload, key);
          return { wire, txId: signature };
        },
        save: (m) => saveMemory(stateFile, m),
      },
      memory,
    );
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        round: 'done',
        vaults: lines.length,
        acted: lines.filter((l) => l.outcome === 'acted').length,
        alerts: lines.filter((l) => l.alert).length,
        inFlight: memory.inFlight.size,
      }),
    );
    if (!loop) return;
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
