import { Mark } from '../../components/shell/Mark';
import { ThemeToggle } from '../../components/shell/ThemeToggle';
import { buttonClass } from '../../components/ui/button-class';
import { cn } from '../../components/ui/cn';
import { dictionary, type Lang } from '../../i18n';
import { API } from '../../lib/api';

// The landing's bar (IDENTITY-2, the first demonstration of the identity): static at the top, full
// width, on the page's ground with a hairline under it. The face and the wordmark lead home; then the
// product (Plans), Bearing, and the API's documents; the one action on the right. The action is "Sign
// in" for a visitor (it opens the sign-in dialog over the landing: LandingSignIn.tsx) and "Open the
// app" for a person signed in on this browser. Before it, the appearance as one icon (ThemeToggle).

/** Where a signed-in person goes back into the app: the goal, where sign-in leads. */
export const APP_HOME = '/goal';

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const LINK = cn(
  'rounded-md px-3 py-2 text-[0.9375rem]/5 font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground',
  FOCUS,
);

export function LandingBar({ lang, signedIn = false }: { lang: Lang; signedIn?: boolean }) {
  const t = dictionary(lang).landing.nav;
  const links = [
    { label: t.plans, href: APP_HOME },
    { label: t.bearing, href: '/analytics/stocks' },
    { label: t.docs, href: `${API}/docs` },
  ];
  const cta = signedIn
    ? { label: t.openApp, href: APP_HOME }
    : { label: t.cta, href: `/sign-in?next=${APP_HOME}` };
  return (
    <header data-ui="landing-bar" className="relative z-10 border-b border-border bg-background">
      <a
        href="#content"
        className={cn(
          'sr-only rounded-md bg-background px-3 py-2 focus:not-sr-only focus:absolute focus:top-3 focus:left-3',
          FOCUS,
        )}
      >
        {t.skip}
      </a>
      <div className="mx-auto flex h-16 w-full max-w-page items-center gap-2 px-[clamp(16px,4vw,56px)] sm:gap-6">
        <a
          href="/"
          aria-label={t.home}
          className={cn('flex shrink-0 items-center gap-2.5 rounded-md text-foreground', FOCUS)}
        >
          <Mark size={24} />
          <span className="font-display text-[1.375rem]/none font-semibold tracking-[-0.02em]">
            tenonfi
          </span>
        </a>
        <nav aria-label={t.main} className="hidden min-w-0 items-center gap-1 sm:flex">
          {links.map((link) => (
            <a key={link.href} href={link.href} className={LINK}>
              {link.label}
            </a>
          ))}
        </nav>
        <ThemeToggle className="ml-auto" />
        <a
          href={cta.href}
          className={cn(buttonClass({ variant: 'secondary' }), 'inline-flex items-center')}
        >
          {cta.label}
        </a>
      </div>
    </header>
  );
}
