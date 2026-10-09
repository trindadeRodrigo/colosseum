'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '../../components/ui/cn';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { useLang, useT } from '../../i18n/I18nProvider';
import { href, METHODOLOGY, PAGES, pageOf } from './pages';
import { useWords } from './words';

// The frame of the portfolio section: a row of tabs over the page, as a portfolio board has them
// (Rodrigo, Oct 8: no side menu), and the disclaimer under the page. The tabs scroll sideways on a
// phone rather than wrap. The disclaimer is drawn here once for every page, from the one constant; a
// page that carries its own under what it shows has it once, since this one is then not drawn, by a
// rule of the stylesheet, as the app's foot does (components/shell/AppShell.tsx).

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function PortfolioShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const current = pageOf(pathname);
  const tabs = [
    ...PAGES.map((p) => ({ id: p.id, href: href(p.id), label: w[p.id].label })),
    { id: METHODOLOGY, href: href(METHODOLOGY), label: w.methodology.label },
  ];

  return (
    <div data-ui="portfolio" className="group/portfolio flex min-w-0 flex-col gap-6">
      <nav id="portfolio-nav" aria-label={w.shell.menu.nav} className="min-w-0 overflow-x-auto">
        <ul className="flex w-max min-w-full list-none gap-6 border-b border-border p-0">
          {tabs.map((tab) => (
            <li key={tab.id}>
              <Link
                href={tab.href}
                aria-current={tab.id === current ? 'page' : undefined}
                className={cn(
                  'relative inline-flex min-h-11 items-center text-body font-medium whitespace-nowrap text-muted-foreground no-underline hover:text-foreground',
                  'aria-[current=page]:text-foreground aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-0 aria-[current=page]:after:-bottom-px aria-[current=page]:after:h-0.5 aria-[current=page]:after:bg-primary',
                  FOCUS,
                )}
              >
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div data-ui="portfolio-page" className="min-w-0">
        {children}
      </div>
      <Disclaimer
        lang={lang}
        heading={w.shell.notAdvice}
        label={t.shell.disclaimer}
        className="group-has-[[data-ui=portfolio-page]_[data-ui=disclaimer]]/portfolio:hidden"
      />
    </div>
  );
}
