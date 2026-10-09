'use client';
import type { ChainId, MixLine, MixReview, Provenance } from '@colosseum/schemas';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { StatusMark } from '../../components/ui/StatusMark';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars, parseNumber } from '../goal/sheet';
import { AmountField } from '../order/AmountField';
import { MAX_USD, MIN_USD } from '../order/limits';
import { displayName } from '../order/plain';
import { rememberPlan } from '../order/plan-store';
import { onMock } from '../order/readiness';
import { unitsFor } from '../order/units';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { useFailureText } from './failure';
import { MixLines, type MixRow } from './MixLines';
import { MixReviewCard, useTicks } from './MixReviewCard';
import { acceptedOf, cashLeft, mixOf, sameMix } from './mix';
import { acceptGoalMix } from './mix-api';
import { linesOf, WeightEditor, type Weights, weightsOf } from './WeightEditor';

// The deposit step of a new goal (gate DEPOSIT-STEP): after the conversation proposes a mix, one
// amount is typed and one press leads to the server's review, its ticks, and the buy screen, where the
// order is signed. Nothing is signed here. There is no form: the mix is the conversation's and is
// changed there, the amount starts from the sum the person wrote there, the goal and the risk are the
// ones the person said there, and one they did not say is worked out by the server from the mix and
// said as such (gate DEPOSIT-DERIVE): nothing is asked here. What the amount becomes in each asset is
// the server's own check of this mix at this amount, never worked out on this screen. Editing a weight
// by hand is behind its own control, closed until asked for, and a mix edited that way is marked and
// is the one checked.

export type Goal = 'grow' | 'income' | 'protect';
export type Risk = 'low' | 'medium' | 'high';
/** What the person said in the conversation, as the server served it. Null: not said. */
export type Purpose = { goal: Goal | null; risk: Risk | null };

/** The amounts one tap types. They are amounts to type, not figures of anybody's. */
export const QUICK_USD = [100, 500, 1000] as const;
/** How long the amount has to be still before the server is asked what it becomes in each asset. */
export const CHECK_MS = 500;

type Checked =
  | { key: string; review: MixReview }
  | { key: string; failure: string; invalid: boolean };

