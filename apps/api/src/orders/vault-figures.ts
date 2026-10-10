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
  `${lone("will|won'?t|shall|going\\s+to|gonna|expect\\p{L}*|forecast\\p{L}*|project(?:ed|s|ion|ions)|predict\\p{L}*|guarante\\p{L}*|promis\\p{L}*|vai|v[aã]o|ir[aá]|ir[aã]o|garant\\p{L}*|promet\\p{L}*|prev[eê]\\p{L}*|previs\\p{L}*|esper\\p{L}*").source}|['’]ll(?![\\p{L}\\p{N}])|\\p{L}{2,}(?:ará|erá|irá|arão|erão|irão)(?![\\p{L}\\p{N}])`,
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
  "should|would|ought|must|always|sure|surely|certain\\p{L}*|definitely|safe|safely|secure\\p{L}*|protected|count(?:s|ing)?\\s+on|bank(?:s|ing)?\\s+on|rely\\p{L}*|relies|relied|depend\\p{L}*|at\\s+least|never\\s+less|not\\s+(?:pay\\s+)?less|next\\s+(?:year|month|week)|from\\s+(?:now|here)(?:\\s+on)?|going\\s+forward|here\\s+to\\s+stay|forever|for\\s+life|for\\s+good|keeps?|kept|lock\\p{L}*|steady|steadily|fixed|reliab\\p{L}*|no\\s+matter|without\\s+fail|rain|clockwork|every\\s+(?:time|year|month|week|day)|each\\s+and\\s+every|as\\s+long\\s+as|risk|downside|collect\\p{L}*|take\\s+home|pocket|set\\s+for|nothing\\s+can|can\\s*not|can'?t|does\\s+not\\s+change|doesn['’]?t\\s+change|deve|devem|dever[aá]|deveria|sempre|cert[oa]|certeza|certamente|segur[oa]\\p{L}*|cont[ae]r?\\s+com|pelo\\s+menos|nunca\\s+menos|(?:ano|m[eê]s)\\s+que\\s+vem|pr[oó]xim[oa]\\s+(?:ano|m[eê]s)|todo\\s+(?:ano|m[eê]s|dia)|todos\\s+os\\s+(?:anos|meses)|n[aã]o\\s+muda|daqui\\s+(?:para|pra)\\s+frente|risco|livre\\s+de|trav\\p{L}*|est[aá]vel|est[aá]veis|fix[oa]s?|confi[aá]ve\\p{L}*",
);

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

// The kind of a figure, by its id, and the words that name it in a sentence.
const KINDS: Array<[RegExp, RegExp]> = [
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
const STRICT_KINDS: Array<[RegExp, RegExp]> = [
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
const strictlyNamed = (id: string, words: string) =>
  STRICT_KINDS.some(([of, named]) => of.test(id) && named.test(words));
const anyKindWord = (words: string) =>
  [...KINDS, ...STRICT_KINDS].some(([, named]) => named.test(words));
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
  kind: "a reference whose sentence does not call the figure what it is: say price, cost to sell, the largest sale or capacity, weekend, provider, variation, volume, volatility or drawdown, as the figure's own line says, in the sentence of the figure or in the heading of its list",
  comparison:
    'a comparison in a sentence with a reference ("more than", "cheaper than", "versus"): give each figure in its own sentence and no verdict',
} as const;

export type FigureResolver = {
  /** The figure an id names in this request, measured or not, or undefined when it names none. */
  figure(id: string): VaultAgentFigure | undefined;
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
    const others = ids.filter((id) => !id.startsWith('yield:') && figure(id) !== undefined);
    const yields = ids.some((id) => id.startsWith('yield:'));
    const all = plainly(withoutReferences(sentence));
    const lead = plainly(withoutReferences(before));
    const found: Array<keyof typeof SAID> = [];
    // Rule 5: each yield in a clause of the grammar, which is then set aside; what is left of the
    // sentence is read for its other figures.
    let own = all;
    if (yields) {
      let rest = plainly(
        sentence.replace(FIGURE_REFERENCE, (_whole, id: string) =>
          id.startsWith('yield:') ? Y : MARK,
        ),
      );
      const clauses = yieldClauses(
        ids.flatMap((id) => {
          const of = id.startsWith('yield:') ? figure(id)?.assetId : undefined;
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
      if (PROMISE.test(`${lead} ${all} ${plainly(withoutReferences(next))}`))
        found.push('forecast');
      own = rest.replaceAll(Y, MARK);
    }
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
      const said = anyKindWord(own) ? own : lead;
      if (!others.every((id) => strictlyNamed(id, said))) found.push('kind');
    }
    if (input.noComparison && COMPARISON.test(all)) found.push('comparison');
    if (others.length) {
      const every = (...kinds: string[]) =>
        others.every((id) => kinds.some((kind) => id.startsWith(kind)));
      const some = (kind: string) => others.some((id) => id.startsWith(kind));
      const oneAsset = new Set(others.map((id) => figure(id)?.assetId)).size === 1;
      const both = oneAsset && every('vol:', 'drawdown:');
      if (RETURN.test(read) || (PERIOD.test(read) && !every('vol:') && !(both && some('vol:'))))
        found.push('rate');
      if (MOVE.test(read) && !every('drawdown:') && !(both && some('drawdown:')))
        found.push('move');
    }
    // A sentence that names assets and references a figure of an asset it does not name; one that
    // names none ("It trades at…") speaks of what the sentence before named.
    const told = namesHere ? here : input.named?.(lead);
    const names = new Set([...(told?.own ?? []), ...(told?.classes ?? [])]);
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
