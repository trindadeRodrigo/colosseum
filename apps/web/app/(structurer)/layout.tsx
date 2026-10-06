import { DISCLAIMER } from '@colosseum/schemas';
import type { ReactNode } from 'react';
import { Nav } from '@/components/Nav';
import { plexMono } from '../fonts-mono';
import '../globals.css';
import { Providers } from './providers';

// The pages written before the design system: the plan view, the partner embed and
// the /risk pages. They keep the shell they had (the top bar with the wallet-adapter button, the
// disclaimer as footer text) until each is rebuilt on the primitives (WEB-2). `tf-system-faces` keeps
// the system's own typefaces for them; the mono face is the one they already had.

export const metadata = {
  title: 'Colosseum — goal-based structuring',
  description: 'Policy in your wallet, not a fund.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" className={`${plexMono.variable} tf-system-faces`}>
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
