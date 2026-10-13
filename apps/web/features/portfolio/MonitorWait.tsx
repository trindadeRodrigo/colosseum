'use client';
import { Skeleton, SkeletonLine } from '../../components/ui/Skeleton';
import { useT } from '../../i18n/I18nProvider';
import { HoldingsWait } from '../shared/waits';

// The monitor while the vaults are read, in its own outline: the three sums over the page, the way to
// a new plan, and a vault's card with its value, the bar of what it holds and its rows. The labels are
// the page's own words; where a sum, a name or a share will be there is a still bar.

/** The page's head: what the vaults are worth, how many, how many holdings, the way to a new plan, the chain. */
export function MonitorHeadWait() {
  const t = useT();
  const words = t.portfolio.overview;
  return (
    <div aria-hidden="true" data-ui="monitor-head-wait" className="flex flex-col gap-3">
      <div className="flex w-full min-w-0 flex-col gap-3 border-y border-border py-5">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="col-span-2 min-w-0 sm:col-span-1">
            <dt className="text-caption text-muted-foreground">{words.value}</dt>
            <dd>
              <SkeletonLine className="text-h2" width="w-40" />
            </dd>
          </div>
          <div>
            <dt className="text-caption text-muted-foreground">{words.vaults}</dt>
            <dd>
              <SkeletonLine className="text-h2" width="w-6" />
            </dd>
          </div>
          <div>
            <dt className="text-caption text-muted-foreground">{words.holdings}</dt>
            <dd>
              <SkeletonLine className="text-h2" width="w-6" />
            </dd>
          </div>
        </dl>
      </div>
      <Skeleton className="h-8 w-24 rounded-md" />
      {/* the chain the vaults are on, named once they are read */}
      <Skeleton className="h-5 w-28" />
    </div>
  );
}

/** A vault's card, in the grid the vaults sit in. */
export function MonitorVaultsWait() {
  const t = useT();
  return (
    <div
      aria-hidden="true"
      data-ui="monitor-vaults-wait"
      className="grid items-start gap-5 lg:grid-cols-2"
    >
      <div
        data-wait="vault"
        className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-card p-4"
      >
        <div className="flex items-center justify-between gap-3">
          <SkeletonLine className="min-w-0 flex-1 text-h4" width="w-44" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <Skeleton className="h-5 w-14" />
          <dl className="text-end">
            <dt className="text-caption text-muted-foreground">{t.portfolio.vault.value}</dt>
            <dd>
              <SkeletonLine className="text-h3" width="w-28" />
            </dd>
          </dl>
        </div>
        <span className="flex flex-col gap-4 [&>[data-ui=holdings-wait]]:gap-4">
          <HoldingsWait />
        </span>
        <SkeletonLine className="text-body-sm" width="w-56" />
        <div className="border-t border-border pt-3">
          <p className="text-body-sm font-medium">{t.portfolio.overview.details}</p>
        </div>
      </div>
    </div>
  );
}
