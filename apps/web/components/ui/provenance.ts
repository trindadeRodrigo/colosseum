import type { Provenance } from '@colosseum/schemas';
import { type Age, type AgeWords, formatAge, isoUtc } from './format';

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

const blank = (value: unknown) => typeof value !== 'string' || value.trim() === '';

/**
 * The state of a figure. Only the exact word `live` is live: every other provenance, known or not, is
 * MOCK. A figure is missing when its source or its method is empty or only spaces, or when its time
 * is not an instant (a date-time with a zone).
 */
export function pinState(obs: PinSource | null | undefined): PinState {
  if (!obs || blank(obs.source) || blank(obs.method) || blank(obs.fetchedAt)) return 'missing';
  if (isoUtc(obs.fetchedAt) === null) return 'missing';
  if (obs.provenance !== 'live') return 'mock';
  return obs.staleAgeSec != null ? 'stale' : 'live';
}

/** A mouse that rests on the pin this long opens it (provenance-pin.md: 300ms). */
export const PIN_OPEN_MS = 300;
/** How long the pointer has to cross from the pin to its popover before the popover closes. */
export const PIN_CLOSE_MS = 200;

export type PinLabels = {
  /** The accessible name. `{value}` is the figure. */
  sourceFor: string;
  /** Appended when stale. `{age}` is "3 hours old". */
  staleSuffix: string;
  mockSuffix: string;
  stale: string;
  /** In place of the age, when the API says a figure is stale and the age it gives is not one. */
  ageUnknown: string;
  /** The age said in full in the accessible name. Left out: English, "3 hours old". */
  age?: AgeWords;
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
  ageUnknown: 'age unknown',
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

const ageSaid = (age: Age | null, labels: PinLabels) =>
  age === null ? labels.ageUnknown : labels.age ? labels.age(age.count, age.unit) : age.long;

/** "Source for 6.40%", with ", stale, 3 hours old" or ", mock data" appended. */
export function pinLabel(value: string, obs: PinSource, labels: PinLabels = PIN_LABELS): string {
  const name = labels.sourceFor.replace('{value}', value);
  const state = pinState(obs);
  if (state === 'mock') return name + labels.mockSuffix;
  if (state === 'stale')
    return (
      name +
      labels.staleSuffix.replace('{age}', ageSaid(formatAge(obs.staleAgeSec as number), labels))
    );
  return name;
}

/** Beside a hollow pin: "stale · 3 h", or "stale · age unknown" when the age handed over is not one. */
export function staleWords(obs: PinSource, labels: PinLabels = PIN_LABELS): string {
  return `${labels.stale} · ${formatAge(obs.staleAgeSec as number)?.short ?? labels.ageUnknown}`;
}

/**
 * How a provenance other than `live` is named in the popover: "test network", "fixture". One this
 * build does not know, or one that is the name of something every object has, is "not live".
 */
export function kindWords(provenance: unknown, labels: PinLabels = PIN_LABELS): string {
  const known =
    typeof provenance === 'string' && Object.hasOwn(labels.kinds, provenance)
      ? (labels.kinds as Record<string, unknown>)[provenance]
      : undefined;
  return typeof known === 'string' && known.trim() !== '' ? known : labels.unknownKind;
}

/** The first line of the popover: `source · fetched_at · method`, the time in UTC. */
export function sourceLine(obs: PinSource): string {
  return `${obs.source} · ${isoUtc(obs.fetchedAt)} · ${obs.method}`;
}
