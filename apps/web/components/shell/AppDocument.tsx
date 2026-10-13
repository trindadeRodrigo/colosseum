import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { fontVariables } from '../../app/fonts';
import '../../app/globals.css';
import { AccountProvider } from '../../features/account/AccountProvider';
import { SignInDialogProvider } from '../../features/account/SignInDialog';
import { WalletProvider } from '../../features/wallet/WalletProvider';
import { LOCALE, SIGNED_IN_COOKIE, THEME_CLASS } from '../../i18n';
import { I18nProvider } from '../../i18n/I18nProvider';
import { readPreferences } from '../../i18n/server';
import { AppShell } from './AppShell';

// The whole document of a product route: `tf-app` on <body>, the three faces, the language and the
// theme, the wallet, the shell. The language and the theme are read from the request, so the first
// paint is already in both; with no theme chosen the stylesheet follows the system (`tf-auto`).
// No wallet adapter is mounted here: a person signs in through the wallet port (features/wallet).
//
// The product's layout is this (app/(app)/layout.tsx). The development pages (app/(app)/dev) sit
// under it too, so the showcase and the wallet check are seen on the same ground, in the same faces,
// as the screens they are for.

export async function AppDocument({ children }: { children: ReactNode }) {
  const { lang, theme } = await readPreferences();
  // The signed-in hint, so the bar's account control is drawn in the shape of what comes from the
  // first paint: the chip's placeholder for a person signed in here, the button's for a visitor.
  const hinted = (await cookies()).get(SIGNED_IN_COOKIE)?.value === '1';
  return (
    <html lang={LOCALE[lang]} className={`${fontVariables} ${THEME_CLASS[theme]}`}>
      <body className="tf-app">
        <I18nProvider lang={lang}>
          <WalletProvider>
            <AccountProvider hinted={hinted}>
              {/* Every link to /sign-in in the product opens the sign-in dialog over the page. */}
              <SignInDialogProvider>
                <AppShell lang={lang}>{children}</AppShell>
              </SignInDialogProvider>
            </AccountProvider>
          </WalletProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
