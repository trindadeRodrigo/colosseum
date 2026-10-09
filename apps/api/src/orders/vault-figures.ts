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

/**
 * A measured value as the conversation shows it, in the reply's language: "$1,234.56", "0.42%". A value
 * that is not zero is never written as zero: where the unit's fixed places would print none of its
 * digits (dust after a rebalance, a small ratio), it is written to two significant digits instead.
 */
export function figureText(
  value: number,
  unit: string,
  language: 'en' | 'pt',
  lowerBound = false,
): string {
  const words = WORDS[language];
  const [style, places, suffix]: [Intl.NumberFormatOptions, Intl.NumberFormatOptions, string] =
    unit === 'USD'
      ? [
          { style: 'currency', currency: 'USD' },
          { minimumFractionDigits: 2, maximumFractionDigits: 2 },
          '',
        ]
      : unit === 'fraction'
        ? [{ style: 'percent' }, { maximumFractionDigits: Math.abs(value) < 0.001 ? 4 : 2 }, '']
        : unit === 'ratio'
          ? [{}, { maximumFractionDigits: 2 }, '']
          : unit === 'count'
            ? [{}, { maximumFractionDigits: 0 }, '']
            : unit === 'hours' || unit === 'seconds'
              ? [{}, { maximumFractionDigits: 1 }, ` ${words[unit]}`]
              : unit === 'units'
                ? [{}, { maximumFractionDigits: 6 }, '']
                : [{}, { maximumFractionDigits: 6 }, ` ${unit}`];
  const number = (digits: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(LOCALE[language], { ...style, ...digits })
      .format(value)
      // one plain space where a locale puts a no-break one: stored history is plain text
      .replace(/[  ]/gu, ' ');
  const fixed = number(places);
  const said = `${value !== 0 && !/[1-9]/u.test(fixed) ? number({ maximumSignificantDigits: 2 }) : fixed}${suffix}`;
  return lowerBound ? `${words.atLeast} ${said}` : said;
}

/**
 * Stands where a reference stood in the words the figure check reads. No person message, catalog name
 * or model prose holds it (`withoutMark`, `cleanProse`), so a quote of the person or a catalog name
 * cannot be made to match by a reference taken out of its middle.
 */
const MARK = '\u0001';
/** The model's words with a mark in place of every well-formed reference: what the figure check reads. */
export const withoutReferences = (text: string): string => text.replace(FIGURE_REFERENCE, MARK);
/** A person's words or a catalog name as the figure check compares them: never holding the mark. */
export const withoutMark = (text: string): string => text.replaceAll(MARK, '');
/**
 * Model prose without the characters that hide or reorder text: controls but tab and line feed, and
 * every format character (zero-width marks, bidi overrides). None of them is ever served.
 */
export const cleanProse = (text: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters taken out
  text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Cf}/gu, '');

// A reference must stand alone, as the figure it is (the review of #216). Three rules, the first two
// of position and the third of the sentence it stands in.
//
// 1. Never inside quotation marks: a quote attributes words to the person, and a figure is never theirs.
// 2. Bounded on both sides. Before it: the start, or a space after a word or plain punctuation, with at
//    most an opening bracket. After it: the end of the line, a full stop that ends the sentence, or a
//    space (after at most a closing bracket and a comma, semicolon or colon) and then a word or an
//    opening bracket or quote. So no sign, symbol, letter or digit touches it, and two references have a
//    word between them. Words are Latin letters: the replies are English and Portuguese.
// 3. Its sentence holds no word that makes another number or another claim of it: a magnitude, a
//    multiplier, a fraction or arithmetic; a number word or another unit beside it; a rate or a return,
//    unless every reference in the sentence is a yield; a period, unless each is a yield or a
//    volatility; a rise or a fall, unless each is a drawdown; a forecast, with any figure; and with a
//    yield no word that promises it. Missing a harmless sentence is the accepted cost.
const BEFORE = /(?:^\s*|[\p{Script=Latin}'’,;:.!?…)\]”"]\s+)[([]?$/u;
const AFTER =
  /^(?:[)\]]?[.!?…]+[)\]”"]*(?:\s|$)|[)\]]?[,;:]?(?:[^\S\n]*(?:\n|$)|\s+(?=[\p{Script=Latin}([“"])))/u;
