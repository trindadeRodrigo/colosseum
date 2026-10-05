// Copies real prices from Robinhood Chain mainnet, read only, onto the Robinhood Chain test network's
// price contracts and moves its pools back to them (TNET-2). One round is one run of
// contracts/script/testnet/CopyPrices.s.sol, which holds the rules; this file runs it once, or once
// every --every seconds until stopped, and keeps the key out of the command line.
//
//   pnpm exec tsx scripts/testnet/robinhood/prices.ts --dry-run          prints what a round would write
//   PRICE_WRITER_KEY_FILE=<path> pnpm exec tsx scripts/testnet/robinhood/prices.ts --once
//   PRICE_WRITER_KEY_FILE=<path> pnpm exec tsx scripts/testnet/robinhood/prices.ts --loop [--every 60]
//
// RH_TESTNET_RPC_URL replaces the test network's public RPC and SOURCE_RPC_URL mainnet's; FACTORY names
// the vault's factory so that its ranges are held to; TESTNET_RECORD the kit's record. The key file holds
// the price writer's key as hex; it is read, never printed. The runbook is contracts/README.md, "The
// Robinhood Chain test network".
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CONTRACTS = join(ROOT, 'contracts');
// Absolute, so that forge, run from contracts/, finds the same file.
const RECORD = resolve(
  process.env.TESTNET_RECORD ??
    join(ROOT, 'contracts', 'script', 'testnet', 'deployed', '46630.json'),
);
const TESTNET_RPC = process.env.RH_TESTNET_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';

type Mode = { dryRun: boolean; loop: boolean; everySeconds: number };

export function parseArgs(argv: string[]): Mode {
  const dryRun = argv.includes('--dry-run');
  const loop = argv.includes('--loop');
  const once = argv.includes('--once');
  if ([dryRun, loop, once].filter(Boolean).length !== 1)
    throw new Error('say one of --dry-run, --once or --loop');
  const at = argv.indexOf('--every');
  const everySeconds = at === -1 ? 60 : Number(argv[at + 1]);
  if (!Number.isInteger(everySeconds) || everySeconds < 15)
    throw new Error('--every takes whole seconds, 15 or more');
  return { dryRun, loop, everySeconds };
}

/** The price writer's key from its file: 32 bytes of hex, with or without 0x. Never echoed. */
export function readKey(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error(`the key file ${path} cannot be read`);
  }
  const hex = text.startsWith('0x') ? text.slice(2) : text;
  if (!/^[0-9a-fA-F]{64}$/.test(hex))
    throw new Error(`the key file ${path} does not hold one 32-byte hex key`);
  return `0x${hex}`;
}

/** The forge command of one round: a dry run sends as the record's price writer without a key. */
export function forgeArgs(dryRun: boolean, priceWriter: string): string[] {
  const args = ['script', 'script/testnet/CopyPrices.s.sol', '--rpc-url', TESTNET_RPC];
  return dryRun ? [...args, '--sender', priceWriter] : [...args, '--broadcast', '--slow'];
}

/** The lines of forge's output a person reads: the source block, each token, the round's totals. */
export function roundLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.replace(/^ {2}/, ''))
    .filter((line) => /^(source:|round:| {2}t[A-Za-z]+:)/.test(line))
    .map((line) => line.trimEnd());
}

function round(mode: Mode, priceWriter: string, key: string | null): Promise<boolean> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TESTNET_RECORD: RECORD,
      FOUNDRY_DISABLE_NIGHTLY_WARNING: '1',
    };
    if (key) env.PRICE_WRITER_KEY = key;
    const child = spawn('forge', forgeArgs(mode.dryRun, priceWriter), { cwd: CONTRACTS, env });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', (status) => {
      const stamp = new Date().toISOString();
      const lines = roundLines(out);
      if (status === 0) {
        // A dry run's script cannot tell it is one: the lines say what a round would do.
        for (const line of lines) console.log(`${stamp} ${mode.dryRun ? 'would: ' : ''}${line}`);
      } else {
        // forge's own error, without the environment it was given.
        console.error(`${stamp} round failed (forge exit ${status}):`);
        console.error(out.split('\n').slice(-25).join('\n'));
      }
      resolve(status === 0);
    });
  });
}

async function main() {
  const mode = parseArgs(process.argv.slice(2));
  const record = JSON.parse(readFileSync(RECORD, 'utf8')) as {
    priceWriter: string;
    chainId: number;
  };
  if (record.chainId !== 46630)
    throw new Error(`the record is for chain ${record.chainId}, not 46630`);
  let key: string | null = null;
  if (!mode.dryRun) {
    const path = process.env.PRICE_WRITER_KEY_FILE;
    if (!path) throw new Error('PRICE_WRITER_KEY_FILE names the price writer key file');
    key = readKey(path);
  }
  if (!mode.loop) {
    process.exitCode = (await round(mode, record.priceWriter, key)) ? 0 : 1;
    return;
  }
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      stopping = true;
    });
  while (!stopping) {
    await round(mode, record.priceWriter, key);
    for (let waited = 0; waited < mode.everySeconds && !stopping; waited++)
      await new Promise((r) => setTimeout(r, 1000));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
