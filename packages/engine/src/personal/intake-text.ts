import { WORDS } from './templates';
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
// What makes a duration a time frame: a word before it ("for", "over", "em", "por") and no age after.
const TIME_FRAME_BEFORE =
  /(?:^|[\s,(])(?:for|over|in|within|during|after|next|em|por|durante|dentro de|daqui a|depois de|pr[oó]ximos?)\s*$/iu;
const AGE_AFTER = /^\s*(?:old|of age|de idade)\b/iu;
const inTimeFrame = (text: string, at: number, end: number) =>
  TIME_FRAME_BEFORE.test(text.slice(0, at)) && !AGE_AFTER.test(text.slice(end));

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
    out.push({ value, currency, kind, perMonth, timeFrame, text: m[0].trim() });
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
    if (!m.timeFrame) continue;
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
    if (!inTimeFrame(text, at, at + m[0].length)) continue;
    found.add(UNIT_YEAR.test(m[2] ?? '') ? n * 12 : n);
  }
  for (const m of half) {
    const at = m.index ?? 0;
    if (inTimeFrame(text, at, at + m[0].length)) found.add(12 / 2);
  }
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

// Words that say a goal or a risk. The model's reading of either is taken only where the text holds
// one of its words; otherwise it is a suggestion the person confirms.
const GOAL_CUES: Record<'grow' | 'income' | 'protect', RegExp> = {
  grow: /\b(grow\w*|growth|crescer|crescimento|multiplic\w*|invest\w*|aplicar|put\b.*\bto work|build (?:up|wealth)|rentabiliz\w*)/iu,
  income:
    /\b(income|renda|dividend\w*|monthly|mensa\w*|a month|per month|por m[eê]s|ao m[eê]s|pay me|me pague)/iu,
  protect:
    /\b(protect\w*|proteg\w*|prote[cç][aã]o|safe\w*|segur\w*|keep\b|guard\w*|preserv\w*|reserv\w*|park\b)/iu,
};
const RISK_CUES: Record<'low' | 'medium' | 'high', RegExp> = {
  low: /\b(low|conservative|conservador\w*|cautious|cautel\w*|baix\w*|safe\w*|segur\w*|no stocks|sem a[cç][oõ]es|little risk|pouco risco)/iu,
  medium: /\b(medium|moderate\w*|moderad\w*|m[eé]dio|balanced|equilibrad\w*)/iu,
  high: /\b(high|aggressive|agressiv\w*|alt[oa]\b|bold|ousad\w*|a lot of risk|muito risco)/iu,
};
/** The goals the text has a word for. */
export const goalCuesIn = (text: string) =>
  (Object.keys(GOAL_CUES) as (keyof typeof GOAL_CUES)[]).filter((g) => GOAL_CUES[g].test(text));
/** The risks the text has a word for. */
export const riskCuesIn = (text: string) =>
  (Object.keys(RISK_CUES) as (keyof typeof RISK_CUES)[]).filter((r) => RISK_CUES[r].test(text));

const plain = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const DEMONYMS: Record<string, string[]> = {
  BR: ['brazilian', 'brasileir'],
  US: ['american', 'americano', 'americana'],
  PT: ['portuguese', 'portugues'],
  AR: ['argentin'],
  MX: ['mexican', 'mexicano', 'mexicana'],
  GB: ['british', 'britanic', 'england', 'inglaterra'],
};
/**
 * Whether the text names the country `code`: its name in either language as the templates write it
 * ("Brazil", "Brasil"), or a word for its people ("brazilian", "brasileira").
 */
export function countryNamed(text: string, code: string): boolean {
  const said = plain(text);
  const names = (['en', 'pt'] as const)
    .map((lang) => WORDS[lang].inCountry[code])
    .filter((x): x is string => x !== undefined)
    .map((phrase) => plain(phrase).replace(/^(in the|in|nos|nas|no|na|em)\s+/, ''));
  const words = [...names, ...(DEMONYMS[code] ?? [])];
  return words.some((w) =>
    new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(said),
  );
}
