'use client';
import type { BasketSheet, ChainId, Network, Provenance } from '@colosseum/schemas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Composer } from '../../components/ui/Composer';
import { WORKSPACE_TITLE } from '../../components/ui/heading';
import { LatticeGlyph } from '../../components/ui/Lattice';
import { LatticeLoader } from '../../components/ui/Skeleton';
import { useWaitPhase } from '../../components/ui/wait';
import { dictionary } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { buildPlan, PERSONALIZE_PATH } from '../goal/build-plan';
import { UseGoalMix } from '../mix/UseGoalMix';
import { rememberPlan } from '../order/plan-store';
import { share } from '../portfolio/figures';
import {
  replyText,
  strategyReplyOf,
  VaultAgentError,
  type VaultAgentReply,
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
import { goalAgent } from './agent';
import { conversationStoreKey } from './conversations';
import { consumeGoalHandoff, readGoalHandoff } from './handoff';

export const goalConversationKey = (
  userId: string,
  chain: ChainId,
  provenance: Provenance,
  network: Network | null = conversationNetwork(chain),
) =>
  `tf-goal-conversation:2:${encodeURIComponent(userId)}:${chain}:${network ?? 'unconfigured'}:${provenance}`;

/** Plain browser history is never restored as a proposal, confirmation or executable order. */
export function GoalConversation({
  userId,
  chain,
  ready,
  provenance,
  conversationId = 'main',
  onSaved,
}: {
  userId: string | null;
  chain: ChainId | null;
  ready: boolean;
  provenance: Provenance | null;
  /** Which saved conversation of this browser is on screen (conversations.ts). */
  conversationId?: string;
  /** Called with the person's first words each time the transcript is saved. */
  onSaved?: (title: string) => void;
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
  const current = useRef(context);
  current.current = context;
  const generation = useRef(0);
  const requestApi = useRef(api);
  const cancel = useRef<AbortController | null>(null);
  const sending = useRef(false);
  const held = useRef<Turn[]>([]);
  const prefill = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [reply, setReply] = useState<VaultAgentReply | null>(null);
  // The preview the person chose to use: the flow stays only while that preview is the one shown.
  const [using, setUsing] = useState<VaultAgentReply | null>(null);
  const [error, setError] = useState<string>();
  // "Invest in this plan" (RELAXED-INTAKE) hands the plan's sheet to the existing personalize route
  // and the person on to the existing plan screen, where the deployed buy and vault creation run.
  const router = useRouter();
  const [investing, setInvesting] = useState(false);
  const [investError, setInvestError] = useState<string>();
  // The chat folds away so the plan can take the whole width.
  const [chatOpen, setChatOpen] = useState(true);
  async function investIn(sheet: Record<string, unknown>) {
    if (investing || !userId) return;
    setInvesting(true);
    setInvestError(undefined);
    const outcome = await buildPlan(api, sheet as BasketSheet, PERSONALIZE_PATH);
    if (outcome.kind === 'built') {
      for (const kept of [
        { id: outcome.id, proposal: outcome.proposal, rollUp: outcome.rollUp },
        ...outcome.candidates,
      ])
        rememberPlan({ id: kept.id, userId, proposal: kept.proposal, rollUp: kept.rollUp });
      router.push(`/plan/${encodeURIComponent(outcome.id)}`);
      return;
    }
    setInvesting(false);
    setInvestError(
      outcome.kind === 'no-plan'
        ? copy.investFailed.noPlan
        : outcome.kind === 'signed-out' || outcome.kind === 'no-identity'
          ? copy.investFailed.signedOut
          : copy.investFailed.other,
    );
  }
  useEffect(() => {
    ++generation.current;
    requestApi.current = api;
    current.current = context;
    cancel.current?.abort();
    held.current = key ? readLocal(key).transcript : [];
    setTurns(held.current);
    let restored: VaultAgentReply | null = null;
    try {
      const raw = previewKey && chain ? localStorage.getItem(previewKey) : null;
      restored = raw && chain ? strategyReplyOf(JSON.parse(raw), chain) : null;
    } catch {
      restored = null;
    }
    // A saved plan is shown without a sheet for investing (one saved earlier may be stale).
    if (restored?.proposal?.investSheet)
      restored = { ...restored, proposal: { ...restored.proposal, investSheet: undefined } };
    setReply(held.current.length ? restored : null);
    setBusy(false);
    sending.current = false;
    prefill.current = readGoalHandoff(userId, ready);
    setText(prefill.current ?? '');
    setError(undefined);
    setLoaded(true);
    return () => {
      ++generation.current;
      cancel.current?.abort();
    };
  }, [api, key, context, userId, ready, previewKey, chain]);

  function keepPreview(next: VaultAgentReply | null) {
    if (!previewKey || !chain) return;
    try {
      if (next?.proposal)
        localStorage.setItem(
          previewKey,
          // The plan is kept without its sheet for investing: a sheet made by an older bridge is
          // never invested from; the button comes back with the next reply.
          JSON.stringify({
            version: 1,
            chain,
            messageId: 'kept',
            ...next,
            proposal: next.proposal ? { ...next.proposal, investSheet: undefined } : next.proposal,
          }),
        );
      else localStorage.removeItem(previewKey);
    } catch {
      // storage full or blocked: the plan is still on screen for this visit
    }
  }

  function persist(next: Turn[]) {
    if (!key) return false;
    const saved = writeLocal(key, { revision: 0, transcript: next });
    if (!saved) setError(copy.notSaved);
    const first = next.find((turn) => turn.who === 'person')?.text.trim();
    if (saved && first) onSaved?.(first.length > 60 ? `${first.slice(0, 59)}…` : first);
    return saved;
  }
  function startOver() {
    if (sending.current) return;
    ++generation.current;
    held.current = [];
    setTurns([]);
    setText('');
    setReply(null);
    keepPreview(null);
    setError(undefined);
    persist([]);
  }
  async function send(words: string) {
    if (!ready || !chain || !key || !loaded || sending.current) return;
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
    setText('');
    // The draft on the card stays while its successor is worked on, so the new one can show what
    // changed; it is marked as the one before, and it can no longer be used. It changes when the new
    // answer is in, and an answer with no plan, or none at all, leaves it in view (Rodrigo, Oct 8).
    setUsing(null);
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
        setError(copy.capacity);
        return;
      }
      held.current = completed;
      setTurns(completed);
      // An answer with no plan (a question only) keeps the last plan in view.
      setReply((previous) => {
        const shown =
          result.proposal || !previous?.proposal
            ? result
            : { ...result, proposal: previous.proposal };
        keepPreview(shown);
        return shown;
      });
      persist(completed);
    } catch (cause) {
      if (active()) {
        // their words go back in the box, unless they have typed something else meanwhile
        setText((now) => (now === '' ? words : now));
        setError(
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
  // The person's last words with no reply after them: a failed reply, or one a reload cut short.
  const unanswered = !busy && ready && loaded ? turns.at(-1) : undefined;
  // a wait under 400ms shows nothing; after that the lattice assembles beside the words (STYLE.md)
  const waiting = useWaitPhase(busy) !== 'quiet';
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
          {turns.length > 0 && (
            <Button variant="link" disabled={busy} onClick={startOver}>
              {t.talk.startOver}
            </Button>
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
        <ol
          data-ui="goal-transcript"
          aria-live="polite"
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
        <Composer
          label={copy.invitation}
          labelHidden
          value={text}
          onChange={setText}
          onSubmit={send}
          maxLength={2000}
          placeholder={copy.placeholder}
          busy={busy}
          disabled={!ready || !loaded}
          error={error}
          lang={lang}
          labels={{
            submit: t.shared.vault.conversation.submitMessage,
            busy: t.shared.vault.conversation.reading,
          }}
        />
        {unanswered?.who === 'person' && (
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
        )}
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
        {reply?.proposal ? (
          <>
            <StrategyPreview
              proposal={reply.proposal}
              previewOnly={copy.draftNote}
              {...(busy ? { pending: t.shared.vault.conversation.reworking } : {})}
              {...(chain && userId && using !== reply
                ? { use: { label: t.mix.preview.use, onUse: () => setUsing(reply) } }
                : {})}
              invest={{
                onPress: () => {
                  const sheet = reply.proposal?.investSheet;
                  if (sheet) void investIn(sheet);
                },
                busy: investing,
                ...(investError ? { error: investError } : {}),
              }}
            />
            {chain && userId && using === reply && (
              <UseGoalMix
                chain={chain}
                userId={userId}
                allocations={reply.proposal.allocations}
                onClose={() => setUsing(null)}
              />
            )}
          </>
        ) : (
          <div
            data-ui="goal-empty-preview"
            className="flex min-w-0 flex-col items-start justify-center gap-3 rounded-lg border border-border bg-card p-4 sm:min-h-60"
          >
            {busy && waiting ? <LatticeLoader size={32} /> : <LatticeGlyph size={32} />}
            <h2 className="text-body-lg font-medium">{t.talk.workbench.strategy}</h2>
            {/* one region for both lines, there before its words change, so a screen reader hears
                that a draft is being worked on */}
            <p
              role="status"
              data-ui={busy ? 'goal-working' : undefined}
              className="max-w-[48ch] text-body-sm text-muted-foreground"
            >
              {busy ? copy.working : copy.empty}
            </p>
            <p className="text-caption text-muted-foreground">{copy.previewOnly}</p>
            {reply?.notes && <WeightNotes notes={reply.notes} />}
          </div>
        )}
      </div>
    </section>
  );
}
