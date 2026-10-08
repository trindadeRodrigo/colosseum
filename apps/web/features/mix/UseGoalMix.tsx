'use client';
import type { ChainId, MixLine, MixReview } from '@colosseum/schemas';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Field, Input, Select } from '../../components/ui/Field';
import { useLang, useT } from '../../i18n/I18nProvider';
import { MAX_USD, MIN_USD } from '../order/InvestCard';
import { rememberPlan } from '../order/plan-store';
import { useApiFetch } from '../wallet/WalletProvider';
import { useFailureText } from './failure';
import { MixReviewCard } from './MixReviewCard';
import { acceptedOf } from './mix';
import { acceptGoalMix } from './mix-api';

// A new goal's mix from the conversation, made into a plan (gate ANY-COMPOSITION, #191): the amount
// and what it is for, the server's review with each warning ticked, then the plan is stored and the
// existing buy takes it by its id, unchanged. The weights are the server's, from the preview.

type Goal = 'grow' | 'income' | 'protect';
type Risk = 'low' | 'medium' | 'high';

const amountOf = (text: string): number | null => {
  const typed = text.trim().replace(/[$\s]/g, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(typed)) return null;
  const n = Number(typed);
  return n >= MIN_USD && n <= MAX_USD ? n : null;
};

export function UseGoalMix({
  chain,
  userId,
  allocations,
  onClose,
}: {
  chain: ChainId;
  userId: string;
  allocations: readonly MixLine[];
  onClose: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const g = t.mix.goal;
  const api = useApiFetch();
  const router = useRouter();
  const failureText = useFailureText();
  const titleId = useId();
  const [amountText, setAmountText] = useState('');
  const [goal, setGoal] = useState<Goal | ''>('');
  const [risk, setRisk] = useState<Risk | ''>('');
  const [tried, setTried] = useState(false);
  const [review, setReview] = useState<MixReview | null>(null);
  const [changed, setChanged] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const amount = amountOf(amountText);
  const lines = allocations.map(({ assetId, weightBps }) => ({ assetId, weightBps }));

  const base = () =>
    amount !== null && goal && risk
      ? {
          version: 1 as const,
          origin: 'model' as const,
          language: lang,
          goal,
          risk,
          amountUsd: amount,
          allocations: lines,
        }
      : null;

  async function ask() {
    setTried(true);
    const body = base();
    if (!body) return;
    setBusy(true);
    setFailure(null);
    const answer = await acceptGoalMix(api, chain, {
      ...body,
      confirm: false,
      acceptedWarnings: [],
    });
    setBusy(false);
    if (answer.kind !== 'ok') return setFailure(failureText(answer));
    setChanged(false);
    setReview(answer.value.review);
  }

  async function confirm() {
    const body = base();
    if (!body || !review) return;
    setBusy(true);
    setFailure(null);
    const answer = await acceptGoalMix(api, chain, {
      ...body,
      confirm: true,
      acceptedWarnings: acceptedOf(review, ticked),
      reviewHash: review.reviewHash,
    });
    if (answer.kind !== 'ok') {
      setBusy(false);
      return setFailure(failureText(answer));
    }
    if (answer.value.status === 'review') {
      // The figures moved since the person looked: the new review, to read and tick again.
      setBusy(false);
      setChanged(true);
      setReview(answer.value.review);
      return;
    }
    const { proposalId, proposal } = answer.value;
    rememberPlan({ id: proposalId, userId, proposal, rollUp: null });
    router.push(`/plan/${encodeURIComponent(proposalId)}/buy`);
  }

  if (review)
    return (
      <>
        <MixReviewCard
          review={review}
          ticked={ticked}
          onTick={(id, on) =>
            setTicked((old) => {
              const next = new Set(old);
              if (on) next.add(id);
              else next.delete(id);
              return next;
            })
          }
          confirmLabel={busy ? g.confirming : g.confirm}
          onConfirm={confirm}
          onBack={() => setReview(null)}
          busy={busy}
          changed={changed}
        />
        {failure && (
          <p role="alert" className="max-w-(--tf-measure-body) text-body-sm text-destructive">
            {failure}
          </p>
        )}
      </>
    );

  return (
    <Card as="section" aria-labelledby={titleId} data-ui="use-goal-mix">
      <CardHeader id={titleId} title={g.title} level={2} meta={t.chain.names[chain]} />
      <CardBody className="flex flex-col gap-4">
        <p className="max-w-(--tf-measure-body) text-body-sm">{g.lead}</p>
        <Field
          label={g.amount}
          hint={g.amountHint}
          error={(tried || amountText.trim()) && amount === null ? g.errors.amount : undefined}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              width="14ch"
              value={amountText}
              onChange={(e) => setAmountText(e.currentTarget.value)}
            />
          )}
        </Field>
        <Field label={g.goal} error={tried && !goal ? g.errors.goal : undefined}>
          {(control) => (
            <Select
              {...control}
              value={goal}
              onChange={(e) => setGoal(e.currentTarget.value as Goal | '')}
            >
              <option value="">{g.choose}</option>
              {(['grow', 'income', 'protect'] as const).map((key) => (
                <option key={key} value={key}>
                  {g.goals[key]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={g.risk} error={tried && !risk ? g.errors.risk : undefined}>
          {(control) => (
            <Select
              {...control}
              value={risk}
              onChange={(e) => setRisk(e.currentTarget.value as Risk | '')}
            >
              <option value="">{g.choose}</option>
              {(['low', 'medium', 'high'] as const).map((key) => (
                <option key={key} value={key}>
                  {g.risks[key]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {failure && (
          <p role="alert" className="max-w-(--tf-measure-body) text-body-sm text-destructive">
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" data-action="mix-review" disabled={busy} onClick={ask}>
            {busy ? g.reviewing : g.review}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t.mix.review.back}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
