'use client';
import Link from 'next/link';
import type { ReactNode, Ref } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { cn } from '../../components/ui/cn';
import { Skeleton } from '../../components/ui/Skeleton';
import { nextPath } from './next-path';

// The parts of the bar's account control that need no wallet: its frame, the placeholder it shows
// until it is known who is here, and "Sign in". The landing draws them at first load, before any of
// the wallet's code is there (features/landing/LandingAccount.tsx); the product's bar and the
// landing's, once the wallet is loaded, draw them through AccountControl.tsx. One control, the same
// three states on every page with a bar (Thom, Oct 9):
//
//   not known yet   a still box of the size of what comes, nothing to press, nothing said as an error
//   signed out      one "Sign in", which opens the sign-in dialog over the page the person is on
//   signed in       the account chip (a wallet glyph and "Account") with its menu of the person's
//                   wallets (AccountMenu.tsx)

/** The chip's box: the placeholder and the signed-in button share it, so nothing moves between them. */
export const CHIP_BOX =
  'inline-flex h-10 max-w-full items-center gap-2 rounded-md border border-border px-3 text-[0.875rem]/5 font-medium whitespace-nowrap';

/**
 * Where "Sign in" leads from a page: the sign-in screen, told to come back to that page. The dialog
 * that a press opens stays on the page; a link opened in a new tab returns to it after the sign-in.
 * A page sign-in cannot lead on to (the landing, the sign-in screen itself) is told nothing.
 */
export function signInHref(pathname: string | null): string {
  if (!pathname || pathname === '/sign-in' || nextPath(pathname) !== pathname) return '/sign-in';
  return `/sign-in?next=${pathname}`;
}

/** The control's frame: what it says to a screen reader, then the state it is in. */
export function AccountControlFrame({
  said,
  state,
  children,
  ref,
  className,
}: {
  /** Said politely when it changes: loading, signed out, still loading. Empty says nothing. */
  said: string;
  state: 'loading' | 'signed-out' | 'signed-in';
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
  className?: string;
}) {
  return (
    <div
      ref={ref}
      data-ui="account-control"
      data-state={state}
      className={cn('relative flex items-center gap-2', className)}
    >
      <span role="status" data-ui="account-said" className="sr-only">
        {said}
      </span>
      {children}
    </div>
  );
}

/** The chip's label, of one width whatever it holds, so the bar never shifts. */
export const LABEL_BOX = 'inline-flex w-[3.75rem] items-center justify-start';

/**
 * Not known yet: still boxes in the shape of what is expected, the chip for someone the hint says
 * was signed in, the button for anyone else. Nothing to press and nothing to read; the frame says
 * "Loading your account…" once.
 */
export function AccountPlaceholder({ expected }: { expected: boolean }) {
  if (!expected)
    return (
      <span aria-hidden="true" data-ui="account-placeholder" data-shape="sign-in">
        <Skeleton className="h-10 w-[5.0625rem] rounded-md" />
      </span>
    );
  return (
    <span aria-hidden="true" className={CHIP_BOX}>
      <Skeleton className="size-4" />
      <span className={LABEL_BOX}>
        <AccountBars />
      </span>
      <span className="size-4" />
    </span>
  );
}

/** The chip's still box: where its label will be. */
export function AccountBars() {
  return (
    <span
      aria-hidden="true"
      data-ui="account-placeholder"
      data-shape="account"
      className="inline-flex items-center"
    >
      <Skeleton className="h-3.5 w-12" />
    </span>
  );
}

/**
 * Signed out: the bar's one way in. `quiet` draws it outlined, on a page whose own action is the
 * filled one (the landing's "Start a plan"; one primary button per view). On the sign-in screen it
 * is where the person already is: marked as the current page, as the bar marks a current link.
 */
export function SignInButton({
  href,
  label,
  quiet = false,
  current = false,
  ref,
}: {
  href: string;
  label: string;
  quiet?: boolean;
  current?: boolean;
  ref?: Ref<HTMLAnchorElement>;
}) {
  if (current)
    return (
      <Link
        ref={ref}
        href={href}
        aria-current="page"
        data-ui="sign-in-here"
        data-account-focus=""
        className="inline-flex h-10 items-center rounded-md px-3 text-[0.875rem]/5 font-medium whitespace-nowrap text-foreground underline decoration-primary decoration-2 underline-offset-[6px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {label}
      </Link>
    );
  return (
    <Link
      ref={ref}
      href={href}
      data-ui="sign-in-button"
      data-account-focus=""
      className={cn(buttonClass({ variant: quiet ? 'secondary' : 'primary' }), 'whitespace-nowrap')}
    >
      {label}
    </Link>
  );
}
