import type { BasketSheetDraft } from '@colosseum/schemas';
import { COUNTRY_CODES } from './countries';
import { parseNumber } from './sheet';

// The words of a typed goal this app can read for itself, in English and Portuguese, before the text
// goes to POST /goals. That reader was made for goals in reais: it reads no dollar amount, no "18
// months", no "protect" and no "medium", and answers "accumulation" and "medium" when it found nothing.
// What it found stands; where it found nothing, or answered with a default of its own, the fields read
// here fill the blanks, and the sheet's source line says so. An amount in reais is left for the person:
// plans are in dollars for now (USD-ONLY), and a conversion would be a figure with no source.

/** The fields the words of a goal can fill. */
export type Words = Partial<
  Pick<BasketSheetDraft, 'goal' | 'amountUsd' | 'horizonMonths' | 'risk' | 'incomeTargetUsdMonthly'>
>;
export type WordField = keyof Words;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
  fifteen: 15,
  eighteen: 18,
  twenty: 20,
  thirty: 30,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  três: 3,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  doze: 12,
  quinze: 15,
  dezoito: 18,
  vinte: 20,
  trinta: 30,
};
const COUNT = `(\\d+(?:[.,]\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})`;
/** "a month" is how often, not how long: a count of months is a number. */
const MONTH_COUNT = `(\\d+(?:[.,]\\d+)?|${Object.keys(NUMBER_WORDS)
  .filter((w) => NUMBER_WORDS[w] !== 1)
  .join('|')})`;
const count = (word: string) => NUMBER_WORDS[word] ?? parseNumber(word) ?? Number.NaN;

const SCALE = '(k|mil|thousand|million|millions|milhão|milhao|milhões|milhoes|mi|m)?';
const scaled = (figure: string, scale: string | undefined) => {
  const n = parseNumber(figure);
  if (n === null || !Number.isFinite(n)) return Number.NaN;
  if (!scale) return n;
  return /^(k|mil|thousand)$/.test(scale) ? n * 1_000 : n * 1_000_000;
};
/** Said a month: the figure is what the plan pays each month, not what it starts with. */
const MONTHLY =
  /^\s*(?:a|per|each|every|por|ao|cada|\/)\s*(?:month|mês|mes)\b|^\s*(?:monthly|mensais|mensal)\b/;
/** Or said before it: "an income of $300", "renda de US$ 300". */
const MONTHLY_BEFORE = /(?:income of|pay me|pays me|renda de|renda mensal de|me pague)\s*$/;
/** Reais, which this reader leaves alone: "R$ 50 mil", "50 mil reais". */
const NOT_REAIS = '(?<!r\\$\\s?)';
const REAIS_AFTER = '(?!\\s?(?:reais|brl)\\b)';

/**
 * Every dollar figure in the text, in order, with whether a month follows it. "$50,000", "US$ 50.000",
 * "50k", "$50 mil", "50,000 dollars" and "USD 50,000"; never "R$", which is reais.
 */
function dollarFigures(t: string): { usd: number; monthly: boolean }[] {
  const found: { at: number; usd: number; end: number }[] = [];
  // a figure is read once, by the first pattern that takes it
  const take = (re: RegExp, figureAt: number, scaleAt: number) => {
    for (const m of t.matchAll(re)) {
      const usd = scaled(m[figureAt] ?? '', m[scaleAt]);
      if (Number.isFinite(usd) && !found.some((f) => f.at === m.index))
        found.push({ at: m.index ?? 0, usd, end: (m.index ?? 0) + m[0].length });
    }
  };
  // "$50,000", "US$ 50.000", "$50 mil", "$1.5 million": a dollar sign that is not "R$"
  take(new RegExp(`(?<![a-z])(?:us)?\\$\\s?(\\d[\\d.,]*)\\s?${SCALE}\\b${REAIS_AFTER}`, 'g'), 1, 2);
  // "usd 50,000"
  take(new RegExp(`\\busd\\s?(\\d[\\d.,]*)\\s?${SCALE}\\b`, 'g'), 1, 2);
  // "50,000 dollars", "50 mil dólares", "50k usd"
  take(
    new RegExp(
      `${NOT_REAIS}(?<![$\\d.,])(\\d[\\d.,]*)\\s?${SCALE}\\s?(?:dollars?|dólares|dolares|usd)\\b`,
      'g',
    ),
    1,
    2,
  );
  // "50k" alone: a thousand is a k only of money
  take(new RegExp(`${NOT_REAIS}(?<![$\\d.,])(\\d+(?:[.,]\\d+)?)(k)\\b${REAIS_AFTER}`, 'g'), 1, 2);
  return found
    .sort((a, b) => a.at - b.at)
    .map((f) => ({
      usd: f.usd,
      monthly:
        MONTHLY.test(t.slice(f.end, f.end + 14)) ||
        MONTHLY_BEFORE.test(t.slice(Math.max(0, f.at - 24), f.at)),
    }));
}

