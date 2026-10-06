import type { HoldableClass } from './types';

// What a goal sentence says in so many words, read by code (gate GUIDED-INTAKE, the checks after the
// model of DESIGN-VAULT section 7). The model reads the sentence; these functions say which amounts,
// time frames and refusals the sentence holds, so a value the model reports that the text does not
// hold is dropped and asked about. Nothing here guesses: a sentence that says it in a way this file
// does not read gives nothing, and the person is asked.

/** A number in the text, with the currency written beside it (null: none) and what it counts. */
export type Mention = {
  value: number;
  currency: string | null;
  /** `amount`: money or a bare number. `duration`: followed by a unit of time. `year`: a calendar year. `percent`. */
  kind: 'amount' | 'duration' | 'year' | 'percent';
  /** An amount written as a rate a month ("$300 a month", "US$ 15 por mês"): an income, not the sum put in. */
  perMonth: boolean;
  /** A duration or a year written as a time frame ("for 5 years", "em 18 meses", "by 2031"), not an age. */
  timeFrame: boolean;
  /** As written. */
  text: string;
  /** Where it is written: from `at` up to `end`. */
  at: number;
  end: number;
};

const THOUSAND = 10 * 10 * 10;
const MILLION = THOUSAND * THOUSAND;

// Currency marks before or after a number, by the code they stand for. A mark this list does not
// know as dollars is never read as dollars.
const CURRENCY_OF: [RegExp, string][] = [
  [/^(us\$|u\$s|usd|\$|d[oó]lar(es)?|dollars?|bucks)$/i, 'USD'],
  [/^(r\$|brl|reais|real)$/i, 'BRL'],
  [/^(€|eur|euros?)$/i, 'EUR'],
  [/^(£|gbp|pounds?|libras?)$/i, 'GBP'],
  [/^(¥|jpy|yen|ienes?)$/i, 'JPY'],
  [/^(chf|francs?|francos?)$/i, 'CHF'],
  [/^(c\$|cad)$/i, 'CAD'],
  [/^(a\$|aud)$/i, 'AUD'],
  [/^(mx\$|mxn)$/i, 'MXN'],
  [/^(ar\$|ars)$/i, 'ARS'],
  [/^(pesos?)$/i, 'XXX'],
];
const currencyOf = (mark: string | undefined): string | null => {
  if (!mark) return null;
  for (const [pattern, code] of CURRENCY_OF) if (pattern.test(mark.trim())) return code;
  return null;
};
// Any mark of a currency other than dollars, anywhere in the text: "3,000 in euros" has one.
const FOREIGN_MARK =
  /(?:\b(?:r|c|a|mx|ar)\$|€|£|¥|\b(?:brl|eur|gbp|jpy|chf|cad|aud|mxn|ars|reais|euros?|pounds?|libras?|yen|ienes?|francs?|francos?|pesos?)\b)/iu;
/** Whether the text writes any currency other than dollars. */
export const foreignMarkIn = (text: string): boolean => FOREIGN_MARK.test(text);

const grouped = (text: string, mark: string) =>
  new RegExp(`^[1-9]\\d{0,2}(\\${mark}\\d{3})+$`).test(text);

/**
 * A number as a person writes one, in either language: "40,000" and "40.000" are forty thousand,
 * "1,500.50" and "1.500,50" fifteen hundred and a half, "3,5" three and a half. NaN when it cannot be
 * read one way only. The same reading as the web's form (`apps/web/features/goal/sheet.ts`).
 */
export function readNumber(text: string): number {
  const bare = text.trim();
  if (!/^\d[\d.,]*$/.test(bare)) return Number.NaN;
  const marks = [...new Set(bare.replace(/\d/g, ''))];
  if (marks.length === 0) return Number(bare);
  const number = (whole: string, cents = '') =>
    Number(`${whole.replace(/[.,]/g, '')}${cents ? `.${cents}` : ''}`);
  if (marks.length === 2) {
    const at = Math.max(bare.lastIndexOf('.'), bare.lastIndexOf(','));
    const [whole, cents] = [bare.slice(0, at), bare.slice(at + 1)];
    const thousands = bare[at] === '.' ? ',' : '.';
    return /^\d{1,2}$/.test(cents) && grouped(whole, thousands) ? number(whole, cents) : Number.NaN;
  }
  const mark = marks[0] as string;
  if (grouped(bare, mark)) return number(bare);
  const [whole = '', cents = '', ...more] = bare.split(mark);
  return more.length === 0 && /^\d+$/.test(whole) && /^\d{1,2}$/.test(cents)
    ? number(whole, cents)
    : Number.NaN;
}

const MULTIPLIER: [RegExp, number][] = [
  [/^(k|mil|thousand|grand)$/i, THOUSAND],
  [/^(m|mi|mm|million|milh[aã]o|milh[oõ]es)$/i, MILLION],
];
const multiplierOf = (word: string | undefined): number => {
  if (!word) return 1;
  for (const [pattern, factor] of MULTIPLIER) if (pattern.test(word)) return factor;
  return 1;
};

