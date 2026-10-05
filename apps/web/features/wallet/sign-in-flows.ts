import type { Chain } from '@colosseum/schemas';
import { getAddress, stringToHex } from 'viem';
import { base64Encode } from './bytes';
import { fail } from './errors';
import type { Eip1193 } from './found-wallets';

// Signing in with an outside wallet, with no window of the wallet provider's: the wallet is asked for
// its account, signs the provider's sign-in message, and the provider checks the signature. The
// provider's calls are handed in, so this file names no provider and runs in a test.

/** A name as the provider files a wallet under: lower case, words joined by an underscore. */
export const clientType = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

export type SiweCalls = {
  /** The EIP-4361 message for an address on a chain (`eip155:<id>`). */
  generate(args: { address: string; chainId: `eip155:${number}` }): Promise<string>;
  login(args: {
    message: string;
    signature: string;
    walletClientType?: string;
    connectorType?: string;
  }): Promise<unknown>;
};

/** Sign-In with Ethereum, with a wallet the browser announced. */
export async function signInWithEvmWallet(
  wallet: { name: string; provider: Eip1193 },
  calls: SiweCalls,
): Promise<void> {
  const accounts = await wallet.provider.request({ method: 'eth_requestAccounts' });
  const account = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof account !== 'string') throw fail('wallet_silent', 'the wallet gave no account');
  let address: string;
  try {
    address = getAddress(account);
  } catch {
    throw fail('wallet_silent', 'the wallet gave an account that is not an address');
  }
  const chain = Number(await wallet.provider.request({ method: 'eth_chainId' }));
  if (!Number.isSafeInteger(chain) || chain <= 0)
    throw fail('wallet_silent', 'the wallet did not say which chain it is on');
  const message = await calls.generate({ address, chainId: `eip155:${chain}` });
  const signature = await wallet.provider.request({
    method: 'personal_sign',
    params: [stringToHex(message), account],
  });
  if (typeof signature !== 'string')
    throw fail('wallet_silent', 'the wallet returned no signature');
  await calls.login({
    message,
    signature,
    walletClientType: clientType(wallet.name),
    connectorType: 'injected',
  });
}

/** A Solana wallet as the wallet standard describes one: the two features sign-in needs. */
export type StandardSolanaWallet = {
  name: string;
  features: {
    'standard:connect'?: {
      connect(): Promise<{ accounts: readonly { address: string }[] }>;
    };
    'solana:signMessage'?: {
      signMessage(
        ...inputs: { account: never; message: Uint8Array }[]
      ): Promise<readonly { signature: Uint8Array }[]>;
    };
  };
};

export type SiwsCalls = {
  generate(args: { address: string }): Promise<string>;
  login(args: {
    message: string;
    /** base64 of the 64 bytes. */
    signature: string;
    walletClientType?: string;
    connectorType?: string;
  }): Promise<unknown>;
};

/**
 * A wallet that is in this browser, as an extension or as the wallet's own browser. WalletConnect
 * registers itself as a wallet too; it is a window of its own that pairs with a phone, drawn by its
 * maker, so it is not listed.
 */
export const inBrowser = (wallet: { name: string }): boolean =>
  !/^wallet\s*connect$/i.test(wallet.name.trim());

/** Can this wallet sign in at all: it connects, and it signs a message. */
export const canSignIn = (wallet: StandardSolanaWallet): boolean =>
  wallet.features['standard:connect'] !== undefined &&
  wallet.features['solana:signMessage'] !== undefined;

/** Sign-In with Solana, with a wallet registered with the wallet standard. */
export async function signInWithSolanaWallet(
  wallet: StandardSolanaWallet,
  calls: SiwsCalls,
): Promise<void> {
  const connect = wallet.features['standard:connect'];
  const signer = wallet.features['solana:signMessage'];
  if (!connect || !signer) throw fail('unsupported', 'that wallet cannot sign a message');
  const { accounts } = await connect.connect();
  const account = accounts[0];
  if (!account) throw fail('wallet_silent', 'the wallet gave no account');
  const message = await calls.generate({ address: account.address });
  const [signed] = await signer.signMessage({
    account: account as never,
    message: new TextEncoder().encode(message),
  });
  if (!signed) throw fail('wallet_silent', 'the wallet returned no signature');
  await calls.login({
    message,
    signature: base64Encode(signed.signature),
    walletClientType: clientType(wallet.name),
    connectorType: 'solana_adapter',
  });
}

/** A linked account as the wallet provider lists one. Only wallets are read. */
export type LinkedAccount = {
  type: string;
  chainType?: string;
  walletClientType?: string | null;
};

const EMBEDDED = new Set(['privy', 'privy-v2']);
export const isEmbedded = (clientType: string | null | undefined) =>
  typeof clientType === 'string' && EMBEDDED.has(clientType);

const CHAIN_TYPE: Record<Chain, string> = { solana: 'solana', evm: 'ethereum' };

/**
 * The provider's answer when a wallet of that family is there already: nothing is left to make. Privy
 * (3.46) throws a plain Error with these words and gives its code to its own event only, so the words
 * are what is read; the code is read too, for a version that carries it on the error.
 */
export function walletAlreadyThere(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { privyErrorCode, message } = error as { privyErrorCode?: unknown; message?: unknown };
  return (
    privyErrorCode === 'embedded_wallet_already_exists' ||
    (typeof message === 'string' && /already has an embedded wallet/i.test(message))
  );
}

/**
 * The families a person is owed a wallet of and has none yet. Someone who signed in with a passkey gets
 * one of each family, made here: the provider makes none by itself after a sign-in without its own
 * window. Someone who connected an outside wallet has their wallet, and none is made.
 */
export function missingWallets(linked: readonly LinkedAccount[]): Chain[] {
  const wallets = linked.filter((account) => account.type === 'wallet');
  if (wallets.some((wallet) => !isEmbedded(wallet.walletClientType))) return [];
  return (['solana', 'evm'] as const).filter(
    (family) => !wallets.some((wallet) => wallet.chainType === CHAIN_TYPE[family]),
  );
}
