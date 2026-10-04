import type { Chain } from '@colosseum/schemas';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base58Encode, parseSolanaTx, withSolanaSignature } from '../bytes';
import type { DriverAccount, EvmRequest, FoundWallet, WalletDriver } from '../driver';

// A wallet made of throwaway keys, for automated tests and for work on the mock. The keys are made in
// memory when the wallet is created and are never stored, so a reload is a new wallet with no funds.
//
// It cannot reach a production build by accident, three ways:
// 1. Nothing imports this file except the tests, the dev page (a route only `next dev` has) and
//    test-bridge.tsx, which the provider loads only when NODE_ENV is not production.
// 2. createTestDriver() throws when NODE_ENV is production, and the bundler then drops the key code.
// 3. scripts/check-build.mjs runs after every `next build` and fails it if TEST_WALLET_MARKER is in
//    the output.

/** Never rename without scripts/check-build.mjs: the build check looks for this string. */
export const TEST_WALLET_MARKER = 'test-wallet:throwaway-keys';

export type EvmFees = {
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export type TestWalletOptions = {
  /** `external` behaves like MetaMask on EVM: it cannot sign without sending. Default `embedded`. */
  kind?: 'embedded' | 'external';
  families?: Chain[];
  /** Stands in for the person. Called before every signature; throw what a wallet would to refuse. */
  approve?: (action: 'sign' | 'send' | 'message', family: Chain) => void | Promise<void>;
  /** What an EVM wallet fills in by itself. Default: nonce 0, 21,000 gas, 1 gwei. */
  prepareEvm?: (from: `0x${string}`, request: EvmRequest) => Promise<EvmFees>;
  /** Sends a signed EVM transaction. Default: there is no network, so sending is refused. */
  broadcastEvm?: (signed: `0x${string}`) => Promise<`0x${string}`>;
  /** Called when the wallet signs in or out, so a view can render again. */
  onChange?: () => void;
};

const DEFAULT_FEES: EvmFees = {
  nonce: 0,
  gas: 21_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
};

export type TestDriver = WalletDriver & { readonly marker: typeof TEST_WALLET_MARKER };

/**
 * What the throwaway wallet offers the sign-in screen as outside wallets: one of each family. Signing
 * in with one gives that one account, as an outside wallet; signing in with a passkey gives both, as
 * wallets made in the app. So both ways in can be walked with no real wallet.
 */
export const TEST_WALLETS: FoundWallet[] = [
  { id: 'test:solana', name: 'Throwaway wallet', family: 'solana' },
  { id: 'test:evm', name: 'Throwaway wallet', family: 'evm' },
];

export async function createTestDriver(options: TestWalletOptions = {}): Promise<TestDriver> {
  // In a production build the bundler keeps this throw and drops the rest of the function as dead
  // code. The marker is in the message so that what is left is still found by the build check.
  if (process.env.NODE_ENV === 'production')
    throw new Error(`${TEST_WALLET_MARKER} is not available in a production build`);
  // What the signed-in accounts are. Signing in with one of TEST_WALLETS makes it `external`.
  let kind = options.kind ?? 'embedded';
  const families = options.families ?? ['solana', 'evm'];
  const approve = options.approve ?? (() => {});

  const solana = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const solanaKey = new Uint8Array(await crypto.subtle.exportKey('raw', solana.publicKey));
  const solanaAddress = base58Encode(solanaKey);
  const evm = privateKeyToAccount(generatePrivateKey());

  const all = (): DriverAccount[] => [
    { family: 'solana', address: solanaAddress, kind },
    // viem returns the checksum form, as a wallet provider does: the port puts it in lower case.
    { family: 'evm', address: evm.address, kind },
  ];
  const held = (): DriverAccount[] => all().filter((a) => families.includes(a.family));

  const own = (family: Chain, address: string) => {
    const account = driver.accounts.find((a) => a.family === family);
    if (!account || account.address.toLowerCase() !== address.toLowerCase())
      throw new Error('disconnected: the test wallet does not hold that account');
  };
  const signBytes = async (message: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign('Ed25519', solana.privateKey, message as BufferSource));
  const signEvm = async (request: EvmRequest) => {
    const fees = await (options.prepareEvm?.(evm.address, request) ?? DEFAULT_FEES);
    return evm.signTransaction({ type: 'eip1559', ...request, ...fees });
  };

  const driver: TestDriver = {
    marker: TEST_WALLET_MARKER,
    test: true,
    status: 'signed-out',
    userId: null,
    accounts: [],
    found: TEST_WALLETS,

    async signIn(method, choice) {
      const wallet =
        method === 'wallet' && choice?.wallet !== undefined
          ? TEST_WALLETS.find((w) => w.id === choice.wallet)
          : undefined;
      if (method === 'wallet' && choice?.wallet !== undefined && !wallet)
        throw new Error('disconnected: the test wallet has no such wallet');
      if (wallet) kind = 'external';
      driver.status = 'ready';
      driver.userId = `test:${solanaAddress.slice(0, 8)}`;
      driver.accounts = wallet ? held().filter((a) => a.family === wallet.family) : held();
      options.onChange?.();
    },
    async signOut() {
      driver.status = 'signed-out';
      driver.userId = null;
      driver.accounts = [];
      kind = options.kind ?? 'embedded';
      options.onChange?.();
    },

    async signSolana(address, transactions) {
      own('solana', address);
      await approve('sign', 'solana');
      return Promise.all(
        transactions.map(async (bytes) => {
          const wire = parseSolanaTx(bytes);
          const slot = wire.signers.indexOf(solanaAddress);
          if (slot < 0) throw new Error('the transaction does not ask this account to sign');
          return withSolanaSignature(bytes, slot, await signBytes(wire.message));
        }),
      );
    },
    async signSolanaMessage(address, message) {
      own('solana', address);
      await approve('message', 'solana');
      return signBytes(message);
    },

    async signEvm(address, request) {
      own('evm', address);
      if (kind === 'external') throw Object.assign(new Error('not supported'), { code: 4200 });
      await approve('sign', 'evm');
      return signEvm(request);
    },
    async sendEvm(address, request) {
      own('evm', address);
      await approve('send', 'evm');
      if (!options.broadcastEvm) throw new Error('not supported: the test wallet has no network');
      return options.broadcastEvm(await signEvm(request));
    },
    async signEvmMessage(address, message) {
      own('evm', address);
      await approve('message', 'evm');
      return evm.signMessage({ message });
    },

    async exportKey() {
      throw new Error('not supported: a throwaway key is not exported');
    },
    // The API verifies Privy tokens. This wallet has none, so its calls go out with no sign-in.
    tokens: () => Promise.resolve(null),
  };
  return driver;
}
