'use client';
import type {
  BasketProposal,
  BasketSheet,
  PlanCandidate,
  PlanCandidateId,
  PlanCandidateNotShown,
  RiskRollUp,
} from '@colosseum/schemas';
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
import { FIRST_CHAIN } from '../account/chain-choice';
import { SlowSignIn } from '../account/SlowSignIn';
import { type BuildOutcome, buildPlan, PERSONALIZE_PATH, PROPOSE_PATH } from '../goal/build-plan';
import { GOAL_DRAFT, GOAL_HANDOFF } from '../goal/draft';
import { GOAL_TEXT } from '../goal/read-goal';
import { dollars, type SheetFields } from '../goal/sheet';
import { formatBps } from '../order/amounts';
import { Candidates } from '../order/Candidates';
import { Invest } from '../order/Invest';
import type { InvestProgress } from '../order/invest-words';
import { PlanPane } from '../order/PlanPane';
import { rememberPlan } from '../order/plan-store';
import { chainReady, onMock } from '../order/readiness';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import {
  type Conversation,
  FACTS,
  type Fact,
  type IntakeState,
  isFact,
  isGoAhead,
  isStartOver,
  PICKS,
  QUICK,
  type Question,
  type QuickReply,
  type Reply,
  readerConversation,
  type Say,
  type Send,
  type Sheet,
  validOf,
} from './conversation';
import { takeWay } from './handoff';
import { IntakeAnswers } from './intake';
import { intakeConversation } from './intake-conversation';
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

/** The most of a person's own messages kept with the sheet: a conversation has no end at ten. */
const MAX_WORDS = 200;

type Plan = { id: string; proposal: BasketProposal; rollUp: RiskRollUp | null; own: boolean };
/**
 * What one "Build my plan" answered: the candidates of the goal, in their fixed order, and those the
 * engine left out. `one` is the plan a server that sends no candidates answers with.
 */
type Built = {
  one: Omit<Plan, 'own'>;
  candidates: PlanCandidate[];
  notShown: PlanCandidateNotShown[];
  own: boolean;
  /** The sheet these were made from, as it was sent. */
  sheet: BasketSheet;
};
type Build = { kind: 'idle' } | { kind: 'building' } | Exclude<BuildOutcome, { kind: 'built' }>;

type Turn =
  | { id: number; who: 'person'; text: string }
  | {
      id: number;
      who: 'app';
      /** What to say, as keys; the sentences are the dictionary's, the figures the sheet's. */
      say: (
        | Say
        | { key: 'building' | 'built' | 'builtChoice' | 'signIn' | 'done' }
        | { key: 'picked'; candidate: PlanCandidateId }
        | { key: 'failure' | 'progress'; text: string }
        | { key: 'stopped'; orderId: string }
      )[];
      /** The sheet as it stood when this was said. */
      fields: SheetFields | null;
      ask: Fact | null;
      /** The question in our server's words, with its replies. Never kept in the tab's storage. */
      question?: Question | null;
      /** Who read the turn: shown to the people building this, never to anyone else. */
      reader?: Reply['reader'];
      retry: boolean;
    };

const known = (fields: SheetFields | null, fact: Fact) => (fields?.[fact] ?? '').trim() !== '';

