import type { Language } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import evalSet from './fixtures/goals-eval.json';
import recorded from './fixtures/intake-replies.json';
import { runIntake, type ShelfPortfolio } from './intake';
import { readNumber } from './intake-text';
import { filterOfSlug } from './market-filter';
import { readBack, type ThemeNames } from './readback';
import { CLASS_WORDS, placeholdersOf, READBACK_TEMPLATES, render, WORDS } from './templates';
import { launchShelf } from './testing';
import type { PersonalSheet } from './types';

// C18: the read-back the person confirms holds no number and no name that the sheet does not. It is
// drawn from the validated sheet by templates, so this holds the templates and the code that fills
// them. The check is the one of portfolio-method.md section 2.6, items 1 to 3: every numeral maps to a
// value of the sheet once the locale is undone, and every name is a value of the sheet or words of the
// templates themselves. The last test plants the errors the check is for and sees each one caught.

const portfolios: ShelfPortfolio[] = launchShelf().families.map((f) => ({
  slug: f.meta.slug,
  name: f.meta.name,
}));

// MOCK. The names handed in for the theme sleeves a sheet holds (gates THEMES and THEME-MATCHED): two
// curated labels, and the value two filters matched by as the stocks' attributes write it. Written by
// hand for these tests: the label files and the attribute files live with the theme sleeve.
const THEMES: ThemeNames = {
  labels: [
    { slug: 'ai', name: { en: 'AI', pt: 'IA' } },
    { slug: 'semiconductors', name: { en: 'Semiconductors', pt: 'Semicondutores' } },
  ],
  matched: {
    'matched-industry-aerospace-defense': 'Aerospace & Defense',
    'matched-keyword-glp-1': 'GLP-1',
  },
};
/** What a theme sleeve's slug is said by, as handed in: a label's name, a matched value, a portfolio's name. */
const themeSaidBy = (slug: string, lang: Language): string =>
  filterOfSlug(slug)
    ? (THEMES.matched?.[slug] ?? '')
    : (THEMES.labels?.find((l) => l.slug === slug)?.name[lang] ??
      portfolios.find((p) => p.slug === slug)?.name ??
      slug);

/** The numbers a sheet holds, as a read-back may write them. */
function numbersOf(sheet: PersonalSheet): Set<number> {
  const out = new Set<number>([sheet.amountUsd, sheet.horizonMonths]);
  if (sheet.incomeTargetUsdMonthly !== undefined) out.add(sheet.incomeTargetUsdMonthly);
  if (sheet.limits?.mustKeepUsd !== undefined) out.add(sheet.limits.mustKeepUsd);
  if (sheet.limits?.mayNeedInMonths !== undefined) out.add(sheet.limits.mayNeedInMonths);
  for (const o of sheet.obligations ?? []) {
    out.add(o.amount);
    out.add(Number(o.month.slice(0, 4)));
  }
  for (const s of sheet.sleeves ?? []) out.add(s.shareBps / 100);
  // What the person said to hold (gate EXPLICIT-MIX), as percents of the plan.
  const mix = sheet.mix;
  if (mix)
    for (const bps of [
      mix.growthBps,
      mix.dollarYieldBps,
      mix.goldBps,
      mix.cashBps,
      mix.creditBps ?? 0,
    ])
      out.add(bps / 100);
  // A shared portfolio's name may hold a number ("The 500"), and so may what a theme sleeve is said
  // by ("GLP-1"): each is the name handed in for a slug the sheet holds.
  const named = [
    ...sheet.themes.map((slug) => portfolios.find((p) => p.slug === slug)?.name ?? ''),
    ...(sheet.sleeves ?? []).flatMap((s) =>
      s.kind === 'theme' ? [themeSaidBy(s.theme, sheet.language)] : [],
    ),
  ];
  for (const name of named) for (const m of name.matchAll(/\d+/g)) out.add(Number(m[0]));
  return out;
}

/** The names a sheet holds, in the words a read-back writes them in. */
function namesOf(sheet: PersonalSheet, lang: Language): Set<string> {
  const words = [
    ...sheet.chains.map((c) => WORDS[lang].chain[c] ?? c),
    sheet.currency ?? '',
    ...sheet.themes.map((slug) => portfolios.find((p) => p.slug === slug)?.name ?? slug),
    ...(sheet.limits?.cannotHold?.classes ?? []).map((c) => CLASS_WORDS[lang][c] ?? c),
    ...(sheet.limits?.cannotHold?.underlyings ?? []),
    ...(sheet.limits?.cannotHold?.assets ?? []),
    ...(sheet.obligations ?? []).flatMap((o) => [
      o.currency,
      render('{m|month}', { m: o.month }, lang),
    ]),
    ...(sheet.sleeves ?? []).flatMap((s) =>
      s.kind === 'theme' ? [themeSaidBy(s.theme, lang)] : [],
    ),
  ];
  return new Set(words.join(' ').split(/\s+/).filter(Boolean));
}

