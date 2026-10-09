import {
  type AssetId,
  CHAIN_ERROR_RETRYABLE,
  ChainError,
  type ChainErrorCode,
} from '@colosseum/schemas';
import {
  AccountRole,
  type Address,
  appendTransactionMessageInstructions,
  type Commitment,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  type IAccountLookupMeta,
  type IAccountMeta,
  type IInstruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  computeUnitLimitInstruction,
  computeUnitPriceInstruction,
  MAX_COMPUTE_UNITS,
} from './program';
import { ask, getAccounts, type RawAccount, type VaultWriteRpc } from './rpc';
import { describeFailure } from './status';
import { decodeTokenAccount } from './tokens';

// One transaction from a builder's instructions (DESIGN-VAULT 3.2, 3.3, section 10): a fresh blockhash,
// a simulation against the chain as it is, a compute budget sized from what the simulation used, the
// fee it can cost, what it changes, and the hash that ties signed bytes back to it. Nothing is signed
// and nothing is sent.

/** The most bytes a transaction may be on the wire. */
export const MAX_TRANSACTION_BYTES = 1232;
/** The signature fee of one signature. */
export const SIGNATURE_FEE_LAMPORTS = 5_000n;
/** The compute budget is the units the simulation used, plus a fifth (design section 10). */
const BUDGET_HEADROOM = 1.2;
/** Where nothing else is said, the most a priority fee may add to a transaction: 0.001 SOL. */
export const DEFAULT_MAX_PRIORITY_LAMPORTS = 1_000_000n;

export type PriorityFee = {
  /** A fixed price per compute unit, in millionths of a lamport. Left out: from the recent fees. */
  microLamports?: bigint;
  /** The most the priority fee may add to one transaction. */
  maxLamports?: bigint;
};

/** A token account whose balance the preview reports, by who holds it and which asset it is. */
export type Watch = { holder: 'wallet' | 'vault'; asset: AssetId; account: Address };

export type Composed = {
  /** base64 of the whole transaction, with an empty signature for each signer. */
  payload: string;
  messageHash: string;
  lastValidBlockHeight: bigint;
  /** What the simulation used, and the limit the transaction asks for. */
  unitsConsumed: number;
  computeUnitLimit: number;
  microLamportsPerUnit: bigint;
  /** Signatures plus priority, in lamports. */
  feeLamports: bigint;
  bytes: number;
  changes: { holder: 'wallet' | 'vault'; asset: AssetId; deltaRaw: string }[];
  logs: string[];
};

const hexOf = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
}

/**
 * The bytes of the message inside a serialized transaction: what follows the signatures (a compact
 * count, then 64 bytes each). Null when the bytes cannot be a transaction.
 */
export function messageBytesOf(wire: Uint8Array): { count: number; message: Uint8Array } | null {
  let count = 0;
  let at = 0;
  for (let shift = 0; ; shift += 7) {
    const byte = wire[at];
    if (byte === undefined || at > 2) return null;
    at += 1;
    count |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
  }
  const start = at + 64 * count;
  if (count === 0 || start >= wire.length) return null;
  return { count, message: wire.subarray(start) };
}

/** A transaction's id and message hash rule (basket-tx.ts): the SHA-256 of the message bytes. */
export async function messageHashOfWire(wire: Uint8Array): Promise<string | null> {
  const parts = messageBytesOf(wire);
  return parts ? sha256Hex(parts.message) : null;
}

/** The program's log line for a refused version (DESIGN-VAULT section 6): which of the rules it broke. */
export function creatorLimitReason(logs: readonly string[]): string | null {
  for (const line of logs) {
    const match = line.match(/creator limit: reason=(\d+) (\w+)/);
    if (match) return `rule ${match[1]}, ${match[2]}`;
  }
  return null;
}

const NO_GAS = new Set(['InsufficientFundsForFee', 'InsufficientFundsForRent', 'AccountNotFound']);

/**
 * A simulated or landed failure as the adapter's refusal. The vault program's own errors keep their
 * names; Anchor's check of the one key a step expects is `NotOwner`; a payer with too little SOL is
 * `NoGas`; anything else is `Unknown`, with what the chain said in the message.
 */
