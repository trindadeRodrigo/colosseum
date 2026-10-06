'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { cn } from '../../components/ui/cn';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { formatAge } from '../../components/ui/format';
import { Icon } from '../../components/ui/Icon';
import { useBearing } from './BearingProvider';
import { RISK_API } from './data';
import { hhmm, iso, RW } from './format';
import { href, METHODOLOGY, PAGES } from './pages';
import { etParts, regimeAt } from './time';

// The frame of Bearing's analytics (Rodrigo's Analytics 2.0): a retractable side menu beside the page,
// 220px open and a 56px rail closed, a bar with a drawer under 900px; the head with the page's one
// line and the banner that says whether the figures are live or stale; the disclaimer under the page.
// The menu remembers whether it was closed, on this browser only.

const SIDE_KEY = 'tf-an2-side';
const NARROW = '(max-width: 899px)';
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function BearingShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const current = pathname.split('/')[2] ?? 'stocks';
  const page =
    PAGES.find((p) => p.id === current) ?? (current === METHODOLOGY.id ? METHODOLOGY : PAGES[0]);
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
      data-ui="bearing"
      data-collapsed={collapsed || undefined}
      lang="en"
      className={cn(
        'grid grid-cols-[minmax(0,1fr)] text-[0.8125rem]/5',
        collapsed
          ? 'min-[900px]:grid-cols-[56px_minmax(0,1fr)]'
          : 'min-[900px]:grid-cols-[220px_minmax(0,1fr)]',
      )}
    >
      <aside
        aria-label="Analytics pages"
        className="z-20 border-b border-border bg-card px-4 py-2 min-[900px]:sticky min-[900px]:top-4 min-[900px]:max-h-[calc(100dvh-32px)] min-[900px]:self-start min-[900px]:overflow-auto min-[900px]:border-r min-[900px]:border-b-0 min-[900px]:px-2 min-[900px]:py-3"
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls="bearing-nav"
          onClick={toggle}
          className={cn(
            'flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md border border-input px-2.5 py-1.5 text-left font-medium hover:border-primary min-[900px]:w-full',
            collapsed && 'min-[900px]:justify-center min-[900px]:px-0',
            FOCUS,
          )}
        >
          <Icon name="Menu" size={16} />
          <span className={cn(collapsed && 'min-[900px]:sr-only')}>
            {collapsed ? 'Show menu' : 'Hide menu'}
          </span>
        </button>
        <nav
          id="bearing-nav"
          aria-label="Analytics"
          className={cn(collapsed && 'max-[899px]:hidden')}
        >
          <ul className="mt-2 grid list-none gap-0.5 p-0 min-[900px]:mt-4">
            {PAGES.map((p) => (
              <li key={p.id}>
                <Link
                  href={href(p.id)}
                  title={p.label}
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
                  <span className={cn(collapsed && 'min-[900px]:sr-only')}>{p.label}</span>
                </Link>
              </li>
            ))}
          </ul>
          <p className={cn('mt-6 px-2.5 text-caption', collapsed && 'min-[900px]:hidden')}>
            <Link
              href={href(METHODOLOGY.id)}
              aria-current={current === METHODOLOGY.id ? 'page' : undefined}
              onClick={followed}
              className={cn(
                'underline decoration-1 underline-offset-[3px] hover:decoration-2',
                FOCUS,
              )}
            >
              {METHODOLOGY.label}
            </Link>
          </p>
        </nav>
      </aside>
      <div className="min-w-0 px-0 pt-2 min-[900px]:px-[clamp(16px,3vw,40px)] min-[900px]:pt-4">
        <div>
          <div className="font-condensed text-b-head font-medium text-muted-foreground">
            Bearing · analytics
          </div>
          <h1 className="mt-2 mb-4 max-w-[34ch] font-display text-[clamp(1.75rem,1.3rem+1.4vw,2.5rem)]/[1.15] font-normal tracking-[-0.015em]">
            {page.lede}
          </h1>
          <Banner />
        </div>
        {children}
        <Disclaimer lang="en" heading="Not advice" className="mt-8" />
      </div>
    </div>
  );
}

/** Live or stale, said once for the whole page; or that the API did not answer. */
export function Banner() {
  const { mode, newest, clock } = useBearing();
  const box =
    'mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 border border-l-2 border-border border-l-primary px-3 py-2';
  if (mode === 'loading')
    return (
      <div role="status" data-ui="bearing-banner" data-mode={mode} className={box}>
        <span className="text-muted-foreground">Reading the risk API…</span>
      </div>
    );
  const now = new Date(clock.now);
  return (
    <div role="status" data-ui="bearing-banner" data-mode={mode} className={box}>
      {mode === 'live' && (
        <>
          <b className="font-semibold">
            Live from the collectors, as of {newest ? hhmm(newest) : 'an unknown time'}.
          </b>
          <span className="font-mono text-b-meta text-muted-foreground">
            now: {RW[regimeAt(now)]} ({etParts(now).label})
          </span>
        </>
      )}
      {mode === 'stale' && (
        <>
          <b className="font-semibold">
            {newest
              ? `The collectors’ newest reading is from ${iso(newest).replace('T', ' ').replace('Z', ' UTC')}, ${
                  formatAge((clock.now - Date.parse(newest)) / 1000)?.long ?? 'of an unknown age'
                }.`
              : 'The collectors have no reading yet.'}
          </b>
          <span>Every figure is stale: measured, only old. Its age is beside it.</span>
        </>
      )}
      {mode === 'none' && (
        <>
          <b className="font-semibold">The risk API at {RISK_API} did not answer.</b>
          <span>Every figure on this page waits for it; none is made up in its place.</span>
        </>
      )}
    </div>
  );
}
