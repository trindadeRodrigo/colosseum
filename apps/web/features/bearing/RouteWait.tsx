'use client';
import { PageWait, useWords } from './parts';

// A Bearing page's wait before the page itself runs (its `loading.tsx`): its filters, a row of five
// figures, the two chart cards and the table, with no labels yet, since the page is not known here.

export function RouteWait() {
  const t = useWords();
  return (
    <PageWait
      label={t.dex.reading}
      kpis={Array.from({ length: 5 }, () => ({ label: '\u00a0', note: '\u00a0' }))}
    />
  );
}
