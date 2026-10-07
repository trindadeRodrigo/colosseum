'use client';
import type { BasketProposal, BasketSheet, RiskRollUp } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Composer } from '../../components/ui/Composer';
import { cn } from '../../components/ui/cn';
import { PAGE_TITLE } from '../../components/ui/heading';
import { LatticeStatus } from '../../components/ui/Lattice';
import { type Dictionary, type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { SlowSignIn } from '../account/SlowSignIn';
import { type BuildOutcome, buildPlan, PERSONALIZE_PATH, PROPOSE_PATH } from '../goal/build-plan';
import { GOAL_DRAFT, GOAL_HANDOFF } from '../goal/draft';
import { GOAL_TEXT } from '../goal/read-goal';
import { dollars, type SheetFields } from '../goal/sheet';
import { BuyScreen } from '../order/BuyScreen';
import { PlanPane } from '../order/PlanPane';
import { rememberPlan } from '../order/plan-store';
import { chainReady, onMock } from '../order/readiness';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import {
  type Conversation,
  FACTS,
  type Fact,
  QUICK,
  type Reply,
  readerConversation,
  type Say,
  type Send,
  type Sheet,
  silentCountry,
  validOf,
} from './conversation';
import { takeWay } from './handoff';
import { wayChange } from './ways';

// Invest, as one screen (gate INVEST-TWO-PANE): the conversation on the left, the plan built beside it
// on the right. On a phone it is one thread, with the plan as a line at the foot that opens.
//
// Left: one box, the three example goals, then turns. The person's words; then what was understood,
// said back from the sheet, and the one question that is still open, with quick replies. Once every
// fact is known the app says so and the person asks for the plan (gate GUIDED-INTAKE: the solver runs
// on what the person confirmed). After that a change to a fact is the person's own word, and the plan
// is built again at once.
//
// Right: the pane, in four states. Empty: the outline of a plan. The goal as facts, appearing as they
// are learned, each one a button that asks about it again. The plan, showing how (`PlanPane`, the
// block the plan's own page draws). And the invest step, in the same pane.
//
// Someone signed out can talk and see a plan (POST /v1/baskets/propose asks for no sign-in). Investing
// asks them to sign in, in the dialog, and the plan is built again as their own.

type Plan = { id: string; proposal: BasketProposal; rollUp: RiskRollUp | null; own: boolean };
type Build = { kind: 'idle' } | { kind: 'building' } | Exclude<BuildOutcome, { kind: 'built' }>;

type Turn =
  | { id: number; who: 'person'; text: string }
  | {
      id: number;
      who: 'app';
      /** What to say, as keys; the sentences are the dictionary's, the figures the sheet's. */
      say: (Say | { key: 'building' | 'built' | 'signIn' } | { key: 'failure'; text: string })[];
      /** The sheet as it stood when this was said. */
      fields: SheetFields | null;
      ask: Fact | null;
      retry: boolean;
    };

const known = (fields: SheetFields | null, fact: Fact) => (fields?.[fact] ?? '').trim() !== '';

/** A fact's value as a person reads it. */
function factValue(fact: Fact, value: string, t: Dictionary, lang: Lang): string {
  if (fact === 'goal') return t.goal.options.goal[value as 'grow' | 'income' | 'protect'] ?? value;
  if (fact === 'risk') return t.goal.options.risk[value as 'low' | 'medium' | 'high'] ?? value;
  if (fact === 'horizon') {
    const months = Number(value);
    return months % 12 === 0 ? t.invest.replies.years(months / 12) : t.goal.card.months(months);
  }
  if (fact === 'income') return t.invest.replies.aMonth(dollars(Number(value), lang));
  return dollars(Number(value), lang);
}

/** The facts known so far, as one list: "Grow it, $40,000, 3 years and Medium". */
function saidBack(fields: SheetFields, t: Dictionary, lang: Lang): string {
  const parts = FACTS.filter((fact) => known(fields, fact)).map((fact) =>
    fact === 'risk'
      ? t.plan.riskWord[fields.risk as 'low' | 'medium' | 'high']
      : factValue(fact, fields[fact], t, lang),
  );
  return new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(parts);
}

export function InvestScreen() {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const { account, chain, slow, retry } = useAccount();
  const w = t.invest;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reading, setReading] = useState(false);
  const [build, setBuild] = useState<Build>({ kind: 'idle' });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [investing, setInvesting] = useState(false);
  const [paneOpen, setPaneOpen] = useState(false);
  const [text, setText] = useState('');
  const nextId = useRef(0);
  const wanted = useRef(0);
  const wantsInvest = useRef(false);
  const thread = useRef<HTMLOListElement>(null);
  const paneId = useId();
  const who = port.userId ?? '';
  // While the wallet loads again and names nobody, nobody is known to have left.
  const whoNow = port.status === 'loading' && port.userId === null ? null : who;
  const signedIn = account.status !== 'signed-out' && who !== '';

  // The sheet a plan is built from: whole, valid for the chain, and with no question open. It follows
  // the chain, which a sign-in that is still being read does not have yet.
  const lastApp = [...turns].reverse().find((turn) => turn.who === 'app');
  const asking = lastApp?.who === 'app' ? lastApp.ask : null;
  const valid: BasketSheet | null = useMemo(
    () => (sheet && asking === null ? validOf(sheet, chain) : null),
    [sheet, asking, chain],
  );

  const conversation: Conversation = useMemo(
    () =>
      readerConversation(apiFetch, {
        lang,
        chain,
        examples: t.goal.examples.list,
        country: silentCountry(
          typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]),
        ),
      }),
    [apiFetch, lang, chain, t],
  );

  const say = (turn: Omit<Extract<Turn, { who: 'app' }>, 'id' | 'who'>) =>
    setTurns((all) => [...all, { ...turn, id: nextId.current++, who: 'app' }]);
  const said = (words: string) =>
    setTurns((all) => [...all, { id: nextId.current++, who: 'person', text: words }]);

  /** Builds the plan of a valid sheet: the person's own when signed in, a visitor's otherwise. */
  async function buildFrom(sheetToBuild: BasketSheet, own: boolean) {
    wanted.current += 1;
    const mine = wanted.current;
    setBuild({ kind: 'building' });
    setInvesting(false);
    const outcome = await buildPlan(apiFetch, sheetToBuild, own ? PERSONALIZE_PATH : PROPOSE_PATH);
    if (wanted.current !== mine) return;
    if (outcome.kind === 'built') {
      // The plan screen and the buy read the plan from the browser first, then the server.
      if (own && port.userId)
        rememberPlan({
          id: outcome.id,
          userId: port.userId,
          proposal: outcome.proposal,
          rollUp: outcome.rollUp,
        });
      setPlan({ id: outcome.id, proposal: outcome.proposal, rollUp: outcome.rollUp, own });
      setBuild({ kind: 'idle' });
      say({ say: [{ key: 'built' }], fields: null, ask: null, retry: false });
      if (own && wantsInvest.current) {
        wantsInvest.current = false;
        setInvesting(true);
        setPaneOpen(true);
      }
      return;
    }
    setBuild(outcome);
    setPlan(null);
    const sentence =
      outcome.kind === 'no-plan'
        ? w.failure.noPlan
        : outcome.kind === 'refused' || outcome.kind === 'currency'
          ? w.failure.refused
          : outcome.kind === 'busy'
            ? t.shell.slowDown
            : outcome.kind === 'signed-out'
              ? t.goal.blocked.signInAgain
              : outcome.kind === 'no-identity'
                ? t.goal.blocked.noIdentity
                : outcome.kind === 'no-chain'
                  ? t.goal.blocked.chainNotChosen
                  : w.failure.unavailable;
    say({
      say: [{ key: 'failure', text: sentence }],
      fields: null,
      ask: null,
      // a sheet no plan fits is changed, not sent again as it is
      retry: outcome.kind !== 'no-plan' && outcome.kind !== 'refused',
    });
  }

  /** One turn: what the person sent, then what the conversation answers. */
  async function post(input: Send, words: string, from: Sheet | null = sheet, sure = confirmed) {
    if (reading) return;
    said(words);
    setReading(true);
    let reply: Reply;
    try {
      reply = await conversation.turn(input, from);
    } finally {
      setReading(false);
    }
    setSheet(reply.sheet);
    // The limits on the page are no longer the ones a plan was built for.
    wanted.current += 1;
    if (!reply.valid) setBuild({ kind: 'idle' });
    const rebuild = reply.valid !== null && sure;
    say({
      say: reply.say.filter((s) => !(rebuild && s.key === 'ready')),
      fields: reply.sheet.fields,
      ask: reply.ask,
      retry: false,
    });
    if (rebuild && reply.valid) void buildFrom(reply.valid, signedIn);
  }

  function confirm() {
    if (!valid) return;
    said(w.replies.build);
    setConfirmed(true);
    void buildFrom(valid, signedIn);
  }

  // What was handed to this screen, read once as it opens: a way to close a gap pressed on a plan's
  // own page, or a goal typed on the landing page or in a partner's embed (in the tab, or in the
  // fragment of the address, which no server sees and which is taken out once read).
  const opened = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once, as the screen opens
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const way = takeWay();
    if (way) {
      const s = way.sheet;
      const from: Sheet = {
        fields: {
          goal: s.goal,
          amount: String(s.amountUsd),
          income: s.incomeTargetUsdMonthly === undefined ? '' : String(s.incomeTargetUsdMonthly),
          horizon: String(s.horizonMonths),
          risk: s.risk,
          country: s.country,
          holdings: s.rules.useHoldings ? 'yes' : 'no',
          glide: s.rules.glide ? 'yes' : 'no',
          language: s.language,
        },
        skipped: s.incomeTargetUsdMonthly === undefined ? ['income'] : [],
      };
      const change = wayChange(way.way, s);
      setConfirmed(true);
      void post(
        change ? { kind: 'answer', ...change } : { kind: 'text', text: way.way },
        way.way,
        from,
        true,
      );
      return;
    }
    let typed: string | null = null;
    try {
      typed = window.sessionStorage.getItem(GOAL_HANDOFF);
      window.sessionStorage.removeItem(GOAL_HANDOFF);
      const fragment = /^#goal=(.*)$/.exec(window.location.hash)?.[1];
      if (fragment !== undefined) {
        try {
          typed = decodeURIComponent(fragment);
        } catch {
          typed = null;
        }
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    } catch {
      // No storage in this browser: the screen opens empty.
    }
    if (typed !== null && typed.trim() !== '' && typed.length <= GOAL_TEXT.max)
      void post({ kind: 'text', text: typed.trim() }, typed.trim());
  }, []);

  // What was said and the sheet so far are kept in the tab, so a sign-in that leaves the page and
  // comes back loses nothing. Only keys and the person's own words are kept and read back: a sentence
  // is never taken from storage.
  const [restored, setRestored] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read back once, before anything is written
  useEffect(() => {
    const kept = restoreDraft(readDraft());
    if (kept && turns.length === 0) {
      nextId.current = kept.turns.length;
      setTurns(kept.turns);
      setSheet(kept.sheet);
    }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return;
    try {
      if (turns.length === 0) window.sessionStorage.removeItem(GOAL_DRAFT);
      else window.sessionStorage.setItem(GOAL_DRAFT, JSON.stringify({ v: 2, turns, sheet }));
    } catch {
      // No storage in this browser: the screen works without it.
    }
  }, [restored, turns, sheet]);

  // The goal on the page is one person's. When they sign out, or another person signs in, it goes
  // with them. Someone who was signed out and signs in keeps it, and the plan a visitor was shown is
  // built again as their own: its vault is theirs, and it is kept on the server for them.
  const last = useRef(who);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a change of the person only
  useEffect(() => {
    const before = last.current;
    if (whoNow === null || before === who) return;
    last.current = who;
    if (before !== '') {
      wanted.current += 1;
      wantsInvest.current = false;
      setTurns([]);
      setSheet(null);
      setConfirmed(false);
      setPlan(null);
      setBuild({ kind: 'idle' });
      setInvesting(false);
      return;
    }
  }, [whoNow]);

  // A visitor who signs in keeps the conversation, and the plan they were shown is built again as
  // their own, once their chain is known: its vault is theirs, and the server keeps it for them.
  const visitorPlan = plan !== null && !plan.own;
  const ready = account.status === 'ready' && who !== '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the person is ready and the plan shown is a visitor's
  useEffect(() => {
    if (ready && visitorPlan && valid && build.kind !== 'building') void buildFrom(valid, true);
  }, [ready, visitorPlan, valid]);

  // A plan lives on one chain (gate ONE-CHAIN). When the person moves to another, the plan on the
  // page is another chain's: it is built again for the chain they are on.
  const planOn = plan?.proposal.sheet.chains[0] ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the chain is no longer the plan's
  useEffect(() => {
    if (planOn && chain && planOn !== chain && valid && build.kind !== 'building')
      void buildFrom(valid, signedIn && plan?.own === true);
  }, [planOn, chain, valid]);

  // A new turn is brought into view, in the thread's own scroll.
  const count = turns.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: when a turn is added
  useEffect(() => {
    const el = thread.current?.lastElementChild;
    if (count > 0 && el instanceof HTMLElement) el.scrollIntoView?.({ block: 'nearest' });
  }, [count]);

  /** Signed out, "Invest" is a link to sign in, which opens the dialog over this page (SignInDialog). */
  const SIGN_IN = '/sign-in?next=/goal';
  function invest() {
    if (!plan) return;
    if (!signedIn || !plan.own) {
      // The plan is built again as theirs once they are in, and the invest step opens then.
      wantsInvest.current = true;
      say({ say: [{ key: 'signIn' }], fields: null, ask: null, retry: false });
      if (signedIn && valid) void buildFrom(valid, true);
      return;
    }
    setInvesting(true);
  }

  const lastTurn = turns[turns.length - 1];
  const open = lastTurn?.who === 'app' ? lastTurn : null;
  const busy = reading || build.kind === 'building';
  // Every fact is known and no plan was asked for yet: "Build my plan" is the one reply.
  const toConfirm = valid !== null && !confirmed && !plan;
  const fields = sheet?.fields ?? null;
  const planChain = plan?.proposal.sheet.chains[0] ?? chain;
  const chainName = planChain ? t.chain.names[planChain] : '';
  const network = planChain ? port.network(planChain) : null;
  const blocked =
    plan && planChain
      ? network?.on === false
        ? t.plan.chainOff(chainName)
        : chainReady(planChain, onMock(port, planChain))
          ? null
          : t.plan.chainNotReady(chainName)
      : null;
  const state = investing && plan ? 'invest' : plan ? 'plan' : fields ? 'facts' : 'empty';
  const knownCount = FACTS.filter((fact) => known(fields, fact)).length;

  /** The words of a quick reply, and what it sends. */
  const replies = (fact: Fact) =>
    QUICK[fact].map((value) => ({
      value,
      label: value === '' ? w.replies.noIncome : factValue(fact, value, t, lang),
    }));

  const line = (s: Extract<Turn, { who: 'app' }>['say'][number], at: SheetFields | null) => {
    switch (s.key) {
      case 'understood':
        return at ? w.say.understood(saidBack(at, t, lang)) : '';
      case 'notUnderstood':
        return w.say.notUnderstood;
      case 'set':
        return s.fact === 'income' && !known(at, 'income')
          ? w.say.incomeSkipped
          : at
            ? w.say.set(w.facts[s.fact], factValue(s.fact, at[s.fact], t, lang))
            : '';
      case 'unfit':
        return w.say.unfit[s.fact];
      case 'failed':
        return s.why === 'busy'
          ? t.shell.slowDown
          : s.why === 'too_short'
            ? t.goal.readFailure.tooShort
            : s.why === 'too_long'
              ? t.goal.readFailure.tooLong
              : t.goal.readFailure[s.why];
      case 'ready':
        return w.say.ready;
      case 'building':
        return w.say.building;
      case 'built':
        return w.say.built;
      case 'signIn':
        return w.say.signIn;
      case 'failure':
        return s.text;
    }
  };

  return (
    <div
      data-ui="invest-screen"
      className="flex flex-col gap-6 lg:grid lg:h-[calc(100dvh-13rem)] lg:min-h-[32rem] lg:grid-cols-12 lg:gap-x-10"
    >
      {/* Left: the conversation. It scrolls on its own beside the plan. */}
      <section
        data-ui="invest-chat"
        aria-label={w.chat}
        className="flex min-h-0 flex-col gap-4 lg:col-span-5"
      >
        <h1 className={PAGE_TITLE}>{t.goal.title}</h1>
        {/* Someone signed in whose wallets or chain are still being read is told, and not left
            waiting with no word: after a while, which side is slow and the two things they can do. */}
        {account.status === 'loading' && (slow || who !== '') && (
          <div data-ui="invest-account" className="text-body-sm text-muted-foreground">
            {slow ? (
              <SlowSignIn
                className="flex flex-col gap-1"
                onSignOut={() => void port.signOut().catch(() => {})}
              />
            ) : (
              t.chain.reading
            )}
          </div>
        )}
        {account.status === 'unknown' && (
          <p data-ui="invest-account" className="flex flex-wrap items-center gap-x-3 text-body-sm">
            <span>{t.goal.chain.unknown}</span>
            {account.why !== 'signed_out' && (
              <Button variant="link" onClick={retry}>
                {t.chain.unknown.retry}
              </Button>
            )}
          </p>
        )}
        {turns.length === 0 && (
          <p className="max-w-(--tf-measure-body) text-body text-muted-foreground">{t.goal.lead}</p>
        )}
        <ol
          ref={thread}
          data-ui="invest-turns"
          aria-live="polite"
          className={cn('flex min-h-0 flex-col gap-4 lg:flex-1 lg:overflow-y-auto lg:pr-2')}
        >
          {turns.map((turn) =>
            turn.who === 'person' ? (
              <li
                key={turn.id}
                data-who="person"
                className="motion-safe:animate-seat ml-8 self-end rounded-sm border border-border bg-muted px-3 py-2 text-body"
              >
                <span className="sr-only">{w.you}: </span>
                {turn.text}
              </li>
            ) : (
              <li
                key={turn.id}
                data-who="app"
                className="motion-safe:animate-seat mr-8 flex flex-col gap-1.5"
              >
                <span className="text-caption text-muted-foreground">{w.me}</span>
                {turn.say.map((s) => (
                  <p key={`${s.key}:${'fact' in s ? s.fact : ''}`} className="text-body">
                    {line(s, turn.fields)}
                  </p>
                ))}
                {turn.ask && <p className="text-body font-medium">{w.ask[turn.ask]}</p>}
              </li>
            ),
          )}
          {busy && (
            <li data-who="app" className="mr-8">
              <LatticeStatus label={reading ? w.reading : w.say.building} />
            </li>
          )}
        </ol>

        {/* The quick replies of the question that is open: one press answers it. */}
        {!busy && (open?.ask || toConfirm || (open?.retry && valid)) && (
          <div data-ui="invest-replies" className="flex flex-wrap gap-2">
            {open?.ask &&
              replies(open.ask).map((r) => (
                <Button
                  key={r.value}
                  variant="chip"
                  onClick={() =>
                    post({ kind: 'answer', fact: open.ask as Fact, value: r.value }, r.label)
                  }
                >
                  {r.label}
                </Button>
              ))}
            {toConfirm && (
              <Button variant="primary" onClick={confirm}>
                {w.replies.build}
              </Button>
            )}
            {open?.retry && valid && !toConfirm && (
              <Button variant="secondary" onClick={() => buildFrom(valid, signedIn)}>
                {w.failure.again}
              </Button>
            )}
          </div>
        )}

        <Composer
          label={w.box}
          labelHidden
          value={text}
          onChange={setText}
          onSubmit={(typed) => {
            setText('');
            void post({ kind: 'text', text: typed }, typed.trim());
          }}
          placeholder={turns.length === 0 ? t.goal.composer.placeholder : w.placeholder}
          maxLength={GOAL_TEXT.max}
          busy={reading}
          disabled={build.kind === 'building'}
          lang={LOCALE[lang]}
          labels={{ submit: w.reply, busy: w.reading }}
        />
        {turns.length === 0 && (
          <ul aria-label={w.examples} className="flex flex-wrap gap-2">
            {t.goal.examples.list.map((example) => (
              <li key={example}>
                <Button
                  variant="chip"
                  className="h-auto! min-h-8 py-1"
                  disabled={busy}
                  onClick={() => post({ kind: 'text', text: example }, example)}
                >
                  {example}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* On a phone the plan is one line at the foot that opens. */}
      <div className="sticky bottom-0 z-10 -mx-1 border-t border-border bg-background px-1 py-3 lg:hidden">
        <Button
          variant="secondary"
          className="w-full justify-between"
          aria-expanded={paneOpen}
          aria-controls={paneId}
          onClick={() => setPaneOpen(true)}
        >
          <span data-ui="invest-summary" className="truncate">
            {plan
              ? w.pane.open
              : fields
                ? w.pane.summaryFacts(knownCount, fields.goal === 'income' ? 5 : 4)
                : w.pane.summaryEmpty}
          </span>
        </Button>
      </div>

      {/* Right: the plan, built as the answers arrive. */}
      <aside
        id={paneId}
        data-ui="invest-pane"
        data-state={state}
        aria-label={w.pane.label}
        className={cn(
          'min-h-0 flex-col gap-6 lg:col-span-7 lg:flex lg:overflow-y-auto lg:border-l lg:border-border lg:pl-10',
          paneOpen
            ? 'fixed inset-0 z-40 flex overflow-y-auto bg-background p-4 pt-28 lg:static lg:z-auto lg:p-0 lg:pt-0'
            : 'hidden',
        )}
      >
        <div className="lg:hidden">
          <Button variant="secondary" onClick={() => setPaneOpen(false)}>
            {w.pane.close}
          </Button>
        </div>
        {state === 'empty' && <EmptyPane />}
        {fields && (
          <Facts
            fields={fields}
            skipped={sheet?.skipped ?? []}
            disabled={busy || investing}
            onChange={(fact) => post({ kind: 'reopen', fact }, w.facts.change(w.facts[fact]))}
          />
        )}
        {build.kind === 'building' && <LatticeStatus label={w.pane.building} />}
        {plan && planChain && !investing && (
          <div className="motion-safe:animate-seat flex flex-col gap-4">
            <PlanPane
              plan={plan}
              chain={planChain}
              blocked={blocked}
              level={2}
              onWay={(way) => {
                const change = wayChange(way, plan.proposal.sheet);
                void post(
                  change ? { kind: 'answer', ...change } : { kind: 'text', text: way },
                  way,
                );
              }}
              invest={signedIn ? { onPress: invest } : { href: SIGN_IN, onFollow: invest }}
            />
            {plan.own && (
              <Link
                href={`/plan/${encodeURIComponent(plan.id)}`}
                className={`${buttonClass({ variant: 'link' })} self-start`}
              >
                {w.pane.ownPage}
              </Link>
            )}
          </div>
        )}
        {plan && investing && (
          <section
            data-ui="invest-step"
            aria-label={w.pane.investTitle}
            className="flex flex-col gap-4"
          >
            <Button variant="link" className="self-start" onClick={() => setInvesting(false)}>
              {w.pane.backToPlan}
            </Button>
            <BuyScreen id={plan.id} embedded />
          </section>
        )}
      </aside>
    </div>
  );
}

/** The pane before anything is said: the outline of a plan, drawn in hairlines, and what fills it. */
function EmptyPane() {
  const t = useT();
  const w = t.invest.pane.empty;
  return (
    <div data-ui="pane-empty" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-h4 font-semibold">{w.title}</h2>
        <p className="max-w-(--tf-measure-body) text-body text-muted-foreground">{w.body}</p>
      </div>
      <div aria-hidden="true" className="flex flex-col gap-3">
        <div className="grid grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="h-12 border border-dashed border-border" />
          ))}
        </div>
        <span className="h-3 border border-dashed border-border" />
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-10 border border-dashed border-border" />
        ))}
      </div>
    </div>
  );
}

