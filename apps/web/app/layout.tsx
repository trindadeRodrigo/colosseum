import { DISCLAIMER } from '@colosseum/schemas';
import type { ReactNode } from 'react';
import { Nav } from '@/components/Nav';
import { fontVariables } from './fonts';
import './globals.css';
import { Providers } from './providers';

export const metadata = {
  title: 'Colosseum — goal-based structuring',
  description: 'Policy in your wallet, not a fund.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" className={fontVariables}>
      <body className="min-h-screen bg-white text-gray-900 antialiased">
        <Providers>
          <div className="mx-auto max-w-4xl px-4">
            <Nav />
            <main className="py-6">{children}</main>
            <footer className="border-t border-gray-200 py-6 text-xs text-gray-500">
              <p>{DISCLAIMER.pt}</p>
              <p className="mt-2">{DISCLAIMER.en}</p>
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}
