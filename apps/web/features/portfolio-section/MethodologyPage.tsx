'use client';
import { TRACK_RULE, TrackLine, type TrackWord } from '@colosseum/schemas';
import { useId } from 'react';
import { Status } from '../../components/ui/StatusMark';
import { PageHead } from './parts';
import { statusKind } from './status';
import { useWords } from './words';

// How the section reads a person's plans (/portfolio/methodology): what a snapshot is and how often
// one is taken, what each status means with the rule's name and its lines in the order they are
// tried, where each figure on these pages comes from, and what the pages cannot say yet. Plain text:
// there is no figure on this page, so no pin. That none of it is advice is the disclaimer's to say,
// from the one constant, under the page (PortfolioShell.tsx).

const WORDS: readonly TrackWord[] = ['on_track', 'watch', 'off_track'];

/**
 * What each line of the rule gives, as the ON-TRACK-V1 row of docs/GATES.md states it, for the words
 * of this page alone. A plan's status on a card is always the server's: nothing reads this table to
 * decide one. `verdict` hands the status over, and so names none.
 */
const GIVES: Record<TrackLine, TrackWord | null | 'verdict'> = {
  verdict: 'verdict',
  never_read: null,
  empty: null,
  chain_silent: 'off_track',
  loss_half: 'off_track',
  unpriced: 'watch',
  no_band: null,
  outside_band: 'watch',
  cash_over: 'watch',
  loss_quarter: 'watch',
  stale: 'watch',
  inside: 'on_track',
  inside_no_budget: 'on_track',
};

const H2 = 'text-h3 font-semibold';
const TEXT = 'flex max-w-(--tf-measure-body) flex-col gap-3 text-body';
const LIST = 'flex list-disc flex-col gap-2 pl-5';

export function MethodologyPage() {
  const w = useWords();
  const m = w.methodology;
  const id = useId();
  /** A status word with its shape, or the words that stand where the rule gives none. */
  const given = (gives: TrackWord | null | 'verdict') =>
    gives === 'verdict' ? (
      <span className="text-caption font-medium">{m.status.asVerdict}</span>
    ) : gives === null ? (
      <span className="text-caption font-medium">{w.status.none}</span>
    ) : (
      <Status status={statusKind(gives)}>{w.status.words[gives]}</Status>
    );
  return (
    <article data-ui="portfolio-methodology" className="flex flex-col gap-10">
      <PageHead title={m.title} lead={m.lead} />

      <section aria-labelledby={`${id}-snapshot`} className={TEXT}>
        <h2 id={`${id}-snapshot`} className={H2}>
          {m.snapshot.heading}
        </h2>
        {m.snapshot.body.map((text) => (
          <p key={text}>{text}</p>
        ))}
      </section>

      <section aria-labelledby={`${id}-status`} className={TEXT}>
        <h2 id={`${id}-status`} className={H2}>
          {m.status.heading}
        </h2>
        <p data-ui="rule-name">{m.status.intro(TRACK_RULE)}</p>
        <p>{m.status.notForecast}</p>
        <dl data-ui="status-legend" className="flex flex-col gap-3">
          {WORDS.map((word) => (
            <div key={word} data-word={word} className="flex flex-col gap-1">
              <dt>{given(word)}</dt>
              <dd className="text-body-sm">{m.status.means[word]}</dd>
            </div>
          ))}
          <div data-word="none" className="flex flex-col gap-1">
            <dt>{given(null)}</dt>
            <dd className="text-body-sm">{m.status.means.none}</dd>
          </div>
        </dl>
        <p>{m.status.goal}</p>
        <ul className={LIST}>
          {m.status.terms.map(([term, text]) => (
            <li key={term}>
              <b className="font-semibold">{term}</b>: {text}
            </li>
          ))}
        </ul>
        <h3 id={`${id}-lines`} className="mt-3 text-h4 font-semibold">
          {m.status.order}
        </h3>
        <p>{m.status.first}</p>
        <ol
          data-ui="rule-lines"
          aria-labelledby={`${id}-lines`}
          className="flex list-decimal flex-col gap-3 pl-6"
        >
          {TrackLine.options.map((line) => (
            <li key={line} data-line={line}>
              <span className="flex flex-col gap-1">
                {given(GIVES[line])}
                <span className="text-body-sm">{m.status.lines[line]}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby={`${id}-sources`} className={TEXT}>
        <h2 id={`${id}-sources`} className={H2}>
          {m.sources.heading}
        </h2>
        <ul className={LIST}>
          {m.sources.items.map(([term, text]) => (
            <li key={term}>
              <b className="font-semibold">{term}</b>: {text}
            </li>
          ))}
        </ul>
        <p>{m.sources.pin}</p>
      </section>

      <section aria-labelledby={`${id}-cannot`} className={TEXT}>
        <h2 id={`${id}-cannot`} className={H2}>
          {m.cannot.heading}
        </h2>
        <ul className={LIST}>
          {m.cannot.items.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      </section>

      <p data-ui="methodology-boundary" className="max-w-(--tf-measure-body) text-body">
        {m.boundary}
      </p>
    </article>
  );
}
