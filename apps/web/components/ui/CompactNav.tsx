'use client';
import {
  type AnchorHTMLAttributes,
  type ComponentType,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Button } from './Button';
import { buttonClass } from './button-class';
import { cn } from './cn';
import { Icon } from './Icon';
import { COMPACT_NAV_LABELS, type CompactNavLabels } from './labels';

// compact-nav.md. The landing header: a quiet full-width bar (the mark and the wordmark, nothing else)
// that, from the third step of the hero onward, compacts into a centred bar with the menu and the one
// call to action. Solid, with a hairline: no glass and no blur. The product's own screens use the
// plain bar of STYLE.md, not this.
//
// The mark and the wordmark are handed in: there is no final logo artwork yet (DES-1).

export type NavLink = {
  label: string;
  href: string;
  /** The section in view. */
  current?: boolean;
};

export type { CompactNavLabels } from './labels';

export type CompactNavProps = {
  /** The symbol, 24px. It takes the brand wood of the ground it is on. */
  symbol: ReactNode;
  /** The wordmark, always lowercase. It is a logo, not the screen's serif line. */
  wordmark: string;
  /** The name of the link home: "tenonfi home". */
  homeLabel: string;
  homeHref?: string;
  links: readonly NavLink[];
  /**
   * The one call to action in the bar. A signed-in visitor gets "Open app"; the bar never shows a
   * balance.
   */
  cta?: { label: string; href: string };
  /**
   * In place of `cta`, where the action is more than a link: the product's wallet ("Sign in", then
   * the short address and "Sign out"). Still one action in the bar.
   */
  action?: ReactNode;
  /** At the top of the phone's sheet: what the bar has no room for there (the wallet's address). */
  sheetHead?: ReactNode;
  /** Where "Skip to content" goes: the id of the main content. */
  contentId: string;
  /**
   * The ids of the hero's steps that drive the bar: it compacts when `compactAt` (step 03) comes into
   * view and opens again only above `releaseAbove` (step 02). Left out, the bar is compact at once:
   * a page with no stage, or a stage in its still form.
   */
  stage?: { compactAt: string; releaseAbove: string };
  /**
   * What draws a link: a plain anchor by default, or the router's link (`next/link`) where the bar
   * leads between pages of one app, so a page change keeps what the app holds in memory.
   */
  linkAs?: ComponentType<
    AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; ref?: Ref<HTMLAnchorElement> }
  >;
  /** Sets the state from outside and switches the observer off. */
  compact?: boolean;
  labels?: Partial<CompactNavLabels>;
  className?: string;
};

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const LINK = cn(
  'rounded-md px-3 py-2 text-[0.875rem]/5 font-medium whitespace-nowrap text-foreground transition-colors hover:bg-accent',
  'aria-[current=true]:underline aria-[current=true]:decoration-primary aria-[current=true]:decoration-2 aria-[current=true]:underline-offset-[6px]',
  FOCUS,
);

