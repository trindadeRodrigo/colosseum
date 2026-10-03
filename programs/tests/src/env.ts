import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AccountMeta,
  AccountRole,
  type AccountSignerMeta,
  type Address,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
  isWritableRole,
  type KeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from '@solana/kit';
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from 'litesvm';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
export const SYSVAR_RENT = address('SysvarRent111111111111111111111111111111111');
export const UPGRADEABLE_LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');

const addressEncoder = getAddressEncoder();
const anchorToml = readFileSync(join(REPO_ROOT, 'Anchor.toml'), 'utf8');

/** The program ids have one home, Anchor.toml (and `declare_id!`, which must agree). */
function programId(name: string): Address {
  const match = anchorToml.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm'));
  if (!match?.[1]) throw new Error(`Anchor.toml has no program id for ${name}`);
  return address(match[1]);
}

export const BASKET_PROGRAM = programId('basket');
export const MOCK_ROUTER_PROGRAM = programId('mock_router');

export async function programDataAddress(program: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: UPGRADEABLE_LOADER,
    seeds: [addressEncoder.encode(program)],
  });
  return pda;
}

/** Loads a built program the way a real deploy does: under the upgradeable loader, with a
 * program data account that names the upgrade authority. */
export async function loadProgram(
  svm: LiteSVM,
  program: Address,
  file: string,
  upgradeAuthority: Address | null,
): Promise<void> {
  const bytes = readFileSync(join(REPO_ROOT, 'target', 'deploy', file));
  svm.addProgramWithLoader(program, bytes, UPGRADEABLE_LOADER);
  // litesvm writes the program data account with no upgrade authority. Its header is
  // variant (u32) + slot (u64) + Option<Pubkey>; the option starts at byte 12.
  const programData = svm.getAccount(await programDataAddress(program));
  if (!programData.exists) throw new Error(`no program data account for ${program}`);
  const data = new Uint8Array(programData.data);
  data[12] = upgradeAuthority ? 1 : 0;
  data.set(upgradeAuthority ? addressEncoder.encode(upgradeAuthority) : new Uint8Array(32), 13);
  svm.setAccount({ ...programData, data });
}

export type World = {
  svm: LiteSVM;
  /** Upgrade authority of the vault program: the only key that may initialise its config. */
  deployer: KeyPairSigner;
};

/** A fresh chain with both programs loaded. Token, Token-2022 and the associated token
 * program come with litesvm. */
export async function createWorld(): Promise<World> {
  const svm = new LiteSVM();
  const deployer = await fundedSigner(svm);
  await loadProgram(svm, BASKET_PROGRAM, 'basket.so', deployer.address);
  await loadProgram(svm, MOCK_ROUTER_PROGRAM, 'mock_router.so', deployer.address);
  return { svm, deployer };
}

/** Loads the hostile transfer-hook program (programs/test-hook) at a fresh address. */
export async function loadHook(svm: LiteSVM): Promise<Address> {
  const hook = (await generateKeyPairSigner()).address;
  svm.addProgram(hook, readFileSync(join(REPO_ROOT, 'target', 'deploy', 'test_hook.so')));
  return hook;
}

export async function fundedSigner(svm: LiteSVM, sol = 10n): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  svm.airdrop(signer.address, lamports(sol * 1_000_000_000n));
  return signer;
}

/** Sets the chain's clock, in unix seconds. Only a test can; it may also go back. */
export function setClock(svm: LiteSVM, unixSeconds: bigint | number): void {
  const clock = svm.getClock();
  clock.unixTimestamp = BigInt(unixSeconds);
  svm.setClock(clock);
}

export function now(svm: LiteSVM): bigint {
  return svm.getClock().unixTimestamp;
}

export type SendResult = TransactionMetadata | FailedTransactionMetadata;

/** Signs with the fee payer and every signer named in the instructions, then runs it. */
export async function send(
  svm: LiteSVM,
  payer: TransactionSigner,
  instructions: Instruction[],
): Promise<SendResult> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const result = svm.sendTransaction(transaction);
  // A new blockhash, so a later identical transaction is not refused as a duplicate.
  svm.expireBlockhash();
  return result;
}

export function failed(result: SendResult): result is FailedTransactionMetadata {
  return result instanceof FailedTransactionMetadata;
}

export function expectOk(result: SendResult): TransactionMetadata {
  if (failed(result)) {
    throw new Error(`transaction failed: ${result.toString()}\n${result.meta().prettyLogs()}`);
  }
  return result;
}

/** The custom error code a failed transaction ended with, or null if it failed another way. */
export function customErrorCode(result: SendResult): number | null {
  if (!failed(result)) return null;
  const error = result.err();
  if (typeof error !== 'object' || !('err' in error)) return null;
  const inner = error.err();
  return typeof inner === 'object' && 'code' in inner ? inner.code : null;
}

