'use client';
import type { ChainId, Network, Provenance } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Composer } from '../../components/ui/Composer';
import { WORKSPACE_TITLE } from '../../components/ui/heading';
import { LatticeGlyph, LatticeStatus } from '../../components/ui/Lattice';
import { LatticeLoader } from '../../components/ui/Skeleton';
import { useWaitPhase } from '../../components/ui/wait';
import { dictionary, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import type { AccountView } from '../account/AccountProvider';
import { signInHref } from '../account/account-control-parts';
import { DepositStep, type Purpose } from '../mix/DepositStep';
import { share } from '../portfolio/figures';
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

/** Plain browser history is never restored as a proposal, confirmation or executable order. */
export function GoalConversation({
  userId,
  chain,
  ready,
  provenance,
  account = userId ? 'signed-in' : 'signed-out',
  conversationId = 'main',
  onSaved,
}: {
  /**
   * What the bar's account control shows (AccountProvider, `view`), so this page says the same:
   * while it is not known who is here the page waits, and asks nobody to sign in.
   */
  account?: AccountView;
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
    setReply(null);
    setMix(held.current.length ? restored : null);
    setKept(Boolean(held.current.length && restored));
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
  }, [api, key, context, userId, ready, previewKey, chain]);

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
    setMix(null);
    setKept(false);
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
        setKept(false);
        setDepositing(false);
        keepPreview(result.proposal);
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
        {/* The page agrees with the bar: it waits while the bar's control waits, and asks for a
            sign-in only once the bar offers one, through the same link. */}
        {!ready &&
          (account === 'loading' ? (
            <LatticeStatus label={copy.loadingAccount} className="self-start" />
          ) : (
            <p data-ui="goal-account" className="text-body-sm text-muted-foreground">
              {account === 'signed-in' ? copy.readingAccount : copy.signIn}
            </p>
          ))}
        {account === 'signed-out' && (
          <Link
            href={signInHref('/goal')}
            data-ui="goal-sign-in"
            className="text-body-sm underline"
          >
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
            />
            {reply && !reply.proposal && reply.notes && <WeightNotes notes={reply.notes} />}
          </>
        ) : mix ? (
          <>
            <StrategyPreview
              proposal={mix}
              previewOnly={copy.draftNote}
              {...(busy ? { pending: t.shared.vault.conversation.reworking } : {})}
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
