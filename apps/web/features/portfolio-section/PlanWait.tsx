'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { PAGE_TITLE } from '../../components/ui/heading';
import { Skeleton, SkeletonChart, SkeletonLine, SkeletonTable } from '../../components/ui/Skeleton';
import { ScreenWait } from '../../components/waits/ScreenWait';
import { SECTION } from './pages';
import { Block } from './plan-blocks';
import { useWords } from './words';

// A plan's page while its answer is on its way, in the page's own outline: the block that says where
// the plan stands, then each block under its own heading (the headings are the page's words, so they
// are already there): its value over time, its parts against their targets, what leaving would cost,
// where the risk sits, its latest trades. A block that reads on its own afterwards (plan-blocks.tsx,
// `BlockRead`) waits in the same frame, so the page does not move twice.

const CARD = 'rounded-lg border border-border bg-card p-6';

/** The frame a block's answer lands in. */
function Frame({ children }: { children: ReactNode }) {
  return <div className={CARD}>{children}</div>;
}

/** The chart of a vault's value: its read-out line, the frame it draws in, its legend. */
export function ValueChartWait() {
  return (
    <span aria-hidden="true" className="flex flex-col gap-2">
      <SkeletonLine className="font-mono text-[12px]/5" width="w-64" />
      <SkeletonChart title={false} frame="h-[220px]" />
      <SkeletonLine className="text-caption" width="w-56" />
    </span>
  );
}

/** Lines of a name over two labelled figures: what leaving a holding would cost. */
export function ExitLinesWait({ rows = 2 }: { rows?: number }) {
  return (
    <span aria-hidden="true" className="flex flex-col divide-y divide-border">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
        <span key={i} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
          <SkeletonLine className="text-body-sm" width="w-28" />
          <SkeletonLine className="text-body-sm" width="w-48" />
          <SkeletonLine className="text-body-sm" width="w-56" />
        </span>
      ))}
    </span>
  );
}

/** Two short tables side by side: the shares by issuer and by kind of asset. */
export function RiskWait() {
  const columns = [{ track: 'minmax(0,1fr)' }, { track: '4rem', align: 'end' as const }];
  return (
    <span aria-hidden="true" className="flex flex-col gap-4">
      <SkeletonLine className="text-body-sm" width="w-72" />
      <span className="grid gap-6 md:grid-cols-2">
        <SkeletonTable columns={columns} rows={3} framed={false} />
        <SkeletonTable columns={columns} rows={2} framed={false} />
      </span>
    </span>
  );
}

/** A few lines of a list, each one sentence long: the latest trades. */
export function TradesWait({ rows = 2 }: { rows?: number }) {
  return (
    <span aria-hidden="true" className="flex flex-col divide-y divide-border">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
        <SkeletonLine key={i} className="py-2 text-body-sm" width={i % 2 ? 'w-2/3' : 'w-3/4'} />
      ))}
    </span>
  );
}

/** The page's blocks in outline, under the page's head. */
export function PlanBlocksWait() {
  const w = useWords();
  const words = w.overview.card;
  return (
    <div aria-hidden="true" data-ui="plan-wait" className="flex flex-col gap-10">
      <div data-wait="plan-head" className={`${CARD} flex flex-col items-start gap-3`}>
        <div className="flex items-center gap-3">
          <Skeleton className="h-[22px] w-20 rounded-full" />
          <Skeleton className="h-[22px] w-16 rounded-sm" />
        </div>
        <SkeletonLine className="w-full max-w-(--tf-measure-body) text-body" width="w-full" />
        <SkeletonLine className="w-full font-mono text-source" width="w-40" />
        <dl className="grid w-full gap-x-6 gap-y-1 text-body min-[480px]:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{words.value}</dt>
          <dd>
            <SkeletonLine width="w-28" />
          </dd>
          <dt className="text-muted-foreground">{words.putIn}</dt>
          <dd>
            <SkeletonLine width="w-28" />
          </dd>
        </dl>
        <SkeletonLine className="w-full text-caption" width="w-64" />
      </div>
      <Block ui="plan-history-wait" heading={w.plan.history.heading} lead={w.plan.history.lead}>
        <Frame>
          <ValueChartWait />
        </Frame>
      </Block>
      <Block ui="plan-parts-wait" heading={w.plan.parts.heading}>
        <Frame>
          <SkeletonTable
            framed={false}
            rows={3}
            columns={[
              { track: 'minmax(0,2fr)' },
              { align: 'end' },
              { align: 'end' },
              { align: 'end' },
              { track: 'minmax(0,2fr)', align: 'end', width: 'w-32' },
            ]}
          />
        </Frame>
      </Block>
      <Block ui="plan-exit-wait" heading={w.plan.exit.heading} lead={w.plan.exit.lead}>
        <Frame>
          <ExitLinesWait />
        </Frame>
      </Block>
      <Block ui="plan-risk-wait" heading={w.plan.risk.heading} lead={w.plan.risk.lead}>
        <Frame>
          <RiskWait />
        </Frame>
      </Block>
      <Block ui="plan-trades-wait" heading={w.plan.trades.heading} lead={w.plan.trades.lead}>
        <Frame>
          <TradesWait />
        </Frame>
      </Block>
    </div>
  );
}

/** What a plan's page shows while it is made on the server (its `loading.tsx`). */
export function PlanWait() {
  const w = useWords();
  return (
    <div className="flex flex-col gap-8">
      {/* the page's own head while it waits: the way back, and its title until the goal is read */}
      <header className="flex flex-col gap-3">
        <p>
          <Link href={SECTION} className={buttonClass({ variant: 'link' })}>
            {w.plan.back}
          </Link>
        </p>
        <h1 className={PAGE_TITLE}>{w.plan.title}</h1>
      </header>
      <ScreenWait label={w.shell.reading} skeleton={<PlanBlocksWait />} />
    </div>
  );
}
