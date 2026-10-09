'use client';
import type { ReactNode } from 'react';
import { Wait } from '../../components/shell/Wait';
import { SkeletonText } from '../../components/ui/Skeleton';
import { ScreenWait } from '../../components/waits/ScreenWait';
import { PageHead } from './parts';
import { ExposureWait, OverviewWait, StepsWait } from './waits';
import { useWords } from './words';

// What a page of the section shows while it is made on the server (its `loading.tsx`), inside the
// section's frame: the page's own head and its own shape (waits.tsx), so the page's own wait takes
// over without a box moving.

/** A page that reads the person's plans, in its own outline. */
export function RouteWait({ page }: { page: 'overview' | 'rebalancing' | 'exposure' }) {
  const w = useWords();
  const shape: Record<typeof page, ReactNode> = {
    overview: <OverviewWait />,
    rebalancing: <StepsWait />,
    exposure: <ExposureWait />,
  };
  return (
    <div className="flex flex-col gap-8">
      {page === 'rebalancing' && <PageHead title={w.rebalancing.title} lead={w.rebalancing.lead} />}
      {page === 'exposure' && <PageHead title={w.exposure.title} lead={w.exposure.lead} />}
      <ScreenWait label={w.shell.reading} skeleton={shape[page]} />
    </div>
  );
}

/** The methodology, which reads nothing: its text to come. */
export function TextWait() {
  const w = useWords();
  return <Wait label={w.methodology.label} skeleton={<SkeletonText lines={6} />} />;
}
