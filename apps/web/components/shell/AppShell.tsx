import type { ReactNode } from 'react';
import { dictionary, type Lang, type ThemeChoice } from '../../i18n';
import { Disclaimer } from '../ui/Disclaimer';
import { AppNav } from './AppNav';
import { LanguageSwitch } from './LanguageSwitch';
import { ThemeSwitch } from './ThemeSwitch';

// The one frame of the product's routes: the bar, the page, and the foot. The page is as wide as the
// system's page (1280px) with its side margins. The disclaimer is in the foot of every product screen,
// from the one DISCLAIMER constant, at body size, in the language of the view: the foot is where it
// stands while a screen has no plan to sit under, and a screen with a plan carries it under the plan
// as well (disclaimer-block.md).

const SKIP =
  'sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-3 focus-visible:left-3 focus-visible:z-40 focus-visible:rounded-md focus-visible:bg-card focus-visible:px-3 focus-visible:py-2 focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export type AppShellProps = { lang: Lang; theme: ThemeChoice; children: ReactNode };

export function AppShell({ lang, theme, children }: AppShellProps) {
  const t = dictionary(lang).shell;
  return (
    <div
      data-ui="app-shell"
      className="mx-auto flex min-h-dvh w-full max-w-page flex-col px-[clamp(16px,4vw,56px)]"
    >
      <a href="#content" className={SKIP}>
        {t.skip}
      </a>
      <AppNav />
      <main id="content" tabIndex={-1} className="flex-1 scroll-mt-4 py-10 outline-none">
        {children}
      </main>
      <footer data-ui="app-foot" className="flex flex-col gap-6 border-t border-border py-8">
        <Disclaimer lang={lang} label={t.disclaimer} />
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <LanguageSwitch />
          <ThemeSwitch initial={theme} />
        </div>
      </footer>
    </div>
  );
}
