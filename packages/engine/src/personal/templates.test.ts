import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INPUT_NAMES,
  placeholdersOf,
  REASON_TEMPLATES,
  type RuleId,
  reason,
  render,
  TEXT_TEMPLATES,
  WORDS,
} from './templates';

// Explanation text is one template per rule, in English and Portuguese, filled from the inputs. No
// model writes it. These tests hold the wording to the rules of DESIGN-VAULT section 7 and of the
// brand's voice: nothing that reads as advice, no return promise, no exclamation mark.

const LANGUAGES = ['en', 'pt'] as const;

// "recommend", "suitable" and "best for you", their Portuguese equivalents, and return promises.
const BANNED: Record<(typeof LANGUAGES)[number], RegExp[]> = {
  en: [
    /recommend/i,
    /suitab/i,
    /best for you/i,
    /right for you/i,
    /advis/i,
    /guarante/i,
    /risk[- ]free/i,
    /\bwill (earn|return|pay|make|grow|yield)\b/i,
    /earn up to/i,
    /safe yield/i,
    /passive income/i,
    /\bpromise/i,
  ],
  pt: [
    /recomend/i,
    /adequad/i,
    /indicad/i,
    /apropriad/i,
    /melhor para voc/i,
    /ideal para/i,
    /aconselh/i,
    /garant/i,
    /sem risco/i,
    /vai (render|pagar|ganhar|lucrar|crescer)/i,
    /render[áa]\b/i,
    /lucro certo/i,
    /renda passiva/i,
    /promet/i,
  ],
};
// The brand's own list (voice-and-tone.md), which holds in any language the copy is in.
const BRAND_BANNED = [
  /set and forget/i,
  /autopilot/i,
  /seamless/i,
  /effortless/i,
  /unlock/i,
  /supercharge/i,
  /\bsmart\b/i,
  /\bmagic/i,
  /\bbasket/i,
  /\bstrategy\b/i,
  /\bbet\b/i,
];

const SAMPLE: Record<string, string | number> = {
  pct: 1432,
  usd: 4000,
  usdUp: 4000,
  amount: 3000.5,
  inCountry: 'BR',
  chain: 'robinhood',
  goal: 'grow',
  risk: 'medium',
  sleeve: 'growth',
  month: '2028-04',
  months: 18,
  regimes: 'weekend,us_holiday',
  list: 'AAPL,NVDA',
  '': 'NVDA',
};
const sampleParams = (text: string) =>
  Object.fromEntries(placeholdersOf(text).map((p) => [p.key, SAMPLE[p.format] ?? 'NVDA']));

const all = [
  ...Object.entries(REASON_TEMPLATES).map(([id, t]) => ({ id, ...t })),
  ...Object.entries(TEXT_TEMPLATES).map(([id, t]) => ({ id, ...t })),
];

