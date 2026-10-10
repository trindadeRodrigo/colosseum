'use client';
import { useT } from '../../i18n/I18nProvider';
import { Card } from '../ui/Card';
import { SkeletonPlan } from '../ui/Skeleton';
import { CardWait } from './Wait';

// What a route shows while its page is made on the server (a `loading.tsx`): the card the page opens
// with, in its own shape, and the wait in words. The screens' own waits take over once they run.

/** A shared portfolio's deposit page while it is made on the server. */
export function RouteWait() {
  const t = useT();
  return (
    <Card>
      <CardWait label={t.shared.family.loading} skeleton={<SkeletonPlan />} />
    </Card>
  );
}
