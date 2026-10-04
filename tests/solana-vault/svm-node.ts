import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VaultWriteRpc } from '@colosseum/chain-solana/vault';
import {
  type Address,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  type Transaction,
} from '@solana/kit';
import { Clock, FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from 'litesvm';
import { REPO_ROOT } from './world';

// A Solana node in memory for the adapter: LiteSVM, with the two built programs loaded the way a deploy
// loads them, answering the RPC calls the adapter makes in the shape a node answers them. What the
// adapter asks is what it would ask a validator; what is not a node's (the clock that moves at will,
// the accounts a test writes) stays on `node.svm`. Signatures are not checked here, so a simulation
// can run on an unsigned transaction as a node's does with `sigVerify: false`: the cases that hold
// signed bytes to their signatures run on a local validator.

export const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111' as Address;

const anchorToml = readFileSync(join(REPO_ROOT, 'Anchor.toml'), 'utf8');
/** The program ids have one home, Anchor.toml. */
export function programId(name: string): Address {
  const match = anchorToml.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm'));
  if (!match?.[1]) throw new Error(`Anchor.toml has no program id for ${name}`);
  return match[1] as Address;
}
export const BASKET_PROGRAM = programId('basket');
export const MOCK_ROUTER_PROGRAM = programId('mock_router');
export const binary = (name: string) => join(REPO_ROOT, 'target', 'deploy', name);
/** True when both programs are built (`anchor build --no-idl -- --tools-version v1.54`). */
export const PROGRAMS_BUILT =
  existsSync(binary('basket.so')) && existsSync(binary('mock_router.so'));

export async function programDataAddress(program: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: UPGRADEABLE_LOADER,
    seeds: [getAddressEncoder().encode(program)],
  });
  return pda;
}

const TX_ERRORS = [
  'AccountInUse',
  'AccountLoadedTwice',
  'AccountNotFound',
  'ProgramAccountNotFound',
  'InsufficientFundsForFee',
  'InvalidAccountForFee',
  'AlreadyProcessed',
  'BlockhashNotFound',
  'CallChainTooDeep',
  'MissingSignatureForFee',
  'InvalidAccountIndex',
  'SignatureFailure',
  'InvalidProgramForExecution',
  'SanitizeFailure',
  'ClusterMaintenance',
  'AccountBorrowOutstanding',
  'WouldExceedMaxBlockCostLimit',
  'UnsupportedVersion',
  'InvalidWritableAccount',
  'WouldExceedMaxAccountCostLimit',
  'WouldExceedAccountDataBlockLimit',
  'TooManyAccountLocks',
  'AddressLookupTableNotFound',
  'InvalidAddressLookupTableOwner',
  'InvalidAddressLookupTableData',
  'InvalidAddressLookupTableIndex',
  'InvalidRentPayingAccount',
];
const IX_ERRORS = [
  'GenericError',
  'InvalidArgument',
  'InvalidInstructionData',
  'InvalidAccountData',
  'AccountDataTooSmall',
  'InsufficientFunds',
  'IncorrectProgramId',
  'MissingRequiredSignature',
  'AccountAlreadyInitialized',
  'UninitializedAccount',
  'UnbalancedInstruction',
  'ModifiedProgramId',
  'ExternalAccountLamportSpend',
  'ExternalAccountDataModified',
  'ReadonlyLamportChange',
  'ReadonlyDataModified',
  'DuplicateAccountIndex',
  'ExecutableModified',
  'RentEpochModified',
  'NotEnoughAccountKeys',
  'AccountDataSizeChanged',
  'AccountNotExecutable',
  'AccountBorrowFailed',
  'AccountBorrowOutstanding',
  'DuplicateAccountOutOfSync',
  'InvalidError',
  'ExecutableDataModified',
  'ExecutableLamportChange',
  'ExecutableAccountNotRentExempt',
  'UnsupportedProgramId',
  'CallDepth',
  'MissingAccount',
  'ReentrancyNotAllowed',
  'MaxSeedLengthExceeded',
  'InvalidSeeds',
  'InvalidRealloc',
  'ComputationalBudgetExceeded',
  'PrivilegeEscalation',
  'ProgramEnvironmentSetupFailure',
  'ProgramFailedToComplete',
  'ProgramFailedToCompile',
  'Immutable',
  'IncorrectAuthority',
  'AccountNotRentExempt',
  'InvalidAccountOwner',
  'ArithmeticOverflow',
];