describe('explanation templates', () => {
  it('has one template per rule in both languages, each a plain sentence', () => {
    expect(all.length).toBeGreaterThan(25);
    for (const t of all)
      for (const lang of LANGUAGES) {
        const text = t[lang];
        expect(text.length, `${t.id}.${lang}`).toBeGreaterThan(10);
        expect(text, `${t.id}.${lang}`).toMatch(/\.$/);
        expect(text, `${t.id}.${lang}`).not.toMatch(/!/);
        // No emoji and no pictograph: letters, digits, punctuation and Latin accents only.
        expect(text, `${t.id}.${lang}`).toMatch(/^[\p{L}\p{N}\p{P}\p{Zs}$|]+$/u);
      }
  });

  it('takes the same values in both languages', () => {
    for (const t of all) {
      const keys = (text: string) =>
        placeholdersOf(text)
          .map((p) => `${p.key}|${p.format}`)
          .sort();
      expect(keys(t.pt), t.id).toEqual(keys(t.en));
    }
  });

  it('names only inputs a person gives', () => {
    for (const [id, t] of Object.entries(REASON_TEMPLATES))
      for (const input of t.inputs) expect(INPUT_NAMES, id).toContain(input);
  });

  it('bans "recommend", "suitable", "best for you", their Portuguese equivalents and return promises', () => {
    const words = (lang: (typeof LANGUAGES)[number]) =>
      Object.values(WORDS[lang]).flatMap((group) => Object.values(group));
    for (const lang of LANGUAGES) {
      const texts = [
        ...all.map((t) => ({ id: t.id, text: t[lang] })),
        ...all.map((t) => ({
          id: `${t.id} filled`,
          text: render(t[lang], sampleParams(t[lang]), lang),
        })),
        ...words(lang).map((text) => ({ id: 'a word', text })),
      ];
      for (const { id, text } of texts)
        for (const pattern of [...BANNED[lang], ...BRAND_BANNED])
          expect(text, `${id}.${lang} against ${pattern}`).not.toMatch(pattern);
    }
  });

  it('holds the curated reasons of the theme lists to the same ban: a line shows them', () => {
    const root = join(import.meta.dirname, '../../../../content/themes');
    for (const chain of readdirSync(root))
      for (const file of readdirSync(join(root, chain))) {
        const list = JSON.parse(readFileSync(join(root, chain, file), 'utf8')) as {
          name: Record<string, string>;
          members: { symbol: string; reason: Record<string, string> }[];
        };
        for (const lang of LANGUAGES)
          for (const text of [
            list.name[lang] ?? '',
            ...list.members.map((m) => m.reason[lang] ?? ''),
          ]) {
            expect(text, `${chain}/${file}.${lang}`).not.toBe('');
            // Written into a sentence that ends it: no full stop of its own, no exclamation mark.
            expect(text, `${chain}/${file}.${lang}`).not.toMatch(/[.!]$/);
            for (const pattern of [...BANNED[lang], ...BRAND_BANNED])
              expect(text, `${chain}/${file}.${lang} against ${pattern}`).not.toMatch(pattern);
          }
      }
  });

  it('self-check: the ban sees what it bans', () => {
    const caught = (lang: 'en' | 'pt', text: string) => BANNED[lang].some((p) => p.test(text));
    expect(caught('en', 'We recommend this plan.')).toBe(true);
    expect(caught('en', 'A plan suitable for you.')).toBe(true);
    expect(caught('en', 'The best for you.')).toBe(true);
    expect(caught('en', 'It will earn 5% a year.')).toBe(true);
    expect(caught('en', 'A guaranteed return.')).toBe(true);
    expect(caught('pt', 'Recomendamos este plano.')).toBe(true);
    expect(caught('pt', 'Um plano adequado ao seu perfil.')).toBe(true);
    expect(caught('pt', 'O melhor para você.')).toBe(true);
    expect(caught('pt', 'Vai render 5% ao ano.')).toBe(true);
    expect(caught('pt', 'Retorno garantido.')).toBe(true);
    expect(caught('en', 'No return is assumed for this line.')).toBe(false);
  });

  it('fills every value, and refuses to print a hole', () => {
    for (const t of all)
      for (const lang of LANGUAGES) {
        const text = render(t[lang], sampleParams(t[lang]), lang);
        expect(text, `${t.id}.${lang}`).not.toMatch(/[{}]|undefined|NaN|null/);
      }
    expect(() => render('Less {asset}.', {}, 'en')).toThrow(/asset/);
    // An empty name is a hole too: " is left out" names nothing.
    expect(() => render('{what} is left out.', { what: '' }, 'en')).toThrow(/what/);
    expect(() => render('In {months|months}.', { months: 'soon' }, 'en')).toThrow(/months/);
    expect(() => render('{x|nope}.', { x: 1 }, 'en')).toThrow(/nope/);
  });

  it('writes money, shares, dates and words the way each language does', () => {
    const line =
      '{a|usd} · {b|pct} · {c|pct} · {d|month} · {e|months} · {f|months} · {g|chain} · {h|sleeve}';
    const values = {
      a: 4000.4,
      b: 8000,
      c: 1432,
      d: '2028-04',
      e: 18,
      f: 1,
      g: 'robinhood',
      h: 'dollarYield',
    };
    expect(render(line, values, 'en')).toBe(
      '$4,000 · 80% · 14.32% · April 2028 · 18 months · 1 month · Robinhood Chain · dollar yield',
    );
    expect(render(line, values, 'pt')).toBe(
      'US$ 4.000 · 80% · 14,32% · abril de 2028 · 18 meses · 1 mês · Robinhood Chain · rendimento em dólar',
    );
    expect(render('{a|usd}', { a: 1_250_000 }, 'en')).toBe('$1,250,000');
    // A chain or a word this file does not know is printed as it came, never dropped.
    expect(render('{g|chain}', { g: 'arbitrum' }, 'en')).toBe('arbitrum');
  });

  it('writes the times of the week in one order, whatever order they come in', () => {
    const when = (codes: string, lang: 'en' | 'pt') => render('{w|regimes}', { w: codes }, lang);
    expect(when('weekend', 'en')).toBe('at the weekend');
    expect(when('us_holiday,weekend', 'en')).toBe('at the weekend and on US holidays');
    expect(when('us_holiday,weekend,us_offhours_weekday,us_market_hours', 'en')).toBe(
      'in US market hours, on weekdays outside US market hours, at the weekend and on US holidays',
    );
    expect(when('weekend,us_holiday', 'pt')).toBe('no fim de semana e em feriados dos EUA');
    expect(Object.keys(WORDS.en.regime)).toEqual(Object.keys(WORDS.pt.regime));
    // A time of the week this file does not know is an error, never a blank.
    expect(() => when('weekend,full_moon', 'en')).toThrow(/times of the week/);
  });

  it('writes a list of names as a person would: one, two with "and", more with commas', () => {
    const names = (list: string, lang: 'en' | 'pt') => render('{n|list}', { n: list }, lang);
    expect(names('SPY', 'en')).toBe('SPY');
    expect(names('AAPL,NVDA', 'en')).toBe('AAPL and NVDA');
    expect(names('AAPL,MSFT,NVDA', 'en')).toBe('AAPL, MSFT and NVDA');
    expect(names('AAPL,MSFT,NVDA', 'pt')).toBe('AAPL, MSFT e NVDA');
    expect(() => names('AAPL,,NVDA', 'en')).toThrow(/list of names/);
  });

  it('never writes a small amount as zero, and rounds a loss up', () => {
    // Under a dollar, the cents are shown.
    expect(render('{a|usd}', { a: 0.4 }, 'en')).toBe('$0.40');
    expect(render('{a|usd}', { a: 0.4 }, 'pt')).toBe('US$ 0,40');
    expect(render('{a|usd}', { a: 0.004 }, 'en')).toBe('$0');
    expect(render('{a|usd}', { a: 0 }, 'en')).toBe('$0');
    expect(render('{a|usd}', { a: 0.996 }, 'en')).toBe('$1');
    expect(render('{a|usd}', { a: 1.4 }, 'en')).toBe('$1');
    // A loss is never written smaller than it is: $1.40 is "$2", and four tenths of a cent is a cent.
    expect(render('{a|usdUp}', { a: 1.4 }, 'en')).toBe('$2');
    expect(render('{a|usdUp}', { a: 228.48 }, 'en')).toBe('$229');
    expect(render('{a|usdUp}', { a: 2000 }, 'pt')).toBe('US$ 2.000');
    expect(render('{a|usdUp}', { a: 0.004 }, 'en')).toBe('$0.01');
    expect(render('{a|usdUp}', { a: 0 }, 'en')).toBe('$0');
  });

  it('writes a country by its name, and by its code only when it does not know the name', () => {
    expect(render('{c|inCountry}', { c: 'BR' }, 'en')).toBe('in Brazil');
    expect(render('{c|inCountry}', { c: 'BR' }, 'pt')).toBe('no Brasil');
    expect(render('{c|inCountry}', { c: 'US' }, 'pt')).toBe('nos Estados Unidos');
    expect(render('{c|inCountry}', { c: 'PT' }, 'pt')).toBe('em Portugal');
    expect(render('{c|inCountry}', { c: 'XX' }, 'en')).toBe('in XX');
    expect(render('{c|inCountry}', { c: 'XX' }, 'pt')).toBe('em XX');
    expect(Object.keys(WORDS.en.inCountry).sort()).toEqual(Object.keys(WORDS.pt.inCountry).sort());
  });

  it('builds a reason: the rule, the inputs it names, the values and the text', () => {
    const r = reason('ALREADY_HELD_NONE', { asset: 'NVDA', heldUsd: 4000 }, 'en');
    expect(r).toEqual({
      rule: 'ALREADY_HELD_NONE',
      inputs: ['holdings'],
      params: { asset: 'NVDA', heldUsd: 4000 },
      text: 'No NVDA: you already hold $4,000 of it.',
    });
    expect(reason('ALREADY_HELD_NONE', { asset: 'NVDA', heldUsd: 4000 }, 'pt').text).toBe(
      'Sem NVDA: você já tem US$ 4.000.',
    );
    const rules = Object.keys(REASON_TEMPLATES) as RuleId[];
    for (const rule of rules) {
      const t = REASON_TEMPLATES[rule];
      expect(reason(rule, sampleParams(t.en), 'en').inputs).toEqual([...t.inputs]);
    }
  });
});
