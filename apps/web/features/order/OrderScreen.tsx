'use client';
import type { ConsentKind, Leg, OrderDetail } from '@colosseum/schemas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader, Stat, StatRow } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { CopyButton } from '../../components/ui/CopyButton';
import { utcMinute } from '../../components/ui/ExecutionList';
import { ExplorerLink } from '../../components/ui/ExplorerLink';
import { PAGE_TITLE } from '../../components/ui/heading';
import { SkeletonSummary } from '../../components/ui/Skeleton';
import { StatusMark } from '../../components/ui/StatusMark';
import { type Dictionary, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { dollars } from '../goal/sheet';
import { readPersonPlans, recordsOfPlans } from '../portfolio/server-plans';
import { SharedReview } from '../shared/SharedReview';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { assetTicker, formatBps, formatRaw, shortfallBps } from './amounts';
import { type CallFailure, continueOrder, readOrder } from './order-api';
import {
  checkContinuation,
  checkDeposit,
  checkFamilyBuy,
  type DepositCheck,
  sharedShapeOk,
  tradesLeft,
} from './order-check';
import { isBuy, keepOrder, type OrderRecord, recallOrder } from './order-record';
import { legsInOrder, type NextStep, type OutcomeView, outcomeView, stepOf } from './order-view';
import { readStoredPlan } from './plan-store';
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
  // An order that finishes another deposits nothing, and makes only trades the first one left.
  if (record.continues) return checkContinuation(order, record.continues.left, units);
  const terms = record.terms;
  if (!terms) return checkDeposit(order, record.amountUsd, units);
  if (terms.kind === 'family') return checkFamilyBuy(order, record.amountUsd, units, terms.targets);
  return sharedShapeOk(order, terms)
    ? { ok: true, depositRaw: 0n, decimals: 0 }
    : { ok: false, why: 'shape' };
}
type Phase = { legId: string; phase: string } | null;

