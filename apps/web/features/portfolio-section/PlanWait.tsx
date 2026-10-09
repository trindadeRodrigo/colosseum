'use client';
import { Wait } from '../../components/shell/Wait';
import { Skeleton, SkeletonChart, SkeletonRows, SkeletonText } from '../../components/ui/Skeleton';
import { useWords } from './words';

// What a plan's page shows while it is made on the server (its `loading.tsx`), inside the section's
// frame: the page's own shape, still, and the wait in words. A goal's line, the block that says where
// the plan stands, the figure of its value over time, the table of its parts.

export function PlanWait() {
  const w = useWords();
  return (
    <Wait
      label={w.shell.reading}
      skeleton={
        <div aria-hidden="true" data-ui="plan-wait" className="flex flex-col gap-10">
          <div className="flex flex-col gap-3">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-9 w-72 max-w-full" />
          </div>
          <div className="flex flex-col gap-3 border border-border p-6">
            <Skeleton className="h-4 w-32" />
            <SkeletonText lines={2} />
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-44" />
          </div>
          <div className="border border-border p-6">
            <SkeletonChart />
          </div>
          <SkeletonRows rows={3} columns={5} />
        </div>
      }
    />
  );
}
