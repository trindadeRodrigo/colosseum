'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { AccountBlock, AccountMenu } from '../../features/account/AccountMenu';
import { useAccount } from '../../features/account/AccountProvider';
import { ChainSwitch } from '../../features/account/ChainSwitch';
import { SlowSignIn } from '../../features/account/SlowSignIn';
import { useWalletPort } from '../../features/wallet/WalletProvider';
import { useT } from '../../i18n/I18nProvider';
import { buttonClass } from '../ui/button-class';
import { CompactNav } from '../ui/CompactNav';
import { Mark } from './Mark';

// The product's bar is his landing's compact bar (compact-nav.md, hero-3d.html), compact from the
// start because no product page has a stage: the mark and the wordmark, then his items mapped to the
// product's routes, then the wallet. A solid bar with a hairline, fixed at the top; no glass, no blur.
//
//   Invest      the goal and its plan (/goal)
//   Portfolio   the person's vaults (/monitor), for someone signed in
//   Analytics   Bearing's analytics (/analytics/stocks), current on every page under /analytics,
//               its methodology too, which its side menu links (no Resources item: Thom, Oct 6)
//   signed out  the chain switcher (what the shelf shows, CHAIN-SWITCH) and "Sign in", the one action
//   signed in   one account control: the current chain and the short address, opening the chain
//               switch, "Copy address", the explorer and "Sign out" (Thom, Oct 6; AccountMenu.tsx)
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
  { href: '/monitor', key: 'portfolio', signedIn: true },
  // Bearing's analytics: every page of the section is under it
  { href: '/analytics/stocks', key: 'analytics', also: ['/analytics'] },
] as const;

/** The page a link stands for is the one in view: its own path, or one under it that it leads to. */
const isCurrent = (pathname: string, route: (typeof ROUTES)[number]) =>
  pathname === route.href ||
  ('also' in route && route.also.some((p) => pathname.startsWith(`${p}/`)));

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
      action={account.action}
      sheetHead={account.sheetHead}
      labels={{ skip: t.shell.skip, main: t.shell.nav, menu: t.shell.menu }}
    />
  );
}

/** Who is signed in, in the bar: the chain and "Sign in" for nobody, the account control for a person. */
function useAccountControl(): { action: ReactNode; sheetHead: ReactNode } {
  const t = useT();
  const port = useWalletPort();
  const { slow, stalled, leave } = useAccount();
  const [busy, setBusy] = useState(false);
  const [stillIn, setStillIn] = useState(false);
  const [said, setSaid] = useState('');
  const signIn = useRef<HTMLAnchorElement>(null);
  // The person pressed "Sign out" here. When they are out, that button is gone: focus goes to what
  // took its place, and a screen reader is told.
  const leaving = useRef(false);
  const signedOut = port.status === 'signed-out';
  const onSignIn = usePathname() === '/sign-in';
  useEffect(() => {
    if (!signedOut || !leaving.current) return;
    leaving.current = false;
    signIn.current?.focus();
    setSaid(t.shell.signedOut);
  }, [signedOut, t]);

  async function signOut() {
    // The sign-in service names nobody (it has not loaded) and there is nobody to sign out there:
    // the person leaves as far as this browser can, and gets the visitor's way in.
    if (port.userId === null) {
      leave();
      return;
    }
    setBusy(true);
    setStillIn(false);
    setSaid('');
    leaving.current = true;
    try {
      await port.signOut();
    } catch {
      // Signing out fails only when the provider cannot be reached: the person is still signed in,
      // and is told so.
      leaving.current = false;
      setStillIn(true);
    } finally {
      setBusy(false);
    }
  }

  const out = { signOut, busy, failed: stillIn };
  // Signed in, even while the wallet still loads (their wallets are being made, or could not be):
  // known by then, and always with the way out, which is in the menu.
  // Someone told their sign-in is slow keeps the control while the wallet is read again.
  const nobody = port.status === 'loading' && port.userId === null;
  // The sign-in service has not loaded, and nobody is known to be signed in: after a short wait the
  // bar gives the visitor's controls anyway, so there is always a way in (the sign-in screen says
  // what is wrong if the service still has not answered).
  const waitedOut = nobody && stalled && (!slow || slow.side === 'service');
  const unknown = nobody && !slow && !stalled;
  const visitor = signedOut || waitedOut;
  const signedIn = !visitor && !unknown;
  const action = (
    <div data-ui="account-control" className="relative ml-2 flex items-center gap-2">
      <span role="status" data-ui="account-said" className="sr-only">
        {said}
      </span>
      {/* Before the wallet has loaded there is nothing to say: an empty box of the same height. */}
      {unknown ? (
        <span aria-hidden="true" className="h-10 min-w-20" />
      ) : visitor ? (
        <>
          {/* Still not loaded after a quarter of a minute: said beside the way in, which stays. */}
          {waitedOut && slow && (
            <span
              role="status"
              data-ui="account-slow"
              className="text-caption whitespace-nowrap text-muted-foreground max-[1023px]:sr-only"
            >
              {t.shell.slow.title}
            </span>
          )}
          <ChainSwitch />
          {onSignIn ? (
            // On the sign-in page (a direct link; elsewhere "Sign in" opens the sign-in dialog) the
            // bar's way in is where the person already is: marked as the current page, as the bar
            // marks a current link, and not a second primary button beside the page's "Continue
            // with a passkey". As tall as the button it stands for, so the bar keeps its height.
            <Link
              ref={signIn}
              href="/sign-in"
              aria-current="page"
              data-ui="sign-in-here"
              className="inline-flex h-10 items-center rounded-md px-3 text-[0.875rem]/5 font-medium whitespace-nowrap text-foreground underline decoration-primary decoration-2 underline-offset-[6px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {t.shell.signIn}
            </Link>
          ) : (
            // The bar's one call to action, as the landing's bar draws it (compact-nav.md: CTA = primary).
            <Link ref={signIn} href="/sign-in" className={buttonClass({ variant: 'primary' })}>
              {t.shell.signIn}
            </Link>
          )}
        </>
      ) : (
        // One control for the account: the chain and the address, opening the chain switch, the
        // address and "Sign out" (AccountMenu.tsx). No second button in the bar.
        <AccountMenu out={out} />
      )}
    </div>
  );
  // The phone's sheet opens with the same block: the chain switch, the address, "Sign out".
  // For a visitor the sign-in service never answered for, what is slow and the way to try again.
  const sheetHead =
    waitedOut && slow ? (
      <SlowSignIn className="flex flex-col gap-1" />
    ) : (
      signedIn && <AccountBlock out={out} className="flex flex-col gap-2" />
    );
  return { action, sheetHead };
}