const UNIT_MONTH = /^(months?|meses|m[eê]s)$/i;
const UNIT_YEAR = /^(years?|yrs?|anos?)$/i;
const UNIT_TIME = /^(months?|meses|m[eê]s|years?|yrs?|anos?|weeks?|semanas?|days?|dias?)$/i;
const BY_WORD = /^(by|until|till|in|até|ate|em|before|antes de)$/i;

// One regular expression for a number with what may be written around it.
const NUMBER = new RegExp(
  [
    '(?<before>us\\$|u\\$s|r\\$|c\\$|a\\$|mx\\$|ar\\$|\\$|€|£|¥|usd|brl|eur|gbp|jpy|chf|cad|aud|mxn|ars)?',
    '\\s*',
    '(?<num>\\d[\\d.,]*\\d|\\d)',
    '(?:\\s*(?<mult>k|mil|thousand|grand|million|milh[aã]o|milh[oõ]es|mi|mm|m)(?![\\p{L}]))?',
    '(?:\\s*(?<pct>%|por cento|percent))?',
    '(?:\\s*(?:de\\s+)?(?<after>€|£|¥|usd|brl|eur|gbp|jpy|chf|cad|aud|mxn|ars|d[oó]lares|d[oó]lar|dollars?|bucks|reais|real|euros?|pounds?|libras?|yen|ienes?|francs?|francos?|pesos?|months?|meses|m[eê]s|years?|yrs?|anos?|weeks?|semanas?|days?|dias?)(?![\\p{L}]))?',
  ].join(''),
  'giu',
);

// What marks an amount as a rate a month: after it ("a month", "por mês") or before it ("monthly").
const PER_MONTH_AFTER =
  /^\s*(?:(?:a|per|each|every|\/)\s*(?:month|mo)\b|monthly|(?:por|ao|\/|cada)\s*m[eê]s|mensa)/iu;
const PER_MONTH_BEFORE = /(?:monthly|mensal|por m[eê]s)\s+(?:income|renda)?\s*(?:of|de)?\s*$/iu;
// What makes a duration a time frame: a word before it ("for", "over", "em", "por"), or one of these
// and "the next", "the coming", "próximos", "até" ("for the next 15 years", "em até 3 anos"), and no
// age after.
// A soft time frame is one too (EXPLICIT-MIX, Oct 6): "I don't have a term, but I would say 5 years",
// "about 5 years", "uns 5 anos". It is a time frame with no glide: the glide stays opt-in.
const TIME_FRAME_BEFORE =
  /(?:^|[\s,(])(?:for|over|in|within|during|after|next|coming|em|por|durante|dentro de|daqui a|depois de|pr[oó]ximos?|em at[eé]|(?:for|over|within|invest\p{L}*)\s+up to|(?:por|durante|investir)\s+at[eé]|(?:i'?d|i would|would|let'?s)\s+say|say|about|around|roughly|approximately|maybe|perhaps|diria|digamos|uns|umas|cerca de|aproximadamente|talvez)\s*$/iu;
const AGE_AFTER = /^\s*(?:old|of age|de idade)\b/iu;
const inTimeFrame = (text: string, at: number, end: number) =>
  TIME_FRAME_BEFORE.test(text.slice(0, at)) && !AGE_AFTER.test(text.slice(end));

// A time to get the money out, not a date for the goal (gate GLIDE-OPT-IN, Oct 6): "can take up to 3
// months to get out", "I may need it in 3 months", "posso precisar em 3 meses", "resgatar em até 3
// meses". Read in the words just before and just after the duration.
const EXIT_BEFORE =
  /(?:may|might|could|can)\s+need\b[^.;!?]{0,25}$|\b(?:take|takes|wait)\s+(?:up to|at most|no more than)?\s*$|(?:posso|pode ser que eu|talvez eu?)\s+precis\p{L}*[^.;!?]{0,25}$|(?:sacar|resgatar|tirar|retirar)\p{L}*[^.;!?]{0,15}$/iu;
const EXIT_AFTER =
  /^\s*(?:\S+\s+){0,2}?(?:to\s+(?:get\s+(?:it\s+|the money\s+)?out|exit|withdraw|cash out|sell|sell out|take (?:it )?out)|para\s+(?:sair|sacar|resgatar|tirar|retirar|vender))\b/iu;
const exitAround = (text: string, at: number, end: number) =>
  EXIT_BEFORE.test(text.slice(0, at)) || EXIT_AFTER.test(text.slice(end));

/** Every number in the text, read with its currency and what it counts. */
export function mentionsIn(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const g = m.groups ?? {};
    const base = readNumber(g.num ?? '');
    if (!Number.isFinite(base)) continue;
    const value = base * multiplierOf(g.mult);
    const at = m.index ?? 0;
    const end = at + m[0].length;
    const before = text.slice(0, at).trimEnd();
    const lastWord = /(\S+(?:\s+de)?)$/.exec(before)?.[1] ?? '';
    const kind: Mention['kind'] = g.pct
      ? 'percent'
      : g.after && UNIT_TIME.test(g.after)
        ? 'duration'
        : !g.before && !g.mult && /^(19|20)\d\d$/.test(g.num ?? '') && BY_WORD.test(lastWord)
          ? 'year'
          : 'amount';
    const currency = kind === 'amount' ? (currencyOf(g.before) ?? currencyOf(g.after)) : null;
    const perMonth =
      kind === 'amount' &&
      (PER_MONTH_AFTER.test(text.slice(end)) || PER_MONTH_BEFORE.test(text.slice(0, at)));
    const timeFrame = kind === 'year' || (kind === 'duration' && inTimeFrame(text, at, end));
    out.push({ value, currency, kind, perMonth, timeFrame, text: m[0].trim(), at, end });
  }
  return out;
}

