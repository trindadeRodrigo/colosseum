'use client';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '../../components/ui/Button';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { Icon } from '../../components/ui/Icon';
import { useLang, useT } from '../../i18n/I18nProvider';
import { nextPath } from './next-path';
import { SignInScreen } from './SignInScreen';

// Sign-in as a dialog over the page the person is on (Thom, Oct 6; gate SIGN-IN-FLOW): the same
// panel as `/sign-in`, the two ways in, the wallet list and the chain question inside it, then back to
// the page, where what they started carries on. Every link to `/sign-in` in the product opens it: the
// bar's "Sign in", the guarded pages, Buy, Publish. A link opened in a new tab, a page loaded at
// `/sign-in`, and the landing (its own document, with no wallet) still get the page.
//
// The surface is the design system's modal (token-mapping.md, section 7): the popover ground, a 1px
// hairline, 2px corners, no shadow, a scrim of the page's ground at 85% with no blur. It rises 12px as
// it fades in (STYLE.md, Motion), a 120ms crossfade with reduced motion. Below 640px it is a sheet the
// full height of the window. `role="dialog"`, `aria-modal`, named by its title; focus goes into it
// and stays there, Escape and the scrim close it, focus goes back to what opened it, and the page
// behind is inert and does not scroll.

type Opened = { next: string | null; trigger: HTMLElement | null };
type SignInDialogValue = { openSignIn: (opened?: Partial<Opened>) => void };

const SignInDialogContext = createContext<SignInDialogValue | null>(null);

/** Opens the sign-in dialog from code. A link to `/sign-in` opens it by itself. */
export function useSignInDialog(): SignInDialogValue {
  const value = useContext(SignInDialogContext);
  if (!value) throw new Error('useSignInDialog() needs <SignInDialogProvider> above it');
  return value;
}

/** A plain click on a link to `/sign-in` of this app, or null for anything else. */
function signInLink(event: MouseEvent): HTMLAnchorElement | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = (event.target as Element | null)?.closest?.('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.target && anchor.target !== '_self') return null;
  const url = new URL(anchor.href, window.location.href);
  return url.origin === window.location.origin && url.pathname === '/sign-in' ? anchor : null;
}

export function SignInDialogProvider({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const pathname = usePathname();
  const openSignIn = useCallback((given: Partial<Opened> = {}) => {
    setOpened({
      next: given.next ?? null,
      trigger:
        given.trigger ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null),
    });
  }, []);

  // Every link to the sign-in page opens the dialog instead, wherever it is drawn. On the page itself
  // the link goes nowhere new, and is left alone.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (pathname === '/sign-in') return;
      const anchor = signInLink(event);
      if (!anchor) return;
      event.preventDefault();
      const next = new URL(anchor.href, window.location.href).searchParams.get('next');
      openSignIn({ next, trigger: anchor });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [pathname, openSignIn]);

  const value = useMemo(() => ({ openSignIn }), [openSignIn]);
  return (
    <SignInDialogContext.Provider value={value}>
      {children}
      {opened && <SignInDialog opened={opened} onClose={() => setOpened(null)} />}
    </SignInDialogContext.Provider>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function SignInDialog({ opened, onClose }: { opened: Opened; onClose: () => void }) {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const pathname = usePathname();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  // The page behind does not scroll and cannot be reached; what opened the dialog gets focus back.
  useEffect(() => {
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = 'hidden';
    const behind = [...document.querySelectorAll<HTMLElement>('[data-ui="app-shell"]')];
    for (const el of behind) el.inert = true;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    const trigger = opened.trigger;
    return () => {
      root.style.overflow = overflow;
      for (const el of behind) el.inert = false;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [opened.trigger]);

  // Escape closes it; Tab goes round inside it.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => !el.closest('[aria-hidden="true"]'),
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Signed in and the chain known: back to the page, and on to where the action was headed if that
  // is another page of this app.
  const done = useCallback(() => {
    onClose();
    const next = opened.next === null ? null : nextPath(opened.next);
    if (next && next !== pathname) router.push(next);
  }, [onClose, opened.next, pathname, router]);

  return (
    <div data-ui="sign-in-dialog" className="fixed inset-0 z-50 flex items-center justify-center">
      {/* The scrim: the page's ground at 85%, no blur. Pressing it closes the dialog. */}
      <div
        aria-hidden="true"
        data-ui="sign-in-scrim"
        onClick={onClose}
        className="absolute inset-0 bg-[color-mix(in_oklab,var(--background)_85%,transparent)] motion-safe:animate-scrim-in motion-reduce:animate-crossfade"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative flex w-full flex-col gap-6 overflow-y-auto border border-border bg-popover p-6 text-popover-foreground outline-none motion-safe:animate-dialog-in motion-reduce:animate-crossfade max-sm:h-dvh max-sm:rounded-none max-sm:border-0 max-sm:pt-16 sm:max-h-[calc(100dvh-32px)] sm:w-[calc(100%-32px)] sm:max-w-[920px] sm:rounded-md"
      >
        <Button
          variant="icon"
          aria-label={t.signIn.close}
          onClick={onClose}
          className="absolute top-4 right-4"
        >
          <Icon name="X" />
        </Button>
        <SignInScreen titleId={titleId} onDone={done} />
        {/* On the panel's column, so its left edge is the title's and the cards'. */}
        <div className="mx-auto w-full max-w-[860px]">
          <Disclaimer lang={lang} label={t.shell.disclaimer} />
        </div>
      </div>
    </div>
  );
}
