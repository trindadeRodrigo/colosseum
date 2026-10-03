import type { Provenance } from '@colosseum/schemas';
import { formatAge, isoUtc } from './format';

// What the provenance pin is handed, and what state that puts a figure in (provenance-pin.md). This is
// a plain module, apart from ProvenancePin.tsx, so that a server component can ask the state of a
// figure: a function exported from a client module cannot be called on the server.

/**
 * What a figure must be handed to be shown: where it came from, when, and how it was worked out.
 * The same shape as `Sourced` in @colosseum/schemas, plus how stale the API says it is.
 */
export type PinSource = {
  source: string;
  /** An ISO 8601 instant. */
  fetchedAt: string;
  method: string;
  provenance: Provenance;
  /**
   * How old the API says the figure is, in seconds, when it counts it as stale. Null or absent means
   * not stale. The pin never works this out from `fetchedAt`: staleness is stated, not inferred.
   */
  staleAgeSec?: number | null;
};

export type PinState = 'live' | 'stale' | 'mock' | 'missing';

/**
 * The state of a figure. Only the exact word `live` is live: every other provenance, known or not, is
 * MOCK. A figure with no source, no time or no method is missing.
 */
export function pinState(obs: PinSource | null | undefined): PinState {
  if (!obs?.source || !obs.method || !obs.fetchedAt || isoUtc(obs.fetchedAt) === null)
    return 'missing';
  if (obs.provenance !== 'live') return 'mock';
  return obs.staleAgeSec != null ? 'stale' : 'live';
}

export type PinLabels = {
  /** The accessible name. `{value}` is the figure. */
  sourceFor: string;
  /** Appended when stale. `{age}` is "3 hours old". */
  staleSuffix: string;
  mockSuffix: string;
  stale: string;
  /** In place of a figure that has no source. */
  missing: string;
  /** The name of the popover when it holds a link. */
  provenance: string;
  copy: string;
  copied: string;
  /** How each provenance other than `live` is named in the popover. */
  kinds: Record<Exclude<Provenance, 'live'>, string>;
  /** For a provenance this build does not know. It is never shown as live. */
  unknownKind: string;
};

export const PIN_LABELS: PinLabels = {
  sourceFor: 'Source for {value}',
  staleSuffix: ', stale, {age}',
  mockSuffix: ', mock data',
  stale: 'stale',
  missing: 'no source yet',
  provenance: 'Provenance',
  copy: 'Copy source',
  copied: 'Copied',
  kinds: {
    mock: 'mock data',
    sandbox: 'test network',
    fixture: 'fixture',
    prior_dataset: 'prior dataset',
  },
  unknownKind: 'not live',
};

/** "Source for 6.40%", with ", stale, 3 hours old" or ", mock data" appended. */
export function pinLabel(value: string, obs: PinSource, labels: PinLabels = PIN_LABELS): string {
  const name = labels.sourceFor.replace('{value}', value);
  const state = pinState(obs);
  if (state === 'mock') return name + labels.mockSuffix;
  if (state === 'stale')
    return name + labels.staleSuffix.replace('{age}', formatAge(obs.staleAgeSec ?? 0).long);
  return name;
}

/** The first line of the popover: `source · fetched_at · method`, the time in UTC. */
export function sourceLine(obs: PinSource): string {
  return `${obs.source} · ${isoUtc(obs.fetchedAt)} · ${obs.method}`;
}