const close = (a: number, b: number) => Math.abs(a - b) < 1 / 100;

/** The currencies the text writes beside an amount. */
export function currenciesIn(text: string): string[] {
  return [
    ...new Set(
      mentionsIn(text).flatMap((m) => (m.kind === 'amount' && m.currency ? [m.currency] : [])),
    ),
  ].sort();
}

/**
 * Whether `value` is written in the text in its role, and in dollars. The role binds an amount to its
 * place: `income` is a rate a month ("$250 a month"), `amount` is the sum put in, never a rate, so
 * the two cannot be swapped. "R$ 3.000,00", "3 mil", "$3k" and "3,000" each hold 3,000; only the last
 * three hold it in dollars, and a bare "3,000" counts as dollars only when the text writes no other
 * currency anywhere ("3,000 in euros" does). An amount in a currency that is not dollars never
 * passes as dollars. `wrong_role`: the figure is written, in the other role.
 */
export function amountInText(
  text: string,
  value: number,
  role: 'amount' | 'income' = 'amount',
): 'dollars' | 'other_currency' | 'wrong_role' | 'absent' {
  const all = mentionsIn(text).filter((m) => m.kind === 'amount' && close(m.value, value));
  const found = all.filter((m) => m.perMonth === (role === 'income'));
  if (found.some((m) => m.currency === 'USD')) return 'dollars';
  if (found.some((m) => m.currency === null) && !foreignMarkIn(text)) return 'dollars';
  if (found.length > 0) return 'other_currency';
  return all.length > 0 ? 'wrong_role' : 'absent';
}

// Number words up to twelve, by their place in the list.
const WORDS_EN = 'zero one two three four five six seven eight nine ten eleven twelve'.split(' ');
const WORDS_PT = 'zero um dois três quatro cinco seis sete oito nove dez onze doze'.split(' ');
const FEMININE_PT: Record<string, string> = { uma: 'um', duas: 'dois' };
const wordNumber = (word: string): number => {
  const w = word.toLowerCase();
  if (w === 'a' || w === 'an') return 1;
  const en = WORDS_EN.indexOf(w);
  if (en >= 0) return en;
  const pt = WORDS_PT.indexOf(FEMININE_PT[w] ?? w.replace('tres', 'três'));
  return pt >= 0 ? pt : Number.NaN;
};
const WORD_DURATION =
  /\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\s+(months?|meses|m[eê]s|years?|anos?)\b/giu;
const HALF_YEAR = /\b(half a year|six months|meio ano|seis meses)\b/giu;

const monthsBetween = (fromMonth: string, year: number): number => {
  const [y, m] = fromMonth.split('-').map(Number) as [number, number];
  return (year - y) * 12 - (m - 1);
};

/**
 * The time frames the text writes, in months: "18 months", "10 anos", "for five years", "half a year",
 * "by 2031" (January of that year, counted from `nowMonth`, as the rules parser counts).
 */