/** The order's deposit reached the chain, and the order goes no further with a step not done. */
function stoppedAfterDeposit(order: OrderDetail): boolean {
  const landed = order.legs.some(
    (leg) => (leg.kind === 'create_vault' || leg.kind === 'deposit') && leg.status === 'confirmed',
  );
  const over =
    order.status === 'failed' ||
    order.status === 'expired' ||
    order.legs.some((leg) => leg.status === 'failed' || leg.status === 'expired');
  return landed && order.status !== 'done' && over;
}

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
  const [finishing, setFinishing] = useState(false);
  const [finishProblem, setFinishProblem] = useState<{ sentence: string; said: string } | null>(
    null,
  );
  const router = useRouter();
  const stop = useRef({ aborted: false });
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

  // An order this browser did not make, stopped after its deposit: the server's list of plans names
  // its plan (`GET /v1/me/plans`) and the plan is read back by its id, so the buy can be finished
  // from here too. `undefined` while that is asked; null when the server has no such plan to give.
  const [served, setServed] = useState<OrderRecord | null | undefined>(undefined);
  useEffect(() => {
    if (record !== null || load.kind !== 'read' || !userId) return;
    if (!stoppedAfterDeposit(load.order)) return setServed(null);
    let mine = true;
    setServed(undefined);
    void (async () => {
      const listed = recordsOfPlans(await readPersonPlans(apiFetch), userId).find(
        (r) => r.orderId === id,
      );
      const plan = listed ? await readStoredPlan(apiFetch, listed.proposalId) : null;
      if (mine) setServed(listed && plan ? { ...listed, lines: plan.proposal.lines } : null);
    })();
    return () => {
      mine = false;
    };
  }, [record, load, userId, id, apiFetch]);

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
  // The record this page stands on: this browser's own, or, for an order stopped after its deposit
  // that another browser made, the one made from the server's plan. Nothing but the continuation is
  // offered from the server's: an order is signed where it was reviewed.
  if (record === null && served === undefined && stoppedAfterDeposit(load.order))
    return (
      <Card>
        <CardWait label={t.order.loading} skeleton={<SkeletonSummary />} />
      </Card>
    );
  const kept = record ?? served ?? null;
  if (!kept) {
    // Made in another browser, and its plan is not the server's to give: its steps cannot be checked
    // here. When its deposit landed and the buying did not finish, the page says where the money is.
    const there = load.order;
    const landed =
      there.status !== 'done' &&
      there.legs.some(
        (leg) =>
          (leg.kind === 'create_vault' || leg.kind === 'deposit') && leg.status === 'confirmed',
      );
    const on = there.legs[0]?.chain;
    const cashUnits = on ? unitsFor(on, onMock(port, on)) : null;
    const decimals = cashUnits?.tokens[cashUnits.cash]?.decimals;
    return landed && there.depositRaw !== undefined && decimals !== undefined ? (
      <Notice
        title={t.order.title}
        body={t.order.outcome.elsewhereStopped(
          dollars(Number(there.depositRaw) / 10 ** decimals, lang),
        )}
        href="/monitor"
        label={t.order.outcome.seePortfolio}
      />
    ) : (
      <Notice
        title={t.order.title}
        body={t.order.elsewhere}
        href="/goal"
        label={t.plan.backToGoal}
      />
    );
  }

  const shown = kept.approved?.order ?? load.order;
  const now = live ?? load.order;
  const chain = kept.chain;
  // Every amount on this screen is the order's own, read with units this repository committed, and the
  // order is offered for signing only when it deposits what the person typed (order-check.ts).
  const units = unitsFor(chain, onMock(port, chain));
  const check = checkOf(shown, kept, units);
  const buying = isBuy(kept);
  const amount = check.ok
    ? dollars(Number(check.depositRaw) / 10 ** check.decimals, lang)
    : dollars(kept.amountUsd, lang);
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
  const consentMissing = !kept.approved && needed.some((kind) => !consents.includes(kind));
  const current = phase ? stepOf(shown, phase.legId) : 1;
  const terms = kept.terms;
  const newOrder = !terms
    ? `/plan/${encodeURIComponent(kept.proposalId)}/buy`
    : terms.kind === 'family'
      ? `/indexes/${encodeURIComponent(terms.slug)}/buy`
      : terms.kind === 'follow'
        ? `/indexes/${encodeURIComponent(terms.slug)}`
        : '/publish';
  const testNetwork = shown.legs[0]?.provenance === 'sandbox';
  // The order stopped for good after its deposit reached the chain: the money is in the vault as cash.
  const deposited =
    buying &&
    now.legs.some(
      (leg) =>
        (leg.kind === 'create_vault' || leg.kind === 'deposit') && leg.status === 'confirmed',
    );
  // The same for an order that finishes another: it deposited nothing, and the cash is in the vault.
  const inVault = deposited || (buying && kept.continues !== undefined);
  // It goes no further: the executor said so, or (on a page opened again) the order's own state does.
  const over = view
    ? view.next.kind === 'new-order'
    : now.status === 'failed' ||
      now.status === 'expired' ||
      now.legs.some((leg) => leg.status === 'failed' || leg.status === 'expired');
  const stranded = inVault && !done && !running && over;

  /** A new order that finishes this buy with the cash in the vault, then its own review page. */
  async function finish() {
    if (!kept || finishing) return;
    setFinishing(true);
    setFinishProblem(null);
    const o = t.order.outcome;
    const firstId = kept.continues?.orderId ?? id;
    const made = await continueOrder(
      apiFetch,
      { id: firstId, owner: shown.owner, basketId: shown.basketId },
      chain,
    );
    if (made.kind !== 'placed') {
      setFinishing(false);
      setFinishProblem(
        made.kind === 'not-now'
          ? { sentence: made.wait ? o.finishWait : o.finishRefused, said: made.said }
          : { sentence: made.kind === 'busy' ? t.shell.slowDown : o.finishRefused, said: '' },
      );
      return;
    }
    // What this order had left to buy: the new one is held to it before it is offered for signing.
    const left = tradesLeft(shown, now);
    const cashToken = units?.tokens[units.cash];
    const spent = left.reduce((sum, trade) => sum + BigInt(trade.amountInRaw), 0n);
    const stored =
      cashToken !== undefined &&
      spent > 0n &&
      keepOrder({
        ...kept,
        orderId: made.order.id,
        amountUsd: Number(spent) / 10 ** cashToken.decimals,
        approved: null,
        continues: { orderId: firstId, left },
      });
    if (!stored) {
      setFinishing(false);
      setFinishProblem({ sentence: cashToken ? o.finishNoStore : o.finishRefused, said: '' });
      return;
    }
    router.push(`/orders/${encodeURIComponent(made.order.id)}`);
  }

  // The one primary button of the view: sign, carry on, approve a step again, or nothing.
  const next: NextStep | { kind: 'first' } =
    view?.next ?? (kept.approved ? { kind: 'run' } : { kind: 'first' });
  const primaryLabel =
    next.kind === 'approve-again'
      ? t.order.outcome.approveAgain(next.step)
      : next.kind === 'run' && view && outcome?.status === 'waiting'
        ? t.order.outcome.lookAgain
        : next.kind === 'run' && view
          ? t.order.outcome.tryAgain
          : terms?.kind === 'publish'
            ? kept.approved
              ? t.order.shared.resume
              : t.order.shared.signPublish
            : terms?.kind === 'follow'
              ? kept.approved
                ? t.order.shared.resume
                : t.order.shared.signFollow
              : kept.approved
                ? t.order.resume(amount)
                : t.order.signAndBuy(amount);

  return (
    <div data-ui="order-screen" className="flex flex-col gap-8">
      <header className="flex flex-col items-start gap-3">
        <ChainBadge chain={chain} />
        <h1 id={titleId} className={PAGE_TITLE}>
          {kept.approved || stranded ? t.order.title : t.order.review.title}
        </h1>
        {!kept.approved && !stranded && (
          <p className="max-w-(--tf-measure-body) text-body-lg">{t.order.review.lead}</p>
        )}
        {kept.continues && (
          <p data-ui="order-continues" className="max-w-(--tf-measure-body) text-body">
            {t.order.review.continuesLead}
          </p>
        )}
      </header>

      <Card
        as="section"
        aria-label={t.order.stepsTitle}
        mock={shown.legs[0]?.provenance !== 'live'}
        mockLabels={{
          announce: t.shell.mockAnnounce,
          note: testNetwork ? t.shell.testNetwork : undefined,
        }}
      >
        <CardHeader title={t.order.stepsTitle} level={2} meta={<ChainBadge chain={chain} />} />
        <CardBody className="flex flex-col gap-4">
          <StatRow>
            {buying && !kept.continues && (
              <Stat label={t.order.review.deposit}>{depositShown}</Stat>
            )}
            {kept.continues && <Stat label={t.order.review.fromVault}>{amount}</Stat>}
            <Stat label={t.order.review.steps}>{legs.length}</Stat>
            {!kept.approved && (
              <Stat label={t.order.review.expires} className="max-[620px]:col-span-2">
                {/* The one way a time is written here, with its zone (ExecutionList's). */}
                <time dateTime={new Date(shown.expiresAt * 1000).toISOString()}>
                  {utcMinute(new Date(shown.expiresAt * 1000).toISOString())}
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
                  t={t}
                  locale={LOCALE[lang]}
                  money={(value) => dollars(value, lang)}
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

      {!kept.approved && !stranded && needed.length > 0 && (
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
        {/* Where the money is, first: said whenever the order stopped after its deposit landed. */}
        {stranded && (
          <p data-ui="deposit-safe" className="max-w-(--tf-measure-body) text-body">
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

            {/* What failed, in the guard's own words: for the person to quote, not to read first. */}
            {(view.check || view.detail) && (
              <details data-ui="order-details" className="text-body-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  {t.order.outcome.details}
                </summary>
                {view.check && (
                  <p className="font-mono text-source text-muted-foreground">{view.check}</p>
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
          !stranded &&
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
        {/* Done: the way on is the portfolio, where the vault now is; a buy can be made again. */}
        {done && (
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
        {/* Stopped after the deposit: the one way on spends the cash that is in the vault. A new
            order from the plan would ask for the whole deposit again, so it is not offered here. */}
        {stranded && (
          <div data-ui="order-next" className="flex flex-col items-start gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                busy={finishing}
                busyLabel={t.order.outcome.finishing}
                onClick={finish}
              >
                {t.order.outcome.finish}
              </Button>
              <Link href="/monitor" className={buttonClass({ variant: 'secondary' })}>
                {t.order.outcome.seePortfolio}
              </Link>
            </div>
            {finishProblem && (
              <div role="alert" className="flex max-w-(--tf-measure-body) flex-col gap-1">
                <p className="text-body-sm text-destructive">{finishProblem.sentence}</p>
                {finishProblem.said && (
                  <details className="text-body-sm">
                    <summary className="cursor-pointer text-muted-foreground">
                      {t.order.outcome.details}
                    </summary>
                    <p className="font-mono text-source text-muted-foreground break-words">
                      {finishProblem.said}
                    </p>
                  </details>
                )}
              </div>
            )}
          </div>
        )}
        {next.kind === 'new-order' && !done && !stranded && (
          <Link href={newOrder} className={buttonClass({ variant: 'primary' })}>
            {t.order.outcome.newOrder}
          </Link>
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
  t,
  locale,
  money,
}: {
  n: number;
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
  /** A dollar figure in the language of the page. */
  money: (value: number) => string;
}) {
  /** A raw amount of a token in whole units with its symbol, or null when its units are not known. */
  const whole = (raw: string, asset: string) => {
    const u = units?.tokens[asset];
    const figure = u ? formatRaw(raw, u.decimals, locale) : null;
    return u && figure !== null ? `${figure} ${u.symbol}` : null;
  };
  const spend = (raw: string) => (units ? whole(raw, units.cash) : null) ?? raw;
  /** A token by the symbol this repository committed for it, or its id on the chain where none is. */
  const symbol = (asset: string) => units?.tokens[asset]?.symbol ?? assetTicker(asset);
  const status = phase
    ? t.order.phase[phase as keyof Dictionary['order']['phase']]
    : t.order.status[now.status];
  const failed = now.status === 'failed';
  // A step that deposits and buys in one transaction says so: the buys are not hidden under "deposit".
  const title =
    leg.trades.length > 0 && (leg.kind === 'create_vault' || leg.kind === 'deposit')
      ? t.order.kindWithBuys[leg.kind]
      : t.order.kind[leg.kind];
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
  return (
    <li data-ui="order-step" data-status={now.status} className="flex flex-col gap-1 py-3">
      <p className="flex flex-wrap items-baseline gap-x-2 text-body">
        <span className="font-medium">
          {t.order.step(n)} · {title}
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
                {/* In whole tokens, with the price that minimum means. A token whose units this app has
                    no record of gets no figure: a raw amount reads as nothing a person can check. */}
                {expected && whole(expected.minOutRaw, trade.buy) !== null && (
                  <>
                    {' · '}
                    {t.order.review.atLeastWhole(whole(expected.minOutRaw, trade.buy) as string)}
                    {each(trade.amountInRaw, expected.minOutRaw, trade.buy) !== null &&
                      ` (${t.order.review.atMostEach(
                        each(trade.amountInRaw, expected.minOutRaw, trade.buy) as string,
                      )})`}
                  </>
                )}
                {expected &&
                  under !== null &&
                  ` · ${t.order.review.under(formatBps(under, locale))}`}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
