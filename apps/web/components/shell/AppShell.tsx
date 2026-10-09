import type { ReactNode } from 'react';
import { dictionary, type Lang } from '../../i18n';
import { Disclaimer } from '../ui/Disclaimer';
import { AppNav } from './AppNav';
import { RouterLinks } from './RouterLinks';

// The one frame of the product's routes: the bar, the page, and the foot. The bar is his compact bar,
// fixed at the top (AppNav), with the way past it for a keyboard as its first link; the page starts
// below it. The page is as wide as the system's page (1280px) with its side margins; Bearing's
// analytics, a dense instrument with a side menu and wide tables, takes the whole width. The
// disclaimer is in the foot of every product screen,
// from the one DISCLAIMER constant, at body size, in the language of the view: the foot is where it
// stands while a screen has no plan to sit under. A screen that carries its own under its plan or
// its vaults (disclaimer-block.md) has it once: the foot's is then not drawn, by a rule of the
// stylesheet, so nothing about it waits for a script.

export type AppShellProps = { lang: Lang; children: ReactNode };

export function AppShell({ lang, children }: AppShellProps) {
  const t = dictionary(lang).shell;
  return (
    <div
      data-ui="app-shell"
      className="group/shell mx-auto flex min-h-dvh w-full max-w-page flex-col px-[clamp(16px,4vw,56px)] has-[[data-ui=bearing]]:max-w-none"
    >
      <AppNav />
      <RouterLinks />
      <main
        id="content"
        tabIndex={-1}
        className="flex-1 scroll-mt-24 pt-[calc(env(safe-area-inset-top,0px)+104px)] pb-10 outline-none"
      >
        {children}
      </main>
      {/* A page on one centred column (the sign-in screen) has the foot on the same column. */}
      <footer
        data-ui="app-foot"
        className="flex flex-col gap-6 border-t border-border py-8 group-has-[main_[data-column=centred]]/shell:mx-auto group-has-[main_[data-column=centred]]/shell:w-full group-has-[main_[data-column=centred]]/shell:max-w-[860px]"
      >
        <Disclaimer
          lang={lang}
          label={t.disclaimer}
          className="group-has-[main_[data-ui=disclaimer]]/shell:hidden"
        />
      </footer>
    </div>
  );
}
