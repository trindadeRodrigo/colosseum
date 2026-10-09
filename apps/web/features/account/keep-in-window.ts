'use client';
import { type RefObject, useLayoutEffect, useState } from 'react';

// A panel hung from the right edge of the bar's account control (its menu, the help while a sign-in
// is slow). On a phone the bar is narrow and centred, and the control sits left of where such a panel
// fits: its left edge would be outside the window. This says how far right to move it so the whole
// panel is inside, with a gutter. The bar is transformed, so `position: fixed` would not escape it.

const GUTTER = 16;

/** How many pixels to add to the panel's `right` (as a negative offset) while it is `shown`. */
export function useKeepInWindow(
  shown: boolean,
  anchor: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
): number {
  const [nudge, setNudge] = useState(0);
  useLayoutEffect(() => {
    if (!shown) return setNudge(0);
    const place = () => {
      const frame = anchor.current?.getBoundingClientRect();
      const width = panel.current?.getBoundingClientRect().width ?? 0;
      // nothing is laid out (a test with no layout): it stays where the stylesheet puts it
      if (!frame || width === 0) return setNudge(0);
      setNudge(Math.max(0, Math.ceil(GUTTER - (frame.right - width))));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [shown, anchor, panel]);
  return nudge;
}
