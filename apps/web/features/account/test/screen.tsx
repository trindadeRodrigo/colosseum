import type { ReactNode } from 'react';
import { AppShell } from '../../../components/shell/AppShell';
import type { Lang, ThemeChoice } from '../../../i18n';
import { I18nProvider } from '../../../i18n/I18nProvider';
import { AccountProvider } from '../AccountProvider';
import { SignInDialogProvider } from '../SignInDialog';

// What a screen sits in, for its tests: the language of the view, and the signed-in person. The wallet
// under them is the test's own (features/wallet/test/mock-provider.ts). The JSX is here because test
// files are plain .ts.

export const inLanguage = (lang: Lang, children: ReactNode) => (
  <I18nProvider lang={lang}>{children}</I18nProvider>
);

export const withAccount = (lang: Lang, children: ReactNode) =>
  inLanguage(lang, <AccountProvider>{children}</AccountProvider>);

/** The whole shell around a page. */
/** `_theme` is the server's word; the shell draws no choice of its own now (the toggle reads the page). */
export const inShell = (lang: Lang, _theme: ThemeChoice, page: ReactNode) =>
  withAccount(lang, <AppShell lang={lang}>{page}</AppShell>);

/** The shell with the sign-in dialog, as the product mounts it (components/shell/AppDocument.tsx). */
export const inShellWithSignIn = (lang: Lang, _theme: ThemeChoice, page: ReactNode) =>
  withAccount(
    lang,
    <SignInDialogProvider>
      <AppShell lang={lang}>{page}</AppShell>
    </SignInDialogProvider>,
  );
