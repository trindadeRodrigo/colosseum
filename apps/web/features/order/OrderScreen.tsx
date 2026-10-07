'use client';
import {
  type ConsentKind,
  chainFamily,
  type Leg,
  type OrderDetail,
  type Trade,
} from '@colosseum/schemas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader, Stat, StatRow } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { CopyButton } from '../../components/ui/CopyButton';
import { ExplorerLink } from '../../components/ui/ExplorerLink';
import { PAGE_TITLE } from '../../components/ui/heading';
import { SkeletonSummary } from '../../components/ui/Skeleton';
import { StatusMark } from '../../components/ui/StatusMark';
import { type Dictionary, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { dollars } from '../goal/sheet';
import { utc } from '../portfolio/figures';
import { readPersonPlans, recordsOfPlans } from '../portfolio/server-plans';
import { SharedReview } from '../shared/SharedReview';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { formatBps, formatRaw, shortfallBps, tokenName } from './amounts';
import { type CallFailure, continueOrder, continuesOrders, readOrder } from './order-api';
import {
  checkContinuation,
  checkDeposit,
  checkFamilyBuy,
  type DepositCheck,
  depositLanded,
  leftOfApproved,
  leftOfPlan,
  sharedShapeOk,
  stoppedShort,
} from './order-check';
import { isBuy, keepOrder, type OrderRecord, recallOrder } from './order-record';
import { legsInOrder, type NextStep, type OutcomeView, outcomeView, stepOf } from './order-view';
import { readStoredPlan } from './plan-store';
import { targetsOfPlan } from './plan-terms';
import { chainReady, explorerUrlFor, onMock } from './readiness';
import { type RunOutcome, useOrderRunner } from './run-order';
import { type ChainUnits, unitsFor } from './units';

// The order: the review of every step, then signing it, then each step's status as it lands. The
// review shows the order as the API made it; when the person presses the button that order, exactly as
// shown, is kept with the consents they ticked, and every run is handed that and nothing read later.
// The signing is `execute()` of @colosseum/sdk through run-order.ts: this screen never holds the wallet's
// signing members, only the answer. Status changes are said in an aria-live region, with the explorer
// link of each landed step.

type Load = { kind: 'loading' } | { kind: 'read'; order: OrderDetail } | { kind: CallFailure };

/** Why an order is not offered for signing, or that it may be, with what it deposits. */
type Check = DepositCheck | { ok: false; why: 'trades' | 'shape' };

/**
 * Before an order is offered for signing (order-check.ts): a buy of a plan deposits what was typed; a
 * buy of a shared portfolio does too, and spends it on the weights its screen read; a follow and a
 * publish move nothing and have only the steps their terms call for.
 */
function checkOf(order: OrderDetail, record: OrderRecord, units: ChainUnits | null): Check {
  const terms = record.terms;
  // An order that finishes another deposits nothing: it is held to the trades that one left.
  if (record.continues)
    return checkContinuation(order, record.continues, units, order !== record.approved?.order);
  if (!terms) return checkDeposit(order, record.amountUsd, units);
  if (terms.kind === 'family') return checkFamilyBuy(order, record.amountUsd, units, terms.targets);
  return sharedShapeOk(order, terms)
    ? { ok: true, depositRaw: 0n, decimals: 0 }
    : { ok: false, why: 'shape' };
}
type Phase = { legId: string; phase: string } | null;

export function OrderScreen({ id }: { id: string }) {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const { account } = useAccount();
  const apiFetch = useApiFetch();
  const { run } = useOrderRunner();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [record, setRecord] = useState<OrderRecord | null | undefined>(undefined);
  const [live, setLive] = useState<OrderDetail | null>(null);
  const [phase, setPhase] = useState<Phase>(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [consents, setConsents] = useState<ConsentKind[]>([]);
  const [round, setRound] = useState(0);
  const stop = useRef({ aborted: false });
  const router = useRouter();
  // Whether this server finishes a buy with the cash in its vault: asked only once an order has
  // stopped after its deposit, and the button is not there until the answer is yes.
  const [canFinish, setCanFinish] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishFailure, setFinishFailure] = useState<string | null>(null);
  const titleId = useId();
  const reasonId = useId();
  const userId = port.userId;

  useEffect(() => {
    setRecord(recallOrder(id, userId));
  }, [id, userId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads the order again
  useEffect(() => {
    if (port.status !== 'ready') return;
    let mine = true;
    setLoad({ kind: 'loading' });
    readOrder(apiFetch, id).then((read) => {
      if (mine) setLoad(read);
    });
    return () => {
      mine = false;
    };
  }, [id, apiFetch, port.status, round]);

  // An order that stopped for good is the one case a buy may be finished from: only then is the
  // server asked whether it can. Stopped as this page just saw it, or as the order itself says when
  // the page is opened again, here or in another browser.
  const stopped =
    outcome?.status === 'refused' || outcome?.status === 'failed' || outcome?.status === 'expired';
  const seen = live ?? (load.kind === 'read' ? load.order : null);
  const short = seen !== null && stoppedShort(seen);
  useEffect(() => {
    if (!stopped && !short) return;
    let mine = true;
    void continuesOrders(apiFetch).then((yes) => {
      if (mine) setCanFinish(yes);
    });
    return () => {
      mine = false;
    };
  }, [stopped, short, apiFetch]);

  // An order this browser did not make, stopped after its deposit: its plan as the server stores it
  // (the list of the person's plans, then the plan's lines), to finish the buy from here too. Nothing
  // of the first order is offered for signing from it: an order is signed where it was reviewed.
  const [served, setServed] = useState<OrderRecord | null | undefined>(undefined);
  useEffect(() => {
    if (record !== null || load.kind !== 'read' || !userId) return;
    if (!depositLanded(load.order) || !stoppedShort(load.order)) return setServed(null);
    let mine = true;
    setServed(undefined);
    void (async () => {
      const listed = recordsOfPlans(await readPersonPlans(apiFetch), userId).find(
        (r) => r.orderId === id,
      );
      const plan = listed ? await readStoredPlan(apiFetch, listed.proposalId) : null;
      if (mine)
        setServed(
          listed && plan && plan !== 'gone' ? { ...listed, lines: plan.proposal.lines } : null,
        );
    })();
    return () => {
      mine = false;
    };
  }, [record, load, userId, id, apiFetch]);

  /**
   * Makes the order that finishes `first` (the order of `from`) with the cash in its vault, held to
   * `trades`, and opens its review. `first` is what the answer is held to for owner, vault and chain:
   * the copy approved here, or the server's own in a browser that never reviewed it (`unseen`), which
   * the new order's review then says.
   */
  async function finish(
    from: OrderRecord,
    first: Pick<OrderDetail, 'id' | 'owner' | 'basketId' | 'legs'>,
    trades: Trade[],
    unseen: boolean,
  ) {
    if (finishing) return;
    setFinishing(true);
    setFinishFailure(null);
    const o = t.order.outcome;
    const made = await continueOrder(apiFetch, first);
    if (made.kind !== 'placed') {
      setFinishing(false);
      if (made.kind === 'unavailable') return setCanFinish(false);
      setFinishFailure(
        made.kind === 'refused'
          ? made.priceMoved
            ? o.finishPriceMoved
            : made.retryable
              ? o.finishLater
              : o.finishRefused(made.sentence)
          : made.kind === 'busy'
            ? t.shell.slowDown
            : made.kind === 'signed-out'
              ? t.buy.failure.signedOut
              : made.kind === 'unreadable'
                ? t.buy.failure.unreadable
                : t.buy.failure.unreachable,
      );
      return;
    }
    // The new order's record: the same plan and vault, nothing approved yet, and what it is held to.
    const kept = keepOrder({
      orderId: made.order.id,
      userId: from.userId,
      proposalId: from.proposalId,
      chain: from.chain,
      amountUsd: from.amountUsd,
      lines: from.lines,
      approved: null,
      ...(from.linked ? { linked: true as const } : {}),
      continues: { orderId: from.orderId, trades, ...(unseen ? { unseen: true as const } : {}) },
    });
    if (!kept) {
      setFinishing(false);
      return setFinishFailure(t.buy.failure.noStore);
    }
    router.push(`/orders/${encodeURIComponent(made.order.id)}`);
  }

  // Leaving the page stops the run between steps; what was signed is still reported.
  useEffect(() => {
    const signal = stop.current;
    return () => {
      signal.aborted = true;
    };
  }, []);

  const go = useCallback(
    async (again?: { legId: string; signedTimes: number }) => {
      if (!record) return;
      // The order as the review screen showed it, kept from the moment the person approved it.
      let approved = record.approved;
      // Never run an order that does not deposit what the person typed (order-check.ts).
      const order = approved?.order ?? (load.kind === 'read' ? load.order : null);
      if (!order || !checkOf(order, record, unitsFor(record.chain, onMock(port, record.chain))).ok)
        return;
      if (!approved) {
        if (load.kind !== 'read') return;
        approved = { order: load.order, consents, at: new Date().toISOString() };
        const next = { ...record, approved };
        if (!keepOrder(next)) {
          setOutcome({ status: 'not-runnable', why: 'no-store' });
          return;
        }
        setRecord(next);
      }
      stop.current = { aborted: false };
      setRunning(true);
      setOutcome(null);
      const answer = await run({
        order: approved.order,
        plan: {
          proposalId: record.proposalId,
          lines: record.lines,
          userId: record.userId,
          ...(record.linked ? { linked: true } : {}),
        },
        ...(record.terms ? { terms: record.terms } : {}),
        consents: approved.consents,
        ...(again ? { approvedAgain: again } : {}),
        onEvent: (event) => {
          setLive(event.order);
          setPhase({ legId: event.legId, phase: event.phase });
        },
        signal: stop.current,
      });
      if ('order' in answer) setLive(answer.order);
      setPhase(null);
      setOutcome(answer);
      setRunning(false);
    },
    [record, load, consents, run, port],
  );

  if (port.status === 'loading' || account.status === 'loading' || record === undefined)
    return (
      <Card>
        <CardWait label={t.order.loading} skeleton={<SkeletonSummary />} />
      </Card>
    );
  if (port.status === 'signed-out')
    return (
      <Notice
        title={t.order.title}
        body={t.order.signedOut}
        href={`/sign-in?next=/orders/${encodeURIComponent(id)}`}
        label={t.shell.signIn}
      />
    );
  if (load.kind === 'loading')
    return (
      <Card>
        <CardWait label={t.order.loading} skeleton={<SkeletonSummary />} />
      </Card>
    );
  if (load.kind !== 'read') {
    const body =
      load.kind === 'no-plan' || load.kind === 'signed-out'
        ? t.order.failure.notFound
        : load.kind === 'busy'
          ? t.shell.slowDown
          : load.kind === 'unreadable'
            ? t.order.failure.unreadable
            : t.order.failure.unreachable;
    return (
      <section aria-labelledby={titleId} className="flex flex-col items-start gap-4">
        <h1 id={titleId} className={PAGE_TITLE}>
          {t.order.title}
        </h1>
        <p className="max-w-(--tf-measure-body) text-body">{body}</p>
        <Button variant="secondary" onClick={() => setRound((n) => n + 1)}>
          {t.order.failure.retry}
        </Button>
      </section>
    );
  }
  if (!record) {
    const first = load.order;
    // Made in another browser and stopped after its deposit: the cash is in the vault, and the buy
    // can be finished from here. Anything else of it is signed where it was reviewed.
    if (depositLanded(first) && stoppedShort(first)) {
      if (served === undefined)
        return (
          <Card>
            <CardWait label={t.order.loading} skeleton={<SkeletonSummary />} />
          </Card>
        );
      const units = served ? unitsFor(served.chain, onMock(port, served.chain)) : null;
      const cash = units?.tokens[units.cash];
      const targets =
        served && units ? targetsOfPlan(served.lines, served.chain, units.cash) : null;
      // What is left, as the server lists it, held to the plan's lines read from the server.
      const trades = units && targets ? leftOfPlan(first, targets, units.cash) : null;
      const offer =
        canFinish &&
        served &&
        trades !== null &&
        trades.length > 0 &&
        chainFamily(served.chain) !== 'evm';
      const put =
        cash && first.depositRaw !== undefined
          ? dollars(Number(first.depositRaw) / 10 ** cash.decimals, lang)
          : null;
      return (
        <section
          aria-labelledby={titleId}
          data-ui="order-stopped-elsewhere"
          className="flex flex-col items-start gap-4"
        >
          <h1 id={titleId} className={PAGE_TITLE}>
            {t.order.title}
          </h1>
          <p data-ui="order-deposit-kept" className="max-w-(--tf-measure-body) text-body">
            {put ? t.order.outcome.stopped(put) : t.order.outcome.depositKept}
          </p>
          {offer && (
            <p data-ui="order-unseen" className="max-w-(--tf-measure-body) text-body-sm">
              {t.order.outcome.finishNote} {t.order.review.unseen}
            </p>
          )}
          <div data-ui="order-stopped" className="flex flex-wrap items-center gap-3">
            {offer && (
              <Button
                variant="primary"
                busy={finishing}
                busyLabel={t.order.outcome.finishing}
                onClick={() => finish(served, first, trades, true)}
              >
                {t.order.outcome.finish}
              </Button>
            )}
            <Link
              href="/monitor"
              className={buttonClass({ variant: offer ? 'secondary' : 'primary' })}
            >
              {t.order.outcome.seePortfolio}
            </Link>
          </div>
          {finishFailure && (
            <p
              role="alert"
              className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
            >
              <StatusMark status="off-track" size={12} className="mt-1.5" />
              <span>{finishFailure}</span>
            </p>
          )}
        </section>
      );
    }
    return (
      <Notice
        title={t.order.title}
        body={t.order.elsewhere}
        href="/goal"
        label={t.plan.backToGoal}
      />
    );
  }

  const shown = record.approved?.order ?? load.order;
  const now = live ?? load.order;
  const chain = record.chain;
  // Every amount on this screen is the order's own, read with units this repository committed, and the
  // order is offered for signing only when it deposits what the person typed (order-check.ts).
  const units = unitsFor(chain, onMock(port, chain));
  const check = checkOf(shown, record, units);
  const buying = isBuy(record);
  const amount = check.ok
    ? dollars(Number(check.depositRaw) / 10 ** check.decimals, lang)
    : dollars(record.amountUsd, lang);
  const cash = units?.tokens[units.cash];
  const depositShown =
    shown.depositRaw === undefined
      ? '—'
      : cash
        ? `${formatRaw(shown.depositRaw, cash.decimals, LOCALE[lang]) ?? shown.depositRaw} ${cash.symbol}`
        : shown.depositRaw;
  const legs = legsInOrder(shown);
  const done = now.status === 'done';
  const view: OutcomeView | null = outcome ? outcomeView(outcome, t, chain) : null;
  const needed = shown.needsConsent;
  const consentMissing = !record.approved && needed.some((kind) => !consents.includes(kind));
  const current = phase ? stepOf(shown, phase.legId) : 1;
  const terms = record.terms;
  const newOrder = !terms
    ? `/plan/${encodeURIComponent(record.proposalId)}/buy`
    : terms.kind === 'family'
      ? `/indexes/${encodeURIComponent(terms.slug)}/buy`
      : terms.kind === 'follow'
        ? `/indexes/${encodeURIComponent(terms.slug)}`
        : '/publish';
  const testNetwork = shown.legs[0]?.provenance === 'sandbox';
  // The swaps the order left undone: what an order that finishes it would make, and is held to.
  // The trades are the approved order's own, step by step: of the API's later answer only where each
  // step stands is read, so an answer that changed a trade cannot widen what the next order may buy.
  const left = leftOfApproved(record.approved?.order ?? { legs: [] }, now);
  // A deposit that landed stays in the vault as cash, whatever became of the steps after it.
  const deposited = depositLanded(now);

  // Stopped for good with swaps left and their cash in the vault: after this order's deposit landed,
  // or, for an order that finishes another, with the cash that one left. Said by the run that just
  // stopped, or by the order itself when the page is opened again. Where the server can finish it,
  // that is offered first (the flow audit, finding 24). Not on an EVM chain: the route refuses those.
  const halted = !view && !running && stoppedShort(now);
  const stranded =
    !done &&
    !running &&
    (deposited || record.continues !== undefined) &&
    !terms &&
    left.length > 0 &&
    chainFamily(chain) !== 'evm' &&
    (view?.next.kind === 'new-order' || halted);
  // Opened again on an order that goes no further: there is nothing of it left to sign.
  const over = stranded && halted;
  const offerFinish = stranded && canFinish;

  // The one primary button of the view: sign, carry on, approve a step again, or nothing.
  const next: NextStep | { kind: 'first' } =
    view?.next ?? (record.approved ? { kind: 'run' } : { kind: 'first' });
  const primaryLabel =
    next.kind === 'approve-again'
      ? t.order.outcome.approveAgain(next.step)
      : next.kind === 'run' && view && outcome?.status === 'waiting'
        ? t.order.outcome.lookAgain
        : next.kind === 'run' && view
          ? t.order.outcome.tryAgain
          : terms?.kind === 'publish'
            ? record.approved
              ? t.order.shared.resume
              : t.order.shared.signPublish
            : terms?.kind === 'follow'
              ? record.approved
                ? t.order.shared.resume
                : t.order.shared.signFollow
              : record.approved
                ? t.order.resume(amount)
                : t.order.signAndBuy(amount);

  return (
    <div data-ui="order-screen" className="flex flex-col gap-8">
      <header className="flex flex-col items-start gap-3">
        <ChainBadge chain={chain} />
        <h1 id={titleId} className={PAGE_TITLE}>
          {record.approved ? t.order.title : t.order.review.title}
        </h1>
        {!record.approved && (
          <p
            data-ui={record.continues ? 'order-continues' : undefined}
            className="max-w-(--tf-measure-body) text-body-lg"
          >
            {record.continues ? t.order.review.continuesLead : t.order.review.lead}
          </p>
        )}
        {record.continues?.unseen && (
          <p data-ui="order-unseen" className="max-w-(--tf-measure-body) text-body-sm">
            {t.order.review.unseen}
          </p>
        )}
      </header>

      <Card
        as="section"
        aria-label={t.order.stepsTitle}
        mock={shown.legs[0]?.provenance !== 'live'}
        mockLabels={{
          announce: testNetwork ? t.shell.testNetworkLine : t.shell.mockAnnounce,
        }}
      >
        <CardHeader title={t.order.stepsTitle} level={2} meta={<ChainBadge chain={chain} />} />
        <CardBody className="flex flex-col gap-4">
          <StatRow>
            {/* an order that finishes another deposits nothing */}
            {buying && !record.continues && (
              <Stat label={t.order.review.deposit}>{depositShown}</Stat>
            )}
            {record.continues && check.ok && <Stat label={t.order.review.fromVault}>{amount}</Stat>}
            <Stat label={t.order.review.steps}>{legs.length}</Stat>
            {!record.approved && (
              <Stat label={t.order.review.expires} className="max-[620px]:col-span-2">
                <time dateTime={new Date(shown.expiresAt * 1000).toISOString()}>
                  {/* the one way this app writes a time: the date, the minute and the zone */}
                  {utc(lang, shown.expiresAt)}
                </time>
              </Stat>
            )}
          </StatRow>
          <ol className="flex flex-col divide-y divide-border">
            {legs.map((leg, i) => {
              const standing = now.legs.find((l) => l.id === leg.id) ?? leg;
              return (
                <Step
                  key={leg.id}
                  n={i + 1}
                  leg={leg}
                  now={standing}
                  phase={phase?.legId === leg.id ? phase.phase : null}
                  units={units}
                  explorer={t.chain.explorers[chain]}
                  mock={onMock(port, chain)}
                  money={(value) => dollars(value, lang)}
                  t={t}
                  locale={LOCALE[lang]}
                />
              );
            })}
          </ol>
        </CardBody>
      </Card>

      {terms && <SharedReview terms={terms} chain={chain} />}

      {shown.warnings.length > 0 && (
        <section aria-label={t.order.review.warnings} className="flex flex-col gap-2">
          <h2 className="text-h4 font-semibold">{t.order.review.warnings}</h2>
          <ul className="flex max-w-(--tf-measure-body) list-disc flex-col gap-1 pl-5 text-body-sm">
            {shown.warnings.map((w) => (
              <li key={w.code}>{w.text}</li>
            ))}
          </ul>
        </section>
      )}

      {!record.approved && needed.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-2 text-h4 font-semibold">{t.order.review.consents}</legend>
          {needed.map((kind) => (
            <label key={kind} className="inline-flex items-start gap-2 text-body">
              <input
                type="checkbox"
                className="mt-1.5 size-4 accent-primary"
                checked={consents.includes(kind)}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setConsents((all) =>
                    on ? [...all.filter((k) => k !== kind), kind] : all.filter((k) => k !== kind),
                  );
                }}
              />
              <span className="max-w-(--tf-measure-body)">{t.order.review.consent[kind]}</span>
            </label>
          ))}
        </fieldset>
      )}

      <div aria-live="polite" data-ui="order-status" className="flex flex-col gap-2">
        {running && phase && (
          <p className="text-body">
            {t.order.step(current)}:{' '}
            {t.order.phase[phase.phase as keyof Dictionary['order']['phase']]}
          </p>
        )}
        {!running && done && !view && (
          <p className="text-body">{t.order.outcome.done(t.chain.names[chain])}</p>
        )}
        {over && (
          <p data-ui="order-deposit-kept" className="max-w-(--tf-measure-body) text-body">
            {t.order.outcome.stopped(amount)}
          </p>
        )}
        {view && (
          <div className="flex max-w-(--tf-measure-body) flex-col gap-1">
            <p
              className={
                view.alarm ? 'flex items-start gap-1.5 text-body text-destructive' : 'text-body'
              }
            >
              {view.alarm && <StatusMark status="off-track" size={12} className="mt-1.5" />}
              <span>{view.sentence}</span>
            </p>
            {!done && deposited && view.next.kind === 'new-order' && (
              <p data-ui="order-deposit-kept" className="text-body">
                {stranded ? t.order.outcome.stopped(amount) : t.order.outcome.depositKept}
              </p>
            )}
            {/* The check that failed and the guard's own words are for the team: behind a fold. */}
            {(view.check || view.detail) && (
              <details data-ui="order-support">
                <summary className="cursor-pointer text-body-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  {t.order.outcome.forSupport}
                </summary>
                {view.check && (
                  <p className="mt-1 font-mono text-source text-muted-foreground">{view.check}</p>
                )}
                {view.detail && (
                  <p className="font-mono text-source text-muted-foreground break-words">
                    {view.detail}
                  </p>
                )}
              </details>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col items-start gap-2">
        {!check.ok && (
          <p
            role="alert"
            className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body text-destructive"
          >
            <StatusMark status="off-track" size={12} className="mt-1.5" />
            <span>
              {check.why === 'units' && !chainReady(chain, onMock(port, chain))
                ? t.order.outcome.notRunnable['no-deployment'](t.chain.names[chain])
                : t.order.mismatch[check.why]}
            </span>
          </p>
        )}
        {check.ok &&
          !done &&
          !over &&
          next.kind !== 'none' &&
          next.kind !== 'new-order' &&
          next.kind !== 'other-order' && (
            <Button
              variant="primary"
              busy={running}
              busyLabel={t.order.signing(current, legs.length)}
              disabled={consentMissing}
              aria-describedby={consentMissing ? reasonId : undefined}
              onClick={() =>
                go(
                  next.kind === 'approve-again'
                    ? { legId: next.legId, signedTimes: next.signedTimes }
                    : undefined,
                )
              }
            >
              {primaryLabel}
            </Button>
          )}
        {consentMissing && (
          <p id={reasonId} className="text-body-sm">
            {t.order.review.consentNeeded}
          </p>
        )}
        {(next.kind === 'new-order' || over) && (
          // With the deposit in the vault, that is where to look first, not at a second deposit.
          <div data-ui="order-stopped" className="flex flex-wrap items-center gap-3">
            {offerFinish && (
              <>
                <Button
                  variant="primary"
                  busy={finishing}
                  busyLabel={t.order.outcome.finishing}
                  onClick={() => finish(record, record.approved?.order ?? now, left, false)}
                >
                  {t.order.outcome.finish}
                </Button>
                <Link href="/monitor" className={buttonClass({ variant: 'secondary' })}>
                  {t.order.outcome.seePortfolio}
                </Link>
              </>
            )}
            {deposited && !offerFinish && (
              <Link href="/monitor" className={buttonClass({ variant: 'primary' })}>
                {t.order.outcome.seePortfolio}
              </Link>
            )}
            <Link
              href={newOrder}
              className={buttonClass({ variant: deposited ? 'secondary' : 'primary' })}
            >
              {t.order.outcome.newOrder}
            </Link>
          </div>
        )}
        {offerFinish && (
          <p data-ui="order-finish-note" className="max-w-(--tf-measure-body) text-body-sm">
            {t.order.outcome.finishNote}
          </p>
        )}
        {finishFailure && (
          <p
            role="alert"
            className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
          >
            <StatusMark status="off-track" size={12} className="mt-1.5" />
            <span>{finishFailure}</span>
          </p>
        )}
        {/* The order is done: the next step is the portfolio it filled, and another buy beside it. */}
        {done && !running && terms?.kind !== 'publish' && (
          <div data-ui="order-next" className="flex flex-wrap items-center gap-3">
            <Link href="/monitor" className={buttonClass({ variant: 'primary' })}>
              {t.order.outcome.seePortfolio}
            </Link>
            {buying && (
              <Link href={newOrder} className={buttonClass({ variant: 'secondary' })}>
                {t.order.outcome.buyMore}
              </Link>
            )}
          </div>
        )}
        {next.kind === 'other-order' && (
          <Link
            href={`/orders/${encodeURIComponent(next.orderId)}`}
            className={buttonClass({ variant: 'primary' })}
          >
            {t.order.outcome.blockedLink}
          </Link>
        )}
      </div>
    </div>
  );
}

function Notice({
  title,
  body,
  href,
  label,
}: {
  title: string;
  body: string;
  href: string;
  label: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col items-start gap-4">
      <h1 id={id} className={PAGE_TITLE}>
        {title}
      </h1>
      <p className="max-w-(--tf-measure-body) text-body">{body}</p>
      <Link href={href} className={buttonClass({ variant: 'secondary' })}>
        {label}
      </Link>
    </section>
  );
}

/** One step: what it does as the review showed it, and where it stands now. */
function Step({
  n,
  leg,
  now,
  phase,
  units,
  explorer,
  mock,
  money,
  t,
  locale,
}: {
  n: number;
  /** A dollar figure in the language of the page. */
  money: (value: number) => string;
  /** The explorer's name, for the link's accessible name. */
  explorer: string;
  /** The chain runs on the mock: its transactions are no network's, and link to the mock's own address. */
  mock: boolean;
  /** As the review showed it: what it may do. */
  leg: Leg;
  /** As the API last said: where it stands. */
  now: Leg;
  phase: string | null;
  /** What each token's raw amount means, from what this repository committed. */
  units: ChainUnits | null;
  t: Dictionary;
  locale: string;
}) {
  /** A raw amount of a token in whole units with its symbol, or null when its units are not known. */
  const whole = (raw: string, asset: string) => {
    const u = units?.tokens[asset];
    const figure = u ? formatRaw(raw, u.decimals, locale) : null;
    return u && figure !== null ? `${figure} ${u.symbol}` : null;
  };
  const spend = (raw: string) => (units ? whole(raw, units.cash) : null) ?? raw;
  /** A token by the symbol this repository committed for it, or its id on the chain where none is. */
  const symbol = (asset: string) => units?.tokens[asset]?.symbol ?? tokenName(asset);
  /** The most one token costs when the least is received: what is spent over that minimum. */
  const each = (spentRaw: string, minOutRaw: string, asset: string) => {
    const cash = units?.tokens[units.cash];
    const token = units?.tokens[asset];
    const least = Number(minOutRaw);
    if (!cash || !token || !(least > 0)) return null;
    const price = Number(spentRaw) / 10 ** cash.decimals / (least / 10 ** token.decimals);
    // A minimum too small to mean a price (a dust amount) gets none.
    return Number.isFinite(price) && price < 1e9 ? money(price) : null;
  };
  const status = phase
    ? t.order.phase[phase as keyof Dictionary['order']['phase']]
    : t.order.status[now.status];
  const failed = now.status === 'failed';
  return (
    <li data-ui="order-step" data-status={now.status} className="flex flex-col gap-1 py-3">
      <p className="flex flex-wrap items-baseline gap-x-2 text-body">
        <span className="font-medium">
          {t.order.step(n)} ·{' '}
          {leg.trades.length > 0 && leg.kind === 'create_vault'
            ? t.order.kind.create_vault_buy
            : leg.trades.length > 0 && leg.kind === 'deposit'
              ? t.order.kind.deposit_buy
              : t.order.kind[leg.kind]}
        </span>
        {leg.cashRaw && <span className="tabular-nums">{spend(leg.cashRaw)}</span>}
        <span aria-hidden="true">·</span>
        <span className={failed ? 'inline-flex items-center gap-1.5 text-status-off' : undefined}>
          {failed && <StatusMark status="off-track" />}
          {status}
          {failed && ` ${t.order.notRetried}`}
        </span>
        {now.txId && (
          <span className="ml-auto inline-flex items-center gap-2">
            <ExplorerLink
              signature={now.txId}
              href={explorerUrlFor(leg.chain, now.txId, mock)}
              explorer={explorer}
              labels={t.order.link}
            />
            <CopyButton value={now.txId} what={t.order.signature} />
          </span>
        )}
      </p>
      {leg.trades.length === 0 ? null : (
        <ul className="flex flex-col gap-0.5 text-body-sm text-muted-foreground">
          {leg.trades.map((trade, i) => {
            const expected = leg.expected[i];
            const under = expected ? shortfallBps(expected.outRaw, expected.minOutRaw) : null;
            return (
              <li key={`${trade.sell}>${trade.buy}:${trade.amountInRaw}`} className="tabular-nums">
                {t.order.review.spend(spend(trade.amountInRaw), symbol(trade.buy))}
                {/* In the token's own units where this app has them. Where it has none (the mock's
                    tokens), a raw count would read as billions: the step says how far under the
                    quote it may land, and no figure it cannot name (the flow audit, finding 23). */}
                {expected && whole(expected.minOutRaw, trade.buy) !== null && (
                  <>
                    {' · '}
                    {t.order.review.atLeastWhole(whole(expected.minOutRaw, trade.buy) as string)}
                    {each(trade.amountInRaw, expected.minOutRaw, trade.buy) !== null &&
                      ` (${t.order.review.atMostEach(
                        each(trade.amountInRaw, expected.minOutRaw, trade.buy) as string,
                      )})`}
                    {under !== null && ` · ${t.order.review.under(formatBps(under, locale))}`}
                  </>
                )}
                {expected &&
                  whole(expected.minOutRaw, trade.buy) === null &&
                  under !== null &&
                  ` · ${t.order.review.atMostUnder(formatBps(under, locale))}`}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
