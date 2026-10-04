import type { ReactNode } from 'react';
import { fontVariables } from '../../app/fonts';
import '../../app/globals.css';
import { AccountProvider } from '../../features/account/AccountProvider';
import { WalletProvider } from '../../features/wallet/WalletProvider';
import { LOCALE, THEME_CLASS } from '../../i18n';
import { I18nProvider } from '../../i18n/I18nProvider';
import { readPreferences } from '../../i18n/server';
import { AppShell } from './AppShell';

// The whole document of a product route: `tf-app` on <body>, the three faces, the language and the
// theme, the wallet, the shell. The language and the theme are read from the request, so the first
// paint is already in both; with no theme chosen the stylesheet follows the system (`tf-auto`).
// No wallet adapter is mounted here: a person signs in through the wallet port (features/wallet).
//
// Two root layouts use it: the product's (app/(app)/layout.tsx) and, under the development server
// only, the one of the pages under /dev.

export async function AppDocument({ children }: { children: ReactNode }) {
  const { lang, theme } = await readPreferences();
  return (
    <html lang={LOCALE[lang]} className={`${fontVariables} ${THEME_CLASS[theme]}`}>
      <body className="tf-app">
        <I18nProvider lang={lang}>
          <WalletProvider>
            <AccountProvider>
              <AppShell lang={lang} theme={theme}>
                {children}
              </AppShell>
            </AccountProvider>
          </WalletProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