export function horizonsIn(text: string, nowMonth: string): number[] {
  const found = new Set<number>();
  for (const m of mentionsIn(text)) {
    if (!m.timeFrame || exitAround(text, m.at, m.end)) continue;
    if (m.kind === 'duration') {
      const unit = /(\p{L}+)$/u.exec(m.text)?.[1] ?? '';
      if (UNIT_MONTH.test(unit)) found.add(m.value);
      if (UNIT_YEAR.test(unit)) found.add(m.value * 12);
    }
    if (m.kind === 'year') {
      const months = monthsBetween(nowMonth, m.value);
      if (months > 0) found.add(months);
    }
  }
  const half = [...text.matchAll(HALF_YEAR)];
  let rest = text;
  for (const m of half) rest = rest.replace(m[0], ' '.repeat(m[0].length));
  for (const m of rest.matchAll(WORD_DURATION)) {
    const n = wordNumber(m[1] ?? '');
    if (!Number.isFinite(n)) continue;
    // "$300 a month" is a rate, not a time frame; "a year" alone is read as one.
    if (/^an?$/i.test(m[1] ?? '') && !UNIT_YEAR.test(m[2] ?? '')) continue;
    const at = m.index ?? 0;
    if (!inTimeFrame(text, at, at + m[0].length) || exitAround(text, at, at + m[0].length))
      continue;
    found.add(UNIT_YEAR.test(m[2] ?? '') ? n * 12 : n);
  }
  for (const m of half) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    if (inTimeFrame(text, at, end) && !exitAround(text, at, end)) found.add(12 / 2);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The times to get the money out the text writes, in months, with the words around each: "can take up
 * to 3 months to get out", "I may need it in 3 months". These are a limit on how liquid the plan is,
 * never its time frame: `horizonsIn` leaves them out (gate GLIDE-OPT-IN, Oct 6).
 */
export function exitTimesIn(text: string): { months: number; words: string }[] {
  const out: { months: number; words: string }[] = [];
  for (const m of mentionsIn(text)) {
    if (m.kind !== 'duration' || !exitAround(text, m.at, m.end)) continue;
    const unit = /(\p{L}+)$/u.exec(m.text)?.[1] ?? '';
    const months = UNIT_MONTH.test(unit) ? m.value : UNIT_YEAR.test(unit) ? m.value * 12 : null;
    if (months !== null) out.push({ months, words: phraseAround(text, m.at, m.end) });
  }
  for (const m of text.matchAll(WORD_DURATION)) {
    const n = wordNumber(m[1] ?? '');
    const at = m.index ?? 0;
    const end = at + m[0].length;
    if (!Number.isFinite(n) || /^an?$/i.test(m[1] ?? '') || !exitAround(text, at, end)) continue;
    out.push({
      months: UNIT_YEAR.test(m[2] ?? '') ? n * 12 : n,
      words: phraseAround(text, at, end),
    });
  }
  return out;
}

/** The clause a figure is written in, trimmed to a few words either side: what the person said. */
function phraseAround(text: string, at: number, end: number): string {
  const before =
    text
      .slice(0, at)
      .split(/[.;!?,]/)
      .at(-1) ?? '';
  const after = text.slice(end).split(/[.;!?,]/)[0] ?? '';
  // A few words either side, as the regular expressions count them.
  const left = /(?:\S+\s+){0,3}\S+$/u.exec(before.trim())?.[0] ?? '';
  const right = /^\S+(?:\s+\S+){0,3}/u.exec(after.trim())?.[0] ?? '';
  return [left, text.slice(at, end).trim(), right].filter(Boolean).join(' ');
}

// No date for the goal (gate GLIDE-OPT-IN, Oct 6): "no hard cap", "no date", "open-ended", "sem prazo".
const OPEN_ENDED =
  /(?<![\p{L}])(?:no (?:hard )?(?:cap|deadline|date|end date|time limit|horizon|time frame|timeframe|rush)|(?:do not|don't|dont|do n't) have (?:a |any )?(?:hard )?(?:cap|deadline|date|end date|time limit|horizon|time frame|timeframe|term)|open[- ]ended|indefinitely|no particular (?:date|time)|sem (?:prazo|data|pressa|horizonte)|n[aã]o tenho (?:um )?(?:prazo|data|horizonte)|prazo indefinido|por tempo indeterminado)(?![\p{L}])/iu;
/** The words that say the goal has no date, as written; null when the text has none. */
export const openEndedIn = (text: string): string | null => OPEN_ENDED.exec(text)?.[0] ?? null;

// The glide is opt-in (gate GLIDE-OPT-IN, Oct 6): on only when the text asks to take less risk as time
// passes, or names a date by which the money is needed ("I need it by 2031", "preciso em 3 anos").
const DERISK =
  /(?<![\p{L}])(?:de-?risk\p{L}*|glide|less risk (?:as|over) time|safer as (?:the date|it|time)\p{L}* (?:nears|gets closer|approaches|goes on)|reduce (?:the )?risk over time|(?:ir )?reduzi\p{L}* (?:o )?risco (?:com o tempo|ao longo do tempo)|menos risco (?:com o tempo|perto da data))(?![\p{L}])/iu;
const NEED_BY =
  /(?<![\p{L}])(?<!(?:may|might|could|can)\s)(?:need|needs|needed)\s+(?:(?:it|this|that|the|my|them)\s+)?(?:(?:money|cash|amount|sum)\s+)?(?:by|in|within|before)\s+\S+|(?<!(?:posso|talvez)\s)preciso\s+(?:(?:dele|disso|do dinheiro|desse dinheiro|deste dinheiro)\s+)?(?:em|at[eé]|antes de)\s+\S+/iu;
/** Whether the text asks for the glide, or names a date by which the money is needed. */
export function glideAskedIn(text: string, nowMonth: string): boolean {
  if (DERISK.test(text)) return true;
  if (mentionsIn(text).some((m) => m.kind === 'year' && m.timeFrame)) return true;
  const need = NEED_BY.exec(text);
  return need !== null && horizonsIn(text.slice(need.index), nowMonth).length > 0;
}

// The person's split of the plan in so many words (gate SLEEVES): "70-30", "70/30", "70% and 30%".
const PAIR = /(?<!\d)(\d{1,2})\s*(?:%\s*)?(?:-|\/|x|e|and|to)\s*(\d{1,2})\s*%?(?!\d)/giu;
// What follows a percent that is no share of the money: a fall, a loss, a yield, a rate.
const NOT_A_SHARE =
  /^\s*(?:\p{L}+\s+){0,1}?(?:fall|drop|drops|loss|losses|down|dip|crash|yield|return|returns|apy|apr|interest|rate|a year|per year|annual|queda|perda|rendimento|retorno|juros|taxa|ao ano|por ano)(?![\p{L}])/iu;
const HALF =
  /(?<![\p{L}])(?:the other half|other half|a outra metade|outra metade|half|metade)(?![\p{L}])/iu;
/**
 * The shares the text writes, as percents of the whole: pairs that add up to a whole ("70-30"), and
 * every percent written. `mismatch` is a percent written beside "the other half" that, with the half,
 * is not the whole ("70% ... the other half" is 120%): the split is asked, never guessed.
 */
export function splitIn(text: string): {
  pairs: [number, number][];
  percents: number[];
  /** Whether "half" or "metade" is written. */
  half: boolean;
  /** The percents written as shares of the money: not a fall, a loss or a yield ("a 20% fall"). */
  ofMoney: number[];
  mismatch: { pct: number } | null;
} {
  const whole = 100;
  const pairs: [number, number][] = [];
  for (const m of text.matchAll(PAIR)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a + b === whole) pairs.push([a, b]);
  }
  const percentMentions = mentionsIn(text).filter((m) => m.kind === 'percent');
  const percents = percentMentions.map((m) => m.value);
  const ofMoney = percentMentions
    .filter((m) => !NOT_A_SHARE.test(text.slice(m.end)))
    .map((m) => m.value);
  const half = whole / 2;
  const halfWritten = HALF.test(text);
  const off = halfWritten ? percents.find((p) => p !== half && p < whole) : undefined;
  return {
    pairs,
    percents,
    ofMoney,
    half: halfWritten,
    mismatch: off !== undefined ? { pct: off } : null,
  };
}

