import type { ReactNode } from 'react';
import { AppShell } from '../../../components/shell/AppShell';
import type { Lang, ThemeChoice } from '../../../i18n';
import { I18nProvider } from '../../../i18n/I18nProvider';
import { AccountProvider } from '../AccountProvider';

// What a screen sits in, for its tests: the language of the view, and the signed-in person. The wallet
// under them is the test's own (features/wallet/test/mock-provider.ts). The JSX is here because test
// files are plain .ts.

export const inLanguage = (lang: Lang, children: ReactNode) => (
  <I18nProvider lang={lang}>{children}</I18nProvider>
);

export const withAccount = (lang: Lang, children: ReactNode) =>
  inLanguage(lang, <AccountProvider>{children}</AccountProvider>);

/** The whole shell around a page. */
export const inShell = (lang: Lang, theme: ThemeChoice, page: ReactNode) =>
  withAccount(
    lang,
    <AppShell lang={lang} theme={theme}>
      {page}
    </AppShell>,
  );
