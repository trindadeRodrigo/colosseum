'use client';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { type ReactNode, useMemo } from 'react';
import '@solana/wallet-adapter-react-ui/styles.css';
import { WalletProvider as SignInProvider } from '@/features/wallet/WalletProvider';

/** Wallet connect is the only auth (HANDOFF §4.4). Phantom and other Wallet-Standard wallets are auto-detected; no legacy adapters bundled. */
export function Providers({ children }: { children: ReactNode }) {
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <SignInProvider>{children}</SignInProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
