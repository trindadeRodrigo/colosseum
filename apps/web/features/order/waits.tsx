'use client';
import type { ReactNode } from 'react';
import { CardBody, CardHeader } from '../../components/ui/Card';
import { PAGE_TITLE } from '../../components/ui/heading';
import {
  Skeleton,
  SkeletonLine,
  SkeletonListRow,
  SkeletonMark,
  SkeletonStats,
} from '../../components/ui/Skeleton';
import { ScreenWait } from '../../components/waits/ScreenWait';
import { useT } from '../../i18n/I18nProvider';

// The plan, buy and order screens while their data is on its way, each in its own outline so nothing
// moves when it lands. A plan and a shared portfolio draw the same pane (PlanView.tsx), so they wait
// in the same one. The words that are the screen's own (a title, a heading) are already there; a
// name, a share or an amount is a still bar. No figure is drawn, real or made up.

const CARD = 'rounded-lg border border-border bg-card text-card-foreground';
const LEDE = 'w-full max-w-(--tf-measure-body)';

/** The chain's tag over a page's title. */
export function ChainBadgeWait() {
  return <Skeleton className="h-5 w-14" />;
}

/**
 * The plan pane in outline (PlanView.tsx): its head, the answer in one line, the bar of what it
 * holds with a label a holding, a row a holding, then the exit plan.
 */
export function PlanViewWait({
  title,
  rows = 3,
  aside = 1,
}: {
  /** The pane's own title, where the screen knows it. */
  title?: string;
  rows?: number;
  /** Lines under the answer: who published it, where it was read from. */
  aside?: number;
}) {
  const t = useT();
  return (
    <div aria-hidden="true" data-ui="plan-pane-wait" className={CARD}>
      <div className="px-6 pt-6">
        {title ? (
          <p className="text-[1.125rem]/7 font-medium">{title}</p>
        ) : (
          <SkeletonLine className="text-[1.125rem]/7" width="w-32" />
        )}
        <SkeletonLine className="mt-1 text-body-sm" width="w-64" />
      </div>
      <div className="flex flex-col gap-6 px-6 pt-5 pb-6">
        <div className="flex max-w-(--tf-measure-body) flex-col gap-3">
          <SkeletonLine className="text-h4" width="w-72" />
          {aside > 0 && <SkeletonLine className="text-body-sm" width="w-80" lines={aside} />}
        </div>
        <div className="flex flex-col gap-4">
          <p className="text-[0.8125rem]/5 font-medium">{t.plan.holds}</p>
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-11 w-full rounded-none" />
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {Array.from({ length: rows }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
                <span key={i} className="flex min-h-8 items-center gap-1.5 text-caption">
                  <Skeleton className="size-3 rounded-none" />
                  <SkeletonMark />
                  <SkeletonLine width="w-16" />
                </span>
              ))}
            </div>
          </div>
          <div className="flex flex-col divide-y divide-border border-y border-border">
            {Array.from({ length: rows }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
              <div key={i} className="flex flex-col gap-1 py-2.5">
                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,11rem)_minmax(3rem,1fr)_auto]">
                  <SkeletonMark />
                  <SkeletonLine className="text-body" width="w-20" />
                  <Skeleton className="hidden h-2 w-full rounded-none sm:block" />
                  <SkeletonLine className="text-body" width="w-9" />
                </div>
                <SkeletonLine className="pl-9 text-caption" width="w-20" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <p className="text-[0.8125rem]/5 font-medium">{t.plan.exitPlan}</p>
          <SkeletonLine className="text-body-sm" width="w-96" />
          <p className="text-body-sm text-muted-foreground">{t.plan.inKind}</p>
        </div>
      </div>
    </div>
  );
}

/** A page's head: the chain's tag, the title in the title's own face, and the lines under it. */
function HeadWait({
  title,
  titleLines = 2,
  children,
}: {
  /** The page's own title, where it is known before the data. */
  title?: string;
  titleLines?: number;
  children?: ReactNode;
}) {
  return (
    <div aria-hidden="true" className="flex flex-col items-start gap-3">
      <ChainBadgeWait />
      {title ? (
        <p className={PAGE_TITLE}>{title}</p>
      ) : (
        <SkeletonLine className={`w-full ${PAGE_TITLE}`} width="w-72" lines={titleLines} />
      )}
      {children}
    </div>
  );
}

/** A plan's page (PlanScreen): the goal as its title, what the plan does, the pane, and the way on. */
export function PlanScreenWait() {
  const t = useT();
  return (
    <ScreenWait
      label={t.chain.reading}
      skeleton={
        <div data-ui="plan-screen-wait" className="flex flex-col gap-8">
          <HeadWait>
            {/* what the plan does, then what happens next: more lines on a phone, as the words wrap */}
            <SkeletonLine className={`${LEDE} text-body-lg sm:hidden`} lines={4} />
            <SkeletonLine className={`${LEDE} hidden text-body-lg sm:block`} lines={2} />
            <SkeletonLine className={`${LEDE} text-body sm:hidden`} lines={3} />
            <SkeletonLine className={`${LEDE} hidden text-body sm:block`} lines={2} />
          </HeadWait>
          <div aria-hidden="true" className="flex flex-col gap-6">
            <PlanViewWait title={t.plan.title} rows={4} aside={0} />
            <div className="border border-border px-6 py-4">
              <p className="text-body font-medium">{t.plan.details}</p>
            </div>
            <Skeleton className="h-10 w-28 rounded-md" />
          </div>
        </div>
      }
    />
  );
}

