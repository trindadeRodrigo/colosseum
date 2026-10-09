'use client';
import { type RefObject, useEffect, useState } from 'react';

// The popover the bar's account menu opens in.

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
