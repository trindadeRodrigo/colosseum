import type { MarketFilter } from './market-filter';
import { INTAKE_LIMITS } from './params';
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
  /**
   * An amount written as money: with a currency mark or word beside it, or in thousands ("$5,000",
   * "3 mil", "5k"). A bare number ("35") is not.
   */
  money: boolean;
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
// A duration that says what it is the length of ("After 5 years of marriage", "in 2 years of day
// trading", "depois de 10 anos de empresa") measures that thing, not the plan (the third review,
// Oct 7): it is no time frame, whatever word leads into it.
const SPAN_OF_ANOTHER = /^[^\S\n]+(?:of|de|do|da)[^\S\n]+\p{L}/iu;
const inTimeFrame = (text: string, at: number, end: number) =>
  TIME_FRAME_BEFORE.test(tailBefore(text, at)) &&
  !AGE_AFTER.test(text.slice(end)) &&
  !SPAN_OF_ANOTHER.test(text.slice(end));

// A time to get the money out, not a date for the goal (gate GLIDE-OPT-IN, Oct 6): "can take up to 3
// months to get out", "I may need it in 3 months", "posso precisar em 3 meses", "resgatar em até 3
// meses". Read in the words just before and just after the duration.
const EXIT_BEFORE =
  /(?:may|might|could|can)\s+need\b[^.;!?]{0,25}$|\b(?:take|takes|wait)\s+(?:up to|at most|no more than)?\s*$|(?:posso|pode ser que eu|talvez eu?)\s+precis\p{L}*[^.;!?]{0,25}$|(?:sacar|resgatar|tirar|retirar)\p{L}*[^.;!?]{0,15}$/iu;
const EXIT_AFTER =
  /^\s*(?:\S+\s+){0,2}?(?:to\s+(?:get\s+(?:it\s+|the money\s+)?out|exit|withdraw|cash out|sell|sell out|take (?:it )?out)|para\s+(?:sair|sacar|resgatar|tirar|retirar|vender))\b/iu;
const exitAround = (text: string, at: number, end: number) =>
  EXIT_BEFORE.test(text.slice(0, at)) || EXIT_AFTER.test(text.slice(end));

/** Whether a character, by its code, is one a pattern's `\s` matches. */
const isSpace = (code: number): boolean => SPACES.has(code);
const SPACES = new Set(
  Array.from(
    '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff',
    (c) => c.charCodeAt(0),
  ),
);
// How many words back the patterns that end at a place read: each reads fewer.
const TAIL_WORDS = 12;
/**
 * The last words written before a place, from the start of a word: all that a pattern which ends at
 * the place can read, so a long text costs it no more than a short one.
 */
function tailBefore(text: string, at: number): string {
  const space = (i: number) => isSpace(text.charCodeAt(i));
  let from = at;
  for (let words = 0; from > 0 && words < TAIL_WORDS; words += 1) {
    while (from > 0 && space(from - 1)) from -= 1;
    while (from > 0 && !space(from - 1)) from -= 1;
  }
  return text.slice(from, at);
}

/**
 * The last word written before a place, with a Portuguese "de" after it ("até o fim de"): what leads
 * into a year. Read backwards from the place, so a long text costs no more than a short one.
 */
function lastWordBefore(text: string, at: number): string {
  const space = (i: number) => isSpace(text.charCodeAt(i));
  let end = at;
  while (end > 0 && space(end - 1)) end -= 1;
  const wordFrom = (to: number) => {
    let from = to;
    while (from > 0 && !space(from - 1)) from -= 1;
    return from;
  };
  const start = wordFrom(end);
  if (text.slice(start, end) !== 'de') return text.slice(start, end);
  let gap = start;
  while (gap > 0 && space(gap - 1)) gap -= 1;
  return gap === start || gap === 0 ? 'de' : text.slice(wordFrom(gap), end);
}

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
    const lastWord = lastWordBefore(text, at);
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
      (PER_MONTH_AFTER.test(text.slice(end)) || PER_MONTH_BEFORE.test(tailBefore(text, at)));
    const timeFrame = kind === 'year' || (kind === 'duration' && inTimeFrame(text, at, end));
    const money = kind === 'amount' && (currency !== null || Boolean(g.mult));
    out.push({ value, currency, kind, perMonth, timeFrame, money, text: m[0].trim(), at, end });
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

// A number said of the person, not of the money: "I am 35", "I'm 40", "aged 62".
const AGE_BEFORE =
  /(?<![\p{L}])(?:(?:i|we)\s+(?:am|are)|i['’]m|we['’]re|aged?|age\s+of|turn(?:ed|ing)?)\s*$/iu;

/**
 * Whether `value` is written in the text in its role, and in dollars. The role binds an amount to its
 * place: `income` is a rate a month ("$250 a month"), `amount` is the sum put in, never a rate, so
 * the two cannot be swapped. "R$ 3.000,00", "3 mil", "$3k" and "3,000" each hold 3,000; only the last
 * three hold it in dollars, and a bare "3,000" counts as dollars only when the text writes no other
 * currency anywhere ("3,000 in euros" does). An amount in a currency that is not dollars never
 * passes as dollars. `wrong_role`: the figure is written, in the other role.
 *
 * A bare number is the sum put in only where it can be one (the review of Oct 7: "I am 35 and want
 * to grow $5,000" gave a plan of $35). `not_a_sum`: it is written, and it is said of the person
 * ("I am 35"), or the text writes another sum as money ("$5,000"), beside which a bare number is an
 * age, a count or a year.
 */
