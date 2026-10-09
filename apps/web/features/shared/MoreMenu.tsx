'use client';
import { type ReactNode, useId, useRef } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { Icon } from '../../components/ui/Icon';
import { usePopover } from '../account/use-popover';

// The few things a page keeps out of its main actions, behind one quiet control: a button that says
// whether its list is open, and the list as a popover under it. Escape closes it and gives the focus
// back to the button; a press or focus anywhere else closes it (usePopover). It is a disclosure, not a
// menu: the items are ordinary links and buttons, reached with Tab.

export function MoreMenu({
  label,
  ui,
  children,
}: {
  label: string;
  /** The `data-ui` of the button; the list's is this with `-list`. */
  ui: string;
  /** The items, each an `<li>`. */
  children: ReactNode;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = usePopover(root, button);
  return (
    // on a phone the list hangs from the row the control is in, so it never runs off the screen
    <div ref={root} className="md:relative">
      <button
        ref={button}
        type="button"
        className={`${buttonClass({ variant: 'link' })} inline-flex items-center gap-1 whitespace-nowrap`}
        data-ui={ui}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((now) => !now)}
      >
        {label}
        <Icon name="ChevronDown" size={16} />
      </button>
      <ul
        id={id}
        data-ui={`${ui}-list`}
        hidden={!open}
        className={`absolute top-full right-0 z-20 mt-2 w-max max-w-[min(32ch,calc(100vw-2rem))] flex-col items-start gap-3 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-popover max-md:right-auto max-md:left-0 ${open ? 'flex' : 'hidden'}`}
      >
        {children}
      </ul>
    </div>
  );
}
