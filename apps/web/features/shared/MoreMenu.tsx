'use client';
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { Icon } from '../../components/ui/Icon';
import { usePopover } from '../account/use-popover';

// The few things a page keeps out of its main actions, behind one quiet control: a button that says
// whether its list is open, and the list as a menu surface under it, as the bar's account menu is
// drawn (the popover surface, rows with a full-width hit area). Escape closes it and gives the focus
// back to the button; a press or focus anywhere else closes it (usePopover), and so does choosing a
// row. It is a disclosure, not a `menu` role: the rows are ordinary links and buttons, reached with
// Tab, as the account menu's are.
//
// The list is placed against the window (`position: fixed`, from the button's own box), never inside
// the box it is written in: a head that scrolls inside itself would cut it off. It hangs under the
// button from its right edge, moves in from either side of the window with a gutter, and opens above
// the button where there is no room below.

/** A row of the list: the whole row is the target, as in the account menu. */
export const MORE_ROW =
  'flex min-h-10 w-full items-center justify-between gap-3 rounded-md px-3 text-left text-body-sm text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

const GUTTER = 16;
const GAP = 8;

type Box = { top: number; bottom: number; left: number; right: number };

/**
 * Where the list goes, in the window's own coordinates: under the button and flush with its right
 * edge; inside the window on both sides; above the button when it does not fit below and does above.
 */
export function placeMenu(
  button: Box,
  size: { width: number; height: number },
  window: { width: number; height: number },
): { top: number; left: number } {
  const most = Math.max(GUTTER, window.width - GUTTER - size.width);
  const left = Math.min(Math.max(button.right - size.width, GUTTER), most);
  const below = button.bottom + GAP;
  const above = button.top - GAP - size.height;
  const fits = below + size.height <= window.height - GUTTER;
  const top = fits || above < GUTTER ? below : above;
  return { top, left };
}

export function MoreMenu({
  label,
  ui,
  children,
}: {
  label: string;
  /** The `data-ui` of the button; the list's is this with `-list`. */
  ui: string;
  /** The rows, each an `<li>` holding one link or button with `MORE_ROW`. */
  children: ReactNode;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = usePopover(root, button);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  // Placed before it is painted, and again when the window or anything around the button moves.
  useLayoutEffect(() => {
    if (!open) return setAt(null);
    const place = () => {
      const from = button.current?.getBoundingClientRect();
      const size = list.current?.getBoundingClientRect();
      // nothing is laid out (a test with no layout): it stays where the stylesheet puts it
      if (!from || !size || size.width === 0) return setAt(null);
      setAt(
        placeMenu(from, size, {
          width: document.documentElement.clientWidth,
          height: window.innerHeight,
        }),
      );
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // A row that was chosen closes the list: a link that opens another tab leaves this page as it was.
  // Heard on the list itself, which is no control: its rows are, and a key on one is a click.
  useEffect(() => {
    const node = list.current;
    if (!node || !open) return;
    const chosen = (event: Event) => {
      if ((event.target as Element).closest?.('a, button')) setOpen(false);
    };
    node.addEventListener('click', chosen);
    return () => node.removeEventListener('click', chosen);
  }, [open, setOpen]);

  const style: CSSProperties | undefined = at ? { top: at.top, left: at.left } : undefined;
  return (
    <div ref={root}>
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
        ref={list}
        id={id}
        data-ui={`${ui}-list`}
        hidden={!open}
        style={style}
        className={`fixed z-50 w-max min-w-56 max-w-[calc(100vw-2rem)] flex-col gap-1 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-popover ${open ? 'flex' : 'hidden'}`}
      >
        {children}
      </ul>
    </div>
  );
}