export function amountInText(
  text: string,
  value: number,
  role: 'amount' | 'income' = 'amount',
): 'dollars' | 'other_currency' | 'wrong_role' | 'not_a_sum' | 'absent' {
  const amounts = mentionsIn(text).filter((m) => m.kind === 'amount');
  const all = amounts.filter((m) => close(m.value, value));
  const found = all.filter((m) => m.perMonth === (role === 'income'));
  if (found.some((m) => m.currency === 'USD')) return 'dollars';
  // A rate a month is marked as one by its own words. The sum put in is a figure written as money,
  // or a bare number where the text writes no other sum as money and does not say it of the person.
  const sum = (m: Mention) =>
    role === 'income' ||
    m.money ||
    (!AGE_BEFORE.test(tailBefore(text, m.at)) && !amounts.some((x) => x.money && !x.perMonth));
  const sums = found.filter(sum);
  if (sums.some((m) => m.currency === null) && !foreignMarkIn(text)) return 'dollars';
  if (sums.length > 0) return 'other_currency';
  if (found.length > 0) return 'not_a_sum';
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
 * A time frame the text writes, in months, and how the person said it: in months, in years, or as a
 * date ("by 2031"). The read-back says it back the same way.
 */
export type TimeFrame = { months: number; said: 'months' | 'years' | 'date'; at: number };

/**
 * The time frames the text writes, in the order written: "18 months", "10 anos", "for five years",
 * "half a year", "by 2031" (January of that year, counted from `nowMonth`, as the rules parser counts).
 */
export function timeFramesIn(text: string, nowMonth: string): TimeFrame[] {
  const found: TimeFrame[] = [];
  for (const m of mentionsIn(text)) {
    if (!m.timeFrame || exitAround(text, m.at, m.end)) continue;
    if (m.kind === 'duration') {
      const unit = /(\p{L}+)$/u.exec(m.text)?.[1] ?? '';
      if (UNIT_MONTH.test(unit)) found.push({ months: m.value, said: 'months', at: m.at });
      if (UNIT_YEAR.test(unit)) found.push({ months: m.value * 12, said: 'years', at: m.at });
    }
    if (m.kind === 'year') {
      const months = monthsBetween(nowMonth, m.value);
      if (months > 0) found.push({ months, said: 'date', at: m.at });
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
    const years = UNIT_YEAR.test(m[2] ?? '');
    found.push({ months: years ? n * 12 : n, said: years ? 'years' : 'months', at });
  }
  for (const m of half) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    // Half a year is said back in months: "6 months".
    if (inTimeFrame(text, at, end) && !exitAround(text, at, end))
      found.push({ months: 12 / 2, said: 'months', at });
  }
  return found.sort((a, b) => a.at - b.at);
}

/** The time frames the text writes, in months, each once, the shortest first. */
export function horizonsIn(text: string, nowMonth: string): number[] {
  return [...new Set(timeFramesIn(text, nowMonth).map((t) => t.months))].sort((a, b) => a - b);
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
/** The same words, wherever a clause writes them. */
const OPEN_ENDED_ANYWHERE = new RegExp(OPEN_ENDED.source, 'giu');
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
  // A date the money is needed by is a date to come: "I got burned by big tech in 2022" names none.
  if (
    mentionsIn(text).some(
      (m) => m.kind === 'year' && m.timeFrame && monthsBetween(nowMonth, m.value) > 0,
    )
  )
    return true;
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
 * every percent written. `mismatch` is a share written beside "the other half" that, with the half,
 * is not the whole ("70% ... the other half" is 120%): the split is asked, never guessed.
 */
export function splitIn(text: string): {
  pairs: [number, number][];
  /** Every percent written, whatever it is a percent of. */
  percents: number[];
  /** Whether "half" or "metade" is written. */
  half: boolean;
  /**
   * The percents written as shares of the money, in their plain forms (`plainSharesIn`): not a fall,
   * a loss or a yield ("a 20% fall"), not a percent of something else ("70% of experts", "I am 70%
   * sure"). Only these are a split, or a share of one.
   */
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
  const ofMoney = plainSharesIn(text).map((m) => m.value);
  const half = whole / 2;
  const halfWritten = HALF.test(text);
  const off = halfWritten ? ofMoney.find((p) => p !== half && p < whole) : undefined;
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

// A refusal written in the text: "no stocks", "sem ações", "without crypto", "no credit". What leads
// into it, then at most two words ("no US stocks", "sem nenhuma ação"), then what is refused. The
// leads are the ways a person says it: a bare negation ("no", "without", "sem", "nem", "never"), not
// wanting it ("I don't want any stocks", "não quero"), not being able to hold it ("I can't hold
// stocks", "não posso ter"), keeping out of it ("stay away from crypto", "longe de"), and leaving it
// out, the words the intake's own lines use ("leave out stocks", "deixe de fora ações"). Where two
// start at the same word the longer is tried first.
const NEG = `(?:${[
  String.raw`\b(?:do\s+not|don['’]?t|does\s+not|doesn['’]?t|will\s+not|won['’]?t|would\s+not|wouldn['’]?t|never)\s+want(?:\s+to\s+(?:hold|own|buy|have|touch|invest|be|put\s+(?:money|anything)))?\b`,
  String.raw`\b(?:cannot|can['’]?t|must\s+not|mustn['’]?t|may\s+not|not\s+allowed\s+to|not\s+permitted\s+to)\s+(?:hold|own|buy|have|touch|trade|invest)\b`,
  String.raw`\b(?:will\s+not|won['’]?t|do\s+not|don['’]?t|never)\s+touch\b`,
  String.raw`\b(?:keep|keeping|stay|staying|steer|steering)\s+(?:(?:me|us|it|my\s+money|the\s+money)\s+)?(?:out\s+of|away\s+from|clear\s+of)\b`,
  String.raw`\b(?:leave|leaving)\s+out\b`,
  String.raw`\bdeix(?:e|a|o|ar|ando)\s+(?:de\s+)?fora\b`,
  String.raw`\bnothing\s+in\b`,
  String.raw`\bnever\b`,
  String.raw`\bneither\b`,
  String.raw`\bnor\b`,
  String.raw`\bno\b`,
  String.raw`\bnot?\s+(?:any|in)\b`,
  String.raw`\bwithout\b`,
  String.raw`\bzero\b`,
  String.raw`\bexclud\w*\b`,
  String.raw`\bavoid\w*\b`,
  String.raw`\bn[aã]o\s+(?:quero|queria|aceito|posso\s+(?:ter|comprar|investir))\b`,
  String.raw`\bsem\b`,
  String.raw`\bnada de\b`,
  String.raw`\bnem\b`,
  String.raw`\bnenhum[a]?\b`,
  String.raw`\blonge\s+d[eoa]s?\b`,
  String.raw`\bfora\b`,
  String.raw`\bevit\w*\b`,
].join('|')})`;
/** What a person can rule out: a class the plan may hold, or credit (tokens that lend or trade a spread). */
export type Refused = HoldableClass | 'credit';
// The class of stock funds is named by its own words only ("ETFs", "index funds", "stock funds",
// "fundos de índice", "fundos de ações"). Bare "funds" and "fundos" are money ("no funds needed
// before then", "sem fundos de emergência"): they name no class (the review of Oct 7).
const REFUSED: [Refused, string][] = [
  ['stock', '(?:stocks?|shares|equit(?:y|ies)|a[cç][oõ]es|a[cç][aã]o)'],
  ['crypto', String.raw`(?:crypto\w*|cripto\w*|bitcoin|btc)`],
  ['gold', '(?:gold|ouro)'],
  [
    'etf',
    String.raw`(?:etfs?|index\s+funds?|(?:stock|equity)\s+funds?|fundos?\s+de\s+[ií]ndice|fundos?\s+de\s+a[cç][oõ]es)`,
  ],
  ['commodity', '(?:commodit(?:y|ies))'],
  ['credit', '(?:credit|lending|loans?|borrowers|cr[eé]dito|empr[eé]stimos?|tomadores)'],
];
const REFUSALS: [Refused, RegExp][] = REFUSED.map(([what, things]) => [
  what,
  new RegExp(`(?<lead>${NEG})\\s+(?<between>(?:\\p{L}+\\s+){0,2}?)(?<cls>${things})\\b`, 'giu'),
]);
// What is refused, any class: the next items of a list one refusal leads ("no stocks, crypto or
// gold", "sem ações nem cripto"). An item ends where the list goes on or its clause ends: in "no
// stocks, gold is fine" the gold is no item.
const REFUSED_NEXT = new RegExp(
  String.raw`^(?:\s*,\s*(?:(?:or|and|nor|ou|e|nem)\s+)?|\s+(?:or|and|nor|ou|e|nem)\s+)(?:(?:any|the|no|sem|de|d[oa]s?|as|os)\s+)?(?<cls>${REFUSED.map(([, things]) => things).join('|')})(?=\s*(?:$|[,.;!?\n]|(?:or|and|nor|ou|e|nem|please|either|at\s+all|por\s+favor)(?![\p{L}])))`,
  'iu',
);
const refusedBy = (word: string): Refused | null =>
  REFUSED.find(([, things]) => new RegExp(`^${things}$`, 'iu').test(word))?.[0] ?? null;

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
// A plain cue under a negation is no cue for that risk either (the review of Oct 7): "I can't take
// high risk", "Not low risk", "I am not aggressive". The negation is of the risk word where it comes
// right before it, with at most a few words between, none of them something else it could be of: a
// thing to hold ("no stocks and low risk" refuses the stocks), or a word that starts another clause.
const RISK_NEGATED =
  /(?<![\p{L}])(?:\p{L}+n['’]t|cannot|not|no|never|nothing|n[aã]o|nunca|nada|sem|nem)((?:\s+[^\s,;.!?]+){0,4})\s*$/iu;
const riskNegatedAt = (text: string, at: number): boolean => {
  const between = RISK_NEGATED.exec(tailBefore(text, at))?.[1];
  return (
    between !== undefined &&
    !between
      .split(/\s+/)
      .filter(Boolean)
      .some((word) => NOT_OF_THE_RISK.test(word))
  );
};
// A negation that comes after the risk word, in its own clause, is of it too (the third review, Oct
// 7: "High risk is not for me.", "Risco alto não é pra mim."): right after it, with at most two
// words between, none of them one that starts another clause ("low risk so I don't lose sleep").
const RISK_NEGATED_AFTER =
  /^((?:[^\S\n]+[^\s,;.!?]+){0,2}?)[^\S\n]+(?:\p{L}+n['’]t|cannot|not|never|n[aã]o|nunca|nem)(?![\p{L}])/iu;
const riskNegatedAfter = (text: string, end: number): boolean => {
  const between = RISK_NEGATED_AFTER.exec(text.slice(end))?.[1];
  return (
    between !== undefined &&
    !between
      .split(/\s+/)
      .filter(Boolean)
      .some((word) => NOT_OF_THE_RISK.test(word) || STARTS_A_CLAUSE.test(word))
  );
};
// A word of degree alone ("low", "high", "medium", "alto", "baixa") says how much of whatever it is
// said of: "low fees", "a high tax bracket", "interest rates are high right now" say nothing of the
// risk (the third review, Oct 7). It is a word for the risk where it is said of the risk ("low
// risk", "risco alto", "the risk can be high"), where it ends its clause with nothing else to be of
// ("keep it low", "not high, not low"), or beside another degree ("low to medium").
const DEGREE = String.raw`low|medium|high|baix[oa]|m[eé]dio|m[eé]dia|alt[oa]`;
const DEGREE_WORD = new RegExp(`^(?:${DEGREE})$`, 'iu');
const OF_THE_RISK = String.raw`risk\p{L}*|risco\p{L}*|volatil\p{L}*|profile|perfil`;
const RISK_NAMED_AFTER = new RegExp(String.raw`^[\s-]*(?:${OF_THE_RISK})(?![\p{L}])`, 'iu');
const RISK_NAMED_BEFORE = new RegExp(
  String.raw`(?<![\p{L}])(?:${OF_THE_RISK})(?:[^\S\n]+[^\s,;.!?]+){0,3}[^\S\n:]*$`,
  'iu',
);
const DEGREE_BESIDE = new RegExp(
  String.raw`^\s*(?:(?:to|or|and|ou|e|a|\/|-)\s*)(?:${DEGREE})(?![\p{L}])`,
  'iu',
);
const ENDS_ITS_CLAUSE = /^\s*(?:$|[,;.!?\n)])/u;
const SUBJECT_BEFORE = /(?:^|[,;.!?\n(])\s*(?:\p{L}+[^\S\n]+){2,}$/u;
/** Whether a word of degree written from `at` up to `end` is said of something that is not the risk. */
const degreeOfAnother = (text: string, at: number, end: number): boolean => {
  if (!DEGREE_WORD.test(text.slice(at, end))) return false;
  const after = text.slice(end);
  const before = tailBefore(text, at);
  if (RISK_NAMED_AFTER.test(after) || RISK_NAMED_BEFORE.test(before)) return false;
  if (DEGREE_BESIDE.test(after)) return false;
  // At the end of its clause it is said of what the clause names before it: of the risk where the
  // clause names nothing ("keep it low", "high"), of that thing where it does ("rates are high").
  if (ENDS_ITS_CLAUSE.test(after)) return SUBJECT_BEFORE.test(before) && !OWN_SUBJECT.test(before);
  return true;
};
// The clause is the person's own, or about the plan: "I want it low", "keep it high", "make it low".
const OWN_SUBJECT =
  /(?:^|[,;.!?\n(])\s*(?:\p{L}+[^\S\n]+)*?(?:i|we|it|eu|n[oó]s|keep|make|go|stay|set|not|nem|n[aã]o|risco|risk)(?:['’]\p{L}+)?[^\S\n]+(?:\p{L}+[^\S\n]+)*$/iu;
/**
 * How the text writes a risk's plain words: each place, and whether a negation is of it. A word of
 * degree said of something else is no place the text writes the risk.
 */
const plainRiskMatches = (risk: keyof typeof RISK_CUES, text: string) =>
  [...text.matchAll(new RegExp(RISK_CUES[risk].source, 'giu'))]
    .filter((m) => !degreeOfAnother(text, m.index, m.index + m[0].length))
    .map((m) => ({
      words: m[0],
      negated: riskNegatedAt(text, m.index) || riskNegatedAfter(text, m.index + m[0].length),
    }));
const RISK_LEVELS = Object.keys(RISK_CUES) as (keyof typeof RISK_CUES)[];
/** The risks the text has a word for, plain or loose, that no negation is of. */
export const riskCuesIn = (text: string) =>
  RISK_LEVELS.filter((r) => {
    const loose = LOOSE_RISK_CUES[r];
    return (
      plainRiskMatches(r, text).some((m) => !m.negated) ||
      (loose !== null && looseMatches(loose, text).length > 0)
    );
  });
/**
 * The risks the text writes only under a negation ("I can't take high risk" for high): the person
 * said that risk is not theirs. A reader that gives one of these read the opposite of what is
 * written.
 */
export const risksRuledOutIn = (text: string) => {
  const said = riskCuesIn(text);
  return RISK_LEVELS.filter(
    (r) => !said.includes(r) && plainRiskMatches(r, text).some((m) => m.negated),
  );
};
/**
 * The loose words a risk was read from, as written, when the text has no plain word for it: "go
 * crazy" for high. Null when a plain word says it ("high risk", "risco alto") or none does.
 */
export function looseRiskWordsIn(text: string, risk: 'low' | 'medium' | 'high'): string | null {
  const loose = LOOSE_RISK_CUES[risk];
  if (plainRiskMatches(risk, text).some((m) => !m.negated) || !loose) return null;
  // The last one written: on a later turn, the person's own answer.
  return looseMatches(loose, text).at(-1) ?? null;
}

// ---------------------------------------------------------------------------------------------------
// What the person wants held (gate EXPLICIT-MIX, Rodrigo, Oct 6): "all of it in stocks", "70% stocks
// and 30% cash", "only credit", "tudo em ações". English and Portuguese only: a mix written in another
// language gives nothing here, so the model's reading of it is asked, and nothing is taken in silence.

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
// A word that only looks like a part is none: "I just cash out every December", "a credit card".
const MIX_CLASSES: [MixPart, string][] = [
  [
    'growth',
    String.raw`stock market|stocks?|equit(?:y|ies)|shares|a[cç][oõ]es|a[cç][aã]o|bolsa|crypto\p{L}*|cripto\p{L}*|bitcoin`,
  ],
  ['credit', String.raw`credit(?!\s+cards?(?![\p{L}]))|cr[eé]dito|high[- ]yield`],
  [
    'dollarYield',
    'dollar yield|rendimento em d[oó]lar|treasur(?:y|ies)|t-bills|bonds|t[ií]tulos do tesouro|renda fixa',
  ],
  ['gold', 'gold|ouro'],
  ['cash', String.raw`cash(?!\s+(?:out|flow)(?![\p{L}]))|caixa`],
];
const CLASS_ANY = MIX_CLASSES.map(([, w]) => w).join('|');
// What a negation before a risk word is of, where it is not of the risk (`riskNegatedAt`): a thing
// to hold, or a word that starts another clause.
const NOT_OF_THE_RISK = new RegExp(
  `^(?:and|or|but|so|then|because|e|ou|mas|ent[aã]o|porque|${CLASS_ANY})$`,
  'iu',
);
// The parts in Portuguese words alone. "So" with no accent is "só" only before one of these: in "I am
// retired so no stocks please" and "so stocks are fine" it is English.
const CLASS_PT = String.raw`a[cç][oõ]es|a[cç][aã]o|bolsa|cripto\p{L}*|cr[eé]dito|rendimento em d[oó]lar|t[ií]tulos do tesouro|renda fixa|ouro|caixa`;
const partOf = (word: string): MixPart | null => {
  for (const [part, words] of MIX_CLASSES)
    if (new RegExp(`^(?:${words})$`, 'iu').test(word)) return part;
  return null;
};
/** A part's word as a named group, ending where the word ends. */
const partNamed = (name: string, words = CLASS_ANY) => `(?<${name}>${words})(?![\\p{L}])`;

const WHOLE_BPS = 10_000;
const BPS_PER_PCT = 100;
const HALF_PCT = 100 / 2;

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

// ---------------------------------------------------------------------------------------------------
// A market, an industry or a trend the person names to invest in (gates EXPLICIT-MIX, THEMES and
// THEME-MATCHED): "big tech", "semiconductors", "space stocks", "setor de defesa". The words are fixed
// lists, English and Portuguese, and code decides what each one reads to on the person's shelf: a
// shared portfolio, a curated label, a filter over the sourced attributes, or nothing. The
// model names a narrative only by its id here, and one the text has no word for is dropped.

/** The narratives the intake has words for, in the order they are read. */
export const MARKET_IDS = [
  'big_tech',
  'us_market',
  'ai',
  'semiconductors',
  'ai_infrastructure',
  'crypto_economy',
  'fintech',
  'space',
  'quantum',
  'ev_autonomy',
  'cloud_software',
  'emerging_markets',
  'commodities',
  'broad_market',
  'retail_favourites',
  'defense',
  'health_care',
  'social_media',
] as const;
export type Market = (typeof MARKET_IDS)[number];

/**
 * What a narrative reads to, tried in this order and taking the first the person's shelf has: its
 * shared portfolio, where it names one; its curated label (gate THEMES); its filters over the stocks'
 * sourced attributes, in the order written, the first that matches a stock listed there (gate
 * THEME-MATCHED). Where none fits, nothing is held for it, and the first of `nearest` the shelf has is
 * offered by name: each is the slug of a shared portfolio or of a label.
 */
export type Narrative = {
  portfolio: string | null;
  label: string;
  filters: readonly MarketFilter[];
  nearest: readonly string[];
};
const reads = (
  label: string,
  nearest: readonly string[] = [],
  filters: readonly MarketFilter[] = [],
  portfolio: string | null = null,
): Narrative => ({ portfolio, label, filters, nearest });
const keyword = (value: string): MarketFilter => ({ by: 'keyword', value });
// The filters follow the stocks' attributes as they are sourced. GICS files a stablecoin issuer and a
// bitcoin holder under Software, IonQ and Rigetti under Semiconductors, and SpaceX under
// telecommunications, so a keyword serves where an industry would mislead.
export const NARRATIVES: Record<Market, Narrative> = {
  big_tech: reads('big-tech', ['the-seven', 'ai', 'the-500'], [], 'the-seven'),
  us_market: reads('broad-market', ['the-500', 'the-seven'], [], 'the-500'),
  ai: reads('ai', ['the-seven', 'the-500']),
  semiconductors: reads(
    'semiconductors',
    ['sand-to-server', 'ai', 'the-seven'],
    [{ by: 'industry', value: 'Semiconductors & Semiconductor Equipment' }],
  ),
  ai_infrastructure: reads(
    'ai-infrastructure',
    ['ai', 'semiconductors', 'the-seven'],
    [keyword('data centers')],
  ),
  crypto_economy: reads('crypto-economy', ['crypto-in-a-suit']),
  fintech: reads('fintech', ['crypto-economy', 'crypto-in-a-suit']),
  space: reads('space', [], [keyword('launch services')]),
  quantum: reads('quantum-computing', ['ai', 'semiconductors'], [keyword('quantum computers')]),
  ev_autonomy: reads(
    'ev-autonomy',
    ['ai', 'the-seven'],
    [keyword('electric vehicles'), { by: 'sub_industry', value: 'Automobile Manufacturers' }],
  ),
  cloud_software: reads('cloud-software', ['the-seven', 'ai'], [keyword('cloud')]),
  emerging_markets: reads('emerging-markets-asia', [], [keyword('emerging markets')]),
  commodities: reads('commodities', ['storm-cellar']),
  broad_market: reads('broad-market', ['the-500'], [keyword('index fund')]),
  retail_favourites: reads('retail-favourites'),
  defense: reads(
    'defense',
    [],
    [{ by: 'industry', value: 'Aerospace & Defense' }, keyword('defense')],
  ),
  health_care: reads('health-care', [], [{ by: 'sector', value: 'Health Care' }]),
  social_media: reads('social-media', [], [keyword('social media')]),
};

// "Space", "defense" and "health care" alone are read only after a word that puts money somewhere
// ("invest in space", "tudo na defesa", "investir em saúde"), and never as "in the space of two
// years", "in defense of" or "money for health care".
const AFTER_IN = String.raw`(?<=(?<![\p{L}])(?:in|into|em|no|na|nos|nas)[^\S\n]+(?:(?:the|a|o|os|as)[^\S\n]+)?)`;
// Words that are everywhere ("I saw it on social media", "vi nas redes sociais") need more: a word
// that puts money there, or a share of it, a few words before in the same clause. A mark inside a
// figure ends no clause ("invest $2,000 in", "investir US$ 2.000 em").
const AFTER_PUT_IN = String.raw`(?<=(?<![\p{L}])(?:invest\p{L}*|put|place|allocate|buy|aplic\p{L}*|coloc\p{L}*|bot[ao]\p{L}*|compr\p{L}*|invist\p{L}*|all|everything|half|tudo|metade|\d{1,3}[^\S\n]*%)(?:[^\S\n]+(?:[^\s,;.!?]|(?<=\d)[.,](?=\d))+){0,3}?[^\S\n]+(?:in|into|em|no|na|nos|nas)[^\S\n]+(?:(?:the|a|o|os|as)[^\S\n]+)?)`;
// "Blue chips" are large companies, not chip makers.
const NOT_BLUE = '(?<!blue[- ]?)';
// The words of each narrative. `asWritten` keeps its capitals: "AI", "IA" and "EVs" are read only in
// capitals ("ai" is a word in Portuguese: "ai, não sei"). `anyCase` is read in any case.
// Not read: "crypto" alone, an asset class the plan can hold; and gold, where "all in gold" is a mix.
const MARKET_WORDS: Record<Market, { asWritten?: string; anyCase?: string }> = {
  big_tech: {
    anyCase:
      'big[- ]?techs?|magnificent (?:7|seven)|mag(?:nificent)? ?7|(?:us|american) tech giants|tech giants|grandes? (?:empresas )?de tecnologia|gigantes (?:da|de) tecnologia',
  },
  us_market: {
    anyCase: String.raw`(?:s&p(?: ?500)?|s and p(?: 500)?|sp ?500)(?: index)?(?: (?:funds?|etfs?))?|(?:the )?(?:us|u\.s\.|american) (?:stock )?market|(?:us|u\.s\.|american) stocks|bolsa americana|mercado americano|a[cç][oõ]es americanas`,
  },
  ai: {
    asWritten: String.raw`AI|IA|A\.I\.`,
    anyCase: 'artificial intelligence|intelig[eê]ncia artificial',
  },
  semiconductors: {
    asWritten: 'AI [Cc]hips|[Cc]hips (?:de|para) IA',
    anyCase: `semiconductors?|${NOT_BLUE}(?:chip ?makers?|chip (?:stocks|companies|manufacturers|designers|sector|industry)|chips)|semicondutor(?:es)?|(?:fabricantes|empresas|a[cç][oõ]es) de chips`,
  },
  ai_infrastructure: {
    asWritten:
      'AI [Ii]nfra(?:structure)?|AI [Dd]ata ?[Cc]ent(?:er|re)s?|[Ii]nfraestrutura de IA|[Dd]ata ?[Cc]enters? de IA',
    anyCase:
      'data ?cent(?:er|re)s?|artificial intelligence infrastructure|infraestrutura de intelig[eê]ncia artificial|centros? de dados',
  },
  crypto_economy: {
    anyCase: String.raw`crypto(?:currency)?[- ](?:economy|stocks|equities|companies|miners)|crypto[- ]related (?:stocks|companies)|bitcoin miners|(?:empresas|a[cç][oõ]es) de cripto\p{L}*|economia (?:de )?cripto\p{L}*|mineradoras de bitcoin`,
  },
  fintech: {
    anyCase: 'fintechs?|brokers|brokerages|brokerage (?:stocks|firms|companies)|corretoras',
  },
  space: {
    anyCase: String.raw`space (?:stocks|industry|sector|companies|economy|exploration|tech(?:nology)?)|rockets|(?:setor|ind[uú]stria|economia|explora[cç][aã]o) espacial|empresas espaciais|foguetes|${AFTER_IN}space(?!\s+of(?![\p{L}]))`,
  },
  quantum: {
    anyCase: String.raw`quantum comput(?:ing|ers?)|quantum (?:stocks|companies|tech(?:nology)?)|quantum(?!\s+leap)|computa[cç][aã]o qu[aâ]ntica|computadores qu[aâ]nticos|tecnologia qu[aâ]ntica`,
  },
  ev_autonomy: {
    asWritten: 'EVs?',
    anyCase:
      'electric (?:vehicles?|cars?)|self[- ]driving(?: cars?)?|autonomous (?:driving|vehicles?|cars?)|robotaxis?|(?:carros?|ve[ií]culos?) (?:el[eé]tricos?|aut[oô]nomos?)|dire[cç][aã]o aut[oô]noma',
  },
  cloud_software: {
    anyCase:
      'cloud(?: (?:computing|software|stocks|companies))?|software(?: (?:stocks|companies))?|saas|computa[cç][aã]o em nuvem|nuvem',
  },
  emerging_markets: {
    anyCase:
      'emerging[- ]markets?(?: (?:stocks|equities))?|asian (?:stocks|markets|equities)|mercados emergentes|pa[ií]ses emergentes|[aá]sia',
  },
  commodities: {
    anyCase:
      'commodities|commodity (?:stocks|producers)|real assets|oil(?: (?:stocks|companies|and gas))?|silver|mat[eé]rias[- ]primas|ativos reais|petr[oó]leo|prata',
  },
  broad_market: {
    anyCase:
      'index funds?|the (?:whole|entire|total) (?:stock )?market|total market|fundos? de [ií]ndice|o mercado (?:todo|inteiro)|mercado como um todo',
  },
  retail_favourites: {
    anyCase: 'meme[- ]?stocks?|retail favou?rites?|a[cç][oõ]es[- ]memes?',
  },
  defense: {
    anyCase: String.raw`defen[cs]e (?:stocks|sector|industry|companies|contractors)|aerospace(?: (?:and|&) defen[cs]e)?|weapons|(?:setor|ind[uú]stria|empresas|a[cç][oõ]es) de defesa|ind[uú]stria b[eé]lica|armamentos?|aeroespacial|${AFTER_IN}defen[cs]e(?!\s+of(?![\p{L}]))|${AFTER_IN}defesa(?!\s+d[eoa]s?(?![\p{L}]))`,
  },
  health_care: {
    anyCase: `health[- ]?care (?:stocks|sector|industry|companies)|health stocks|pharma(?:ceuticals?)?|(?:setor|ind[uú]stria|empresas|a[cç][oõ]es) (?:de|da) sa[uú]de|farmac[eê]uticas?|ind[uú]stria farmac[eê]utica|${AFTER_IN}health[- ]?care|${AFTER_IN}sa[uú]de`,
  },
  social_media: {
    anyCase: `social[- ]media (?:stocks|companies|platforms|sector)|social networks? (?:stocks|companies)|(?:empresas|a[cç][oõ]es) de (?:redes sociais|m[ií]dias? sociais)|${AFTER_PUT_IN}(?:social[- ]media|social networks?|redes sociais|m[ií]dias? sociais)`,
  },
};
const wholeWords = (source: string, flags: string) =>
  new RegExp(`(?<![\\p{L}])(?:${source})(?![\\p{L}])`, flags);
const MARKETS: [Market, RegExp[]][] = MARKET_IDS.map((market) => {
  const { asWritten, anyCase } = MARKET_WORDS[market];
  return [
    market,
    [
      ...(asWritten ? [wholeWords(asWritten, 'gu')] : []),
      ...(anyCase ? [wholeWords(anyCase, 'giu')] : []),
    ],
  ];
});
// The words above that are read only after a word that puts money somewhere, bare. A list carries
// what leads it (the review of Oct 7: in "Invest in AI and defense" the defense was not read): such a
// word is read as an item of a list of narratives too, joined to the one before it.
const LIST_ITEMS: [Market, RegExp][] = (
  [
    ['space', String.raw`space(?!\s+of(?![\p{L}]))`],
    ['defense', String.raw`defen[cs]e(?!\s+of(?![\p{L}]))|defesa(?!\s+d[eoa]s?(?![\p{L}]))`],
    ['health_care', 'health[- ]?care|sa[uú]de'],
    ['social_media', 'social[- ]media|social networks?|redes sociais|m[ií]dias? sociais'],
  ] as const
).map(([market, words]) => [market, wholeWords(words, 'giu')]);
// What joins an item to the one before it, right before the item: "AI and", "AI, space or", "IA e".
const ITEM_JOIN =
  /(?:\s*,\s*(?:(?:and|or|e|ou)\s+)?|\s+(?:and|or|e|ou|&)\s+)(?:(?:the|a|o|os|as)\s+)?$/iu;

/** A place the text writes a narrative's words. */
type Hit = Span & { market: Market; order: number; words: string };
/**
 * Every place the text writes a narrative's words: the words of the lists, and a word read only
 * after "in" where it is the next item of a list of narratives ("AI and defense", "AI, space or
 * defense").
 */
function narrativeHitsIn(text: string): Hit[] {
  const hits: Hit[] = MARKETS.flatMap(([market, patterns], order) =>
    patterns.flatMap((pattern) =>
      [...text.matchAll(pattern)].map((m) => ({
        market,
        order,
        words: m[0],
        at: m.index,
        end: m.index + m[0].length,
      })),
    ),
  );
  for (let added = true; added; ) {
    added = false;
    for (const [market, pattern] of LIST_ITEMS)
      for (const m of text.matchAll(pattern)) {
        const at = m.index;
        const end = at + m[0].length;
        if (hits.some((h) => h.at < end && at < h.end)) continue;
        const join = ITEM_JOIN.exec(tailBefore(text, at));
        if (!join || !hits.some((h) => h.end === at - join[0].length)) continue;
        hits.push({ market, order: MARKET_IDS.indexOf(market), words: m[0], at, end });
        added = true;
      }
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------------
// How a clause says a holding (gate EXPLICIT-MIX; the review of Oct 6). A mix or a market is taken
// from the text only where its own clause states it as what the person wants held. A clause that
// rules it out ("I wouldn't put all of it in stocks", "anything but AI", "instead of only stocks"),
// says it of something else ("I already invest in the S&P 500 through my pension", "I work in
// software", "my brother is all in crypto", "I was all in stocks before"), or only wonders ("Should I
// put all of it in stocks?", "maybe all in stocks") states no holding. Nothing is ever built from the
// opposite of what is written.

/**
 * `stated`: what the person wants held. `negated`: ruled out. `aside`: said of the person, of what
 * they hold elsewhere, of someone else or of another time. `wondered`: asked or hedged; the person
 * may mean it, so it is asked, not taken.
 */
export type Stance = 'stated' | 'negated' | 'aside' | 'wondered';

type Span = { at: number; end: number };

/**
 * The sentence written up to `at`: from the last sentence break or line break. A mark inside a
 * number is no break ("US$ 2.000", "$1,500.50").
 */
function sentenceBefore(text: string, at: number): string {
  // Only the line the place is on is read, so a long text costs no more than a short one.
  const line = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
  let from = 0;
  for (const m of line.matchAll(/[.;!?](?=\s)/gu)) from = m.index + 1;
  return line.slice(from);
}

const CLASS_WORD = new RegExp(`(?<![\\p{L}])(?:${CLASS_ANY})(?![\\p{L}])`, 'giu');
/** Every place the text names something to hold: a narrative's words, or a part of a mix. */
function holdingsIn(text: string): Span[] {
  if (holdingsRead?.text === text) return holdingsRead.spans;
  const spans: Span[] = narrativeSpansIn(text);
  for (const m of text.matchAll(CLASS_WORD))
    spans.push({ at: m.index, end: m.index + m[0].length });
  spans.sort((a, b) => a.at - b.at);
  holdingsRead = { text, spans };
  return spans;
}
// The last text read and its places: a stance is asked of each mention of a text in turn, and the
// places are the text's, the same each time. One text is kept, so nothing grows.
let holdingsRead: { text: string; spans: Span[] } | null = null;

// A word of the text that names another holding, while a clause is read.
const HELD = '\u{E000}';
// What joins two things held ("big tech, AI or crypto stocks") and, before a word that starts a new
// clause, two clauses ("I don't like bonds and want everything in stocks").
const JOINS = /^(?:and|or|nor|plus|e|ou|nem|&|\+)$/iu;
const STARTS_A_CLAUSE =
  /^(?:i|i['’]?d|i['’]?ll|i['’]?m|we|we['’]?d|you|please|then|also|just|maybe|perhaps|want|wants|would|will|prefer|put|invest|let['’]?s|keep|make|give|should|can|could|eu|n[oó]s|quero|queria|gostaria|vou|prefiro|talvez|coloc\p{L}*|bot\p{L}*|invist\p{L}*|investir|aplic\p{L}*|pode|devo|posso)$/iu;
// Words that always start a clause. "Anything but AI" and "nothing but stocks" are one clause.
const BREAKS =
  /^(?:but|because|however|though|although|whereas|mas|por[eé]m|porque|pois|portanto)$/iu;
const BEFORE_BUT = /^(?:anything|everything|all|nothing|none)$/iu;
// "So" and "then" start one where a clause follows ("so put it all in stocks", "so all in stocks"),
// and none in "I am not so sure about".
const MAY_BREAK = /^(?:so|then|ent[aã]o)$/iu;
// Small words and figures that lead into a holding: "in", "the", "$300", "30%".
const LEADS_IN =
  /^(?:the|a|an|o|os|as|um|uma|some|in|into|on|of|to|em|na|nos|nas|de|do|da|dos|das)$/iu;
const FIGURE = /^[^\p{L}]*\d\S*$/u;
const HALF_WORD = /^(?:half|metade)$/iu;
// A dollar mark written apart from its figure, as Portuguese writes it: "US$ 300".
const DOLLAR_MARK = /^(?:us\$|u\$s|usd|\$)$/iu;

/**
 * The words of the holding's own clause that come before it. A clause starts at a sentence break, a
 * comma, "but", "so" and the like, or "and" before a word that starts one ("and I want"). Where the
 * holding is one of a list ("I don't want to invest in big tech, AI or crypto stocks"), the clause is
 * the list's: what is said of the first is said of each. A mix is no item of a list: "no crypto and
 * all of it in stocks" starts anew at "all".
 */
function clauseBefore(text: string, at: number, holdings: Span[], listed: boolean): string {
  // Several readers ask for the clause of one place of a text: it is read once for a text and its
  // holdings. One text is kept, so nothing grows.
  if (clausesRead?.text !== text) clausesRead = { text, around: new WeakMap() };
  let read = clausesRead.around.get(holdings);
  if (!read) {
    read = new Map();
    clausesRead.around.set(holdings, read);
  }
  const key = listed ? at : -1 - at;
  let clause = read.get(key);
  if (clause === undefined) {
    clause = clauseRead(text, at, holdings, listed);
    read.set(key, clause);
  }
  return clause;
}
let clausesRead: { text: string; around: WeakMap<Span[], Map<number, string>> } | null = null;

function clauseRead(text: string, at: number, holdings: Span[], listed: boolean): string {
  const sentence = sentenceBefore(text, at);
  const start = at - sentence.length;
  // The holdings of this sentence the clause is read around, in the order they are given.
  const held: Span[] = [];
  let taken = start;
  for (const h of holdings) {
    if (h.at < taken || h.end > at) continue;
    held.push(h);
    taken = h.end;
  }
  // "No" is "in the" in Portuguese, and leads into a holding there ("no setor de defesa").
  const leads = (word: string) =>
    LEADS_IN.test(word) ||
    FIGURE.test(word) ||
    HALF_WORD.test(word) ||
    DOLLAR_MARK.test(word) ||
    (/^no$/iu.test(word) && portugueseBefore(text, start, at));
  // The clause is read from the end of the sentence backwards. The last stretch is read first, and
  // a longer one only where the clause or the list it ends runs past it: what is read is the same
  // as from the whole sentence, and a long sentence costs no more than its clause.
  // Where the clauses of a sentence run long, the next one is read from as far back straight away.
  if (reachRead?.text !== text) reachRead = { text, from: new Map() };
  const reaches = reachRead.from;
  for (let reach = reaches.get(start) ?? INTAKE_LIMITS.clauseReachChars; ; reach *= 2) {
    let begin = Math.max(start, at - reach);
    // Never from inside a word, nor from inside a holding.
    for (let moved = true; moved && begin > start; ) {
      moved = false;
      const inside = held.find((h) => h.at < begin && begin < h.end);
      if (inside) {
        begin = Math.max(start, inside.at);
        moved = true;
      } else if (!/\s/u.test(text[begin - 1] ?? '')) {
        begin -= 1;
        moved = true;
      }
    }
    const clause = clauseFrom(text, begin, at, held, listed, leads, begin === start);
    if (clause !== null) {
      if (reach > INTAKE_LIMITS.clauseReachChars) reaches.set(start, reach);
      return clause;
    }
  }
}
let reachRead: { text: string; from: Map<number, number> } | null = null;

/**
 * The clause read from the words written from `begin` up to `at`; null where it, or the list it
 * ends, runs back past `begin` and `begin` is not where the sentence starts (`whole`).
 */
function clauseFrom(
  text: string,
  begin: number,
  at: number,
  held: Span[],
  listed: boolean,
  leads: (word: string) => boolean,
  whole: boolean,
): string | null {
  let masked = '';
  let from = begin;
  for (const h of held) {
    if (h.at < begin) continue;
    masked += `${text.slice(from, h.at)} ${HELD} `;
    from = h.end;
  }
  masked += text.slice(from, at);
  // A mark inside a figure ends no clause ("$2,000", "US$ 1.500,50").
  const words = masked
    .replace(/[;:]|,(?!\d)|(?<!\d),/g, ' , ')
    .split(/\s+/)
    .filter(Boolean);
  // The words still read are the first `n`: a long list is walked back without copying it.
  let n = words.length;
  // Back over the items of a list this holding ends, or to the join that starts its clause.
  for (;;) {
    let i = n;
    while (i > 0 && leads(words[i - 1] ?? '')) i -= 1;
    if (i === 0 && !whole) return null;
    const join = words[i - 1] ?? '';
    if (i === 0 || !(join === ',' || JOINS.test(join))) break;
    let before = i - 1;
    if (before === 0 && !whole) return null;
    if (before > 0 && (words[before - 1] === ',' || JOINS.test(words[before - 1] ?? '')))
      before -= 1;
    if (before === 0 && !whole) return null;
    if (!listed || words[before - 1] !== HELD) return words.slice(i, n).join(' ');
    n = before - 1;
  }
  // From the last word that starts a clause: read backwards, and the first one found is the last.
  let onlyLeadsAfter = true;
  for (let i = n - 1; i >= 0; i -= 1) {
    const word = words[i] ?? '';
    const next = i + 1 < n ? (words[i + 1] ?? '') : '';
    if (i === 0 && !whole && /^but$/iu.test(word)) return null;
    if (
      word === ',' ||
      (BREAKS.test(word) && !(/^but$/iu.test(word) && BEFORE_BUT.test(words[i - 1] ?? ''))) ||
      (JOINS.test(word) && STARTS_A_CLAUSE.test(next)) ||
      (MAY_BREAK.test(word) && (STARTS_A_CLAUSE.test(next) || onlyLeadsAfter))
    )
      return words.slice(i + 1, n).join(' ');
    onlyLeadsAfter &&= leads(word);
  }
  return whole ? words.slice(0, Math.max(0, n)).join(' ') : null;
}

/**
 * Whether the sentence that starts at `start` writes a Portuguese word before `at`. Where its first
 * one ends is worked out once for a sentence of a text, and one text is kept, so nothing grows.
 */
function portugueseBefore(text: string, start: number, at: number): boolean {
  if (portugueseRead?.text !== text) portugueseRead = { text, firstEnds: new Map() };
  let end = portugueseRead.firstEnds.get(start);
  if (end === undefined) {
    const line = text.indexOf('\n', start);
    const found = PORTUGUESE_WORD.exec(text.slice(start, line < 0 ? text.length : line));
    end = found ? start + found.index + found[0].length : Number.POSITIVE_INFINITY;
    portugueseRead.firstEnds.set(start, end);
  }
  return end <= at;
}
let portugueseRead: { text: string; firstEnds: Map<number, number> } | null = null;

// A text with one of these words is Portuguese: there "no" is "in the" ("investir no S&P 500", "tudo
// no setor de defesa"), and it rules nothing out.
const PORTUGUESE_WORD =
  /(?<![\p{L}])(?:quero|queria|tenho|gosto|gostaria|prefiro|acho|vou|vai|posso|investir|invisto|aplicar|colocar|botar|apostar|dinheiro|anos?|meses|reais|d[oó]lares|meu|minha|tudo|setor|mercado|interesse|foco|a[cç][oõ]es|em|nos|nas|uma|n[aã]o|é|são|pra|para|por|que|mas|ou|se|mais|muito|bem|também|ainda|só|já)(?![\p{L}])/iu;
// What rules a holding out, anywhere in its clause before it: "I don't want to invest in", "I would
// never", "It's not a good idea to put", "I would rather avoid being", "não quero investir em", "sem".
// "Not only AI", "why not AI" and "I can't wait to" rule nothing out.
const RULED_OUT =
  /(?<![\p{L}'’])(?:(?<!why\s)not(?!\s+(?:only|just)(?![\p{L}]))|(?:\p{L}+n['’]t|cannot)(?!\s+wait(?![\p{L}]))|(?:do|does|did|wo|would|ca|could|should|is|are|was|have|has)nt|never|neither|nor|without|avoid\p{L}*|exclud\p{L}*|refus\p{L}*|against|hate\p{L}*|dislike\p{L}*|n[aã]o|nunca|nem|sem|nada\s+de|evit\p{L}*|contra)(?![\p{L}])/iu;
// English and Spanish "no": "no big tech", "no AI please". "No doubt", "no problem" rule nothing out.
const NO = /(?<![\p{L}])no(?!\s+(?:doubt|problem|worries|matter)(?![\p{L}]))(?![\p{L}])/iu;
// What sets a holding aside, right before it: "anything but AI", "instead of only stocks", "more than
// just stocks", "beyond just stocks", "everything except big tech", "tudo menos IA", "em vez de".
const SET_ASIDE =
  /(?<![\p{L}])(?:(?:anything|everything|all)\s+but|instead\s+of|rather\s+than|more\s+than|other\s+than|apart\s+from|beyond|except(?:\s+for)?|exceto|fora\s+d[eoa]s?|em\s+vez\s+d[eoa]s?|ao\s+inv[eé]s\s+d[eoa]s?|al[eé]m\s+d[eoa]s?|mais\s+(?:do\s+)?que|(?:tudo|qualquer\s+coisa)\s+menos)(?:\s+(?:just|only|being|going|putting|having|s[oó]|apenas|somente|all|everything|tudo|the|a|an|o|os|as|in|into|on|of|em|na|nos|nas|de|do|da))*\s*$/iu;
// What only wonders: "Should I put all of it in stocks", "maybe", "I'm not sure", "what about", "why
// not", "será que", "talvez". The person may mean it: it is asked, never taken.
const WONDERS =
  /(?<![\p{L}])(?:maybe|perhaps|possibly|might|i\s+could|thinking\s+(?:of|about)|considering|wondering|not\s+sure|unsure|undecided|(?:do\s+not|don['’]?t)\s+know|can['’]?t\s+decide|should\s+i|shall\s+i|can\s+i|could\s+i|may\s+i|would\s+it|is\s+it|does\s+it|do\s+you|what\s+if|how\s+about|what\s+about|why\s+not|talvez|quem\s+sabe|pensando\s+em|considerando|ser[aá]\s+que|devo|posso|e\s+se|que\s+tal|por\s+que\s+n[aã]o|vale\s+a\s+pena|n[aã]o\s+sei|em\s+d[uú]vida)(?![\p{L}])/iu;
// A question that ends where the holding's clause ends: "Should I put all of it in stocks?".
const ASKED_AFTER = /^[^,;.!?\n]*\?/u;
// And one the person answers "no" to themself, right after it: "stocks only? no thanks".
const ANSWERED_NO = /^[^,;.!?\n]*\?\s*(?:no|nope|nah|n[aã]o)(?![\p{L}])/iu;
// A judgement against it, right after it: "Putting everything in gold is too risky for me".
const JUDGED_AFTER =
  /^\s*(?:(?:is|are|was|would\s+be|seems?|sounds?|feels?|looks?|[eé]|seria|parece)\s+(?:\p{L}+\s+){0,2}?(?:too|not|risky|crazy|scary|dangerous|a\s+mistake|a\s+bad\s+idea|bad|wrong|out\s+of\s+the\s+question|arriscado|loucura|perigoso|um\s+erro|uma\s+m[aá]\s+ideia|demais)|(?:is|are|was)n['’]?t|n[aã]o\s+[eé])(?![\p{L}])/iu;
// Said of the person, not of what to hold. Where they work or live, or mean to: "I work in software",
// "I live in Asia", "retire in Asia", "trabalho na área de software", "sou engenheiro de software".
const ABOUT_THEM =
  /(?<![\p{L}])(?:work(?:s|ed|ing)?|job|career|background|degree|live[sd]?|living|based|born|retir(?:e|es|ed|ing)|mov(?:e|es|ed|ing)|travel\p{L}*|house|home|apartment|trabalh\p{L}*|emprego|carreira|formad[oa]|mor(?:o|a|amos|ei|ava|ando|ar)|viv[oe]\p{L}*|nasci|aposent\p{L}*|mud(?:ar|o|ei|ando)|viaj\p{L}*|casa|apartamento|engenheir[oa]s?|desenvolvedor(?:a|es)?|programador(?:a|es)?|pesquisador(?:a|es)?|cientistas?|consultor(?:a|es)?|analistas?)[^\S\n]+(?:(?:in|at|for|with|as|to|em|no|na|nos|nas|com|de|do|da|para)[^\S\n]+)?(?:(?:an?|the|um|uma|o|a)[^\S\n]+)?(?:(?:[aá]rea|setor|ramo|ind[uú]stria)[^\S\n]+d[eoa][^\S\n]+)?$/iu;
// What is theirs: "my software company", "minha empresa de software".
const THEIRS =
  /(?<![\p{L}])(?:(?:my|our)|(?:meu|minha|nosso|nossa)[^\S\n]+(?:empresa|startup|neg[oó]cio|trabalho|emprego)[^\S\n]+(?:de|com|em))[^\S\n]+$/iu;
// What they are: "a software engineer", "an AI researcher".
const WHAT_THEY_ARE =
  /^[^\S\n]+(?:engineer(?:s|ing)?|developers?|programmers?|architects?|researchers?|scientists?|consultants?|analysts?)(?![\p{L}])/iu;
// What they hold elsewhere: "I am already heavily invested in US stocks", "I already invest in the S&P
// 500 through my pension", "já invisto em IA".
const HELD_ALREADY =
  /(?<![\p{L}])(?:already|currently|j[aá]|atualmente)\s+(?:\p{L}+\s+){0,2}?(?:invest\p{L}*|invist\p{L}*|hold\p{L}*|have|has|own\p{L}*|bought|in|tenho|temos|possuo|comprei)(?![\p{L}])/iu;
const HELD_ELSEWHERE =
  /^[^,;.!?\n]*?(?<![\p{L}])(?:(?:through|via|in|at|with)\s+(?:my|our)\s+(?:pension|401k|ira|employer|broker|brokerage|bank|retirement\s+(?:plan|account))|(?:pel[oa]|n[oa])\s+(?:meu|minha)\s+(?:previd[eê]ncia|corretora|banco))(?![\p{L}])/iu;
// Said of someone else: "My brother is all in crypto", "everyone invests in big tech". With "I" or
// "we" after it the clause is the person's own again: "my wife and I want all of it in stocks".
const OF_ANOTHER =
  /(?<![\p{L}])(?:(?:my|our|meus?|minhas?|noss[oa]s?)\s+(?:brother|sister|wife|husband|father|mother|dad|mom|mum|friends?|boss|colleagues?|neighbou?rs?|partner|son|daughter|parents|uncle|aunt|cousins?|irm[aã]os?|irm[aã]s?|esposa|mulher|marido|pai|m[aã]e|amig[oa]s?|chefe|colegas?|vizinh[oa]s?|filh[oa]s?|pais|ti[oa]s?|prim[oa]s?)|he|she|they|everyone|everybody|people|ele|ela|eles|elas|todo\s+mundo|as\s+pessoas)(?![\p{L}])(?!.*(?<![\p{L}])(?:i|we|eu|n[oó]s)(?![\p{L}]))/isu;
// Said of another time: "I was all in stocks before", "I used to hold big tech".
const IN_THE_PAST =
  /(?<![\p{L}])(?:was|were|used\s+to|had\s+been|era|estava|costumava)(?![\p{L}])/iu;

/** How the clause of words written from `at` up to `end` says what they name. */
function stanceIn(
  text: string,
  at: number,
  end: number,
  holdings: Span[],
  listed: boolean,
): Stance {
  const after = text.slice(end);
  const lastWords = tailBefore(text, at);
  if (ABOUT_THEM.test(lastWords) || THEIRS.test(lastWords) || WHAT_THEY_ARE.test(after))
    return 'aside';
  // Words that say the goal has no date ("no hard cap", "I don't have a term") rule no holding out.
  const clause = clauseBefore(text, at, holdings, listed).replace(OPEN_ENDED_ANYWHERE, ' ');
  // What is said of the first item of a list is said of each: "I work in AI and defense".
  if (listed) {
    // Both patterns end where the clause ends, so its last words are all they read.
    const ending = `${clause} `;
    const lastOfClause = tailBefore(ending, ending.length);
    if (ABOUT_THEM.test(lastOfClause) || THEIRS.test(lastOfClause)) return 'aside';
  }
  if (HELD_ALREADY.test(clause) || HELD_ELSEWHERE.test(after)) return 'aside';
  if (ANSWERED_NO.test(after)) return 'negated';
  if (WONDERS.test(clause) || ASKED_AFTER.test(after)) return 'wondered';
  if (RULED_OUT.test(clause) || SET_ASIDE.test(clause) || JUDGED_AFTER.test(after))
    return 'negated';
  if (NO.test(clause) && !portugueseBefore(text, at - sentenceBefore(text, at).length, at))
    return 'negated';
  if (OF_ANOTHER.test(clause) || IN_THE_PAST.test(clause)) return 'aside';
  return 'stated';
}

/**
 * How the clause of words written from `at` up to `end` says what they name: as what the person
 * wants held, or not (`Stance`).
 */
export const stanceOf = (text: string, at: number, end: number): Stance =>
  stanceIn(text, at, end, holdingsIn(text), true);

// ---------------------------------------------------------------------------------------------------
// How a clause says a refusal (found by the playground run of Oct 6). "No stocks" lowers what the
// plan may hold, so it is taken from the text where the clause states it, with or without a model: a
// refusal that is lost gives the person what they refused. It is not taken where the clause says
// something else: the "no" is of another word ("I have no problem with stocks"), the refusal is
// itself negated ("I can't do without stocks", "não quero ficar sem ações"), it is said of what the
// person holds, of someone else or of another time ("I have no stocks yet", "my brother holds no
// stocks"), it is of a part of the class ("no US stocks", "no stocks from China"), or it is only
// wondered about ("no stocks? not sure", "maybe no stocks").

// The "no" is of this word, not of what follows: "no problem with stocks", "sem dúvida ações".
const NO_OF_ANOTHER_WORD =
  /(?<![\p{L}])(?:doubts?|problems?|issues?|objections?|worr(?:y|ies)|qualms|trouble|fear|limits?|caps?|restrictions?|rush|hurry|d[uú]vidas?|problemas?|medo|receio|limites?|restri[cç][aã]o|restri[cç][oõ]es|obje[cç][aã]o|obje[cç][oõ]es|pressa)(?![\p{L}])/iu;
// A second negation inside the refusal turns it round: "não quero ficar sem ações".
const TURNED_ROUND = /(?<![\p{L}])(?:without|sem)(?![\p{L}])/iu;
// Between the lead and what is refused, the words that leave it a refusal of the whole class: "no
// exposure to stocks", "sem nenhuma ação", "não quero investir em ações", "avoid all crypto"; and
// another thing refused in the same breath ("no stocks or crypto"). Any other word makes it a refusal
// of a part ("no US stocks", "no tech stocks", "no more stocks", "not only stocks") or another clause
// ("sem pressa quero ações", "moro fora e quero ações"): no refusal of the class. A sheet leaves out
// a class, not a part of one.
const OF_THE_WHOLE = new RegExp(
  `^(?:any|the|a|an|of|in|to|into|on|kinds?|sorts?|types?|exposure|interest|positions?|holdings?|investments?|allocation|money|invest|investing|buy|buying|hold|holding|own|owning|nenhum[a]?s?|de|d[oa]s?|em|n[oa]s?|o|as|os|ter|comprar|investir|aplicar|colocar|pensar|nada|qualquer|tipos?|exposi[cç][aã]o|interesse|posi[cç][aã]o|investimentos?|dinheiro|or|and|nor|e|ou|nem|${REFUSED.map(([, things]) => things).join('|')})$`,
  'iu',
);
// "All" is of the whole after a word that avoids ("avoid all stocks", "evitar todas as ações"), and of
// how much after any other ("I don't want to be all in stocks", "nem todas as ações").
const ALL_OF_IT = /^(?:all|every|tod[oa]s?)$/iu;
const AVOIDS = /^(?:avoid|exclud|evit)/iu;
// What follows names a part of the class: "no stocks from China", "no stocks except Apple", "no
// stocks in tech", "sem ações de tecnologia". "No stocks in my plan" and "no stocks of any kind" are
// of the whole.
const OF_A_KIND_AFTER =
  /^\s+(?:from\s+(?!now|today|here|this)|except|excluding|other\s+than|like(?![\p{L}])|such\s+as|that(?![\p{L}])|which|whose|of\s+(?!any|all|every)|in\s+(?!my|our|the\s+(?:plan|portfolio|mix)|this|it(?![\p{L}])|there|here|any)|de\s+(?!nenhum|qualquer|forma|jeito|modo|maneira)|d[ao]s?\s|que(?![\p{L}])|como(?![\p{L}])|exceto|menos(?![\p{L}])|tirando)/iu;
// What follows makes it another thing: "no stock market crash", "no gold standard", "no credit card".
const ANOTHER_THING: Partial<Record<Refused, RegExp>> = {
  // "No stock funds" names the funds, the other class.
  stock:
    /^\s+(?:market\s+(?:crash|crashes|fall|falls|drop|drops|dip|dips|downturn|correction|bubble|news|timing|hours)|funds?)(?![\p{L}])/iu,
  gold: /^\s+(?:standard|medals?|cards?|rush)(?![\p{L}])/iu,
  credit: /^\s+(?:cards?|scores?|history|checks?|ratings?|limits?|reports?|sharks?)(?![\p{L}])/iu,
};
// What the person holds, not what they refuse: "I have no stocks yet", "I hold no crypto", "I'm not in
// stocks", "my portfolio has no gold", "there are no stocks in it", "não tenho nenhuma ação", "estou
// sem ações". "I want to have no stocks" is a refusal.
const HOLDS_NONE =
  /(?<![\p{L}])(?:(?:i|we)(?:['’]ve)?(?:\s+(?:currently|already|still|now|also|really))?\s+(?:have|hold|own|got|have\s+got|had|held|owned|keep)|(?:n[aã]o\s+|ainda\s+|j[aá]\s+)*(?:tenho|temos|possuo|tinha|t[ií]nhamos|estou|estamos|fiquei)|(?:my|our|meu|minha|nosso|nossa)\s+\p{L}+\s+(?:has|holds|have|hold|had|tem|possui)|there\s+(?:is|are|was|were)|there['’]s)(?:\s+(?:got|currently|still|now|right\s+now|ainda))?\s*$/iu;
// "I'm not in stocks (yet)" says where the money is, not where it may go.
const IS_NOT_IN =
  /(?<![\p{L}])(?:i['’]?m|i\s+am|we['’]?re|we\s+are)(?:\s+(?:currently|still|now))?\s*$/iu;
const NOT_IN = /^not\s+in$/iu;
// A join that carries a refusal on to the next thing whatever came first: "I don't want bonds nor
// stocks", "no bonds or stocks", "sem títulos nem ações".
const AND_NEITHER = /^(?:or|nor|ou|nem)$/iu;
// With "I have no ...", what is held in a class: "I have no exposure to stocks".
const HELD_IN =
  /^(?:(?:exposure|positions?|holdings?|money|investments?|allocation)\s+(?:to|in|on)\s*)?$/iu;
// A hedge right after it, where the clause ends there: "no stocks maybe", "no stocks, not sure".
const HEDGED_AFTER =
  /^\s*,?\s*(?:maybe|perhaps|i\s+guess|i\s+suppose|not\s+sure|talvez|acho|n[aã]o\s+sei)\s*(?:$|[,.;!?\n])/iu;
// A lead that agrees with a negation before it and does not turn it round: "não quero ter nada de
// ações", "I don't want bonds nor stocks", "nem ações nem cripto".
const AGREES = /^(?:nada\s+de|nenhum[a]?|nem|neither|nor)$/iu;

/**
 * A refusal the text writes: what it rules out, the words it is written in, and how its clause says
 * it. `part`: the refusal with the part it names, as written, where the clause states a refusal of a
 * part of the class ("No stocks from China"). A plan leaves out a class, never a part of one, so it
 * is not taken (`aside`), and a caller can say so.
 */
export type RefusalSaid = {
  what: Refused;
  words: string;
  at: number;
  end: number;
  stance: Stance;
  part?: string;
};

/**
 * How the clause of a refusal written from `at` up to `end` says it. `ofAPart` false reads it as if
 * what follows named no part of the class.
 */
function refusalStance(
  text: string,
  what: Refused,
  lead: string,
  between: string,
  cls: string,
  at: number,
  end: number,
  narratives: Span[],
  ofAPart = true,
): Stance {
  const after = text.slice(end);
  if (NO_OF_ANOTHER_WORD.test(between) || TURNED_ROUND.test(between)) return 'negated';
  const words = between.split(/\s+/).filter(Boolean);
  const whole = (word: string) =>
    OF_THE_WHOLE.test(word) || (ALL_OF_IT.test(word) && AVOIDS.test(lead));
  if (!AND_NEITHER.test(words.at(-1) ?? '') && !words.every(whole)) return 'aside';
  if (ANOTHER_THING[what]?.test(after) || (ofAPart && OF_A_KIND_AFTER.test(after))) return 'aside';
  // Inside the words of a narrative the class word names the narrative ("no crypto stocks", "sem
  // ações americanas"): a narrative the person rules out is not asked, and no class is left out.
  const clsAt = end - cls.length;
  if (narratives.some((n) => n.at <= clsAt && end <= n.end && n.end - n.at > cls.length))
    return 'aside';
  // Words that say the goal has no date ("no hard cap", "I don't have a term") negate no refusal.
  const clause = clauseBefore(text, at, [], false).replace(OPEN_ENDED_ANYWHERE, ' ');
  if (HOLDS_NONE.test(clause) && HELD_IN.test(between.trim())) return 'aside';
  if (IS_NOT_IN.test(clause) && NOT_IN.test(lead.trim().replace(/\s+/g, ' '))) return 'aside';
  if (HELD_ALREADY.test(clause) || OF_ANOTHER.test(clause) || IN_THE_PAST.test(clause))
    return 'aside';
  if (WONDERS.test(clause) || ASKED_AFTER.test(after) || HEDGED_AFTER.test(after))
    return 'wondered';
  if (RULED_OUT.test(clause) && !AGREES.test(lead.trim().replace(/\s+/g, ' '))) return 'negated';
  return 'stated';
}

/**
 * Every refusal the text writes, in the order written, each with how its clause says it (`Stance`):
 * `stated` is what the person rules out; any other is written and is no refusal of theirs, or one
 * they are not sure of.
 */
export function refusalsSaidIn(text: string): RefusalSaid[] {
  // Each with the length of the word that names what is refused, which ends where the refusal ends.
  const found: (RefusalSaid & { named: number })[] = [];
  const narratives = narrativeSpansIn(text);
  // A refusal is one class ruled out up to one place: the first reading of it stands. One read
  // again from a later word of the same list is the same refusal, and so is the rest of that list,
  // which the first reading walked to its end: neither is worked out twice.
  const read = new Set<string>();
  const key = (what: Refused, end: number) => `${what}:${end}`;
  const add = (r: RefusalSaid, named: number) => {
    read.add(key(r.what, r.end));
    found.push({ ...r, named });
  };
  for (const [what, pattern] of REFUSALS)
    for (const m of text.matchAll(pattern)) {
      const at = m.index;
      const { lead = '', between = '', cls = '' } = m.groups ?? {};
      let end = at + m[0].length;
      if (read.has(key(what, end))) continue;
      const stance = refusalStance(text, what, lead, between, cls, at, end, narratives);
      // A refusal its clause states, of a part of the class: the words up to where the clause ends.
      const ofAPart =
        stance === 'aside' &&
        OF_A_KIND_AFTER.test(text.slice(end)) &&
        refusalStance(text, what, lead, between, cls, at, end, narratives, false) === 'stated';
      const part = ofAPart
        ? `${m[0]}${/^[^,.;!?\n]*/u.exec(text.slice(end))?.[0] ?? ''}`.replace(/\s+/g, ' ').trim()
        : undefined;
      add(
        { what, words: m[0].replace(/\s+/g, ' '), at, end, stance, ...(part ? { part } : {}) },
        cls.length,
      );
      // The list the refusal leads: what is said of the first is said of each ("no stocks, crypto
      // or gold" rules out the three).
      for (;;) {
        const next = REFUSED_NEXT.exec(text.slice(end));
        const word = next?.groups?.cls ?? '';
        const other = next ? refusedBy(word) : null;
        if (!next || !other) break;
        end += next[0].length;
        if (read.has(key(other, end))) break;
        add(
          {
            what: other,
            words: text.slice(at, end).replace(/\s+/g, ' '),
            at,
            end,
            stance: refusalStance(text, other, lead, '', word, at, end, narratives),
          },
          word.length,
        );
      }
    }
  // A word inside the longer name of another class names that class: "stock" in "no stock funds".
  const inside = (r: (typeof found)[number]) =>
    found.some((x) => x.named > r.named && x.end - x.named <= r.end - r.named && r.end <= x.end);
  return found
    .filter((r) => !inside(r))
    .map(({ named: _named, ...r }) => r)
    .sort((a, b) => a.at - b.at || a.end - b.end);
}

/**
 * The refusals the text writes, however their clause says them: the classes, and whether credit is
 * among them. What the person rules out is `refusalsSaidIn`, the ones their clause states.
 */
export function refusalsIn(text: string): { classes: HoldableClass[]; noCredit: boolean } {
  const said = refusalsSaidIn(text);
  return {
    classes: REFUSED.flatMap(([what]) =>
      what !== 'credit' && said.some((r) => r.what === what) ? [what] : [],
    ),
    noCredit: said.some((r) => r.what === 'credit'),
  };
}

const CLASS_NAMED: [Refused, RegExp][] = REFUSED.map(([what, things]) => [
  what,
  new RegExp(`(?<![\\p{L}])${things}(?![\\p{L}])`, 'giu'),
]);

/**
 * Every place the text names a class a person can rule out, in the order written: "stocks",
 * "crypto", "gold", "ETFs", "credit". Where two names share words the longer is the one read ("stock
 * funds" is the funds), and a class word inside a narrative's words names the narrative ("crypto
 * stocks", "ações americanas"). The last word on a class is found among these (the review of Oct 7).
 */
export function classMentionsIn(text: string): { what: Refused; at: number; end: number }[] {
  const found = CLASS_NAMED.flatMap(([what, pattern]) =>
    [...text.matchAll(pattern)].map((m) => ({ what, at: m.index, end: m.index + m[0].length })),
  );
  const longer = [...found, ...narrativeSpansIn(text)];
  return found
    .filter(
      (m) => !longer.some((x) => x.at <= m.at && m.end <= x.end && x.end - x.at > m.end - m.at),
    )
    .sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------------------------------
// The mix, read from the text.

type MixSpan = Span & { mix: MixRead; whole: boolean };

// What follows a percent that names a part: "70% stocks", "70% in stocks", "30% em caixa", "30% de
// ouro", "100 percent stocks".
const AFTER_PERCENT = new RegExp(
  String.raw`^\s*(?:(?:of\s+it|of\s+the\s+money|do\s+dinheiro)\s+)?(?:(?:in|into|em|de|no|na|nos|nas)\s+)?(?:the\s+)?${partNamed('cls')}`,
  'iu',
);
// What follows a part and makes its percent no share: "a 20% stock market fall".
const FALLS_AFTER =
  /^\s*(?:fall|falls|drop|drops|loss|losses|down|dip|crash|a year|per year|annual|queda|perda|ao ano|por ano)(?![\p{L}])/iu;
type PercentOfMoney = Span & { value: number; part: MixPart | null; partEnd: number };
/**
 * Where the text writes a narrative's words. A part's word inside them names the narrative, not a part
 * of a mix: "crypto stocks", "bitcoin miners", "ações americanas". The longer reading is the one read,
 * as among the narratives themselves, so "all of it in crypto stocks" is a share of that narrative and
 * no mix of its own.
 */
function narrativeSpansIn(text: string): Span[] {
  return narrativeHitsIn(text).map(({ at, end }) => ({ at, end }));
}
/** The part a word written at `at` names, unless a narrative's words hold it. */
function partNamedAt(text: string, word: string, at: number, narratives: Span[]): MixPart | null {
  const end = at + word.length;
  const held = narratives.some((n) => n.at <= at && end <= n.end && n.end - n.at > word.length);
  return held || text.slice(at, end) !== word ? null : partOf(word);
}
/**
 * The percents the text writes as shares of the money, each with the part it names, where it names
 * one. A fall, a loss, a yield or a rate is no share ("a 20% fall", "5% a year"); "30% dollar yield"
 * is one.
 */
function percentsOfMoneyIn(text: string): PercentOfMoney[] {
  const narratives = narrativeSpansIn(text);
  return mentionsIn(text).flatMap((m): PercentOfMoney[] => {
    if (m.kind !== 'percent') return [];
    const after = text.slice(m.end);
    const named = AFTER_PERCENT.exec(after);
    const word = named?.groups?.cls ?? '';
    const part = named
      ? partNamedAt(text, word, m.end + named[0].length - word.length, narratives)
      : null;
    const partEnd = m.end + (part && named ? named[0].length : 0);
    const noShare = part ? FALLS_AFTER.test(text.slice(partEnd)) : NOT_A_SHARE.test(after);
    return noShare ? [] : [{ value: m.value, at: m.at, end: m.end, part, partEnd }];
  });
}
// "70% in stocks and the rest in cash", "70% ações e o resto em caixa".
const THE_REST = new RegExp(
  String.raw`(?<![\p{L}])(?:the\s+rest|the\s+remainder|o\s+resto|o\s+restante)\s+(?:(?:in|into|em|de|no|na|nos|nas)\s+)?(?:the\s+)?${partNamed('cls')}`,
  'giu',
);
// "60/40 stocks and bonds", "70-30 stocks and cash".
const PAIR_OF_PARTS = new RegExp(
  String.raw`(?<![\d.,%])(?<a>\d{1,2})\s*(?:\/|-)\s*(?<b>\d{1,2})\s+(?:(?:in|em)\s+)?${partNamed('first')}\s*(?:,|and|e|\/|&)\s*${partNamed('second')}`,
  'giu',
);
// "Half stocks, half cash", "half in stocks and half in gold", "metade em ações e metade em caixa".
const TWO_HALVES = new RegExp(
  String.raw`(?<![\p{L}])(?:half|metade)\s+(?:(?:in|em|no|na)\s+)?${partNamed('first')}\s*,?\s*(?:(?:and|e)\s+)?(?:the\s+other\s+half|a\s+outra\s+metade|half|metade)\s+(?:(?:in|em|no|na)\s+)?${partNamed('second')}`,
  'giu',
);
// "All of it in stocks", "everything into gold", "all in on stocks", "only credit", "just stocks", "I
// only want stocks", "nothing but stocks", "fully invested in equities", "tudo em ações", "tudo na
// bolsa", "só crédito", "só quero ações", "somente ouro", "nada além de ações".
const ALL_IN: RegExp[] = [
  String.raw`(?:all|everything)(?:\s+of\s+(?:it|my money|the money|this|that))?(?:\s+(?:of\s+)?(?:my|the)\s+money)?\s+(?:in\s+on|in|into)\s+(?:the\s+)?${partNamed('cls')}`,
  String.raw`(?:(?:only|just|purely|exclusively|entirely|solely)\s+(?:in\s+)?|only\s+want\s+|nothing\s+but\s+|fully\s+(?:invested\s+)?in\s+)(?:the\s+)?${partNamed('cls')}`,
  String.raw`tudo\s+(?:em|no|na|nos|nas)\s+${partNamed('cls')}`,
  String.raw`(?:(?:só|somente|apenas|exclusivamente)\s+(?:quero\s+)?(?:em\s+|no\s+|na\s+|nos\s+|nas\s+)?|nada\s+(?:al[eé]m\s+d[eoa]s?|mais\s+(?:do\s+)?que)\s+)${partNamed('cls')}`,
  // "So" with no accent, only before a Portuguese word: "so acoes".
  String.raw`so\s+(?:quero\s+)?(?:em\s+|no\s+|na\s+|nos\s+|nas\s+)?${partNamed('cls', CLASS_PT)}`,
].map((source) => new RegExp(`(?<![\\p{L}])${source}`, 'giu'));
// "Stocks only", and "all stocks" where it is all its clause says or follows a word of wanting.
const ALL_AFTER: RegExp[] = [
  new RegExp(String.raw`(?<![\p{L}])${partNamed('cls')}\s+only\s*(?=$|[,.;:!?\n])`, 'giu'),
  new RegExp(
    String.raw`(?<=^|[,.;:!?\n]\s*|(?<![\p{L}])(?:want|prefer|go|going|make\s+it|keep\s+it|be)\s+)all\s+${partNamed('cls')}\s*(?=$|[,.;:!?\n])`,
    'giu',
  ),
];
// "Only stocks and gold" names two parts with no shares: no mix is read, the person is asked.
const AND_ANOTHER = new RegExp(
  String.raw`^\s*(?:,|and|or|e|ou|&|\+)\s*(?:(?:in|em|no|na)\s+)?${partNamed('cls')}`,
  'iu',
);
// A mix said of a part of the money ("70% safe, and the other 30% all in stocks") is no mix of the
// plan: a share of the money is written before it in its clause.
const OF_A_PART =
  /(?:\d{1,3}\s*(?:%|percent|por cento)|(?<![\p{L}])(?:half|metade|the\s+rest|the\s+other|the\s+remainder|o\s+resto|o\s+restante|a\s+outra)(?![\p{L}]))/iu;

const sumOf = (parts: [MixPart, number][]) => parts.reduce((n, [, bps]) => n + bps, 0);

/**
 * The mix the text writes in percents, where it writes one: every percent of the money names a part,
 * and with "the rest" they are the whole. `unread`: percents name parts and this cannot be read one
 * way only (shares that are not the whole, a percent of the money that is in no part).
 */
function mixInPercents(text: string): MixSpan | 'unread' | null {
  const shares = percentsOfMoneyIn(text);
  const named = shares.filter((s) => s.part !== null);
  const [first] = named;
  if (!first) return null;
  const parts = named.map((s): [MixPart, number] => [s.part as MixPart, s.value * BPS_PER_PCT]);
  let end = Math.max(...named.map((s) => s.partEnd));
  const rest = [...text.matchAll(THE_REST)];
  const [theRest] = rest;
  const left = WHOLE_BPS - sumOf(parts);
  if (theRest && rest.length === 1 && left > 0) {
    const word = theRest.groups?.cls ?? '';
    const wordAt = theRest.index + theRest[0].length - word.length;
    const part = partNamedAt(text, word, wordAt, narrativeSpansIn(text));
    if (part) {
      parts.push([part, left]);
      end = Math.max(end, theRest.index + theRest[0].length);
    }
  }
  if (named.length !== shares.length || sumOf(parts) !== WHOLE_BPS) return 'unread';
  return { mix: mixOf(parts), at: first.at, end, whole: false };
}

/** Two parts with the two shares of a pair or of two halves, where no percent is written beside. */
function mixInTwoParts(text: string): MixSpan[] {
  if (percentsOfMoneyIn(text).length > 0) return [];
  const out: MixSpan[] = [];
  const narratives = narrativeSpansIn(text);
  const two = (m: RegExpExecArray, a: number, b: number) => {
    const [one, other] = [m.groups?.first ?? '', m.groups?.second ?? ''];
    const first = partNamedAt(text, one, m.index + m[0].indexOf(one), narratives);
    const second = partNamedAt(text, other, m.index + m[0].lastIndexOf(other), narratives);
    if (first && second && first !== second && a + b === WHOLE_BPS)
      out.push({
        mix: mixOf([
          [first, a],
          [second, b],
        ]),
        at: m.index,
        end: m.index + m[0].length,
        whole: false,
      });
  };
  for (const m of text.matchAll(PAIR_OF_PARTS))
    two(m, Number(m.groups?.a) * BPS_PER_PCT, Number(m.groups?.b) * BPS_PER_PCT);
  for (const m of text.matchAll(TWO_HALVES)) two(m, HALF_PCT * BPS_PER_PCT, HALF_PCT * BPS_PER_PCT);
  return out;
}

/** All of the money in one part, each place the text says so. */
function mixAllIn(text: string): MixSpan[] {
  const out: MixSpan[] = [];
  const narratives = narrativeSpansIn(text);
  for (const pattern of [...ALL_IN, ...ALL_AFTER])
    for (const m of text.matchAll(pattern)) {
      const word = m.groups?.cls ?? '';
      const part = partNamedAt(text, word, m.index + m[0].lastIndexOf(word), narratives);
      if (!part) continue;
      const end = m.index + m[0].length;
      const next = AND_ANOTHER.exec(text.slice(end));
      const other = next ? partOf(next.groups?.cls ?? '') : null;
      if (other !== null && other !== part) continue;
      out.push({ mix: mixOf([[part, WHOLE_BPS]]), at: m.index, end, whole: true });
    }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * A mix the text writes, the words it is written in, where, and how its clause says it. `part`: said
 * of a part of the money, not of the plan ("the other 30% all in stocks"). `classes`: the classes a
 * person can rule out that its words name ("all of it in stocks" names stocks), so a refusal of one
 * can be held against it.
 */
export type MixSaid = {
  mix: MixRead;
  words: string;
  stance: Stance | 'part';
  at: number;
  end: number;
  classes: Refused[];
};

// The classes a mix's words name, among those a person can rule out. "Bolsa" and "the stock market"
// are stocks here, as a part of a mix reads them.
const MIX_CLASS_NAMED: [Refused, RegExp][] = [
  [
    'stock',
    /(?<![\p{L}])(?:stock market|stocks?|equit(?:y|ies)|shares|a[cç][oõ]es|a[cç][aã]o|bolsa)(?![\p{L}])/iu,
  ],
  ['crypto', /(?<![\p{L}])(?:crypto\p{L}*|cripto\p{L}*|bitcoin)(?![\p{L}])/iu],
  ['gold', /(?<![\p{L}])(?:gold|ouro)(?![\p{L}])/iu],
  ['credit', /(?<![\p{L}])(?:credit|cr[eé]dito|high[- ]yield)(?![\p{L}])/iu],
];

/** The mix one text writes, `unread` where it writes one this file cannot read one way only. */
function mixReadIn(text: string): MixSaid | 'unread' | null {
  const percents = mixInPercents(text);
  if (percents === 'unread') return 'unread';
  const spans = percents ? [percents] : [...mixInTwoParts(text), ...mixAllIn(text)];
  const holdings = holdingsIn(text);
  const said = spans.map((s): MixSaid => {
    const stance = stanceIn(text, s.at, s.end, holdings, false);
    const ofAPart =
      s.whole && stance === 'stated' && OF_A_PART.test(clauseBefore(text, s.at, holdings, false));
    const words = text.slice(s.at, s.end);
    return {
      mix: s.mix,
      words: words.trim(),
      stance: ofAPart ? 'part' : stance,
      at: s.at,
      end: s.end,
      classes: MIX_CLASS_NAMED.flatMap(([what, pattern]) => (pattern.test(words) ? [what] : [])),
    };
  });
  return (
    said.find((s) => s.stance === 'stated') ??
    said.find((s) => s.stance === 'wondered' || s.stance === 'part') ??
    said[0] ??
    null
  );
}

/**
 * The mix the text writes and how it says it; null when it writes none, or writes one this file
 * cannot read one way only (shares that are not the whole, two parts with no shares, a percent of the
 * money that is in no part). Every share is written: nothing is filled in. Where the text writes more
 * than one, the one it states is given, else one it wonders about, else the first.
 */
export function mixSaidIn(text: string): MixSaid | null {
  const read = mixReadIn(text);
  return read === 'unread' ? null : read;
}

/** What separates two messages of a conversation in the text the intake reads. */
export const TURN_BREAK = '\n\n';

/**
 * The mix a conversation writes, message by message: the last word wins (the review of Oct 7). The
 * last message that says a mix of its own decides, whatever an earlier one said: "all of it in
 * stocks" then "Sorry, I meant 60% stocks and 40% cash" is 60 and 40, and then "not all in stocks"
 * is none. A message that says one of someone else or of another time decides nothing. Where no
 * message says one alone, the messages are read as one text ("70% in stocks" then "and the rest in
 * cash"). `turn` is the message it is written in; `at` and `end` are places in the messages joined
 * by `TURN_BREAK`.
 */
export function mixSaidInTurns(turns: readonly string[]): (MixSaid & { turn: number }) | null {
  const starts: number[] = [];
  let offset = 0;
  for (const turn of turns) {
    starts.push(offset);
    offset += turn.length + TURN_BREAK.length;
  }
  for (let t = turns.length - 1; t >= 0; t -= 1) {
    const read = mixReadIn(turns[t] ?? '');
    // The last word on the mix cannot be read alone: the messages are read together, below.
    if (read === 'unread') break;
    const start = starts[t] ?? 0;
    if (read && read.stance !== 'aside')
      return { ...read, at: read.at + start, end: read.end + start, turn: t };
  }
  const whole = mixSaidIn(turns.join(TURN_BREAK));
  if (!whole) return null;
  let turn = 0;
  for (const [t, start] of starts.entries()) if (start < whole.end) turn = t;
  return { ...whole, turn };
}

/**
 * The mix the text states as what the person wants held, with the words it is written in; null when
 * it states none (`mixSaidIn`).
 */
export function mixIn(text: string): { mix: MixRead; words: string } | null {
  const said = mixSaidIn(text);
  return said?.stance === 'stated' ? { mix: said.mix, words: said.words } : null;
}

// ---------------------------------------------------------------------------------------------------
// The narratives, read from the text.

const escaped = (words: string) => words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Where `words` are written in the text, case and spacing aside, as whole words. */
export function phraseIn(
  text: string,
  words: string,
): { words: string; at: number; end: number }[] {
  const tokens = words.trim().split(/\s+/).filter(Boolean).map(escaped);
  if (tokens.length === 0) return [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${tokens.join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
  return [...text.matchAll(pattern)].map((m) => ({
    words: m[0],
    at: m.index,
    end: m.index + m[0].length,
  }));
}

/**
 * A narrative's words in the text. `skipped` says why they are no ask, where they are none: `negated`
 * or `aside` (`Stance`), or `within`, written inside a longer reading or inside a name the caller
 * excepts. `wondered`: the person asks or hedges ("Should I invest in AI?"); the narrative is named,
 * and no share of the money is read for it.
 */
export type MarketMention = {
  market: Market;
  words: string;
  at: number;
  end: number;
  skipped: 'negated' | 'aside' | 'within' | null;
  wondered: boolean;
};

/**
 * Every place the text writes a narrative's words, in the order written. Where two readings share
 * words the longer is the one read ("AI infrastructure" is not also "AI"), and words that are a part
 * of one of the names in `except` are not read: "Chips" in a shared portfolio's name, "Chips &
 * Agents", names the portfolio. A name that is no longer than the words leaves them read: a portfolio
 * called "Big Tech" does not hide big tech. Words not read this way are kept as `within`, so a caller
 * can tell them from words not written.
 */
export function marketMentionsIn(text: string, except: readonly string[] = []): MarketMention[] {
  const names = except.flatMap((name) => phraseIn(text, name));
  const holdings = holdingsIn(text);
  const found = narrativeHitsIn(text).sort(
    (a, b) => b.end - b.at - (a.end - a.at) || a.at - b.at || a.order - b.order,
  );
  const read: Span[] = [];
  const out: MarketMention[] = [];
  for (const { market, words, at, end } of found) {
    const within =
      read.some((other) => other.at < end && at < other.end) ||
      names.some((n) => n.at <= at && end <= n.end && n.end - n.at > end - at);
    if (!within) read.push({ at, end });
    const stance = within ? null : stanceIn(text, at, end, holdings, true);
    out.push({
      market,
      words,
      at,
      end,
      skipped:
        stance === null ? 'within' : stance === 'negated' || stance === 'aside' ? stance : null,
      wondered: stance === 'wondered',
    });
  }
  return out.sort((a, b) => a.at - b.at || b.end - a.end);
}

/**
 * The narratives the text asks for, with the words of the first place each is asked, in the order of
 * `MARKET_IDS`.
 */
export function marketsIn(
  text: string,
  except: readonly string[] = [],
): { market: Market; words: string; at: number }[] {
  const asked = marketMentionsIn(text, except).filter((m) => m.skipped === null);
  return MARKET_IDS.flatMap((market) => {
    const first = asked.find((m) => m.market === market);
    return first ? [{ market, words: first.words, at: first.at }] : [];
  });
}

// How much of the money goes to a market, in the words just before it (gate EXPLICIT-MIX): "invest in
// big tech", "all of it in AI", "put it in US stocks" is the whole; "put $1,000 in AI" is that sum;
// "put 50% in big tech", "30% in AI", "half in AI" is that share. "I like AI", "I'm interested in big
// tech" say no share: it is asked.
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
const OF_THE_MONEY = String.raw`(?:\s+(?:of\s+(?:it|the\s+money|my\s+money)|d[oe]\s+(?:dinheiro|valor|total)))?`;
// "30% in AI", and "60% AI" as a person writes a list of shares.
const PERCENT_BEFORE = new RegExp(
  String.raw`(?<![\d.,])(?<pct>\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|percent|por cento)${OF_THE_MONEY}\s+(?:${INTO})?$`,
  'iu',
);
const HALF_BEFORE = new RegExp(
  String.raw`(?<![\p{L}])(?:half|metade)${OF_THE_MONEY}\s+${INTO}$`,
  'iu',
);
// A share is taken only in its plain forms (the review of Oct 7). The words that give it are the
// figure and what leads into it: a verb in the form that asks ("invest", "put", never "investing" or
// "invested"), what is put ("it", "all of it", "everything"), a sum, a percent or a half, and "in".
// They open their clause, or follow the person's own words of wanting ("I want to", "I'd like to",
// "let's", "my plan is to", "I have $5,000 to"). After any other word they are not read as a share
// of this money: "I can lose 30% in AI", "at least 30% in big tech", "I put $500 in AI last year",
// "I'm afraid to invest in AI", "70% of experts say invest in AI", "it would be reckless to put it
// all in big tech". A list of what is read, not of what is not: a form that is missing here is
// asked, never taken.
const ASK_VERB =
  'invest|put|place|allocate|buy|add|keep|hold|have|go|move|investir|invista|aplicar|aplique|colocar|coloque|coloca|botar|bote|bota|p[oô]r|ponha|comprar|compre|ter';
const ASK_OBJECT = String.raw`it(?:\s+all)?|all(?:\s+of\s+(?:it|this|that|my\s+money|the\s+money))?|everything|(?:all\s+)?(?:my|the)\s+money|this|that|tudo|isso|(?:todo\s+)?o\s+(?:meu\s+)?dinheiro|(?:todo\s+)?meu\s+dinheiro`;
// A sum, a percent or a half, as a person writes one: "$500", "US$ 2.000", "2 mil dólares", "30%",
// "30 percent", "half of it", "the other half".
const ASK_SUM = String.raw`(?:(?:us\$|u\$s|usd|\$)\s*)?\d[\d.,]*(?:\s*(?:k|mil|thousand))?(?:\s*(?:de\s+)?(?:%|percent|por\s+cento|dollars|d[oó]lares|bucks|usd))?`;
const ASK_FIGURE = String.raw`(?:(?:the\s+other|another|the|my|a\s+outra|os\s+outros|os|meus)\s+)?(?:${ASK_SUM}|half|metade)(?:\s+(?:of\s+(?:it|the\s+money|my\s+money)|d[oe]\s+(?:dinheiro|valor|total)))?`;
// The person's own words of wanting, right before the ask.
const OWN_LEAD = String.raw`(?:i|we)(?:['’]d|\s+would)?\s+(?:want|like|love|prefer|wish|plan|intend)(?:\s+to)?|(?:i|we)(?:['’]ll|\s+will)|(?:i|we)(?:['’]d|\s+would)\s+rather|(?:i|we)(?:['’]ve|\s+have)?\s+decided\s+to|(?:my|our)\s+(?:plan|goal|idea|aim)\s+is\s+to|(?:(?:i['’]?m|i\s+am|we['’]?re|we\s+are)\s+)?(?:going|looking|hoping|planning|ready)\s+to|(?:i|we)(?:['’]ve)?\s+(?:have|got|have\s+got)\s+${ASK_SUM}\s+(?:that\s+(?:i|we)\s+(?:want|would\s+like)\s+)?to|let['’]?s|(?:eu\s+|n[oó]s\s+)?(?:quero|queria|queremos|gostaria\s+de|gostar[ií]amos\s+de|vou|vamos|pretendo|prefiro|desejo)|(?:eu\s+)?tenho\s+${ASK_SUM}\s+para|(?:meu|nosso|a)\s+(?:objetivo|plano|ideia)\s+[eé]`;
// A small word that carries on at the start of a clause: "and", "then", "so", "please".
const CARRIES_ON = String.raw`and|so|then|also|now|just|plus|ok(?:ay)?|yes|well|please|instead|make\s+(?:it|that)|e|mais|ent[aã]o|tamb[eé]m|agora|por\s+favor`;
const PLAIN_ASK = new RegExp(
  String.raw`(?:^(?:(?:${CARRIES_ON})\s+)*|(?<![\p{L}'’])(?:${OWN_LEAD})\s+)(?:(?:${ASK_VERB})\s+)?(?:(?:${ASK_OBJECT})\s+)?(?:${ASK_FIGURE}\s+)?(?:(?:in|into|on|em|no|na|nos|nas)\s+)?(?:(?:the|a|o|os|as)\s+)?$`,
  'iu',
);
/**
 * Whether the words that lead into a holding written at `at` are a plain ask: its clause, up to
 * the holding, is the ask and nothing else, but for the person's own words of wanting before it.
 */
const plainAskBefore = (text: string, at: number, holdings: Span[]): boolean =>
  PLAIN_ASK.test(`${clauseBefore(text, at, holdings, true).replace(/\s+/g, ' ').trim()} `);
// What goes with a refusal ("no stocks" is no stocks through a fund either) is left out with it,
// unless the text then holds it. A class named after the refusal holds it only where its own clause
// says so: the person asks for it in a plain form, it stands on the far side of a contrast from the
// refusal ("no stocks, but ETFs"), or the clause goes on to say something of it ("ETFs are fine"). A
// class the refusal's clause only goes on to name carries the refusal on, whatever joins it
// ("including ETFs", "Same goes for ETFs.", "isso vale para ETFs"): the third review found those
// read as "the funds are fine".
const CONTRAST =
  /(?<![\p{L}])(?:but|however|though|although|whereas|yet|except|mas|por[eé]m|contudo|todavia|exceto|salvo)(?![\p{L}])/iu;
// A verb that says something of what was just named: "are fine", "would be ok", "são bem-vindos".
const SAID_OF_IT_AFTER =
  /^[^\S\n]*(?:is|are|was|were|would|will|can|could|may|might|should|seems?|sounds?|looks?|feels?|[eé]|s[aã]o|est[aá]|est[aã]o|seria|seriam|pode|podem|parece|parecem|fica|ficam)(?![\p{L}])/iu;
/**
 * Whether a class named from `at` up to `end`, after a refusal that ends at `from`, is said as
 * something the plan may hold.
 */
export function classKeptAfter(text: string, from: number, at: number, end: number): boolean {
  if (stanceOf(text, at, end) !== 'stated') return false;
  const sentenceFrom = at - sentenceBefore(text, at).length;
  return (
    plainAskBefore(text, at, holdingsIn(text)) ||
    (from >= sentenceFrom && CONTRAST.test(text.slice(from, at))) ||
    SAID_OF_IT_AFTER.test(text.slice(end))
  );
}

// A percent is a share of the money only in its plain forms too (the review of Oct 7: "I can lose
// 30% and I am 70% sure" passed for a 70/30 split, and "70% of experts say" asked one). It opens its
// clause or follows a word that asks for it or joins it to another share ("keep 30% safe", "70% safe
// and 30% to grow", "the other 30%"). And it leads into where that share goes: a place ("30% in
// cash", "70% for the goal"), a part of a mix ("70% stocks"), or how it is kept ("70% safe", "30%
// high risk"), with the money named before it or not ("70% of it in"). A percent that says neither
// ("20% at most", "maybe 20%", "I am 70% sure") or is of something else ("70% of experts") is no
// share of a split.
const SHARE_LEAD = new RegExp(
  String.raw`(?:^|[.!?,;:(]|(?<![\p{L}])(?:${ASK_VERB}|leave|want|like|with|and|or|but|so|plus|then|the\s+other|another|the\s+remaining|make\s+(?:it|that)|deixar|deixe|quero|queria|com|e|ou|mas|mais|ent[aã]o|a\s+outra|os\s+outros))\s*$`,
  'iu',
);
const SHARE_GOES = new RegExp(
  String.raw`^(?:\s+(?:of\s+(?:it|this|that|the\s+(?:money|total|plan|portfolio|amount|savings|whole)|my\s+(?:money|savings|plan|portfolio))|d[oe]\s+(?:dinheiro|valor|total|plano|montante)))?\s+(?:all\s+)?(?:(?:in|into|on|for|to|toward|towards|em|no|na|nos|nas|para|pra)(?![\p{L}])|(?:${CLASS_ANY})(?![\p{L}])|(?:safe|safely|secure|liquid|risky|growth|conservative|aggressive|stable|invested|kept|stays?|goes|low|medium|high|part|seguro|segura|seguros|l[ií]quido|arriscado|conservador|agressivo|investido|guardado|baixo|m[eé]dio|alto)(?![\p{L}]))`,
  'iu',
);
/** The percents the text writes as shares of the money in their plain forms, in the order written. */
function plainSharesIn(text: string): PercentOfMoney[] {
  return percentsOfMoneyIn(text).filter(
    (m) =>
      SHARE_LEAD.test(sentenceBefore(text, m.at)) &&
      (m.part !== null || SHARE_GOES.test(text.slice(m.end))),
  );
}

// Another holding named right after this one, joined to it: "big tech and gold", "AI and defense".
const JOINED_NEXT =
  /^\s*(?:,|and|or|e|ou|&|\+)\s*(?:(?:in|em|no|na)\s+)?(?:(?:the|a|o|os|as)\s+)?/iu;
const anotherAfter = (text: string, end: number, holdings: Span[]): boolean => {
  const join = JOINED_NEXT.exec(text.slice(end));
  return join !== null && holdings.some((h) => h.at === end + join[0].length);
};

/** A share of the money said of a market: the whole, a sum in dollars, or a percent of it. */
export type MarketShare =
  | { kind: 'whole' }
  | { kind: 'amount'; value: number }
  | { kind: 'percent'; value: number }
  | null;

/**
 * The share of the money the text gives a market written at `at`: the whole, a sum, a percent, or
 * none said. With `end`, where the market's words end: "invest in big tech and gold" names two things
 * and gives the whole to neither.
 */
export function marketShareIn(text: string, at: number, end?: number): MarketShare {
  const share = shareBefore(sentenceBefore(text, at));
  if (share === null) return null;
  const holdings = holdingsIn(text);
  if (!plainAskBefore(text, at, holdings)) return null;
  // Two things named after one share ("invest in AI and defense", "30% in AI and chips") share it:
  // it goes to neither.
  return end !== undefined && anotherAfter(text, end, holdings) ? null : share;
}

/** The share the words of a sentence up to a market give it, whoever says them and however. */
function shareBefore(before: string): MarketShare {
  const amount = AMOUNT_BEFORE.exec(before);
  if (amount) {
    const m = mentionsIn(amount.groups?.amt ?? '').find((x) => x.kind === 'amount' && !x.perMonth);
    if (m && (m.currency === null || m.currency === 'USD'))
      return { kind: 'amount', value: m.value };
  }
  const percent = PERCENT_BEFORE.exec(before);
  // A percent may be written with a decimal mark, a point or a comma: "0.5%", "2,5%".
  if (percent)
    return { kind: 'percent', value: Number((percent.groups?.pct ?? '').replace(',', '.')) };
  if (HALF_BEFORE.test(before)) return { kind: 'percent', value: HALF_PCT };
  return WHOLE_BEFORE.test(before) ? { kind: 'whole' } : null;
}

// Where the rest of the money goes, said beside a share: "30% in AI and the rest in stocks", "keep
// the rest in bitcoin", "e o resto em ouro". The words, then at most a few that lead into what holds
// it. "The rest can take up to 3 months to get out" names nothing that holds it.
const THE_REST_GOES =
  /(?<![\p{L}])(?:the\s+rest|the\s+remainder|the\s+remaining|what(?:['’]s|\s+is)\s+left|the\s+other\s+(?:half|\d{1,3}\s*%)|o\s+resto|o\s+restante|a\s+outra\s+metade|os\s+outros\s+\d{1,3}\s*%)(?:\s+(?:of\s+it|of\s+the\s+money|do\s+dinheiro))?(?:\s+(?:stays?|goes|kept|is|should\s+be|fica|vai|deve\s+ficar))?\s+(?:(?:in|into|to|em|no|na|nos|nas|para)\s+)?(?:the\s+|something\s+|algo\s+)?(?<held>\p{L}+(?:[- ]\p{L}+)?)/giu;
// A half or a percent that leads into a part of a mix, beside a narrative's share: "half in stocks
// and half in AI", "metade em ações".
const HALF_OF_A_PART = new RegExp(
  String.raw`(?<![\p{L}])(?:half|metade)\s+(?:(?:in|em|no|na)\s+)?(?:the\s+)?${partNamed('cls')}`,
  'giu',
);
const KEPT_SAFE = /^(?:cash|caixa|safe|safely|seguro|segura|seguran[cç]a|liquid|l[ií]quido)$/iu;
// What the safe-yield sleeve holds: dollar yield from a rate alone, or cash.
const SAFE_PARTS: readonly MixPart[] = ['cash', 'dollarYield'];

/**
 * Where the text says the rest of the money goes, beside a share it gives a narrative (the review of
 * Oct 7): `safe` where it is cash or kept safe ("30% in AI and the rest in cash"), which the
 * safe-yield sleeve holds; `other` where it is anything else ("the rest in stocks", "half in stocks
 * and half in AI", "o resto em ouro"), which no sleeve holds by guessing: the split is asked. Null:
 * the text does not say.
 */
export function restOfMoneyIn(text: string): 'safe' | 'other' | null {
  const narratives = narrativeSpansIn(text);
  const held: ('safe' | 'other')[] = [];
  for (const m of text.matchAll(THE_REST_GOES)) {
    const words = m.groups?.held ?? '';
    const [first = ''] = words.split(/[- ]/);
    const part = partOf(words) ?? partOf(first);
    if (KEPT_SAFE.test(first) || (part && SAFE_PARTS.includes(part))) held.push('safe');
    else if (part) held.push('other');
  }
  for (const m of text.matchAll(HALF_OF_A_PART)) {
    const word = m.groups?.cls ?? '';
    const part = partNamedAt(text, word, m.index + m[0].length - word.length, narratives);
    if (part) held.push(SAFE_PARTS.includes(part) ? 'safe' : 'other');
  }
  return held.includes('other') ? 'other' : held.includes('safe') ? 'safe' : null;
}

// What is carved out of a share, right after the narrative: "all of it in AI except $1,000 that I
// need in cash", "tudo em IA menos US$ 1.000".
const CARVED_OUT =
  /^[^.;!?\n]*?(?<![\p{L}])(?:except(?:\s+for)?|but\s+not|minus|less|apart\s+from|other\s+than|save\s+for|exceto|menos|tirando|fora)\s+(?:(?:us\$|r\$|\$)\s*)?\d/iu;
/** Whether the text carves a sum or a share out of what it gives the narrative that ends at `end`. */
export const carvedOutAfter = (text: string, end: number): boolean =>
  CARVED_OUT.test(text.slice(end));

/**
 * Whether the words written from `from` up to `to` (one message) say something else about money
 * or holdings than what is `accounted` for: the asks the message is read for, each from its figure
 * to the end of what it names, the refusals, and a mix the text states (read by its own rule beside
 * a narrative). What is left over is a sum written as
 * money that is not the goal's own (`amountUsd`), a percent, or a word for something to hold. The
 * third review (Oct 7): a share was taken beside "except for a $1,000 cushion", "and the balance in
 * stocks", "but only 10%" and "and some gold too". No such phrase is listed here: whatever the
 * plain form did not account for is found by what it is, a sum, a percent or a holding.
 *
 * A time frame, a rate a month and the goal's own sum say nothing of a share. With `restSafe`, the
 * words for what is kept safe do not either ("30% in AI and the rest in cash" is the plain form).
 */
export function saysMoreIn(
  text: string,
  from: number,
  to: number,
  accounted: readonly Span[],
  amountUsd: number | null,
  restSafe: boolean,
): boolean {
  const inside = (at: number, end: number) => accounted.some((s) => s.at <= at && end <= s.end);
  // A figure belongs to the ask it leads into: nothing but small words between it and the ask.
  const leadsIn = (end: number) =>
    accounted.some(
      (s) =>
        end <= s.at &&
        s.at - end <= INTAKE_LIMITS.shareLeadChars &&
        !/[,;.!?\n]/u.test(text.slice(end, s.at)),
    );
  // Only this message is read: a number or a word of another message is none of its own.
  const figures = mentionsIn(text.slice(from, to)).map((m) => ({
    ...m,
    at: m.at + from,
    end: m.end + from,
  }));
  for (const m of figures) {
    if (inside(m.at, m.end) || leadsIn(m.end)) continue;
    if (m.kind === 'percent') return true;
    if (m.kind === 'amount' && m.money && !m.perMonth && m.value !== amountUsd) return true;
  }
  // One part of the whole said in words is a share too: "half in AI... or was it a third?".
  for (const m of text.slice(from, to).matchAll(PART_SAID)) {
    const [at, end] = [m.index + from, m.index + from + m[0].length];
    if (!inside(at, end) && !leadsIn(end)) return true;
  }
  // A word for a class written right after what an ask names is part of its name ("AI stocks").
  const namesIt = (at: number) =>
    accounted.some((s) => s.end <= at && text.slice(s.end, at).trim() === '');
  // A part of a mix ("stocks", "gold", "cash") or a class a person can rule out ("ETFs").
  const words = [
    ...[...text.slice(from, to).matchAll(CLASS_WORD)].map((m) => ({
      at: m.index + from,
      end: m.index + from + m[0].length,
      word: m[0],
    })),
    ...classMentionsIn(text.slice(from, to)).map((m) => ({
      at: m.at + from,
      end: m.end + from,
      word: text.slice(m.at + from, m.end + from),
    })),
  ];
  for (const { at, end, word } of words) {
    if (inside(at, end) || namesIt(at)) continue;
    if (restSafe && SAFE_PARTS.includes(partOf(word) ?? 'growth')) continue;
    // Something to hold, or that the person wonders about holding: one its clause rules out, or
    // says of someone else, is no other holding ("I don't want bonds, invest in big tech").
    const stance = stanceOf(text, at, end);
    if (stance === 'stated' || stance === 'wondered') return true;
  }
  return false;
}

/**
 * The sums the words written from `from` up to `to` (one message) write that could be the sum put
 * in, each value once, in the order written. A sum written as money, not a rate a month, not in
 * another currency, and not a share of the money, which is a sum that leads into what it is put in
 * (`placed`: a narrative, a mix, a refusal, a shared portfolio's name) or into a word for a class
 * ("$500 in big tech", "$1,000 in cash"). With `bare`, for a text that writes no sum as money: the
 * bare numbers that could be one, which leaves out one said of the person ("I am 35"), one of a
 * pair ("70/30") and one inside what is placed ("the S&P 500").
 *
 * The third review (Oct 7): "I have $5,000 and owe $2,000 on my card" with a reply that gave the
 * debt made a plan of $2,000, and "My daughter is 12 and I want to invest 5000" one of $12. Nothing
 * in code reads which of two figures is the one put in, so where a message writes several the reply
 * is the one reader, and the amount is asked.
 */
export function sumsWrittenIn(
  text: string,
  from: number,
  to: number,
  placed: readonly Span[],
  bare = false,
): number[] {
  const message = text.slice(from, to);
  const within = (spans: readonly Span[], at: number, end: number) =>
    spans.some((s) => s.at <= at && end <= s.end);
  const into = [
    ...placed,
    ...[...message.matchAll(CLASS_WORD)].map((m) => ({
      at: m.index + from,
      end: m.index + from + m[0].length,
    })),
  ];
  const share = (at: number, end: number) =>
    within(into, at, end) ||
    into.some(
      (s) =>
        end <= s.at &&
        s.at - end <= INTAKE_LIMITS.shareLeadChars &&
        !/[,;.!?\n]/u.test(text.slice(end, s.at)),
    );
  // Where a figure's own characters start: a mention may open on the space before them.
  const startOf = (m: Mention) => m.end - m.text.length + from;
  const pairs = [...message.matchAll(PAIR)].map((m) => ({
    at: m.index + from,
    end: m.index + from + m[0].length,
  }));
  const sums = mentionsIn(message)
    .filter((m) => m.kind === 'amount' && !m.perMonth)
    .filter((m) =>
      bare
        ? !m.money &&
          m.currency === null &&
          !AGE_BEFORE.test(tailBefore(message, m.at)) &&
          !within(pairs, startOf(m), m.end + from)
        : m.money && (m.currency === null || m.currency === 'USD'),
    )
    .filter((m) => !share(startOf(m), m.end + from))
    .map((m) => m.value);
  return [...new Set(sums)];
}

// A name the person rules out that is no class and no narrative: "no Tesla", "without Tesla", "I do
// not want Tesla or Meta". A plan leaves out a class, never one name of a list it holds, so this is
// said and not applied (the review of Oct 7). The name is written with a capital, after the refusal.
const NAME_AFTER = new RegExp(
  String.raw`(?<lead>${NEG})\s+(?<name>\p{L}[\p{L}\d]*(?:\s+(?:or|and|nor|ou|e|nem)\s+\p{L}[\p{L}\d]*)*)`,
  'giu',
);
const CAPITAL = /^\p{Lu}[\p{L}\d]+$/u;
/** A name as it is compared: no accents, no case, its words one space apart. */
const nameKey = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The names the text rules out that a plan cannot leave out: written with a capital after a refusal,
 * no class a person can rule out, no part of a mix and no narrative, and a name the person's shelf
 * knows. The words as written ("no Tesla", "do not want Tesla or Meta").
 *
 * `known` is what makes a capitalised word a name (the third review, Oct 7: "No IRA", "not in
 * January" and "sem Deus" were said back as a company left out): the companies the caller knows on
 * the person's chain, each by its name, its ticker or its token's symbol. A written word is one of
 * them where it is the name or the words the name starts with ("Tesla" for "Tesla, Inc."). A word
 * nobody knows says nothing; with no names handed in, nothing is a name.
 */
export function namesRuledOutIn(
  text: string,
  known: readonly string[],
): { words: string; at: number }[] {
  const keys = known.map(nameKey).filter(Boolean);
  if (keys.length === 0) return [];
  const isKnown = (word: string): boolean => {
    const key = nameKey(word);
    return key !== '' && keys.some((k) => k === key || k.startsWith(`${key} `));
  };
  const read = [
    ...narrativeSpansIn(text),
    ...classMentionsIn(text),
    ...[...text.matchAll(CLASS_WORD)].map((m) => ({ at: m.index, end: m.index + m[0].length })),
  ];
  const out: { words: string; at: number }[] = [];
  for (const m of text.matchAll(NAME_AFTER)) {
    const { lead = '', name = '' } = m.groups ?? {};
    const nameAt = m.index + m[0].length - name.length;
    const names = name.split(/\s+(?:or|and|nor|ou|e|nem)\s+/iu);
    // Every item a name of its own: a capital, a name the shelf knows, and no word the intake reads
    // as something else.
    if (!names.every((word) => CAPITAL.test(word) && isKnown(word))) continue;
    if (read.some((k) => k.at < m.index + m[0].length && nameAt < k.end)) continue;
    // "Never" and "no" that open a sentence before a capitalised word rule nothing out by name.
    if (/^(?:never|neither|nor|nunca|nem)$/iu.test(lead.trim())) continue;
    out.push({ words: m[0].replace(/\s+/g, ' '), at: m.index });
  }
  return out;
}

/**
 * The text with the percent or the half said of each market written at these places blanked ("30%"
 * in "30% in AI", "half" in "half in big tech"), every other character where it was. What `splitIn`
 * reads of it is no market's share.
 */
export function withoutMarketShares(text: string, ats: readonly number[]): string {
  let out = text;
  for (const at of ats) {
    const before = sentenceBefore(text, at);
    const share = PERCENT_BEFORE.exec(before) ?? HALF_BEFORE.exec(before);
    if (!share) continue;
    const from = at - before.length + share.index;
    out = `${out.slice(0, from)}${' '.repeat(at - from)}${out.slice(at)}`;
  }
  return out;
}

const plain = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= INTAKE_LIMITS.nameWordChars);
/** Whether two words are one: the same, one the plural of the other, or with one long stem. */
const sameWord = (a: string, b: string): boolean => {
  if (a === b || `${a}s` === b || `${b}s` === a) return true;
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return shared >= INTAKE_LIMITS.sameStemChars;
};
// The words that say a kind of holding and nothing of which one ("defense stocks", "the insurance
// sector", "empresas de seguros"), with the articles that go with them: what a person's words for a
// filter's value may carry beside the value's own words. A list, as the fixed word lists of the
// narratives write the same kinds ("space stocks|industry|sector|companies"): without it every
// faithful reply that quotes "advertising businesses" for "advertising" would be asked.
const KIND_WORDS = [
  'the',
  'and',
  'stock',
  'share',
  'equities',
  'equity',
  'company',
  'companies',
  'firm',
  'business',
  'businesses',
  'name',
  'maker',
  'producer',
  'sector',
  'industry',
  'industries',
  'acoes',
  'acao',
  'empresa',
  'companhia',
  'setor',
  'industria',
  'fabricante',
  'papeis',
  'uma',
  'dos',
  'das',
];
/**
 * Whether the person's words write the value a filter must carry (the review of Oct 7: "invest in my
 * future" with a model's filter by sector filled a sleeve): "defense stocks" for "Aerospace &
 * Defense", "insurers" for "Insurance", "restaurants" for "Hotels, Restaurants & Leisure". Where they
 * do not ("obesity drugs" for "GLP-1", "my future" for "Consumer Discretionary"), the link between
 * the two is the model's alone: one reader, so it is asked, never taken.
 *
 * The person's words for the thing must be the value's words (the third review, Oct 7: one shared
 * everyday word was enough, so "my financial future" wrote Financials and "my emergency fund" wrote
 * index fund). Two things must hold. They write one whole item of the value, every word of it: a
 * value lists its items with "&", "," or "and" ("Defense" in "Aerospace & Defense"), and a word of
 * an item is not the item ("the markets" is not "Capital Markets"). And they say nothing else: every
 * other word of theirs is a word of the value or says a kind of holding ("stocks", "sector").
 */
export function wordsWrite(words: string, value: string): boolean {
  const written = plain(words);
  const writes = (word: string) => written.some((w) => sameWord(word, w));
  const items = value
    .split(/\s*(?:&|,|\/|(?<![\p{L}])and(?![\p{L}]))\s*/iu)
    .map(plain)
    .filter((item) => item.length > 0);
  if (!items.some((item) => item.every(writes))) return false;
  const ofValue = plain(value);
  return written.every(
    (w) => ofValue.some((v) => sameWord(v, w)) || KIND_WORDS.some((k) => sameWord(k, w)),
  );
}

// A word that puts money in a shared portfolio or picks it, right before its name: "starting from
// The Seven", "invest in the 500", "I want the seven", "go with Storm Cellar".
const PICKS =
  /(?<![\p{L}])(?:from|in|into|on|with|like|want|choose|pick|use|follow|copy|prefer|take|buy|hold|de|d[oa]|em|n[oa]|com|quero|prefiro|escolho|usar|seguir|copiar)\s+$/iu;
// The name alone, as an answer is: "The Seven", "ok, the seven please".
const ALONE_BEFORE = /(?:^|[.,;:!?\n])\s*(?:(?:ok(?:ay)?|yes|sure|then|sim|ent[aã]o)[\s,]+)*$/iu;
const ALONE_AFTER = /^(?:\s+(?:please|thanks|portfolio|por\s+favor))*\s*(?:$|[.,;!?\n])/iu;
// Where a sentence starts, so that a capital there is the sentence's and not the name's.
const SENTENCE_START = /(?:^|[.!?\n])\s*$/u;
// The name runs on into a longer one: "The 500 Club".
const RUNS_ON = /^[^\S\n]+\p{Lu}/u;

/**
 * How the text says a shared portfolio's name written from `at` up to `end` (the review of Oct 7:
 * "the seven of us are saving" started a plan from The Seven). A portfolio's name must be said as a
 * holding, as a narrative's everyday words must. `held`: its clause states it, and it stands alone,
 * or after a word that puts money there or picks it. `negated`, `aside`: its clause rules it out or
 * says it of something else. `wondered`: the person asks or hedges. `unsure`: the words are written,
 * and nothing says they name the portfolio ("the seven of us", "the 500 reasons").
 *
 * Words that are the name and words that only could be are told apart (the third review, Oct 7: "The
 * 500 dollars I saved", "We want the seven of us to retire", "Take the 500 I owe you"). Written as
 * the shelf writes it (`exact`: its slug, or its capitals where a capital is the name's own and not
 * the sentence's, and no capitalised word runs on from it), inside a sentence, it is the name. Any
 * other writing of it needs a word that picks it before it and must end its clause, so that it is
 * not the start of something else. A name that opens its sentence has something said of it ("Home
 * Team lost again"), which picks nothing.
 */
export function portfolioSaidAt(
  text: string,
  at: number,
  end: number,
  exact: boolean,
): 'held' | 'negated' | 'aside' | 'wondered' | 'unsure' {
  const stance = stanceOf(text, at, end);
  if (stance === 'negated' || stance === 'aside') return stance;
  const before = text.slice(0, at);
  const after = text.slice(end);
  const written = text.slice(at, end);
  // Its slug is no everyday word. Its capitals are the name's own where one of them stands where
  // a sentence would not write one.
  const ownCapital = SENTENCE_START.test(before)
    ? /\p{Lu}/u.test(written.replace(/^\P{L}*\p{L}+/u, ''))
    : /\p{Lu}/u.test(written);
  const asTheShelf = exact && !RUNS_ON.test(after) && (ownCapital || !/\p{Lu}|\s/u.test(written));
  const alone = ALONE_BEFORE.test(before) && ALONE_AFTER.test(after);
  // Words that are not written as the name need a word that picks them, and to end their clause.
  const picked = PICKS.test(before) && ALONE_AFTER.test(after);
  // Written as the name inside a sentence: the sentence leads to it. Where it opens the sentence
  // something is said of it ("Home Team lost again", "The Seven looks good"), which picks nothing.
  const named = asTheShelf && !SENTENCE_START.test(before);
  if (!alone && !picked && !named) return 'unsure';
  return stance === 'wondered' ? 'wondered' : 'held';
}

// A share said as the whole of a message, in answer to "how much": "70-30", "half", "all of it",
// "50%", "$500". A few words may come before and after ("its 70-30", "make it half please").
const SAID_BEFORE = String.raw`^\s*(?:(?:it['’]?s|make\s+it|let['’]?s\s+(?:do|say|go)|i['’]?d\s+say|i\s+would\s+say|go|ok(?:ay)?|sure|yes|well|then|put|just|about|around|acho\s+que|pode\s+ser|vamos\s+de|digamos|uns)[\s,:]+)*`;
const SAID_AFTER = String.raw`(?:[\s,]*(?:please|then|thanks|i\s+guess|i\s+think|of\s+it|of\s+the\s+money|do\s+dinheiro|por\s+favor))*[\s.!]*$`;
const saidAlone = (source: string) => new RegExp(`${SAID_BEFORE}(?:${source})${SAID_AFTER}`, 'iu');
const PAIR_SAID = saidAlone(
  String.raw`(?<a>\d{1,2})\s*%?\s*(?:-|\/|x|to|e|and)\s*(?<b>\d{1,2})\s*%?`,
);
const PERCENT_SAID = saidAlone(String.raw`(?<pct>\d{1,3})\s*(?:%|percent|por cento)`);
const HALF_SAID = saidAlone(String.raw`half(?:\s+and\s+half)?|metade(?:\s+e\s+metade)?`);
// "A third", "a quarter", "um terço": one part of that many, in the order of this list from three up.
const PART_WORDS = ['third|ter[cç]o', 'quarter|fourth|quarto'];
/** One part of the whole in words, wherever a text writes it: "half", "a third", "um quarto". */
const PART_SAID = new RegExp(
  String.raw`(?<![\p{L}])(?:half|metade|(?:a|one|um|uma)\s+(?:${PART_WORDS.join('|')}))(?![\p{L}])`,
  'giu',
);
const ONE_PART_OF = PART_WORDS.map((words) =>
  saidAlone(String.raw`(?:a|one|um|uma)\s+(?:${words})`),
);
const HALVES = 2;
const WHOLE_SAID = saidAlone(
  String.raw`all(?:\s+of\s+it)?|everything|the\s+whole\s+(?:thing|amount|lot)|tudo|todo|inteiro`,
);

// "None" as the whole of a message, in answer to "how much": "none", "zero", "0%", "nothing". A
// quantity, never a bare "no": that may answer another question asked with this one.
const NONE_SAID = saidAlone(
  String.raw`none(?:\s+of\s+it)?|nothing|zero|nada|nenhum[a]?|(?:\$\s*)?0(?:\s*(?:%|percent|por cento|dollars|d[oó]lares))?`,
);
// And said of what was asked about: "nothing for AI", "none in big tech", "nada para IA".
const NONE_FOR =
  /^\s*(?:none|nothing|zero|no\s+money|nada|nenhum[a]?|0\s*%?)\s+(?:of\s+it\s+)?(?:for|in|on|to|into|para|em|no|na|nos|nas)\s+(?:the\s+|a\s+|o\s+|os\s+|as\s+)?$/iu;

/**
 * Whether a message says "none" in answer to how much of the money goes to something: alone ("none",
 * "zero", "0%"), or of one of `named`, the words the question asked about ("nothing for AI, I just
 * mentioned my job"). A negation of its own ("I do not want AI") is read with the rest of the text.
 */
export function noneSaidIn(message: string, named: readonly string[] = []): boolean {
  if (NONE_SAID.test(message)) return true;
  return named.some((words) =>
    phraseIn(message, words).some((m) => NONE_FOR.test(message.slice(0, m.at))),
  );
}

// A plain yes or no as the whole of a message: "yes", "that's right", "ok", "sim", "isso"; "no",
// "that's not what I meant", "não". It says no share of its own, so it is read only against a
// question that has a start: a yes takes the start, a no leaves it.
const POLITE = String.raw`(?:[\s,.!]+(?:please|thanks|thank\s+you|por\s+favor|obrigad[oa]))*[\s.!]*$`;
const YES_SAID = new RegExp(
  String.raw`^\s*(?:yes|yeah|yep|yup|ok(?:ay)?|sure|right|correct|exactly|confirm(?:ed)?|that(?:['’]s|\s+is)\s+(?:right|correct|it|what\s+i\s+meant)|sim|isso(?:\s+mesmo)?|[eé]\s+isso(?:\s+mesmo)?|correto|certo|exato|exatamente|confirmo)${POLITE}`,
  'iu',
);
const NO_SAID = new RegExp(
  String.raw`^\s*(?:no|nope|nah|n[aã]o)(?:[\s,.]+(?:that(?:['’]s|\s+is)\s+not\s+(?:it|right|what\s+i\s+meant)|n[aã]o\s+(?:[eé]|era)\s+isso))?${POLITE}`,
  'iu',
);
/**
 * Whether a message says only yes, or only no: an answer to a question that has a start to say yes
 * or no to, and no share or mix of its own. Null for any other message.
 */
export const yesOrNoSaidIn = (message: string): 'yes' | 'no' | null =>
  YES_SAID.test(message) ? 'yes' : NO_SAID.test(message) ? 'no' : null;

// An even split as the whole of a message, in answer to how the money is split between the things
// named: "half each", "50-50", "equally", "meio a meio", "metade para cada".
const EVEN_SAID = saidAlone(
  String.raw`half\s+each|half\s+and\s+half|50\s*%?\s*(?:-|\/|e|and)\s*50\s*%?|fifty[- ]fifty|equally|evenly|equal\s+(?:parts|shares)|split\s+(?:it\s+)?(?:evenly|equally)|(?:the\s+)?same\s+(?:for|in)\s+(?:each|both)|meio\s+a\s+meio|metade\s+(?:para\s+|em\s+)?cada(?:\s+um[a]?)?|metade\s+e\s+metade|igualmente|(?:em\s+)?partes\s+iguais`,
);
/** Whether a message says only that the money is split evenly between what was named. */
export const evenSplitSaidIn = (message: string): boolean => EVEN_SAID.test(message);

/** A share as a message alone says it: the two of a pair, a percent, a sum, or the whole. */
export type ShareSaid =
  | { kind: 'whole' }
  | { kind: 'percent'; value: number }
  | { kind: 'amount'; value: number }
  | { kind: 'pair'; first: number; second: number };

/**
 * The share a message says when it says nothing else: "70-30" (a pair that is the whole), "half",
 * "a third", "50%", "$500", "all of it". Null for any other message: what it means depends on what
 * was asked, and a caller that knows the question reads it.
 */
/**
 * The share, in percent, a message says in words where it names one part of the whole and no
 * other, whatever leads into it: "Hmm, make it half.", "No wait, a third.", "Lower that to a
 * quarter.". The same words an answer is read by, found anywhere in the message. Null where it
 * writes none of them, or more than one.
 */
export function partSaidIn(message: string): { value: number; at: number; end: number } | null {
  const found: { value: number; at: number; end: number }[] = [];
  const count = (source: string, value: number) => {
    for (const m of message.matchAll(
      new RegExp(String.raw`(?<![\p{L}])(?:${source})(?![\p{L}])`, 'giu'),
    ))
      found.push({ value, at: m.index, end: m.index + m[0].length });
  };
  count('half|metade', HALF_PCT);
  for (const [n, words] of PART_WORDS.entries())
    count(String.raw`(?:a|one|um|uma)\s+(?:${words})`, (HALF_PCT * HALVES) / (n + HALVES + 1));
  const [only] = found;
  return found.length === 1 && only !== undefined ? only : null;
}

export function shareSaidIn(message: string): ShareSaid | null {
  const pair = PAIR_SAID.exec(message);
  const [a, b] = [Number(pair?.groups?.a), Number(pair?.groups?.b)];
  if (pair && a + b === HALF_PCT * 2) return { kind: 'pair', first: a, second: b };
  const percent = PERCENT_SAID.exec(message);
  const pct = Number(percent?.groups?.pct);
  if (percent && pct > 0 && pct <= HALF_PCT * 2)
    return pct === HALF_PCT * 2 ? { kind: 'whole' } : { kind: 'percent', value: pct };
  if (HALF_SAID.test(message)) return { kind: 'percent', value: HALF_PCT };
  const parts = ONE_PART_OF.findIndex((pattern) => pattern.test(message));
  if (parts >= 0) return { kind: 'percent', value: (HALF_PCT * HALVES) / (parts + HALVES + 1) };
  if (WHOLE_SAID.test(message)) return { kind: 'whole' };
  const sums = mentionsIn(message).filter((m) => m.kind === 'amount' && !m.perMonth);
  const [sum] = sums;
  const alone = saidAlone(String.raw`\S+(?:\s+(?:k|mil|thousand|dollars|d[oó]lares|bucks|usd))*`);
  // A sum is one written in dollars. A bare number ("5") may be dollars, a percent or years: it is
  // not read, and the question stays (the review of Oct 7).
  if (sum && sums.length === 1 && sum.currency === 'USD')
    return alone.test(message) && /\d/.test(message) ? { kind: 'amount', value: sum.value } : null;
  return null;
}

// A text in a language other than English and Portuguese (gate EXPLICIT-MIX: any language is read,
// and the read-back is in English). Words that are neither, common in a goal in Spanish or French.
const OTHER_LANGUAGE =
  /(?<![\p{L}'])(?:tengo|quiero|quisiera|años|acciones|dinero|ahorros|invertir|también|j'ai|je|veux|voudrais|ans|argent|aussi|épargne|placer|tout)(?![\p{L}])/iu;
/** Whether the text reads as written in another language than English or Portuguese. */
export const otherLanguageIn = (text: string): boolean => OTHER_LANGUAGE.test(text);