export function refusalOf(
  err: unknown,
  logs: readonly string[] | null,
  program: Address,
): ChainError {
  const { code, message } = describeFailure(err, logs, program);
  if (code === 'CreatorLimit') {
    const reason = logs ? creatorLimitReason(logs) : null;
    return new ChainError(
      'CreatorLimit',
      reason ? `the registry refused the version: ${reason}` : message,
    );
  }
  if (code in CHAIN_ERROR_RETRYABLE) return new ChainError(code as ChainErrorCode, message);
  if (NO_GAS.has(code)) return new ChainError('NoGas', `the fee payer cannot pay: ${code}`);
  if (code === 'BlockhashNotFound')
    return new ChainError('Unavailable', 'the blockhash went stale before the simulation');
  if (/^ConstraintHasOne\b/.test(message))
    return new ChainError('NotOwner', 'the signer is not the key this step needs');
  return new ChainError('Unknown', message);
}

/** The middle of the recent fees for these accounts, read as a price per unit; zero when none are paid. */
async function recentPrice(rpc: VaultWriteRpc, accounts: Address[]): Promise<bigint> {
  const recent = await ask('getRecentPrioritizationFees', () =>
    rpc.getRecentPrioritizationFees(accounts.slice(0, 128)).send(),
  );
  const fees = recent.map((r) => BigInt(r.prioritizationFee)).sort((a, b) => (a < b ? -1 : 1));
  return fees[Math.floor(fees.length / 2)] ?? 0n;
}

function balanceOf(account: RawAccount | null | undefined): bigint {
  if (!account) return 0n;
  try {
    return decodeTokenAccount(account.data).amount;
  } catch {
    return 0n;
  }
}

export type ComposeInput = {
  rpc: VaultWriteRpc;
  program: Address;
  feePayer: Address;
  /** The step's own instructions, in order. The compute budget goes in front of them here. */
  instructions: IInstruction[];
  watch: Watch[];
  priority?: PriorityFee;
  commitment?: Commitment;
};

