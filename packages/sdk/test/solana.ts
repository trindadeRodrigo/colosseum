import { createHash } from 'node:crypto';
import type { BasketTx } from '@colosseum/schemas';
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  type IInstruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { base58Encode } from '../src/bytes';
import { tradesOf } from '../src/guard/context';
import { type DeploymentFile, loadDeployments, type SolanaEntry } from '../src/guard/deployment';
import { BASKET_PROGRAM } from '../src/guard/generated/basket-program';
import type { ProgramTable } from '../src/guard/solana/table';
import type { ApprovedStep, Loaded, SolanaDeployment } from '../src/guard/types';

// Solana transactions for the guard's tests, built with @solana/kit: its message compiler and its
// derived addresses, not this package's. So a transaction that passes the guard here was put together
// by other code than the code that reads it.

const sha = (text: string) => createHash('sha256').update(text).digest();
/** An address that belongs to nobody, the same every run. */
export const someone = (label: string) => base58Encode(sha(`sdk test: ${label}`));

export const PROGRAM = BASKET_PROGRAM.address;
export const SYSTEM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export const OWNER = someone('owner');
export const STRANGER = someone('stranger');
export const ROUTER = someone('router');
export const BASKET_ID = '7234567890123456789';

/** A deployment file for a local network, as a deploy would write it, with `change` on top. */
export function solanaDeployment(change: Partial<SolanaEntry> = {}): Loaded<SolanaDeployment> {
  const file: DeploymentFile = {
    format: 'guard-deployment/1',
    network: 'local',
    chains: {
      solana: {
        family: 'solana',
        router: ROUTER,
        cash: 'solana:usdc',
        assets: {
          'solana:usdc': { mint: someone('mint usdc'), tokenProgram: 'token' },
          'solana:spy': { mint: someone('mint spy'), tokenProgram: 'token-2022' },
          'solana:gold': { mint: someone('mint gold'), tokenProgram: 'token' },
        },
        ...change,
      },
    },
  };
  return loadDeployments(file).solana as Loaded<SolanaDeployment>;
}
export const SOLANA = solanaDeployment();
export const mintOf = (asset: string) => SOLANA.assets[asset]?.mint ?? someone(`mint ${asset}`);
const programOf = (asset: string) =>
  SOLANA.assets[asset]?.tokenProgram === 'token-2022' ? TOKEN_2022 : TOKEN;

const encoder = getAddressEncoder();
const raw = (a: string) => new Uint8Array(encoder.encode(address(a)));
const derive = async (seeds: (Uint8Array | string)[], program: string) =>
  (await getProgramDerivedAddress({ programAddress: address(program), seeds }))[0] as string;

export const u64 = (n: bigint | string) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(n));
  return new Uint8Array(out);
};
export const u32 = (n: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(n);
  return new Uint8Array(out);
};
const u16 = (n: number) => {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(n);
  return new Uint8Array(out);
};
const join = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

/** The vault of an owner for a plan, as @solana/kit derives it. */
export const vaultOf = (owner: string, basketId = BASKET_ID, program = PROGRAM) =>
  derive(['vault', raw(owner), u64(basketId)], program);
export const VAULT = await vaultOf(OWNER);
export const CONFIG = await derive(['config'], PROGRAM);
export const ASSETS = await derive(['assets'], PROGRAM);
/** The associated token account of `holder` for an asset of the deployment. */
export const tokenAccountOf = (holder: string, asset: string) =>
  derive([raw(holder), raw(programOf(asset)), raw(mintOf(asset))], ASSOCIATED);

export type Ix = IInstruction;
type Extra = { address: string; signer?: boolean; writable?: boolean };

