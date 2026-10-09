'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccountControl } from '../../features/account/AccountControl';
import { ChainSwitch } from '../../features/account/ChainSwitch';
import { useWalletPort } from '../../features/wallet/WalletProvider';
import { useT } from '../../i18n/I18nProvider';
import { CompactNav } from '../ui/CompactNav';
import { Mark } from './Mark';
import { ThemeToggle } from './ThemeToggle';

// The product's bar is his landing's compact bar (compact-nav.md, hero-3d.html), compact from the
// start because no product page has a stage: the mark and the wordmark, then his items mapped to the
// product's routes, then the wallet. A solid bar with a hairline, fixed at the top; no glass, no blur.
//
//   Invest      the goal and its plan (/goal)
//   Portfolio   the person's vaults (/monitor), for someone signed in
//   Analytics   Bearing's analytics (/analytics/stocks), current on every page under /analytics,
//               its methodology too, which its side menu links (no Resources item: Thom, Oct 6)
//   the account one control, the same on the landing's bar (Thom, Oct 9; AccountControl.tsx): a still
//               placeholder until it is known who is here, "Sign in" for nobody, and for a person the
//               chip with the current chain and the short address, opening the chain switch, "Copy
//               address", the explorer and "Sign out" (Thom, Oct 6; AccountMenu.tsx)
//   signed out  beside it, the chain switcher (what the shelf shows, CHAIN-SWITCH)
//
//   Products    the shelf of shared portfolios (/shelf), and a portfolio's page under it
//
// On a phone the links are in the sheet under the menu button, under the same account block (chain
// switch, address, "Sign out"); the bar's control shows the chain's short name alone.
//
// Nothing here is the wallet adapter's button, which renders one thing on the server and another in
// the browser. What the bar shows about the person comes from the wallet port, and it shows nothing
// about them until the port has loaded, so the server and the browser draw the same bar.

/** The product's routes in the bar, his order; `signedIn` marks the one a visitor does not get. */
const ROUTES = [
  { href: '/shelf', key: 'products', also: ['/indexes', '/publish'] },
  { href: '/goal', key: 'invest', also: ['/plan', '/orders'] },
  // the portfolio section's board (/portfolio); the older monitor and a vault's page are under it
  {
    href: '/portfolio',
    key: 'portfolio',
    signedIn: true,
    also: ['/portfolio', '/monitor', '/vaults'],
  },
  // Bearing's analytics: every page of the section is under it
  { href: '/analytics/stocks', key: 'analytics', also: ['/analytics'] },
] as const;

/** The page a link stands for is the one in view: its own path, or one under it that it leads to. */
const isCurrent = (pathname: string, route: (typeof ROUTES)[number]) =>
  pathname === route.href ||
  ('also' in route &&
    route.also.some((p) => pathname.startsWith(`${p}/`) || (p === '/monitor' && pathname === p)));

export function AppNav() {
  const t = useT();
  const pathname = usePathname();
  const port = useWalletPort();
  const account = useAccountControl();
  const signedIn = port.status !== 'signed-out' && port.userId !== null;
  const exact = ROUTES.some((route) => route.href === pathname);
  return (
    <CompactNav
      symbol={<Mark size={24} />}
      wordmark="tenonfi"
      homeLabel={t.shell.home}
      homeHref="/"
      contentId="content"
      compact
      linkAs={Link}
      links={ROUTES.filter((route) => !('signedIn' in route) || signedIn).map((route) => ({
        label: t.shell[route.key],
        href: route.href,
        // the link whose own page this is wins over one it is under
        current: (exact ? pathname === route.href : isCurrent(pathname, route)) && 'page',
      }))}
      action={
        <div className="flex items-center gap-2">
          {/* On a phone the bar has no room for it beside the account: it sits in the menu's sheet. */}
          <span className="hidden sm:contents">
            <ThemeToggle />
          </span>
          {/* What a visitor looks at, beside the way in: not part of the account control. */}
          <div className="ml-2 flex items-center gap-2">
            {account.view === 'signed-out' && <ChainSwitch />}
            {account.action}
          </div>
        </div>
      }
      sheetHead={
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">{account.sheetHead}</div>
          <span className="contents sm:hidden">
            <ThemeToggle />
          </span>
        </div>
      }
      labels={{ skip: t.shell.skip, main: t.shell.nav, menu: t.shell.menu }}
    />
  );
}