/** A failed transaction's error in the shape a node's JSON answers with. */
function errorOf(failed: FailedTransactionMetadata): unknown {
  const err = failed.err() as unknown;
  if (typeof err === 'number') return TX_ERRORS[err] ?? `TransactionError${err}`;
  const e = err as { index?: number; err?: () => unknown; accountIndex?: number };
  if (typeof e.err === 'function' && typeof e.index === 'number') {
    const inner = e.err() as unknown;
    if (typeof inner === 'number')
      return { InstructionError: [e.index, IX_ERRORS[inner] ?? 'GenericError'] };
    const custom = inner as { code?: number };
    if (typeof custom.code === 'number')
      return { InstructionError: [e.index, { Custom: custom.code }] };
    return { InstructionError: [e.index, 'BorshIoError'] };
  }
  if (typeof e.accountIndex === 'number')
    return { InsufficientFundsForRent: { account_index: e.accountIndex } };
  return String(err);
}

type Landed = {
  signature: string;
  slot: bigint;
  wire: Uint8Array;
  err: unknown;
  logs: string[];
  keys: Address[];
};

export type SvmNode = {
  svm: LiteSVM;
  rpc: VaultWriteRpc;
  /** Runs a signed transaction as a node with no preflight does: a failure lands too, and is recorded. */
  land(tx: Transaction): Landed;
  /** Moves the cluster's clock forward, and the slot with it; a new blockhash. */
  advance(seconds: number): bigint;
  now(): bigint;
  calls: string[];
};

const base58 = getBase58Decoder();
const base58Bytes = getBase58Encoder();
const decoder = getTransactionDecoder();

/** The account keys a message names in its static list: enough to file a transaction under its signer. */
function staticKeys(messageBytes: Uint8Array): Address[] {
  // version byte (v0: 0x80), three header bytes, then a compact count of 32-byte keys.
  let at = messageBytes[0] !== undefined && messageBytes[0] & 0x80 ? 1 : 0;
  at += 3;
  let count = 0;
  for (let shift = 0; ; shift += 7) {
    const byte = messageBytes[at++] ?? 0;
    count |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
  }
  const keys: Address[] = [];
  for (let i = 0; i < count; i++)
    keys.push(base58.decode(messageBytes.subarray(at + 32 * i, at + 32 * i + 32)) as Address);
  return keys;
}

