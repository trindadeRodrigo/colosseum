'use client';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { useT } from '../../i18n/I18nProvider';

// The sign-in dialog's frame, apart from what is in it: the scrim, the panel and the modal's rules.
// It imports nothing of the wallet, so the landing can draw it at once on the first press of "Sign in"
// while the panel inside it loads (features/landing/LandingSignIn.tsx). The product's dialog uses the
// same frame (SignInDialog.tsx).
//
// The surface is the design system's modal (token-mapping.md, section 7): the popover ground, a 1px
// hairline, 2px corners, no shadow, a scrim of the page's ground at 85% with no blur. It rises 12px as
// it fades in (STYLE.md, Motion), a 120ms crossfade with reduced motion. Below 640px it is a sheet the
// full height of the window. `role="dialog"`, `aria-modal`, named by its title; focus goes into it
// and stays there, Escape, the scrim and the close button close it, focus goes back to what opened
// it, and the rest of the page is inert and does not scroll.

/**
 * A plain click on a link to `/sign-in` of this app, or null for anything else. A link marked
 * `data-sign-in-page` asks for the page itself (the dialog's own way out when it cannot load).
 */
export function signInLink(event: MouseEvent): HTMLAnchorElement | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = (event.target as Element | null)?.closest?.('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.hasAttribute('data-sign-in-page')) return null;
  if (anchor.target && anchor.target !== '_self') return null;
  const url = new URL(anchor.href, window.location.href);
  return url.origin === window.location.origin && url.pathname === '/sign-in' ? anchor : null;
}

/** What a link to `/sign-in` asked to go on to afterwards, as it wrote it, or null. */
export const nextOf = (anchor: HTMLAnchorElement) =>
  new URL(anchor.href, window.location.href).searchParams.get('next');

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SignInFrame({
  trigger,
  onClose,
  children,
}: {
  /** What opened the dialog: focus goes back to it when it closes. */
  trigger: HTMLElement | null;
  onClose: () => void;
  /** What is in it, named by the title it draws with this id. */
  children: (titleId: string) => ReactNode;
}) {
  const t = useT();
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const html = document.documentElement;
    const { overflow, scrollbarGutter } = html.style;
    // The page under it does not scroll, and does not shift sideways when its scrollbar goes.
    html.style.scrollbarGutter = 'stable';
    html.style.overflow = 'hidden';
    // Everything beside the dialog, at every level from it up to <body>, is inert while it is open.
    const behind: HTMLElement[] = [];
    for (
      let node: HTMLElement | null = root.current;
      node && node !== document.body;
      node = node.parentElement
    )
      for (const sibling of node.parentElement?.children ?? [])
        if (sibling !== node && sibling instanceof HTMLElement && !sibling.inert)
          behind.push(sibling);
    for (const el of behind) el.inert = true;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    return () => {
      html.style.overflow = overflow;
      html.style.scrollbarGutter = scrollbarGutter;
      for (const el of behind) el.inert = false;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [trigger]);

  // Escape closes it wherever focus is, on <body> too when what had it went away (a list the chain
  // question replaced).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, []);

  // Tab goes round inside it.
  const onKeyDown = (event: React.KeyboardEvent) => {
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

  return (
    <div
      ref={root}
      data-ui="sign-in-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
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
        {children(titleId)}
      </div>
    </div>
  );
}