/**
 * The goal as facts, each appearing as it is learned. A fact is a button: pressed, it is asked about
 * again in the conversation. There is no country here, and none is asked (gate COUNTRY-REMOVED). A
 * monthly contribution has no field on the sheet yet, so it has no slot.
 */
function Facts({
  fields,
  skipped,
  disabled,
  onChange,
}: {
  fields: SheetFields;
  skipped: readonly Fact[];
  disabled: boolean;
  onChange: (fact: Fact) => void;
}) {
  const t = useT();
  const lang = useLang();
  const w = t.invest.facts;
  const shown = FACTS.filter((fact) => fact !== 'income' || fields.goal === 'income');
  return (
    <section data-ui="pane-facts" aria-label={w.title} className="flex flex-col gap-2">
      <h2 className="text-[0.8125rem]/5 font-medium">{w.title}</h2>
      <ul className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4">
        {shown.map((fact) => {
          const set = known(fields, fact);
          const value = set
            ? factValue(fact, fields[fact], t, lang)
            : fact === 'income' && skipped.includes('income')
              ? w.noIncome
              : w.open;
          return (
            <li key={fact} data-fact={fact} data-set={set} className="bg-card">
              <button
                type="button"
                aria-disabled={disabled || undefined}
                onClick={() => {
                  if (!disabled) onChange(fact);
                }}
                className="flex h-full w-full flex-col items-start gap-0.5 px-3 py-2 text-left outline-none hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              >
                <span className="text-caption text-muted-foreground">
                  <span className="sr-only">{w.change('')} </span>
                  {w[fact]}
                </span>
                <span
                  key={value}
                  className={cn(
                    'text-body tabular-nums',
                    set ? 'motion-safe:animate-seat font-medium' : 'text-muted-foreground',
                  )}
                >
                  {value}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const readDraft = (): string | null => {
  try {
    return window.sessionStorage.getItem(GOAL_DRAFT);
  } catch {
    return null;
  }
};

const SAY_KEYS = new Set([
  'understood',
  'notUnderstood',
  'set',
  'unfit',
  'ready',
  'built',
  'signIn',
]);
const isFact = (v: unknown): v is Fact => FACTS.includes(v as Fact);
const FIELD_KEYS = [
  'goal',
  'amount',
  'income',
  'horizon',
  'risk',
  'country',
  'holdings',
  'glide',
  'language',
];

/**
 * Reads back what the screen kept. The tab's storage is text anybody can have written: a turn of the
 * app is rebuilt from its keys alone, a person's turn is their own words shown as text, and anything
 * that is not in that form is dropped, whole.
 */
export function restoreDraft(raw: string | null): { turns: Turn[]; sheet: Sheet } | null {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? 'null');
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { v, turns, sheet } = value as Record<string, unknown>;
  if (v !== 2 || !Array.isArray(turns) || typeof sheet !== 'object' || sheet === null) return null;
  const { fields, skipped } = sheet as Record<string, unknown>;
  if (typeof fields !== 'object' || fields === null || !Array.isArray(skipped)) return null;
  const f = fields as Record<string, unknown>;
  if (!FIELD_KEYS.every((key) => typeof f[key] === 'string' && (f[key] as string).length <= 40))
    return null;
  const cleanFields = Object.fromEntries(FIELD_KEYS.map((key) => [key, f[key]])) as SheetFields;
  const read: Turn[] = [];
  for (const turn of turns.slice(-200)) {
    if (typeof turn !== 'object' || turn === null) return null;
    const t = turn as Record<string, unknown>;
    if (t.who === 'person' && typeof t.text === 'string' && t.text.length <= GOAL_TEXT.max)
      read.push({ id: read.length, who: 'person', text: t.text });
    else if (t.who === 'app' && Array.isArray(t.say)) {
      const said = (t.say as unknown[]).flatMap((s) => {
        const k = (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>;
        if (typeof k.key !== 'string' || !SAY_KEYS.has(k.key)) return [];
        if (k.key === 'set' || k.key === 'unfit')
          return isFact(k.fact) ? [{ key: k.key, fact: k.fact } as Say] : [];
        return [{ key: k.key } as Say];
      });
      const at = (typeof t.fields === 'object' && t.fields !== null ? t.fields : null) as Record<
        string,
        unknown
      > | null;
      read.push({
        id: read.length,
        who: 'app',
        say: said,
        fields:
          at && FIELD_KEYS.every((key) => typeof at[key] === 'string')
            ? (Object.fromEntries(FIELD_KEYS.map((key) => [key, at[key]])) as SheetFields)
            : null,
        ask: isFact(t.ask) ? t.ask : null,
        retry: false,
      });
    } else return null;
  }
  return { turns: read, sheet: { fields: cleanFields, skipped: skipped.filter(isFact) } };
}