/** A fact's value as a person reads it. */
function factValue(fact: Fact, value: string, t: Dictionary, lang: Lang): string {
  // A value that is not one the fact takes is never said as it is: only our own words are.
  if (fact === 'goal') return t.goal.options.goal[value as 'grow' | 'income' | 'protect'] ?? '';
  if (fact === 'risk') return t.goal.options.risk[value as 'low' | 'medium' | 'high'] ?? '';
  if (!/^\d+(\.\d+)?$/.test(value)) return '';
  if (fact === 'horizon') {
    const months = Number(value);
    return months % 12 === 0 ? t.talk.replies.years(months / 12) : t.goal.card.months(months);
  }
  if (fact === 'income') return t.talk.replies.aMonth(dollars(Number(value), lang));
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
  const { account, chain: accountChain, slow, retry } = useAccount();
  // The chain a plan is built on: the person's, or the one a visitor is looking at. Someone not known
  // to be signed in always has one, also while the wallet library is still loading: a visitor can
  // talk and see a plan whatever the sign-in service is doing.
  const chain = accountChain ?? (port.userId ? null : FIRST_CHAIN);
  const w = t.talk;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reading, setReading] = useState(false);
  const [build, setBuild] = useState<Build>({ kind: 'idle' });
  const [built, setBuilt] = useState<Built | null>(null);
  // Which candidate the person picked. None is picked for them (gate THREE-PLANS).
  const [picked, setPicked] = useState<PlanCandidateId | null>(null);
  // The plan on the pane in full: the one picked, or the only one there is to pick.
  const plan: Plan | null = useMemo(() => {
    if (!built) return null;
    if (built.candidates.length === 0) return { ...built.one, own: built.own };
    const chosen =
      built.candidates.length === 1
        ? built.candidates[0]
        : built.candidates.find((c) => c.candidate === picked);
    return chosen
      ? { id: chosen.id, proposal: chosen.proposal, rollUp: chosen.rollUp, own: built.own }
      : null;
  }, [built, picked]);
  const pickedName =
    plan && built && built.candidates.length > 0
      ? t.plan.choice.names[
          (built.candidates.find((c) => c.id === plan.id) as PlanCandidate).candidate
        ]
      : null;
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

  // Who reads the conversation. Signed in, with their chain known: the guided intake on our server
  // (gate GUIDED-INTAKE), which needs a sign-in. A visitor, and anyone the intake cannot read for
  // (no route, a sign-in our server does not know): the rules reader and this app's own questions.
  const guided = account.status === 'ready' && who !== '';
  const conversation: Conversation = useMemo(() => {
    const rules = readerConversation(apiFetch, { lang, chain, examples: t.goal.examples.list });
    return guided ? intakeConversation(apiFetch, { lang, chain, fallback: rules }) : rules;
  }, [apiFetch, lang, chain, t, guided]);

  // The app never says the same thing twice in a row: a turn that repeats the one before it, word
  // for word, is not added.
  const say = (turn: Omit<Extract<Turn, { who: 'app' }>, 'id' | 'who'>) =>
    setTurns((all) => {
      const before = all[all.length - 1];
      if (
        before?.who === 'app' &&
        JSON.stringify([before.say, before.fields, before.ask, before.question, before.retry]) ===
          JSON.stringify([turn.say, turn.fields, turn.ask, turn.question, turn.retry])
      )
        return all;
      return [...all, { ...turn, id: nextId.current++, who: 'app' }];
    });
  const said = (words: string) =>
    setTurns((all) => [...all, { id: nextId.current++, who: 'person', text: words }]);

  /** Builds the plan of a valid sheet: the person's own when signed in, a visitor's otherwise. */
  async function buildFrom(sheetToBuild: BasketSheet, own: boolean, quiet = false) {
    wanted.current += 1;
    const mine = wanted.current;
    // A chain our server has switched off: nothing is built there, and it is said.
    const on = sheetToBuild.chains[0];
    if (on && port.network(on)?.on === false) {
      setBuild({ kind: 'idle' });
      setBuilt(null);
      setPicked(null);
      say({
        say: [{ key: 'failure', text: t.plan.chainOff(t.chain.names[on]) }],
        fields: null,
        ask: null,
        retry: false,
      });
      return;
    }
    setBuild({ kind: 'building' });
    const outcome = await buildPlan(apiFetch, sheetToBuild, own ? PERSONALIZE_PATH : PROPOSE_PATH);
    if (wanted.current !== mine) return;
    if (outcome.kind === 'built') {
      const one = { id: outcome.id, proposal: outcome.proposal, rollUp: outcome.rollUp };
      // The plan screen and the buy read a plan from the browser first, then the server: each
      // candidate is its own stored plan, which is what a buy names.
      if (own && port.userId)
        for (const kept of [one, ...outcome.candidates])
          rememberPlan({
            id: kept.id,
            userId: port.userId,
            proposal: kept.proposal,
            rollUp: kept.rollUp,
          });
      setBuilt({
        one,
        candidates: outcome.candidates,
        notShown: outcome.notShown,
        own,
        sheet: sheetToBuild,
      });
      // Plans made from a change are new plans to compare: none is picked. The same plans made the
      // person's own keep their pick.
      if (!quiet) setPicked(null);
      setBuild({ kind: 'idle' });
      // A plan built again with nothing changed by the person (theirs now, after a sign-in) is not
      // announced a second time.
      if (!quiet)
        say({
          say: [{ key: outcome.candidates.length > 1 ? 'builtChoice' : 'built' }],
          fields: null,
          ask: null,
          retry: false,
        });
      // The person asked to invest before they were signed in: the card is on the pane now.
      if (own && wantsInvest.current) {
        wantsInvest.current = false;
        if (onPhone()) setPaneOpen(true);
      }
      return;
    }
    setBuild(outcome);
    setBuilt(null);
    setPicked(null);
    const sentence =
      outcome.kind === 'no-plan'
        ? w.failure.noPlan
        : outcome.kind === 'refused'
          ? w.failure.refused
          : outcome.kind === 'currency'
            ? t.goal.blocked.currency
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
      retry:
        outcome.kind !== 'no-plan' && outcome.kind !== 'refused' && outcome.kind !== 'currency',
    });
  }

  /** One turn: what the person sent, then what the conversation answers. */
  async function post(input: Send, words: string, from: Sheet | null = sheet, sure = confirmed) {
    if (reading) return;
    // "yes", "ok", "build": the go-ahead, once every fact is known and no plan was asked for yet
    if (input.kind === 'text' && toConfirm && isGoAhead(input.text)) return confirm(words);
    // a candidate named, while the plans are side by side: it is picked, and nothing is read
    const named = input.kind === 'text' && !stale ? candidateSaid(input.text) : null;
    if (named) return pick(named, words);
    // "start over", "clear it out": the conversation and the pane are emptied
    if (input.kind === 'text' && isStartOver(input.text)) return startOver();
    said(words);
    setReading(true);
    let reply: Reply;
    try {
      reply = await conversation.turn(input, from);
    } catch (error) {
      // A turn that fails says so: never an empty reply, and what was held stands.
      console.error('[invest] the turn was not read', error);
      say({
        say: [{ key: 'failed', why: 'unreadable' }],
        fields: from?.fields ?? null,
        ask: asking,
        question: lastApp?.who === 'app' ? (lastApp.question ?? null) : null,
        retry: false,
      });
      return;
    } finally {
      setReading(false);
    }
    // Who read it, for the people building this (the console, and a line in development).
    if (reply.reader) console.info('[invest] read by', reply.reader.by, reply.reader.why ?? '');
    // Words that changed nothing build nothing again.
    const changed = !reply.say.some((x) => ['held', 'unfit', 'failed'].includes(x.key));
    // The person's own messages are kept with the sheet: a reader that reads the whole conversation
    // (the guided intake, once they sign in) is sent them again.
    const kept =
      input.kind === 'text' && !reply.sheet.intake && !reply.say.some((x) => x.key === 'failed')
        ? [...(from?.words ?? []), input.text.trim()].slice(-MAX_WORDS)
        : null;
    setSheet(kept ? { ...reply.sheet, words: kept } : reply.sheet);
    // The limits on the page are no longer the ones a plan was built for.
    if (changed) wanted.current += 1;
    if (!reply.valid) setBuild({ kind: 'idle' });
    // What our server read back is confirmed before anything is made from it (gate GUIDED-INTAKE),
    // each time it changes: the read-back is followed by "Yes, build it", never by a plan. A change
    // by this app's own questions, which the person answered one by one, builds again at once.
    const guidedChange =
      reply.sheet.intake !== undefined &&
      changed &&
      reply.valid !== null &&
      JSON.stringify(reply.valid) !== JSON.stringify(built?.sheet ?? null);
    if (guidedChange && sure) setConfirmed(false);
    const rebuild = reply.valid !== null && sure && changed && reply.sheet.intake === undefined;
    // "Shall I build it?" is not asked again once a plan was asked for, nor by a turn that changed
    // nothing: the question was already put, and is not said over in the same words.
    const lines = reply.say.filter((s) => !((sure || !changed) && s.key === 'ready'));
    say({
      // never an empty reply: with nothing else to say, what is held is said
      say: lines.length === 0 && !reply.ask && !reply.question ? [{ key: 'held' }] : lines,
      fields: reply.sheet.fields,
      ask: reply.ask,
      question: reply.question ?? null,
      reader: reply.reader,
      retry: false,
    });
    if (rebuild && reply.valid) void buildFrom(reply.valid, signedIn);
  }

  /** "Start over": the conversation, the goal and the plans on the pane are emptied. */
  function startOver() {
    wanted.current += 1;
    wantsInvest.current = false;
    setTurns([]);
    setSheet(null);
    setConfirmed(false);
    setBuilt(null);
    setPicked(null);
    setBuild({ kind: 'idle' });
    setText('');
    setPaneOpen(false);
  }

  function confirm(words: string = w.replies.build) {
    if (!valid) return;
    said(words);
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
          // a plan built before the country left the sheet may carry one: it is not sent again
          country: '',
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
      // A plan was asked for before the page was left (a sign-in that came back): it is built again
      // from the same sheet, and neither the question nor its answer is offered a second time.
      if (
        kept.turns.some((turn) => turn.who === 'app' && turn.say.some((x) => x.key === 'built'))
      ) {
        setConfirmed(true);
        again.current = true;
      }
      // What our server said of the conversation is never read back from the tab: it is asked again.
      replay.current = kept.sheet.intake !== undefined;
    }
    setRestored(true);
  }, []);
  const replay = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the person and their chain are known again
  useEffect(() => {
    if (!replay.current || !guided || !sheet?.intake) return;
    replay.current = false;
    let mine = true;
    setReading(true);
    void conversation
      .turn({ kind: 'replay' }, sheet)
      .then((reply) => {
        if (!mine) return;
        setSheet(reply.sheet);
        say({
          say: reply.say,
          fields: reply.sheet.fields,
          ask: reply.ask,
          question: reply.question ?? null,
          retry: false,
        });
      })
      .finally(() => setReading(false));
    return () => {
      mine = false;
    };
  }, [guided, restored]);
  const again = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the kept sheet is valid for the chain
  useEffect(() => {
    if (!again.current || !valid || built || build.kind !== 'idle') return;
    again.current = false;
    void buildFrom(valid, signedIn, true);
  }, [valid]);
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
      setBuilt(null);
      setPicked(null);
      setBuild({ kind: 'idle' });
      return;
    }
  }, [whoNow]);

  // A visitor who signs in keeps the conversation, and the plan they were shown is built again as
  // their own, once their chain is known: its vault is theirs, and the server keeps it for them.
  const visitorPlan = built !== null && !built.own;
  const ready = account.status === 'ready' && who !== '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the person is ready and the plan shown is a visitor's
  useEffect(() => {
    if (ready && visitorPlan && valid && build.kind !== 'building')
      void buildFrom(valid, true, true);
  }, [ready, visitorPlan, valid]);

  // A plan lives on one chain (gate ONE-CHAIN). When the person moves to another, the plan on the
  // page is another chain's: it is built again for the chain they are on.
  const planOn = built?.one.proposal.sheet.chains[0] ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the chain is no longer the plan's
  useEffect(() => {
    if (planOn && chain && planOn !== chain && valid && build.kind !== 'building')
      void buildFrom(valid, signedIn && built?.own === true);
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
    // The plan is built again as theirs once they are in, and the invest card is on the pane then.
    wantsInvest.current = true;
    say({ say: [{ key: 'signIn' }], fields: null, ask: null, retry: false });
    if (signedIn && valid && !plan.own) void buildFrom(valid, true, true);
  }

  // What the invest card tells the conversation (features/order/Invest.tsx): one line as each step
  // runs, in the card's own words, then that the vault is open, or that the buy stopped short.
  const lastLine = useRef('');
  function onProgress(progress: InvestProgress) {
    if (progress.line === '' || progress.line === lastLine.current) return;
    lastLine.current = progress.line;
    say({ say: [{ key: 'progress', text: progress.line }], fields: null, ask: null, retry: false });
  }
  /** Whether the pane is the phone's overlay: under the width the two panes sit side by side at. */
  const onPhone = () =>
    typeof window.matchMedia !== 'function' || window.matchMedia('(max-width: 1023.98px)').matches;
  const onDone = () => say({ say: [{ key: 'done' }], fields: null, ask: null, retry: false });
  const onStopped = (stopped: { orderId: string }) =>
    say({
      say: [{ key: 'stopped', orderId: stopped.orderId }],
      fields: null,
      ask: null,
      retry: false,
    });

  // On a phone the pane opens over the conversation as a dialog: focus goes into it, Escape and its
  // one button close it, and focus goes back to the line that opened it.
  const closePane = useRef<HTMLDivElement>(null);
  const openPane = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (paneOpen) closePane.current?.querySelector('button')?.focus();
    else if (wasOpen.current) openPane.current?.querySelector('button')?.focus();
    wasOpen.current = paneOpen;
  }, [paneOpen]);

  // A development build only: who read each turn is shown under it. A production build has no way
  // to turn this on.
  const [debug, setDebug] = useState(false);
  useEffect(() => setDebug(process.env.NODE_ENV === 'development'), []);

  const lastTurn = turns[turns.length - 1];
  const open = lastTurn?.who === 'app' ? lastTurn : null;
  const busy = reading || build.kind === 'building';
  // Every fact is known and no plan was asked for yet: "Build my plan" is the one reply.
  // The plans on the pane were made from another sheet than the one that is held now.
  const pending =
    built !== null && valid !== null && JSON.stringify(valid) !== JSON.stringify(built.sheet);
  const toConfirm = valid !== null && !confirmed && (!built || pending);
  const fields = sheet?.fields ?? null;
  const planChain = built?.one.proposal.sheet.chains[0] ?? chain;
  const chainName = planChain ? t.chain.names[planChain] : '';
  const network = planChain ? port.network(planChain) : null;
  const blocked =
    built && planChain
      ? network?.on === false
        ? t.plan.chainOff(chainName)
        : chainReady(planChain, onMock(port, planChain))
          ? null
          : t.plan.chainNotReady(chainName)
      : null;
  // The plan is the person's own, on a chain that can be invested in: the invest card is on the
  // pane under it, and the pane's last state is the plan and its one press.
  // The plan on the page is from before a change: a fact is asked about again, or the plan is being
  // built again. It is not invested in, by the card or by a button that names its old amount.
  const stale = built !== null && (build.kind === 'building' || asking !== null || pending);
  const canInvest = plan?.own === true && signedIn && blocked === null && !stale;
  // The pane's states: nothing yet; the goal as facts; the candidates side by side, none picked; the
  // plan that was picked; and that plan with its invest card.
  const state = canInvest
    ? 'invest'
    : plan
      ? 'plan'
      : built
        ? 'choice'
        : fields
          ? 'facts'
          : 'empty';
  /** A candidate, by its name or its word in either language, said alone or after "choose". */
  const candidateSaid = (typed: string): PlanCandidateId | null => {
    if (!built || plan) return null;
    const said = typed
      .toLowerCase()
      .replace(/[.!?…]+$/, '')
      .trim();
    const named = built.candidates.filter((c) =>
      [c.candidate, t.plan.choice.names[c.candidate].toLowerCase()].some(
        (name) => said === name || new RegExp(`^(${w.pickWords})\\s+${name}$`).test(said),
      ),
    );
    return named.length === 1 ? (named[0] as PlanCandidate).candidate : null;
  };
  /**
   * A way to close a gap, pressed. It is said as the person's own turn, in their words: what changes
   * and to what, from the sheet's figure. Never the engine's sentence as if they typed it.
   */
  function closeGap(way: string) {
    if (!built) return;
    const change = wayChange(way, built.one.proposal.sheet);
    void post(
      change ? { kind: 'answer', ...change } : { kind: 'text', text: way },
      change?.fact === 'amount'
        ? w.ways.amount(factValue('amount', change.value, t, lang))
        : change?.fact === 'income'
          ? w.ways.income(factValue('income', change.value, t, lang))
          : w.ways.other,
    );
  }
  function pick(candidate: PlanCandidateId, words?: string) {
    if (words) said(words);
    setPicked(candidate);
    say({ say: [{ key: 'picked', candidate }], fields: null, ask: null, retry: false });
  }
  // What the invest step is called once one of several plans is picked: "Invest $2,000 in Cover".
  const investIn =
    plan && pickedName && built && built.candidates.length > 1
      ? t.plan.investIn(dollars(plan.proposal.sheet.amountUsd, lang), pickedName)
      : null;
  const knownCount = FACTS.filter((fact) => known(fields, fact)).length;

  /** The quick replies of a question this app asks itself. */
  const replies = (fact: Fact): QuickReply[] =>
    QUICK[fact].map((value) => ({
      posts: { kind: 'answer', fact, value },
      label: { kind: 'fact', fact, value },
    }));
  /** The words of a quick reply. A choice our server offers is said in its words. */
  const replyLabel = (r: QuickReply) =>
    r.label.kind === 'option'
      ? r.label.text
      : r.label.kind === 'word'
        ? r.label.word === 'noDate'
          ? t.goal.card.noDate
          : w.replies[r.label.word]
        : r.label.kind === 'share'
          ? formatBps(r.label.bps, LOCALE[lang])
          : r.label.value === ''
            ? w.replies.noIncome
            : factValue(r.label.fact, r.label.value, t, lang);

  const line = (s: Extract<Turn, { who: 'app' }>['say'][number], at: SheetFields | null) => {
    switch (s.key) {
      case 'understood':
        return at ? w.say.understood(saidBack(at, t, lang)) : '';
      case 'notUnderstood':
        return w.say.notUnderstood;
      case 'held':
        return at ? w.say.held(saidBack(at, t, lang)) : '';
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
      case 'cantPick':
        return w.say.cantPick[PICKS[s.pick].kind](PICKS[s.pick].name);
      case 'riskTop':
        return w.say.riskTop;
      case 'riskBottom':
        return w.say.riskBottom;
      case 'simple':
        return w.say.simple;
      case 'notAnswer':
        return w.say.notAnswer;
      case 'said':
        return '';
      case 'ready':
        return w.say.ready;
      case 'building':
        return w.say.building;
      case 'built':
        return w.say.built;
      case 'builtChoice':
        return w.say.builtChoice;
      case 'picked':
        return w.say.picked(t.plan.choice.names[s.candidate]);
      case 'signIn':
        return w.say.signIn;
      case 'failure':
      case 'progress':
        return s.text;
      case 'done':
        return w.say.done;
      case 'stopped':
        return w.say.stopped;
    }
  };

  return (
    <div
      data-ui="invest-screen"
      className="flex flex-col gap-6 lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-10"
    >
      {/* Left: the conversation, held in view at the height of the window with its thread scrolling
          inside it. The plan beside it has no scroll of its own: it scrolls with the page. */}
      <section
        data-ui="invest-chat"
        aria-label={w.chat}
        inert={paneOpen}
        className="flex min-h-0 flex-col gap-4 lg:sticky lg:top-24 lg:col-span-5 lg:h-[calc(100dvh-13rem)] lg:min-h-[32rem]"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className={PAGE_TITLE}>{t.goal.title}</h1>
          {/* an empty conversation and an empty pane, by one press or by saying so */}
          {turns.length > 0 && (
            <span data-ui="invest-start-over">
              <Button variant="link" disabled={busy} onClick={startOver}>
                {w.startOver}
              </Button>
            </span>
          )}
        </div>
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
                {turn.say
                  // what is held is not said over again under a line that says what was not taken
                  .filter(
                    (s) =>
                      s.key !== 'held' ||
                      !turn.say.some((x) => ['cantPick', 'riskTop', 'riskBottom'].includes(x.key)),
                  )
                  .map((s) => (
                    <p key={`${s.key}:${'fact' in s ? s.fact : ''}`} className="text-body">
                      {s.key === 'built' ? (
                        // beside the conversation on a wide screen, at its foot on a phone
                        <>
                          <span className="max-lg:hidden">{w.say.built}</span>
                          <span className="lg:hidden">{w.say.builtBelow}</span>
                        </>
                      ) : s.key === 'said' ? (
                        // our server's own sentences, from its templates: shown as given
                        s.lines.map((sentence) => (
                          <span key={sentence} data-ui="invest-said" className="block">
                            {sentence}
                          </span>
                        ))
                      ) : (
                        line(s, turn.fields)
                      )}
                      {/* where the vault is, once it is open; where a buy that stopped is finished */}
                      {s.key === 'done' && (
                        <>
                          {' '}
                          <Link href="/monitor" className={buttonClass({ variant: 'link' })}>
                            {t.order.outcome.seePortfolio}
                          </Link>
                        </>
                      )}
                      {s.key === 'stopped' && (
                        <>
                          {' '}
                          <Link
                            href={`/orders/${encodeURIComponent(s.orderId)}`}
                            className={buttonClass({ variant: 'link' })}
                          >
                            {w.say.finish}
                          </Link>
                        </>
                      )}
                    </p>
                  ))}
                {/* Words that changed nothing: what can be done next is said, in context. */}
                {turn.say.some((x) => x.key === 'held') &&
                  !turn.say.some((x) => x.key === 'ready' || x.key === 'cantPick') &&
                  !turn.ask && (
                    <p className="text-body">
                      {built ? w.say.heldBuilt : valid ? w.say.heldReady : w.say.heldOpen}
                    </p>
                  )}
                {/* Who read the turn: for the people building this, never in a build people use. */}
                {debug && turn.reader && (
                  <p
                    data-ui="invest-reader"
                    className="font-mono text-source text-muted-foreground"
                  >
                    {`[${turn.reader.by}${turn.reader.why ? `: ${turn.reader.why}` : ''}]`}
                  </p>
                )}
                {/* The one question: in our server's words where it wrote it, else this app's. */}
                {turn.question ? (
                  <p data-ui="invest-question" className="text-body font-medium">
                    {turn.question.text}
                  </p>
                ) : (
                  turn.ask && (
                    <p data-ui="invest-question" className="text-body font-medium">
                      {w.ask[turn.ask]}
                    </p>
                  )
                )}
                {/* The replies of the turn that is open, right under it: one press answers. */}
                {turn === open &&
                  !busy &&
                  (turn.ask || turn.question || toConfirm || (turn.retry && valid)) && (
                    <div data-ui="invest-replies" className="mt-1 flex flex-wrap gap-2">
                      {(turn.question
                        ? turn.question.replies
                        : turn.ask
                          ? replies(turn.ask)
                          : []
                      ).map((r) => (
                        <Button
                          key={JSON.stringify(r.posts)}
                          variant="chip"
                          onClick={() => post(r.posts, replyLabel(r))}
                        >
                          {replyLabel(r)}
                        </Button>
                      ))}
                      {toConfirm && !turn.ask && !turn.question && (
                        <Button variant="primary" onClick={() => confirm()}>
                          {w.replies.build}
                        </Button>
                      )}
                      {turn.retry && valid && !toConfirm && (
                        <Button variant="secondary" onClick={() => buildFrom(valid, signedIn)}>
                          {w.failure.again}
                        </Button>
                      )}
                    </div>
                  )}
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
        <Composer
          label={w.box}
          labelHidden
          value={text}
          onChange={setText}
          onSubmit={(typed) => {
            setText('');
            void post({ kind: 'text', text: typed, asked: asking }, typed.trim());
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
      <div
        ref={openPane}
        inert={paneOpen}
        className="sticky bottom-0 z-10 -mx-1 border-t border-border bg-background px-1 py-3 lg:hidden"
      >
        <Button
          variant="secondary"
          className="w-full justify-between"
          aria-expanded={paneOpen}
          aria-controls={paneId}
          onClick={() => setPaneOpen(true)}
        >
          <span data-ui="invest-summary" className="truncate">
            {built
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
        // open over the conversation on a phone, it is a dialog; beside it, the page's aside
        {...(paneOpen ? { role: 'dialog', 'aria-modal': true } : {})}
        onKeyDown={(e) => {
          if (paneOpen && e.key === 'Escape') setPaneOpen(false);
        }}
        className={cn(
          'min-h-0 flex-col gap-6 lg:col-span-7 lg:flex lg:border-l lg:border-border lg:pl-10',
          paneOpen
            ? 'fixed inset-0 z-40 flex overflow-y-auto bg-background p-4 pt-28 lg:static lg:z-auto lg:overflow-visible lg:p-0 lg:pt-0'
            : 'hidden',
        )}
      >
        <div ref={closePane} className="lg:hidden">
          <Button variant="secondary" onClick={() => setPaneOpen(false)}>
            {w.pane.close}
          </Button>
        </div>
        {state === 'empty' && <EmptyPane />}
        {fields && (
          <Facts
            fields={fields}
            skipped={sheet?.skipped ?? []}
            held={sheet?.intake ?? null}
            disabled={busy}
            onChange={(fact) => post({ kind: 'reopen', fact }, w.facts.changeSay[fact])}
            build={toConfirm && !busy ? () => confirm() : null}
            visitor={!signedIn}
          />
        )}
        {build.kind === 'building' && <LatticeStatus label={w.pane.building} />}
        {stale && build.kind !== 'building' && (
          <p data-ui="pane-stale" className="text-body-sm text-muted-foreground">
            {w.pane.stale}
          </p>
        )}
        {/* The candidates side by side, none picked or marked: one is picked here, or by its name. */}
        {built && !plan && planChain && (
          <Candidates
            candidates={built.candidates}
            notShown={built.notShown}
            chain={planChain}
            disabled={stale}
            onPick={(candidate) =>
              pick(candidate, t.plan.choice.picker.buy(t.plan.choice.names[candidate]))
            }
            onWay={closeGap}
          />
        )}
        {plan && planChain && (
          <div className="motion-safe:animate-seat flex flex-col gap-4">
            {built && built.candidates.length > 1 && (
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p data-ui="pane-picked" className="text-body font-medium">
                  {w.pane.picked(pickedName ?? '')}
                </p>
                <Button variant="link" onClick={() => setPicked(null)}>
                  {w.pane.backToPlans}
                </Button>
              </div>
            )}
            <PlanPane
              plan={plan}
              chain={planChain}
              blocked={blocked}
              level={2}
              onWay={closeGap}
              // Its own button only while the card cannot be here. Signed out it leads to the
              // sign-in dialog. Signed in with a plan that is still a visitor's, it makes the plan
              // theirs. On a chain that is not ready it is off and says why. None while the plan
              // is from before a change.
              invest={
                canInvest || stale
                  ? undefined
                  : signedIn && plan.own
                    ? { onPress: invest, ...(investIn ? { label: investIn } : {}) }
                    : !signedIn
                      ? {
                          href: SIGN_IN,
                          onFollow: invest,
                          ...(investIn ? { label: investIn } : {}),
                        }
                      : valid
                        ? {
                            onPress: () => void buildFrom(valid, true, true),
                            label: w.pane.makeYours,
                          }
                        : // signed in, and their chain is still being read: nothing to press yet
                          undefined
              }
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
        {plan && canInvest && (
          <section
            data-ui="invest-step"
            aria-label={investIn ?? w.pane.investTitle}
            className="flex flex-col gap-4"
          >
            {/* which of the plans the card under this buys */}
            {investIn && (
              <h2 data-ui="invest-in" className="text-[1.125rem]/7 font-medium">
                {investIn}
              </h2>
            )}
            <Invest
              // a plan built again is another plan: its card starts over
              key={plan.id}
              of={{ plan: plan.id }}
              amount={plan.proposal.sheet.amountUsd}
              onProgress={onProgress}
              onDone={onDone}
              onStopped={onStopped}
            />
          </section>
        )}
      </aside>
    </div>
  );
}

/** The pane before anything is said: the outline of a plan, drawn in hairlines, and what fills it. */
function EmptyPane() {
  const t = useT();
  const w = t.talk.pane.empty;
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
  held,
  disabled,
  onChange,
  build,
  visitor,
}: {
  fields: SheetFields;
  skipped: readonly Fact[];
  /** What the guided intake read beyond the five facts: no date, a stated mix, themes. */
  held: Pick<IntakeState, 'mix' | 'themes' | 'horizonOpen'> | null;
  disabled: boolean;
  onChange: (fact: Fact) => void;
  /** Every fact is known and no plan was asked for yet: the way to ask is here too. */
  build: (() => void) | null;
  /** Not signed in: said once, quietly, that this needs no account. */
  visitor: boolean;
}) {
  const t = useT();
  const lang = useLang();
  const w = t.talk.facts;
  const shown = FACTS.filter((fact) => fact !== 'income' || fields.goal === 'income');
  const share = (bps: number) => formatBps(bps, LOCALE[lang]);
  // What the person said to hold, from the sheet: each part with its share, largest first.
  const mix = held?.mix
    ? new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(
        (
          [
            ['growth', held.mix.growthBps],
            ['dollarYield', held.mix.dollarYieldBps],
            ['gold', held.mix.goldBps],
            ['cash', held.mix.cashBps],
          ] as const
        )
          .filter(([, bps]) => bps > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([part, bps]) => w.mixPart[part](share(bps))),
      )
    : null;
  const extras = [
    ...(held?.themes ?? []).map((theme) => ({
      key: `theme:${theme.name}`,
      label: w.theme,
      value: theme.shareBps === null ? theme.name : w.themeShare(theme.name, share(theme.shareBps)),
    })),
    ...(mix ? [{ key: 'mix', label: w.mix, value: mix }] : []),
  ];
  return (
    <section data-ui="pane-facts" aria-label={w.title} className="flex flex-col gap-2">
      <h2 className="text-[0.8125rem]/5 font-medium">{w.title}</h2>
      {/* As many cells as there are facts, in rows that end cleanly: an odd one out takes the row. */}
      <ul className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))]">
        {shown.map((fact) => {
          const set = known(fields, fact);
          const value = set
            ? factValue(fact, fields[fact], t, lang)
            : fact === 'income' && skipped.includes('income')
              ? w.noIncome
              : fact === 'horizon' && held?.horizonOpen
                ? t.goal.card.noDate
                : w.open;
          return (
            <li
              key={fact}
              data-fact={fact}
              data-set={set}
              className="bg-card max-sm:last:odd:col-span-2"
            >
              <button
                type="button"
                aria-disabled={disabled || undefined}
                onClick={() => {
                  if (!disabled) onChange(fact);
                }}
                className="flex h-full w-full flex-col items-start gap-0.5 px-3 py-2 text-left outline-none hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              >
                <span className="text-caption text-muted-foreground">
                  <span className="sr-only">{w.change} </span>
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
        {/* What was read beyond those: a theme, a mix the person stated. From the sheet, as it is. */}
        {extras.map((extra) => (
          <li
            key={extra.key}
            data-fact="held"
            className="flex flex-col gap-0.5 bg-card px-3 py-2 max-sm:last:odd:col-span-2"
          >
            <span className="text-caption text-muted-foreground">{extra.label}</span>
            <span className="text-body font-medium tabular-nums">{extra.value}</span>
          </li>
        ))}
      </ul>
      {build && (
        <div data-ui="pane-build" className="mt-2 flex flex-col items-start gap-1.5">
          <Button variant="secondary" onClick={build}>
            {w.build}
          </Button>
          {visitor && <p className="text-caption text-muted-foreground">{w.noAccount}</p>}
        </div>
      )}
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
  'cantPick',
  'riskTop',
  'riskBottom',
]);
/** What each field of the sheet may hold when read back: a value the sheet takes, or nothing. */
const FIELD_FORMS: Record<keyof SheetFields, RegExp> = {
  goal: /^(grow|income|protect)?$/,
  amount: /^(\d{1,9}(\.\d{1,2})?)?$/,
  income: /^(\d{1,9}(\.\d{1,2})?)?$/,
  horizon: /^\d{0,3}$/,
  risk: /^(low|medium|high)?$/,
  country: /^[A-Z]{0,2}$/,
  holdings: /^(yes|no)$/,
  glide: /^(yes|no)$/,
  language: /^(en|pt)$/,
};

/** Fields read back from the tab, held to the sheet's own values. Anything else: null, whole. */
function fieldsOf(raw: Record<string, unknown>): SheetFields | null {
  const keys = Object.keys(FIELD_FORMS) as (keyof SheetFields)[];
  if (!keys.every((key) => typeof raw[key] === 'string' && FIELD_FORMS[key].test(raw[key])))
    return null;
  return Object.fromEntries(keys.map((key) => [key, raw[key]])) as SheetFields;
}

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
  const cleanFields = fieldsOf(f);
  if (!cleanFields) return null;
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
        if (k.key === 'cantPick')
          return typeof k.pick === 'string' && Object.hasOwn(PICKS, k.pick)
            ? [{ key: k.key, pick: k.pick } as Say]
            : [];
        if (k.key === 'set' || k.key === 'unfit')
          return isFact(k.fact) ? [{ key: k.key, fact: k.fact } as Say] : [];
        return [{ key: k.key } as Say];
      });
      const at = (typeof t.fields === 'object' && t.fields !== null ? t.fields : null) as Record<
        string,
        unknown
      > | null;
      // a turn whose every line was our server's, or a failure's, has nothing left to say
      if (said.length === 0 && !isFact(t.ask)) continue;
      read.push({
        id: read.length,
        who: 'app',
        say: said,
        fields: at ? fieldsOf(at) : null,
        ask: isFact(t.ask) ? t.ask : null,
        retry: false,
      });
    } else return null;
  }
  // The person's own messages, and the answers they gave by a tap, each held to its own form. What
  // our server said of them (its sheet, its question, its sentences) is not read back.
  const { words, intake } = sheet as Record<string, unknown>;
  const said = Array.isArray(words)
    ? words.filter(
        (word): word is string =>
          typeof word === 'string' && word.trim() !== '' && word.length <= GOAL_TEXT.max,
      )
    : [];
  const state = (typeof intake === 'object' && intake !== null ? intake : null) as Record<
    string,
    unknown
  > | null;
  const answers = state ? IntakeAnswers.safeParse(state.answers) : null;
  const then = state ? IntakeAnswers.array().safeParse(state.answersThen) : null;
  return {
    turns: read,
    sheet: {
      fields: cleanFields,
      skipped: skipped.filter(isFact),
      ...(Array.isArray(words) && said.length === words.length && said.length <= MAX_WORDS
        ? { words: said }
        : {}),
      ...(answers?.success && then?.success && said.length > 0
        ? {
            intake: {
              answers: answers.data,
              answersThen: then.data.slice(0, MAX_WORDS),
              sheet: null,
              question: null,
              mix: null,
              themes: [],
              horizonOpen: answers.data.horizonOpen === true,
            },
          }
        : {}),
    },
  };
}
