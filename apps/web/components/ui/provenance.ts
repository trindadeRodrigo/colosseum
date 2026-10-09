import type { Provenance } from '@colosseum/schemas';
import { type Age, type AgeWords, formatAge, isoUtc, sayAge } from './format';
import {
  AGO_WORDS,
  type AgoWords,
  agoWords,
  exactTime,
  limitWords,
  sourceWords,
} from './source-words';

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
  /**
   * How old the figure itself is, in seconds, where the API states it (a price's `ageSeconds`).
   * `fetchedAt` is when the figure was read, which is not when it last changed: a price read ten
   * seconds ago can be a day old. With an age the popover says "Updated"; without one it says only
   * when it was read, and claims nothing about the figure's age.
   */
  ageSec?: number | null;
  /**
   * The oldest the source's own rule accepts, in seconds, where the API states one (a price's
   * `maxAgeSeconds`). The popover names it beside a stale reading. Never worked out here.
   */
  staleLimitSec?: number | null;
  /**
   * The page of an address on the explorer of the network the figure was read on, with `{address}`
   * where the address goes. From the app's own chain table, never the API's word. Left out, an
   * address in the details gets no link.
   */
  explorer?: string | null;
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
  /** The name of the popover. */
  provenance: string;
  /** Copies the API's own line: `source · fetched_at · method`. */
  copy: string;
  copied: string;
  /** How each provenance other than `live` is named in the popover. */
  kinds: Record<Exclude<Provenance, 'live'>, string>;
  /** For a provenance this build does not know. It is never shown as live. */
  unknownKind: string;
  /** The popover's first words. `{what}` is the kind of number, `{source}` the source in plain words. */
  whatFrom: string;
  from: string;
  /** In place of a name, for a source the table of names does not know: the details hold it. */
  unnamed: string;
  /** The figure's own age, where the API states it. `{ago}` is "2 minutes ago". */
  updated: string;
  /** When it was read, where that is all that is known. */
  read: string;
  /** Before the browser's clock is read: `{time}` is the exact time of the read. */
  readAt: string;
  /** In sight when the clipboard refused: the whole line is under it. */
  copyFailed: string;
  /** A stale reading, said first. `{ago}` from the age the API states, `{limit}` "2 minute". */
  staleOverLimit: string;
  staleNoLimit: string;
  staleNoAge: string;
  live: string;
  ago: AgoWords;
  /** The button that opens the API's own words. */
  details: string;
  sourceLabel: string;
  timeLabel: string;
  methodLabel: string;
  /** `{address}` is the shortened address. */
  copyAddress: string;
  explorer: string;
};

export const PIN_LABELS: PinLabels = {
  sourceFor: 'Source for {value}',
  staleSuffix: ', stale, {age}',
  mockSuffix: ', sample figure',
  stale: 'stale',
  ageUnknown: 'age unknown',
  missing: 'no source yet',
  provenance: 'Source details',
  copy: 'Copy all',
  copied: 'Copied',
  kinds: {
    mock: 'Sample figure, not live',
    sandbox: 'Test network, not live',
    fixture: 'Sample figure, not live',
    prior_dataset: 'From an earlier dataset, not live',
  },
  unknownKind: 'Not live',
  whatFrom: '{what} from {source}',
  from: 'From {source}',
  unnamed: 'Source details below',
  updated: 'Updated {ago}',
  read: 'Read {ago}',
  readAt: 'Read {time}',
  copyFailed: 'Couldn’t copy here. The whole line is below to select.',
  staleOverLimit: 'Last updated {ago}, older than this feed’s {limit} limit',
  staleNoLimit: 'Last updated {ago}, which is stale',
  staleNoAge: 'Stale, and its age is not known',
  live: 'Live',
  ago: AGO_WORDS,
  details: 'Details',
  sourceLabel: 'Source',
  timeLabel: 'Read at',
  methodLabel: 'How it is worked out',
  copyAddress: 'Copy address {address}',
  explorer: 'View {address} on the explorer',
};

const ageSaid = (age: Age | null, labels: PinLabels) =>
  age === null ? labels.ageUnknown : labels.age ? sayAge(age, labels.age) : age.long;

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

/** `fresh` is the figure's own age; `read` is when it was read, where that is all that is known. */
export type PinLine = { key: 'what' | 'fresh' | 'read' | 'stale' | 'state'; text: string };

/**
 * What the popover says before the details, in order: what the number is and where it comes from,
 * how fresh it is, whether it is live. A stale reading says so first. What the number is, is the
 * screen's word (`what`): a source does not say it. The source's name comes from the table in
 * source-words.ts; one it does not know is not guessed at ("Source details below").
 * Staleness is the API's word and the age it states; only a fresh reading's age is read off the
 * clock (`now`, the browser's, in milliseconds), and before that clock is known the exact time stands.
 */
export function pinWords(
  obs: PinSource,
  labels: PinLabels = PIN_LABELS,
  { what, now }: { what?: string; now?: number | null } = {},
): { lines: PinLine[]; named: boolean } {
  const state = pinState(obs);
  const named = sourceWords(obs.source, obs.provenance);
  const lead: PinLine = {
    key: 'what',
    text:
      named.from === null
        ? labels.unnamed
        : what
          ? labels.whatFrom.replace('{what}', what).replace('{source}', named.from)
          : labels.from.replace('{source}', named.from),
  };
  const status: PinLine = {
    key: 'state',
    text: state === 'mock' ? kindWords(obs.provenance, labels) : labels.live,
  };
  // A sample or test-network reading can be old too: its glyph stays hatched (it is never drawn as
  // live, stale or not), and the popover still says how old it is before anything else.
  if (obs.staleAgeSec != null) {
    const ago = agoWords(obs.staleAgeSec as number, labels.ago);
    const limit = obs.staleLimitSec == null ? null : limitWords(obs.staleLimitSec, labels.ago);
    const text =
      ago === null || (obs.staleAgeSec as number) < 0
        ? labels.staleNoAge
        : limit
          ? labels.staleOverLimit.replace('{ago}', ago).replace('{limit}', limit)
          : labels.staleNoLimit.replace('{ago}', ago);
    // "Live" under a stale reading would say two things at once: the stale line stands for it.
    const rest = state === 'mock' ? [lead, status] : [lead];
    return { lines: [{ key: 'stale', text }, ...rest], named: named.from !== null };
  }
  // The figure's own age where the API states one. Otherwise only when it was read, said as a read:
  // the time of a read says nothing of how old what was read is.
  const own =
    typeof obs.ageSec === 'number' && obs.ageSec >= 0 ? agoWords(obs.ageSec, labels.ago) : null;
  const iso = isoUtc(obs.fetchedAt) ?? obs.fetchedAt;
  const read = now == null ? null : agoWords((now - Date.parse(iso)) / 1000, labels.ago);
  const fresh: PinLine = {
    key: own ? 'fresh' : 'read',
    text: own
      ? labels.updated.replace('{ago}', own)
      : read
        ? labels.read.replace('{ago}', read)
        : labels.readAt.replace('{time}', exactTime(iso)),
  };
  return { lines: [lead, fresh, status], named: named.from !== null };
}
