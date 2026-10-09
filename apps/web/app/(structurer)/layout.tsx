import { DISCLAIMER } from '@colosseum/schemas';
import type { ReactNode } from 'react';
import { Nav } from '@/components/Nav';
import { plexMono } from '../fonts-mono';
import '../globals.css';
import { Providers } from './providers';

// The one page written before the design system: the first engine's plan view (/plans/[id]). It keeps
// the plain shell it had, with the disclaimer as footer text, until it is rebuilt on the primitives
// (WEB-2). An address no route has is answered in the product's shell (app/(app)/not-found.tsx). `tf-system-faces` keeps
// the system's own typefaces for them; the mono face is the one they already had.

export const metadata = {
  title: 'Plan · tenonfi',
  description: 'A plan from the first version of the engine, as it was stored.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${plexMono.variable} tf-system-faces`}>
      <body className="min-h-screen bg-white text-gray-900 antialiased">
        <Providers>
          <div className="mx-auto max-w-4xl px-4">
            <Nav />
            <main className="py-6">{children}</main>
            <footer className="border-t border-gray-200 py-6 text-xs text-gray-500">
              <p>{DISCLAIMER.en}</p>
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}