/** The buy page (BuyScreen): its title, the amount, and the card the order is made on. */
export function BuyScreenWait() {
  const t = useT();
  return (
    <ScreenWait
      label={t.chain.reading}
      skeleton={
        <div data-ui="buy-screen-wait" className="flex flex-col gap-8">
          <HeadWait title={t.buy.title}>
            <SkeletonLine className={`${LEDE} text-body-lg sm:hidden`} lines={4} />
            <SkeletonLine className={`${LEDE} hidden text-body-lg sm:block`} lines={2} />
          </HeadWait>
          <div aria-hidden="true" data-wait="amount" className="flex flex-col gap-1.5">
            <p className="text-caption font-medium">{t.buy.amount.label}</p>
            <Skeleton className="h-10 w-44 rounded-md" />
            <SkeletonLine className="text-caption" width="w-64" />
          </div>
          <div aria-hidden="true" data-wait="invest-card" className={`${CARD} max-w-3xl p-6`}>
            <div className="flex flex-col gap-5">
              <SkeletonLine className="text-h4" width="w-40" />
              <div className="flex flex-col divide-y divide-border border-y border-border">
                {[0, 1, 2, 3].map((i) => (
                  <SkeletonListRow key={i} mark={false} className="h-9" />
                ))}
              </div>
              <Skeleton className="h-10 w-32 rounded-md" />
            </div>
          </div>
        </div>
      }
    />
  );
}

/** An order's page (OrderScreen): its title and the card of its steps, a line a step. */
export function OrderScreenWait({
  steps = 4,
  head,
}: {
  steps?: number;
  /** The page's own head, where the order this browser kept already says what it is. */
  head?: ReactNode;
}) {
  const t = useT();
  return (
    <ScreenWait
      label={t.order.loading}
      skeleton={
        <div data-ui="order-screen-wait" className="flex flex-col gap-8">
          {head ?? (
            <HeadWait titleLines={1}>
              <SkeletonLine
                className="w-full max-w-(--tf-measure-body) text-body-lg"
                width="w-full"
                lines={2}
              />
            </HeadWait>
          )}
          <div aria-hidden="true" data-wait="order-steps" className={CARD}>
            <CardHeader title={t.order.stepsTitle} level={2} />
            <CardBody className="flex flex-col gap-4">
              <SkeletonStats count={3} />
              <div className="flex flex-col divide-y divide-border">
                {Array.from({ length: steps }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
                  <div key={i} className="flex flex-col gap-1 py-3">
                    <SkeletonLine className="text-body" width={i % 2 ? 'w-72' : 'w-80'} />
                    <SkeletonLine className="text-body-sm" width="w-96" />
                  </div>
                ))}
              </div>
            </CardBody>
          </div>
        </div>
      }
    />
  );
}

/**
 * What the wallet holds against a deposit, while it is read (FundingStep): the line that says what is
 * needed, the note under it, and the two ways on. `label` says what is awaited where that first line
 * will be, so the step lands on it and nothing under it moves. No amount is drawn: none is known yet.
 */
export function FundsWait({ label }: { label?: string }) {
  return (
    <div data-ui="funds-wait" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        {label ? (
          <p className="max-w-(--tf-measure-body) text-body text-muted-foreground">{label}</p>
        ) : (
          <SkeletonLine className="max-w-(--tf-measure-body) text-body" width="w-full" />
        )}
        <SkeletonLine className="max-w-(--tf-measure-body) text-body-sm" width="w-4/5" />
      </div>
      <div aria-hidden="true" className="flex flex-wrap gap-3">
        <Skeleton className="h-9 w-44 rounded-md" />
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>
    </div>
  );
}

/**
 * An order's steps while the order is made or read, inside the pane or the card that holds them: the
 * three figures over them, then a line a step. No card of its own (the host is one), and no amount.
 */
export function StepsWait({ steps = 3 }: { steps?: number }) {
  return (
    <div aria-hidden="true" data-ui="steps-wait" className="flex flex-col gap-4">
      <SkeletonStats count={3} />
      <div className="flex flex-col divide-y divide-border">
        {Array.from({ length: steps }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
          <div key={i} className="flex flex-col gap-1 py-3">
            <SkeletonLine className="text-body" width={i % 2 ? 'w-72' : 'w-80'} />
            {i > 0 && <SkeletonLine className="text-body-sm" width="w-4/5" />}
          </div>
        ))}
      </div>
    </div>
  );
}
