'use client';
import type { CSSProperties } from 'react';
import { useId, useState } from 'react';
import { Mark } from '../../components/shell/Mark';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { EmbedShell } from '../../components/ui/EmbedShell';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { API } from '../../lib/api';
import { GOAL_TEXT, ReadGoalError, readGoal } from '../goal/read-goal';
import { dollars, fieldsOfDraft, goalSentence, type SheetFields } from '../goal/sheet';
import { apiUrl } from '../wallet/api-url';
import { useHostHeight } from './host-height';

// The partner embed's goal (embed-shell.md, guidelines.html section 08): in the partner's colours,
// face and radius, a box for the goal, how it was read as limits, and the way out to build the plan in
// tenonfi, in a new tab, where the person signs in with a wallet of their own. Nothing in the frame
// signs, holds a wallet or calls a route that needs a sign-in: the goal is read by the public reader
// (`POST /goals`), and the plan is built after sign-in, in the app (`/goal`, handed the text in the
// address's fragment, which never reaches a server).

/** A field of the partner's: their border, radius and ground, the focus ring in their accent. */
const FIELD =
  'w-full border border-input bg-background px-[0.75em] py-[0.5em] text-[length:var(--tf-e-body)] text-foreground rounded-[var(--radius)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
/** The partner's button: their accent, their button's radius, full width as the guide draws it. */
export const PARTNER_BUTTON =
  'inline-flex min-h-11 w-full items-center justify-center bg-primary px-[1em] text-primary-foreground font-semibold rounded-[var(--tf-embed-button-radius)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:border disabled:border-border disabled:bg-muted disabled:text-muted-foreground';

const call = (path: string, init?: RequestInit) =>
  fetch(apiUrl(API, path), { cache: 'no-store', ...init, redirect: 'error' });

export function EmbedGoal({ style }: { style: CSSProperties }) {
  const t = useT();
  const lang = useLang();
  const words = t.embed;
  const boxId = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [read, setRead] = useState<{ text: string; fields: SheetFields } | null>(null);
  useHostHeight();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const typed = text.trim();
    if (!typed || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const reading = await readGoal(call, typed, lang);
      setRead({ text: typed, fields: fieldsOfDraft(reading.draft, lang) });
    } catch (e) {
      setFailure(
        e instanceof ReadGoalError && e.kind === 'too_short' ? words.tooShort : words.readFailure,
      );
    } finally {
      setBusy(false);
    }
  }

  const sentence = read ? goalSentence(read.fields, t, lang) : null;
  const rows: [string, string][] = read
    ? [
        [
          t.goal.fields.goal,
          read.fields.goal ? t.goal.options.goal[read.fields.goal] : words.notFound,
        ],
        [
          t.goal.fields.amount,
          /^\d+(\.\d+)?$/.test(read.fields.amount)
            ? dollars(Number(read.fields.amount), lang)
            : read.fields.amount || words.notFound,
        ],
        [
          t.goal.fields.horizon,
          read.fields.horizon ? t.goal.card.months(Number(read.fields.horizon)) : words.notFound,
        ],
        [
          t.goal.fields.risk,
          read.fields.risk ? t.goal.options.risk[read.fields.risk] : words.notFound,
        ],
      ]
    : [];

  return (
    <div style={style} data-ui="embed-frame">
      <EmbedShell
        label={words.label}
        lang={LOCALE[lang]}
        title={read ? (sentence ?? words.unread) : words.title}
        lead={read ? undefined : words.lead}
        credit={{ name: 'tenonfi', href: '/', symbol: <Mark size={16} /> }}
        labels={{
          loading: words.loading,
          unavailable: words.unavailable,
          showSchedule: words.showSchedule,
          poweredBy: words.poweredBy,
        }}
      >
        <form onSubmit={submit} className="flex flex-col gap-[0.5em]">
          <label htmlFor={boxId} className="text-[length:var(--tf-e-small)] text-muted-foreground">
            {words.box}
          </label>
          <textarea
            id={boxId}
            rows={2}
            value={text}
            maxLength={GOAL_TEXT.max}
            placeholder={words.placeholder}
            onChange={(e) => setText(e.target.value)}
            aria-describedby={failure ? `${boxId}-failure` : undefined}
            className={`${FIELD} resize-y placeholder:text-muted-foreground`}
          />
          <button type="submit" disabled={busy || text.trim() === ''} className={PARTNER_BUTTON}>
            {busy ? words.reading : words.read}
          </button>
          <p id={`${boxId}-failure`} role="alert" className="text-[length:var(--tf-e-small)]">
            {failure ?? ''}
          </p>
        </form>
        {read && (
          <section aria-label={words.limits} className="flex flex-col">
            <p className="text-[length:var(--tf-e-small)] text-muted-foreground">{words.eyebrow}</p>
            <dl>
              {rows.map(([key, value]) => (
                <div
                  key={key}
                  className="flex justify-between gap-[0.75em] border-t border-border py-[0.6em]"
                >
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="text-right">{value}</dd>
                </div>
              ))}
            </dl>
            <a
              href={`/goal#goal=${encodeURIComponent(read.text)}`}
              target="_blank"
              rel="noopener"
              className={`${PARTNER_BUTTON} mt-[0.75em] no-underline`}
            >
              {words.build}
            </a>
            <p className="mt-[0.5em] text-[length:var(--tf-e-small)] text-muted-foreground">
              {words.buildNote}
            </p>
          </section>
        )}
        <Disclaimer lang={lang} label={t.shell.disclaimer} />
      </EmbedShell>
    </div>
  );
}