export function CompactNav({
  symbol,
  wordmark,
  homeLabel,
  homeHref = '/',
  links,
  cta,
  action,
  sheetHead,
  contentId,
  stage,
  compact: controlled,
  linkAs: A = 'a' as unknown as NonNullable<CompactNavProps['linkAs']>,
  labels,
  className,
}: CompactNavProps) {
  const text = { ...COMPACT_NAV_LABELS, ...labels };
  const [seen, setSeen] = useState(stage === undefined);
  const [open, setOpen] = useState(false);
  const sheet = useId();
  const header = useRef<HTMLElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const firstLink = useRef<HTMLAnchorElement>(null);
  const compact = controlled ?? seen;
  const compactAt = stage?.compactAt;
  const releaseAbove = stage?.releaseAbove;

  useEffect(() => {
    if (controlled !== undefined || compactAt === undefined || releaseAbove === undefined) return;
    const step = document.getElementById(compactAt);
    const before = document.getElementById(releaseAbove);
    if (!step || !before || typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    // The line sits 60% of the way down the viewport. The bar compacts once the top of step 03 is
    // above it, and opens again only when the top of step 02 is back below it.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const line = entry.rootBounds?.bottom ?? window.innerHeight * 0.6;
          const above = entry.boundingClientRect.top < line;
          if (entry.target === step && above) setSeen(true);
          if (entry.target === before && !above) setSeen(false);
        }
      },
      { rootMargin: '0px 0px -40% 0px' },
    );
    observer.observe(step);
    observer.observe(before);
    return () => observer.disconnect();
  }, [controlled, compactAt, releaseAbove]);

  useEffect(() => {
    if (!compact) setOpen(false);
  }, [compact]);

  // The sheet of links on a phone. It is not next to its button in the page (the call to action sits
  // between), so opening it takes focus to its first link. Escape closes it and gives focus back to
  // the button. A press outside the header closes it, and so does focus that moves out of the header.
  useEffect(() => {
    if (!open) return;
    firstLink.current?.focus();
    const outside = (event: PointerEvent | FocusEvent) => {
      if (header.current && !header.current.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      menu.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  return (
    <header ref={header} data-ui="compact-nav" data-compact={compact} className={className}>
      <a
        href={`#${contentId}`}
        className={cn(
          'sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-3 focus-visible:left-3 focus-visible:z-40 focus-visible:rounded-md focus-visible:bg-card focus-visible:px-3 focus-visible:py-2 focus-visible:text-foreground',
          FOCUS,
        )}
      >
        {text.skip}
      </a>
      <div
        data-ui="compact-nav-bar"
        className={cn(
          'fixed top-[calc(env(safe-area-inset-top,0px)+12px)] left-1/2 z-30 flex -translate-x-1/2 items-center justify-between gap-6 rounded-md border py-2',
          'transition-[max-width,padding,background-color,border-color] duration-[480ms] ease-seat motion-reduce:transition-none',
          compact
            ? 'w-max max-w-[min(860px,calc(100%-32px))] border-border bg-card pr-2 pl-[18px]'
            : 'w-[calc(100%-2*clamp(16px,4vw,56px))] max-w-page border-transparent bg-transparent px-0',
        )}
      >
        <A
          href={homeHref}
          aria-label={homeLabel}
          className={cn('flex shrink-0 items-center gap-2.5 text-foreground', FOCUS)}
        >
          <span className="text-primary">{symbol}</span>
          <span
            className={cn(
              'font-display leading-none font-normal tracking-[-0.01em] transition-[font-size] duration-[480ms] ease-seat motion-reduce:transition-none',
              compact ? 'text-[20px]' : 'text-[24px]',
            )}
          >
            {wordmark}
          </span>
        </A>
        <nav
          aria-label={text.main}
          className={cn(
            'flex items-center gap-1',
            // hidden with `visibility`, so links that cannot be seen cannot be reached either
            compact
              ? 'visible opacity-100 transition-opacity delay-[160ms] duration-(--tf-dur-slide) ease-seat motion-reduce:delay-0 motion-reduce:duration-(--tf-dur-reduced)'
              : 'invisible opacity-0',
          )}
        >
          {links.map((link) => (
            <A
              key={link.href}
              href={link.href}
              aria-current={link.current ? 'true' : undefined}
              className={cn(LINK, 'max-[819px]:hidden')}
            >
              {link.label}
            </A>
          ))}
          <button
            ref={menu}
            type="button"
            aria-label={text.menu}
            title={text.menu}
            aria-expanded={open}
            aria-controls={sheet}
            onClick={() => setOpen((was) => !was)}
            className={cn(buttonClass({ variant: 'icon' }), 'min-[820px]:hidden')}
          >
            <Icon name={open ? 'X' : 'Menu'} />
          </button>
          {action ??
            (cta && (
              <Button variant="primary" href={cta.href} className="ml-2 whitespace-nowrap">
                {cta.label}
              </Button>
            ))}
        </nav>
      </div>
      <div
        id={sheet}
        data-ui="compact-nav-sheet"
        hidden={!open}
        className="fixed top-[calc(env(safe-area-inset-top,0px)+78px)] right-4 left-4 z-30 flex flex-col rounded-md border border-border bg-card p-2 min-[820px]:hidden"
      >
        {sheetHead && <div className="border-b border-border px-3 pt-1 pb-3">{sheetHead}</div>}
        {links.map((link, index) => (
          <A
            key={link.href}
            ref={index === 0 ? firstLink : undefined}
            href={link.href}
            aria-current={link.current ? 'true' : undefined}
            onClick={() => setOpen(false)}
            className={LINK}
          >
            {link.label}
          </A>
        ))}
      </div>
    </header>
  );
}
