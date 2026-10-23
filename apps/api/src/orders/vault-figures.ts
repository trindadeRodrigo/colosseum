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
  /** A figure over a window shown with some of its hours not collected: how many, of how many. */
  windowGaps?: Record<string, WindowGap>;
};
export type WindowGap = { missingHours: number; windowHours: number };

const LOCALE = { en: 'en-US', pt: 'pt-BR' } as const;
const WORDS = {
  en: {
    atLeast: 'at least',
    missing: 'not measured',
    hoursMissing: '{missing} of {total} hours missing',
    hours: 'hours',
    seconds: 'seconds',
    tokens: 'tokens',
  },
  pt: {
    atLeast: 'pelo menos',
    missing: 'não medido',
    hoursMissing: 'faltam {missing} de {total} horas',
    hours: 'horas',
    seconds: 'segundos',
    tokens: 'tokens',
  },
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
                : // a token supply (the asset lookups): whole tokens to two places
                  unit === 'tokens'
                  ? [{}, { maximumFractionDigits: 2 }, ` ${words.tokens}`]
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
 * A figure as plain prose says it: its `text`, and, for a window shown with hours not collected, how many
 * ("3.2% (11 of 720 hours missing)"). A client that draws the figure shows the same note from its fields.
 */
export function plainFigureText(figure: VaultAgentFigure, language: 'en' | 'pt'): string {
  if (figure.value === null || !figure.missingHours || !figure.windowHours) return figure.text;
  const count = (n: number) => new Intl.NumberFormat(LOCALE[language]).format(n);
  const note = WORDS[language].hoursMissing
    .replace('{missing}', count(figure.missingHours))
    .replace('{total}', count(figure.windowHours));
  return `${figure.text} (${note})`;
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
 * every format character (zero-width marks, bidi overrides). None of them is ever served. Nor are the
 * emphasis marks around a reference.
 */
export const cleanProse = (text: string): string =>
  text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters taken out
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\ufe0e|\ufe0f|\p{Cf}/gu, '')
    // The marks a model sets a figure in bold or italics with: the screen shows plain text, and the
    // figure has its own drawing.
    .replace(EMPHASISED, '$2');
const EMPHASISED = /(\*\*|__|\*|_|`)(\{\{fact:[^{}\s]{1,160}\}\})\1/gu;

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
//    volatility; a rise or a fall, unless each is a drawdown (a drawdown and a volatility of one asset
//    may share a sentence); a forecast, or a claim no figure here measures (a gain made, a chance, a
//    tax, a fee, over- or undervalued), with any figure. Missing a harmless sentence is the accepted
//    cost.
//
// After the second review of #216 and the review of #227:
//
// 4. A sentence says what its figure is. It names the kind of each figure it holds (worth or value, of
//    the vault, target, price, cost or sell, drawdown, volatility and so on: `KINDS`), or at least an
//    asset; one that does neither is not served. One that names the kind of every figure stands on its
//    own. One that only names an asset ("Nvidia: about X too.") takes its meaning from the sentence
//    before it, or for a field's first sentence from the end of the field shown above it, and is read
//    with those words: a rate, a period, a rise or a fall, a magnitude, arithmetic, a forecast, a claim.
//    The product's goal words there (grow, income) are not such words.
// 5. A yield is served by a grammar, not by what it avoids (`yieldClauses`): a clause that says a
//    measured yield is the figure, and then ends the sentence. Its word of measurement governs the
//    figure ("its quoted yield is Y a year", "the reserve currently yields Y a year", "its yield is Y a
//    year, based on the latest quote"), and nothing follows the figure but a period, a word for now and
//    where it was read. Anything else with a yield is cut, and so is a yield with a promise word in its
//    sentence or in the one before or after it.
// 6. Neither a referenced sentence nor the one it is read with holds a letter that is not Latin or a
//    code point that is not shown (a look-alike or a hidden letter inside a listed word reads as that
//    word to a person).
// (a second reference may open a bracket after the first: "X (Y of the vault)")
const BEFORE = /(?:^\s*|[\p{Script=Latin}'’,;:.!?…)\]”"]\s+)[([]?$|\}\}\s+[([]$/u;
const AFTER =
  /^(?:[)\]]?[.!?…]+[)\]”"]*(?:\s|$)|[)\]]?[,;:]?(?:[^\S\n]*(?:\n|$)|\s+(?:[—–]\s+)?(?=[\p{Script=Latin}([“"])))/u;
// A word on its own: not part of a longer one, and not what follows an apostrophe ("I'm").
const lone = (words: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}'’])(?:${words})(?![\\p{L}\\p{N}])`, 'iu');
const MAGNITUDE = lone(
  'hundreds?|thousands?|millions?|billions?|trillions?|dozens?|grand|k|m|mm|b|bn|bi|mi|mio|tsd|lakhs?|crores?|mil|millones|mill[oó]n|milhares|milhar|milh(?:ão|ao|ões|oes)|bilh(?:ão|ao|ões|oes)|trilh(?:ão|ao|ões|oes)|centenas?|dezenas?|d[uú]zias?|percent|per\\s+cent|por\\s+cento|pct|pp|bps?|basis\\s+points?|percentage\\s+points?|pontos?[-\\s]base|pontos?\\s+percentuais|cents?|centavos?',
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
  'returns?|returned|returning|yields?|yielded|yielding|rind\\p{L}*|rapport\\p{L}*|apy|apr|earn\\p{L}*|gain\\p{L}*|profit\\p{L}*|interest|dividends?|pays?|paid|paying|payout|payouts|income|grow\\p{L}*|appreciat\\p{L}*|rates?|upside|retorn\\p{L}*|rend[ae]\\p{L}*|rendiment\\p{L}*|rentabilidade|juros|taxas?|cdi|selic|ipca|dividendos?|ganh\\p{L}*|lucr\\p{L}*|valoriz\\p{L}*|cresc\\p{L}*|pag[ao]\\p{L}*',
);
const PERIOD = lone(
  'a\\s+year|per\\s+year|each\\s+year|every\\s+year|yearly|annual\\p{L}*|per\\s+annum|al\\s+a[nñ]o|por\\s+a[nñ]o|al\\s+mes|par\\s+an|par\\s+mois|p\\.a|a\\s+month|per\\s+month|each\\s+month|every\\s+month|monthly|a\\s+week|per\\s+week|weekly|a\\s+day|per\\s+day|daily|ao\\s+ano|por\\s+ano|anual\\p{L}*|a\\.a|ao\\s+m[eê]s|por\\s+m[eê]s|mensal\\p{L}*|por\\s+semana|semanal\\p{L}*|ao\\s+dia|por\\s+dia|di[aá]ri[oa]\\p{L}*',
);
const MOVE = lone(
  'up|down|climb\\p{L}*|sank|sink\\p{L}*|sunk|soar\\p{L}*|surg\\p{L}*|plung\\p{L}*|tumbl\\p{L}*|slid|slide[sd]?|sliding|slump\\p{L}*|rall(?:y|ies|ied|ying)|tick(?:s|ed|ing)|edg(?:es|ed|ing)|rise[sn]?|rose|rising|fell|falls?|fallen|falling|drop\\p{L}*|los[te]|loses|losing|loss|losses|downside|drawdowns?|declin\\p{L}*|decreas\\p{L}*|increas\\p{L}*|jump\\p{L}*|sub(?:ir|iu|a|indo)|sobe|ca(?:ir|iu|ia|indo)|cai|perd\\p{L}*|quedas?|desvaloriz\\p{L}*|aument\\p{L}*|diminu\\p{L}*',
);
const FORECAST = new RegExp(
  `${lone("will|won['’]?t|shall|going\\s+to|gonna|expect\\p{L}*|forecast\\p{L}*|project(?:ed|s|ion|ions)|predict\\p{L}*|guarante\\p{L}*|promis\\p{L}*|vai|v[aã]o|ir[aá]|ir[aã]o|garant\\p{L}*|promet\\p{L}*|prev[eê]\\p{L}*|previs\\p{L}*|esper\\p{L}*").source}|['’]ll(?![\\p{L}\\p{N}])|\\p{L}{2,}(?:ará|erá|irá|arão|erão|irão)(?![\\p{L}\\p{N}])`,
  'iu',
);
// What a word rule must not read as its word: the class name "dollar-yield reserve", "makes up", and
// "up to date". Each is replaced by a word no list holds.
const HARMLESS: Array<[RegExp, string]> = [
  [/dollar[-‑\s]yield(?=\s+(?:reserves?|assets?|tokens?)(?![\p{L}\p{N}]))/giu, 'dollar'],
  [/(?<![\p{L}\p{N}])(ma(?:ke|kes|de|king))\s+up(?![\p{L}\p{N}])/giu, 'forms'],
  [/(?<![\p{L}\p{N}])up\s+to\s+date(?![\p{L}\p{N}])/giu, 'fresh'],
];
const plainly = (text: string) =>
  HARMLESS.reduce((words, [pattern, word]) => words.replace(pattern, word), text);
/** The product's own goal words: in the sentence before a figure they say what the plan is for. */
const GOAL_WORDS = /(?<![\p{L}\p{N}])(?:grow\p{L}*|income|cresc\p{L}*|renda)(?![\p{L}\p{N}])/giu;
/** A claim none of the figures measures: a gain made, a chance, a tax, a fee, a valuation, a past level. */
const CLAIM = lone(
  `ma(?:ke|kes|de|king)\\s+(?:you|me|us|money)|stand\\s+to\\s+make|ma(?:ke|kes|de|king)\\s+(?:about\\s+|around\\s+|roughly\\s+)?${MARK}|chances?|odds|probabilit\\p{L}*|likel\\p{L}*|tax|taxes|taxed|fees?|owe[sd]?|owing|overvalued|undervalued|overpriced|underpriced|safe|safely|risk[-\\s]free|beat|beats|beating|beaten|outperform\\p{L}*|worth\\s+(?:more|less)|(?:cheaper|pricier|higher|lower|better|worse)\\s+than|than\\s+(?:before|last)|in\\s+the\\s+(?:red|black)|what\\s+you\\s+(?:put\\s+in|paid|invested)|probabilidades?|impostos?|tarifas?|sobrevalorizad\\p{L}*|subvalorizad\\p{L}*|no\\s+vermelho|no\\s+azul|vale\\s+(?:mais|menos)|super[ao]\\p{L}*`,
);
/** With a yield, none of these in its sentence or in the one before or after it. */
const PROMISE = lone(
  "should|would|ought|must|always|sure|surely|certain\\p{L}*|definitely|safe|safely|secure\\p{L}*|protected|count(?:s|ing)?\\s+on|bank(?:s|ing)?\\s+on|rely\\p{L}*|relies|relied|depend\\p{L}*|at\\s+least|never\\s+less|not\\s+(?:pay\\s+)?less|next\\s+(?:year|month|week)|from\\s+(?:now|here)(?:\\s+on)?|going\\s+forward|here\\s+to\\s+stay|forever|for\\s+life|for\\s+good|keeps?|kept|lock\\p{L}*|steady|steadily|fixed|reliab\\p{L}*|no\\s+matter|without\\s+fail|rain|clockwork|every\\s+(?:time|year|month|week|day)|each\\s+and\\s+every|as\\s+long\\s+as|risk|downside|collect\\p{L}*|take\\s+home|pocket|set\\s+for|nothing\\s+can|can\\s*not|can['’]?t|does\\s+not\\s+change|doesn['’]?t\\s+change|deve|devem|dever[aá]|deveria|sempre|cert[oa]|certeza|certamente|segur[oa]\\p{L}*|cont[ae]r?\\s+com|pelo\\s+menos|nunca\\s+menos|(?:ano|m[eê]s)\\s+que\\s+vem|pr[oó]xim[oa]\\s+(?:ano|m[eê]s)|todo\\s+(?:ano|m[eê]s|dia)|todos\\s+os\\s+(?:anos|meses)|n[aã]o\\s+muda|daqui\\s+(?:para|pra)\\s+frente|risco|livre\\s+de|trav\\p{L}*|est[aá]vel|est[aá]veis|fix[oa]s?|confi[aá]ve\\p{L}*",
);

/** A sentence that says the figure is no promise names the word without making one. */
const DISCLAIMED =
  /(?<![\p{L}\p{N}])(?:not|no|never|n[aã]o|nem|sem)\s+(?:(?:a|an|any|the|uma?|nenhuma?)\s+)?(?:promis\p{L}*|promess\p{L}*|forecast\p{L}*|previs\p{L}*|prediction\p{L}*)/giu;
/** Beside a yield, a sentence that says it lasts. */
const LASTING = lone(
  'perpetu\\p{L}*|indefinitely|never|nothing\\s+changes|year\\s+after\\s+year|without\\s+exception|continu\\p{L}*|stays?|remain\\p{L}*|nunca|nada\\s+muda|ano\\s+ap[oó]s\\s+ano|sem\\s+exce[cç][aã]o|indefinidamente|permane\\p{L}*',
);
/** The same, in words that say it of whatever stands beside them, whoever the subject is. */
const LASTING_OF_IT = lone(
  'perpetu\\p{L}*|indefinitely|nothing\\s+changes|year\\s+after\\s+year|without\\s+exception|nada\\s+muda|ano\\s+ap[oó]s\\s+ano|sem\\s+exce[cç][aã]o|indefinidamente',
);
/** A sentence that speaks of the yield: it, that, this, the yield or the rate is its subject. */
const OF_THE_YIELD =
  /^\s*(?:[-*•–—]\s+)?(?:(?:and|but|so|e|mas)\s+)?(?:it|that|this|the\s+(?:yield|rate)|isso|isto|ele|ela|o\s+rendimento|a\s+taxa)(?![\p{L}\p{N}])/iu;
/** Or it tells the person what they will get. */
const YOU_WILL_GET =
  /(?<![\p{L}\p{N}])(?:you\s+will|you['’]ll|voc[eê]\s+vai|voc[eê]\s+ir[aá])\s+(?:\p{L}+\s+)?(?:earn|get|keep|receive|be\s+paid|receber|ganhar|manter)(?![\p{L}\p{N}])/iu;
/** A sentence that says the figure may not hold: a caveat, never a promise. */
const HEDGED = lone(
  'may\\s+not|might\\s+not|(?:can|could|may|might|will)\\s+(?:change|vary|move)|not\\s+(?:a\\s+|an\\s+|any\\s+)?(?:guarante\\p{L}*|promis\\p{L}*|forecast\\p{L}*)|never\\s+stands?\\s+still|pode\\s+(?:mudar|variar)|n[aã]o\\s+[eé]\\s+(?:uma?\\s+)?(?:promessa|garantia|previs[aã]o)|n[aã]o\\s+[eé]\\s+garantid[oa]',
);
/**
 * The agent saying what it cannot tell, promise or count on. Its own clause is the caveat: from the
 * opener to the first comma, colon, "but", "than" or "how". What comes after that is read like any
 * other words ("I can't tell you how safe it is: always, forever." promises).
 */
const OWN_CAVEAT =
  /^\s*(?:I|Eu)\s+(?:can['’]?t|cannot|can\s+not|would\s+not|wouldn['’]?t|n[aã]o\s+(?:posso|consigo|contaria))\s+(?:tell|promise|say|know|predict|count\s+on|rely\s+on|guarantee|prometer|dizer|garantir|saber|contar)(?![\p{L}\p{N}])(?:(?!\s+(?:but|than|how|mas|como)(?![\p{L}\p{N}]))[^,;:—–])*/iu;
/** A question that offers the person something; only its own words are spared, not what it offers. */
const OFFER =
  /^\s*(?:would\s+you\s+(?:like|prefer)|do\s+you\s+want|want\s+me\s+to|quer|gostaria)(?![\p{L}\p{N}])[^?]*\?\s*$/iu;
const OFFER_WORDS = /(?<![\p{L}\p{N}'’])(?:would|should|keep|can['’]?t)(?![\p{L}\p{N}])/giu;
/**
 * Whether a sentence beside a yield promises it. It is read only when it speaks of the yield; a
 * sentence about something else ("Nvidia remains your largest stock"), one that offers to go on ("I
 * will show you the rest") and one that hedges ("It will change over time") are served. Where this
 * cannot tell, it serves.
 */
function promisesTheYield(neighbour: string): boolean {
  if (HEDGED.test(neighbour)) return false;
  if (LASTING_OF_IT.test(neighbour)) return true;
  if (!OF_THE_YIELD.test(neighbour) && !YOU_WILL_GET.test(neighbour)) return false;
  const said = neighbour.replace(DISCLAIMED, ' ');
  return FORECAST.test(said) || LASTING.test(said);
}

// The yield grammar. `Y` stands where a yield reference stood. A clause starts the sentence or follows
// another clause, and ends the sentence.
const Y = '\u0002';
/**
 * The clauses for a yield of an asset with these names. Only the reserve, by that word or by one of
 * `names`, may be what yields: any other subject or owner is a stranger to the figure.
 */
const yieldClauses = (names: readonly string[]): RegExp[] => {
  const named = [
    'the\\s+reserve',
    'a\\s+reserva',
    ...names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  ].join('|');
  const approx = '(?:(?:about|around|roughly|cerca\\s+de|aproximadamente)\\s+)?';
  // the figure is a yearly one
  const per = '(?:\\s+(?:a|per)\\s+year|\\s+annually|\\s+(?:ao|por)\\s+ano)?';
  const now =
    '(?:right\\s+now|now|today|currently|at\\s+the\\s+moment|so\\s+far|hoje|agora|no\\s+momento|atualmente|at[eé]\\s+agora)';
  const framed = '(?:quoted|measured|observed|current|past|latest|historical)';
  const framedPt = '(?:cotad[oa]|medid[oa]|observad[oa]|atual|passad[oa]|hist[oó]ric[oa])';
  const noun = '(?:dollar\\s+)?(?:yield|rate)';
  const nounPt = '(?:rendimento|taxa)';
  const owner = `(?:(?:its|the)\\s+|(?:${named})(?:’s|'s)\\s+)?`;
  const ofOwner = `(?:\\s+(?:of|on|for|from)\\s+(?:${named}))?`;
  const ofOwnerPt = `(?:\\s+d[ao]\\s+(?:reserva|${names.length ? named : 'reserva'}))?`;
  const is = '(?:is|was|stands\\s+at|stood\\s+at)';
  const isPt = '(?:é|era|foi|está\\s+em|é\\s+de|foi\\s+de)';
  const source =
    '(?:,?\\s+(?:measured|quoted|observed|based|taken)\\s+(?:from|at|on)\\s+(?:past\\s+rates|the\\s+last\\s+reading|the\\s+latest\\s+(?:quote|reading))|,?\\s+at\\s+the\\s+last\\s+reading|,?\\s+(?:segundo|conforme)\\s+a\\s+[uú]ltima\\s+(?:cota[cç][aã]o|leitura))';
  const start = '(^\\s*(?:[-*•–—]\\s+)?|[,;:]\\s+(?:and\\s+|e\\s+)?|\\s+and\\s+|\\s+e\\s+)';
  const leadIn = `(?:(?:after\\s+the\\s+haircut|ap[oó]s\\s+o\\s+desconto|${now}),?\\s+)?`;
  // the clause ends at the figure, its period, a word for now or a listed source: nothing after it
  const end = '\\s*[.!?]?\\s*$';
  const subject = `(?:it|ela|${named})`;
  const verb = '(?:yields|yielded|has\\s+yielded|pays|paid|has\\s+paid|rende|rendeu|paga|pagou)';
  return [
    // "its quoted yield is Y a year", "the quoted yield of the reserve is currently Y"
    `${leadIn}${owner}${framed}\\s+${noun}${ofOwner}\\s+(?:${is}\\s+|of\\s+|at\\s+)(?:${now}\\s+)?${approx}${Y}${per}(?:\\s+${now})?${source}?`,
    // "its yield is currently Y a year", "its yield is Y a year right now", "… , based on the latest quote"
    `${leadIn}${owner}${noun}${ofOwner}\\s+${is}\\s+(?:${now}\\s+${approx}${Y}${per}${source}?|${approx}${Y}${per}\\s+${now}${source}?|${approx}${Y}${per}${source})`,
    // "its yield at the last reading was Y"
    `${leadIn}${owner}${noun}${ofOwner}\\s+at\\s+the\\s+last\\s+reading\\s+${is}\\s+${approx}${Y}${per}`,
    // "the reserve currently yields Y a year", "so far the reserve has paid Y a year"
    `(?:${now},?\\s+${subject}(?:\\s+${now})?\\s+${verb}\\s+${approx}${Y}${per}(?:\\s+${now})?${source}?|${subject}\\s+${now}\\s+${verb}\\s+${approx}${Y}${per}(?:\\s+${now})?${source}?|${subject}\\s+${verb}\\s+${approx}${Y}${per}(?:\\s+${now}${source}?|${source}))`,
    // "the reserve has a quoted yield of Y a year"
    `${subject}\\s+(?:has|had)\\s+a\\s+${framed}\\s+${noun}\\s+of\\s+${approx}${Y}${per}(?:\\s+${now})?${source}?`,
    // "o rendimento cotado é Y ao ano"
    `${leadIn}(?:o\\s+|a\\s+)?${nounPt}\\s+${framedPt}${ofOwnerPt}\\s+${isPt}\\s+(?:${now}\\s+)?${approx}${Y}${per}(?:\\s+${now})?${source}?`,
  ].map((clause) => new RegExp(`${start}(?:${clause})${end}`, 'iu'));
};

/**
 * The figures read under the yield grammar (rule 5): a stored yield (`yield:`), and of the asset lookups
 * (FIGURES-BY-REFERENCE as amended 2026-10-14) a yield reading of an asset's profile, which is the token's
 * own yield. A lending market's supply or borrow rate is not one: it is the rate of the token the market
 * lends (`LEND_RATE`), never the asset's yield.
 */
export const isYield = (id: string): boolean =>
  id.startsWith('yield:') || /^profile:.+:yield_[a-z0-9_]+$/u.test(id);

/**
 * A lending market's supply or borrow rate (the asset lookups). It is served only where its sentence calls
 * it a supply rate or a borrow rate (`LOOKUP_KINDS`, `MUST_BE_CALLED`); "rate" and a period are its own
 * words, a yield, a return, earning, a gain or a profit cut it (`RETURN`), and the promise words that cut a
 * yield cut it.
 */
const LEND_RATE = /^lend:.+:(?:supply|borrow)$/u;
/** The rate words a lending rate's sentence may hold, which cut any other figure (`RETURN`). */
const RATE_WORDS = /(?<![\p{L}\p{N}'’])(?:rates?|taxas?)(?![\p{L}\p{N}])/giu;
/**
 * A sentence names a token as what a market takes as collateral ("the vault that takes NVDAx as collateral"):
 * the token is where the figure was read, not what it is of, so the rule that a lending figure's sentence
 * names no other asset leaves it out.
 */
const AS_COLLATERAL =
  /(?<![\p{L}\p{N}])(?:takes?|taking|accepts?|accepting|aceita[mr]?)\s+(?:(?:o|a)\s+)?\S+\s+(?:as|como)\s+(?:collateral|colateral|garantia)(?![\p{L}\p{N}])/giu;
/**
 * The person's own holding or action, or the vault's: a looked-up figure is of an asset or its market, never
 * the person's or the vault's share, stake, result or what they can do (`ANY-COMPOSITION`). Read only in a
 * sentence with a lookup's figure (`personal`).
 */
const PERSON_WORDS =
  "your|yours|yourself|you\\s+(?:can|could|will|would|might|may|should|hold|held|have|had|own|owned|get|got|keep|kept|made|lost|gained|earned|put|invested|bought|sold|are|were|want|wanted|wish|need|lend|lent|supply|supplied|deposit|deposited|withdraw|withdrew|borrow|borrowed|stake|staked)|you['’](?:ll|d|ve|re)|my|mine|myself|ur|vc|vcs|seu|sua|seus|suas|voc[eê]s?|teu|tua|teus|tuas|meu|minha|meus|minhas|we|we['’](?:ll|d|ve|re)|our|ours|ourselves|n[oó]s|nosso|nossa|nossos|nossas|(?:by|for|to)\\s+you|a\\s+person|someone|somebody|anyone|anybody|whoever|uma\\s+pessoa|algu[eé]m|quem|d[aá]\\s+(?:pra|para)";
/** The agent speaking of itself ("I see", "eu vejo"): the person's in a figure's sentence, not beside it. */
const AGENT_WORDS = 'I|eu';
const PERSONAL = lone(`${PERSON_WORDS}|${AGENT_WORDS}`);
const PERSONAL_BESIDE = lone(PERSON_WORDS);
/** "u" and "us" in lower case only, so neither "U.S." nor "US" reads as the person. */
const PERSONAL_CASED = /(?<![\p{L}\p{N}'’])(?:u|us|Us|Ur)(?![\p{L}\p{N}'’.])/u;
/** A vault as a holder: it holds, has, owns or can; or its holding, by an asset's name after "vault's". */
const VAULT_HOLDS = new RegExp(
  `${
    lone(
      "(?:the|this|that|my|your|our)\\s+vaults?\\s+(?:\\p{L}+\\s+)?(?:holds?|held|holding|has|had|owns?|owned|can|could|is\\s+able|gets?|got|keeps?|kept)|(?:o|este|esse|aquele|meu|seu|nosso)\\s+cofre\\s+(?:\\p{L}+\\s+)?(?:tem|teve|pode|podem|possui|det[eé]m|guarda|segura|consegue)|vault['’]s\\s+(?:holdings?|positions?|stakes?|shares?|assets?|tokens?|money|balance|dollars)",
    ).source
  }(?!\\s+(?:(?:a|an|the|its|uma)\\s+)?(?:\\p{L}+\\s+)?(?:(?:supply|borrow|borrowing|lending)\\s+rates?|utili\\p{L}*|taxas?))`,
  'iu',
);
const VAULT_OWNS = /(?<![\p{L}\p{N}])vault['’]s\s+(\S+)/giu;
/** A sentence that tells the person to act: it opens with withdraw, sell, lend, supply, deposit, borrow or hold. */
const IMPERATIVE =
  /^\s*(?:[-*•–—]\s+)?(?:(?:just|then|now|so|please|agora|ent[aã]o|basta)\s*,?\s+)?(?:withdraw|sell|lend|supply|deposit|borrow|hold|buy|stake|saque|sacar|venda|vender|empreste|emprestar|deposite|depositar|tome|tomar|compre|segure)(?![\p{L}\p{N}])(?!\s+(?:rates?|apy|apr|caps?|limits?|sides?|volumes?|of|is|was|stands|totals?)(?![\p{L}\p{N}]))/iu;
/** Portuguese without a subject: "pode sacar", "podem vender", at the start of a sentence or a clause. */
const SUBJECTLESS =
  /(?:^\s*(?:[-*•–—]\s+)?(?:(?:sim|hoje|agora|ent[aã]o|e|mas|j[aá])\s*,?\s+)?|[,;:]\s+)(?:pode|podem)\s+\p{L}{2,}/iu;

/**
 * Whether a sentence speaks of the person's or the vault's own holding or action: a person word, a vault as a
 * holder, an order to act or Portuguese without a subject. `agent`: the agent's own "I" counts too (in the
 * figure's own sentence; beside it, "This is what I found" is the agent speaking).
 */
function personal(
  text: string,
  named: ((text: string) => { own: string[] }) | undefined,
  agent: boolean,
): boolean {
  if (
    (agent ? PERSONAL : PERSONAL_BESIDE).test(text) ||
    PERSONAL_CASED.test(text) ||
    VAULT_HOLDS.test(text) ||
    IMPERATIVE.test(text) ||
    SUBJECTLESS.test(text)
  )
    return true;
  // "the vault's NVDAx": a holding of the vault, by the asset's name
  for (const match of text.matchAll(VAULT_OWNS))
    if ((named?.(match[1] ?? '').own.length ?? 0) > 0) return true;
  return false;
}

/** Read in a sentence beside a lookup's figure, never alone. */
const NEIGHBOUR_RETURN = lone(
  'returns?|returned|returning|yields?|yielded|yielding|earn\\p{L}*|pays?|paid|paying|payouts?|income|profit\\p{L}*|gain\\p{L}*|interest|dividends?|rind\\p{L}*|rend[ae]\\p{L}*|rendiment\\p{L}*|rentabilidade|renda|retorn\\p{L}*|ganh\\p{L}*|lucr\\p{L}*|pag[ao]\\p{L}*|juros|dividendos?',
);
/** A sentence that refers back to the figure before it or on to the one after it. */
const REFERS_OPEN =
  /^\s*(?:[-*•–—]\s+)?(?:(?:and|but|so|e|mas)\s+)?(?:that|this|it|which|so|those|these|isso|isto|esse|essa|esses|essas)(?![\p{L}\p{N}])/iu;
const REFERS_IN = lone('that|this|it|isso|isto|isso\\s+tudo');
/** Beside a change over a window, a result: a change is the asset's past move, never a performance. */
const PERFORMANCE = lone(
  'perform\\p{L}*|profit\\p{L}*|earn\\p{L}*|gain\\p{L}*|lost|made|results?|deliver\\p{L}*|winners?|losers?|(?:good|bad|great|strong|weak|rough|solid|terrible)\\s+(?:week|month|day|year)|(?:did|done|doing)\\s+(?:well|badly|poorly|great)|desempenh\\p{L}*|lucr\\p{L}*|ganh\\p{L}*|perd\\p{L}*|resultados?|entreg\\p{L}*|vencedor\\p{L}*|perdedor\\p{L}*',
);

// A holding's distance from its target, and a line's weight in the shared portfolio the vault follows.
const GAP_WORDS =
  'gaps?|off\\s+(?:its\\s+)?target|away\\s+from|above|below|over|under|short|drift|dist[aâ]ncia|desvio|acima|abaixo';
const WEIGHT_WORDS = 'weights?|weighs|portfolio|pesos?|pesa|portf[oó]lio|carteira';
// A pool's share of the asset's pool dollars, called that: "of the dollars in its pools", "of its pool
// liquidity", "of the pools' TVL", "da liquidez dos pools".
const POOL_SHARE_WORDS = [
  "of\\s+(?:the\\s+)?(?:dollars|liquidity|tvl|value)\\s+(?:held\\s+)?(?:in|across|of)\\s+(?:all\\s+)?(?:its|the|\\p{L}+['’]s)\\s+(?:dex\\s+)?pools",
  "of\\s+(?:its|the|\\p{L}+['’]s)\\s+(?:dex\\s+)?pool\\s+(?:liquidity|tvl|dollars|value)",
  "of\\s+(?:its\\s+|the\\s+)?(?:dex\\s+)?pools['’]\\s+(?:tvl|liquidity|dollars|value)",
  'd[ao]s?\\s+(?:liquidez|tvl|d[oó]lares|valor)\\s+(?:d[oe]s|n[oa]s|em)\\s+(?:\\p{L}+\\s+)?pools',
].join('|');
// A lending market's rates, called a supply rate or a borrow rate, or the rate to supply, lend or borrow.
const SUPPLY_RATE_WORDS =
  'supply\\s+rates?|rates?\\s+(?:to|for)\\s+(?:supply|supplying|lend|lending|deposit|depositing)|taxas?\\s+(?:de|para)\\s+(?:fornecimento|fornecer|suprimento|emprestar|dep[oó]sito|depositar)';
const BORROW_RATE_WORDS =
  'borrow(?:ing)?\\s+rates?|rates?\\s+(?:to|for)\\s+(?:borrow|borrowing)|taxas?\\s+(?:de|para)\\s+(?:tomada|tomar)';
// The kinds a lookup's figure must be called by in its own sentence, wherever it is served: neither a
// lending rate nor a pool's share is ever left to a sentence that could read it as something else.
const MUST_BE_CALLED: Array<[RegExp, RegExp]> = [
  [/^lend:.+:supply$/u, lone(SUPPLY_RATE_WORDS)],
  [/^lend:.+:borrow$/u, lone(BORROW_RATE_WORDS)],
  [/^pool:.+:share$/u, lone(POOL_SHARE_WORDS)],
];
// The asset lookups' families (FIGURES-BY-REFERENCE as amended 2026-10-14): each called what it is. A
// change over a window is a change or a move, never a return or a gain (those words cut it, rule 3).
const LOOKUP_KINDS: Array<[RegExp, RegExp]> = [
  [
    /^profile:.+:supply_(?:total|issuer)$/u,
    lone('supply|supplies|circulat\\p{L}*|issued|oferta|emitid\\p{L}*|emiss\\p{L}*|circula\\p{L}*'),
  ],
  [
    /^profile:.+:holders_top\d+_share$/u,
    lone(
      'holders?|held|largest\\s+(?:accounts|wallets)|concentrat\\p{L}*|detentor\\p{L}*|concentra\\p{L}*',
    ),
  ],
  [
    /^profile:.+:pool_tvl_usd$/u,
    lone('tvl|pools?|held\\s+in|deposited|locked|depositad\\p{L}*|bloquead\\p{L}*'),
  ],
  [
    /^profile:.+:protocol_tvl_usd$/u,
    lone('tvl|protocol|locked|deposited|protocolo|depositad\\p{L}*'),
  ],
  [/^profile:.+:dex_volume_\w+$/u, lone('volume|traded|negociad\\p{L}*')],
  [
    /^profile:.+:exchange_rate$/u,
    lone(
      'exchange|conversion|redemption|redeem\\p{L}*|underlying|c[aâ]mbio|convers[aã]o|resgate|subjacente',
    ),
  ],
  [
    /^bars:.+:close$/u,
    lone('price[sd]?|close[sd]?|closing|pre[cç]os?|fechamento|fechou|cota[cç][aã]o'),
  ],
  [/^bars:.+:high$/u, lone('high|highest|peak|top|m[aá]xim\\p{L}*|pico')],
  [/^bars:.+:low$/u, lone('low|lowest|bottom|trough|m[ií]nim\\p{L}*')],
  [
    /^bars:.+:change$/u,
    lone(
      'change[sd]?|changing|move[sd]?|movement|moving|varia\\p{L}*|mudan[cç]\\p{L}*|mud(?:ou|ar)|oscil\\p{L}*',
    ),
  ],
  [/^bars:.+:volume$/u, lone('volume|traded|negociad\\p{L}*')],
  // the entry and exit sides (Bearing's market terms), beside the old words
  [
    /^bars:.+:buyvol$/u,
    lone('entry\\s+side|entries|bought|buys?|buying|purchases?|purchased|compras?|comprad\\p{L}*'),
  ],
  [
    /^bars:.+:sellvol$/u,
    lone('exit\\s+side|exits|sold|sells?|selling|sales?|vendas?|vendid\\p{L}*'),
  ],
  [
    /^bars:.+:swaps$/u,
    lone('swaps?|trades|count|number\\s+of|trocas?|opera[cç](?:ão|ões|ao|oes)|n[uú]mero\\s+de'),
  ],
  [/^bars:.+:gaps$/u, lone('hours?|gaps?|quiet|horas?|lacunas?')],
  [
    /^pool:.+:tvl$/u,
    lone('tvl|holds|held|deposited|locked|liquidity|liquidez|depositad\\p{L}*|bloquead\\p{L}*'),
  ],
  [/^pool:.+:volume$/u, lone('volume|traded|negociad\\p{L}*')],
  // a share of the dollars in the asset's pools, never a bare "share" (a person's share: ANY-COMPOSITION)
  [/^pool:.+:share$/u, lone(POOL_SHARE_WORDS)],
  [/^lend:.+:supply$/u, lone(SUPPLY_RATE_WORDS)],
  [/^lend:.+:borrow$/u, lone(BORROW_RATE_WORDS)],
  [
    /^lend:.+:util$/u,
    lone('utili[sz]\\p{L}*|lent\\s+out|in\\s+use|utiliza\\p{L}*|emprestad\\p{L}*'),
  ],
  [
    /^lend:.+:withdrawable$/u,
    lone('withdraw\\p{L}*|available|sac\\p{L}*|dispon[ií]ve\\p{L}*|resgat\\p{L}*'),
  ],
  // a market that only takes the asset as collateral: no figure, a note that it is collateral there
  [/^lend:.+:collateral$/u, lone('collateral|colateral|garantia')],
];
// The kind of a figure, by its id, and the words that name it in a sentence.
const BASE_KINDS: Array<[RegExp, RegExp]> = [
  [
    /^(?:vault:value|holding:.*:value)$/u,
    lone(
      'worth|values?|valued|total|totals|altogether|in\\s+all|vale|valem|valor|no\\s+total|ao\\s+todo',
    ),
  ],
  [
    /^holding:.*:(?:share|target)$/u,
    lone(
      'of\\s+(?:the|your|this)\\s+vault|shares?|target|targets|portion|d[oe]\\s+(?:seu\\s+)?cofre|parcela|participa[cç][aã]o|alvo|meta',
    ),
  ],
  [
    /^holding:.*:amount$/u,
    lone('units?|tokens?|hold|holds|holding|amount|unidades?|quantidade|possui|tem'),
  ],
  [/^holding:.*:gap$/u, lone(GAP_WORDS)],
  [/^recipe:.*:weight$/u, lone(WEIGHT_WORDS)],
  [/^price:/u, lone('price[sd]?|trades?|trading|pre[cç]os?|cota[cç][aã]o|negocia\\p{L}*')],
  [
    /^(?:exit|lpexit|liquidity|capacity):/u,
    lone(
      'costs?|sell|sells|selling|sold|sale|exit|capacity|custo|custa|custaria|vender|venda|sa[ií]da|capacidade',
    ),
  ],
  [/^drawdown:/u, lone('drawdowns?|fall|fell|fallen|drop\\p{L}*|declin\\p{L}*|quedas?|caiu')],
  [/^vol:/u, lone('volatil\\p{L}*')],
  [/^weekend:/u, lone('weekends?|fi(?:m|ns)\\s+de\\s+semana')],
  [/^lp:/u, lone('providers?|liquidity|provedor\\p{L}*|liquidez')],
  [/^capvar:/u, lone('var(?:y|ies|ied|iation|iations)|varia\\p{L}*')],
  [/^volume:/u, lone('volume|trades?|traded|negociad\\p{L}*')],
];
const VAULT_WORD = lone('vault|cofre');
// Where every figure must be called what it is (`kindRequired`, the relaxed intake): the words that
// name each kind, narrower than `KINDS`. A cost is not a capacity, "trades" is a price and not a
// volume, and "is at" and "goes for" say a price. A kind of the vault's own (worth, share, target,
// amount) has no words here: no such figure exists where this is asked.
const BASE_STRICT_KINDS: Array<[RegExp, RegExp]> = [
  [
    /^price:/u,
    lone(
      'price[sd]?|trades?|trading|is\\s+at|goes\\s+for|pre[cç]os?|cota[cç][aã]o|negocia\\p{L}*|est[aá]\\s+a',
    ),
  ],
  [/^(?:exit|lpexit):/u, lone('costs?|custos?|custa|custaria')],
  [
    /^(?:capacity|liquidity):/u,
    lone('capacity|largest\\s+sale|sale|deep|depth|capacidade|maior\\s+venda|venda|profund\\p{L}*'),
  ],
  [/^drawdown:/u, lone('drawdowns?|fall|fell|fallen|drop\\p{L}*|declin\\p{L}*|quedas?|caiu')],
  [/^vol:/u, lone('volatil\\p{L}*')],
  [/^weekend:/u, lone('weekends?|fi(?:m|ns)\\s+de\\s+semana')],
  [/^lp:/u, lone('providers?|provedor\\p{L}*')],
  [/^capvar:/u, lone('var(?:y|ies|ied|iation|iations)|varia\\p{L}*')],
  [/^volume:/u, lone('volume|traded|negociad\\p{L}*')],
];
// The words that bind to a figure: each names one kind and stands beside the figure it speaks of
// ("priced at X", "X of the vault", "X units"). Narrower than `KINDS`: "holding" and "total" stand
// in sentences about any figure, and "share" is also a unit of a stock.
const BASE_BOUND_KINDS: Array<[RegExp, RegExp]> = [
  [/^(?:vault:value|holding:.*:value)$/u, lone('worth|values?|valued|vale|valem|valor')],
  [
    /^holding:.*:share$/u,
    lone('of\\s+(?:the|your|this)\\s+vault|d[oe]\\s+(?:seu\\s+)?cofre|parcela|participa[cç][aã]o'),
  ],
  [/^holding:.*:target$/u, lone('targets?|alvo|meta')],
  [/^holding:.*:amount$/u, lone('units?|tokens?|unidades?')],
  [/^holding:.*:gap$/u, lone(GAP_WORDS)],
  [/^recipe:.*:weight$/u, lone(WEIGHT_WORDS)],
  ...BASE_STRICT_KINDS,
];
// A lookup's kind words count only in a sentence that names a lookup's figure: elsewhere ("selling",
// "hours", "supply" beside a cost) they are plain words, as they were before the lookups.
const LOOKUP_ID = /^(?:profile|bars|pool|lend):/u;
const hasLookup = (ids: readonly (string | undefined)[]) =>
  ids.some((id) => id !== undefined && LOOKUP_ID.test(id));
const KINDS = [...BASE_KINDS, ...LOOKUP_KINDS];
const STRICT_KINDS = [...BASE_STRICT_KINDS, ...LOOKUP_KINDS];
const boundKinds = (ids: readonly (string | undefined)[]) =>
  hasLookup(ids) ? [...BASE_BOUND_KINDS, ...LOOKUP_KINDS] : BASE_BOUND_KINDS;
/**
 * Whether each figure stands beside a word of its own kind. Every kind word of the sentence binds to
 * the reference nearest it; a figure that words are bound to, none of them of its kind, is called
 * what another figure is ("priced at <a cost> and costs <a price>"). Where the kinds are named in a
 * run and the figures given in another ("its price and value are X and Y"), they pair in order. A
 * figure no word binds to is left to the other rules. `ids` are the figures of `words`, one for each mark, in order.
 */
function boundToItsKind(words: string, ids: readonly (string | undefined)[]): boolean {
  const marks = [...words.matchAll(new RegExp(MARK, 'gu'))].map((match) => match.index);
  if (marks.length < 2) return true;
  const bound = marks.map(() => ({ any: false, own: false }));
  // every kind word, once, in the order it stands
  const spans = new Map<number, { from: number; to: number; word: string }>();
  const BOUND_KINDS = boundKinds(ids);
  for (const [, named] of BOUND_KINDS)
    for (const match of words.matchAll(new RegExp(named.source, `g${named.flags}`)))
      spans.set(match.index, {
        from: match.index,
        to: match.index + match[0].length,
        word: match[0],
      });
  const said = [...spans.values()].sort((a, b) => a.from - b.from);
  const first = marks[0] ?? 0;
  const last = marks.at(-1) ?? 0;
  // "A and B are X and Y": as many kind words as figures, all before them or all after, pair in order
  const inOrder =
    said.length === marks.length &&
    (said.every((span) => span.to <= first) || said.every((span) => span.from > last));
  said.forEach((span, place) => {
    let nearest = place;
    if (!inOrder) {
      let least = Number.POSITIVE_INFINITY;
      marks.forEach((at, index) => {
        const gap = at >= span.to ? at - span.to : span.from - at;
        if (gap < least) {
          least = gap;
          nearest = index;
        }
      });
    }
    const slot = bound[nearest];
    const id = ids[nearest];
    if (!slot || id === undefined) return;
    slot.any = true;
    // a word of several kinds ("trades": a price and a volume) agrees with each
    if (BOUND_KINDS.some(([kind, word]) => kind.test(id) && word.test(span.word))) slot.own = true;
  });
  return bound.every((slot) => !slot.any || slot.own);
}
const strictlyNamed = (id: string, words: string) =>
  STRICT_KINDS.some(([of, named]) => of.test(id) && named.test(words));
const anyKindWord = (words: string, ids: readonly string[]) =>
  [
    ...(hasLookup(ids) ? KINDS : BASE_KINDS),
    ...(hasLookup(ids) ? STRICT_KINDS : BASE_STRICT_KINDS),
  ].some(([, named]) => named.test(words));
/** One figure set against another, or against anything: a verdict, which no figure states. */
const COMPARISON = lone(
  '(?:more|less|higher|lower|deeper|shallower|cheaper|costlier|pricier|better|worse|bigger|smaller|larger|greater|fewer|safer|riskier|easier|harder)\\s+than|than|compared\\s+(?:to|with)|versus|vs|(?:mais|menos|maior|menor|melhor|pior)\\s+(?:\\p{L}+\\s+)?(?:do\\s+)?que|do\\s+que',
);
/** A line of a list: it is read under the list's heading. */
const LIST_ITEM = /^\s*(?:[-*•–—]|\p{N}+[.)])\s/u;
const kindNamed = (id: string, words: string) =>
  KINDS.some(([of, named]) => of.test(id) && named.test(words));

// A sentence is not ended by the stop of an abbreviation, nor by an ellipsis that runs on.
const ABBREVIATED =
  /(?<![\p{L}\p{N}])(?:approx|e\.g|i\.e|vs|est|etc|cf|ca|aprox|p\.\s?ex|ex)\.\s*$/iu;
const RUNS_ON = /(?:…|\.{3})\s*$/u;
const NOT_LATIN = /[^\P{L}\p{Script=Latin}]|\p{Default_Ignorable_Code_Point}/u;

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
  rate: 'a rate or a return word in or just before a sentence whose reference is not a yield: figure',
  move: 'a rise or a fall in or just before a sentence whose reference is not a drawdown: figure',
  forecast: 'a forecast or a promise in or just before a sentence with a reference',
  claim:
    'a claim no figure measures (a gain made, a chance, a tax, a fee, over- or undervalued) in or just before a sentence with a reference',
  frame:
    'a yield: reference in a sentence that is more than its measurement: say only that the quoted, measured or current yield is the figure, with at most a period ("a year"), a word for now and where it was read, and end the sentence there',
  bare: 'a reference in a sentence that names neither what the figure is (worth, of the vault, target, price, cost to sell, drawdown, volatility) nor an asset',
  script:
    'a letter that is not Latin, or a character that is not shown, in or just before a sentence with a reference',
  asset: "a sentence that names one asset and references another asset's figure",
  malformed: 'a brace that is not part of one well-formed reference',
  bound:
    'a figure beside the word for another kind of figure (a cost called a price, a share called a value): put each reference next to the word for what it is',
  kind: "a reference whose sentence does not call the figure what it is: say price, cost to sell, the largest sale or capacity, weekend, provider, variation, volume, volatility or drawdown, as the figure's own line says, in the sentence of the figure or in the heading of its list",
  comparison:
    'a comparison in a sentence with a reference ("more than", "cheaper than", "versus"): give each figure in its own sentence and no verdict',
  called:
    "a lending rate not called a supply rate or a borrow rate, or a pool's share not called a share of the dollars in the asset's pools, in its own sentence",
  personal:
    "a looked-up figure in a sentence about the person's or the vault's own holding or action (your, you can, we, our, I, the vault holds, an order such as \"withdraw\", seu, você, pode sacar): it is a figure of the asset or its market, never the person's",
  neighbour:
    "a looked-up figure with a sentence just before or after it that refers back to it (that, this, it, isso) and calls it a yield, a return, a payment, a result or the person's or the vault's own: say what the figure is in its own sentence and nothing more of it",
  performance:
    'a change over a window called a performance, a profit or a result made or lost: call it the change over its window',
} as const;

export type FigureResolver = {
  /** The figure an id names in this request, measured or not, or undefined when it names none. */
  figure(id: string): VaultAgentFigure | undefined;
  /** A figure of this request as plain prose says it, in the reply's language (`plainFigureText`). */
  plain(figure: VaultAgentFigure): string;
  /**
   * Why `text` holds an unbacked figure through its references, one entry each: an id that names no
   * figure, and what `SAID` lists. Empty when every reference stands alone as a figure of the request.
   * `lead` is the text shown just above this one, whose last sentence is read with its first.
   */
  unbacked(text: string, lead?: string): string[];
  /** `text` sentence by sentence, as it joins back, each with why it cannot be served, if anything. */
  parts(text: string, lead?: string): Array<{ sentence: string; why: string[] }>;
};

/**
 * Resolves references against one request's evidence: an id whose source carries a value is that
 * figure, an id listed as missing says why, and anything else names nothing. With `enabled` false (the
 * model-led conversation of a new goal, which states no figure) every reference names nothing. `sentences` cuts a
 * text where the trimming does, `digitNames` are the catalog names that hold digits, and `named` the
 * assets a text names: `own` by a name of one asset, `classes` by a word for a class of them.
 */
export function figureResolver(input: {
  enabled: boolean;
  sources: ReadonlyMap<string, VaultAgentSource>;
  references: FigureReferences | undefined;
  lowerBound: ReadonlySet<string>;
  language: 'en' | 'pt';
  sentences?: (text: string) => string[];
  digitNames?: readonly string[];
  named?: (text: string) => { own: string[]; classes: string[] };
  /** The names an asset goes by in prose: its symbol and what it tracks. */
  namesOf?: (assetId: string) => string[];
  /**
   * Every figure but a yield is called what it is (`STRICT_KINDS`): its kind's word stands in its
   * sentence, or, where the sentence has no word of any kind, in the one it is read with; a line of a
   * list is read with the list's heading. For a conversation whose model is handed ids without their
   * values, where naming the wrong id is the likely mistake. Off for the vault's conversation.
   */
  kindRequired?: boolean;
  /** No sentence with a reference compares (`COMPARISON`). Off for the vault's conversation. */
  noComparison?: boolean;
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
      const gap =
        references?.windowGaps && Object.hasOwn(references.windowGaps, id)
          ? references.windowGaps[id]
          : undefined;
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
        ...(gap && gap.missingHours > 0
          ? { missingHours: gap.missingHours, windowHours: gap.windowHours }
          : {}),
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
  const split = (text: string): string[] => {
    const cut = (input.sentences ?? ((whole) => [whole]))(text);
    const joined: string[] = [];
    for (const sentence of cut) {
      const last = joined.at(-1);
      if (
        last !== undefined &&
        (ABBREVIATED.test(last) || (RUNS_ON.test(last) && /^(?:\p{Ll}|\{\{fact:)/u.test(sentence)))
      )
        joined[joined.length - 1] = last + sentence;
      else joined.push(sentence);
    }
    return joined;
  };
  /** Rule 3 to 6, for one sentence that holds a reference, with the sentence that stands before it. */
  const worded = (sentence: string, before: string, next: string): Array<keyof typeof SAID> => {
    const ids = idsIn(sentence);
    // the figures that are not yields; an id that names no figure is refused where ids are read
    const others = ids.filter((id) => !isYield(id) && figure(id) !== undefined);
    const yields = ids.some((id) => isYield(id));
    // a lending market's supply or borrow rate: not a yield, but promised as one is
    const lendRates = others.filter((id) => LEND_RATE.test(id));
    const all = plainly(withoutReferences(sentence));
    const lead = plainly(withoutReferences(before));
    const found: Array<keyof typeof SAID> = [];
    // A promise beside a yield or a lending rate is one of it, in its own sentence or in the one before
    // or after: "…a year. You will keep earning that." A neighbour is read for a forecast only when it
    // speaks of the figure (`promisesTheYield`); one about anything else, or one that hedges, is served.
    // Every neighbour is read against the promise list, whoever speaks and question or not. Two honest
    // shapes are spared, each only in its own words: the clause in which the agent says what it cannot
    // tell or would not count on, and the words of an offer to the person ("Would you like…?", "Do you
    // want to keep…?"). The rest of either sentence is read.
    const promised = () => {
      const after = plainly(withoutReferences(next));
      const worded = [lead, after].map((neighbour) =>
        (OFFER.test(neighbour) ? neighbour.replace(OFFER_WORDS, ' ') : neighbour).replace(
          OWN_CAVEAT,
          ' ',
        ),
      );
      return (
        PROMISE.test(`${worded.join(' ').replace(DISCLAIMED, ' ')} ${all}`) ||
        [lead, after].some(promisesTheYield)
      );
    };
    // Rule 5: each yield in a clause of the grammar, which is then set aside; what is left of the
    // sentence is read for its other figures.
    let own = all;
    let bindable = all;
    if (yields) {
      let rest = plainly(
        sentence.replace(FIGURE_REFERENCE, (_whole, id: string) => (isYield(id) ? Y : MARK)),
      );
      const clauses = yieldClauses(
        ids.flatMap((id) => {
          const of = isYield(id) ? figure(id)?.assetId : undefined;
          return of === undefined ? [] : (input.namesOf?.(of) ?? []);
        }),
      );
      for (let more = true; more; ) {
        more = false;
        for (const clause of clauses) {
          const cut = rest.replace(clause, '$1');
          if (cut !== rest) {
            rest = cut;
            more = true;
          }
        }
      }
      // What is left beside the clauses is nothing, or another figure that is judged on its own
      // words: free text there would say of the yield what the clause may not.
      if (rest.includes(Y) || (!rest.includes(MARK) && /\p{L}/u.test(rest))) found.push('frame');
      if (promised()) found.push('forecast');
      bindable = rest;
      own = rest.replaceAll(Y, MARK);
    }
    // Each kind word beside the figure it names: ids that name no figure keep their place in the order.
    if (
      !boundToItsKind(
        bindable,
        ids.filter((id) => !isYield(id)).map((id) => (figure(id) ? id : undefined)),
      )
    )
      found.push('bound');
    // Rule 4: a sentence that names the kind of every figure stands on its own; one that only names an
    // asset is read with the sentence before it; one that does neither is not served.
    const here = input.named?.(all);
    const namesHere = (here?.own.length ?? 0) + (here?.classes.length ?? 0) > 0;
    // It stands on its own when it names the kind of every figure and that figure's subject: an asset,
    // or the vault for the vault's own value.
    const described = others.every(
      (id) =>
        kindNamed(id, own) &&
        (figure(id)?.assetId === undefined ? VAULT_WORD.test(own) : namesHere),
    );
    if (others.length && !namesHere && !others.some((id) => kindNamed(id, own))) found.push('bare');
    const carried = described ? '' : lead.replace(GOAL_WORDS, ' ');
    const whole = `${carried} ${all}`;
    const read = `${carried} ${own}`;
    if (NOT_LATIN.test(`${lead} ${all}`)) found.push('script');
    if (MAGNITUDE.test(whole)) found.push('magnitude');
    if (ARITHMETIC.test(whole)) found.push('arithmetic');
    if (BESIDE.test(whole)) found.push('beside');
    if (CLAIM.test(whole)) found.push('claim');
    if (FORECAST.test(whole)) found.push('forecast');
    if (input.kindRequired && others.length) {
      const said = anyKindWord(own, ids) ? own : lead;
      if (!others.every((id) => strictlyNamed(id, said))) found.push('kind');
    }
    if (input.noComparison && COMPARISON.test(all)) found.push('comparison');
    // The asset lookups' own rules, read only where one of their figures stands: no earlier id is judged
    // otherwise.
    if (lendRates.length && !yields && promised()) found.push('forecast');
    if (
      others.some((id) => MUST_BE_CALLED.some(([kind, named]) => kind.test(id) && !named.test(own)))
    )
      found.push('called');
    if (hasLookup(ids) && personal(all, input.named, true)) found.push('personal');
    if (
      ids.some((id) => /^bars:.+:change$/u.test(id)) &&
      // a result in the sentence before or after a change is said of the change
      (PERFORMANCE.test(whole) ||
        PERFORMANCE.test(lead) ||
        PERFORMANCE.test(plainly(withoutReferences(next))))
    )
      found.push('performance');
    // A sentence just before or after a lookup's figure that refers to it and calls it a yield, a return, a
    // result or the person's or the vault's own says that of the figure ("… a year. That is NVDAx's yield.").
    if (
      hasLookup(ids) &&
      [lead, plainly(withoutReferences(next))].some(
        (beside) =>
          (REFERS_OPEN.test(beside) || REFERS_IN.test(beside)) &&
          (NEIGHBOUR_RETURN.test(beside) ||
            PERFORMANCE.test(beside) ||
            personal(beside, input.named, false)),
      )
    )
      found.push('neighbour');
    if (others.length) {
      const every = (...kinds: string[]) =>
        others.every((id) => kinds.some((kind) => id.startsWith(kind)));
      const some = (kind: string) => others.some((id) => id.startsWith(kind));
      const oneAsset = new Set(others.map((id) => figure(id)?.assetId)).size === 1;
      const both = oneAsset && every('vol:', 'drawdown:');
      // a lending rate is a rate a year: "rate" and its period are its own words, when every figure of
      // the sentence is one; a yield, a return, earning, a gain or a profit still cut it
      const rates = lendRates.length === others.length;
      if (
        RETURN.test(rates ? read.replace(RATE_WORDS, ' ') : read) ||
        (PERIOD.test(read) && !every('vol:') && !(both && some('vol:')) && !rates)
      )
        found.push('rate');
      if (MOVE.test(read) && !every('drawdown:') && !(both && some('drawdown:')))
        found.push('move');
    }
    // A sentence that names assets and references a figure of an asset it does not name; one that
    // names none ("It trades at…") speaks of what the sentence before named.
    const told = namesHere ? here : input.named?.(lead);
    const names = new Set([...(told?.own ?? []), ...(told?.classes ?? [])]);
    // A lending figure is the figure of the token its market lends, and is served under that token
    // (asset-lookups.ts, `lendingAnswer`): its sentence names no other asset, but for one named as what the
    // market takes as collateral ("the vault that takes NVDAx as collateral").
    const ofIds = new Set(
      ids.flatMap((id) => {
        const of = figure(id)?.assetId;
        return of === undefined ? [] : [of];
      }),
    );
    const besides = namesHere ? input.named?.(all.replace(AS_COLLATERAL, ' ')) : told;
    if (
      names.size > 0 &&
      (ids.some((id) => {
        const of = figure(id)?.assetId;
        return of !== undefined && !names.has(of);
      }) ||
        (ids.some((id) => id.startsWith('lend:')) &&
          (besides?.own ?? []).some((named) => !ofIds.has(named))))
    )
      found.push('asset');
    return found;
  };
  const parts = (text: string, lead = ''): Array<{ sentence: string; why: string[] }> => {
    const sentences = split(text);
    // Compared as one form: full-width and other compatibility characters read as what they show.
    const read = sentences.map((sentence) => sentence.normalize('NFKC'));
    const whole = read.join('');
    // Rule 1, over the whole text: a reference between an opening quotation mark and its close, or
    // the end of the text.
    const quoted = new Set<number>();
    let open = false;
    for (let at = 0; at < whole.length; at += 1) {
      const char = whole[at];
      if (char === '“' || char === '«') open = true;
      else if (char === '”' || char === '»') open = false;
      else if (char === '"') open = !open;
      else if (open && whole.startsWith('{{fact:', at)) quoted.add(at);
    }
    let from = 0;
    return sentences.map((sentence, index) => {
      const mine = read[index] ?? '';
      const start = from;
      from += mine.length;
      const ids = idsIn(mine);
      const bad: string[] = ids.filter((id) => figure(id) === undefined);
      const found = new Set<keyof typeof SAID>();
      if (/[{}]/u.test(withoutReferences(mine)) || ids.length !== idsIn(sentence).length)
        found.add('malformed');
      if (ids.length) {
        for (const match of mine.matchAll(FIGURE_REFERENCE)) {
          const at = start + match.index;
          if (quoted.has(at)) found.add('quoted');
          // Rule 2: bounded on both sides, read in the whole text.
          if (!BEFORE.test(whole.slice(0, at)) || !AFTER.test(whole.slice(at + match[0].length)))
            found.add('touching');
        }
        const marked = withoutReferences(mine);
        if (nameTouches.some((touches) => touches.test(marked))) found.add('name');
        let before =
          index > 0 ? (read[index - 1] ?? '') : (split(lead).at(-1) ?? '').normalize('NFKC');
        if (input.kindRequired && LIST_ITEM.test(mine)) {
          // under the heading of its list as well as the line before it
          let at = index - 1;
          while (at >= 0 && LIST_ITEM.test(read[at] ?? '')) at -= 1;
          if (at >= 0 && at < index - 1) before = `${read[at] ?? ''} ${before}`;
        }
        for (const why of worded(mine, before, read[index + 1] ?? '')) found.add(why);
      }
      return { sentence, why: [...bad, ...[...found].map((why) => SAID[why])] };
    });
  };
  return {
    figure,
    plain: (figure) => plainFigureText(figure, language),
    parts,
    unbacked: (text, lead) => [...new Set(parts(text, lead).flatMap((part) => part.why))],
  };
}

/**
 * One text without the sentences that cannot be served: those `typed` flags (the model's own words
 * hold a figure) and those whose reference the resolver refuses. A figure that only shows across two
 * sentences leaves nothing of the text. `lead` is the text shown just above this one.
 */
export function withoutUnserved(
  references: FigureResolver,
  typed: (text: string) => boolean,
  text: string,
  lead = '',
): { text: string; cut: number } {
  const parts = references.parts(text, lead);
  const kept = parts.filter((part) => !part.why.length && !typed(part.sentence));
  if (kept.length === parts.length && !typed(text)) return { text, cut: 0 };
  const rest = kept
    .map((part) => part.sentence)
    .join('')
    .trim();
  return typed(rest)
    ? { text: '', cut: parts.length }
    : { text: rest, cut: parts.length - kept.length };
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

/**
 * What the vault's targets add to its own figures (`vaultFacts`): the target of cash, which is what
 * the targets leave of the whole, each holding's distance from its target, and, for a vault that
 * follows a shared portfolio, each line's weight in the version read from the chain. A gap that needs
 * a price the chain did not give is missing, never zero.
 */
export function targetFacts(input: {
  state: VaultState;
  prices: readonly Price[];
  assets: readonly BasketAsset[];
  chainSource: string;
  chainProvenance: Provenance;
  followed?: {
    version: number;
    readAt: string;
    lines: ReadonlyArray<{ asset: string; weightBps: number }>;
  };
}): { sources: VaultAgentSource[]; references: FigureReferences } {
  const { state, prices, assets, chainSource, chainProvenance } = input;
  const sources: VaultAgentSource[] = [];
  const references: FigureReferences = { missing: {}, staleAgeSec: {} };
  const listed = new Set(assets.map((asset) => asset.id));
  const read = { source: chainSource, fetchedAt: state.observedAt, provenance: chainProvenance };
  for (const line of input.followed?.lines ?? []) {
    if (!listed.has(line.asset)) continue;
    sources.push({
      id: `recipe:${line.asset}:weight`,
      assetId: line.asset,
      label: 'Weight of this asset in the shared portfolio the vault follows',
      value: line.weightBps / 10_000,
      unit: 'fraction',
      source: chainSource,
      fetchedAt: input.followed?.readAt ?? state.observedAt,
      provenance: chainProvenance,
      method: `weight in version ${input.followed?.version} of the shared portfolio, read from its chain`,
    });
  }
  if (!listed.has(state.cash.asset)) return { sources, references };
  const cashTargetBps = 10_000 - state.positions.reduce((sum, p) => sum + p.targetBps, 0);
  if (cashTargetBps >= 0)
    sources.push({
      id: `holding:${state.cash.asset}:target`,
      assetId: state.cash.asset,
      label: 'Target share of cash in the vault: what the targets leave of the whole',
      value: cashTargetBps / 10_000,
      unit: 'fraction',
      ...read,
      method:
        'one whole minus the targets read from the vault on its chain; cash is never a target',
    });
  let seen: ReturnType<typeof view>;
  try {
    seen = view(state, [...prices], [...assets]);
  } catch {
    return { sources, references };
  }
  const priceOf = new Map(prices.map((price) => [price.asset, price]));
  const unpriced = seen.positions.some(
    (position) => position.valueUsd === null && !/^0+$/.test(position.raw),
  );
  const used = seen.positions.flatMap((position) => {
    const price = position.valueUsd === null ? undefined : priceOf.get(position.asset);
    return price ? [price] : [];
  });
  const older = (a: string, b: string) => (Date.parse(b) < Date.parse(a) ? b : a);
  const whole = {
    source: used.length ? [...new Set(used.map((price) => price.source))].join(' + ') : chainSource,
    fetchedAt: used.reduce((oldest, price) => older(oldest, price.fetchedAt), state.observedAt),
    provenance: used.reduce((label, price) => worst(label, price.provenance), chainProvenance),
  };
  const total = Number(seen.valueUsd);
  const label = "This holding's share of the vault minus its target; negative is below target";
  const gap = (assetId: string, weightBps: number, targetBps: number) => {
    const id = `holding:${assetId}:gap`;
    if (unpriced) references.missing[id] = { assetId, label, reason: 'no_reference_price' };
    else if (!(total > 0)) references.missing[id] = { assetId, label, reason: 'not_applicable' };
    else
      sources.push({
        id,
        assetId,
        label,
        value: (weightBps - targetBps) / 10_000,
        unit: 'fraction',
        ...whole,
        method: "this holding's share of the vault's value at reference prices, minus its target",
      });
  };
  const others = seen.positions.reduce((sum, position) => sum + position.weightBps, 0);
  if (cashTargetBps >= 0) gap(state.cash.asset, total > 0 ? 10_000 - others : 0, cashTargetBps);
  for (const position of seen.positions)
    if (listed.has(position.asset)) gap(position.asset, position.weightBps, position.targetBps);
  return { sources, references };
}