/** One instruction of the vault program: the accounts in the interface's order, then any extra ones. */
export function vaultIx(
  table: ProgramTable,
  name: string,
  accounts: Record<string, string>,
  args: Uint8Array,
  extra: Extra[] = [],
  /** An account listed with other flags than the interface gives it. */
  flags: Record<string, { signer: boolean; writable: boolean }> = {},
): Ix {
  const spec = table.instructions[name];
  if (!spec) throw new Error(`the table has no ${name}`);
  const role = (signer?: boolean, writable?: boolean) =>
    signer
      ? writable
        ? AccountRole.WRITABLE_SIGNER
        : AccountRole.READONLY_SIGNER
      : writable
        ? AccountRole.WRITABLE
        : AccountRole.READONLY;
  return {
    programAddress: address(table.address),
    accounts: [
      ...spec.accounts.map((a) => {
        const at = accounts[a.name];
        if (!at) throw new Error(`${name} needs the account ${a.name}`);
        const as = flags[a.name] ?? a;
        return { address: address(at), role: role(as.signer, as.writable) };
      }),
      ...extra.map((e) => ({ address: address(e.address), role: role(e.signer, e.writable) })),
    ],
    data: join(Uint8Array.from(spec.discriminator), args),
  };
}

export const targetsArg = (targets: { asset: string; weightBps: number }[]) =>
  join(u32(targets.length), ...targets.flatMap((t) => [raw(mintOf(t.asset)), u16(t.weightBps)]));
export const bytesArg = (bytes: Uint8Array) => join(u32(bytes.length), bytes);
export const flag = (on: boolean) => Uint8Array.of(on ? 1 : 0);
export { join, raw };

/** "Create this token account if it is missing." `data` is the instruction's one byte: 1. */
export const openAccountIx = async (
  holder: string,
  asset: string,
  o: { payer?: string; account?: string; data?: number[]; system?: string } = {},
): Promise<Ix> => ({
  programAddress: address(ASSOCIATED),
  accounts: [
    { address: address(o.payer ?? OWNER), role: AccountRole.WRITABLE_SIGNER },
    {
      address: address(o.account ?? (await tokenAccountOf(holder, asset))),
      role: AccountRole.WRITABLE,
    },
    { address: address(holder), role: AccountRole.READONLY },
    { address: address(mintOf(asset)), role: AccountRole.READONLY },
    { address: address(o.system ?? SYSTEM), role: AccountRole.READONLY },
    { address: address(programOf(asset)), role: AccountRole.READONLY },
  ],
  data: Uint8Array.from(o.data ?? [1]),
});

export const unitLimitIx = (units: number): Ix => ({
  programAddress: address(COMPUTE_BUDGET),
  accounts: [],
  data: join(Uint8Array.of(2), u32(units)),
});
export const unitPriceIx = (microLamports: bigint): Ix => ({
  programAddress: address(COMPUTE_BUDGET),
  accounts: [],
  data: join(Uint8Array.of(3), u64(microLamports)),
});

/** What a builder may be told to get wrong: any account by its name, any argument. */
export type Wrong = {
  accounts?: Record<string, string>;
  extra?: Extra[];
  flags?: Record<string, { signer: boolean; writable: boolean }>;
};

export const createVaultIx = async (
  table: ProgramTable,
  a: {
    basketId?: string;
    targets?: { asset: string; weightBps: number }[];
    autoFollow?: boolean;
    expectedVersion?: number;
    recipe?: string;
  } & Wrong = {},
) =>
  vaultIx(
    table,
    'create_vault',
    {
      owner: OWNER,
      vault: VAULT,
      config: CONFIG,
      assets: ASSETS,
      recipe: a.recipe ?? table.address,
      system_program: SYSTEM,
      ...a.accounts,
    },
    join(
      u64(a.basketId ?? BASKET_ID),
      targetsArg(a.targets ?? []),
      flag(a.autoFollow ?? false),
      u32(a.expectedVersion ?? 0),
    ),
    a.extra,
    a.flags,
  );

export const depositIx = async (table: ProgramTable, amount: string, a: Wrong = {}) =>
  vaultIx(
    table,
    'deposit',
    {
      owner: OWNER,
      vault: VAULT,
      config: CONFIG,
      mint: mintOf(SOLANA.cash),
      vault_token_account: await tokenAccountOf(VAULT, SOLANA.cash),
      source: await tokenAccountOf(OWNER, SOLANA.cash),
      token_program: programOf(SOLANA.cash),
      ...a.accounts,
    },
    u64(amount),
    a.extra,
    a.flags,
  );

