'use client';
import Link from 'next/link';
import { useId } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardLoading } from '../../components/ui/Card';
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
  if (state.kind === 'loading')
    return (
      <Card>
        <CardLoading label={t.chain.reading} />
      </Card>
    );
  const say = (title: string, body: string, action: { href: string; label: string }) => (
    <section aria-labelledby={titleId} className="flex flex-col items-start gap-4">
      <h1 id={titleId} className="font-sans text-h2 font-semibold">
        {title}
      </h1>
      <p className="max-w-(--tf-measure-body) text-body">{body}</p>
      <Link href={action.href} className={link}>
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
  if (state.kind === 'missing') return say(t.plan.missing.title, t.plan.missing.body, goal);
  return say(
    t.plan.title,
    t.plan.otherChain(t.chain.names[state.planChain], t.chain.names[state.chain]),
    goal,
  );
}