// A word on its own: not part of a longer one, and not what follows an apostrophe ("I'm").
const lone = (words: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}'’])(?:${words})(?![\\p{L}\\p{N}])`, 'iu');
const MAGNITUDE = lone(
  'hundreds?|thousands?|millions?|billions?|trillions?|dozens?|grand|k|m|mm|b|bn|bi|mi|mil|milhares|milhar|milh(?:ão|ao|ões|oes)|bilh(?:ão|ao|ões|oes)|trilh(?:ão|ao|ões|oes)|centenas?|dezenas?|d[uú]zias?|percent|per\\s+cent|por\\s+cento|pct|pp|bps?|basis\\s+points?|percentage\\s+points?|pontos?[-\\s]base|pontos?\\s+percentuais|cents?|centavos?',
);
const ARITHMETIC = lone(
  'double[sd]?|doubling|triple[sd]?|tripling|quadruple[sd]?|quintuple[sd]?|twice|thrice|half|halve[sd]?|halving|thirds?|quarters?|fifths?|sixths?|sevenths?|eighths?|ninths?|tenths?|times|x|fold|multipl\\p{L}*|divid\\p{L}*|plus|minus|negative|sum|sums|average|combined|difference|point|power|squared|cubed|dobro|dobr\\p{L}+|triplo|triplic\\p{L}+|qu[aá]druplo|metade|ter[cç]os?|quartos?|quintos?|sextos?|d[eé]cimos?|vezes|soma|somad[oa]s?|m[eé]dia|diferen[cç]a|menos|negativ[oa]|elevado|ponto|v[ií]rgula',
);
const NUMBER_WORDS =
  'two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|vinte|trinta|quarenta|cinquenta|cem';
const UNIT_WORDS = 'dollars?|d[oó]lares|d[oó]lar|usd|bucks?|reais|real|brl|euros?';
const BESIDE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${NUMBER_WORDS})[^\\p{L}\\p{N}${MARK}]*${MARK}|${MARK}[^\\p{L}\\p{N}${MARK}]*(?:${NUMBER_WORDS}|${UNIT_WORDS})(?![\\p{L}\\p{N}])`,
  'iu',
);
const RETURN = lone(
  'returns?|returned|returning|yields?|yielded|yielding|apy|apr|earn\\p{L}*|gain\\p{L}*|profit\\p{L}*|interest|dividends?|pays?|paid|paying|payout|payouts|income|grow\\p{L}*|appreciat\\p{L}*|rates?|upside|retorn\\p{L}*|rend[ae]\\p{L}*|rendiment\\p{L}*|rentabilidade|juros|taxas?|cdi|selic|ipca|dividendos?|ganh\\p{L}*|lucr\\p{L}*|valoriz\\p{L}*|cresc\\p{L}*|pag[ao]\\p{L}*',
);
const PERIOD = lone(
  'a\\s+year|per\\s+year|each\\s+year|every\\s+year|yearly|annual\\p{L}*|per\\s+annum|p\\.a|a\\s+month|per\\s+month|each\\s+month|every\\s+month|monthly|a\\s+week|per\\s+week|weekly|a\\s+day|per\\s+day|daily|ao\\s+ano|por\\s+ano|anual\\p{L}*|a\\.a|ao\\s+m[eê]s|por\\s+m[eê]s|mensal\\p{L}*|por\\s+semana|semanal\\p{L}*|ao\\s+dia|por\\s+dia|di[aá]ri[oa]\\p{L}*',
);
const MOVE = lone(
  'up|down|rise[sn]?|rose|rising|fell|falls?|fallen|falling|drop\\p{L}*|los[te]|loses|losing|loss|losses|downside|drawdowns?|declin\\p{L}*|decreas\\p{L}*|increas\\p{L}*|jump\\p{L}*|sub(?:ir|iu|a|indo)|sobe|ca(?:ir|iu|ia|indo)|cai|perd\\p{L}*|quedas?|desvaloriz\\p{L}*|aument\\p{L}*|diminu\\p{L}*',
);
const FORECAST = new RegExp(
  `${lone("will|won'?t|shall|going\\s+to|gonna|expect\\p{L}*|forecast\\p{L}*|project(?:ed|s|ion|ions)|predict\\p{L}*|guarante\\p{L}*|promis\\p{L}*|vai|v[aã]o|ir[aá]|ir[aã]o|garant\\p{L}*|promet\\p{L}*|prev[eê]\\p{L}*|previs\\p{L}*|esper\\p{L}*").source}|['’]ll(?![\\p{L}\\p{N}])|\\p{L}{2,}(?:ará|erá|irá|arão|erão|irão)(?![\\p{L}\\p{N}])`,
  'iu',
);
const PROMISE = lone(
  'should|would|ought|must|always|sure|surely|certain\\p{L}*|definitely|safe|safely|secure\\p{L}*|deve|devem|dever[aá]|deveria|sempre|cert[oa]|certeza|certamente|segur[oa]\\p{L}*',
);

/** What makes a sentence with a reference in it one the server will not serve, in words for the model. */
const SAID = {
  quoted: 'a reference inside quotation marks',
  touching:
    'a reference that something touches, or two references with no word between them: put a space and a word around each',
  name: 'a reference beside a catalog name that holds digits',
  magnitude: 'a magnitude or percent word in a sentence with a reference',
  arithmetic:
    'a multiplier, a fraction, a sign or arithmetic in words in a sentence with a reference',
  beside: 'a number word or a currency word beside a reference',
  rate: 'a rate or a return word in a sentence whose reference is not a yield: figure',
  move: 'a rise or a fall in a sentence whose reference is not a drawdown: figure',
  forecast: 'a forecast or a promise in a sentence with a reference',
  asset: "a sentence that names one asset and references another asset's figure",
  malformed: 'a brace that is not part of one well-formed reference',
} as const;

