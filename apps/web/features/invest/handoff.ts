import { BasketSheet } from '@colosseum/schemas';

// A way to close a gap, pressed on a plan's own page: the plan's goal and the way go to the Invest
// screen in the tab, where the change is a turn of the conversation and the plan is built again.
// Taken once, then removed.

const KEY = 'tf-invest-way';

export function keepWay(sheet: BasketSheet, way: string): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ sheet, way }));
  } catch {
    // No storage in this browser: the Invest screen opens empty.
  }
}

/** Non-consuming compatibility check; the original Invest screen remains the only consumer. */
export function readWay(): { sheet: BasketSheet; way: string } | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const read = raw ? (JSON.parse(raw) as { sheet?: unknown; way?: unknown }) : null;
    const sheet = BasketSheet.safeParse(read?.sheet);
    return sheet.success && typeof read?.way === 'string'
      ? { sheet: sheet.data, way: read.way }
      : null;
  } catch {
    return null;
  }
}

export function takeWay(): { sheet: BasketSheet; way: string } | null {
  const value = readWay();
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  return value;
}
