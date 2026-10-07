import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKET_FILTER_BY } from './market-filter';
import {
  ASSUMPTION_TEMPLATES,
  asListed,
  CLASS_WORDS,
  FILTER_BY_WORDS,
  INPUT_NAMES,
  MATCHED_NAME,
  placeholdersOf,
  QUESTION_TEMPLATES,
  READBACK_TEMPLATES,
  REASON_TEMPLATES,
  type RuleId,
  reason,
  render,
  TERM_SAID,
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
  chain: 'robinhood',
  goal: 'grow',
  risk: 'medium',
  sleeve: 'growth',
  month: '2028-04',
  months: 18,
  years: 5,
  regimes: 'weekend,us_holiday',
  raisers: 'withdrawals,holdings',
  steps: 1,
  lines: 'set',
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

  // A matched theme's lines print the attributes as they are written (gate THEME-MATCHED): the value
  // matched by, and each stock's company. Found by the review of Oct 6: nothing held that text to the
  // ban. A company's legal name is a fact and is held to the ban on advice and promises only, not to
  // the brand's words ("Strategy Inc" is a name, not our voice).
  it('holds the stock attributes a matched line prints to the same ban', () => {
    const root = join(import.meta.dirname, '../../../../content/stocks');
    for (const file of readdirSync(root)) {
      const { stocks } = JSON.parse(readFileSync(join(root, file), 'utf8')) as {
        stocks: {
          symbol: string;
          company: string;
          sector: string | null;
          industry: string | null;
          subIndustry: string | null;
          keywords: string[];
          tracks: string | null;
        }[];
      };
      expect(stocks.length, file).toBeGreaterThan(0);
      for (const row of stocks) {
        const values = [row.sector, row.industry, row.subIndustry, row.tracks, ...row.keywords];
        for (const text of values.flatMap((v) => (v === null ? [] : [v]))) {
          expect(text, `${file} ${row.symbol}`).not.toMatch(/[.!]$/);
          for (const lang of LANGUAGES)
            for (const pattern of [...BANNED[lang], ...BRAND_BANNED])
              expect(text, `${file} ${row.symbol} against ${pattern}`).not.toMatch(pattern);
        }
        for (const lang of LANGUAGES)
          for (const pattern of BANNED[lang])
            expect(row.company, `${file} ${row.symbol} against ${pattern}`).not.toMatch(pattern);
      }
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

  it('writes what raised the limits of a mix in one order, and how many risks up', () => {
    const by = (codes: string, lang: 'en' | 'pt') => render('{b|raisers}', { b: codes }, lang);
    expect(by('holdings', 'en')).toBe('what you already hold');
    expect(by('cannotHold,withdrawals', 'en')).toBe(
      'what is set aside for your withdrawals and what you cannot hold',
    );
    expect(by('date,limits,cannotHold,holdings,withdrawals', 'pt')).toBe(
      'o que fica separado para os seus saques, o que você já tem, o que você não pode ter, os seus outros limites e a sua data',
    );
    expect(Object.keys(WORDS.en.raiser)).toEqual(Object.keys(WORDS.pt.raiser));
    expect(Object.keys(WORDS.en.steps)).toEqual(Object.keys(WORDS.pt.steps));
    // Something this file has no words for is an error, never a blank.
    expect(() => by('holdings,the_weather', 'en')).toThrow(/what raised the limits/);
    expect(render('{n|steps}', { n: 1 }, 'en')).toBe('one step up');
    expect(render('{n|steps}', { n: 2 }, 'pt')).toBe('dois níveis acima');
    expect(() => render('{n|steps}', { n: 3 }, 'en')).toThrow(/number of steps/);
    expect(
      reason(
        'MIX_LIMITS_RAISED',
        { alone: 'low', risk: 'medium', by: 'withdrawals', steps: 1 },
        'en',
      ).text,
    ).toBe(
      'On its own, this mix takes the limits for low risk. Because of what is set aside for your withdrawals, the plan uses the limits one step up, for medium risk: at lower limits it would hold less in stocks and crypto.',
    );
    expect(
      reason(
        'MIX_LIMITS_RAISED',
        { alone: 'low', risk: 'high', by: 'holdings,cannotHold', steps: 2 },
        'pt',
      ).text,
    ).toBe(
      'Sozinha, esta composição usa os limites de risco baixo. Por causa de o que você já tem e o que você não pode ter, o plano usa os limites dois níveis acima, de risco alto: com limites mais baixos ele teria menos em ações e cripto.',
    );
  });

  it('writes a list of names as a person would: one, two with "and", more with commas', () => {
    const names = (list: string, lang: 'en' | 'pt') => render('{n|list}', { n: list }, lang);
    expect(names('SPY', 'en')).toBe('SPY');
    expect(names('AAPL,NVDA', 'en')).toBe('AAPL and NVDA');
    expect(names('AAPL,MSFT,NVDA', 'en')).toBe('AAPL, MSFT and NVDA');
    expect(names('AAPL,MSFT,NVDA', 'pt')).toBe('AAPL, MSFT e NVDA');
    expect(() => names('AAPL,,NVDA', 'en')).toThrow(/list of names/);
  });

  it('keeps a name with a comma in it whole in a list (gate THEME-MATCHED)', () => {
    // A list is joined by commas with no space after them, so a comma followed by a space is part of
    // a name: an industry is often written with one.
    const hardware = 'Technology Hardware, Storage & Peripherals';
    const names = (list: string[], lang: 'en' | 'pt' = 'en') =>
      render('{n|list}', { n: list.map(asListed).join(',') }, lang);
    expect(names([hardware])).toBe(hardware);
    expect(names(['AI', hardware])).toBe('AI and Technology Hardware, Storage & Peripherals');
    expect(names([hardware, 'AI', 'Oil, Gas & Consumable Fuels'], 'pt')).toBe(
      'Technology Hardware, Storage & Peripherals, AI e Oil, Gas & Consumable Fuels',
    );
    expect(names(['AAPL', 'MSFT', 'NVDA'])).toBe('AAPL, MSFT and NVDA');
    // A name written with no space after its comma is given one before it is listed, so it is never
    // split either; a name with no comma is left as it is.
    expect(asListed('Oil,Gas & Consumable Fuels')).toBe('Oil, Gas & Consumable Fuels');
    expect(names(['AI', 'Oil,Gas & Consumable Fuels'])).toBe('AI and Oil, Gas & Consumable Fuels');
    expect(asListed(hardware)).toBe(hardware);
    expect(asListed('NVDA')).toBe('NVDA');
  });

  it('says what a market filter reads in each language (gate THEME-MATCHED)', () => {
    const said = (by: string, lang: 'en' | 'pt') => render('{by|by}', { by }, lang);
    const kinds = ['sector', 'industry', 'sub_industry', 'keyword'];
    expect(kinds.map((by) => said(by, 'en'))).toEqual([
      'sector',
      'industry',
      'sub-industry',
      'keyword',
    ]);
    expect(kinds.map((by) => said(by, 'pt'))).toEqual([
      'setor',
      'indústria',
      'subindústria',
      'palavra-chave',
    ]);
    expect(Object.keys(WORDS.en.by)).toEqual(kinds);
    expect(Object.keys(WORDS.pt.by)).toEqual(kinds);
    expect(Object.keys(WORDS.en.itsBy)).toEqual(kinds);
    expect(Object.keys(WORDS.pt.itsBy)).toEqual(kinds);
    // What this file does not know is printed as it came, never dropped.
    expect(said('country', 'en')).toBe('country');
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

  // Gate COUNTRY-REMOVED (Rodrigo, Oct 6): no sentence names a country, so the wording has no way
  // to write one, and no reason can name the country as the input that caused it.
  it('has no way to write a country, and no reason names one as its input', () => {
    expect(() => render('{c|inCountry}', { c: 'BR' }, 'en')).toThrow(/inCountry/);
    expect(INPUT_NAMES as readonly string[]).not.toContain('country');
    for (const t of all)
      for (const lang of LANGUAGES) expect(t[lang], t.id).not.toMatch(/inCountry|\bcountr|\bpaís/i);
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

// The guided intake's wording (ENG-3 slice 4): the questions and the read-back are held to the same
// bans. A question ends with a question mark, or with a full stop where it asks for an action.
describe('intake templates', () => {
  const intake = [
    ...Object.entries(QUESTION_TEMPLATES).map(([id, t]) => ({ id, ...t })),
    ...Object.entries(READBACK_TEMPLATES).map(([id, t]) => ({ id, ...t })),
    ...Object.entries(ASSUMPTION_TEMPLATES).map(([id, t]) => ({ id, ...t })),
  ];

  it('are plain sentences in both languages, with the same values, filled with no hole', () => {
    for (const t of intake) {
      const keys = (text: string) =>
        placeholdersOf(text)
          .map((p) => `${p.key}|${p.format}`)
          .sort();
      expect(keys(t.pt), t.id).toEqual(keys(t.en));
      for (const lang of LANGUAGES) {
        const text = t[lang];
        expect(text, `${t.id}.${lang}`).toMatch(/[.?]$/);
        expect(text, `${t.id}.${lang}`).not.toMatch(/!/);
        expect(text, `${t.id}.${lang}`).toMatch(/^[\p{L}\p{N}\p{P}\p{Zs}$|]+$/u);
        const filled = render(text, sampleParams(text), lang);
        expect(filled, `${t.id}.${lang}`).not.toMatch(/[{}]|undefined|NaN|null/);
      }
    }
  });

  // The founder's words (Oct 6) for a market, an industry or a trend the chain has nothing for.
  it('says "nothing on your chain" as written, with and without a nearest', () => {
    expect(ASSUMPTION_TEMPLATES.MARKET_NONE).toEqual({
      en: 'There is no stock for “{words}” on {chain|chain} at the moment. We will be adding more soon.',
      pt: 'No momento não há nenhuma ação para “{words}” na {chain|chain}. Vamos incluir mais em breve.',
    });
    expect(ASSUMPTION_TEMPLATES.MARKET_NEAREST).toEqual({
      en: 'There is no stock for “{words}” on {chain|chain} at the moment, and we will be adding more soon. The nearest today is {nearest}, which you can choose.',
      pt: 'No momento não há nenhuma ação para “{words}” na {chain|chain}, e vamos incluir mais em breve. O mais próximo hoje é {nearest}, que você pode escolher.',
    });
    expect(ASSUMPTION_TEMPLATES.MARKET_MATCHED).toEqual({
      en: 'No curated list covers “{words}” on {chain|chain}, so the plan holds the names matched by {by}: {value}. Matched from the sourced attributes of each, not a curated theme.',
      pt: 'Nenhuma lista com curadoria cobre “{words}” na {chain|chain}, então o plano fica com os nomes filtrados por {by}: {value}. Filtrados pelos atributos de cada um, que têm fonte; não é um tema com curadoria.',
    });
  });

  // The second review of the intake (Oct 7): a filter that matches one name alone is no theme, and
  // "there is no stock" would be false of it.
  it('says "only one stock" as written, with and without a nearest', () => {
    expect(ASSUMPTION_TEMPLATES.MARKET_ONE).toEqual({
      en: 'There is only one stock for “{words}” on {chain|chain} at the moment, and a theme is not made of one. We will be adding more soon.',
      pt: 'No momento há só uma ação para “{words}” na {chain|chain}, e um tema não se faz de uma só. Vamos incluir mais em breve.',
    });
    expect(ASSUMPTION_TEMPLATES.MARKET_ONE_NEAREST).toEqual({
      en: `${ASSUMPTION_TEMPLATES.MARKET_ONE.en} The nearest today is {nearest}, which you can choose.`,
      pt: `${ASSUMPTION_TEMPLATES.MARKET_ONE.pt} O mais próximo hoje é {nearest}, que você pode escolher.`,
    });
    // The offer is the one the sentence for no stock makes, word for word.
    for (const lang of LANGUAGES) {
      const offer = ASSUMPTION_TEMPLATES.MARKET_ONE_NEAREST[lang].slice(
        ASSUMPTION_TEMPLATES.MARKET_ONE[lang].length + 1,
      );
      expect(ASSUMPTION_TEMPLATES.MARKET_NEAREST[lang].endsWith(offer), lang).toBe(true);
    }
  });

  it('says a shelf that could not be read without a word on what the chain has', () => {
    expect(
      render(ASSUMPTION_TEMPLATES.SHELF_UNREAD.en, { words: 'AI', chain: 'solana' }, 'en'),
    ).toBe('What is listed on Solana could not be read just now, so nothing is held for “AI” yet.');
    expect(
      render(ASSUMPTION_TEMPLATES.SHELF_UNREAD.pt, { words: 'IA', chain: 'solana' }, 'pt'),
    ).toBe(
      'Não foi possível ler agora o que está listado na Solana, então nada é mantido para “IA” por enquanto.',
    );
    for (const lang of LANGUAGES)
      expect(ASSUMPTION_TEMPLATES.SHELF_UNREAD[lang]).not.toMatch(
        /no stock|nenhuma ação|only one|só uma/,
      );
  });

  // The second review of the intake (Oct 7): the questions and the lines its rules say. The words are
  // Rodrigo's to set; these hold what is written, in both languages, so a change is a decision.
  it('asks the split between the things named, the share and the rest, and a refusal against a holding, as written', () => {
    expect(QUESTION_TEMPLATES.themeShares).toEqual({
      en: 'How do you want to split the money between {themes}?',
      pt: 'Como você quer dividir o dinheiro entre {themes}?',
    });
    expect(QUESTION_TEMPLATES.themeAndRest).toEqual({
      en: 'How much of the money for {market}, and how do you want the rest held: kept safe and easy to take out, or seeking a return?',
      pt: 'Quanto do dinheiro para {market}, e como você quer o restante: seguro e fácil de tirar, ou buscando retorno?',
    });
    expect(QUESTION_TEMPLATES.holdOrLeaveOut).toEqual({
      en: 'You wrote “{refusal}” and also “{held}”. Which one stands? Say how much of the money goes to it, or none.',
      pt: 'Você escreveu “{refusal}” e também “{held}”. Qual dos dois vale? Diga quanto do dinheiro vai para isso, ou nada.',
    });
    const q = (
      id: keyof typeof QUESTION_TEMPLATES,
      lang: 'en' | 'pt',
      params: Record<string, string | number>,
    ) => render(QUESTION_TEMPLATES[id][lang], params, lang);
    expect(q('themeShares', 'en', { themes: 'AI and semiconductors' })).toBe(
      'How do you want to split the money between AI and semiconductors?',
    );
    expect(q('themeShares', 'pt', { themes: 'IA e semicondutores' })).toBe(
      'Como você quer dividir o dinheiro entre IA e semicondutores?',
    );
    expect(q('themeAndRest', 'en', { market: 'AI' })).toBe(
      'How much of the money for AI, and how do you want the rest held: kept safe and easy to take out, or seeking a return?',
    );
    expect(q('themeAndRest', 'pt', { market: 'IA' })).toBe(
      'Quanto do dinheiro para IA, e como você quer o restante: seguro e fácil de tirar, ou buscando retorno?',
    );
    expect(q('holdOrLeaveOut', 'en', { refusal: 'No stocks', held: 'all stocks' })).toBe(
      'You wrote “No stocks” and also “all stocks”. Which one stands? Say how much of the money goes to it, or none.',
    );
    expect(q('holdOrLeaveOut', 'pt', { refusal: 'Sem ações', held: 'tudo em ações' })).toBe(
      'Você escreveu “Sem ações” e também “tudo em ações”. Qual dos dois vale? Diga quanto do dinheiro vai para isso, ou nada.',
    );
    // A question that offers a way out says it: "none", "nada".
    for (const lang of LANGUAGES)
      expect(QUESTION_TEMPLATES.holdOrLeaveOut[lang]).toMatch(
        lang === 'pt' ? /ou nada\.$/ : /or none\.$/,
      );
  });

  it('asks the share of a filter only the model linked to the words by saying the match, with a way out', () => {
    expect(QUESTION_TEMPLATES.matchedShare).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder after a dollar sign, not a JS template.
      en: 'I read “{market}” as {matched}. How much of the ${amount|amount} for them? Say none if that is not what you meant.',
      pt: 'Li “{market}” como {matched}. Quanto dos US$ {amount|amount} para eles? Diga nenhum se não era isso que você quis dizer.',
    });
    expect(QUESTION_TEMPLATES.matchedShareNoAmount).toEqual({
      en: 'I read “{market}” as {matched}. How much of the money for them? Say none if that is not what you meant.',
      pt: 'Li “{market}” como {matched}. Quanto do dinheiro para eles? Diga nenhum se não era isso que você quis dizer.',
    });
    const matched = (lang: 'en' | 'pt') =>
      render(MATCHED_NAME[lang], { by: FILTER_BY_WORDS[lang].keyword, value: 'GLP-1' }, lang);
    expect(
      render(
        QUESTION_TEMPLATES.matchedShare.en,
        { market: 'obesity drugs', matched: matched('en'), amount: 2000 },
        'en',
      ),
    ).toBe(
      'I read “obesity drugs” as names matched by keyword: GLP-1. How much of the $2,000 for them? Say none if that is not what you meant.',
    );
    expect(
      render(
        QUESTION_TEMPLATES.matchedShare.pt,
        { market: 'remédios para obesidade', matched: matched('pt'), amount: 2000 },
        'pt',
      ),
    ).toBe(
      'Li “remédios para obesidade” como nomes filtrados por palavra-chave: GLP-1. Quanto dos US$ 2.000 para eles? Diga nenhum se não era isso que você quis dizer.',
    );
    expect(
      render(
        QUESTION_TEMPLATES.matchedShareNoAmount.en,
        { market: 'obesity drugs', matched: matched('en') },
        'en',
      ),
    ).toBe(
      'I read “obesity drugs” as names matched by keyword: GLP-1. How much of the money for them? Say none if that is not what you meant.',
    );
    // It says the match as a reading, never as a curated theme, and never names a stock.
    for (const lang of LANGUAGES)
      for (const id of ['matchedShare', 'matchedShareNoAmount'] as const)
        expect(QUESTION_TEMPLATES[id][lang], `${id}.${lang}`).not.toMatch(
          /curated|curadoria|theme|tema/i,
        );
  });

  it('says a refusal it took, one of a part, a name it cannot leave out and a share too small, as written', () => {
    expect(ASSUMPTION_TEMPLATES.REFUSAL_TAKEN).toEqual({
      en: 'I read “{words}” as leaving out {classes|list}. Say so if that is not what you meant.',
      pt: 'Li “{words}” como deixar de fora {classes|list}. Diga se não era isso que você quis dizer.',
    });
    expect(ASSUMPTION_TEMPLATES.REFUSAL_TAKEN_CREDIT).toEqual({
      en: 'I read “{words}” as no tokens that lend to borrowers or trade a spread. Say so if that is not what you meant.',
      pt: 'Li “{words}” como nenhum token que empresta a tomadores ou opera um spread. Diga se não era isso que você quis dizer.',
    });
    expect(ASSUMPTION_TEMPLATES.REFUSAL_OF_A_PART).toEqual({
      en: 'A plan can leave out a whole class, not a part of one, so “{words}” was not applied.',
      pt: 'Um plano pode deixar de fora uma classe inteira, não uma parte dela, então “{words}” não foi aplicado.',
    });
    expect(ASSUMPTION_TEMPLATES.CANNOT_LEAVE_OUT).toEqual({
      en: 'A plan cannot leave one company out of a list it holds, so “{words}” was not applied.',
      pt: 'Um plano não deixa uma empresa de fora de uma lista que mantém, então “{words}” não foi aplicado.',
    });
    expect(ASSUMPTION_TEMPLATES.SHARE_TOO_SMALL).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder after a dollar sign, not a JS template.
      en: 'The smallest part a plan of this size can hold is ${least|amount}, so a smaller one was not taken.',
      pt: 'A menor parte que um plano deste tamanho pode ter é US$ {least|amount}, então uma parte menor não foi considerada.',
    });
    const said = (
      id: keyof typeof ASSUMPTION_TEMPLATES,
      lang: 'en' | 'pt',
      params: Record<string, string | number>,
    ) => render(ASSUMPTION_TEMPLATES[id][lang], params, lang);
    expect(
      said('REFUSAL_TAKEN', 'en', { words: 'avoid stocks', classes: 'stocks,stock funds' }),
    ).toBe(
      'I read “avoid stocks” as leaving out stocks and stock funds. Say so if that is not what you meant.',
    );
    expect(
      said('REFUSAL_TAKEN', 'pt', { words: 'sem ações', classes: 'ações,fundos de ações' }),
    ).toBe(
      'Li “sem ações” como deixar de fora ações e fundos de ações. Diga se não era isso que você quis dizer.',
    );
    expect(said('REFUSAL_TAKEN_CREDIT', 'en', { words: 'no loans' })).toBe(
      'I read “no loans” as no tokens that lend to borrowers or trade a spread. Say so if that is not what you meant.',
    );
    expect(said('REFUSAL_TAKEN_CREDIT', 'pt', { words: 'sem crédito' })).toBe(
      'Li “sem crédito” como nenhum token que empresta a tomadores ou opera um spread. Diga se não era isso que você quis dizer.',
    );
    expect(said('REFUSAL_OF_A_PART', 'en', { words: 'No stocks from China' })).toBe(
      'A plan can leave out a whole class, not a part of one, so “No stocks from China” was not applied.',
    );
    expect(said('REFUSAL_OF_A_PART', 'pt', { words: 'Sem ações da China' })).toBe(
      'Um plano pode deixar de fora uma classe inteira, não uma parte dela, então “Sem ações da China” não foi aplicado.',
    );
    expect(said('CANNOT_LEAVE_OUT', 'en', { words: 'no Tesla' })).toBe(
      'A plan cannot leave one company out of a list it holds, so “no Tesla” was not applied.',
    );
    expect(said('CANNOT_LEAVE_OUT', 'pt', { words: 'sem Tesla' })).toBe(
      'Um plano não deixa uma empresa de fora de uma lista que mantém, então “sem Tesla” não foi aplicado.',
    );
    expect(said('SHARE_TOO_SMALL', 'en', { least: 25 })).toBe(
      'The smallest part a plan of this size can hold is $25, so a smaller one was not taken.',
    );
    expect(said('SHARE_TOO_SMALL', 'pt', { least: 25 })).toBe(
      'A menor parte que um plano deste tamanho pode ter é US$ 25, então uma parte menor não foi considerada.',
    );
    // The line a refusal is said in where the model did not read it is the credit line of the
    // read-back, word for word, so the person reads one thing in both places.
    for (const lang of LANGUAGES) {
      const credit = READBACK_TEMPLATES.NO_CREDIT[lang].replace(/\.$/, '');
      expect(ASSUMPTION_TEMPLATES.REFUSAL_TAKEN_CREDIT[lang].toLowerCase(), lang).toContain(
        credit.toLowerCase(),
      );
    }
  });

  // Product words follow the brand: goal, limits, plan, portfolio, exit plan, rebalance. The words
  // these lines use for the product are "plan" and nothing else; none promises a return, and none
  // names another product.
  it('the lines of the second review say "plan" for the product, promise nothing and name no one', () => {
    const lines = [
      QUESTION_TEMPLATES.themeShares,
      QUESTION_TEMPLATES.themeAndRest,
      QUESTION_TEMPLATES.holdOrLeaveOut,
      QUESTION_TEMPLATES.matchedShare,
      QUESTION_TEMPLATES.matchedShareNoAmount,
      ASSUMPTION_TEMPLATES.REFUSAL_TAKEN,
      ASSUMPTION_TEMPLATES.REFUSAL_TAKEN_CREDIT,
      ASSUMPTION_TEMPLATES.REFUSAL_OF_A_PART,
      ASSUMPTION_TEMPLATES.CANNOT_LEAVE_OUT,
      ASSUMPTION_TEMPLATES.SHARE_TOO_SMALL,
    ];
    for (const line of lines)
      for (const lang of LANGUAGES) {
        const text = line[lang];
        expect(text, text).not.toMatch(
          /\b(?:basket|index|fund of funds|strategy|product|account|wallet app|robo)\b|\b(?:cesta|estratégia|produto|conta)\b/i,
        );
        expect(text, text).not.toMatch(
          /\b(?:return|returns|yield|gain|profit|guarantee|earn|beat|outperform)\w*\s+(?:of|de)\s+\d|\d+\s*%|guarantee|garant/i,
        );
        for (const pattern of [...BANNED[lang], ...BRAND_BANNED])
          expect(text, text).not.toMatch(pattern);
      }
    // Where they name the product, the word is "plan" / "plano".
    for (const id of ['REFUSAL_OF_A_PART', 'CANNOT_LEAVE_OUT', 'SHARE_TOO_SMALL'] as const) {
      expect(ASSUMPTION_TEMPLATES[id].en).toMatch(/\bplan\b/);
      expect(ASSUMPTION_TEMPLATES[id].pt).toMatch(/\bplano\b/);
    }
  });

  it('names a theme filled by a filter by what it was matched by, in both languages', () => {
    expect(placeholdersOf(MATCHED_NAME.pt)).toEqual(placeholdersOf(MATCHED_NAME.en));
    for (const lang of LANGUAGES) {
      expect(Object.keys(FILTER_BY_WORDS[lang]).sort()).toEqual([...MARKET_FILTER_BY].sort());
      for (const by of MARKET_FILTER_BY) {
        const said = render(
          MATCHED_NAME[lang],
          { by: FILTER_BY_WORDS[lang][by], value: 'Aerospace & Defense' },
          lang,
        );
        expect(said, `${by}.${lang}`).toMatch(/: Aerospace & Defense$/);
        expect(said, `${by}.${lang}`).not.toMatch(/[{}]|undefined|NaN|null/);
        // Never said as a curated theme.
        expect(said, `${by}.${lang}`).not.toMatch(/theme|tema|curat|curad/i);
        for (const pattern of [...BANNED[lang], ...BRAND_BANNED])
          expect(said, `${by}.${lang} against ${pattern}`).not.toMatch(pattern);
      }
    }
    expect(FILTER_BY_WORDS.en).toEqual({
      sector: 'sector',
      industry: 'industry',
      sub_industry: 'sub-industry',
      keyword: 'keyword',
    });
    expect(FILTER_BY_WORDS.pt).toEqual({
      sector: 'setor',
      industry: 'indústria',
      sub_industry: 'subindústria',
      keyword: 'palavra-chave',
    });
  });

  // How long the goal runs, the way the person said it (Oct 6): "about 5 years" is not "60 months".
  it('says the time frame in months, in years or as a date, and one year as one', () => {
    expect(TERM_SAID).toEqual({
      months: { en: 'over {months|months}', pt: 'em {months|months}' },
      years: { en: 'over {years|years}', pt: 'em {years|years}' },
      date: { en: 'by {month|month}', pt: 'até {month|month}' },
    });
    expect(render('{a|years} · {b|years}', { a: 5, b: 1 }, 'en')).toBe('5 years · 1 year');
    expect(render('{a|years} · {b|years}', { a: 5, b: 1 }, 'pt')).toBe('5 anos · 1 ano');
    expect(() => render('{a|years}', { a: 'soon' }, 'en')).toThrow(/a/);
    // The goal's line takes the phrase whole, and no months of its own.
    for (const id of ['GOAL', 'GOAL_MIX'] as const)
      for (const lang of LANGUAGES) {
        const keys = placeholdersOf(READBACK_TEMPLATES[id][lang]).map((p) => p.key);
        expect(keys, `${id}.${lang}`).toContain('term');
        expect(keys, `${id}.${lang}`).not.toContain('months');
      }
    for (const lang of LANGUAGES) {
      const filled = (said: keyof typeof TERM_SAID) =>
        render(
          READBACK_TEMPLATES.GOAL[lang],
          {
            goal: 'grow',
            amount: 5000,
            risk: 'medium',
            term: render(TERM_SAID[said][lang], sampleParams(TERM_SAID[said][lang]), lang),
          },
          lang,
        );
      expect([filled('months'), filled('years'), filled('date')]).toEqual(
        lang === 'en'
          ? [
              'You set a goal to grow with $5,000 over 18 months, at medium risk.',
              'You set a goal to grow with $5,000 over 5 years, at medium risk.',
              'You set a goal to grow with $5,000 by April 2028, at medium risk.',
            ]
          : [
              'Você definiu um objetivo de crescimento com US$ 5.000 em 18 meses, com risco médio.',
              'Você definiu um objetivo de crescimento com US$ 5.000 em 5 anos, com risco médio.',
              'Você definiu um objetivo de crescimento com US$ 5.000 até abril de 2028, com risco médio.',
            ],
      );
    }
  });

  // The review of Oct 6, finding 4: a risk the person gave is never replaced in silence.
  it('says the risk the person gave and the limits the plan uses to hold what they asked, in one line', () => {
    expect(ASSUMPTION_TEMPLATES.MIX_LIMITS_OTHER_RISK).toEqual({
      en: 'You said {said|risk}, but to hold “{words}” the plan uses the limits for {risk|risk}.',
      pt: 'Você disse {said|risk}, mas para manter “{words}” o plano usa os limites de {risk|risk}.',
    });
    const params = { said: 'low', words: 'all of it in stocks', risk: 'high' };
    expect(render(ASSUMPTION_TEMPLATES.MIX_LIMITS_OTHER_RISK.en, params, 'en')).toBe(
      'You said low risk, but to hold “all of it in stocks” the plan uses the limits for high risk.',
    );
    expect(
      render(
        ASSUMPTION_TEMPLATES.MIX_LIMITS_OTHER_RISK.pt,
        { ...params, words: 'tudo em ações' },
        'pt',
      ),
    ).toBe(
      'Você disse risco baixo, mas para manter “tudo em ações” o plano usa os limites de risco alto.',
    );
  });

  // A refusal the text writes and the intake does not take (the person was not sure, or the model
  // read one where the clause says otherwise) is said, never dropped in silence.
  it('says a refusal it did not take, in the person words, and how to have it taken', () => {
    expect(ASSUMPTION_TEMPLATES.REFUSAL_NOT_TAKEN).toEqual({
      en: 'I did not read “{words}” as something to leave out. Say so if you want it left out.',
      pt: 'Não li “{words}” como algo a deixar de fora. Diga se quiser que fique de fora.',
    });
    expect(render(ASSUMPTION_TEMPLATES.REFUSAL_NOT_TAKEN.en, { words: 'no stocks' }, 'en')).toBe(
      'I did not read “no stocks” as something to leave out. Say so if you want it left out.',
    );
  });

  // A fund of class `etf` is a fund of stocks: "funds" alone would read as any fund, and the shelf
  // also has funds that pay a dollar yield.
  it('says each class a person can leave out, and the funds as stock funds, in the order they are said', () => {
    expect(CLASS_WORDS).toEqual({
      en: {
        stock: 'stocks',
        etf: 'stock funds',
        gold: 'gold',
        commodity: 'commodities',
        dollar_yield: 'dollar yield',
        crypto: 'crypto',
      },
      pt: {
        stock: 'ações',
        etf: 'fundos de ações',
        gold: 'ouro',
        commodity: 'commodities',
        dollar_yield: 'rendimento em dólar',
        crypto: 'cripto',
      },
    });
    // The order of the keys is the order of saying: stocks, then the funds of them.
    for (const lang of LANGUAGES)
      expect(Object.keys(CLASS_WORDS[lang]).slice(0, 2)).toEqual(['stock', 'etf']);
    const said = (lang: 'en' | 'pt', classes: string[]) =>
      render(
        READBACK_TEMPLATES.CANNOT_HOLD[lang],
        { classes: classes.map((c) => CLASS_WORDS[lang][c] ?? c).join(',') },
        lang,
      );
    expect(said('en', ['stock', 'etf'])).toBe('You left out stocks and stock funds.');
    expect(said('pt', ['stock', 'etf'])).toBe('Você deixou de fora ações e fundos de ações.');
    expect(said('en', ['etf'])).toBe('You left out stock funds.');
    expect(said('pt', ['etf'])).toBe('Você deixou de fora fundos de ações.');
  });

  it('ban what reads as advice or a return promise', () => {
    for (const lang of LANGUAGES) {
      const texts = [
        ...intake.map((t) => ({ id: t.id, text: t[lang] })),
        ...intake.map((t) => ({
          id: `${t.id} filled`,
          text: render(t[lang], sampleParams(t[lang]), lang),
        })),
        ...Object.values(CLASS_WORDS[lang]).map((text) => ({ id: 'a class', text })),
      ];
      for (const { id, text } of texts)
        for (const pattern of [...BANNED[lang], ...BRAND_BANNED])
          expect(text, `${id}.${lang} against ${pattern}`).not.toMatch(pattern);
    }
  });
});
