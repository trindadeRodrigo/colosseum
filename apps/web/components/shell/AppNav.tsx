'use client';
import { chainFamily } from '@colosseum/schemas';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useAccount } from '../../features/account/AccountProvider';
import { useWalletPort } from '../../features/wallet/WalletProvider';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../ui/Button';
import { buttonClass } from '../ui/button-class';
import { cn } from '../ui/cn';
import { shorten } from '../ui/format';
import { MockPlate } from '../ui/MockPlate';
import { Mark } from './Mark';

// The product's top bar (STYLE.md, Navigation): a plain bar on the ground with a hairline under it,
// the mark and the wordmark at the left. No glass and no blur. The goal comes first: home is the goal,
// then the portfolio (the monitor). The landing's compact bar is another component
// (components/ui/CompactNav.tsx).
//
// Nothing here is the wallet adapter's button, which renders one thing on the server and another in
// the browser. What the bar shows about the person comes from the wallet port, and it shows nothing
// about them until the port has loaded, so the server and the browser draw the same bar.

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const LINK = cn(
  'py-2 text-[0.9375rem]/5 font-medium text-muted-foreground transition-colors hover:text-foreground',
  'aria-[current=page]:text-foreground aria-[current=page]:underline aria-[current=page]:decoration-primary aria-[current=page]:decoration-2 aria-[current=page]:underline-offset-[6px]',
  FOCUS,
);

/** The product's routes, in the order of the bar. */
const ROUTES = [
  { href: '/goal', key: 'goal' },
  { href: '/monitor', key: 'portfolio' },
] as const;

export function AppNav() {
  const t = useT();
  const pathname = usePathname();
  return (
    <header data-ui="app-nav" className="border-b border-border">
      <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-6 gap-y-2 py-2">
        <div className="flex items-center gap-6">
          <Link
            href="/"
            aria-label={t.shell.home}
            className={cn('flex shrink-0 items-center gap-2.5 text-foreground', FOCUS)}
          >
            <span className="text-primary">
              <Mark size={24} />
            </span>
            {/* The wordmark is a logo, not the screen's serif line. Always lowercase. */}
            <span className="font-display text-[1.25rem] leading-none font-normal tracking-[-0.01em]">
              tenonfi
            </span>
          </Link>
          <nav aria-label={t.shell.nav} className="flex items-center gap-4">
            {ROUTES.map((route) => (
              <Link
                key={route.href}
                href={route.href}
                aria-current={pathname === route.href ? 'page' : undefined}
                className={LINK}
              >
                {t.shell[route.key]}
              </Link>
            ))}
          </nav>
        </div>
        <AccountControl />
      </div>
    </header>
  );
}

/** Who is signed in, in the bar: "Sign in" for nobody, the wallet of the plan's chain and "Sign out". */
function AccountControl() {
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
  return (
    <>
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
        <div data-ui="account" className="flex flex-wrap items-center justify-end gap-3">
          {port.test && <MockPlate labels={{ announce: t.shell.mockAnnounce }} />}
          {wallet && (
            <span className="font-mono text-source text-muted-foreground" title={wallet.address}>
              <span className="sr-only">{t.shell.account}: </span>
              {shorten(wallet.address)}
            </span>
          )}
          <Button size="dense" busy={busy} busyLabel={t.shell.signingOut} onClick={signOut}>
            {t.shell.signOut}
          </Button>
          {stillIn && (
            <p role="alert" className="basis-full text-right text-caption text-destructive">
              {t.shell.signOutFailed}
            </p>
          )}
        </div>
      )}
    </>
  );
}
