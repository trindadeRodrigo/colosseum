'use client';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { useLang, useT } from '../../i18n/I18nProvider';
import { nextPath } from './next-path';
import { SignInScreen } from './SignInScreen';
import { nextOf, SignInFrame, signInLink } from './sign-in-frame';

// Sign-in as a dialog over the page the person is on (Thom, Oct 6; gate SIGN-IN-FLOW): the same
// panel as `/sign-in`, the two ways in, the wallet list and the chain question inside it, then back to
// the page, where what they started carries on. Every link to `/sign-in` in the product opens it: the
// bar's "Sign in", the guarded pages, Buy, Publish. The landing opens the same dialog, loading it on
// the first press (features/landing/LandingSignIn.tsx). A link opened in a new tab and a page loaded
// at `/sign-in` still get the page. The frame and its modal rules are in sign-in-frame.tsx.

type Opened = { next: string | null; trigger: HTMLElement | null };
type SignInDialogValue = { openSignIn: (opened?: Partial<Opened>) => void };

const SignInDialogContext = createContext<SignInDialogValue | null>(null);

/** Opens the sign-in dialog from code. A link to `/sign-in` opens it by itself. */
export function useSignInDialog(): SignInDialogValue {
  const value = useContext(SignInDialogContext);
  if (!value) throw new Error('useSignInDialog() needs <SignInDialogProvider> above it');
  return value;
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
      openSignIn({ next: nextOf(anchor), trigger: anchor });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [pathname, openSignIn]);

  const value = useMemo(() => ({ openSignIn }), [openSignIn]);
  const close = useCallback(() => setOpened(null), []);
  return (
    <SignInDialogContext.Provider value={value}>
      {children}
      {opened && (
        <SignInFrame trigger={opened.trigger} onClose={close}>
          {(titleId) => <SignInDialogBody titleId={titleId} next={opened.next} onClose={close} />}
        </SignInFrame>
      )}
    </SignInDialogContext.Provider>
  );
}

/**
 * What the dialog holds: the sign-in panel and the disclaimer. Signed in and the chain known, it
 * closes, and goes on to where the action was headed if that is another page of this app.
 */
export function SignInDialogBody({
  titleId,
  next,
  onClose,
}: {
  titleId: string;
  next: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const pathname = usePathname();
  const done = useCallback(() => {
    onClose();
    const to = next === null ? null : nextPath(next);
    if (to && to !== pathname) router.push(to);
  }, [onClose, next, pathname, router]);
  return (
    <>
      <SignInScreen
        titleId={titleId}
        onDone={done}
        next={next === null ? pathname : nextPath(next)}
      />
      {/* On the panel's column, so its left edge is the title's and the cards'. */}
      <div className="mx-auto w-full max-w-[860px]">
        <Disclaimer lang={lang} label={t.shell.disclaimer} />
      </div>
    </>
  );
}
