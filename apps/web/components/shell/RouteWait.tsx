'use client';
import { useT } from '../../i18n/I18nProvider';
import { Card } from '../ui/Card';
import { SkeletonPlan, SkeletonSummary } from '../ui/Skeleton';
import { CardWait } from './Wait';

// What a route shows while its page is made on the server (a `loading.tsx`): the card the page opens
// with, in its own shape, and the wait in words. The screens' own waits take over once they run.

export type RouteShape = 'plan' | 'order' | 'portfolio' | 'vault';

export function RouteWait({ shape }: { shape: RouteShape }) {
  const t = useT();
  const label =
    shape === 'order'
      ? t.order.loading
      : shape === 'portfolio'
        ? t.shared.family.loading
        : shape === 'vault'
          ? t.shared.vault.loading
          : t.chain.reading;
  return (
    <Card>
      <CardWait
        label={label}
        skeleton={shape === 'order' || shape === 'vault' ? <SkeletonSummary /> : <SkeletonPlan />}
      />
    </Card>
  );
}
