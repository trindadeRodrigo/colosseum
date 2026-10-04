import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  type Address,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  getAddressEncoder,
  type KeyPairSigner,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { BASKET_PROGRAM, MOCK_ROUTER_PROGRAM, programDataAddress, REPO_ROOT } from './src/env';
import { rpcChain } from './src/testnet/chain';
import { insideRepo } from './src/testnet/folder';
import { lifecycle } from './src/testnet/lifecycle';
import type { Deployment } from './src/testnet/setup';
import { waitUntilUp } from './src/validator';

// The rehearsal for a test-network deploy, on a local validator and nowhere else:
//
//   pnpm exec tsx scripts/testnet/solana/rehearse.ts <dir> <rpc port> [--preload]   (from the repo root)
//
// It starts `solana-test-validator`, gives a fresh deploy key 10 SOL, deploys the two built programs
// with the commands of the runbook (programs/README.md), runs the set-up three times (a dry run, the
// real run, and a second run that must send nothing), and then carries one vault through its life:
// create, deposit, a swap, a keeper leg, an accept. It prints what each step cost in SOL.
//
// Every key is made here and holds nothing outside this validator. The deploy key is written to
// <dir>, because the Solana CLI and the set-up read a keypair from a file; keep <dir> out of the repo.
// The programs are deployed at their declared ids with the keypairs in keys/, used as files. Where
// those are missing, or with --preload, the validator loads the programs at start and the deploy
// is not rehearsed.

const [dirArg, portArg, ...rest] = process.argv.slice(2);
if (!dirArg || !portArg) throw new Error('usage: rehearse.ts <dir> <rpc port> [--preload]');
/** Load the programs when the validator starts and skip the deploy: for a quick run of the rest. */
const preload = rest.includes('--preload');
if (insideRepo(dirArg)) throw new Error('keep the rehearsal folder outside the repository');
const dir = resolvePath(dirArg);
const port = Number(portArg);
const url = `http://127.0.0.1:${port}`;
const rpc = createSolanaRpc(url);
const SOL = 1_000_000_000n;
const sol = (lamports: bigint) => `${(Number(lamports) / 1e9).toFixed(6)} SOL`;
const say = (line: string) => console.log(line);

/** A new key, and its file in the Solana CLI's form: the 32 secret bytes, then the 32 public ones. */
async function newKey(file?: string): Promise<KeyPairSigner> {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(secret);
  if (file)
    writeFileSync(
      file,
      JSON.stringify([...secret, ...getAddressEncoder().encode(signer.address)]),
      { mode: 0o600 },
    );
  return signer;
}

const balance = async (who: Address) =>
  (await rpc.getBalance(who, { commitment: 'confirmed' }).send()).value;

