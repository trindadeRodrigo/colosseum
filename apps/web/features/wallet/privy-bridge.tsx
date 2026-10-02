'use client';
import type { Chain } from '@colosseum/schemas';
import {
  getIdentityToken,
  type PrivyClientConfig,
  PrivyProvider,
  useExportWallet,
  useLogin,
  usePrivy,
  useSignMessage,
  useSignTransaction,
  useWallets,
} from '@privy-io/react-auth';
import {
  toSolanaWalletConnectors,
  useExportWallet as useExportSolanaWallet,
  useSignMessage as useSignSolanaMessage,
  useSignTransaction as useSignSolanaTransaction,
  useWallets as useSolanaWallets,
} from '@privy-io/react-auth/solana';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import { useEffect, useMemo, useRef } from 'react';
import { stringToHex } from 'viem';
import { evmChainsForProvider, publicWalletEnv, type WalletChains, walletChains } from './chains';
import type { DriverAccount, WalletDriver } from './driver';
import { fail, toWalletError } from './errors';
import { createWalletPort, idleDriver } from './port';
import { useApiCheck } from './use-api-check';
import type { BridgeProps } from './WalletProvider';

// Privy, and the only file that knows it. Everything else in the app sees a WalletPort.
// Loaded in the browser only (WalletProvider imports it with ssr: false).

const SOLANA_RPC = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
} as const;

function privyConfig(chains: WalletChains): PrivyClientConfig {
  const rpc = (url: string) => ({
    rpc: createSolanaRpc(url),
    rpcSubscriptions: createSolanaRpcSubscriptions(url.replace(/^http/, 'ws')),
  });
  return {
    loginMethods: ['passkey', 'wallet'],
    appearance: {
      theme: 'light',
      // STYLE.md: the primary is hardwood, and no blue or violet anywhere. Privy's default accent is violet.
      accentColor: '#7A5A3A',
      landingHeader: 'Sign in',
      walletChainType: 'ethereum-and-solana',
      // The only other login method is the passkey, and Privy insists on this when there is no email
      // or social login.
      showWalletLoginFirst: true,
      // Wallets found in the browser first, then the two the design names, then any other by QR code.
      walletList: [
        'detected_solana_wallets',
        'detected_ethereum_wallets',
        'phantom',
        'metamask',
        'wallet_connect',
      ],
    },
    embeddedWallets: {
      ethereum: { createOnLogin: 'users-without-wallets' },
      solana: { createOnLogin: 'users-without-wallets' },
      // Our own review screen shows what is signed (DESIGN-VAULT section 9); Privy's stays hidden.
      showWalletUIs: false,
    },
    ...evmChainsForProvider(chains),
    externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
    solana: {
      rpcs: { 'solana:mainnet': rpc(SOLANA_RPC.mainnet), 'solana:devnet': rpc(SOLANA_RPC.devnet) },
    },
  };
}

/** Sign-in cannot work: the port says why, and stays signed out. */
function Unconfigured({ onPort, problem }: BridgeProps & { problem: string }) {
  useEffect(() => {
    onPort(createWalletPort(idleDriver(), walletChains(), problem));
  }, [onPort, problem]);
  return null;
}

