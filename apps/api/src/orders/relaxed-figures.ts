import { type BasketAsset, FIGURE_REFERENCE, type VaultAgentRequest } from '@colosseum/schemas';
import { assetsNamedIn, type GoalAgentContext, LOWER_BOUND } from './vault-agent';
import { type FigureReferences, type FigureResolver, NULL_REASONS } from './vault-figures';

// The measured figures the relaxed intake may state by reference (RELAXED-INTAKE as amended
// 2026-10-09; the rules are FIGURES-BY-REFERENCE's, in vault-figures.ts, unchanged). This file only
// chooses which of the request's evidence the model is handed, and writes the served message.
//
// What is handed over: the figures of the holdings the conversation names, not the whole catalog's.
// A catalog of a dozen assets has about a dozen figures each, and the block varies with the
// conversation, so it cannot sit in the cached prefix; a question is about one to four holdings, and
// loading those keeps the uncached part of the prompt a few hundred tokens. A holding is named by its
// symbol, what it tracks or its company in any turn, by its id in a draft the web kept and resent, or
// by a class word ("the stocks") in the person's latest message. The others are listed by symbol only,
// so the model can say their figures come once they are named. Each id goes with what it measures and
// never with its value: the model has nothing to copy, compare or rank.

/** The kinds of evidence that are measured figures of a listed asset. Nothing of a vault or a person. */
const MEASURED =
  /^(?:price|yield|exit|lpexit|weekend|lp|capvar|volume|vol|drawdown|capacity|liquidity):/u;

export type GoalFigures = {
  /** The measured sources the model was handed, by id: what a reference may resolve to. */
  sources: Map<string, GoalAgentContext['evidence'][number]>;
  /** Of those handed over, what is not measured and why, and the stated age of a stale one. */
  references: FigureReferences;
  /** The ids whose value is a lower bound: the reply says "at least". */
  lowerBound: Set<string>;
  /** The block for the uncached part of the system prompt. */
  block: string;
};

export function goalFigures(
  context: GoalAgentContext,
  assets: BasketAsset[],
  companies: Map<string, string[]>,
  messages: VaultAgentRequest['messages'],
): GoalFigures {
  const named = assetsNamedIn(assets, companies);
  const latest = messages.at(-1);
  const loaded = new Set<string>();
  for (const message of messages) {
    // one asset by its own name anywhere; a class word only in the newest question
    for (const ids of named(message.text))
      if (ids.length === 1 || message === latest) for (const id of ids) loaded.add(id);
    if (message.who === 'app')
      for (const asset of assets)
        if (
          new RegExp(
            `(?<![a-z0-9:-])${asset.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`,
            'u',
          ).test(message.text)
        )
          loaded.add(asset.id);
  }
  const sources: GoalFigures['sources'] = new Map();
  const references: FigureReferences = { missing: {}, staleAgeSec: {} };
  const lowerBound = new Set(
    (context.analytics?.assets ?? []).flatMap((row) => row.lowerBound ?? []),
  );
  const lines = new Map<string, string[]>();
  const add = (assetId: string | undefined, line: string) => {
    if (assetId) lines.set(assetId, [...(lines.get(assetId) ?? []), line]);
  };
  for (const source of context.evidence) {
    if (!source.assetId || !loaded.has(source.assetId) || !MEASURED.test(source.id)) continue;
    if (typeof source.value !== 'number' || source.unit === undefined) continue;
    sources.set(source.id, source);
    // a size-free capacity says so in its label only (`buildGoalAgentContext`)
    if (source.label?.includes(LOWER_BOUND)) lowerBound.add(source.id);
    add(source.assetId, `${source.id} — ${source.label ?? 'measured figure'}`);
    const age = context.references?.staleAgeSec[source.id];
    if (age !== undefined) references.staleAgeSec[source.id] = age;
  }
  for (const [id, missing] of Object.entries(context.references?.missing ?? {})) {
    if (!missing.assetId || !loaded.has(missing.assetId) || !MEASURED.test(id)) continue;
    references.missing[id] = missing;
    add(
      missing.assetId,
      `${id} — ${missing.label}: not measured (${NULL_REASONS[missing.reason]})`,
    );
  }
  const shown = assets.filter((asset) => lines.has(asset.id));
  const others = assets.filter((asset) => !lines.has(asset.id) && asset.cls !== 'cash');
  const block = [
    'MEASURED FIGURES for this message (rule 3). Each line is an id and what it measures; the value is not shown to you, the code writes it where you write {{fact:<id>}}.',
    ...shown.flatMap((asset) => [
      `${asset.symbol} (${asset.id}):`,
      ...(lines.get(asset.id) ?? []).map((line) => `  ${line}`),
    ]),
    ...(shown.length
      ? []
      : ['None is loaded: the conversation has named no holding with figures.']),
    ...(others.length
      ? [
          `Not loaded, so no reference to them this turn: ${others.map((asset) => asset.symbol).join(', ')}. Their figures are loaded once the conversation names them; say so if asked.`,
        ]
      : []),
  ].join('\n');
  return { sources, references, lowerBound, block };
}

/** `template` as plain text, each reference its figure's text, with the figures it named. */
export function filled(template: string, references: FigureResolver) {
  const facts = new Map<string, NonNullable<ReturnType<FigureResolver['figure']>>>();
  const counts = { resolved: 0, missing: 0 };
  const plain = template.replace(FIGURE_REFERENCE, (_token, id: string) => {
    const fact = references.figure(id);
    if (!fact) return '';
    facts.set(id, fact);
    counts[fact.value === null ? 'missing' : 'resolved'] += 1;
    return fact.text;
  });
  return { plain, facts: [...facts.values()], counts };
}

/** At most this many figures in one message (`VaultAgentFigures.facts`). */
const MAX_FACTS = 64;

/**
 * `template` cut so that its plain reading fits `max` characters: whole references only, never part of
 * one, and no more distinct figures than a reply carries. What is cut ends in "…".
 */
export function fitted(template: string, max: number, references: FigureResolver): string {
  if (filled(template, references).plain.length <= max) {
    if (new Set([...template.matchAll(FIGURE_REFERENCE)].map((m) => m[1])).size <= MAX_FACTS)
      return template;
  }
  let out = '';
  let length = 0;
  let from = 0;
  const seen = new Set<string>();
  const room = max - 1;
  for (const match of template.matchAll(FIGURE_REFERENCE)) {
    const words = template.slice(from, match.index);
    if (length + words.length > room) return `${(out + words.slice(0, room - length)).trimEnd()}…`;
    const text = references.figure(match[1] ?? '')?.text ?? '';
    seen.add(match[1] ?? '');
    if (length + words.length + text.length > room || seen.size > MAX_FACTS)
      return `${(out + words).trimEnd()}…`;
    out += words + match[0];
    length += words.length + text.length;
    from = match.index + match[0].length;
  }
  const rest = template.slice(from);
  return length + rest.length > max
    ? `${(out + rest.slice(0, room - length)).trimEnd()}…`
    : out + rest;
}
