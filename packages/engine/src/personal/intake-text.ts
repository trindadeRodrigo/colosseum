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
  /** As written. */
  text: string;
};

const THOUSAND = 10 * 10 * 10;
const MILLION = THOUSAND * THOUSAND;

// Currency marks before or after a number, by the code they stand for.
const CURRENCY_OF: [RegExp, string][] = [
  [/^(us\$|u\$s|usd|\$|d[oó]lar(es)?|dollars?|bucks)$/i, 'USD'],
  [/^(r\$|brl|reais|real)$/i, 'BRL'],
  [/^(€|eur|euros?)$/i, 'EUR'],
];
const currencyOf = (mark: string | undefined): string | null => {
  if (!mark) return null;
  for (const [pattern, code] of CURRENCY_OF) if (pattern.test(mark.trim())) return code;
  return null;
};

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
    '(?<before>us\\$|u\\$s|r\\$|\\$|€|usd|brl|eur)?',
    '\\s*',
    '(?<num>\\d[\\d.,]*\\d|\\d)',
    '(?:\\s*(?<mult>k|mil|thousand|grand|million|milh[aã]o|milh[oõ]es|mi|mm|m)(?![\\p{L}]))?',
    '(?:\\s*(?<pct>%|por cento|percent))?',
    '(?:\\s*(?:de\\s+)?(?<after>usd|brl|eur|d[oó]lares|d[oó]lar|dollars?|bucks|reais|real|euros?|months?|meses|m[eê]s|years?|yrs?|anos?|weeks?|semanas?|days?|dias?)(?![\\p{L}]))?',
  ].join(''),
  'giu',
);

/** Every number in the text, read with its currency and what it counts. */
export function mentionsIn(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const g = m.groups ?? {};
    const base = readNumber(g.num ?? '');
    if (!Number.isFinite(base)) continue;
    const value = base * multiplierOf(g.mult);
    const before = text.slice(0, m.index ?? 0).trimEnd();
    const lastWord = /(\S+(?:\s+de)?)$/.exec(before)?.[1] ?? '';
    const kind: Mention['kind'] = g.pct
      ? 'percent'
      : g.after && UNIT_TIME.test(g.after)
        ? 'duration'
        : !g.before && !g.mult && /^(19|20)\d\d$/.test(g.num ?? '') && BY_WORD.test(lastWord)
          ? 'year'
          : 'amount';
    const currency = kind === 'amount' ? (currencyOf(g.before) ?? currencyOf(g.after)) : null;
    out.push({ value, currency, kind, text: m[0].trim() });
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
 * Whether `value` is an amount the text writes in dollars, or with no currency beside it. "R$ 3.000,00",
 * "3 mil", "$3k" and "3,000" each hold 3,000; only the last three hold it in dollars.
 */
export function amountInText(text: string, value: number): 'dollars' | 'other_currency' | 'absent' {
  const found = mentionsIn(text).filter((m) => m.kind === 'amount' && close(m.value, value));
  if (found.some((m) => m.currency === 'USD' || m.currency === null)) return 'dollars';
  return found.length > 0 ? 'other_currency' : 'absent';
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
const HALF_YEAR = /\b(half a year|six months|meio ano|seis meses)\b/iu;

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
  for (const m of text.replace(HALF_YEAR, ' ').matchAll(WORD_DURATION)) {
    const n = wordNumber(m[1] ?? '');
    if (!Number.isFinite(n)) continue;
    // "$300 a month" is a rate, not a time frame; "a year" alone is read as one.
    if (/^an?$/i.test(m[1] ?? '') && !UNIT_YEAR.test(m[2] ?? '')) continue;
    found.add(UNIT_YEAR.test(m[2] ?? '') ? n * 12 : n);
  }
  if (HALF_YEAR.test(text)) found.add(12 / 2);
  return [...found].sort((a, b) => a - b);
}

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