// "Highest yield possible" for a part of the plan: the max-yield objective (gate MAX-YIELD-SLEEVE, Oct
// 6), not built yet. The intake flags it so what reads the answer can say what was done instead.
const MAX_YIELD =
  /(?<![\p{L}])(?:highest|maximum|max|most|best)\s+(?:possible\s+)?(?:yield|return|returns|rate)|(?:maior|m[aá]ximo)\s+(?:rendimento|retorno|rentabilidade)|rendimento m[aá]ximo(?![\p{L}])/iu;
/** Whether the text asks for the highest yield possible. */
export const maxYieldAskedIn = (text: string): boolean => MAX_YIELD.test(text);

// A refusal written in the text: "no stocks", "sem ações", "without crypto", "no credit".
const NEG = String.raw`(?:\bno\b|\bnot?\s+(?:any|in)\b|\bwithout\b|\bzero\b|\bsem\b|\bnada de\b|\bn[aã]o\s+quero\b|\bfora\b|\bexclud\w*\b|\bavoid\w*\b|\bevit\w*\b)`;
const near = (things: string) => new RegExp(`${NEG}\\s+(?:\\p{L}+\\s+){0,2}?${things}`, 'iu');
const REFUSALS: [HoldableClass, RegExp][] = [
  ['stock', near(String.raw`(?:stocks?|shares|equit(?:y|ies)|a[cç][oõ]es|a[cç][aã]o)\b`)],
  ['crypto', near(String.raw`(?:crypto\w*|cripto\w*|bitcoin|btc)\b`)],
  ['gold', near(String.raw`(?:gold|ouro)\b`)],
  ['etf', near(String.raw`(?:etfs?|funds|fundos)\b`)],
  ['commodity', near(String.raw`(?:commodit(?:y|ies))\b`)],
];
const NO_CREDIT = near(
  String.raw`(?:credit|lending|loans?|borrowers|cr[eé]dito|empr[eé]stimos?|tomadores)\b`,
);

/** The refusals the text writes: the classes it rules out, and whether it rules out credit. */
export function refusalsIn(text: string): { classes: HoldableClass[]; noCredit: boolean } {
  return {
    classes: REFUSALS.filter(([, pattern]) => pattern.test(text)).map(([cls]) => cls),
    noCredit: NO_CREDIT.test(text),
  };
}

// Words that say a goal or a risk. The model's reading of either is taken only where the text holds
// one of its words; otherwise it is a suggestion the person confirms.
// Whole words only: "highly" is not "high", "lowest" not "low". A stem ends in `\p{L}*`.
const cue = (words: string) => new RegExp(`(?<![\\p{L}])(?:${words})(?![\\p{L}])`, 'iu');
const GOAL_CUES: Record<'grow' | 'income' | 'protect', RegExp> = {
  grow: cue(
    String.raw`grow|grows|growing|growth|crescer|crescimento|multiplic\p{L}*|invest|investing|investir|aplicar|put\b.*\bto work|build (?:up|wealth)|rentabiliz\p{L}*`,
  ),
  income: cue(
    String.raw`income|renda|dividends?|monthly|mensal|mensais|mensalmente|a month|per month|por m[eê]s|ao m[eê]s|pay me|me pague`,
  ),
  protect: cue(
    String.raw`protect|protecting|protection|proteger|prote[cç][aã]o|safe|safely|safety|seguro|segura|seguran[cç]a|keep|guard|guardar|preserve|preservar|reserve|reserva|park`,
  ),
};
const RISK_CUES: Record<'low' | 'medium' | 'high', RegExp> = {
  low: cue(
    String.raw`low|conservative|conservador|conservadora|conservadoramente|cautious|cautelos[oa]|baix[oa]|safe|safely|seguro|segura|seguran[cç]a|no stocks|sem a[cç][oõ]es|little risk|pouco risco`,
  ),
  medium: cue(String.raw`medium|moderate|moderately|moderad[oa]|m[eé]dio|balanced|equilibrad[oa]`),
  high: cue(
    String.raw`high|aggressive|aggressively|agressiv[oa]|alt[oa]|bold|ousad[oa]|a lot of risk|muito risco`,
  ),
};
/** The goals the text has a word for. */
export const goalCuesIn = (text: string) =>
  (Object.keys(GOAL_CUES) as (keyof typeof GOAL_CUES)[]).filter((g) => GOAL_CUES[g].test(text));