export function DepositStep({
  chain,
  userId,
  allocations,
  said,
  amountText,
  onAmountText,
  provenance,
  onChangeMix,
  onClose,
  waiting = false,
}: {
  chain: ChainId;
  userId: string;
  allocations: readonly (MixLine & { symbol?: string })[];
  /**
   * The goal and risk the person said in the conversation. Null is sent as not said, and the server
   * works it out from the mix (DEPOSIT-DERIVE); this screen never fills one in.
   */
  said: Purpose;
  /** The amount as typed, kept by the host so another proposal does not empty it. */
  amountText: string;
  onAmountText: (text: string) => void;
  /** What the chain's figures are, for the card's sample mark. */
  provenance: Provenance | null;
  /** Back to the conversation's box, with this proposal kept: weights are changed by saying so. */
  onChangeMix: () => void;
  /** Back to the proposal as the conversation showed it. */
  onClose: () => void;
  /** The conversation is working on a reply: the mix may be about to change, so no review starts. */
  waiting?: boolean;
}) {
  const t = useT();
  const lang = useLang();
  const d = t.mix.deposit;
  const api = useApiFetch();
  const port = useWalletPort();
  const router = useRouter();
  const failureText = useFailureText();
  const titleId = useId();
  const editorId = useId();
  const reasonId = useId();
  const [weights, setWeights] = useState<Weights | null>(null);
  const [editing, setEditing] = useState(false);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [review, setReview] = useState<MixReview | null>(null);
  const [changed, setChanged] = useState(false);
  const [ticked, tick] = useTicks(review);
  const [busy, setBusy] = useState(false);
  // The plan is stored and the next screen is on its way: the button says so until the route changes.
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  // The amount has been still for a moment, or the field was left: only then is it said to be wrong.
  const [settled, setSettled] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const focus = (selector: string) => root.current?.querySelector<HTMLElement>(selector)?.focus();
  // The step opens with the one thing to type. Focus never falls to the page when a screen changes.
  // An amount filled in from the conversation is selected, so what the person types replaces it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the step opens
  useEffect(() => {
    focus('[data-ui="amount-large"] input');
    root.current?.querySelector<HTMLInputElement>('[data-ui="amount-large"] input')?.select();
  }, []);
  // From the review back to the step: the press that led there.
  const reviewing = review !== null;
  const wasReviewing = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `focus` reads a ref
  useEffect(() => {
    if (wasReviewing.current && !reviewing) focus('[data-action="deposit-review"]');
    wasReviewing.current = reviewing;
  }, [reviewing]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a pause after each change of the text
  useEffect(() => {
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), CHECK_MS);
    return () => clearTimeout(timer);
  }, [amountText]);

  // Read as the buy screen reads an amount: in Portuguese "100,50" is a hundred dollars and fifty cents.
  const typed = parseNumber(amountText, lang);
  const amount = typed !== null && typed >= MIN_USD && typed <= MAX_USD ? typed : null;
  const amountError =
    (!amountText.trim() || !settled) && !tried
      ? undefined
      : typed === null || Number.isNaN(typed)
        ? d.errors.notAmount
        : typed < MIN_USD
          ? d.errors.belowMin
          : typed > MAX_USD
            ? d.errors.aboveMax
            : undefined;

  const mock = onMock(port, chain);
  const units = unitsFor(chain, mock);
  const cash = units?.cash ?? null;
  const start = allocations
    .filter((line) => line.assetId !== cash)
    .map(({ assetId, weightBps }) => ({ assetId, weightBps }));
  const shown = weights ?? weightsOf(start);
  const lines = cash ? linesOf(shown, cash) : null;
  // Edited means the person changed a weight, whether or not the weights add up yet.
  const edited = weights !== null && !(lines !== null && sameMix(lines, start));
  const broken = weights !== null && lines === null;

  const body =
    amount !== null && lines && cash
      ? {
          version: 1 as const,
          origin: edited ? ('person' as const) : ('model' as const),
          language: lang,
          goal: said.goal,
          risk: said.risk,
          amountUsd: amount,
          allocations: mixOf(lines, cash),
        }
      : null;
  const key = body ? JSON.stringify(body) : null;
  const sending = useRef({ key, body, failureText });
  sending.current = { key, body, failureText };

  // What the amount becomes in each asset: asked of the server once the amount and the weights have
  // been still for a moment. Only the answer to what is on the screen now is shown.
  useEffect(() => {
    if (key === null || review) return;
    const timer = setTimeout(async () => {
      const asked = sending.current.body;
      if (!asked) return;
      const answer = await acceptGoalMix(api, chain, {
        ...asked,
        confirm: false,
        acceptedWarnings: [],
      });
      // An answer about what is no longer on the screen is nobody's.
      if (sending.current.key !== key) return;
      setChecked((old) =>
        old?.key === key && 'review' in old
          ? old
          : answer.kind === 'ok'
            ? { key, review: answer.value.review }
            : {
                key,
                failure: sending.current.failureText(answer),
                invalid: answer.kind === 'invalid',
              },
      );
    }, CHECK_MS);
    return () => clearTimeout(timer);
    // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for everything that is sent
  }, [key, review, api, chain]);

  const current = checked && checked.key === key ? checked : null;
  const live = current && 'review' in current ? current.review : null;
  const refused = current && 'failure' in current ? current : null;

  async function toReview() {
    setTried(true);
    setFailure(null);
    if (!body || !key) return;
    if (live) {
      setChanged(false);
      return setReview(live);
    }
    setBusy(true);
    const answer = await acceptGoalMix(api, chain, {
      ...body,
      confirm: false,
      acceptedWarnings: [],
    });
    setBusy(false);
    // The step is locked while this runs; an answer about anything else is still dropped.
    if (sending.current.key !== key) return;
    if (answer.kind !== 'ok')
      return setChecked({
        key,
        failure: failureText(answer),
        invalid: answer.kind === 'invalid',
      });
    setChecked({ key, review: answer.value.review });
    setChanged(false);
    setReview(answer.value.review);
  }

  async function confirm() {
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
    setOpening(true);
    router.push(`/plan/${encodeURIComponent(proposalId)}/buy`);
  }

  // The goal and risk as one sentence: the server's, once it has checked this mix, which names what it
  // worked out from the mix; until then only what the person said, and nothing where they said neither.
  const purposeOf = (r: MixReview) =>
    [
      d.purpose(r.goal, r.risk ?? said.risk),
      r.fromMix?.length ? d.fromMix(r.fromMix.includes('goal'), r.fromMix.includes('risk')) : '',
    ]
      .filter(Boolean)
      .join(' ');
  const purpose = live ? purposeOf(live) : d.purpose(said.goal, said.risk);

  if (review)
    return (
      <div ref={root} data-ui="deposit-review" className="flex min-w-0 flex-col gap-4">
        <MixReviewCard
          review={review}
          ticked={ticked}
          onTick={tick}
          confirmLabel={t.mix.goal.confirm}
          busyLabel={opening ? t.mix.goal.opening : t.mix.goal.confirming}
          onConfirm={confirm}
          onBack={() => setReview(null)}
          backLabel={d.backToDeposit}
          purpose={purposeOf(review)}
          focusOnOpen
          busy={busy}
          changed={changed}
        />
        {failure && (
          <p
            role="alert"
            className="max-w-(--tf-measure-body) whitespace-pre-line text-body-sm text-destructive"
          >
            {failure}
          </p>
        )}
      </div>
    );

  const nameOf = (asset: string) =>
    allocations.find((line) => line.assetId === asset)?.symbol ??
    units?.tokens[asset]?.symbol ??
    displayName(asset, t.plan);
  const dollarsOf = (asset: string) =>
    live?.lines.find((line) => line.assetId === asset)?.amountUsd ?? null;
  const held = (lines ?? start).filter((line) => line.weightBps > 0);
  const left = cashLeft(held);
  const rows: MixRow[] = [
    ...held.map((line) => ({
      assetId: line.assetId,
      name: nameOf(line.assetId),
      weightBps: line.weightBps,
      amountUsd: dollarsOf(line.assetId),
    })),
    ...(cash && left > 0
      ? [{ assetId: cash, name: t.mix.review.cash, weightBps: left, amountUsd: dollarsOf(cash) }]
      : []),
  ];
  // Why the press does nothing yet, in the order a person would fix it.
  const blocked = !cash
    ? t.mix.failure.readOnly
    : waiting
      ? d.blocked.reply
      : !lines
        ? d.blocked.weights
        : amount === null
          ? d.blocked.amount
          : null;
  const status = refused
    ? null
    : live
      ? d.checked
      : key !== null
        ? d.checking
        : amount === null
          ? amountError
            ? null
            : d.needAmount
          : null;

  return (
    <div ref={root} data-ui="deposit-step" className="min-w-0">
      <Card
        as="section"
        aria-labelledby={titleId}
        mock={provenance !== null && provenance !== 'live'}
        mockLabels={{
          announce: provenance === 'mock' ? t.shell.mockAnnounce : t.shell.testNetworkLine,
        }}
      >
        <CardHeader id={titleId} title={d.title} level={2} meta={t.chain.names[chain]} />
        <CardBody className="flex min-w-0 flex-col gap-5">
          {purpose && (
            <p
              data-ui="deposit-purpose"
              className="flex flex-wrap items-baseline gap-x-3 text-body"
            >
              <span>{purpose}</span>
              <Button variant="link" aria-label={d.changePurposeLabel} onClick={onChangeMix}>
                {d.changePurpose}
              </Button>
            </p>
          )}

          <div inert={busy} className="flex min-w-0 flex-col gap-2">
            <AmountField
              large
              disabled={busy}
              onBlur={() => setSettled(true)}
              text={amountText}
              onText={onAmountText}
              hint={d.limits}
              value={amount}
              {...(cash && units?.tokens[cash] ? { unit: units.tokens[cash].symbol } : {})}
              {...(amountError ? { error: amountError } : {})}
            />
            <ul aria-label={d.quick} data-ui="deposit-quick" className="flex flex-wrap gap-2">
              {QUICK_USD.map((usd) => (
                <li key={usd}>
                  <Button
                    variant="chip"
                    aria-label={d.quickOne(dollars(usd, lang))}
                    onClick={() => onAmountText(String(usd))}
                  >
                    {dollars(usd, lang)}
                  </Button>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <h3 className="flex flex-wrap items-baseline gap-x-3 text-caption font-medium">
              {d.mix}
              {edited && (
                <span data-ui="deposit-edited" className="font-normal text-muted-foreground">
                  {d.edited}
                </span>
              )}
            </h3>
            {broken ? (
              <p data-ui="deposit-broken" className="text-body-sm">
                {d.brokenMix}
              </p>
            ) : (
              <MixLines rows={rows} caption={d.mix} amounts />
            )}
            {status && !broken && (
              <p
                role="status"
                data-ui="deposit-check"
                className="text-caption text-muted-foreground"
              >
                {status}
              </p>
            )}
            {refused && (
              <div
                role="alert"
                data-ui="deposit-refused"
                className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
              >
                <StatusMark status="off-track" size={12} className="mt-1.5" />
                <p className="whitespace-pre-line">
                  {refused.failure}
                  {refused.invalid && `\n${d.invalidNext}`}
                </p>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <Button
                variant="primary"
                data-action="deposit-review"
                busy={busy}
                busyLabel={d.reviewing}
                busyMark
                disabled={blocked !== null}
                aria-describedby={blocked !== null && tried ? reasonId : undefined}
                onDisabledClick={() => setTried(true)}
                onClick={toReview}
              >
                {amount === null ? d.review : d.reviewOf(dollars(amount, lang))}
              </Button>
              <Button variant="secondary" data-action="change-mix" onClick={onChangeMix}>
                {d.changeMix}
              </Button>
            </div>
            {blocked !== null && tried && (
              <p id={reasonId} role="status" className="text-body-sm">
                {blocked}
              </p>
            )}
            <p className="max-w-(--tf-measure-body) text-caption text-muted-foreground">
              {d.next} {d.balance}
            </p>
          </div>

          {cash && (
            <div className="flex min-w-0 flex-col gap-3 border-t border-border pt-4">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <Button
                  variant="link"
                  data-action="edit-by-hand"
                  aria-expanded={editing}
                  aria-controls={editorId}
                  onClick={() => setEditing((open) => !open)}
                >
                  {d.editByHand}
                </Button>
                {edited && (
                  <Button variant="link" data-action="reset-mix" onClick={() => setWeights(null)}>
                    {d.reset}
                  </Button>
                )}
                <Button variant="link" onClick={onClose}>
                  {d.backToProposal}
                </Button>
              </div>
              <div
                id={editorId}
                hidden={!editing}
                inert={busy}
                className="flex min-w-0 flex-col gap-3"
              >
                {editing && (
                  <>
                    <p className="max-w-(--tf-measure-body) text-body-sm">{d.editorLead}</p>
                    <WeightEditor
                      plain
                      chain={chain}
                      mock={mock}
                      cash={cash}
                      value={shown}
                      onChange={setWeights}
                      names={Object.fromEntries(
                        allocations.flatMap((line) =>
                          line.symbol ? [[line.assetId, line.symbol]] : [],
                        ),
                      )}
                    />
                  </>
                )}
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
