import { view } from '@colosseum/basket';
import {
  type BasketAsset,
  type FactNullReason,
  FIGURE_REFERENCE,
  isStalePrice,
  type Price,
  type Provenance,
  type VaultAgentFigure,
  type VaultAgentSource,
  type VaultState,
} from '@colosseum/schemas';

// Figures by reference (gate FIGURES-BY-REFERENCE). The vault's conversation may state a measured figure
// only by naming it: the model writes `{{fact:<id>}}` where the number would stand, with an evidence id
// the server gave it in this request, and the server writes the value, its unit and its pin. The model
// types no number: its own words, with the references taken out, pass the same figure check as before.
// A reference that names nothing the server measured is an unbacked figure and costs its sentence.

/** Why a figure is not measured, in the words the conversation uses. */
export const NULL_REASONS: Record<FactNullReason, string> = {
  no_samples_in_regime: 'no samples in that regime yet',
  insufficient_samples: 'too few samples',
  not_a_number: 'the computed figure was not a number',
  beyond_measured_size: 'the size is beyond the measured depth',
  no_reference_price: 'no reference prices collected',
  no_external_source: 'no external price source',
  chain_not_covered: 'this chain is not measured',
  not_collected: 'not collected yet',
  not_imported: 'not imported yet',
  not_followed: 'not traced',
  gate_open: 'waiting on a decision',
  not_applicable: 'does not apply',
  no_oracle: 'no price oracle for this asset',
};
const NULL_REASONS_PT: Record<FactNullReason, string> = {
  no_samples_in_regime: 'ainda sem amostras nesse regime',
  insufficient_samples: 'amostras insuficientes',
  not_a_number: 'o valor calculado não era um número',
  beyond_measured_size: 'o tamanho passa da profundidade medida',
  no_reference_price: 'sem preços de referência coletados',
  no_external_source: 'sem fonte externa de preço',
  chain_not_covered: 'esta rede não é medida',
  not_collected: 'ainda não coletado',
  not_imported: 'ainda não importado',
  not_followed: 'não rastreado',
  gate_open: 'aguardando uma decisão',
  not_applicable: 'não se aplica',
  no_oracle: 'sem oráculo de preço para este ativo',
};

/**
 * What a reference may resolve to besides a measured source: the ids whose figure is not measured,
 * each with why, and the age the chain states for a figure past its age limit (a price the vault no
 * longer trades on).
 */
export type FigureReferences = {
  missing: Record<string, { assetId?: string; label: string; reason: FactNullReason }>;
  staleAgeSec: Record<string, number>;
};

const LOCALE = { en: 'en-US', pt: 'pt-BR' } as const;
const WORDS = {
  en: { atLeast: 'at least', missing: 'not measured', hours: 'hours', seconds: 'seconds' },
  pt: { atLeast: 'pelo menos', missing: 'não medido', hours: 'horas', seconds: 'segundos' },
} as const;

