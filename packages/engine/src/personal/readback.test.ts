import type { Language } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import evalSet from './fixtures/goals-eval.json';
import recorded from './fixtures/intake-replies.json';
import { runIntake, type ShelfPortfolio } from './intake';
import { readNumber } from './intake-text';
import { readBack } from './readback';
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
  // A shared portfolio's name may hold a number ("The 500"): it is the name of a slug the sheet holds.
  const named = [
    ...sheet.themes,
    ...(sheet.sleeves ?? []).flatMap((s) => (s.kind === 'theme' ? [s.theme] : [])),
  ];
  for (const slug of named)
    for (const m of (portfolios.find((p) => p.slug === slug)?.name ?? '').matchAll(/\d+/g))
      out.add(Number(m[0]));
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
      s.kind === 'theme' ? [portfolios.find((p) => p.slug === s.theme)?.name ?? s.theme] : [],
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
  return [
    ...out,
    ...out.map((s) => ({ ...s, language: s.language === 'en' ? 'pt' : 'en' }) as PersonalSheet),
  ];
}

describe('the read-back (C18)', () => {
  const all = sheets();

  it('is made for every goal of the set and uses every sentence it has', () => {
    expect(all.length).toBeGreaterThan(2 * evalSet.goals.length);
    const used = new Set<string>();
    for (const sheet of all)
      for (const sentence of readBack(sheet, portfolios))
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
      const sentences = readBack(sheet, portfolios);
      expect(unsupported(sentences, sheet), JSON.stringify(sheet)).toEqual([]);
      expect(sentences.join(' '), JSON.stringify(sheet)).not.toMatch(/[{}]|undefined|NaN|null/);
    }
  });

  it('says "no date set" for a goal with no date, never the months it is built over (Oct 6)', () => {
    const open = all.find((s) => s.horizonOpen && s.language === 'en') as PersonalSheet;
    const said = readBack(open, portfolios);
    expect(said[0]).toMatch(/with no date set/);
    expect(said.join(' ')).not.toMatch(new RegExp(`\\b${open.horizonMonths} months`));
    const pt = readBack({ ...open, language: 'pt' }, portfolios);
    expect(pt[0]).toMatch(/sem data definida/);
  });

  it('says the glide only when it is on, and the risk of the part not kept safe (Oct 6)', () => {
    const full = all.find((s) => s.obligations && s.language === 'en') as PersonalSheet;
    const off = readBack(full, portfolios).join(' ');
    expect(off).not.toMatch(/date nears/);
    expect(off).toMatch(/The low risk is for the part that seeks the goal/);
    const on = readBack({ ...full, rules: { useHoldings: false, glide: true } }, portfolios);
    expect(on.join(' ')).toMatch(/As the date nears/);
  });

  it('writes amounts with their cents, never rounded to a figure the sheet does not hold', () => {
    const sheet = all.find((s) => s.amountUsd === 1234.5 && s.language === 'en');
    expect(readBack(sheet as PersonalSheet, portfolios)[0]).toMatch(/\$1,234\.50 /);
    const pt = all.find((s) => s.amountUsd === 1234.5 && s.language === 'pt');
    expect(readBack(pt as PersonalSheet, portfolios)[0]).toMatch(/US\$ 1\.234,50 /);
  });

  it('self-check: a wrong number, a swapped name or an added name is caught', () => {
    const sheet = all.find((s) => s.obligations && s.language === 'en') as PersonalSheet;
    const good = readBack(sheet, portfolios);
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