export type FigureResolver = {
  /** The figure an id names in this request, measured or not, or undefined when it names none. */
  figure(id: string): VaultAgentFigure | undefined;
  /**
   * Why `text` holds an unbacked figure through its references, one entry each: an id that names no
   * figure, and what `SAID` lists. Empty when every reference stands alone as a figure of the request.
   */
  unbacked(text: string): string[];
};

/**
 * Resolves references against one request's evidence: an id whose source carries a value is that
 * figure, an id listed as missing says why, and anything else names nothing. With `enabled` false (a
 * new goal's conversation, which states no figure) every reference names nothing. `sentences` cuts a
 * text where the trimming does, `digitNames` are the catalog names that hold digits, and `named` the
 * single assets a text names, each by its id.
 */
export function figureResolver(input: {
  enabled: boolean;
  sources: ReadonlyMap<string, VaultAgentSource>;
  references: FigureReferences | undefined;
  lowerBound: ReadonlySet<string>;
  language: 'en' | 'pt';
  sentences?: (text: string) => string[];
  digitNames?: readonly string[];
  named?: (text: string) => string[];
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
  const idsIn = (text: string) =>
    [...text.matchAll(FIGURE_REFERENCE)].map((match) => match[1] ?? '');
  const nameTouches = (input.digitNames ?? [])
    .filter((name) => /\p{N}/u.test(name))
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .map((name) => new RegExp(`${MARK}[^\\p{L}]*${name}|${name}[^\\p{L}]*${MARK}`, 'u'));
  /** Rule 1: a reference between an opening quotation mark and its close, or the end of the text. */
  const quoted = (text: string) => {
    let open = false;
    for (let at = 0; at < text.length; at += 1) {
      const char = text[at];
      if (char === '“' || char === '«') open = true;
      else if (char === '”' || char === '»') open = false;
      else if (char === '"') open = !open;
      else if (open && text.startsWith('{{fact:', at)) return true;
    }
    return false;
  };
  /** Rule 2: every reference bounded on both sides. */
  const bounded = (text: string) =>
    [...text.matchAll(FIGURE_REFERENCE)].every(
      (match) =>
        BEFORE.test(text.slice(0, match.index)) &&
        AFTER.test(text.slice(match.index + match[0].length)),
    );
  /** Rule 3, for one sentence that holds a reference. */
  const worded = (sentence: string): Array<keyof typeof SAID> => {
    const ids = idsIn(sentence);
    const words = withoutReferences(sentence);
    const every = (...kinds: string[]) => ids.every((id) => kinds.some((k) => id.startsWith(k)));
    const found: Array<keyof typeof SAID> = [];
    if (MAGNITUDE.test(words)) found.push('magnitude');
    if (ARITHMETIC.test(words)) found.push('arithmetic');
    if (BESIDE.test(words)) found.push('beside');
    if (
      (RETURN.test(words) && !every('yield:')) ||
      (PERIOD.test(words) && !every('yield:', 'vol:'))
    )
      found.push('rate');
    if (MOVE.test(words) && !every('drawdown:')) found.push('move');
    if (FORECAST.test(words) || (ids.some((id) => id.startsWith('yield:')) && PROMISE.test(words)))
      found.push('forecast');
    // A sentence that names assets and references a figure of an asset it does not name.
    const names = new Set(input.named?.(words) ?? []);
    if (
      names.size > 0 &&
      ids.some((id) => {
        const of = figure(id)?.assetId;
        return of !== undefined && !names.has(of);
      })
    )
      found.push('asset');
    return found;
  };
  return {
    figure,
    unbacked(text) {
      // Compared as one form: full-width and other compatibility characters read as what they show.
      const read = text.normalize('NFKC');
      const ids = idsIn(read);
      const bad: string[] = ids.filter((id) => figure(id) === undefined);
      const found = new Set<keyof typeof SAID>();
      if (/[{}]/u.test(withoutReferences(read)) || ids.length !== idsIn(text).length)
        found.add('malformed');
      if (ids.length) {
        if (quoted(read)) found.add('quoted');
        if (!bounded(read)) found.add('touching');
        const marked = withoutReferences(read);
        if (nameTouches.some((touches) => touches.test(marked))) found.add('name');
        for (const sentence of (input.sentences ?? ((whole) => [whole]))(read))
          if (idsIn(sentence).length) for (const why of worded(sentence)) found.add(why);
      }
      return [...bad, ...[...found].map((why) => SAID[why])];
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
        // `display`: the token balance times the multiplier in force, so shares of the underlying
        label: 'Amount of this asset the vault holds, in units of the underlying',
        value,
        unit: 'units',
        ...read,
        method:
          'token balance read from the vault on its chain, times the token multiplier in force',
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