export default function PrivyBridge({ onPort }: BridgeProps) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const setup = useMemo((): { chains: WalletChains; config: PrivyClientConfig } | string => {
    try {
      const chains = walletChains(publicWalletEnv());
      return { chains, config: privyConfig(chains) };
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, []);
  const check = useApiCheck(typeof setup === 'string' ? null : setup.chains);
  if (!appId) return <Unconfigured onPort={onPort} problem="NEXT_PUBLIC_PRIVY_APP_ID is not set" />;
  if (typeof setup === 'string') return <Unconfigured onPort={onPort} problem={setup} />;
  // Privy is not mounted until the API says it is on the same networks as this app.
  if (check === null) return null;
  if (!check.ok) return <Unconfigured onPort={onPort} problem={check.problem} />;
  return (
    <PrivyProvider appId={appId} config={setup.config}>
      <PrivyDriver onPort={onPort} chains={setup.chains} />
    </PrivyProvider>
  );
}

const isEmbedded = (clientType: string | undefined) =>
  clientType === 'privy' || clientType === 'privy-v2';
const sameAddress = (family: Chain, a: string, b: string) =>
  family === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;
const one = <T,>(out: T | T[]): T[] => (Array.isArray(out) ? out : [out]);

function PrivyDriver({ onPort, chains }: BridgeProps & { chains: WalletChains }) {
  const privy = usePrivy();
  const evm = useWallets();
  const solana = useSolanaWallets();
  const { signTransaction } = useSignTransaction();
  const { signMessage } = useSignMessage();
  const { exportWallet } = useExportWallet();
  const { signTransaction: signSolanaTransaction } = useSignSolanaTransaction();
  const { signMessage: signSolanaMessage } = useSignSolanaMessage();
  const { exportWallet: exportSolanaWallet } = useExportSolanaWallet();

  // signIn() resolves when Privy says the login finished, embedded wallets included.
  const pending = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);
  const { login } = useLogin({
    onComplete: () => {
      pending.current?.resolve();
      pending.current = null;
    },
    onError: (code) => {
      pending.current?.reject(
        toWalletError({ privyErrorCode: code, message: `sign-in failed: ${code}` }),
      );
      pending.current = null;
    },
  });

  // The accounts are the person's linked wallets that are connected in this browser, in Privy's order
  // (the most recently connected first). A wallet that is connected but not linked is left out: the
  // API reads wallets from the identity token and would not know it.
  const linked = privy.user?.linkedAccounts ?? [];
  const accounts: DriverAccount[] = [];
  for (const [family, chainType, addresses] of [
    ['evm', 'ethereum', evm.wallets.map((w) => w.address)],
    ['solana', 'solana', solana.wallets.map((w) => w.address)],
  ] as const) {
    for (const address of addresses) {
      const link = linked.find(
        (a) =>
          a.type === 'wallet' &&
          a.chainType === chainType &&
          sameAddress(family, a.address, address),
      );
      if (link?.type === 'wallet')
        accounts.push({
          family,
          address,
          kind: isEmbedded(link.walletClientType) ? 'embedded' : 'external',
        });
    }
  }

  const status: WalletDriver['status'] = !privy.ready
    ? 'loading'
    : !privy.authenticated
      ? 'signed-out'
      : evm.ready && solana.ready
        ? 'ready'
        : 'loading';
  const userId = privy.user?.id ?? null;

  // Privy's functions change identity between renders. The driver reads them through this ref, so the
  // port is rebuilt only when what it reports (status, user, accounts) changes.
  const live = {
    privy,
    evm: evm.wallets,
    solana: solana.wallets,
    login,
    signTransaction,
    signMessage,
    exportWallet,
    signSolanaTransaction,
    signSolanaMessage,
    exportSolanaWallet,
  };
  const ref = useRef(live);
  ref.current = live;

  const shape = JSON.stringify({ status, userId, accounts });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shape` stands for status, userId and accounts
  const port = useMemo(() => {
    const evmWallet = (address: string) => {
      const wallet = ref.current.evm.find((w) => sameAddress('evm', w.address, address));
      if (!wallet) throw fail('not_connected', 'that wallet is no longer connected');
      return wallet;
    };
    const solanaWallet = (address: string) => {
      const wallet = ref.current.solana.find((w) => w.address === address);
      if (!wallet) throw fail('not_connected', 'that wallet is no longer connected');
      return wallet;
    };
    const quiet = { uiOptions: { showWalletUIs: false } };

    const driver: WalletDriver = {
      test: false,
      status,
      userId,
      accounts,

      signIn(method) {
        if (ref.current.privy.authenticated) return Promise.resolve();
        // Before Privy is ready its login() does nothing, and the promise would never settle.
        if (!ref.current.privy.ready)
          return Promise.reject(fail('not_connected', 'the wallet is still loading'));
        return new Promise<void>((resolve, reject) => {
          pending.current?.reject(fail('unsupported', 'a newer sign-in replaced this one'));
          pending.current = { resolve, reject };
          ref.current.login({ loginMethods: [method], walletChainType: 'ethereum-and-solana' });
        });
      },
      signOut: () => ref.current.privy.logout(),

      async signSolana(address, transactions, cluster) {
        const wallet = solanaWallet(address);
        const out = await ref.current.signSolanaTransaction(
          ...transactions.map((transaction) => ({ transaction, wallet, chain: cluster })),
        );
        return one(out).map((o) => o.signedTransaction);
      },
      async signSolanaMessage(address, message) {
        const out = await ref.current.signSolanaMessage({
          message,
          wallet: solanaWallet(address),
        });
        return out.signature;
      },

      async signEvm(address, request) {
        const out = await ref.current.signTransaction(request, { address, ...quiet });
        return out.signature;
      },
      async sendEvm(address, request) {
        const wallet = evmWallet(address);
        const provider = await wallet.getEthereumProvider();
        const onChain = async () => Number(await provider.request({ method: 'eth_chainId' }));
        if ((await onChain()) !== request.chainId) {
          // The person may refuse to switch, or the wallet may not know the chain: both leave it on
          // the wrong one.
          await wallet.switchChain(request.chainId).catch(() => {});
          if ((await onChain()) !== request.chainId)
            throw toWalletError({
              code: 4902,
              message: `the wallet is not on chain ${request.chainId}`,
            });
        }
        return provider.request({
          method: 'eth_sendTransaction',
          params: [
            {
              from: wallet.address,
              to: request.to,
              data: request.data,
              value: `0x${request.value.toString(16)}`,
              // Named again in the call itself: a wallet that changed chain since the check refuses.
              chainId: `0x${request.chainId.toString(16)}`,
            },
          ],
        });
      },
      async signEvmMessage(address, message) {
        const wallet = evmWallet(address);
        if (isEmbedded(wallet.walletClientType)) {
          const out = await ref.current.signMessage({ message }, { address, ...quiet });
          return out.signature as `0x${string}`;
        }
        const provider = await wallet.getEthereumProvider();
        return provider.request({
          method: 'personal_sign',
          params: [stringToHex(message), wallet.address],
        });
      },

      exportKey: (family, address) =>
        family === 'evm'
          ? ref.current.exportWallet({ address })
          : ref.current.exportSolanaWallet({ address }),

      async tokens() {
        const access = await ref.current.privy.getAccessToken();
        // The identity token lists the linked wallets. It exists once it is switched on in the Privy
        // dashboard; until then the API gets the access token alone.
        const identity = access ? await getIdentityToken().catch(() => null) : null;
        return { access, identity };
      },
    };
    return createWalletPort(driver, chains);
  }, [shape, chains]);

  useEffect(() => onPort(port), [onPort, port]);
  return null;
}