// Words that say a risk loosely (Oct 6): read as that risk, and said back as an assumption ("I took
// 'go crazy' as high risk"), never taken in silence.
const LOOSE_RISK_CUES: Record<'low' | 'medium' | 'high', RegExp | null> = {
  low: cue(
    String.raw`as safe as possible|t[aã]o seguro quanto poss[ií]vel|o mais seguro poss[ií]vel`,
  ),
  medium: null,
  // Phrases, never a bare word: "crazy" alone is "I'm not crazy about crypto" as often as not.
  high: cue(
    String.raw`go crazy|going crazy|go wild|yolo|all in|risk it all|highest (?:possible )?(?:yield|return)|as much risk as possible|maximum risk|max risk|arriscar tudo|pode arriscar|chutar o balde|risco m[aá]ximo`,
  ),
};
// A loose cue under a negation is no cue: "don't go crazy", "não pode arriscar".
// The window stops at a comma or a sentence break: "no stocks, go crazy" still goes crazy.
const LOOSE_NEGATED =
  /(?<![\p{L}])(?:not|no|never|nothing|don'?t|do not|doesn'?t|won'?t|can'?t|cannot|n[aã]o|nunca|nada|sem)(?:\s+[^\s,;.!?]+){0,2}\s*$/iu;
/** The loose cue's matches that are not under a negation, as written. */
const looseMatches = (pattern: RegExp, text: string): string[] =>
  [...text.matchAll(new RegExp(pattern.source, 'giu'))]
    .filter((m) => !LOOSE_NEGATED.test(text.slice(0, m.index ?? 0)))
    .map((m) => m[0]);
/** The risks the text has a word for, plain or loose. */
export const riskCuesIn = (text: string) =>
  (Object.keys(RISK_CUES) as (keyof typeof RISK_CUES)[]).filter((r) => {
    const loose = LOOSE_RISK_CUES[r];
    return RISK_CUES[r].test(text) || (loose !== null && looseMatches(loose, text).length > 0);
  });
/**
 * The loose words a risk was read from, as written, when the text has no plain word for it: "go
 * crazy" for high. Null when a plain word says it ("high risk", "risco alto") or none does.
 */
export function looseRiskWordsIn(text: string, risk: 'low' | 'medium' | 'high'): string | null {
  const loose = LOOSE_RISK_CUES[risk];
  if (RISK_CUES[risk].test(text) || !loose) return null;
  // The last one written: on a later turn, the person's own answer.
  return looseMatches(loose, text).at(-1) ?? null;
}

// ---------------------------------------------------------------------------------------------------
// What the person wants held (gate EXPLICIT-MIX, Rodrigo, Oct 6): "all of it in stocks", "70% stocks
// and 30% cash", "only credit", "tudo em ações". English and Portuguese only: a mix written in another
// language gives nothing here, so the model's reading of it is dropped and nothing is taken in silence.

/** The parts of a mix, as `PersonalMix` holds them (basis points of the whole plan). */
export type MixRead = {
  growthBps: number;
  dollarYieldBps: number;
  goldBps: number;
  cashBps: number;
  creditBps?: number;
};
type MixPart = 'growth' | 'dollarYield' | 'gold' | 'cash' | 'credit';

