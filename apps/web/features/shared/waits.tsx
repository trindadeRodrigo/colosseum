'use client';
import { buttonClass } from '../../components/ui/button-class';
import { PAGE_TITLE } from '../../components/ui/heading';
import { Skeleton, SkeletonLine, SkeletonListRow } from '../../components/ui/Skeleton';
import { ScreenWait } from '../../components/waits/ScreenWait';
import { useT } from '../../i18n/I18nProvider';
import { PlanViewWait } from '../order/waits';

// The shelf and a shared portfolio's page while they are read, in their own outlines: the shelf's
// cards in the shelf's grid, each with its bar of holdings; a portfolio's head over the plan pane it
// shares with a plan's page. A name, a share or a yield is a still bar: no figure is drawn.

/** What a card of holdings opens with: one bar of the shares, then a mark, a name and a share each. */
export function HoldingsWait({ rows = 3 }: { rows?: number }) {
  return (
    <span aria-hidden="true" data-ui="holdings-wait" className="flex flex-col gap-2">
      <Skeleton className="h-3 w-full rounded-none" />
      <span className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
          <SkeletonListRow key={i} />
        ))}
      </span>
    </span>
  );
}

/** One card of the shelf: its name and chain, its holdings, its yield, its words, who made it. */
function ShelfCardWait() {
  return (
    <div data-wait="shelf-card" className="h-full rounded-lg border border-border bg-card">
      <div className="flex items-baseline justify-between gap-4 p-6">
        <SkeletonLine className="min-w-0 flex-1 text-h4" width="w-44" />
        <Skeleton className="h-5 w-14" />
      </div>
      <div className="flex flex-col gap-3 border-t border-border p-6">
        <HoldingsWait />
        <SkeletonLine className="text-body-sm" width="w-72" />
        <SkeletonLine className="text-body-sm" width="w-48" />
        <SkeletonLine className="text-body-sm" width="w-40" />
      </div>
    </div>
  );
}

/** The shelf's list: cards two abreast on a desk, one on a phone, as the shelf lays them. */
export function ShelfWait({ cards = 4 }: { cards?: number }) {
  return (
    <div
      aria-hidden="true"
      data-ui="shelf-wait"
      className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0"
    >
      {Array.from({ length: cards }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
        <ShelfCardWait key={i} />
      ))}
    </div>
  );
}

/** A shared portfolio's page: the way back, its name, what to do next, its words, then its pane. */
export function FamilyWait() {
  const t = useT();
  return (
    <ScreenWait
      label={t.shared.family.loading}
      skeleton={
        <div aria-hidden="true" data-ui="family-wait" className="flex flex-col gap-8">
          <div className="flex flex-col gap-3">
            <span className={`${buttonClass({ variant: 'link' })} self-start`}>
              {t.shared.family.backToShelf}
            </span>
            <SkeletonLine className={PAGE_TITLE} width="w-80" />
            <p className="max-w-(--tf-measure-body) text-body text-muted-foreground">
              {t.shared.family.nextStep}
            </p>
            <SkeletonLine className="max-w-(--tf-measure-body) text-body-lg" width="w-64" />
          </div>
          <PlanViewWait aside={2} />
        </div>
      }
    />
  );
}