/** A measured value as the conversation shows it, in the reply's language: "$1,234.56", "0.42%". */
export function figureText(
  value: number,
  unit: string,
  language: 'en' | 'pt',
  lowerBound = false,
): string {
  const number = (options: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(LOCALE[language], options)
      .format(value)
      // one plain space where a locale puts a no-break one: stored history is plain text
      .replace(/[  ]/gu, ' ');
  const words = WORDS[language];
  const said =
    unit === 'USD'
      ? number({
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      : unit === 'fraction'
        ? number({ style: 'percent', maximumFractionDigits: Math.abs(value) < 0.001 ? 4 : 2 })
        : unit === 'ratio'
          ? number({ maximumFractionDigits: 2 })
          : unit === 'count'
            ? number({ maximumFractionDigits: 0 })
            : unit === 'hours' || unit === 'seconds'
              ? `${number({ maximumFractionDigits: 1 })} ${words[unit]}`
              : unit === 'tokens'
                ? number({ maximumFractionDigits: 6 })
                : `${number({ maximumFractionDigits: 6 })} ${unit}`;
  return lowerBound ? `${words.atLeast} ${said}` : said;
}

/** The model's words with every well-formed reference taken out: what the figure check reads. */
export const withoutReferences = (text: string): string => text.replace(FIGURE_REFERENCE, ' ');

// A reference must stand as the figure it is. Two with no word between them would read as one number
// the server never measured ("10" and "3" as "103", or "10.3"); a magnitude or another unit after one
// rescales it ("$2,000.00 million", an amount in tokens "dollars"); a multiplier before one derives a
// number from it ("double $2,000.00"). Each is an unbacked figure. This is a short list of the plain
// cases, not a reader of arithmetic in words: the instruction forbids that, and nothing here proves it.
// A stop with a space after it ends a sentence or a clause: the next reference starts another.
const JOINED = /\}\}(?:[^\p{L}\n.!?…;:]|[.!?…;:](?!\s))*\{\{fact:/u;
const RESCALED =
  /\}\}[\s-]*(?:k|m|mm|bn|thousand|million|billion|trillion|mil|milh(?:ão|ao|ões|oes)|bilh(?:ão|ao|ões|oes)|percent|per\s+cent|por\s+cento|pct|bps|basis\s+points?|pontos[-\s]base|dollars?|d[oó]lares|usd|reais|brl)(?![\p{L}\p{N}])/iu;
const MULTIPLIED =
  /(?<![\p{L}\p{N}])(?:half|double|twice|triple|thrice|third|quarter|times|metade|dobro|triplo|ter[cç]o|vezes)(?:\s+(?:of|the|de|do|da|o|a))*\s*\{\{fact:/iu;

export type FigureResolver = {
  /** The figure an id names in this request, measured or not, or undefined when it names none. */
  figure(id: string): VaultAgentFigure | undefined;
  /**
   * The references in `text` that name no figure, one entry for braces outside any reference, and one
   * for a reference joined to another, rescaled or multiplied in words.
   */
  unbacked(text: string): string[];
};

/**
 * Resolves references against one request's evidence: an id whose source carries a value is that
 * figure, an id listed as missing says why, and anything else names nothing. With `enabled` false (a
 * new goal's conversation, which states no figure) every reference names nothing.
 */
export function figureResolver(input: {
  enabled: boolean;
  sources: ReadonlyMap<string, VaultAgentSource>;
  references: FigureReferences | undefined;
  lowerBound: ReadonlySet<string>;
  language: 'en' | 'pt';
}): FigureResolver {
  const { sources, references, lowerBound, language } = input;
  const figure = (id: string): VaultAgentFigure | undefined => {
    if (!input.enabled) return undefined;
    const source = sources.get(id);
    if (
      source &&
      typeof source.value === 'number' &&
      Number.isFinite(source.value) &&
      source.unit !== undefined
    ) {
      const atLeast = lowerBound.has(id);
      return {
        id,
        ...(source.assetId === undefined ? {} : { assetId: source.assetId }),
        ...(source.label === undefined ? {} : { label: source.label }),
        text: figureText(source.value, source.unit, language, atLeast),
        value: source.value,
        unit: source.unit,
        source: source.source,
        method: source.method,
        fetchedAt: source.fetchedAt,
        provenance: source.provenance,
        staleAgeSec:
          references && Object.hasOwn(references.staleAgeSec, id)
            ? (references.staleAgeSec[id] ?? null)
            : null,
        ...(atLeast ? { lowerBound: true as const } : {}),
      };
    }
    const missing = references && Object.hasOwn(references.missing, id) && references.missing[id];
    if (!missing) return undefined;
    const why = (language === 'pt' ? NULL_REASONS_PT : NULL_REASONS)[missing.reason];
    return {
      id,
      ...(missing.assetId === undefined ? {} : { assetId: missing.assetId }),
      label: missing.label,
      text: `${WORDS[language].missing} (${why})`,
      value: null,
      reason: missing.reason,
    };
  };
  return {
    figure,
    unbacked(text) {
      const bad = [...text.matchAll(FIGURE_REFERENCE)]
        .map((match) => match[1] ?? '')
        .filter((id) => figure(id) === undefined);
      if (/[{}]/u.test(withoutReferences(text))) bad.push('malformed');
      if (JOINED.test(text) || RESCALED.test(text) || MULTIPLIED.test(text)) bad.push('derived');
      return bad;
    },
  };
}

const worst = (a: Provenance, b: Provenance): Provenance =>
  a === b || b === 'live' ? a : a === 'live' ? b : 'mock';

/**
 * The vault's own state as figures a reference may name: what it holds, what each holding and the whole
 * are worth at the reference prices, each holding's share and its target. Each is a source with the
 * read it came from; a value that needs a price the chain did not give is missing, never zero. They are
 * this person's, so none belongs in the prompt's shared part.
 */
export function vaultFacts(input: {
  state: VaultState;
  prices: readonly Price[];
  assets: readonly BasketAsset[];
  chainSource: string;
  chainProvenance: Provenance;
}): { sources: VaultAgentSource[]; references: FigureReferences } {
  const { state, prices, assets, chainSource, chainProvenance } = input;
  const sources: VaultAgentSource[] = [];
  const references: FigureReferences = { missing: {}, staleAgeSec: {} };
  const listed = new Set(assets.map((asset) => asset.id));
  let seen: ReturnType<typeof view>;
  try {
    seen = view(state, [...prices], [...assets]);
  } catch {
    // A read the view cannot value gives no vault figures; it never fails the reply.
    return { sources, references };
  }
  const priceOf = new Map(prices.map((price) => [price.asset, price]));
  const read = {
    source: chainSource,
    fetchedAt: state.observedAt,
    provenance: chainProvenance,
  };
  const older = (a: string, b: string) => (Date.parse(b) < Date.parse(a) ? b : a);
  const held = seen.positions.filter((position) => listed.has(position.asset));
  const unpriced = seen.positions.some(
    (position) => position.valueUsd === null && !/^0+$/.test(position.raw),
  );
  const used = seen.positions.flatMap((position) => {
    const price = position.valueUsd === null ? undefined : priceOf.get(position.asset);
    return price ? [price] : [];
  });
  const whole = {
    source: used.length ? [...new Set(used.map((price) => price.source))].join(' + ') : chainSource,
    fetchedAt: used.reduce((oldest, price) => older(oldest, price.fetchedAt), state.observedAt),
    provenance: used.reduce((label, price) => worst(label, price.provenance), chainProvenance),
  };
  const stale = used.filter(isStalePrice).map((price) => price.ageSeconds);
  const total = Number(seen.valueUsd);
  const valueLabel = 'Value of everything the vault holds, at reference prices';
  if (unpriced || !Number.isFinite(total))
    references.missing['vault:value'] = { label: valueLabel, reason: 'no_reference_price' };
  else {
    sources.push({
      id: 'vault:value',
      label: valueLabel,
      value: total,
      unit: 'USD',
      ...whole,
      method: 'holdings read from the vault, times their reference prices; cash at one dollar',
    });
    if (stale.length) references.staleAgeSec['vault:value'] = Math.max(...stale);
  }
  const share = (id: string, assetId: string, weightBps: number) => {
    const label = "This holding's share of the vault's value";
    if (unpriced) references.missing[id] = { assetId, label, reason: 'no_reference_price' };
    else if (!(total > 0)) references.missing[id] = { assetId, label, reason: 'not_applicable' };
    else {
      sources.push({
        id,
        assetId,
        label,
        value: weightBps / 10_000,
        unit: 'fraction',
        ...whole,
        method: "this holding's value over the vault's value, at reference prices",
      });
      if (stale.length) references.staleAgeSec[id] = Math.max(...stale);
    }
  };
  const amount = (assetId: string, display: string) => {
    const value = Number(display);
    if (Number.isFinite(value))
      sources.push({
        id: `holding:${assetId}:amount`,
        assetId,
        label: 'Amount of this asset the vault holds, in tokens',
        value,
        unit: 'tokens',
        ...read,
        method: 'balance read from the vault on its chain',
      });
  };
  if (listed.has(state.cash.asset)) {
    const id = state.cash.asset;
    const dollars = Number(state.cash.display);
    amount(id, state.cash.display);
    if (Number.isFinite(dollars)) {
      sources.push({
        id: `holding:${id}:value`,
        assetId: id,
        label: 'Value of this holding',
        value: dollars,
        unit: 'USD',
        ...read,
        method: 'cash balance read from the vault, at one dollar',
      });
      const others = seen.positions.reduce((sum, position) => sum + position.weightBps, 0);
      share(`holding:${id}:share`, id, total > 0 ? 10_000 - others : 0);
    }
  }
  for (const position of held) {
    const id = position.asset;
    const price = priceOf.get(id);
    amount(id, position.display);
    const label = 'Value of this holding at its reference price';
    if (position.valueUsd === null || !price)
      references.missing[`holding:${id}:value`] = {
        assetId: id,
        label,
        reason: 'no_reference_price',
      };
    else {
      sources.push({
        id: `holding:${id}:value`,
        assetId: id,
        label,
        value: Number(position.valueUsd),
        unit: 'USD',
        source: price.source,
        fetchedAt: older(state.observedAt, price.fetchedAt),
        provenance: worst(chainProvenance, price.provenance),
        method: `amount read from the vault, times its reference price (${price.method})`,
      });
      if (isStalePrice(price)) references.staleAgeSec[`holding:${id}:value`] = price.ageSeconds;
    }
    share(`holding:${id}:share`, id, position.weightBps);
    sources.push({
      id: `holding:${id}:target`,
      assetId: id,
      label: 'Target share of this asset in the vault',
      value: position.targetBps / 10_000,
      unit: 'fraction',
      ...read,
      method: 'target read from the vault on its chain',
    });
  }
  return { sources, references };
}
