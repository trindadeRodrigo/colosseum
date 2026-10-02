import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSolanaVaultReader,
  type SolanaVaultReader,
  TOKEN_ACCOUNT_BYTES_BOUND,
  toBase58,
  VAULT_SIZE,
} from '@colosseum/chain-solana/vault';
import { createSolanaRpc } from '@solana/kit';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { type ReadSetup, readCases } from './reads';
import { assetId, assetsOf, configOf, REPO_ROOT, type World } from './world';

// The reader against a real node: a local validator with the two built programs loaded, and the same
// world of vaults as the fixtures, made by real transactions (programs/tests/local-validator.ts).
// Nothing leaves the machine. It needs the Solana tools and the built programs, so it only runs when
// asked:
//
//   anchor build --no-idl -- --tools-version v1.54
//   pnpm --dir programs/tests install --frozen-lockfile
//   SOLANA_LOCAL_VALIDATOR=1 pnpm exec vitest run tests/solana-vault/local-validator.test.ts
//
// SOLANA_LOCAL_VALIDATOR_PORT moves it off 28899 and the forty ports above it.

const RUN = process.env.SOLANA_LOCAL_VALIDATOR === '1';
const PORT = Number(process.env.SOLANA_LOCAL_VALIDATOR_PORT ?? 28_899);

type Started = World & {
  rpcUrl: string;
  landedTxId: string;
  revertedTx: { txId: string; code: string };
};

describe.skipIf(!RUN)('on a local validator', () => {
  // Starting a validator and sending twenty transactions takes about a minute.
  vi.setConfig({ hookTimeout: 240_000, testTimeout: 60_000 });

  let child: ChildProcess | undefined;
  let dir: string | undefined;
  let started: Promise<ReadSetup> | undefined;
  const notBefore = new Date().toISOString();

  /** Starts the validator once, waits for the world to be built, and hands back a reader on it. */
  const start = (): Promise<ReadSetup> => {
    started ??= new Promise<ReadSetup>((resolve, reject) => {
      const workDir = mkdtempSync(join(tmpdir(), 'solana-vault-'));
      dir = workDir;
      const script = join('programs', 'tests', 'local-validator.ts');
      const spawned = spawn('pnpm', ['exec', 'tsx', script, workDir, String(PORT)], {
        cwd: REPO_ROOT,
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      child = spawned;
      spawned.on('exit', (code) => reject(new Error(`the validator script stopped with ${code}`)));
      spawned.stdout?.on('data', (chunk: Buffer) => {
        if (!chunk.toString().includes('READY')) return;
        const world: Started = JSON.parse(readFileSync(join(workDir, 'world.json'), 'utf8'));
        const reader = createSolanaVaultReader({
          config: configOf(world, 'local'),
          rpc: createSolanaRpc(world.rpcUrl),
          assets: assetsOf(world),
        });
        resolve({
          reader,
          world,
          provenance: 'sandbox',
          notBefore,
          exactAges: false,
          explorer: false,
          unknownTxId: toBase58(new Uint8Array(64).fill(1)),
          landedTxId: world.landedTxId,
          revertedTx: world.revertedTx,
        });
      });
    });
    return started;
  };

  afterAll(() => {
    // Closing its input is what tells the script to stop the validator.
    child?.stdin?.end();
    child?.kill('SIGTERM');
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  readCases('a local validator, real transactions', start);

  describe('what only a real node shows', () => {
    let reader: SolanaVaultReader;
    let world: World;

    it('reads the Config the program wrote', async () => {
      ({ reader, world } = await start());
      expect(await reader.getConfig()).toMatchObject({
        admin: world.names.admin,
        guardian: world.names.guardian,
        defaultKeeper: world.names.keeper,
        routerProgram: world.names.router,
        priceOwner: world.names.priceOwner,
        cashMint: world.names.mints.usdc,
      });
    });

    it('takes the rent figures from the node', async () => {
      const rpc = createSolanaRpc(`http://127.0.0.1:${PORT}`);
      const rent = (bytes: number) => rpc.getMinimumBalanceForRentExemption(BigInt(bytes)).send();
      const need = { cashRaw: '0', legs: 4, newVault: true };
      const funding = await reader.funding(world.names.owner, need);
      expect(BigInt(funding.gasNeedRaw)).toBe(
        (await rent(0)) +
          4n * 5_000n +
          (await rent(VAULT_SIZE)) +
          4n * (await rent(TOKEN_ACCOUNT_BYTES_BOUND)),
      );
      expect(funding.gasHaveRaw).toBe(
        (await rpc.getBalance(world.names.owner as never).send()).value.toString(),
      );
    });

    it("says whether the market is open by the validator's own clock", async () => {
      const [stock, gold] = await reader.getPrices([assetId('spyx'), assetId('gold')]);
      expect(['open', 'closed']).toContain(stock?.market);
      expect(gold?.market).toBe('open');
    });
  });
});