/** Starts a node with both programs loaded under the upgradeable loader, `authority` their upgrade authority. */
export async function createSvmNode(authority: Address, startAt: bigint): Promise<SvmNode> {
  const svm = new LiteSVM().withSigverify(false).withTransactionHistory(10_000n);
  for (const [program, file] of [
    [BASKET_PROGRAM, 'basket.so'],
    [MOCK_ROUTER_PROGRAM, 'mock_router.so'],
  ] as const) {
    svm.addProgramWithLoader(program, readFileSync(binary(file)), UPGRADEABLE_LOADER);
    // litesvm writes the program data account with no upgrade authority. Its header is variant (u32),
    // slot (u64), then Option<Pubkey>: the option starts at byte 12.
    const at = await programDataAddress(program);
    const data = svm.getAccount(at);
    if (!data.exists) throw new Error(`no program data account for ${program}`);
    const bytes = new Uint8Array(data.data);
    bytes[12] = 1;
    bytes.set(getAddressEncoder().encode(authority), 13);
    svm.setAccount({ ...data, data: bytes });
  }
  const clock = svm.getClock();
  svm.setClock(
    new Clock(100n, clock.epochStartTimestamp, clock.epoch, clock.leaderScheduleEpoch, startAt),
  );

  const history = new Map<string, Landed>();
  const bySigner = new Map<string, string[]>();
  const calls: string[] = [];
  const height = () => svm.getClock().slot;

  const accountJson = (address: Address, slice?: { offset: number; length: number }) => {
    const a = svm.getAccount(address);
    if (!a.exists) return null;
    const data = new Uint8Array(a.data);
    return {
      data: [
        Buffer.from(
          slice ? data.subarray(slice.offset, slice.offset + slice.length) : data,
        ).toString('base64'),
        'base64',
      ],
      executable: a.executable,
      lamports: a.lamports,
      owner: a.programAddress,
      rentEpoch: 0n,
      space: BigInt(data.length),
    };
  };
  const answer = <T>(method: string, work: () => T) => ({
    send: async () => {
      calls.push(method);
      return work();
    },
  });
  const decode = (base64: string) => decoder.decode(new Uint8Array(Buffer.from(base64, 'base64')));
  const run = (tx: Transaction, record: boolean): Landed => {
    const result = svm.sendTransaction(tx as never) as
      | TransactionMetadata
      | FailedTransactionMetadata;
    const failed = result instanceof FailedTransactionMetadata;
    const meta = failed ? result.meta() : result;
    const first = Object.values(tx.signatures)[0];
    const signature = first ? base58.decode(first) : base58.decode(meta.signature());
    const landed: Landed = {
      signature,
      slot: height(),
      wire: new Uint8Array(
        // The wire bytes, rebuilt from what was handed in: signatures, then the message.
        [
          ...new Uint8Array([Object.keys(tx.signatures).length]),
          ...Object.values(tx.signatures).flatMap((s) => [...(s ?? new Uint8Array(64))]),
          ...tx.messageBytes,
        ],
      ),
      err: failed ? errorOf(result) : null,
      logs: meta.logs(),
      keys: staticKeys(new Uint8Array(tx.messageBytes)),
    };
    if (record) {
      history.set(signature, landed);
      const signer = landed.keys[0];
      if (signer) bySigner.set(signer, [signature, ...(bySigner.get(signer) ?? [])]);
    }
    return landed;
  };

  const rpc = {
    getMultipleAccounts: (
      addresses: Address[],
      config?: { dataSlice?: { offset: number; length: number } },
    ) =>
      answer('getMultipleAccounts', () => ({
        context: { slot: height() },
        value: addresses.map((a) => accountJson(a, config?.dataSlice)),
      })),
    getProgramAccounts: (
      program: Address,
      config: {
        filters?: ({ dataSize: bigint } | { memcmp: { offset: bigint; bytes: string } })[];
        dataSlice?: { offset: number; length: number };
      },
    ) =>
      answer('getProgramAccounts', () =>
        svm
          .getProgramAccounts(program)
          .filter((account) => {
            const data = new Uint8Array(account.data);
            return (config.filters ?? []).every((f) => {
              if ('dataSize' in f) return BigInt(data.length) === f.dataSize;
              const want = base58Bytes.encode(f.memcmp.bytes);
              const at = Number(f.memcmp.offset);
              return want.every((b, i) => data[at + i] === b);
            });
          })
          .map((account) => ({
            pubkey: account.address,
            account: accountJson(account.address, config.dataSlice),
          })),
      ),
    getBalance: (address: Address) =>
      answer('getBalance', () => ({
        context: { slot: height() },
        value: svm.getBalance(address) ?? 0n,
      })),
    getBlockHeight: () => answer('getBlockHeight', () => height()),
    getMinimumBalanceForRentExemption: (size: bigint) =>
      answer('getMinimumBalanceForRentExemption', () => svm.minimumBalanceForRentExemption(size)),
    getLatestBlockhash: () =>
      answer('getLatestBlockhash', () => ({
        context: { slot: height() },
        value: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: height() + 150n },
      })),
    getRecentPrioritizationFees: () => answer('getRecentPrioritizationFees', () => []),
    simulateTransaction: (base64: string, config: { accounts?: { addresses: Address[] } }) =>
      answer('simulateTransaction', () => {
        const tx = decode(base64);
        const result = svm.simulateTransaction(tx as never);
        const failed = result instanceof FailedTransactionMetadata;
        const meta = failed ? result.meta() : result.meta();
        const post = failed ? [] : result.postAccounts();
        const after = new Map(post.map((a) => [a.address as string, a]));
        return {
          context: { slot: height() },
          value: {
            err: failed ? errorOf(result) : null,
            logs: meta.logs(),
            unitsConsumed: meta.computeUnitsConsumed(),
            returnData: null,
            accounts: failed
              ? null
              : (config.accounts?.addresses ?? []).map((address) => {
                  const a = after.get(address);
                  if (!a) return accountJson(address);
                  if (a.lamports === 0n) return null;
                  return {
                    data: [Buffer.from(new Uint8Array(a.data)).toString('base64'), 'base64'],
                    executable: a.executable,
                    lamports: a.lamports,
                    owner: a.programAddress,
                    rentEpoch: 0n,
                    space: BigInt(a.data.length),
                  };
                }),
          },
        };
      }),
    sendTransaction: (base64: string) =>
      answer('sendTransaction', () => {
        const tx = decode(base64);
        // A node runs a preflight first: a transaction that would fail is refused, not landed.
        const tried = svm.simulateTransaction(tx as never);
        if (tried instanceof FailedTransactionMetadata)
          throw new Error(`preflight failed: ${JSON.stringify(errorOf(tried))}`);
        return run(tx, true).signature;
      }),
    getSignatureStatuses: (signatures: string[]) =>
      answer('getSignatureStatuses', () => ({
        context: { slot: height() },
        value: signatures.map((s) => {
          const found = history.get(s);
          return found
            ? {
                slot: found.slot,
                confirmations: null,
                err: found.err,
                confirmationStatus: 'confirmed',
              }
            : null;
        }),
      })),
    getTransaction: (signature: string, config?: { encoding?: string }) =>
      answer('getTransaction', () => {
        const found = history.get(signature);
        if (!found) return null;
        return {
          slot: found.slot,
          blockTime: null,
          meta: { err: found.err, logMessages: found.logs },
          transaction:
            config?.encoding === 'base64'
              ? [Buffer.from(found.wire).toString('base64'), 'base64']
              : { signatures: [found.signature] },
          version: 0,
        };
      }),
    getSignaturesForAddress: (address: Address, config?: { limit?: number }) =>
      answer('getSignaturesForAddress', () =>
        (bySigner.get(address) ?? []).slice(0, config?.limit ?? 1000).map((s) => {
          const found = history.get(s) as Landed;
          return {
            signature: s,
            slot: found.slot,
            err: found.err,
            memo: null,
            blockTime: null,
            confirmationStatus: 'confirmed',
          };
        }),
      ),
  } as unknown as VaultWriteRpc;

  return {
    svm,
    rpc,
    calls,
    land: (tx) => {
      const landed = run(tx, true);
      svm.expireBlockhash();
      return landed;
    },
    advance(seconds) {
      const c = svm.getClock();
      const next = c.unixTimestamp + BigInt(seconds);
      svm.setClock(
        new Clock(
          c.slot + BigInt(Math.max(1, Math.ceil(seconds / 0.4))),
          c.epochStartTimestamp,
          c.epoch,
          c.leaderScheduleEpoch,
          next,
        ),
      );
      svm.expireBlockhash();
      return next;
    },
    now: () => svm.getClock().unixTimestamp,
  };
}
