'use client';
import { type RefObject, useEffect, useState } from 'react';
import type { Dictionary } from '../../i18n';
import { PersonError } from './person';

// What is left of the bar's chain switcher, which is gone (gate CHAIN-AT-THE-PLAN, Thom, Oct 9: the
// chain is not a mode, and the bar shows and switches none): the sentence for a chain that could not
// be stored, which /goal's own chain choice says, and the popover the account menu opens in.

/** Why a switch to `name` was not stored, as a sentence. */
export function switchFailure(t: Dictionary, e: unknown, name: string): string {
  const kind = e instanceof PersonError ? e.kind : 'unreachable';
  if (kind === 'no_wallet') return t.chain.failure.noWallet(name);
  if (kind === 'not_offered') return t.chain.failure.notOffered;
  if (kind === 'signed_out') return t.chain.failure.signedOut;
  if (kind === 'no_identity') return t.chain.failure.noIdentity;
  if (kind === 'busy') return t.shell.slowDown;
  return t.chain.failure.unreachable;
}

/**
 * A panel under a button: closed by Escape, which gives focus back to the button, and by a press or
 * focus anywhere outside `root`.
 */
export function usePopover(
  root: RefObject<HTMLElement | null>,
  button: RefObject<HTMLElement | null>,
): [boolean, (next: boolean | ((now: boolean) => boolean)) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('focusin', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('focusin', away);
      document.removeEventListener('keydown', key);
    };
  }, [open, root, button]);
  return [open, setOpen];
}
