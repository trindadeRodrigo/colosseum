'use client';
import { FIGURE_REFERENCE } from '@colosseum/schemas';
import { Fragment, type ReactNode } from 'react';
import { formatAge, sayAge } from '../../components/ui/format';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { useT } from '../../i18n/I18nProvider';
import { displayName } from '../order/plain';
import type { Figure } from './agent';

/** A measurement this old or older says its age beside the figure, in a fresh reply or a kept one. */
export const FIGURE_AGE_SHOWN_SEC = 3600;

/**
 * A text of the conversation with each figure it states drawn as a figure (gate FIGURES-BY-REFERENCE):
 * the value our server measured, with the provenance pin every other figure has, the sample or
 * test-network mark where it is not live, and its age once it is an hour old, so a reply read again
 * later shows what was measured then and never passes for today's. A figure that is not measured is
 * its reason in words; a placeholder that names no fact is a dash. Nothing here is the model's number,
 * and no brace is ever shown. `now` is the reader's clock in milliseconds, or null before it is read.
 */
export function FiguredText({
  template,
  facts,
  now,
}: {
  template: string;
  facts: readonly Figure[];
  now: number | null;
}) {
  const t = useT();
  const copy = t.shared.vault.conversation;
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const parts: ReactNode[] = [];
  let from = 0;
  let key = 0;
  for (const match of template.matchAll(FIGURE_REFERENCE)) {
    if (match.index > from) parts.push(template.slice(from, match.index));
    from = match.index + match[0].length;
    key += 1;
    const fact = byId.get(match[1] ?? '');
    if (!fact) {
      parts.push('—');
      continue;
    }
    if (fact.value === null) {
      parts.push(
        <span key={key} data-ui="figure-missing" className="text-muted-foreground">
          {fact.text}
        </span>,
      );
      continue;
    }
    const seconds = now === null ? null : Math.max(0, (now - Date.parse(fact.fetchedAt)) / 1000);
    const age = seconds === null ? null : formatAge(seconds);
    const aged = age ? sayAge(age, t.pin.age) : null;
    const what = [fact.assetId ? displayName(fact.assetId, t.plan) : null, fact.label]
      .filter(Boolean)
      .join(' · ');
    parts.push(
      <Fragment key={key}>
        <ProvenancePin
          value={fact.text}
          labelValue={(aged ? copy.figureSaidAged : copy.figureSaid)
            .replace('{value}', () => fact.text)
            .replace('{age}', () => aged ?? '')}
          obs={{
            source: fact.source,
            fetchedAt: fact.fetchedAt,
            method: fact.method,
            provenance: fact.provenance,
            staleAgeSec: fact.staleAgeSec,
          }}
          {...(what ? { detail: what } : {})}
          labels={t.pin}
        />
        {aged && seconds !== null && seconds >= FIGURE_AGE_SHOWN_SEC && (
          <span data-ui="figure-age" className="text-caption text-muted-foreground">
            {' '}
            ({aged})
          </span>
        )}
      </Fragment>,
    );
  }
  if (from < template.length) parts.push(template.slice(from));
  return <>{parts}</>;
}
