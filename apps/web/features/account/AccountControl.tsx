'use client';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWaitPhase } from '../../components/ui/wait';
import { useT } from '../../i18n/I18nProvider';
import { useWalletPort } from '../wallet/WalletProvider';
import { AccountBlock, AccountMenu, type SignOutState } from './AccountMenu';
import { type AccountView, useAccount } from './AccountProvider';
import {
  AccountControlFrame,
  AccountPlaceholder,
  SignInButton,
  signInHref,
} from './account-control-parts';
import { SlowSignIn } from './SlowSignIn';

// The bar's account control with the wallet under it: the one control of the product's bar and of the
// landing's (account-control-parts.tsx says what its three states are). What it adds to the parts:
//
//   who is here   from the account (`who`), which a page that needs a sign-in reads too, so the bar
//                 and the page never say different things
//   slowness      is not a label. The control keeps its loading look; after half a minute (SLOW_MS)
//                 the help is under it: what is slow, "Try again", "Sign out". The help is kept
//                 inside the window at every width (on a phone the control sits near the left)
//   the way out   someone the sign-in service names, whose account is still being read, has it at
//                 once: the loading look is then a button that opens "Sign out" (AccountMenu)
//   focus         stays in the control when the state changes under it: after "Sign out" it is on
//                 "Sign in", after a slow sign-in resolves it is on what took the help's place
//   said          "Loading your account…" once a wait is over 400ms, "Still loading your account"
//                 when the help comes, "You're signed out." after a sign-out. Politely, once each

export function useAccountControl({ quiet = false }: { quiet?: boolean } = {}): {
  /** The control, for the bar. */
  action: ReactNode;
  /** The same account at the head of the phone's sheet: the help while it is slow, then the block. */
  sheetHead: ReactNode;
  view: AccountView;
} {
  const t = useT();
  const port = useWalletPort();
  const { slow, who, expected, view, leave } = useAccount();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);
  const [stillIn, setStillIn] = useState(false);
  const [said, setSaid] = useState('');
  const root = useRef<HTMLDivElement>(null);
  // The person pressed "Sign out" here: once they are out, a screen reader is told.
  const leaving = useRef(false);

  const help = view === 'loading' && slow !== null;
  // A wait under 400ms says nothing (STYLE.md, the loader).
  const waited = useWaitPhase(view === 'loading') !== 'quiet';

  // The help hangs from the control's right edge. Where that would put its left edge outside the
  // window (a phone, where the bar is narrow and centred), it is moved right by what is missing.
  const panel = useRef<HTMLDivElement>(null);
  const [nudge, setNudge] = useState(0);
  useLayoutEffect(() => {
    if (!help) return setNudge(0);
    const GUTTER = 16;
    const place = () => {
      const frame = root.current?.getBoundingClientRect();
      const width = panel.current?.getBoundingClientRect().width ?? 0;
      // nothing is laid out (a test with no layout): it stays where the stylesheet puts it
      if (!frame || width === 0) return setNudge(0);
      setNudge(Math.max(0, Math.ceil(GUTTER - (frame.right - width))));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [help]);

  // Focus that was in the control stays in it when what held it is gone.
  const inside = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `view` and `help` are the changes that take a focused element away
  useEffect(() => {
    const frame = root.current;
    if (!frame || !inside.current || frame.contains(document.activeElement)) return;
    frame.querySelector<HTMLElement>('[data-account-focus]')?.focus();
  }, [view, help]);
  useEffect(() => {
    if (view !== 'signed-out' || !leaving.current) return;
    leaving.current = false;
    // "Sign out" is gone, from the menu or from the phone's sheet: focus goes to what took its place.
    root.current?.querySelector<HTMLElement>('[data-account-focus]')?.focus();
    setSaid(t.shell.signedOut);
  }, [view, t]);

  async function signOut() {
    setStillIn(false);
    setSaid('');
    leaving.current = true;
    // The sign-in service names nobody (it has not loaded) and there is nobody to sign out there:
    // the person leaves as far as this browser can, and gets the visitor's way in.
    if (port.userId === null) {
      leave();
      return;
    }
    setBusy(true);
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
  const out: SignOutState = { signOut, busy, failed: stillIn };

  const action = (
    <AccountControlFrame
      ref={root}
      state={view}
      said={
        view === 'loading'
          ? help
            ? t.shell.slow.title
            : waited
              ? t.shell.accountLoading
              : ''
          : said
      }
    >
      {/* Focus is followed here, where it bubbles: a press on a child that then goes away. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: it only notes where focus is */}
      <div
        data-live=""
        className="contents"
        onFocus={() => {
          inside.current = true;
        }}
        onBlur={(event) => {
          // Focus taken elsewhere on the page; one whose element went away names no other.
          if (event.relatedTarget && !root.current?.contains(event.relatedTarget as Node))
            inside.current = false;
        }}
      >
        {view === 'loading' ? (
          <>
            {/* A session the service names can be left at once; with only the hint there is none. */}
            {who === 'signed-in' ? (
              <AccountMenu out={out} waiting />
            ) : (
              <AccountPlaceholder expected={expected} />
            )}
            {help && (
              <div
                ref={panel}
                data-ui="account-help"
                style={{ right: -nudge }}
                className="absolute top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-popover p-3 text-popover-foreground"
              >
                <SlowSignIn out={out} className="flex flex-col gap-2" />
              </div>
            )}
          </>
        ) : view === 'signed-out' ? (
          <SignInButton
            href={signInHref(pathname)}
            label={t.shell.signIn}
            quiet={quiet}
            current={pathname === '/sign-in'}
          />
        ) : (
          <AccountMenu out={out} />
        )}
      </div>
    </AccountControlFrame>
  );
  const sheetHead =
    view === 'signed-in' ? (
      <AccountBlock out={out} className="flex flex-col gap-2" />
    ) : help ? (
      <SlowSignIn out={out} className="flex flex-col gap-2" />
    ) : null;
  return { action, sheetHead, view };
}

/** The control by itself, where there is no sheet to head (the landing's bar). */
export function AccountControl({ quiet }: { quiet?: boolean }) {
  return useAccountControl({ quiet }).action;
}