export const withdrawIx = async (
  table: ProgramTable,
  asset: string,
  amount: string,
  a: Wrong = {},
) =>
  vaultIx(
    table,
    'withdraw',
    {
      owner: OWNER,
      vault: VAULT,
      mint: mintOf(asset),
      vault_token_account: await tokenAccountOf(VAULT, asset),
      destination: await tokenAccountOf(OWNER, asset),
      token_program: programOf(asset),
      ...a.accounts,
    },
    u64(amount),
    a.extra,
    a.flags,
  );

export const ownerSwapIx = async (
  table: ProgramTable,
  trade: { sell: string; buy: string; inRaw: string; minOutRaw: string },
  a: Wrong & { route?: Uint8Array } = {},
) =>
  vaultIx(
    table,
    'owner_swap',
    {
      owner: OWNER,
      vault: VAULT,
      config: CONFIG,
      assets: ASSETS,
      input_mint: mintOf(trade.sell),
      output_mint: mintOf(trade.buy),
      vault_input: await tokenAccountOf(VAULT, trade.sell),
      vault_output: await tokenAccountOf(VAULT, trade.buy),
      input_token_program: programOf(trade.sell),
      output_token_program: programOf(trade.buy),
      router_program: ROUTER,
      ...a.accounts,
    },
    join(u64(trade.inRaw), u64(trade.minOutRaw), bytesArg(a.route ?? Uint8Array.of(9, 9, 9, 9))),
    // A route's own accounts: pools and their token accounts, which only the router reads.
    a.extra ?? [
      { address: someone('pool'), writable: true },
      { address: someone('pool tokens'), writable: true },
    ],
    a.flags,
  );

export type Wire = { payload: string; messageHash: string };

/** The instructions as one transaction on the wire, with one empty signature slot per signer. */
export function wire(
  instructions: Ix[],
  o: { version?: 0 | 'legacy'; payer?: string; tables?: Record<string, string[]> } = {},
): Wire {
  const lifetime = { blockhash: blockhash(someone('blockhash')), lastValidBlockHeight: 1000n };
  const payer = address(o.payer ?? OWNER);
  const tables = Object.fromEntries(
    Object.entries(o.tables ?? {}).map(([table, held]) => [table, held.map((h) => address(h))]),
  ) as Record<Address, Address[]>;
  const compiled =
    o.version === 'legacy'
      ? compileTransaction(
          pipe(
            createTransactionMessage({ version: 'legacy' }),
            (m) => setTransactionMessageFeePayer(payer, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
            (m) => appendTransactionMessageInstructions(instructions, m),
          ),
        )
      : compileTransaction(
          pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayer(payer, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
            (m) => appendTransactionMessageInstructions(instructions, m),
            (m) => compressTransactionMessageUsingAddressLookupTables(m, tables),
          ),
        );
  return {
    payload: getBase64EncodedWireTransaction(compiled),
    messageHash: createHash('sha256').update(new Uint8Array(compiled.messageBytes)).digest('hex'),
  };
}

/** A transaction as the API hands it out, for a step, around bytes. */
export function solanaTx(step: ApprovedStep, bytes: Wire, over: Partial<BasketTx> = {}): BasketTx {
  return {
    chain: 'solana',
    payload: bytes.payload,
    description: 'a test transaction',
    provenance: 'sandbox',
    lastValidBlockHeight: 1000,
    legKind: step.kind,
    chainId: 'solana',
    signer: step.owner,
    feePayer: step.owner,
    messageHash: bytes.messageHash,
    preview: {
      source: 'test',
      method: 'test',
      fetchedAt: '2026-10-03T12:00:00.000Z',
      provenance: 'sandbox',
      summary: 'a test transaction',
      simulated: true,
      feeNativeRaw: '5000',
      changes: [],
      minimums: tradesOf(step).map((t) => ({ ...t })),
    },
    legId: step.legId,
    attemptId: 'attempt-1',
    ...over,
  };
}
