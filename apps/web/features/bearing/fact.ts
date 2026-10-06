import type { Provenance } from '@colosseum/schemas';
import type { PinSource } from '../../components/ui/provenance';
import { iso, regimeW, usd } from './format';

// A figure as the risk API serves it: a value with where it came from, when, and how; or no value and
// the reason. Figures the page works out (a sum, a share) are facts too: their method names the facts
// and the formula, their time is the newest of their parts, and a sum with a part missing is a lower
// bound. Nothing here makes a figure up: a value with no source is shown as its reason.

export type Quality = 'measured' | 'lower_bound' | 'assumption' | string;

export type Fact = {
  value: number | null;
  quality?: Quality;
  source?: string;
  fetchedAt?: string | null;
  method?: string;
  methodVersion?: string;
  provenance?: string;
  reason?: string;
  detail?: string;
  samples?: number;
  dataFrom?: string | null;
  regime?: string;
  sizeUsd?: number;
};

export type FactMeta = Omit<Fact, 'value'>;

export const none = (reason: string, detail?: string): Fact => ({ value: null, reason, detail });

/** A value with its meta as a fact; a missing or non-finite value is the reason instead. */
export function mk(value: number | null | undefined, o: FactMeta): Fact {
  if (value == null || !Number.isFinite(value)) return none(o.reason ?? 'not_served', o.detail);
  return {
    value,
    quality: o.quality ?? 'measured',
    source: o.source,
    fetchedAt: o.fetchedAt,
    method: o.method,
    methodVersion: o.methodVersion,
    samples: o.samples,
    dataFrom: o.dataFrom,
    regime: o.regime,
    sizeUsd: o.sizeUsd,
    provenance: o.provenance ?? 'live',
  };
}

export const has = (f: Fact | null | undefined): f is Fact & { value: number } =>
  f != null && f.value != null;

/** The later of two ISO times; either may be missing. */
export function maxT<T extends string | null | undefined>(a: T, b: T): T {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** The provenance of a figure made of parts: live only when every part is. */
export function provenanceOf(parts: readonly Fact[]): string {
  return parts.find((f) => (f.provenance ?? 'live') !== 'live')?.provenance ?? 'live';
}

/** A sum of facts as one fact: a lower bound when any part is one or has no figure. */
export function sumFact(
  facts: readonly Fact[],
  o: { source?: string; method?: string; methodVersion?: string; regime?: string; reason?: string },
): Fact {
  if (!facts.length) return none('nothing_selected');
  const have = facts.filter(has);
  if (!have.length) return none(o.reason ?? facts[0]?.reason ?? 'not_collected');
  const value = have.reduce((s, f) => s + f.value, 0);
  let t: string | null | undefined = null;
  let from: string | null | undefined = null;
  for (const f of have) {
    t = maxT(t, f.fetchedAt);
    if (f.dataFrom && (!from || f.dataFrom < from)) from = f.dataFrom;
  }
  const lower = have.some((f) => f.quality === 'lower_bound') || have.length < facts.length;
  return mk(value, {
    quality: lower ? 'lower_bound' : 'measured',
    source: o.source ?? have[0]?.source,
    fetchedAt: t,
    dataFrom: from,
    regime: o.regime,
    method: `${o.method ?? 'sum'} · ${have.length} of ${facts.length} with a figure${
      have.length < facts.length ? ' (the rest have none, so this is a lower bound)' : ''
    }`,
    methodVersion: o.methodVersion ?? have[0]?.methodVersion,
    provenance: provenanceOf(have),
  });
}

/**
 * Whether the view is stale, and the clock it reads ages against. The risk API states no staleness of
 * its own, so the view states it (DESIGN-VAULT, "Bearing analytics"): when the collectors' newest
 * reading is older than STALE_AFTER_MS every figure is stale, each with its own age, as Rodrigo's
 * snapshot shows them. A figure whose own reading is older than that is stale too, whatever the
 * rest of the page is: stale is never shown as live (STYLE.md rule 2).
 */
export type Clock = { now: number; stale: boolean };
export const STALE_AFTER_MS = 2 * 3600e3;

/** What the provenance pin is handed for a fact: the API's own words, with the method's version. */
export function pinSource(f: Fact, clock: Clock): PinSource {
  const fetchedAt = f.fetchedAt ? new Date(f.fetchedAt).toISOString() : '';
  const age = fetchedAt ? Math.max(0, (clock.now - Date.parse(fetchedAt)) / 1000) : null;
  return {
    source: cleanSource(f.source ?? ''),
    fetchedAt,
    method: [f.method, f.methodVersion].filter(Boolean).join(' · '),
    provenance: (f.provenance ?? 'live') as Provenance,
    staleAgeSec: age != null && (clock.stale || age * 1000 > STALE_AFTER_MS) ? age : null,
  };
}

/** The second line of the popover: the quality, the regime, the size, the samples, the data's start. */
export function factDetail(f: Fact): string {
  return [
    f.quality === 'lower_bound' ? 'lower bound' : f.quality,
    f.regime ? regimeW(f.regime) : null,
    f.sizeUsd ? `at ${usd(f.sizeUsd)}` : null,
    f.samples != null ? `n=${f.samples}` : null,
    f.dataFrom ? `data from ${iso(f.dataFrom)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A source names no one's machine: local paths are dropped. */
export const cleanSource = (s: string) => s.replace(/~\/[^,]*,\s*/g, '');