// The words for each part. Credit is dollar yield that lends or trades a spread ("only high yield").
const MIX_CLASSES: [MixPart, string][] = [
  [
    'growth',
    String.raw`stocks?|equit(?:y|ies)|shares|a[cç][oõ]es|a[cç][aã]o|crypto\p{L}*|cripto\p{L}*|bitcoin`,
  ],
  ['credit', 'credit|cr[eé]dito|high[- ]yield'],
  [
    'dollarYield',
    'dollar yield|rendimento em d[oó]lar|treasur(?:y|ies)|t-bills|bonds|t[ií]tulos do tesouro|renda fixa',
  ],
  ['gold', 'gold|ouro'],
  ['cash', 'cash|caixa'],
];
const CLASS_ANY = MIX_CLASSES.map(([, w]) => w).join('|');
const partOf = (word: string): MixPart | null => {
  for (const [part, words] of MIX_CLASSES)
    if (new RegExp(`^(?:${words})$`, 'iu').test(word)) return part;
  return null;
};
// "All of it in stocks", "everything in gold", "only credit", "just stocks", "100% stocks", "tudo em
// ações", "só crédito", "somente ouro". The class word is captured.
const ALL_IN = new RegExp(
  String.raw`(?<![\p{L}])(?:(?:all|everything)(?:\s+of\s+(?:it|my money|the money|this|that))?(?:\s+(?:of\s+)?(?:my|the)\s+money)?\s+(?:in|into)\s+(?:the\s+)?|(?:only|just|purely|exclusively|entirely)\s+(?:in\s+)?|100\s*%\s*(?:(?:of\s+it\s+)?in\s+|em\s+|de\s+)?|tudo\s+(?:em|no|na|nos|nas)\s+|(?:s[oó]|somente|apenas|exclusivamente)\s+(?:em\s+|no\s+|na\s+|nos\s+|nas\s+)?)(?<cls>${CLASS_ANY})(?![\p{L}])`,
  'giu',
);
// "70% stocks", "70% in stocks", "30% em caixa", "30% de ouro".
const PCT_IN = new RegExp(
  String.raw`(?<![\d.,])(?<pct>\d{1,3})\s*%\s*(?:(?:of\s+it|of\s+the\s+money|do\s+dinheiro)\s+)?(?:(?:in|into|em|de|no|na|nos|nas)\s+)?(?:the\s+)?(?<cls>${CLASS_ANY})(?![\p{L}])`,
  'giu',
);
// A mix under a negation is no mix: "I don't want all of it in stocks", "não quero tudo em ações".
const MIX_NEGATED =
  /(?<![\p{L}])(?:not|no|never|don'?t|do not|doesn'?t|won'?t|n[aã]o|nunca|nem)(?:\s+[^\s,;.!?]+){0,3}\s*$/iu;
// "Only stocks and gold" names two parts with no shares: no mix is read, the person is asked.
const AND_ANOTHER = new RegExp(
  String.raw`^\s*(?:,|and|or|e|ou|&|\+)\s*(?:(?:in|em|no|na)\s+)?(?<cls>${CLASS_ANY})(?![\p{L}])`,
  'iu',
);

const WHOLE_BPS = 10_000;
const BPS_PER_PCT = 100;

function mixOf(parts: [MixPart, number][]): MixRead {
  const m: MixRead = { growthBps: 0, dollarYieldBps: 0, goldBps: 0, cashBps: 0 };
  let credit = 0;
  for (const [part, bps] of parts) {
    if (part === 'credit') {
      m.dollarYieldBps += bps;
      credit += bps;
    } else m[`${part}Bps`] += bps;
  }
  if (credit > 0) m.creditBps = credit;
  return m;
}

/**
 * The mix the text writes, with the words it is written in; null when it writes none, or writes one
 * this file cannot read one way only (shares that are not the whole, two parts with no shares, a
 * percent of the money that is not in a part). Every share is written: nothing is filled in.
 */
export function mixIn(text: string): { mix: MixRead; words: string } | null {
  const notNegated = (m: RegExpMatchArray) => !MIX_NEGATED.test(text.slice(0, m.index ?? 0));
  // Shares written as percents of named parts.
  const pcts = [...text.matchAll(PCT_IN)].filter(notNegated);
  if (pcts.length > 0) {
    const parts = pcts.flatMap((m): [MixPart, number][] => {
      const part = partOf(m.groups?.cls ?? '');
      return part ? [[part, Number(m.groups?.pct) * BPS_PER_PCT]] : [];
    });
    const total = parts.reduce((n, [, bps]) => n + bps, 0);
    // Every percent of the money written is one of these shares: "70% stocks, and keep 50% safe" is
    // not read.
    const written = splitIn(text).ofMoney.length;
    if (parts.length === pcts.length && total === WHOLE_BPS && written === pcts.length)
      return {
        mix: mixOf(parts),
        words: phraseOf(text, pcts[0]?.index ?? 0, endOf(pcts.at(-1))),
      };
    return null;
  }
  // All of it in one part.
  for (const m of [...text.matchAll(ALL_IN)].filter(notNegated)) {
    const part = partOf(m.groups?.cls ?? '');
    if (!part) continue;
    const at = m.index ?? 0;
    const end = at + m[0].length;
    const next = AND_ANOTHER.exec(text.slice(end));
    const other = next ? partOf(next.groups?.cls ?? '') : null;
    if (other !== null && other !== part) return null;
    return { mix: mixOf([[part, WHOLE_BPS]]), words: text.slice(at, end).trim() };
  }
  return null;
}
const endOf = (m: RegExpMatchArray | undefined) => (m ? (m.index ?? 0) + m[0].length : 0);
const phraseOf = (text: string, at: number, end: number) => text.slice(at, end).trim();

// A market or a trend the person names (gate EXPLICIT-MIX): read to a shared portfolio on the shelf,
// by its slug, or to a theme that has none yet. English and Portuguese words only.
export type Market = 'big_tech' | 'us_market' | 'ai';
const MARKETS: [Market, RegExp][] = [
  [
    'big_tech',
    /(?<![\p{L}])(?:big[- ]?techs?|magnificent (?:7|seven)|mag(?:nificent)? ?7|(?:us|american) tech giants|tech giants|grandes? (?:empresas )?de tecnologia|gigantes (?:da|de) tecnologia)(?![\p{L}])/iu,
  ],
  [
    'us_market',
    /(?<![\p{L}])(?:s&p(?: ?500)?|s and p(?: 500)?|sp ?500|(?:the )?(?:us|u\.s\.|american) (?:stock )?market|(?:us|u\.s\.|american) stocks|bolsa americana|mercado americano|a[cç][oõ]es americanas)(?![\p{L}])/iu,
  ],
  // "AI" and "IA" only in capitals: "ai" is a word in Portuguese ("ai, não sei").
  [
    'ai',
    /(?<![\p{L}])(?:AI|IA|A\.I\.|artificial intelligence|intelig[eê]ncia artificial)(?![\p{L}])/u,
  ],
];
/** The shared portfolio a market reads to; null for a market that has none on any shelf yet. */
export const MARKET_SLUG: Record<Market, string | null> = {
  big_tech: 'the-seven',
  us_market: 'the-500',
  // TODO(engine/themes): "AI" is a theme sleeve, `{ kind: 'theme', theme: 'ai' }`, once theme sleeves
  // are built. Until then no portfolio is named for it: no slug is made up.
  ai: null,
};
/** The markets the text names, with the words, in the order of the list. */
export function marketsIn(text: string): { market: Market; words: string; at: number }[] {
  return MARKETS.flatMap(([market, pattern]) => {
    const m = pattern.exec(text);
    return m ? [{ market, words: m[0], at: m.index }] : [];
  });
}

/**
 * The nearest shared portfolios to a market, in order (gate EXPLICIT-MIX): offered when the market
 * itself has none on the person's shelf, so "no list" is never said without an offer.
 */
export const MARKET_NEAREST: Record<Market, readonly string[]> = {
  big_tech: ['the-seven', 'the-500'],
  ai: ['the-seven', 'the-500'],
  us_market: ['the-500', 'the-seven'],
};

/**
 * The sentence written up to `at`: from the last sentence break or line break. A mark inside a
 * number is no break ("US$ 2.000", "$1,500.50").
 */
function sentenceBefore(text: string, at: number): string {
  return (
    text
      .slice(0, at)
      .split(/[.;!?](?=\s)|\n/)
      .at(-1) ?? ''
  );
}

// How much of the money goes to a market, in the words just before it (gate EXPLICIT-MIX): "invest in
// big tech", "all of it in AI", "put it in US stocks" is the whole; "put $1,000 in AI" is that sum.
// "I like AI", "I'm interested in big tech" say no share: it is asked.
const INTO = String.raw`(?:in|into|on|em|no|na|nos|nas)\s+(?:the\s+|a\s+|o\s+|os\s+|as\s+)?`;
const PUT = String.raw`(?:invest\p{L}*|put|place|allocate|aplicar|investir|colocar|botar)`;
const WHOLE_BEFORE = new RegExp(
  String.raw`(?<![\p{L}])(?:${PUT}(?:\s+(?:it|all|all of it|everything|my money|the money|this|that|tudo|isso|o dinheiro|meu dinheiro))?|(?:all|everything)(?:\s+of\s+(?:it|my money|the money))?|tudo)\s+${INTO}$`,
  'iu',
);
// A sum after the verb, or a later sum of the same sentence: "put $500 in AI and $300 in chips". The
// sum as a person writes it, with a space after its mark and its words after it: "US$ 2.000", "2 mil
// dólares".
const SUM_LEAD = String.raw`(?:${PUT}\s+|${PUT}(?![\p{L}])[^\n]*?(?:,\s*(?:(?:and|plus|e|mais)\s+)?|\s(?:and|plus|e|mais)\s+))`;
const SUM = String.raw`(?:(?:us\$|u\$s|usd|\$)\s+)?\S+(?:\s+(?:k|mil|thousand))?(?:\s+(?:de\s+)?(?:dollars|d[oó]lares|bucks|usd))?`;
const AMOUNT_BEFORE = new RegExp(
  String.raw`(?<![\p{L}])${SUM_LEAD}(?:the\s+|my\s+|os\s+|meus\s+)?(?<amt>${SUM})\s+${INTO}$`,
  'iu',
);
/** The share of the money the text gives a market written at `at`: the whole, a sum, or none said. */
export function marketShareIn(
  text: string,
  at: number,
): { kind: 'whole' } | { kind: 'amount'; value: number } | null {
  // The sentence the market is written in.
  const before = sentenceBefore(text, at);
  const amount = AMOUNT_BEFORE.exec(before);
  if (amount) {
    const m = mentionsIn(amount.groups?.amt ?? '').find((x) => x.kind === 'amount' && !x.perMonth);
    if (m && (m.currency === null || m.currency === 'USD'))
      return { kind: 'amount', value: m.value };
  }
  return WHOLE_BEFORE.test(before) ? { kind: 'whole' } : null;
}

// A text in a language other than English and Portuguese (gate EXPLICIT-MIX: any language is read,
// and the read-back is in English). Words that are neither, common in a goal in Spanish or French.
const OTHER_LANGUAGE =
  /(?<![\p{L}'])(?:tengo|quiero|quisiera|años|acciones|dinero|ahorros|invertir|también|j'ai|je|veux|voudrais|ans|argent|aussi|épargne|placer|tout)(?![\p{L}])/iu;
/** Whether the text reads as written in another language than English or Portuguese. */
export const otherLanguageIn = (text: string): boolean => OTHER_LANGUAGE.test(text);
