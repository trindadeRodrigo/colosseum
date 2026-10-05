'use client';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import Link from 'next/link';

export function Nav() {
  return (
    <header className="flex items-center justify-between border-b border-gray-200 py-3">
      <nav className="flex gap-5 text-sm">
        <Link href="/" className="font-semibold">
          Structurer
        </Link>
        <Link href="/monitor">Monitor</Link>
        <Link href="/risk">Liquidity</Link>
        <a
          href={`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/docs`}
          target="_blank"
          rel="noreferrer"
        >
          API docs
        </a>
      </nav>
      <WalletMultiButton />
    </header>
  );
}
