'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { cn } from '../../components/ui/cn';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { Icon } from '../../components/ui/Icon';
import { useLang, useT } from '../../i18n/I18nProvider';
import { href, METHODOLOGY, PAGES, pageOf } from './pages';
import { useWords } from './words';

// The frame of the portfolio section: a side menu beside the page, as Bearing's analytics have it
// (features/bearing/BearingShell.tsx, whose structure this follows with its own ids and its own
// storage key), and the disclaimer under the page. 220px open and a 56px rail closed, a bar with a
// drawer under 900px; the menu remembers whether it was closed, on this browser only, and stays in
// view under the app's fixed bar. It is a consumer screen, so it keeps the product's type and the
// system's page width, where Bearing's dense instrument takes the whole window.
//
// A page writes its own title: the serif is spent once a screen, and a page with goal cards spends it
// on their sentences (goal-card.md). The disclaimer is drawn here once for every page, from the one
// constant; a page that carries its own under what it shows has it once, since this one is then not
// drawn, by a rule of the stylesheet, as the app's foot does (components/shell/AppShell.tsx).

const SIDE_KEY = 'tf-portfolio-side';
const NARROW = '(max-width: 899px)';
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function PortfolioShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const current = pageOf(pathname);
  const [collapsed, setCollapsed] = useState(false);

  // On a phone the menu starts closed, as a drawer; elsewhere it opens as it was left.
  useEffect(() => {
    const narrow = window.matchMedia(NARROW).matches;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(SIDE_KEY);
    } catch {
      // the menu works without storage
    }
    setCollapsed(narrow || saved === '1');
  }, []);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(SIDE_KEY, next ? '1' : '0');
    } catch {
      // the menu works without storage
    }
  };
  const followed = () => {
    if (window.matchMedia(NARROW).matches && !collapsed) setCollapsed(true);
  };

  return (
    <div
      data-ui="portfolio"
      data-collapsed={collapsed || undefined}
      className={cn(
        'group/portfolio grid grid-cols-[minmax(0,1fr)]',
        collapsed
          ? 'min-[900px]:grid-cols-[56px_minmax(0,1fr)]'
          : 'min-[900px]:grid-cols-[220px_minmax(0,1fr)]',
      )}
    >
      <aside
        aria-label={w.shell.menu.region}
        className="z-20 border-b border-border bg-card px-4 py-2 text-body-sm min-[900px]:sticky min-[900px]:top-[calc(env(safe-area-inset-top,0px)+80px)] min-[900px]:max-h-[calc(100dvh-96px)] min-[900px]:self-start min-[900px]:overflow-auto min-[900px]:border-r min-[900px]:border-b-0 min-[900px]:px-2 min-[900px]:py-3"
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls="portfolio-nav"
          onClick={toggle}
          className={cn(
            'flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md border border-input px-2.5 py-1.5 text-left font-medium hover:border-primary min-[900px]:w-full',
            collapsed && 'min-[900px]:justify-center min-[900px]:px-0',
            FOCUS,
          )}
        >
          <Icon name="Menu" size={16} />
          <span className={cn(collapsed && 'min-[900px]:sr-only')}>
            {collapsed ? w.shell.menu.show : w.shell.menu.hide}
          </span>
        </button>
        <nav
          id="portfolio-nav"
          aria-label={w.shell.menu.nav}
          className={cn(collapsed && 'max-[899px]:hidden')}
        >
          <ul className="mt-2 grid list-none gap-0.5 p-0 min-[900px]:mt-4">
            {PAGES.map((p) => (
              <li key={p.id}>
                <Link
                  href={href(p.id)}
                  title={w[p.id].label}
                  onClick={followed}
                  aria-current={p.id === current ? 'page' : undefined}
                  className={cn(
                    'flex min-h-9 items-center gap-2.5 rounded-r-md border-l-2 border-transparent px-2.5 py-1.5 text-foreground no-underline hover:bg-muted aria-[current=page]:border-primary aria-[current=page]:bg-muted aria-[current=page]:font-semibold',
                    collapsed && 'min-[900px]:justify-center min-[900px]:px-0',
                    FOCUS,
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'w-6 shrink-0 pl-1 font-mono text-caption',
                      p.id === current ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {p.mark}
                  </span>
                  <span className={cn(collapsed && 'min-[900px]:sr-only')}>{w[p.id].label}</span>
                </Link>
              </li>
            ))}
          </ul>
          <p className={cn('mt-6 px-2.5 text-caption', collapsed && 'min-[900px]:hidden')}>
            <Link
              href={href(METHODOLOGY)}
              aria-current={current === METHODOLOGY ? 'page' : undefined}
              onClick={followed}
              className={cn(
                'inline-flex min-h-6 items-center underline decoration-1 underline-offset-[3px] hover:decoration-2',
                FOCUS,
              )}
            >
              {w.methodology.label}
            </Link>
          </p>
        </nav>
      </aside>
      <div className="min-w-0 pt-6 min-[900px]:pt-0 min-[900px]:pl-[clamp(16px,3vw,40px)]">
        <div data-ui="portfolio-page">{children}</div>
        <Disclaimer
          lang={lang}
          heading={w.shell.notAdvice}
          label={t.shell.disclaimer}
          className="mt-10 group-has-[[data-ui=portfolio-page]_[data-ui=disclaimer]]/portfolio:hidden"
        />
      </div>
    </div>
  );
}