/** The capitalised words the templates of a language write on their own. */
const templateWords = (lang: Language) =>
  new Set(
    Object.values(READBACK_TEMPLATES)
      .map((t) => t[lang].replace(/\{[^}]*\}/g, ' '))
      .join(' ')
      .split(/\s+/)
      .map((w) => w.replace(/[.,:;]$/, ''))
      .filter((w) => /\p{Lu}/u.test(w)),
  );

/** What in a read-back the sheet does not hold: numbers, names. Empty when it holds no such thing. */
function unsupported(sentences: string[], sheet: PersonalSheet): string[] {
  const lang = sheet.language;
  const numbers = numbersOf(sheet);
  const names = namesOf(sheet, lang);
  const fixed = templateWords(lang);
  const out: string[] = [];
  for (const sentence of sentences) {
    for (const m of sentence.matchAll(/\d[\d.,]*\d|\d/g)) {
      const n = readNumber(m[0]);
      if (![...numbers].some((x) => Math.abs(x - n) < 1e-9)) out.push(`number ${m[0]}`);
    }
    for (const raw of sentence.split(/\s+/)) {
      const word = raw.replace(/[.,:;]$/, '');
      if (!/\p{Lu}/u.test(word) || /^\$?\d/.test(word)) continue;
      if (!names.has(word) && !fixed.has(word)) out.push(`name ${word}`);
    }
  }
  return out;
}

// Every goal of the evaluation set, through the intake to a sheet, in both languages, plus sheets
// that use every sentence of the read-back.
function sheets(): PersonalSheet[] {
  const out: PersonalSheet[] = [];
  const replies = recorded.replies as Record<string, unknown>;
  for (const g of evalSet.goals) {
    const answers = {
      goal: 'grow' as const,
      amountUsd: 1234.5,
      incomeTargetUsdMonthly: 40,
      horizonMonths: 30,
      risk: 'medium' as const,
      country: 'PT',
      themes: [],
    };
    const input = {
      text: g.text,
      nowMonth: evalSet.nowMonth,
      reply: replies[g.id] ?? null,
      homeChain: 'robinhood' as const,
      portfolios,
    };
    const asked = runIntake(input).questions.map((q) => q.field as string);
    const result = runIntake({
      ...input,
      answers: Object.fromEntries(Object.entries(answers).filter(([k]) => asked.includes(k))),
    });
    if (result.sheet) out.push(result.sheet);
  }
  const slugs = portfolios.map((p) => p.slug);
  const full: PersonalSheet = {
    basketType: 'standard',
    goal: 'income',
    amountUsd: 80_000,
    horizonMonths: 60,
    risk: 'low',
    themes: slugs.slice(0, 2),
    country: 'BR',
    chains: ['solana'],
    incomeTargetUsdMonthly: 300,
    rules: { useHoldings: false, glide: false },
    language: 'en',
    currency: 'BRL',
    obligations: [
      { month: '2027-04', amount: 2500.5, currency: 'BRL' },
      { month: '2028-12', amount: 1000, currency: 'USD' },
    ],
    sleeves: [
      { kind: 'goal', shareBps: 5000 },
      { kind: 'safe_yield', shareBps: 2550 },
      { kind: 'theme', shareBps: 2450, theme: slugs[0] ?? 'the-seven' },
    ],
    restoreSplit: true,
    limits: {
      mustKeepUsd: 20_000,
      mayNeedInMonths: 9,
      creditTolerance: 'none',
      cannotHold: { classes: ['stock', 'crypto'], underlyings: ['TSLA'], assets: ['solana:usdy'] },
    },
  };
  out.push(full, { ...full, language: 'pt' }, { ...full, limits: { creditTolerance: 'limited' } });
  out.push({ ...full, limits: { creditTolerance: 'accept' }, language: 'pt' });
  out.push({ ...full, restoreSplit: false });
  // A goal with no date (Oct 6).
  out.push({ ...full, horizonOpen: true });
  // A mix the person stated (gate EXPLICIT-MIX), with every part and a credit share.
  const { sleeves: _sleeves, restoreSplit: _restore, ...noSplit } = full;
  out.push({
    ...noSplit,
    goal: 'grow',
    risk: 'medium',
    mix: { growthBps: 4000, dollarYieldBps: 3000, goldBps: 2000, cashBps: 1000, creditBps: 1500 },
  });
  // A mix with no date: the goal line names no risk either.
  out.push({
    ...noSplit,
    goal: 'grow',
    risk: 'high',
    horizonOpen: true,
    mix: { growthBps: 10_000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 },
  });
  // A plan held in themes (gates THEMES and THEME-MATCHED): two curated labels, two matched themes
  // and a part kept safe, with no part for the goal; and one curated label that is the whole plan.
  out.push({
    ...noSplit,
    goal: 'grow',
    risk: 'high',
    sleeves: [
      { kind: 'theme', shareBps: 3000, theme: 'ai' },
      { kind: 'theme', shareBps: 2000, theme: 'semiconductors' },
      { kind: 'theme', shareBps: 2500, theme: 'matched-industry-aerospace-defense' },
      { kind: 'theme', shareBps: 500, theme: 'matched-keyword-glp-1' },
      { kind: 'safe_yield', shareBps: 2000 },
    ],
  });
  out.push({
    ...noSplit,
    goal: 'grow',
    risk: 'high',
    horizonOpen: true,
    sleeves: [{ kind: 'theme', shareBps: 10_000, theme: 'ai' }],
  });
  return [
    ...out,
    ...out.map((s) => ({ ...s, language: s.language === 'en' ? 'pt' : 'en' }) as PersonalSheet),
  ];
}

