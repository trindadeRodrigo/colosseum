import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { type Address, createKeyPairSignerFromBytes } from '@solana/kit';
import { REPO_ROOT } from './src/env';
import { clusterOf, rpcChain } from './src/testnet/chain';
import { loadPlan } from './src/testnet/config';
import { type Deployment, guardSolanaEntry, setUp } from './src/testnet/setup';

// Sets up a Solana test network after the two programs are deployed. Run it from the repo root:
//
//   SOLANA_RPC_URL=<cluster> SOLANA_KEYPAIR=<path> pnpm exec tsx scripts/testnet/solana/setup.ts [options]
//
//   --dry-run            print every transaction and send none
//   --config <file>      what to set up (default scripts/testnet/solana/devnet.config.json)
//   --out <file>         the record of what was made (default deployments/solana-devnet.json on devnet)
//   --guard-file <file>  the SDK guard's deployment file, whose `chains.solana` this writes
//                        (default packages/sdk/deployments/testnet.json on devnet)
//   --no-lookup-table    leave the platform's lookup table out
//   --omit-extension <name>   leave one extension out of the stock token's set (may be repeated)
//
// SOLANA_KEYPAIR is the path of the key that deployed both programs: their upgrade authority, which
// becomes the admin of both. The file is read to sign and is never printed. The script refuses
// mainnet by its genesis hash, and any cluster that is neither devnet nor on this machine. It never
// calls `launch()`. A second run sends nothing.

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const values = (name: string) =>
  args.flatMap((arg, i) => (arg === name && args[i + 1] ? [args[i + 1] as string] : []));
const value = (name: string) => values(name).at(-1);
const fromRoot = (path: string) => (isAbsolute(path) ? path : join(REPO_ROOT, path));
const log = (line: string) => console.log(line);

function need(name: string): string {
  const found = process.env[name];
  if (!found)
    throw new Error(`${name} is not set (see the top of programs/tests/testnet-setup.ts)`);
  return found;
}

/** Writes JSON when it differs from what the file holds. Answers whether it wrote. */
function writeIfChanged(path: string, content: unknown): boolean {
  const text = `${JSON.stringify(content, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

async function main(): Promise<void> {
  const url = need('SOLANA_RPC_URL');
  const dryRun = flag('--dry-run');
  const chain = rpcChain(url);

  const genesis = await chain.genesisHash();
  const devnet = clusterOf(url, genesis) === 'devnet';
  log(
    `cluster: ${devnet ? 'devnet' : 'a local validator'} (genesis ${genesis}); provenance: sandbox`,
  );

  const out = value('--out') ?? (devnet ? 'deployments/solana-devnet.json' : undefined);
  const guardFile =
    value('--guard-file') ?? (devnet ? 'packages/sdk/deployments/testnet.json' : undefined);
  if (!out || !guardFile)
    throw new Error('on a local validator, say where to write: --out <file> --guard-file <file>');
  const outPath = fromRoot(out);
  const guardPath = fromRoot(guardFile);

  const plan = loadPlan(fromRoot(value('--config') ?? 'scripts/testnet/solana/devnet.config.json'));
  const admin = await createKeyPairSignerFromBytes(
    new Uint8Array(JSON.parse(readFileSync(need('SOLANA_KEYPAIR'), 'utf8'))),
  );
  log(`admin: ${admin.address}${dryRun ? '; dry run: nothing is sent' : ''}`);
  const before = (await chain.account(admin.address))?.lamports ?? 0n;

  const earlier: Deployment | null = existsSync(outPath)
    ? JSON.parse(readFileSync(outPath, 'utf8'))
    : null;
  const known: Address | null =
    earlier && earlier.genesisHash === genesis ? earlier.accounts.lookupTable : null;
  const { transactions, deployment } = await setUp(chain, admin, plan, {
    dryRun,
    log,
    lookupTable: known,
    withLookupTable: !flag('--no-lookup-table'),
    omitExtensions: values('--omit-extension'),
  });
  deployment.genesisHash = genesis;

  const after = (await chain.account(admin.address))?.lamports ?? 0n;
  const sol = (lamports: bigint) => `${(Number(lamports) / 1e9).toFixed(6)} SOL`;
  log(`the admin holds ${sol(after)}; this run cost ${sol(before - after)}`);
  if (dryRun) {
    log(`dry run: ${transactions} transactions printed, no file written`);
    return;
  }

  log(
    writeIfChanged(outPath, deployment)
      ? `wrote the record of the deployment: ${out}`
      : `the record of the deployment is unchanged: ${out}`,
  );
  // The guard's file is one per network and holds an entry per chain: this writes Solana's and
  // leaves any other chain's as it is.
  const network = devnet ? 'testnet' : 'local';
  const held = existsSync(guardPath) ? JSON.parse(readFileSync(guardPath, 'utf8')) : null;
  if (held && (held.format !== 'guard-deployment/1' || held.network !== network))
    throw new Error(
      `${guardFile} is not the guard's file for the ${network} network: left as it is`,
    );
  const guard = {
    format: 'guard-deployment/1',
    network,
    chains: { ...(held?.chains ?? {}), solana: guardSolanaEntry(deployment) },
  };
  log(
    writeIfChanged(guardPath, guard)
      ? `wrote the guard's deployment file: ${guardFile}`
      : `the guard's deployment file is unchanged: ${guardFile}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
