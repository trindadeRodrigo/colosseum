import type { KeyPairSigner } from '@solana/kit';
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { buildUnsignedV0, type UnsignedV0 } from './compose';
import type { SolanaRpc } from './rpc';

export const KAMINO_MAIN_MARKET = address('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
/** Main-market USDC reserve (nine-figure deposits); two tiny USDC reserves also exist and must be ignored. */
export const KAMINO_USDC_RESERVE = address('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59');
const KAMINO_API = 'https://api.kamino.finance';

/** The market-level address lookup table, from Kamino's public market config. */
export async function fetchMarketLookupTable(
  market: Address = KAMINO_MAIN_MARKET,
): Promise<Address> {
  const res = await fetch(`${KAMINO_API}/v2/kamino-market`);
  const cfg = (await res.json()) as Array<{ lendingMarket: string; lookupTable: string }>;
  const m = cfg.find((c) => c.lendingMarket === market);
  if (!m) throw new Error(`market ${market} not in Kamino config`);
  return address(m.lookupTable);
}

export type KaminoDepositBuild = {
  /** Signed, base64 wire transaction ready to simulate or send. */
  wire: ReturnType<typeof getBase64EncodedWireTransaction>;
  signature: string;
  instructionCount: number;
  lookupTables: Address[];
};

/**
 * Builds and signs a Kamino Lend deposit for `owner` (vanilla obligation, created on first use).
 * Amount is in base units of the reserve's liquidity mint (USDC: 6 decimals).
 * Under policy mechanism A this leg still needs the owner's signature (docs/structurer/VERIFICATION.md V5d).
 */
export async function buildKaminoDepositTx(
  rpc: SolanaRpc,
  owner: KeyPairSigner,
  amountBase: bigint,
  reserve: Address = KAMINO_USDC_RESERVE,
  market: Address = KAMINO_MAIN_MARKET,
): Promise<KaminoDepositBuild> {
  const sdk = await import('@kamino-finance/klend-sdk');
  const kaminoMarket = await sdk.KaminoMarket.load(
    rpc,
    market,
    sdk.DEFAULT_RECENT_SLOT_DURATION_MS,
  );
  if (!kaminoMarket) throw new Error('Kamino market load returned null');
  const currentLedgerInstant = await sdk.getCurrentLedgerInstant(rpc);
  const action = await sdk.KaminoAction.buildDepositTxns({
    kaminoMarket,
    amount: amountBase.toString(),
    reserveAddress: reserve,
    owner,
    obligation: new sdk.VanillaObligation(kaminoMarket.programId),
    useV2Ixs: true,
    scopeRefreshConfig: undefined,
    currentLedgerInstant,
    // First deposit also creates user metadata + obligation; skip the optional per-user LUT (unused here).
    initUserMetadata: { skipInitialization: false, skipLutCreation: true },
  });
  const ixs = [
    ...action.computeBudgetIxs,
    ...action.setupIxs,
    ...action.lendingIxs,
    ...action.cleanupIxs,
  ];
  const lutAddress = await fetchMarketLookupTable(market);
  const luts = await sdk.getLookupTableAccounts(rpc, [lutAddress]);
  const tables = Object.fromEntries(luts.map((l) => [l.address, l.data.addresses])) as Record<
    Address,
    Address[]
  >;
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
    (m) => compressTransactionMessageUsingAddressLookupTables(m, tables),
  );
  const signed = await signTransactionMessageWithSigners(message);
  return {
    wire: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed),
    instructionCount: ixs.length,
    lookupTables: [lutAddress],
  };
}

/** Unsigned Kamino deposit for `owner` (a wallet we do not hold): returned through the API for the partner wallet to sign. */
export async function buildKaminoDepositUnsigned(
  rpc: SolanaRpc,
  owner: Address,
  amountBase: bigint,
  reserve: Address = KAMINO_USDC_RESERVE,
  market: Address = KAMINO_MAIN_MARKET,
): Promise<UnsignedV0> {
  const sdk = await import('@kamino-finance/klend-sdk');
  const kaminoMarket = await sdk.KaminoMarket.load(
    rpc,
    market,
    sdk.DEFAULT_RECENT_SLOT_DURATION_MS,
  );
  if (!kaminoMarket) throw new Error('Kamino market load returned null');
  const currentLedgerInstant = await sdk.getCurrentLedgerInstant(rpc);
  const action = await sdk.KaminoAction.buildDepositTxns({
    kaminoMarket,
    amount: amountBase.toString(),
    reserveAddress: reserve,
    owner: createNoopSigner(owner),
    obligation: new sdk.VanillaObligation(kaminoMarket.programId),
    useV2Ixs: true,
    scopeRefreshConfig: undefined,
    currentLedgerInstant,
    initUserMetadata: { skipInitialization: false, skipLutCreation: true },
  });
  const ixs = [
    ...action.computeBudgetIxs,
    ...action.setupIxs,
    ...action.lendingIxs,
    ...action.cleanupIxs,
  ];
  return buildUnsignedV0(rpc, owner, ixs, [await fetchMarketLookupTable(market)]);
}

/** Unsigned Kamino withdrawal of `amountBase` USDC for `owner` (owner signature required: lending legs are never delegated). */
export async function buildKaminoWithdrawUnsigned(
  rpc: SolanaRpc,
  owner: Address,
  amountBase: bigint,
  reserve: Address = KAMINO_USDC_RESERVE,
  market: Address = KAMINO_MAIN_MARKET,
): Promise<UnsignedV0> {
  const sdk = await import('@kamino-finance/klend-sdk');
  const kaminoMarket = await sdk.KaminoMarket.load(
    rpc,
    market,
    sdk.DEFAULT_RECENT_SLOT_DURATION_MS,
  );
  if (!kaminoMarket) throw new Error('Kamino market load returned null');
  const currentLedgerInstant = await sdk.getCurrentLedgerInstant(rpc);
  const action = await sdk.KaminoAction.buildWithdrawTxns({
    kaminoMarket,
    amount: amountBase.toString(),
    reserveAddress: reserve,
    owner: createNoopSigner(owner),
    obligation: new sdk.VanillaObligation(kaminoMarket.programId),
    useV2Ixs: true,
    scopeRefreshConfig: undefined,
    currentLedgerInstant,
  });
  const ixs = [
    ...action.computeBudgetIxs,
    ...action.setupIxs,
    ...action.lendingIxs,
    ...action.cleanupIxs,
  ];
  return buildUnsignedV0(rpc, owner, ixs, [await fetchMarketLookupTable(market)]);
}