/** Fails unless the transaction failed with exactly this custom error code. */
export function expectError(result: SendResult, code: number): void {
  if (!failed(result)) throw new Error(`expected error ${code}, but the transaction succeeded`);
  const actual = customErrorCode(result);
  if (actual !== code) {
    throw new Error(
      `expected error ${code}, got ${actual ?? result.toString()}\n${result.meta().prettyLogs()}`,
    );
  }
}

/** Fails unless the transaction failed with this runtime error, one that carries no code
 * of its own (for example `MissingAccount` or `InvalidAccountData`). */
export function expectFailure(result: SendResult, name: string): void {
  if (!failed(result)) throw new Error(`expected ${name}, but the transaction succeeded`);
  const error = result.err().toString();
  if (!new RegExp(`\\b${name}\\b`).test(error)) {
    throw new Error(`expected ${name}, got ${error}\n${result.meta().prettyLogs()}`);
  }
}

/** Anchor's instruction selector: the first eight bytes of sha256("global:<name>"). */
export function discriminator(name: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`global:${name}`).digest().subarray(0, 8));
}

export function concat(...parts: ArrayLike<number>[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export const readonly = (addr: Address): AccountMeta => ({
  address: addr,
  role: AccountRole.READONLY,
});
export const writable = (addr: Address): AccountMeta => ({
  address: addr,
  role: AccountRole.WRITABLE,
});
export const signer = (s: TransactionSigner): AccountSignerMeta => ({
  address: s.address,
  role: AccountRole.READONLY_SIGNER,
  signer: s,
});
export const writableSigner = (s: TransactionSigner): AccountSignerMeta => ({
  address: s.address,
  role: AccountRole.WRITABLE_SIGNER,
  signer: s,
});

/** An address in a signer's place when an instruction is built for a program to sign by
 * itself (a vault, the puppet's own address). It never signs a transaction. */
export function programSigner(addr: Address): TransactionSigner {
  return {
    address: addr,
    signTransactions: async () => {
      throw new Error(`${addr} is signed for by a program, never by a key`);
    },
  };
}

/** The instruction with its first account, the one that should sign, named but not signing. */
export function unsigned(instruction: Instruction): Instruction {
  const [first, ...rest] = instruction.accounts ?? [];
  if (!first) throw new Error('the instruction has no accounts');
  return {
    ...instruction,
    accounts: [
      {
        address: first.address,
        role: isWritableRole(first.role) ? AccountRole.WRITABLE : AccountRole.READONLY,
      },
      ...rest,
    ],
  };
}

/** Anchor's own error codes that the tests name. */
export const ANCHOR = {
  IdlInstructionStub: 1000,
  ConstraintHasOne: 2001,
  ConstraintSeeds: 2006,
  ConstraintAssociated: 2009,
  ConstraintTokenOwner: 2015,
  ConstraintMintTokenProgram: 2022,
  AccountDiscriminatorMismatch: 3002,
  AccountDidNotDeserialize: 3003,
  AccountOwnedByWrongProgram: 3007,
  InvalidProgramId: 3008,
  AccountNotSigner: 3010,
  AccountNotInitialized: 3012,
} as const;

/** The system program's "already in use": what creating an account twice ends with. */
export const SYSTEM_ACCOUNT_ALREADY_IN_USE = 0;

/** The payloads of the Anchor events with this name that a transaction logged. */
export function events(meta: TransactionMetadata, name: string): Uint8Array[] {
  const tag = createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
  return meta
    .logs()
    .filter((line) => line.startsWith('Program data: '))
    .map((line) => Buffer.from(line.slice('Program data: '.length), 'base64'))
    .filter((data) => data.subarray(0, 8).equals(tag))
    .map((data) => new Uint8Array(data.subarray(8)));
}

/** Anchor's built-in instruction that creates a program's on-chain IDL account. A program
 * built with `no-idl` must refuse it: whoever creates that account becomes its authority. */
export async function idlCreateInstruction(
  program: Address,
  payer: TransactionSigner,
): Promise<{ instruction: Instruction; idlAccount: Address }> {
  const [base] = await getProgramDerivedAddress({ programAddress: program, seeds: [] });
  // createWithSeed(base, "anchor:idl", program)
  const idlAccount = getAddressDecoder().decode(
    createHash('sha256')
      .update(addressEncoder.encode(base) as Uint8Array)
      .update('anchor:idl')
      .update(addressEncoder.encode(program) as Uint8Array)
      .digest(),
  );
  const tag = new Uint8Array([0x40, 0xf4, 0xbc, 0x78, 0xa7, 0xe9, 0x69, 0x0a]);
  const dataLength = new Uint8Array(8);
  new DataView(dataLength.buffer).setBigUint64(0, 1000n, true);
  return {
    idlAccount,
    instruction: {
      programAddress: program,
      accounts: [
        writableSigner(payer),
        writable(idlAccount),
        readonly(base),
        readonly(SYSTEM_PROGRAM),
        readonly(program),
      ],
      data: concat(tag, [0], dataLength),
    },
  };
}
