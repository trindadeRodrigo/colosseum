'use client';
import type { Chain, ChainStatus } from '@colosseum/schemas';
import {
  getIdentityToken,
  type PrivyClientConfig,
  PrivyProvider,
  useCreateWallet,
  useExportWallet,
  useLoginWithPasskey,
  useLoginWithSiwe,
  useLoginWithSiws,
  usePrivy,
  useSignMessage,
  useSignTransaction,
  useSignupWithPasskey,
  useWallets,
} from '@privy-io/react-auth';
import {
  toSolanaWalletConnectors,
  useCreateWallet as useCreateSolanaWallet,
  useExportWallet as useExportSolanaWallet,
  useSignMessage as useSignSolanaMessage,
  useSignTransaction as useSignSolanaTransaction,
  useWallets as useSolanaWallets,
  useStandardWallets,
} from '@privy-io/react-auth/solana';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import { useEffect, useMemo, useRef, useState } from 'react';
import { stringToHex } from 'viem';
import { evmChainsForProvider, publicWalletEnv, type WalletChains, walletChains } from './chains';
import type { DriverAccount, WalletDriver } from './driver';
import { fail, toWalletError } from './errors';
import {
  type AnnouncedWallet,
  evmWalletId,
  foundWallets,
  solanaWalletId,
  watchEvmWallets,
} from './found-wallets';
import { createWalletPort, idleDriver, type ProblemKind } from './port';
import {
  canSignIn,
  isEmbedded,
  missingWallets,
  type StandardSolanaWallet,
  signInWithEvmWallet,
  signInWithSolanaWallet,
} from './sign-in-flows';
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
    // Sign-in is our own screen (app/(app)/sign-in), on Privy's hooks that open no window of Privy's.
    // What is left of its appearance is the one window it still owns: the export of a key.
    appearance: {
      theme: 'light',
      // STYLE.md: the primary is hardwood, and no blue or violet anywhere. Privy's default accent is violet.
      accentColor: '#7A5A3A',
      walletChainType: 'ethereum-and-solana',
      // Which outside wallets Privy keeps a connector for: those found in the browser, of both families.
      walletList: ['detected_solana_wallets', 'detected_ethereum_wallets', 'phantom', 'metamask'],
    },
    embeddedWallets: {
      // Privy makes no wallet by itself after a sign-in through its hooks: the driver below makes one
      // of each family for a person who signed in with a passkey (missingWallets).
      ethereum: { createOnLogin: 'off' },
      solana: { createOnLogin: 'off' },
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
function Unconfigured({
  onPort,
  problem,
  kind,
}: BridgeProps & { problem: string; kind: ProblemKind }) {
  useEffect(() => {
    onPort(createWalletPort(idleDriver(), walletChains(), problem, { problemKind: kind }));
  }, [onPort, problem, kind]);
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
  if (!appId)
    return (
      <Unconfigured onPort={onPort} problem="NEXT_PUBLIC_PRIVY_APP_ID is not set" kind="setup" />
    );
  if (typeof setup === 'string')
    return <Unconfigured onPort={onPort} problem={setup} kind="setup" />;
  // Privy is not mounted until the API says it is on the same networks as this app.
  if (check === null) return null;
  if (!check.ok)
    return (
      <Unconfigured onPort={onPort} problem={check.problem} kind={check.again ? 'api' : 'setup'} />
    );
  return (
    <PrivyProvider appId={appId} config={setup.config}>
      <PrivyDriver onPort={onPort} chains={setup.chains} api={check.chains} />
    </PrivyProvider>
  );
}

const sameAddress = (family: Chain, a: string, b: string) =>
  family === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;
const one = <T,>(out: T | T[]): T[] => (Array.isArray(out) ? out : [out]);

/** Privy says a wallet of that family is there already: nothing is left to make. */
const alreadyThere = (e: unknown) =>
  (e as { privyErrorCode?: unknown } | null)?.privyErrorCode === 'embedded_wallet_already_exists';

type Waiter = { resolve: () => void; reject: (e: unknown) => void };

function PrivyDriver({
  onPort,
  chains,
  api,
}: BridgeProps & { chains: WalletChains; api: readonly ChainStatus[] }) {
  const privy = usePrivy();
  const evm = useWallets();
  const solana = useSolanaWallets();
  const standard = useStandardWallets();
  const { signTransaction } = useSignTransaction();
  const { signMessage } = useSignMessage();
  const { exportWallet } = useExportWallet();
  const { signTransaction: signSolanaTransaction } = useSignSolanaTransaction();
  const { signMessage: signSolanaMessage } = useSignSolanaMessage();
  const { exportWallet: exportSolanaWallet } = useExportSolanaWallet();
  // Sign-in with no window of Privy's. Using a passkey and creating one are two calls.
  const { loginWithPasskey } = useLoginWithPasskey();
  const { signupWithPasskey } = useSignupWithPasskey();
  const { generateSiweMessage, loginWithSiwe } = useLoginWithSiwe();
  const { generateSiwsMessage, loginWithSiws } = useLoginWithSiws();
  const { createWallet } = useCreateWallet();
  const { createWallet: createSolanaWallet } = useCreateSolanaWallet();

  // The outside wallets in this browser: EVM wallets announce themselves, Solana wallets are in the
  // wallet standard's registry, which Privy's hook reads. Privy's own embedded wallet is not one.
  const [announced, setAnnounced] = useState<AnnouncedWallet[]>([]);
  useEffect(() => watchEvmWallets(window, setAnnounced), []);
  const outside = (
    standard.wallets as readonly (StandardSolanaWallet & { isPrivyWallet?: boolean })[]
  ).filter((wallet) => !wallet.isPrivyWallet && canSignIn(wallet));
  const found = foundWallets(outside, announced);

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

  const userId = privy.user?.id ?? null;
  // The wallets a passkey sign-in owes the person and Privy has not made. While they are being made
  // the port is still loading; if making them fails it is ready without them, and says so when asked.
  const owed = privy.ready && privy.authenticated ? missingWallets(linked).join(',') : '';
  const [attempt, setAttempt] = useState(0);
  const [failedAt, setFailedAt] = useState<string | null>(null);
  const makingKey = owed && userId ? `${userId}:${owed}:${attempt}` : null;
  const started = useRef<string | null>(null);
  const waiting = useRef<Waiter[]>([]);

  const status: WalletDriver['status'] = !privy.ready
    ? 'loading'
    : !privy.authenticated
      ? 'signed-out'
      : evm.ready && solana.ready && (makingKey === null || failedAt === makingKey)
        ? 'ready'
        : 'loading';

  // Privy's functions change identity between renders. The driver reads them through this ref, so the
  // port is rebuilt only when what it reports (status, user, accounts) changes.
  const live = {
    privy,
    evm: evm.wallets,
    solana: solana.wallets,
    announced,
    outside,
    owed,
    failed: makingKey !== null && failedAt === makingKey,
    loginWithPasskey,
    signupWithPasskey,
    generateSiweMessage,
    loginWithSiwe,
    generateSiwsMessage,
    loginWithSiws,
    createWallet,
    createSolanaWallet,
    signTransaction,
    signMessage,
    exportWallet,
    signSolanaTransaction,
    signSolanaMessage,
    exportSolanaWallet,
  };
  const ref = useRef(live);
  ref.current = live;

  // Makes the owed wallets once per person and attempt. An effect, so it runs with Privy's functions
  // as they are after the sign-in (the ones a sign-in call holds are from before it). Strict mode runs
  // an effect twice: `started` keeps the second run from making a second wallet.
  useEffect(() => {
    if (makingKey === null) {
      for (const waiter of waiting.current.splice(0)) waiter.resolve();
      return;
    }
    if (started.current === makingKey) return;
    started.current = makingKey;
    (async () => {
      try {
        for (const family of ref.current.owed.split(',')) {
          const make = family === 'evm' ? ref.current.createWallet : ref.current.createSolanaWallet;
          await make().catch((e: unknown) => {
            if (!alreadyThere(e)) throw e;
          });
        }
        // Privy now lists the new wallets, `owed` empties, and this effect runs again to say so.
      } catch (e) {
        const text = e instanceof Error ? e.message : 'no reason given';
        setFailedAt(makingKey);
        for (const waiter of waiting.current.splice(0))
          waiter.reject(fail('wallet_not_made', `the wallet could not be made: ${text}`));
      }
    })();
  }, [makingKey]);

  const shape = JSON.stringify({ status, userId, accounts, found });
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
      found,

      async signIn(method, choice) {
        const now = ref.current;
        if (now.privy.authenticated) return;
        if (!now.privy.ready) throw fail('not_connected', 'the wallet is still loading');
        if (method === 'passkey') {
          // Two calls: a person with no passkey for this site yet has to be able to make one.
          await (choice?.create ? now.signupWithPasskey() : now.loginWithPasskey());
          return;
        }
        const evmWallet = now.announced.find((w) => evmWalletId(w.rdns) === choice?.wallet);
        if (evmWallet)
          return signInWithEvmWallet(evmWallet, {
            generate: now.generateSiweMessage,
            login: now.loginWithSiwe,
          });
        const solanaWallet = now.outside.find((w) => solanaWalletId(w.name) === choice?.wallet);
        if (solanaWallet)
          return signInWithSolanaWallet(solanaWallet, {
            generate: now.generateSiwsMessage,
            login: now.loginWithSiws,
          });
        throw fail('wallet_gone', 'that wallet is not in this browser');
      },
      signOut: () => ref.current.privy.logout(),
      ensureWallets() {
        if (!ref.current.owed) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          waiting.current.push({ resolve, reject });
          // After a failure, a new attempt: the effect above runs again for it. While the first one
          // is still running, this call waits for it.
          if (ref.current.failed) {
            setFailedAt(null);
            setAttempt((n) => n + 1);
          }
        });
      },

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
    return createWalletPort(driver, chains, null, { api });
  }, [shape, chains, api]);

  useEffect(() => onPort(port), [onPort, port]);
  return null;
}