/** Runs a command, and answers its output and the least `watch` held while it ran. */
async function command(
  program: string,
  args: string[],
  options: { env?: Record<string, string>; watch?: Address } = {},
): Promise<{ output: string; least: bigint | null }> {
  let least: bigint | null = null;
  const poll = options.watch
    ? setInterval(async () => {
        try {
          const { value } = await rpc
            .getBalance(options.watch as Address, { commitment: 'processed' })
            .send();
          if (least === null || value < least) least = value;
        } catch {
          // The next poll will do.
        }
      }, 100)
    : null;
  const child = spawn(program, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  if (poll) clearInterval(poll);
  if (code !== 0) throw new Error(`${program} ${args.slice(0, 3).join(' ')} failed:\n${output}`);
  return { output, least };
}

async function main(): Promise<void> {
  for (const binary of ['basket.so', 'mock_router.so'])
    if (!existsSync(join(REPO_ROOT, 'target', 'deploy', binary)))
      throw new Error(`target/deploy/${binary} is not built: see programs/README.md`);
  mkdirSync(dir, { recursive: true });
  const built = (name: string) => join(REPO_ROOT, 'target', 'deploy', name);
  const programKey = (name: string) => join(REPO_ROOT, 'keys', `${name}-keypair.json`);
  const withKeys =
    !preload && existsSync(programKey('basket')) && existsSync(programKey('mock_router'));

  const faucet = await newKey();
  const deployKeyFile = join(dir, 'deploy-key.json');
  const deployKey = await newKey(deployKeyFile);
  const [guardian, keeper, writer, owner, creator] = await Promise.all(
    Array.from({ length: 5 }, () => newKey()),
  );
  if (!guardian || !keeper || !writer || !owner || !creator) throw new Error('no keys');

  // A local validator turns on every feature it knows; devnet has not turned on all of them, and one
  // it lacks (account data mapped in place) refuses Token-2022's metadata on a new mint. The validator
  // runs with devnet's set, as scripts/testnet/solana/devnet-features.json recorded it.
  const devnetFeatures: { fetchedAt: string; inactive: { id: string }[] } = JSON.parse(
    readFileSync(join(REPO_ROOT, 'scripts', 'testnet', 'solana', 'devnet-features.json'), 'utf8'),
  );
  const validator = spawn(
    'solana-test-validator',
    [
      ...['--ledger', join(dir, 'ledger'), '--reset', '--quiet'],
      ...devnetFeatures.inactive.flatMap((feature) => ['--deactivate-feature', feature.id]),
      ...['--bind-address', '127.0.0.1', '--rpc-port', String(port)],
      ...['--faucet-port', String(port + 2), '--gossip-port', String(port + 3)],
      ...['--dynamic-port-range', `${port + 10}-${port + 40}`],
      ...['--mint', faucet.address],
      ...(withKeys
        ? []
        : [
            ...['--upgradeable-program', BASKET_PROGRAM, built('basket.so'), deployKey.address],
            ...[
              '--upgradeable-program',
              MOCK_ROUTER_PROGRAM,
              built('mock_router.so'),
              deployKey.address,
            ],
          ]),
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const stop = () => validator.kill('SIGTERM');
  process.on('SIGTERM', () => {
    stop();
    process.exit(1);
  });
  process.on('SIGINT', () => {
    stop();
    process.exit(1);
  });

  try {
    await waitUntilUp(rpc, validator);
    const chain = rpcChain(url);
    const rentPerByte = (await rpc.getMinimumBalanceForRentExemption(0n).send()) / 128n;
    say(
      `a local validator is up at ${url}, with the ${devnetFeatures.inactive.length} features devnet lacked on ${devnetFeatures.fetchedAt} switched off; rent is ${rentPerByte} lamports a byte here`,
    );

    // The deploy key starts with what the real one holds: 10 SOL.
    await chain.send(faucet, [
      getTransferSolInstruction({
        source: faucet,
        destination: deployKey.address,
        amount: 10n * SOL,
      }),
      ...[owner, keeper, creator].map((who) =>
        getTransferSolInstruction({ source: faucet, destination: who.address, amount: SOL }),
      ),
    ]);
    const start = await balance(deployKey.address);
    say(`the deploy key ${deployKey.address} holds ${sol(start)}`);
    let least: bigint = start;

    if (withKeys) {
      for (const [name, file, id] of [
        ['basket', 'basket.so', BASKET_PROGRAM],
        ['mock_router', 'mock_router.so', MOCK_ROUTER_PROGRAM],
      ] as const) {
        const before = await balance(deployKey.address);
        const deployed = await command(
          'solana',
          [
            ...['program', 'deploy', '--url', url, '--keypair', deployKeyFile],
            ...['--program-id', programKey(name), built(file)],
          ],
          { watch: deployKey.address },
        );
        const after = await balance(deployKey.address);
        if (deployed.least !== null && deployed.least < least) least = deployed.least;
        if (!deployed.output.includes(id)) throw new Error(`${name} did not land at ${id}`);
        const data = await rpc
          .getAccountInfo(await programDataAddress(id), {
            encoding: 'base64',
            dataSlice: { offset: 0, length: 0 },
          })
          .send();
        say(
          `deployed ${name} at ${id}: ${readFileSync(built(file)).length} bytes; its data account holds ${sol(data.value?.lamports ?? 0n)}; the deploy cost ${sol(before - after)}, and the key held ${sol(deployed.least ?? after)} at its lowest`,
        );
      }
    } else {
      say('the validator loaded both programs at start: no deploy was rehearsed');
    }
    const afterDeploy = await balance(deployKey.address);

    // The config file that is committed for devnet, with the roles this rehearsal's keys hold.
    const config = JSON.parse(
      readFileSync(join(REPO_ROOT, 'scripts', 'testnet', 'solana', 'devnet.config.json'), 'utf8'),
    );
    config.network = 'solana-local';
    config.roles = {
      guardian: guardian.address,
      defaultKeeper: keeper.address,
      priceWriter: writer.address,
    };
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    const setup = async (name: string, ...extra: string[]) => {
      const { output, least: low } = await command(
        'pnpm',
        [
          ...['exec', 'tsx', 'scripts/testnet/solana/setup.ts'],
          ...['--config', join(dir, 'config.json'), '--out', join(dir, 'deployment.json')],
          ...['--guard-file', join(dir, 'guard-local.json'), ...extra],
        ],
        { env: { SOLANA_RPC_URL: url, SOLANA_KEYPAIR: deployKeyFile }, watch: deployKey.address },
      );
      writeFileSync(join(dir, `${name}.log`), output);
      if (low !== null && low < least) least = low;
      const lines = output.trim().split('\n');
      const planned = lines.filter((line) => /^#\d+ /.test(line)).length;
      const sent = lines.filter((line) => line.startsWith('    sent: ')).length;
      say(`set-up, ${name}: ${planned} transactions printed, ${sent} sent`);
      for (const line of lines.slice(-4)) say(`    ${line}`);
      return { planned, sent };
    };
    const dry = await setup('dry run', '--dry-run');
    if (dry.sent !== 0) throw new Error('the dry run sent something');
    const real = await setup('first run');
    if (real.sent !== dry.planned)
      throw new Error('the first run did not send what the dry run printed');
    const again = await setup('second run');
    if (again.planned !== 0) throw new Error('the second run found something to send');
    const afterSetup = await balance(deployKey.address);

    const deployment: Deployment = JSON.parse(readFileSync(join(dir, 'deployment.json'), 'utf8'));
    say(
      `the vault's life, on what the set-up made (lookup table ${deployment.accounts.lookupTable}):`,
    );
    await lifecycle(chain, deployment, { admin: deployKey, owner, keeper, creator }, (line) =>
      say(`    ${line}`),
    );
    const end = await balance(deployKey.address);

    say('what it cost the deploy key:');
    say(`    start                      ${sol(start)}`);
    say(`    after the two deploys      ${sol(afterDeploy)}   (${sol(start - afterDeploy)} spent)`);
    say(
      `    after the set-up           ${sol(afterSetup)}   (${sol(afterDeploy - afterSetup)} spent)`,
    );
    say(`    after the vault's life     ${sol(end)}   (${sol(afterSetup - end)} spent)`);
    say(
      `    the least it held          ${sol(least)}   (${sol(start - least)} in use at the peak)`,
    );
    say('REHEARSAL PASSED');
  } finally {
    stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
