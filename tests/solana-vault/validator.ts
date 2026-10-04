import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeClock, SYSVAR_CLOCK } from '@colosseum/chain-solana/vault';
import {
  type Address,
  createSolanaRpc,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  type Signature,
  type Transaction,
} from '@solana/kit';
import { priceAccountBytes } from './admin';
import {
  buildContractWorld,
  type ContractWorld,
  type Ledger,
  newKey,
  PARAMS,
  PRICE_ENTRIES,
} from './contract-world';
import { BASKET_PROGRAM, binary, MOCK_ROUTER_PROGRAM } from './svm-node';

// A local validator with the vault program and the test exchange loaded under the upgradeable loader,
// the deployer their upgrade authority, and a price account in Scope's layout loaded at start. Nothing
// leaves the machine. Its clock is the wall clock, so the price entries are stamped ahead of the start
// by less than the program's allowance (`max_price_age_s`): they read as fresh from the start for
// about twice that long, which is longer than a run.

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const base58 = getBase58Decoder();

export type Started = {
  world: ContractWorld;
  rpc: ReturnType<typeof createSolanaRpc>;
  rpcUrl: string;
  ledger: Ledger;
  stop(): void;
};

export async function startValidator(port: number, notBefore: string): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'solana-adapter-'));
  const deployer = await newKey();
  const priceAccount = (await newKey()).address;
  const startAt = BigInt(Math.floor(Date.now() / 1000));
  const data = priceAccountBytes(PRICE_ENTRIES, startAt + BigInt(PARAMS.maxPriceAgeS) - 100n, 0n);
  const priceFile = join(dir, 'prices.json');
  writeFileSync(
    priceFile,
    JSON.stringify({
      pubkey: priceAccount,
      account: {
        lamports: 1_000_000_000,
        data: [Buffer.from(data).toString('base64'), 'base64'],
        owner: MOCK_ROUTER_PROGRAM,
        executable: false,
        rentEpoch: 0,
        space: data.length,
      },
    }),
  );
  const validator: ChildProcess = spawn(
    'solana-test-validator',
    [
      ...['--ledger', join(dir, 'ledger'), '--reset', '--quiet'],
      ...['--bind-address', '127.0.0.1', '--rpc-port', String(port)],
      ...['--faucet-port', String(port + 2), '--gossip-port', String(port + 3)],
      ...['--dynamic-port-range', `${port + 10}-${port + 40}`],
      ...['--mint', deployer.address],
      ...['--upgradeable-program', BASKET_PROGRAM, binary('basket.so'), deployer.address],
      ...['--upgradeable-program', MOCK_ROUTER_PROGRAM, binary('mock_router.so'), deployer.address],
      ...['--account', priceAccount, priceFile],
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const stop = () => {
    validator.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const rpcUrl = `http://127.0.0.1:${port}`;
    const rpc = createSolanaRpc(rpcUrl);
    for (let i = 0; ; i++) {
      if (validator.exitCode !== null) throw new Error('the validator stopped while starting');
      if (i > 480) throw new Error('the validator did not come up in four minutes');
      try {
        if (
          (await rpc.getHealth().send()) === 'ok' &&
          (await rpc.getSlot({ commitment: 'confirmed' }).send()) > 3n
        )
          break;
      } catch {
        // Not listening yet.
      }
      await sleep(500);
    }
    const clock = async () => {
      const { value } = await rpc
        .getAccountInfo(SYSVAR_CLOCK, { encoding: 'base64', commitment: 'confirmed' })
        .send();
      return decodeClock(
        value
          ? {
              address: SYSVAR_CLOCK,
              owner: value.owner,
              lamports: BigInt(value.lamports),
              data: new Uint8Array(Buffer.from(value.data[0], 'base64')),
            }
          : null,
      ).unixTimestamp;
    };
    const ledger: Ledger = {
      rpc,
      async land(tx: Transaction) {
        const first = Object.values(tx.signatures)[0];
        if (!first) throw new Error('an unsigned transaction');
        const signature = base58.decode(first) as Signature;
        await rpc
          .sendTransaction(getBase64EncodedWireTransaction(tx), {
            encoding: 'base64',
            skipPreflight: true,
          })
          .send();
        for (let i = 0; i < 240; i++) {
          const { value } = await rpc.getSignatureStatuses([signature]).send();
          const status = value[0];
          if (
            status?.confirmationStatus === 'confirmed' ||
            status?.confirmationStatus === 'finalized'
          ) {
            const found = await rpc
              .getTransaction(signature, {
                commitment: 'confirmed',
                encoding: 'json',
                maxSupportedTransactionVersion: 0,
              })
              .send();
            return {
              signature,
              failed: status.err !== null,
              logs: [...(found?.meta?.logMessages ?? [])],
            };
          }
          await sleep(250);
        }
        throw new Error(`transaction ${signature} did not confirm`);
      },
      async advance(seconds) {
        const until = (await clock()) + BigInt(seconds);
        while ((await clock()) < until) await sleep(1_000);
      },
      now: clock,
    };
    const world = await buildContractWorld(ledger, {
      deployer,
      priceAccount: priceAccount as Address,
      // A third version would wait one publish delay, a minute: too short to hold through a run.
      pendingVersion: false,
      network: 'local',
      notBefore,
    });
    return { world, rpc, rpcUrl, ledger, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
