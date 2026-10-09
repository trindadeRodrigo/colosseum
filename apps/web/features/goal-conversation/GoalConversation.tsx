'use client';
import type { ChainId, Network, Provenance } from '@colosseum/schemas';
import Link from 'next/link';
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Composer } from '../../components/ui/Composer';
import { WORKSPACE_TITLE } from '../../components/ui/heading';
import { LatticeGlyph } from '../../components/ui/Lattice';
import { StatusMark } from '../../components/ui/StatusMark';
import { dictionary, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import {
  type DepositHost,
  DepositSign,
  type OpenDeposit,
  UnfinishedDeposit,
} from '../mix/DepositSign';
import { DepositStep, type Purpose } from '../mix/DepositStep';
import { recallOrder } from '../order/order-record';
import { share } from '../portfolio/figures';
import { DraftBuilding, PendingReply, ReplyAnnouncer, useChatScroll } from '../shared/ReplyPending';
import {
  replyText,
  strategyReplyOf,
  VaultAgentError,
  type VaultStrategyPreview,
} from '../vault-conversation/agent';
import { StrategyPreview, WeightNotes } from '../vault-conversation/StrategyPreview';
import {
  conversationNetwork,
  readLocal,
  type Turn,
  transcriptOf,
  writeLocal,
} from '../vault-conversation/storage';
import { useApiFetch } from '../wallet/WalletProvider';
import { type GoalReply, goalAgent } from './agent';
import { conversationStoreKey } from './conversations';
import { consumeGoalHandoff, readGoalHandoff } from './handoff';

export const goalConversationKey = (
  userId: string,
  chain: ChainId,
  provenance: Provenance,
  network: Network | null = conversationNetwork(chain),
) =>
  `tf-goal-conversation:2:${encodeURIComponent(userId)}:${chain}:${network ?? 'unconfigured'}:${provenance}`;

/**
 * Plain browser history is never restored as a proposal, confirmation or executable order. The one
 * thing taken up again after a reload is a deposit the person already approved here (gate
 * DEPOSIT-IN-PLACE): this browser keeps its plan's and its order's ids beside the transcript, and the
 * pane opens on that order as its own record and our server have it, never on anything kept here.
 */
export function GoalConversation({
  userId,
  chain,
  ready,
  provenance,
  conversationId = 'main',
  onSaved,
  onDeposit,
  chainControl,
  carried,
}: {
  userId: string | null;
  chain: ChainId | null;
  ready: boolean;
  provenance: Provenance | null;
  /** Which saved conversation of this browser is on screen (conversations.ts). */
  conversationId?: string;
  /** Called with the person's first words each time the transcript is saved. */
  onSaved?: (first: string) => void;
  /**
   * Called as a deposit is open on the pane (approved, its steps not all confirmed) whichever way the
   * pane came to show it, with whether a step is being signed now, and as it no longer is.
   */
  onDeposit?: (state: { open: boolean; signing: boolean }) => void;
  /**
   * The chain of this plan, drawn beside the box (GoalChain, gate CHAIN-AT-THE-PLAN): a choice while
   * the conversation has no words, its badge with "Change" once it has.
   */
  chainControl?: (state: { started: boolean; busy: boolean }) => ReactNode;
  /**
   * Words typed before the first message on another chain, carried over when the chain was changed
   * beside the box: the box starts with them.
   */
  carried?: RefObject<{ chain: ChainId; text: string } | null>;
}) {
  const t = useT();
  const lang = useLang();
  const copy = t.goal.explore;
  const api = useApiFetch();
  const base =
    userId && chain && provenance ? goalConversationKey(userId, chain, provenance) : null;
  const key = base ? conversationStoreKey(base, conversationId) : null;
  const context = `${key}:${ready}`;
  // Rodrigo, Oct 8: the last plan is kept in this browser beside the transcript and
  // shown again on return. It is read back through the same check as a fresh server reply
  // (strategyReplyOf), and it stays a preview: nothing here can buy or sign from it.
  const previewKey = key ? `${key}:preview` : null;
  const depositKey = key ? `${key}:deposit` : null;
  const current = useRef(context);
  current.current = context;
  const generation = useRef(0);
  const requestApi = useRef(api);
  const cancel = useRef<AbortController | null>(null);
  const sending = useRef(false);
  const held = useRef<Turn[]>([]);
  const prefill = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState(() =>
    carried?.current && carried.current.chain === chain ? carried.current.text : '',
  );
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [reply, setReply] = useState<GoalReply | null>(null);
  // The mix on the screen: the last proposal the conversation made. A reply that only talks, or one
  // that failed, leaves it there, so asking for a change never costs the person what they had.
  const [mix, setMix] = useState<VaultStrategyPreview | null>(null);
  // The deposit step is open, for the mix on the screen. Another proposal is read as a preview first.
  const [depositing, setDepositing] = useState(false);
  // The amount typed on the deposit step: kept while the mix is changed in the conversation. It starts
  // from the sum the person wrote in the conversation (DEPOSIT-DERIVE), and a newer sum replaces it
  // only while the person has not typed in the field, or has emptied it.
  const [amountText, setAmountText] = useState('');
  const typed = useRef(false);
  const typeAmount = (words: string) => {
    typed.current = words !== '';
    setAmountText(words);
  };
  // The deposit the person approved on this pane: from the press until every step is confirmed the
  // conversation waits, so no reply can take the pane from under a step that is being signed.
  const [open, setOpen] = useState<OpenDeposit | null>(null);
  const [signing, setSigning] = useState(false);
  // "Start over" was pressed with a deposit open: asked once more before it is left.
  const [asking, setAsking] = useState(false);
  // One state for every way the pane shows an approved deposit (just pressed, signing, stopped, taken
  // up again after a reload): it holds the box and the chain, and is what every way out asks about.
  const locked = open !== null && !open.done && !open.left;
  const openNow = useRef(open);
  openNow.current = open;
  const lockedNow = useRef(locked);
  lockedNow.current = locked;
  const tellDeposit = useRef(onDeposit);
  tellDeposit.current = onDeposit;
  useEffect(() => {
    tellDeposit.current?.({ open: locked, signing: locked && signing });
  }, [locked, signing]);
  useEffect(() => () => tellDeposit.current?.({ open: false, signing: false }), []);
  const [error, setError] = useState<string>();
  // The reply did not come: said in the transcript, where the reply would have been.
  const [failure, setFailure] = useState<string>();
  // What a screen reader hears, once each: that a reply is being fetched, then the reply.
  const [announced, setAnnounced] = useState('');
  // The mix on the screen was read back from this browser, not answered on this visit: it is shown, and
  // the deposit comes back with the next reply (Rodrigo, Oct 8: a kept plan is a preview only).
  const [kept, setKept] = useState(false);
  // The chat folds away so the plan can take the whole width.
  const [chatOpen, setChatOpen] = useState(true);
  useEffect(() => {
    ++generation.current;
    requestApi.current = api;
    current.current = context;
    cancel.current?.abort();
    held.current = key ? readLocal(key).transcript : [];
    setTurns(held.current);
    let restored: VaultStrategyPreview | null = null;
    try {
      const raw = previewKey && chain ? localStorage.getItem(previewKey) : null;
      restored = (raw && chain ? strategyReplyOf(JSON.parse(raw), chain) : null)?.proposal ?? null;
    } catch {
      restored = null;
    }
    // A deposit approved here before a reload: only one whose order this browser kept for this person,
    // approved, for that plan and chain. Its amount is the order record's own.
    let resumed: OpenDeposit | null = null;
    try {
      const raw = depositKey && chain ? localStorage.getItem(depositKey) : null;
      const read = raw ? (JSON.parse(raw) as Partial<OpenDeposit>) : null;
      const record =
        read && typeof read.orderId === 'string' ? recallOrder(read.orderId, userId) : null;
      if (read && record?.approved && record.proposalId === read.planId && record.chain === chain)
        resumed = {
          planId: record.proposalId,
          orderId: record.orderId,
          amountUsd: record.amountUsd,
          ...(read.left === true ? { left: true as const } : {}),
        };
      else if (raw && depositKey) localStorage.removeItem(depositKey);
    } catch {
      resumed = null;
    }
    setOpen(resumed);
    setSigning(false);
    setAsking(false);
    setReply(null);
    setMix(held.current.length ? restored : null);
    setKept(Boolean(held.current.length && restored));
    setDepositing(false);
    setAmountText('');
    typed.current = false;
    setBusy(false);
    sending.current = false;
    prefill.current = readGoalHandoff(userId, ready);
    // What the box holds stays: it is empty on a new conversation, or the words carried over.
    setText((now) => prefill.current ?? now);
    setError(undefined);
    setFailure(undefined);
    setAnnounced('');
    setLoaded(true);
    return () => {
      ++generation.current;
      cancel.current?.abort();
    };
  }, [api, key, context, userId, ready, previewKey, depositKey, chain]);

  /** The open deposit's ids are kept beside the transcript, so a reload finds its order again. */
  function keepOpen(next: OpenDeposit | null) {
    setOpen(next);
    if (!next || next.left) setSigning(false);
    if (!depositKey) return;
    try {
      // only the ids and whether it was left: done is the server's to say, each visit
      if (next)
        localStorage.setItem(
          depositKey,
          JSON.stringify({
            planId: next.planId,
            orderId: next.orderId,
            amountUsd: next.amountUsd,
            ...(next.left ? { left: true } : {}),
          }),
        );
      else localStorage.removeItem(depositKey);
    } catch {
      // storage full or blocked: the deposit is still on the pane for this visit
    }
  }
  /** Leaves the deposit on the pane: one that is not done is set aside and said to be waiting. */
  function setAside() {
    const now = openNow.current;
    keepOpen(now && !now.done ? { ...now, left: true } : null);
  }
  const host: DepositHost = { onOpen: keepOpen, onRunning: setSigning, onLeave: setAside };

  /** The last mix is kept beside the transcript, read back through the same check as a reply. */
  function keepPreview(next: VaultStrategyPreview | null) {
    if (!previewKey || !chain) return;
    try {
      if (next)
        localStorage.setItem(
          previewKey,
          JSON.stringify({
            version: 1,
            chain,
            messageId: 'kept',
            message: 'kept',
            question: null,
            warnings: [],
            weightNotes: [],
            proposal: next,
          }),
        );
      else localStorage.removeItem(previewKey);
    } catch {
      // storage full or blocked: the mix is still on screen for this visit
    }
  }

  function persist(next: Turn[]) {
    if (!key) return false;
    const saved = writeLocal(key, { revision: 0, transcript: next });
    if (!saved) setError(copy.notSaved);
    const first = next.find((turn) => turn.who === 'person')?.text.trim();
    if (saved) onSaved?.(first ?? '');
    return saved;
  }
  function startOver(sure = false) {
    if (sending.current) return;
    // A deposit is open: leaving it is asked once more. What was sent stays sent.
    if (lockedNow.current && !sure) return setAsking(true);
    setAsking(false);
    // an unfinished deposit outlives the conversation's words: it is still said to be waiting
    setAside();
    ++generation.current;
    held.current = [];
    setTurns([]);
    setText('');
    setReply(null);
    keepPreview(null);
    setMix(null);
    setKept(false);
    setDepositing(false);
    setAmountText('');
    typed.current = false;
    setError(undefined);
    setFailure(undefined);
    setAnnounced('');
    persist([]);
  }
  async function send(words: string) {
    if (!ready || !chain || !key || !loaded || sending.current || lockedNow.current) return;
    // Words that got no reply are sent again as the turn they already are, never as a second copy.
    const last = held.current.at(-1);
    const next =
      last?.who === 'person' && last.text === words
        ? held.current
        : [...held.current, { id: crypto.randomUUID(), who: 'person' as const, text: words }];
    if (!transcriptOf({ revision: 0, transcript: next })) {
      setError(copy.capacity);
      return;
    }
    const run = generation.current;
    const expected = context;
    const active = () => generation.current === run && current.current === expected;
    sending.current = true;
    setBusy(true);
    setError(undefined);
    setFailure(undefined);
    setAnnounced(t.shared.vault.conversation.reading);
    setText('');
    // The mix on the card stays while its successor is worked on, marked as the one before, and its
    // deposit action waits for the reply.
    held.current = next;
    setTurns(next);
    if (persist(next) && prefill.current && userId) {
      consumeGoalHandoff(prefill.current, userId);
      prefill.current = null;
    }
    const controller = new AbortController();
    cancel.current = controller;
    try {
      const result = await goalAgent(requestApi.current, chain, lang, next, controller.signal);
      if (!active()) return;
      const completed = [
        ...next,
        {
          id: crypto.randomUUID(),
          who: 'app' as const,
          text: replyText(result.message, result.question),
        },
      ];
      if (result.proposal) {
        let chunk = t.shared.vault.conversation.draftIntro;
        for (const line of [
          result.proposal.objective,
          ...result.proposal.allocations.map(
            (row) =>
              `${row.symbol ?? row.assetId} (${row.assetId}): ${share(lang, row.weightBps)} — ${row.why} [${row.evidenceIds.join(', ')}]`,
          ),
        ]) {
          if (chunk.length + line.length + 1 > 8000) {
            completed.push({ id: crypto.randomUUID(), who: 'app', text: chunk });
            chunk = t.shared.vault.conversation.draftIntro;
          }
          chunk += `\n${line}`;
        }
        completed.push({ id: crypto.randomUUID(), who: 'app', text: chunk });
      }
      if (!transcriptOf({ revision: 0, transcript: completed })) {
        setAnnounced('');
        setError(copy.capacity);
        return;
      }
      held.current = completed;
      setTurns(completed);
      setReply(result);
      setAnnounced(
        [
          `${t.talk.me}: ${replyText(result.message, result.question)}`,
          ...(result.proposal ? [t.shared.vault.conversation.draftArrived] : []),
        ].join(' '),
      );
      // Written as this page reads an amount back: "1500,5" in Portuguese, "1500.5" in English.
      if (result.amountUsd !== null && !typed.current)
        setAmountText(
          new Intl.NumberFormat(LOCALE[lang], {
            useGrouping: false,
            maximumFractionDigits: 2,
          }).format(result.amountUsd),
        );
      if (result.proposal) {
        setMix(result.proposal);
        setKept(false);
        setDepositing(false);
        // a deposit that is done gives the pane back to the next proposal
        if (openNow.current?.done) keepOpen(null);
        keepPreview(result.proposal);
      }
      persist(completed);
    } catch (cause) {
      if (active()) {
        // their words go back in the box, unless they have typed something else meanwhile
        setText((now) => (now === '' ? words : now));
        setAnnounced('');
        setFailure(
          cause instanceof VaultAgentError && cause.kind === 'unavailable'
            ? cause.reason === 'timeout'
              ? copy.timeout
              : cause.reason === 'budget'
                ? copy.budget
                : cause.reason === 'invalid'
                  ? copy.invalid
                  : copy.unavailable
            : copy.failed,
        );
      }
    } finally {
      if (active()) {
        sending.current = false;
        setBusy(false);
      }
    }
  }
  // What the person said the money is for and the risk, as the newest reply read the whole conversation.
  const said: Purpose = { goal: reply?.goal ?? null, risk: reply?.risk ?? null };
  // "Back to the proposal": focus goes to the button that opened the step, never to the page. A new
  // proposal closing the step leaves focus where the person is typing.
  const backToPreview = useRef(false);
  useEffect(() => {
    if (depositing || !backToPreview.current) return;
    backToPreview.current = false;
    box.current?.parentElement?.querySelector<HTMLElement>('[data-action="deposit"]')?.focus();
  }, [depositing]);
  /** Weights, the goal and the risk are changed by saying so: back to the box, the mix kept. */
  const toChat = () => box.current?.querySelector('textarea')?.focus();
  // The person's last words with no reply after them: a failed reply, or one a reload cut short.
  const unanswered = !busy && ready && loaded ? turns.at(-1) : undefined;
  useChatScroll(list, box, busy, `${context}:${loaded}`);
  const chatId = useId();
  return (
    <section
      data-ui="goal-conversation"
      data-workbench
      className="grid min-w-0 gap-4 md:min-h-0 md:flex-1 md:grid-cols-12 md:grid-rows-[auto_minmax(0,1fr)] md:items-stretch"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-3 md:col-span-12">
        <h1 className={WORKSPACE_TITLE}>{t.talk.workbench.title}</h1>
        <div className="flex flex-wrap items-baseline gap-3">
          <Button
            variant="link"
            aria-expanded={chatOpen}
            aria-controls={chatId}
            data-ui="goal-chat-toggle"
            onClick={() => setChatOpen((open) => !open)}
          >
            {chatOpen ? t.talk.hideChat : t.talk.showChat}
          </Button>
          {turns.length > 0 && !asking && (
            <Button variant="link" disabled={busy} onClick={() => startOver()}>
              {t.talk.startOver}
            </Button>
          )}
          {asking && (
            <LeaveDeposit
              signing={signing}
              onLeave={() => startOver(true)}
              onStay={() => setAsking(false)}
            />
          )}
        </div>
      </header>
      <div
        ref={box}
        id={chatId}
        data-ui="goal-chat"
        hidden={!chatOpen}
        className={`${chatOpen ? 'flex' : 'hidden'} min-w-0 flex-col gap-4 md:col-span-5 md:min-h-0`}
      >
        {turns.length === 0 && (
          <div className="flex flex-col gap-2">
            <p className="font-display font-semibold text-[1.25rem]/7">{copy.invitation}</p>
            <p className="text-body-sm text-muted-foreground">{copy.lead}</p>
          </div>
        )}
        <p className="text-caption text-muted-foreground">{copy.local}</p>
        <ReplyAnnouncer text={announced} />
        {/* Not a live region: the wait and the reply are announced once each, above. */}
        <ol
          ref={list}
          data-ui="goal-transcript"
          className="tf-scroll-thin relative flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto md:flex-1 md:pr-2"
        >
          {/* The person's own words sit on the honey glow, so they stand apart from the replies
              (Rodrigo, Oct 8); the column itself has no glow. */}
          {turns.map((turn) => (
            <li
              data-who={turn.who}
              key={turn.id}
              className={`min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] ${turn.who === 'person' ? 'max-w-[85%] self-end rounded-lg bg-honey-tint bg-glow px-4 py-3' : ''}`}
            >
              <span className="sr-only">{turn.who === 'person' ? t.talk.you : t.talk.me}: </span>
              {['en', 'pt'].some(
                (language) =>
                  turn.who === 'app' &&
                  turn.text.startsWith(
                    dictionary(language as 'en' | 'pt').shared.vault.conversation.draftIntro,
                  ),
              ) ? (
                <details data-ui="goal-draft-record">
                  <summary className="cursor-pointer text-body-sm">
                    {t.shared.vault.conversation.proposed}
                  </summary>
                  <p className="pt-2 text-caption">{turn.text}</p>
                </details>
              ) : (
                turn.text
              )}
            </li>
          ))}
          {/* The reply's place, under the words it answers: the wait, then the reply itself, or
              why it did not come and the way to ask again. */}
          {busy && <PendingReply speaker={t.talk.me} lines={copy.pendingLines} />}
          {unanswered?.who === 'person' && (
            <li data-ui="goal-unanswered" data-who="app" className="flex min-w-0 flex-col gap-2">
              {failure && (
                <p role="alert" className="flex items-start gap-1.5 text-body-sm text-destructive">
                  <StatusMark status="off-track" size={12} className="mt-1.5" />
                  <span>{failure}</span>
                </p>
              )}
              <p
                data-ui="goal-retry"
                className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body-sm"
              >
                <Button variant="link" data-act="goal-retry" onClick={() => send(unanswered.text)}>
                  {copy.retry}
                </Button>
                <Link href="/shelf" className="underline">
                  {copy.elsewhere}
                </Link>
              </p>
            </li>
          )}
        </ol>
        {!ready && (
          <p className="text-body-sm text-muted-foreground">
            {userId ? copy.readingAccount : copy.signIn}
          </p>
        )}
        {!userId && (
          <Link href="/sign-in?next=/goal" className="text-body-sm underline">
            {t.shell.signIn}
          </Link>
        )}
        {/* A draft exists once a reply came: words that got none leave the chain a plain choice. It
            is fixed while a reply is worked on and through the deposit step and its signing. */}
        {loaded &&
          chainControl?.({
            started: turns.some((turn) => turn.who === 'app'),
            // and while a deposit is open on the pane, however it came to be there (after a reload too)
            busy: busy || depositing || locked,
          })}
        <Composer
          label={copy.invitation}
          labelHidden
          value={text}
          onChange={setText}
          onSubmit={send}
          maxLength={2000}
          placeholder={copy.placeholder}
          busy={busy}
          // the next thought can be typed while a reply is on its way; only sending waits
          typeWhileBusy
          // a deposit open on the pane holds the box whatever else: its own line says why
          hint={
            locked
              ? signing
                ? copy.deposit.signing
                : copy.deposit.open
              : t.shared.vault.conversation.hint
          }
          busyHint={t.shared.vault.conversation.busyHint}
          disabled={!ready || !loaded || locked}
          error={error}
          lang={lang}
          labels={{ submit: t.shared.vault.conversation.submitMessage, busy: '' }}
        />
        {loaded && turns.length === 0 && (
          <ul
            data-ui="goal-starters"
            aria-label={t.goal.examples.label}
            className="flex flex-wrap gap-2"
          >
            {copy.starters.map((starter) => (
              <li key={starter}>
                <Button
                  variant="chip"
                  className="h-auto! min-h-8 py-1"
                  disabled={!ready || !key || busy}
                  onClick={() => {
                    setText(starter);
                    box.current?.querySelector('textarea')?.focus();
                  }}
                >
                  {starter}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div
        data-ui="goal-strategy"
        aria-busy={busy}
        className={`tf-scroll-thin relative flex min-w-0 flex-col gap-4 ${chatOpen ? 'md:col-span-7' : 'md:col-span-12'} md:min-h-0 md:overflow-y-auto md:pr-2`}
      >
        {open?.left && (
          <UnfinishedDeposit
            orderId={open.orderId}
            amountUsd={open.amountUsd}
            onBack={() => {
              setDepositing(false);
              keepOpen({ planId: open.planId, orderId: open.orderId, amountUsd: open.amountUsd });
            }}
            onGone={() => keepOpen(null)}
          />
        )}
        {mix && chain && userId && depositing && !kept ? (
          <>
            <DepositStep
              chain={chain}
              userId={userId}
              allocations={mix.allocations}
              said={said}
              amountText={amountText}
              onAmountText={typeAmount}
              provenance={provenance}
              onChangeMix={toChat}
              waiting={busy}
              onClose={() => {
                backToPreview.current = true;
                setDepositing(false);
              }}
              host={host}
            />
            {reply && !reply.proposal && reply.notes && <WeightNotes notes={reply.notes} />}
          </>
        ) : open && !open.left && chain && ready ? (
          // approved before a reload: the same steps, from the order's own record
          <DepositSign
            chain={chain}
            planId={open.planId}
            amountUsd={open.amountUsd}
            resume={open}
            host={host}
          />
        ) : mix ? (
          <>
            <StrategyPreview
              proposal={mix}
              previewOnly={copy.draftNote}
              wait={{
                banner: t.shared.vault.conversation.reworking,
                action: t.shared.vault.conversation.waitingAction,
              }}
              pending={busy}
              {...(chain && userId && !kept
                ? {
                    use: {
                      label: t.mix.preview.deposit,
                      onUse: () => setDepositing(true),
                      primary: true,
                    },
                  }
                : {})}
            />
            {reply && !reply.proposal && reply.notes && <WeightNotes notes={reply.notes} />}
          </>
        ) : (
          <div
            data-ui="goal-empty-preview"
            data-state={busy ? 'building' : 'empty'}
            className="flex min-w-0 flex-col items-start justify-center gap-3 rounded-lg border border-border bg-card p-4 sm:min-h-60"
          >
            {busy ? (
              // the first draft is being worked on: said at heading size, with the rows it will fill
              <DraftBuilding title={copy.building} line={copy.working} note={copy.previewOnly} />
            ) : (
              <>
                <LatticeGlyph size={32} />
                <h2 className="text-body-lg font-medium">{t.talk.workbench.strategy}</h2>
                <p className="max-w-[48ch] text-body-sm text-muted-foreground">{copy.empty}</p>
                <p className="text-caption text-muted-foreground">{copy.previewOnly}</p>
              </>
            )}
            {reply?.notes && <WeightNotes notes={reply.notes} />}
          </div>
        )}
      </div>
    </section>
  );
}

/** Asked before a deposit that is open is left: what was sent stays sent, the rest stays unsigned. */
export function LeaveDeposit({
  signing,
  onLeave,
  onStay,
}: {
  signing: boolean;
  onLeave: () => void;
  onStay: () => void;
}) {
  const w = useT().goal.explore.deposit;
  const id = useId();
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => {
    group.current?.querySelector<HTMLElement>('[data-action="stay"]')?.focus();
  }, []);
  return (
    <div
      ref={group}
      role="alertdialog"
      aria-labelledby={id}
      data-ui="leave-deposit"
      className="flex max-w-(--tf-measure-body) flex-wrap items-baseline gap-x-3 gap-y-1 text-body-sm"
    >
      <span id={id}>{signing ? w.leaveSigning : w.leave}</span>
      <Button variant="link" data-action="stay" onClick={onStay}>
        {w.stay}
      </Button>
      <Button variant="link" data-action="leave" onClick={onLeave}>
        {w.leaveYes}
      </Button>
    </div>
  );
}
