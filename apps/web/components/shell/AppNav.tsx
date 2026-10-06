'use client';
import { chainFamily } from '@colosseum/schemas';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useAccount } from '../../features/account/AccountProvider';
import { useWalletPort } from '../../features/wallet/WalletProvider';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../ui/Button';
import { buttonClass } from '../ui/button-class';
import { CompactNav } from '../ui/CompactNav';
import { shorten } from '../ui/format';
import { MockPlate } from '../ui/MockPlate';
import { Mark } from './Mark';

// The product's bar is his landing's compact bar (compact-nav.md, hero-3d.html), compact from the
// start because no product page has a stage: the mark and the wordmark, then his items mapped to the
// product's routes, then the wallet. A solid bar with a hairline, fixed at the top; no glass, no blur.
//
//   Invest      the goal and its plan (/goal)
//   Portfolio   the person's vaults (/monitor), for someone signed in
//   Resources   how Bearing measures (/risk/methodology), the one methodology page the app has
//   Analytics   Bearing (/risk)
//   the wallet  "Sign in"; then the short address of the plan's chain and "Sign out"
//
// His "Products" is the shelf of shared portfolios, which no route serves yet (WEB-4): it comes back
// with the shelf. On a phone the links are in the sheet under the menu button, and the address goes at
// the top of the sheet: the bar keeps room for the one action.
//
// Nothing here is the wallet adapter's button, which renders one thing on the server and another in
// the browser. What the bar shows about the person comes from the wallet port, and it shows nothing
// about them until the port has loaded, so the server and the browser draw the same bar.

/** The product's routes in the bar, his order; `signedIn` marks the one a visitor does not get. */
const ROUTES = [
  { href: '/goal', key: 'invest', also: ['/plan', '/orders'] },
  { href: '/monitor', key: 'portfolio', signedIn: true },
  { href: '/risk/methodology', key: 'resources' },
  { href: '/risk', key: 'analytics' },
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
  return (
    <CompactNav
      symbol={<Mark size={24} />}
      wordmark="tenonfi"
      homeLabel={t.shell.home}
      homeHref="/"
      contentId="content"
      compact
      links={ROUTES.filter((route) => !('signedIn' in route) || signedIn).map((route) => ({
        label: t.shell[route.key],
        href: route.href,
        current: isCurrent(pathname, route),
      }))}
      action={account.action}
      sheetHead={account.sheetHead}
      labels={{ skip: t.shell.skip, main: t.shell.nav, menu: t.shell.menu }}
    />
  );
}

/** Who is signed in, in the bar: "Sign in" for nobody, the wallet of the plan's chain and "Sign out". */
function useAccountControl(): { action: ReactNode; sheetHead: ReactNode } {
  const t = useT();
  const port = useWalletPort();
  const { account } = useAccount();
  const [busy, setBusy] = useState(false);
  const [stillIn, setStillIn] = useState(false);
  const [said, setSaid] = useState('');
  const signIn = useRef<HTMLAnchorElement>(null);
  // The person pressed "Sign out" here. When they are out, that button is gone: focus goes to what
  // took its place, and a screen reader is told.
  const leaving = useRef(false);
  const signedOut = port.status === 'signed-out';
  useEffect(() => {
    if (!signedOut || !leaving.current) return;
    leaving.current = false;
    signIn.current?.focus();
    setSaid(t.shell.signedOut);
  }, [signedOut, t]);

  async function signOut() {
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

  // Only the wallet of the chain the plan lives on is shown: the other family's is never used.
  const wallet = account.status === 'ready' ? port.active(chainFamily(account.chain)) : null;
  const address = wallet && (
    <span className="font-mono text-source text-muted-foreground" title={wallet.address}>
      <span className="sr-only">{t.shell.account}: </span>
      {shorten(wallet.address)}
    </span>
  );
  const plate = port.test && <MockPlate labels={{ announce: t.shell.mockAnnounce }} />;
  const action = (
    <div data-ui="account-control" className="relative ml-2 flex items-center gap-3">
      <span role="status" data-ui="account-said" className="sr-only">
        {said}
      </span>
      {/* Before the wallet has loaded there is nothing to say: an empty box of the same height. A
          person who is signed in while it still loads (their wallets are being made, or could not
          be) is known by then, and always has the way out: a wallet that never arrives must not
          hold them here. */}
      {port.status === 'loading' && port.userId === null ? (
        <span aria-hidden="true" className="h-8 min-w-20" />
      ) : signedOut ? (
        <Link ref={signIn} href="/sign-in" className={buttonClass({ size: 'dense' })}>
          {t.shell.signIn}
        </Link>
      ) : (
        <div data-ui="account" className="flex items-center gap-3">
          <span className="flex items-center gap-2 max-[819px]:hidden">
            {plate}
            {address}
          </span>
          <Button
            size="dense"
            variant="secondary"
            busy={busy}
            busyLabel={t.shell.signingOut}
            onClick={signOut}
          >
            {t.shell.signOut}
          </Button>
          {stillIn && (
            <p
              role="alert"
              className="absolute top-full right-2 mt-2 rounded-md border border-border bg-card px-3 py-2 text-caption text-destructive"
            >
              {t.shell.signOutFailed}
            </p>
          )}
        </div>
      )}
    </div>
  );
  const sheetHead = !signedOut && (plate || address) && (
    <span className="flex items-center gap-2">
      {plate}
      {address}
    </span>
  );
  return { action, sheetHead };
}
