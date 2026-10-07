'use client';
import Link from 'next/link';
import { useId } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { buttonClass } from '../../components/ui/button-class';
import { Card } from '../../components/ui/Card';
import { PAGE_TITLE } from '../../components/ui/heading';
import { SkeletonPlan } from '../../components/ui/Skeleton';
import { useT } from '../../i18n/I18nProvider';
import type { PlanState } from './use-plan';

// What the plan screen and the buy screen show when there is no plan to show: still reading, signed
// out, no chain yet, a plan this tab does not have, or a plan made for another chain. Each says what
// the person can do, and none shows a plan in its place.

export function PlanGate({
  state,
  next,
}: {
  state: Exclude<PlanState, { kind: 'ready' }>;
  /** Where sign-in leads back to: this page. */
  next: string;
}) {
  const t = useT();
  const titleId = useId();
  const link = buttonClass({ variant: 'secondary' });
  const primary = buttonClass({ variant: 'primary' });
  if (state.kind === 'loading')
    return (
      <Card>
        <CardWait label={t.chain.reading} skeleton={<SkeletonPlan />} />
      </Card>
    );
  const say = (
    title: string,
    body: string,
    action: { href: string; label: string; primary?: boolean },
  ) => (
    <section aria-labelledby={titleId} className="flex flex-col items-start gap-4">
      <h1 id={titleId} className={PAGE_TITLE}>
        {title}
      </h1>
      <p className="max-w-(--tf-measure-body) text-body">{body}</p>
      <Link href={action.href} className={action.primary ? primary : link}>
        {action.label}
      </Link>
    </section>
  );
  const goal = { href: '/goal', label: t.plan.backToGoal };
  if (state.kind === 'signed-out')
    return say(t.plan.title, t.plan.signedOut, {
      href: `/sign-in?next=${next}`,
      label: t.shell.signIn,
    });
  if (state.kind === 'no-chain')
    return say(t.plan.title, t.goal.blocked.chainNotChosen, {
      href: `/sign-in?next=${next}`,
      label: t.goal.chain.choose,
    });
  // The one thing to do about a plan that is not here is to build it again: the page's main button.
  if (state.kind === 'missing')
    return say(t.plan.missing.title, t.plan.missing.body, {
      href: '/goal',
      label: t.plan.missing.again,
      primary: true,
    });
  if (state.kind === 'split') return say(t.plan.title, t.plan.split, goal);
  return say(t.plan.title, t.plan.unsignable(t.chain.names[state.planChain]), goal);
}