describe('the read-back (C18)', () => {
  it('with a mix, says the risk once, as the assumption, never in the goal line', () => {
    for (const s of sheets().filter((x) => x.mix))
      expect(readBack(s, [])[0]).not.toMatch(/risk|risco/);
  });

  const all = sheets();

  it('is made for every goal of the set and uses every sentence it has', () => {
    expect(all.length).toBeGreaterThan(2 * evalSet.goals.length);
    const used = new Set<string>();
    for (const sheet of all)
      for (const sentence of readBack(sheet, portfolios, THEMES))
        for (const [id, t] of Object.entries(READBACK_TEMPLATES)) {
          const shape = new RegExp(
            `^${t[sheet.language]
              .replace(/[.*+?^$()[\]\\|]/g, '\\$&')
              .replace(/\\?\{[^}]*\}/g, '.+')}$`,
          );
          if (shape.test(sentence)) used.add(id);
        }
    expect([...used].sort()).toEqual(Object.keys(READBACK_TEMPLATES).sort());
  });

  it('holds no number and no name that the sheet does not, in either language', () => {
    for (const sheet of all) {
      const sentences = readBack(sheet, portfolios, THEMES);
      expect(unsupported(sentences, sheet), JSON.stringify(sheet)).toEqual([]);
      expect(sentences.join(' '), JSON.stringify(sheet)).not.toMatch(/[{}]|undefined|NaN|null/);
    }
  });

  it('says "no date set" for a goal with no date, never the months it is built over (Oct 6)', () => {
    const open = all.find((s) => s.horizonOpen && s.language === 'en') as PersonalSheet;
    const said = readBack(open, portfolios, THEMES);
    expect(said[0]).toMatch(/with no date set/);
    expect(said.join(' ')).not.toMatch(new RegExp(`\\b${open.horizonMonths} months`));
    const pt = readBack({ ...open, language: 'pt' }, portfolios, THEMES);
    expect(pt[0]).toMatch(/sem data definida/);
  });

  it('says the glide only when it is on, and the risk of the part not kept safe (Oct 6)', () => {
    const full = all.find((s) => s.obligations && s.language === 'en') as PersonalSheet;
    const off = readBack(full, portfolios, THEMES).join(' ');
    expect(off).not.toMatch(/date nears/);
    expect(off).toMatch(/The low risk is for the part that seeks the goal/);
    const on = readBack(
      { ...full, rules: { useHoldings: false, glide: true } },
      portfolios,
      THEMES,
    );
    expect(on.join(' ')).toMatch(/As the date nears/);
  });

  // Gates THEMES and THEME-MATCHED: a theme sleeve is said by the name handed in for its slug.
  const heldInThemes = (s: PersonalSheet) =>
    s.sleeves?.some((x) => x.kind === 'theme') === true &&
    !s.sleeves.some((x) => x.kind === 'goal');

  it('says a curated label by its name in the sheet language, and a matched theme by what it was matched by', () => {
    const themed = all.find((s) => s.sleeves?.length === 5 && s.language === 'en') as PersonalSheet;
    expect(readBack(themed, portfolios, THEMES)).toEqual(
      expect.arrayContaining([
        '30% of the plan for the theme AI.',
        '20% of the plan for the theme Semiconductors.',
        '25% of the plan for stocks matched by industry: Aerospace & Defense.',
        '5% of the plan for stocks matched by business line: GLP-1.',
        '20% of the plan for dollar yield from a rate alone.',
      ]),
    );
    expect(readBack({ ...themed, language: 'pt' }, portfolios, THEMES)).toEqual(
      expect.arrayContaining([
        '30% do plano para o tema IA.',
        '20% do plano para o tema Semicondutores.',
        '25% do plano para ações que correspondem a indústria: Aerospace & Defense.',
        '5% do plano para ações que correspondem a linha de negócio: GLP-1.',
        '20% do plano para rendimento em dólar só de taxa.',
      ]),
    );
    // A matched theme is never said as a curated one.
    expect(readBack(themed, portfolios, THEMES).join(' ')).not.toMatch(
      /the theme (stocks|matched)/,
    );
    // With no name handed in nothing is made up: the slug is said, and the key a filter matched by.
    expect(readBack(themed, portfolios)).toEqual(
      expect.arrayContaining([
        '30% of the plan for the theme ai.',
        '25% of the plan for stocks matched by industry: aerospace-defense.',
      ]),
    );
    // The same where a name handed in is blank: said by the slug, never as a hole.
    const blank = {
      labels: [{ slug: 'ai', name: { en: '', pt: '' } }],
      matched: { 'matched-keyword-glp-1': '' },
    };
    expect(readBack(themed, portfolios, blank)).toEqual(
      expect.arrayContaining([
        '30% of the plan for the theme ai.',
        '5% of the plan for stocks matched by business line: glp-1.',
      ]),
    );
  });

  it('with a plan held in themes says no risk of its own: its limits follow what it holds', () => {
    const themed = all.filter(heldInThemes);
    expect(themed.length).toBeGreaterThan(2);
    for (const s of themed) {
      const said = readBack(s, portfolios, THEMES);
      expect(said[0], JSON.stringify(s)).not.toMatch(/risk|risco/);
      expect(said.join(' '), JSON.stringify(s)).not.toMatch(
        /part that seeks the goal|parte que busca o objetivo/,
      );
    }
    // With a part for the goal beside a theme, the plan's risk is that part's, and it is said.
    const withGoal = all.find((s) => s.obligations && s.language === 'en') as PersonalSheet;
    expect(heldInThemes(withGoal)).toBe(false);
    expect(readBack(withGoal, portfolios, THEMES)[0]).toMatch(/at low risk\.$/);
  });

  it('writes amounts with their cents, never rounded to a figure the sheet does not hold', () => {
    const sheet = all.find((s) => s.amountUsd === 1234.5 && s.language === 'en');
    expect(readBack(sheet as PersonalSheet, portfolios, THEMES)[0]).toMatch(/\$1,234\.50 /);
    const pt = all.find((s) => s.amountUsd === 1234.5 && s.language === 'pt');
    expect(readBack(pt as PersonalSheet, portfolios, THEMES)[0]).toMatch(/US\$ 1\.234,50 /);
  });

  it('self-check: a wrong number, a swapped name or an added name is caught', () => {
    const sheet = all.find((s) => s.obligations && s.language === 'en') as PersonalSheet;
    const good = readBack(sheet, portfolios, THEMES);
    expect(unsupported(good, sheet)).toEqual([]);
    const planted = [
      good.map((s) => s.replace('$80,000', '$85,000')),
      good.map((s) => s.replace('60 months', '61 months')),
      good.map((s) => s.replace('Solana', 'Base')),
      // The country is no longer said (gate COUNTRY-REMOVED, Oct 6): an added one is caught.
      [...good, 'You live in Chile.'],
      good.map((s) => s.replace('April 2027', 'May 2027')),
      [...good, 'Most people pick NVDA.'],
      good.map((s) => s.replace('50%', '55%')),
    ];
    for (const sentences of planted)
      expect(unsupported(sentences, sheet).length, sentences.join(' ')).toBeGreaterThan(0);
    // The same for a plan held in themes: another label, another value, another figure in a value.
    const themed = all.find((s) => s.sleeves?.length === 5 && s.language === 'en') as PersonalSheet;
    const said = readBack(themed, portfolios, THEMES);
    expect(unsupported(said, themed)).toEqual([]);
    for (const sentences of [
      said.map((s) => s.replace('the theme AI', 'the theme Robotics')),
      said.map((s) => s.replace('Aerospace & Defense', 'Airlines')),
      said.map((s) => s.replace('GLP-1', 'GLP-2')),
      said.map((s) => s.replace('25%', '35%')),
    ])
      expect(unsupported(sentences, themed).length, sentences.join(' ')).toBeGreaterThan(0);
  });

  it('every value a read-back template takes is one the code above fills from the sheet', () => {
    const keys = new Set(
      Object.values(READBACK_TEMPLATES).flatMap((t) => placeholdersOf(t.en).map((p) => p.key)),
    );
    expect([...keys].sort()).toEqual(
      [
        'amount',
        'chain',
        'classes',
        'currency',
        'goal',
        'income',
        'matched',
        'month',
        'months',
        'names',
        'risk',
        'share',
        'theme',
        'themes',
      ].sort(),
    );
  });
});
