'use client';
import type { ChainId, Network, Provenance } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Composer } from '../../components/ui/Composer';
import { WORKSPACE_TITLE } from '../../components/ui/heading';
import { LatticeGlyph } from '../../components/ui/Lattice';
import { LatticeLoader } from '../../components/ui/Skeleton';
import { useWaitPhase } from '../../components/ui/wait';
import { dictionary, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { DepositStep, type Purpose } from '../mix/DepositStep';
import { share } from '../portfolio/figures';
import { replyText, VaultAgentError, type VaultStrategyPreview } from '../vault-conversation/agent';
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
}: {
  userId: string | null;
  chain: ChainId | null;
  ready: boolean;
  provenance: Provenance | null;
}) {
  const t = useT();
  const lang = useLang();
  const copy = t.goal.explore;
  const api = useApiFetch();
  const key = userId && chain && provenance ? goalConversationKey(userId, chain, provenance) : null;
  const context = `${key}:${ready}`;
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
  const [error, setError] = useState<string>();
  useEffect(() => {
    ++generation.current;
    requestApi.current = api;
    current.current = context;
    cancel.current?.abort();
    held.current = key ? readLocal(key).transcript : [];
    setTurns(held.current);
    setReply(null);
    setMix(null);
    setDepositing(false);
    setAmountText('');
    typed.current = false;
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
  }, [api, key, context, userId, ready]);

  function persist(next: Turn[]) {
    if (!key) return false;
    const saved = writeLocal(key, { revision: 0, transcript: next });
    if (!saved) setError(copy.notSaved);
    return saved;
  }
  function startOver() {
    if (sending.current) return;
    ++generation.current;
    held.current = [];
    setTurns([]);
    setText('');
    setReply(null);
    setMix(null);
    setDepositing(false);
    setAmountText('');
    typed.current = false;
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
        setError(copy.capacity);
        return;
      }
      held.current = completed;
      setTurns(completed);
      setReply(result);
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
        setDepositing(false);
      }
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
  // a wait under 400ms shows nothing; after that the lattice assembles beside the words (STYLE.md)
  const waiting = useWaitPhase(busy) !== 'quiet';
  return (
    <section
      data-ui="goal-conversation"
      className="grid min-w-0 gap-4 lg:grid-cols-12 lg:items-start"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-3 lg:col-span-12">
        <h1 className={WORKSPACE_TITLE}>{t.talk.workbench.title}</h1>
        {turns.length > 0 && (
          <Button variant="link" disabled={busy} onClick={startOver}>
            {t.talk.startOver}
          </Button>
        )}
      </header>
      <div
        ref={box}
        data-ui="goal-chat"
        className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-24 lg:col-span-5 lg:max-h-[calc(100dvh-8rem)]"
      >
        {turns.length === 0 && (
          <div className="flex flex-col gap-2">
            <p className="font-display text-[1.25rem]/7">{copy.invitation}</p>
            <p className="text-body-sm text-muted-foreground">{copy.lead}</p>
          </div>
        )}
        <p className="text-caption text-muted-foreground">{copy.local}</p>
        <ol
          data-ui="goal-transcript"
          aria-live="polite"
          className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto"
        >
          {turns.map((turn) => (
            <li
              key={turn.id}
              className={`min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] ${turn.who === 'person' ? 'border-l-2 border-primary pl-3' : ''}`}
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
      <div data-ui="goal-strategy" className="flex min-w-0 flex-col gap-4 lg:col-span-7">
        {mix && chain && userId && depositing ? (
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
            />
            {reply && !reply.proposal && reply.notes && <WeightNotes notes={reply.notes} />}
          </>
        ) : mix ? (
          <>
            <StrategyPreview
              proposal={mix}
              previewOnly={copy.draftNote}
              {...(busy ? { pending: t.shared.vault.conversation.reworking } : {})}
              {...(chain && userId
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
            className="flex min-w-0 flex-col items-start justify-center gap-3 rounded-md border border-border bg-card p-4 sm:min-h-60"
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
