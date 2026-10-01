import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import anchor from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  type AddressLookupTableAccount,
  ComputeBudgetProgram,
  type Connection,
  Keypair,
  PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = resolve(ROOT, 'out');

export const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const SPYX = new PublicKey('XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W');
export const JUPITER_V6 = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
export const JUP_API = process.env.JUP_API ?? 'https://lite-api.jup.ag/swap/v1';
export const MAINNET_RPC = process.env.MAINNET_RPC ?? 'https://api.mainnet-beta.solana.com';

export const idl = JSON.parse(readFileSync(resolve(ROOT, 'target/idl/vault_swap.json'), 'utf8'));
export const PROGRAM_ID = new PublicKey(idl.address);

export function loadKeypair(path: string): Keypair {
  const p = path.startsWith('~') ? path.replace('~', process.env.HOME!) : path;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
}

export function vaultPda(owner: PublicKey, basketId: bigint): PublicKey {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(basketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), owner.toBuffer(), id],
    PROGRAM_ID,
  )[0];
}

export function vaultAtas(vault: PublicKey) {
  return {
    usdc: getAssociatedTokenAddressSync(
      USDC,
      vault,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    spyx: getAssociatedTokenAddressSync(
      SPYX,
      vault,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  };
}

export function program(connection: Connection, payer: Keypair) {
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {
    commitment: 'confirmed',
  });
  return new anchor.Program(idl, provider);
}

// ---- Jupiter ----

export type JupIx = {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
};

export type Route = {
  fetchedAt: string;
  vault: string;
  quote: any;
  swapInstruction: JupIx;
  setupInstructions: JupIx[];
  cleanupInstruction: JupIx | null;
  addressLookupTableAddresses: string[];
};

export type RouteOpts = {
  amount: bigint; // USDC raw units (6 decimals)
  slippageBps?: number;
  maxAccounts?: number;
  dexes?: string; // e.g. "Raydium CLMM"
  onlyDirectRoutes?: boolean;
  useSharedAccounts?: boolean;
};

async function getJson(url: string, init?: RequestInit) {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (process.env.JUP_API_KEY) headers['x-api-key'] = process.env.JUP_API_KEY;
  // The keyless endpoint answers 429 quickly when several agents share one IP.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, headers });
    const text = await res.text();
    if (res.status === 429 && attempt < 6) {
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${url}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  }
}

/** Quote and swap instructions with the vault PDA as Jupiter's `userPublicKey`. */
export async function fetchRoute(vault: PublicKey, o: RouteOpts): Promise<Route> {
  const q = new URLSearchParams({
    inputMint: USDC.toBase58(),
    outputMint: SPYX.toBase58(),
    amount: o.amount.toString(),
    slippageBps: String(o.slippageBps ?? 100),
    swapMode: 'ExactIn',
  });
  if (o.maxAccounts) q.set('maxAccounts', String(o.maxAccounts));
  if (o.dexes) q.set('dexes', o.dexes);
  if (o.onlyDirectRoutes) q.set('onlyDirectRoutes', 'true');
  const quote = await getJson(`${JUP_API}/quote?${q}`);

  const body: Record<string, unknown> = {
    quoteResponse: quote,
    userPublicKey: vault.toBase58(),
    wrapAndUnwrapSol: false,
    dynamicComputeUnitLimit: false,
  };
  if (o.useSharedAccounts !== undefined) body.useSharedAccounts = o.useSharedAccounts;
  const ixs = await getJson(`${JUP_API}/swap-instructions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (ixs.error) throw new Error(`swap-instructions: ${ixs.error}`);

  return {
    fetchedAt: new Date().toISOString(),
    vault: vault.toBase58(),
    quote,
    swapInstruction: ixs.swapInstruction,
    setupInstructions: ixs.setupInstructions ?? [],
    cleanupInstruction: ixs.cleanupInstruction ?? null,
    addressLookupTableAddresses: ixs.addressLookupTableAddresses ?? [],
  };
}

/** Our program's `swap` instruction wrapping Jupiter's. The vault is not a transaction
 *  signer: the program signs for it inside the CPI, so its flag is cleared here. */
export async function buildVaultSwapIx(
  prog: anchor.Program,
  owner: PublicKey,
  vault: PublicKey,
  route: Route,
): Promise<TransactionInstruction> {
  const jup = route.swapInstruction;
  if (jup.programId !== JUPITER_V6.toBase58())
    throw new Error(`unexpected program ${jup.programId}`);
  const atas = vaultAtas(vault);
  return prog.methods
    .swap(
      new anchor.BN(route.quote.inAmount),
      new anchor.BN(route.quote.otherAmountThreshold),
      Buffer.from(jup.data, 'base64'),
    )
    .accounts({
      owner,
      vault,
      inputMint: USDC,
      outputMint: SPYX,
      vaultInputTokenAccount: atas.usdc,
      vaultOutputTokenAccount: atas.spyx,
      jupiterProgram: JUPITER_V6,
    })
    .remainingAccounts(
      jup.accounts.map((a) => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: false,
        isWritable: a.isWritable,
      })),
    )
    .instruction();
}

export async function loadAlts(connection: Connection, addrs: string[]) {
  const out: AddressLookupTableAccount[] = [];
  for (const a of addrs) {
    const r = await connection.getAddressLookupTable(new PublicKey(a));
    if (!r.value) throw new Error(`lookup table ${a} not found on this cluster`);
    out.push(r.value);
  }
  return out;
}

export async function buildTx(
  connection: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
  alts: AddressLookupTableAccount[],
  cuLimit: number,
  cuPriceMicroLamports = 0,
): Promise<VersionedTransaction> {
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit })];
  if (cuPriceMicroLamports > 0) {
    budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicroLamports }));
  }
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [...budget, ...ixs],
  }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return tx;
}

export function txStats(tx: VersionedTransaction, jupAccounts: number) {
  const m = tx.message;
  const viaAlt = m.addressTableLookups.reduce(
    (n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length,
    0,
  );
  return {
    txBytes: tx.serialize().length,
    txBytesLimit: 1232,
    accountsTotal: m.staticAccountKeys.length + viaAlt,
    accountsStatic: m.staticAccountKeys.length,
    accountsViaLookupTables: viaAlt,
    lookupTables: m.addressTableLookups.length,
    jupiterIxAccounts: jupAccounts,
    accountLockLimit: 64,
  };
}

/** Deepest "Program X invoke [N]" in the logs. N=1 is the top-level instruction. */
export function logStats(logs: string[]) {
  let depth = 0;
  const chain: string[] = [];
  let cu: number | null = null;
  for (const l of logs) {
    const m = l.match(/^Program (\w+) invoke \[(\d+)\]/);
    if (m) {
      const d = Number(m[2]);
      chain[d - 1] = m[1];
      if (d > depth) depth = d;
    }
    const c = l.match(new RegExp(`^Program ${PROGRAM_ID.toBase58()} consumed (\\d+) of`));
    if (c) cu = Number(c[1]);
  }
  return { maxInvokeDepth: depth, vaultProgramComputeUnits: cu };
}
