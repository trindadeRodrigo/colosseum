import {
  type Address,
  address,
  generateKeyPairSigner,
  type Instruction,
  type KeyPairSigner,
  none,
  some,
  type TransactionSigner,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  AccountState,
  decodeToken,
  type ExtensionArgs,
  extension,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeAccount3Instruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getPostInitializeInstructionsForMintExtensions,
  getPreInitializeInstructionsForMintExtensions,
  type Token,
} from '@solana-program/token-2022';
import type { LiteSVM } from 'litesvm';
import { expectOk, SYSTEM_PROGRAM, send } from './env';

export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

/** Token program errors the tests name. The numbers are the same in both token programs. */
export const TOKEN_ERR = {
  InsufficientFunds: 1,
  MintMismatch: 3,
  OwnerMismatch: 4,
  MintPaused: 67,
} as const;

export type TestMint = {
  address: Address;
  /** The token program that owns the mint. */
  program: Address;
  decimals: number;
  /** Mint, freeze and every extension authority: the test's stand-in for the issuer. */
  issuer: KeyPairSigner;
};

/** The extensions SPYx carries on mainnet (docs/vault/research/test-networks.md, section 3):
 * a transfer hook with an authority and no program, a permanent delegate, pausable, a scaled
 * UI amount, default account state "initialized", confidential transfers configured without
 * auto-approve, and a metadata pointer. The metadata text itself is left out. */
export function stockExtensions(issuer: Address, mint: Address): ExtensionArgs[] {
  return [
    extension('TransferHook', { authority: issuer, programId: SYSTEM_PROGRAM }),
    extension('PermanentDelegate', { delegate: issuer }),
    extension('PausableConfig', { authority: some(issuer), paused: false }),
    extension('ScaledUiAmountConfig', {
      authority: issuer,
      multiplier: 1.003909,
      newMultiplierEffectiveTimestamp: 0n,
      newMultiplier: 1.005715,
    }),
    extension('DefaultAccountState', { state: AccountState.Initialized }),
    extension('ConfidentialTransferMint', {
      authority: some(issuer),
      autoApproveNewAccounts: false,
      auditorElgamalPubkey: none(),
    }),
    extension('MetadataPointer', { authority: some(issuer), metadataAddress: some(mint) }),
  ];
}

export async function createMint(
  svm: LiteSVM,
  payer: TransactionSigner,
  options: {
    program: Address;
    decimals: number;
    /** The stock token's extension set. */
    stock?: boolean;
    /** Or any other extensions, given the issuer's address. */
    extensions?: (issuer: Address) => ExtensionArgs[];
  },
): Promise<TestMint> {
  const mint = await generateKeyPairSigner();
  const issuer = await generateKeyPairSigner();
  const extensions = options.stock
    ? stockExtensions(issuer.address, mint.address)
    : (options.extensions?.(issuer.address) ?? []);
  // A mint without extensions is the base 82 bytes under either token program.
  const space = extensions.length ? BigInt(getMintSize(extensions)) : 82n;
  const config = { programAddress: options.program };
  const result = await send(svm, payer, [
    getCreateAccountInstruction({
      payer,
      newAccount: mint,
      lamports: svm.minimumBalanceForRentExemption(space),
      space,
      programAddress: options.program,
    }),
    ...getPreInitializeInstructionsForMintExtensions(mint.address, extensions),
    getInitializeMint2Instruction(
      {
        mint: mint.address,
        decimals: options.decimals,
        mintAuthority: issuer.address,
        freezeAuthority: issuer.address,
      },
      config,
    ),
    ...getPostInitializeInstructionsForMintExtensions(mint.address, issuer, extensions),
  ]);
  expectOk(result);
  return { address: mint.address, program: options.program, decimals: options.decimals, issuer };
}

/** The associated token account: the one address per (holder, mint, token program). */
export async function ata(holder: Address, mint: TestMint): Promise<Address> {
  const [pda] = await findAssociatedTokenPda({
    owner: holder,
    mint: mint.address,
    tokenProgram: mint.program,
  });
  return pda;
}

export async function createAtaInstruction(
  payer: TransactionSigner,
  holder: Address,
  mint: TestMint,
): Promise<Instruction> {
  return getCreateAssociatedTokenIdempotentInstruction({
    payer,
    ata: await ata(holder, mint),
    owner: holder,
    mint: mint.address,
    tokenProgram: mint.program,
  });
}

export async function createAta(
  svm: LiteSVM,
  payer: TransactionSigner,
  holder: Address,
  mint: TestMint,
): Promise<Address> {
  expectOk(await send(svm, payer, [await createAtaInstruction(payer, holder, mint)]));
  return ata(holder, mint);
}

/** Mints to the holder's associated token account, creating it if needed. */
export async function mintTo(
  svm: LiteSVM,
  payer: TransactionSigner,
  mint: TestMint,
  holder: Address,
  amount: bigint,
): Promise<Address> {
  const token = await ata(holder, mint);
  const result = await send(svm, payer, [
    await createAtaInstruction(payer, holder, mint),
    getMintToInstruction(
      { mint: mint.address, token, mintAuthority: mint.issuer, amount },
      { programAddress: mint.program },
    ),
  ]);
  expectOk(result);
  return token;
}

/** Mints to one token account, wherever it is. */
export async function mintToAccount(
  svm: LiteSVM,
  payer: TransactionSigner,
  mint: TestMint,
  token: Address,
  amount: bigint,
): Promise<void> {
  const result = await send(svm, payer, [
    getMintToInstruction(
      { mint: mint.address, token, mintAuthority: mint.issuer, amount },
      { programAddress: mint.program },
    ),
  ]);
  expectOk(result);
}

/** A token account that is not the associated one. Only for mints without extensions:
 * the account is the base 165 bytes. */
export async function createLooseTokenAccount(
  svm: LiteSVM,
  payer: TransactionSigner,
  mint: TestMint,
  holder: Address,
): Promise<Address> {
  const account = await generateKeyPairSigner();
  const space = 165n;
  const result = await send(svm, payer, [
    getCreateAccountInstruction({
      payer,
      newAccount: account,
      lamports: svm.minimumBalanceForRentExemption(space),
      space,
      programAddress: mint.program,
    }),
    getInitializeAccount3Instruction(
      { account: account.address, mint: mint.address, owner: holder },
      { programAddress: mint.program },
    ),
  ]);
  expectOk(result);
  return account.address;
}

export function tokenAccount(svm: LiteSVM, token: Address): Token {
  const account = svm.getAccount(token);
  if (!account.exists) throw new Error(`token account ${token} does not exist`);
  return decodeToken(account).data;
}

/** Raw units held; zero when the account does not exist. */
export function balance(svm: LiteSVM, token: Address): bigint {
  return svm.getAccount(token).exists ? tokenAccount(svm, token).amount : 0n;
}

/** A Token-2022 transfer fee of 1%: the receiver gets less than was sent. */
export const onePercentFee = (issuer: Address): ExtensionArgs[] => {
  const fee = { epoch: 0n, maximumFee: 1_000_000_000n, transferFeeBasisPoints: 100 };
  return [
    extension('TransferFeeConfig', {
      transferFeeConfigAuthority: issuer,
      withdrawWithheldAuthority: issuer,
      withheldAmount: 0n,
      olderTransferFee: fee,
      newerTransferFee: fee,
    }),
  ];
};