export async function compose(input: ComposeInput): Promise<Composed> {
  const { rpc, feePayer, instructions, watch } = input;
  const commitment = input.commitment ?? 'confirmed';
  const watched = watch.map((w) => w.account);

  const [before, latest] = await Promise.all([
    getAccounts(rpc, watched, commitment),
    ask('getLatestBlockhash', () => rpc.getLatestBlockhash({ commitment }).send()),
  ]);
  const writable = [
    ...new Set(
      instructions.flatMap((ix) =>
        (ix.accounts ?? [])
          .filter((a) => a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER)
          .map((a) => a.address),
      ),
    ),
  ];
  const maxLamports = input.priority?.maxLamports ?? DEFAULT_MAX_PRIORITY_LAMPORTS;
  const wanted = input.priority?.microLamports ?? (await recentPrice(rpc, writable));

  const build = (limit: number, price: bigint) => {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest.value, m),
      (m) =>
        appendTransactionMessageInstructions(
          [
            computeUnitLimitInstruction(limit),
            // A price wherever the cap allows one (`priceAt`): with none, a wallet such as Phantom adds
            // its own priority-fee instruction before signing, and the app then refuses the changed
            // transaction (devnet's recent fees are 0).
            ...(price > 0n ? [computeUnitPriceInstruction(price)] : []),
            ...instructions,
          ],
          m,
        ),
    );
    return compileTransaction(message);
  };

  // The price is capped so the priority fee stays under `maxLamports` at the limit asked for. It is
  // at least 1 micro-lamport (about 1 lamport a transaction), so a wallet adds no price of its own,
  // unless the cap allows none: `maxLamports` 0, or too small for the limit. The cap always wins.
  const priceAt = (limit: number) => {
    const cap = (maxLamports * 1_000_000n) / BigInt(limit);
    const capped = wanted < cap ? wanted : cap;
    if (capped > 0n) return capped;
    return cap >= 1n ? 1n : 0n;
  };
  const tooLarge = (bytes: number) =>
    new ChainError(
      'NotSupported',
      `the transaction is ${bytes} bytes, over the ${MAX_TRANSACTION_BYTES} a Solana transaction may be`,
    );
  const trial = build(MAX_COMPUTE_UNITS, priceAt(MAX_COMPUTE_UNITS));
  // A transaction that cannot be sent is refused before the node is asked to simulate it. The final
  // one is measured again below: its limit and price keep their sizes, but where the cap allows no
  // price at this limit and one at the lower final limit, it gains the price instruction.
  const trialBytes = getTransactionEncoder().encode(trial).length;
  if (trialBytes > MAX_TRANSACTION_BYTES) throw tooLarge(trialBytes);
  const simulated = await ask('simulateTransaction', () =>
    rpc
      .simulateTransaction(getBase64EncodedWireTransaction(trial), {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment,
        accounts: { addresses: watched, encoding: 'base64' },
      })
      .send(),
  );
  const { err, logs, unitsConsumed, accounts } = simulated.value;
  if (err) throw refusalOf(err, logs ?? null, input.program);

  const used = Number(unitsConsumed ?? 0n);
  const limit = Math.min(MAX_COMPUTE_UNITS, Math.max(1_000, Math.ceil(used * BUDGET_HEADROOM)));
  const price = priceAt(limit);
  const transaction = build(limit, price);
  const wire = getTransactionEncoder().encode(transaction);
  if (wire.length > MAX_TRANSACTION_BYTES) throw tooLarge(wire.length);
  const signers = Object.keys(transaction.signatures).length;
  const priority = (price * BigInt(limit) + 999_999n) / 1_000_000n;

  const after = (accounts ?? []).map((a, i): RawAccount | null =>
    a
      ? {
          address: watched[i] as Address,
          owner: a.owner,
          lamports: BigInt(a.lamports),
          data: new Uint8Array(Buffer.from(a.data[0], 'base64')),
        }
      : null,
  );
  const changes = watch.flatMap((w, i) => {
    const delta = balanceOf(after[i]) - balanceOf(before[i]);
    return delta === 0n ? [] : [{ holder: w.holder, asset: w.asset, deltaRaw: delta.toString() }];
  });

  return {
    payload: getBase64EncodedWireTransaction(transaction),
    messageHash: await sha256Hex(new Uint8Array(transaction.messageBytes)),
    lastValidBlockHeight: latest.value.lastValidBlockHeight,
    unitsConsumed: used,
    computeUnitLimit: limit,
    microLamportsPerUnit: price,
    feeLamports: SIGNATURE_FEE_LAMPORTS * BigInt(signers) + priority,
    bytes: wire.length,
    changes,
    logs: [...(logs ?? [])],
  };
}

/**
 * The router's own accounts of a swap, each read through one of the route's lookup tables where it can
 * be. Only these: every account an instruction names for itself stays in the message, as the guard
 * requires (it refuses a named account read from a table). `named` is every address the transaction
 * names elsewhere, which keeps its place in the message.
 */
export function lookupRouterAccounts(
  ix: IInstruction,
  fixedAccounts: number,
  tables: { address: Address; addresses: Address[] }[],
  named: Set<Address>,
): IInstruction {
  const accounts = ix.accounts ?? [];
  const index = new Map<Address, { table: Address; at: number }>();
  for (const table of tables)
    table.addresses.forEach((address, at) => {
      if (!index.has(address)) index.set(address, { table: table.address, at });
    });
  return {
    ...ix,
    accounts: accounts.map((meta, i): IAccountMeta | IAccountLookupMeta => {
      const found = i >= fixedAccounts && !named.has(meta.address) && index.get(meta.address);
      if (
        !found ||
        meta.role === AccountRole.READONLY_SIGNER ||
        meta.role === AccountRole.WRITABLE_SIGNER
      )
        return meta;
      return {
        address: meta.address,
        addressIndex: found.at,
        lookupTableAddress: found.table,
        role: meta.role,
      } as IAccountLookupMeta;
    }),
  };
}