const months = (n: number) => (Number.isInteger(n) && n >= 1 && n <= 480 ? n : undefined);

function horizon(t: string, now: Date): number | undefined {
  const inMonths = t.match(new RegExp(`\\b${MONTH_COUNT}\\s?(?:months?|meses|mês|mes)\\b`));
  if (inMonths?.[1]) return months(count(inMonths[1]));
  const inYears = t.match(new RegExp(`\\b${COUNT}\\s?(?:years?|anos?)\\b`));
  if (inYears?.[1]) return months(Math.round(count(inYears[1]) * 12));
  // "by 2031", "até 2031", "until 2031", "in 2031": to the start of that year, as the API reads it
  const by = t.match(/\b(?:by|until|till|in|até|ate|em)\s(20\d{2})\b/);
  if (by?.[1]) {
    const n = (Number(by[1]) - now.getUTCFullYear()) * 12 - now.getUTCMonth();
    return months(Math.max(1, n));
  }
  return undefined;
}

function goal(t: string): Words['goal'] {
  if (/\b(income|pay me|pays me|renda|rendimento mensal|me pague|me pagar)\b/.test(t))
    return 'income';
  if (
    /\b(protect|keep\b[^;!?]{0,30}?\bsafe|preserve|safeguard|proteger|protege|preservar|guardar|manter\b[^;!?]{0,30}?\bsegur)/.test(
      t,
    )
  )
    return 'protect';
  if (
    /\b(grow|build|turn\b[^;!?]{0,30}?\binto|crescer|cresça|aumentar|multiplicar|construir|transformar)/.test(
      t,
    )
  )
    return 'grow';
  if (/\b(monthly|a month|per month|por mês|por mes|ao mês|ao mes|mensal|mensais)\b/.test(t))
    return 'income';
  return undefined;
}

function risk(t: string): Words['risk'] {
  const said =
    t.match(/\b(low|medium|high)[- ]risk\b/) ??
    t.match(/\brisk(?:\s?(?:is|:|level))?\s(low|medium|high)\b/) ??
    t.match(/\brisco\s(baixo|médio|medio|alto)\b/) ??
    t.match(/\b(baixo|médio|medio|alto)\srisco\b/);
  const word = said?.[1];
  if (word === 'low' || word === 'baixo') return 'low';
  if (word === 'medium' || word === 'médio' || word === 'medio') return 'medium';
  if (word === 'high' || word === 'alto') return 'high';
  if (/\b(conservative|conservador|conservadora)\b/.test(t)) return 'low';
  if (/\b(moderate|moderado|moderada)\b/.test(t)) return 'medium';
  if (/\b(aggressive|agressivo|agressiva)\b/.test(t)) return 'high';
  return undefined;
}

/** What the words of a goal say, field by field; a field they do not say is left out. */
export function preRead(text: string, now: Date = new Date()): Words {
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  const words: Words = {};
  const g = goal(t);
  if (g) words.goal = g;
  const figures = dollarFigures(t);
  const start = figures.find((f) => !f.monthly);
  if (start && start.usd >= 10 && start.usd <= 1_000_000) words.amountUsd = start.usd;
  const monthly = figures.find((f) => f.monthly);
  if (monthly && monthly.usd > 0 && (g === 'income' || g === undefined))
    words.incomeTargetUsdMonthly = monthly.usd;
  const h = horizon(t, now);
  if (h !== undefined) words.horizonMonths = h;
  const r = risk(t);
  if (r) words.risk = r;
  return words;
}

/**
 * The reader's draft with its blanks filled from the words: a field it left empty, or answered with
 * a default of its own (`guessed`), takes what the words say. `filled` is true when a field did.
 */
export function fillFromWords(
  draft: BasketSheetDraft,
  guessed: ReadonlySet<WordField>,
  words: Words,
): { draft: BasketSheetDraft; filled: boolean } {
  const next: BasketSheetDraft = { ...draft };
  let filled = false;
  for (const key of Object.keys(words) as WordField[]) {
    const value = words[key];
    if (value === undefined || value === null) continue;
    if (draft[key] !== null && !guessed.has(key)) continue;
    if (draft[key] === value) continue;
    (next as Record<WordField, unknown>)[key] = value;
    filled = true;
  }
  // A monthly figure is an income's; a plan of another kind does not carry one.
  if (next.goal !== 'income' && draft.incomeTargetUsdMonthly === null)
    next.incomeTargetUsdMonthly = null;
  return { draft: next, filled };
}

/** The country of the browser's language ("pt-BR" is BR), when it names one this app lists. */
export function browserCountry(languages: readonly string[]): string | null {
  for (const tag of languages) {
    const region = tag.split('-')[1]?.toUpperCase();
    if (region && (COUNTRY_CODES as readonly string[]).includes(region)) return region;
  }
  return null;
}
