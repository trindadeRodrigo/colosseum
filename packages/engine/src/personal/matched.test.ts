import type { PlanSleeve, Shelf } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { candidates, compose } from './index';
import { type MarketFilterBy, matchedSlug } from './market-filter';
import { filterMatchOf, shelfLabelsOf } from './matched-theme';
import { PERSONAL_PARAMS } from './params';
import type { StockAttributes } from './stock-attributes';
import {
  aiList,
  allReasons,
  fixtureContext,
  fixtureStocks,
  launchShelf,
  sheet,
  violations,
} from './testing';
import { parseThemeList } from './theme-list';
import {
  type ComposeContext,
  PersonalInputError,
  type PersonalProposal,
  type PersonalSheet,
} from './types';

// ENG-3, gate THEME-MATCHED: the second way to fill a theme sleeve. A filter names one sourced
// attribute of a tracked stock and the value it must carry; pure code selects the stocks
// (./matched-theme.test.ts); the sleeve holds them as it holds a curated list, and every line says
// they are matched, not curated. This is the sleeve, in a plan.
//
// The attributes here are `fixtureStocks` of ./testing.ts: a few rows written for the tests, each
// labelled as a fixture. No row is real content.

const shelf = launchShelf();
const stocks = fixtureStocks('solana');
const rows = stocks.stocks;
const ai = aiList();
const ctxWith = (over: Partial<ComposeContext> = {}) =>
  fixtureContext({ themes: [ai], stocks, ...over });
const ctx = ctxWith();

const slugOf = (by: MarketFilterBy, value: string): string => {
  const slug = matchedSlug({ by, value });
  if (slug === null) throw new Error(`no slug for ${value}`);
  return slug;
};
/** NVDAx, MSFTx and AAPLx on Solana; TSMx carries it too, and Solana does not list TSMx. */
const TECH = slugOf('sector', 'Information Technology');
/** AMZNx, GOOGLx and MSFTx. */
const CLOUD = slugOf('keyword', 'cloud');
/** AAPLx alone, by a value with commas in it. */
const HARDWARE = slugOf('industry', 'Technology Hardware, Storage & Peripherals');
/** LMTx, which no chain lists. */
const DEFENSE = slugOf('industry', 'Aerospace & Defense');
/** No stock at all. */
const UTILITIES = slugOf('sector', 'Utilities');
/** GLDx: a fund, of gold. */
const GOLD = slugOf('keyword', 'gold');

const halfIn = (theme: string): PlanSleeve[] => [
  { kind: 'goal', shareBps: 5000 },
  { kind: 'theme', shareBps: 5000, theme },
];
const themed = (theme: string, over: Partial<PersonalSheet> = {}) =>
  sheet({ risk: 'high', sleeves: halfIn(theme), ...over });
const run = (s: PersonalSheet, c: ComposeContext = ctx, onShelf: Shelf = shelf) => {
  const plan = compose(s, onShelf, c);
  expect(violations(plan, onShelf, c)).toEqual([]);
  return plan;
};
const themeOf = (plan: PersonalProposal, slug: string) =>
  plan.split?.find((x) => x.kind === 'theme' && x.theme === slug);
const assetOf = (id: string) => shelf.assets.find((a) => a.id === id);
/** What a theme holds, in dollars, by the symbol of the token. */
const heldBy = (plan: PersonalProposal, slug: string) =>
  new Map(
    (themeOf(plan, slug)?.holds ?? []).map((h) => [
      assetOf(h.assetId)?.symbol ?? h.assetId,
      h.amountUsd,
    ]),
  );
/** The symbols of the stocks, funds and gold a theme holds: what is not dollar yield or cash. */
const namesHeld = (plan: PersonalProposal, slug: string) =>
  (themeOf(plan, slug)?.holds ?? [])
    .filter((h) => !['dollar_yield', 'cash'].includes(assetOf(h.assetId)?.cls ?? ''))
    .map((h) => assetOf(h.assetId)?.symbol)
    .sort();
const removedWhy = (plan: PersonalProposal, ref: string) =>
  plan.removed.find((r) => r.ref === ref)?.reasons.map((r) => r.rule) ?? [];
const removedSays = (plan: PersonalProposal, ref: string) =>
  plan.removed.find((r) => r.ref === ref)?.reasons.map((r) => r.text) ?? [];
const textsOf = (plan: PersonalProposal, assetId: string) =>
  plan.lines.find((l) => l.assetId === assetId)?.reasons.map((r) => r.text) ?? [];
const rulesOf = (plan: PersonalProposal, assetId: string) =>
  plan.lines.find((l) => l.assetId === assetId)?.reasons.map((r) => r.rule) ?? [];
const cents = (usd: number) => Math.round(usd * 100);
/** A way to put a list in another order that depends only on the seed. */
const shuffled = <T>(items: readonly T[], key: (item: T) => string, seed: number): T[] => {
  const order = (text: string) =>
    [...text].reduce((n, ch) => (n * seed + ch.charCodeAt(0)) % 9973, seed);
  return [...items].sort((a, b) => order(key(a)) - order(key(b)));
};

describe('a matched theme sleeve holds the stocks its filter matches, as a curated list is held', () => {
  it('in equal parts, and every line says it is matched, by what, and from which attributes', () => {
    const plan = run(themed(TECH));
    expect(themeOf(plan, TECH)).toEqual({
      kind: 'theme',
      theme: TECH,
      matched: { by: 'sector', value: 'Information Technology' },
      shareBps: 5000,
      amountUsd: 5000,
      holds: [
        { assetId: 'solana:aaplx', amountUsd: 1666.67 },
        { assetId: 'solana:msftx', amountUsd: 1666.66 },
        { assetId: 'solana:nvdax', amountUsd: 1666.67 },
      ],
    });
    expect(textsOf(plan, 'solana:nvdax')).toEqual(
      expect.arrayContaining([
        "You set 50% of the plan for stocks matched by sector: Information Technology. Matched from each stock's sourced attributes, not a curated theme: equal shares of the ones you can hold on Solana and that can be sold at this size, each up to its limit.",
        'NVDAx is matched by sector: Information Technology (attributes version 3, read 2026-10-06), not from a curated theme: NVIDIA Corporation: its sector is Information Technology.',
      ]),
    );
    for (const id of ['solana:aaplx', 'solana:msftx', 'solana:nvdax'])
      expect(rulesOf(plan, id), id).toEqual(
        expect.arrayContaining(['THEME_MATCHED_SLEEVE', 'THEME_MATCHED_MEMBER']),
      );
    // TSMx carries the value and Solana does not list it: left out with why, as a curated name is.
    expect(removedWhy(plan, 'TSMx')).toEqual(['NOT_ON_CHAIN']);
    expect(plan.flags.filter((f) => f.startsWith('theme_'))).toEqual([]);
  });

  it('never as a curated theme: no list, no curator, no confirmation asked', () => {
    const plan = run(themed(TECH));
    const said = allReasons(plan);
    expect(said.some((r) => r.rule === 'THEME_SLEEVE' || r.rule === 'THEME_MEMBER')).toBe(false);
    const matched = said.filter((r) => r.rule.startsWith('THEME_MATCHED_'));
    expect(matched.length).toBeGreaterThan(0);
    for (const r of matched) {
      expect(r.text, r.rule).toMatch(/not (from )?a curated theme/);
      expect(r.text, r.rule).not.toMatch(/kept by|on the .* list|confirmed/);
      expect(r.params.curator).toBeUndefined();
      expect(r.params.by).toBe('sector');
      expect(r.params.value).toBe('Information Technology');
    }
    // It needs no confirmation, where a curated list that is only proposed holds nothing.
    expect(plan.flags).not.toContain(`theme_not_confirmed:${TECH}`);
    const proposed = run(themed('ai'), ctxWith({ themes: [{ ...ai, status: 'proposed' }] }));
    expect(proposed.flags).toContain('theme_not_confirmed:ai');
    // A curated theme carries no such label on the split.
    expect(themeOf(run(themed('ai')), 'ai')).not.toHaveProperty('matched');
  });

  it('by a keyword, in Portuguese', () => {
    const plan = run(themed(CLOUD, { language: 'pt' }));
    expect(namesHeld(plan, CLOUD)).toEqual(['AMZNx', 'GOOGLx', 'MSFTx']);
    expect(textsOf(plan, 'solana:amznx')).toEqual(
      expect.arrayContaining([
        'Você destinou 50% do plano para ações filtradas por linha de negócio: cloud. Filtradas pelos atributos de cada ação, que têm fonte, e não por um tema com curadoria: partes iguais das que você pode ter na Solana e que podem ser vendidas neste tamanho, cada uma até o seu limite.',
        'AMZNx entra pelo filtro de linha de negócio: cloud (atributos na versão 3, lidos em 2026-10-06), e não por um tema com curadoria: Amazon.com, Inc.: uma das linhas de negócio dela é cloud.',
      ]),
    );
  });

  it('holds what the intake is told it would: the same value, and as many stocks as the shelf lists', () => {
    for (const [by, value] of [
      ['keyword', 'Cloud'],
      ['sector', 'information technology'],
      ['keyword', 'gold'],
    ] as const) {
      const slug = slugOf(by, value);
      const found = filterMatchOf({ by, value }, stocks, shelf.assets);
      if (!found) throw new Error(`no match for ${value}`);
      const plan = run(themed(slug));
      expect(namesHeld(plan, slug).length, value).toBe(found.listed);
      expect(themeOf(plan, slug)?.matched).toEqual({ by, value: found.value });
    }
    // And a curated label, with no limit in the way: as many names as it says the shelf lists.
    const [label] = shelfLabelsOf([ai], shelf.assets);
    const roomy = ctxWith({ params: { ...PERSONAL_PARAMS, maxLinesPerChain: 16 } });
    expect(namesHeld(run(themed('ai'), roomy), 'ai').length).toBe(label?.listed);
  });

  it('each name up to the cap on one stock, and the rest in dollar yield, said', () => {
    // At medium risk one stock is at most 20% of the plan: $2,000 of the $5,000 the theme has.
    const plan = run(themed(HARDWARE, { risk: 'medium' }));
    expect(heldBy(plan, HARDWARE).get('AAPLx')).toBe(2000);
    expect(themeOf(plan, HARDWARE)?.amountUsd).toBe(5000);
    expect(allReasons(plan).map((r) => r.text)).toContain(
      '$3,000 meant for AAPLx is held in dollar yield or cash instead: no more than 20% of the plan is in one stock or one crypto asset at medium risk.',
    );
  });

  it('THEME-FIRST: it keeps its share of an issuer, and the goal’s stocks take what is left', () => {
    const plan = run(themed(TECH, { risk: 'medium' }));
    expect(cents([...heldBy(plan, TECH).values()].reduce((n, x) => n + x, 0))).toBe(cents(5000));
    const spy = plan.lines.find((l) => l.assetId === 'solana:spyx');
    expect(spy?.amountUsd).toBe(1750);
    expect(spy?.reasons.map((r) => r.text)).toContain(
      'No more than 70% of the plan with one issuer at medium risk: Backed (xStocks) is at that limit, and the theme Information Technology you asked for holds its share of it first.',
    );
  });

  it('a value with a comma in it stays one name where a sentence lists the themes', () => {
    // Three stocks under one industry whose name has two commas, so that the theme fills Backed's room.
    const hardware = 'Technology Hardware, Storage & Peripherals';
    const three = rows.map((row) =>
      ['NVDAx', 'MSFTx'].includes(row.symbol) ? { ...row, industry: hardware } : row,
    );
    const plan = run(
      themed(HARDWARE, { risk: 'medium' }),
      ctxWith({ stocks: { ...stocks, stocks: three } }),
    );
    expect(namesHeld(plan, HARDWARE)).toEqual(['AAPLx', 'MSFTx', 'NVDAx']);
    expect(allReasons(plan).map((r) => r.text)).toContain(
      'No more than 70% of the plan with one issuer at medium risk: Backed (xStocks) is at that limit, and the theme Technology Hardware, Storage & Peripherals you asked for holds its share of it first.',
    );
    // And where the money it kept out is said, on the dollar-yield line.
    const kept = allReasons(plan).filter((r) => r.rule === 'OVERFLOW_ISSUER_THEME');
    expect(kept.length).toBeGreaterThan(0);
    for (const r of kept) expect(r.text).toContain(`the theme ${hardware} you asked for`);
  });

  it('in the lines the plan has left, the easiest to sell first', () => {
    const c = ctxWith({ params: { ...PERSONAL_PARAMS, maxLinesPerChain: 4 } });
    const plan = run(themed(TECH), c);
    // NVDAx is measured; AAPLx and MSFTx are on one tier, and AAPLx comes first by id.
    expect(namesHeld(plan, TECH)).toEqual(['AAPLx', 'NVDAx']);
    expect(removedWhy(plan, 'MSFTx')).toEqual(['MAX_LINES']);
    expect(rulesOf(plan, 'solana:nvdax')).toContain('THEME_EASIEST');
  });

  it('counting what the person already holds, once', () => {
    const plan = run(themed(TECH), ctxWith({ holdings: [{ underlying: 'NVDA', valueUsd: 9000 }] }));
    expect(namesHeld(plan, TECH)).toEqual(['AAPLx', 'MSFTx']);
    expect(removedSays(plan, 'NVDAx')).toEqual([
      'No NVDA in Information Technology: of the $9,000 of it you hold, $2,500 counts here, as much as each of its other names holds.',
    ]);
  });

  it('beside a curated theme that names the same stocks, each sleeve holds its own and the line says both', () => {
    const c = ctxWith({ params: { ...PERSONAL_PARAMS, maxLinesPerChain: 16 } });
    const both: PlanSleeve[] = [
      { kind: 'theme', shareBps: 5000, theme: 'ai' },
      { kind: 'theme', shareBps: 5000, theme: TECH },
    ];
    const plan = run(sheet({ risk: 'high', sleeves: both }), c);
    expect(namesHeld(plan, 'ai').length).toBe(7);
    expect(namesHeld(plan, TECH)).toEqual(['AAPLx', 'MSFTx', 'NVDAx']);
    const nvda = plan.lines.find((l) => l.assetId === 'solana:nvdax');
    expect(nvda?.reasons.map((r) => r.rule)).toEqual(
      expect.arrayContaining([
        'THEME_SLEEVE',
        'THEME_MEMBER',
        'THEME_MATCHED_SLEEVE',
        'THEME_MATCHED_MEMBER',
      ]),
    );
    // One line, holding what the two sleeves hold of it, within the cap on one stock.
    const ofBoth = (heldBy(plan, 'ai').get('NVDAx') ?? 0) + (heldBy(plan, TECH).get('NVDAx') ?? 0);
    expect(cents(nvda?.amountUsd ?? 0)).toBe(cents(ofBoth));
    expect(nvda?.amountUsd ?? 0).toBeLessThanOrEqual(3500);
    // A name of the curated list alone is never said as matched.
    expect(rulesOf(plan, 'solana:tslax')).not.toContain('THEME_MATCHED_MEMBER');
  });

  it('on each chain by that chain’s attributes and shelf', () => {
    // Robinhood Chain lists TSM, so four stocks there; Base lists neither COIN nor HOOD.
    const on = (chain: 'robinhood' | 'base', slug: string) => {
      const c = fixtureContext({ stocks: fixtureStocks(chain) });
      return run(themed(slug, { chains: [chain] }), c);
    };
    const robinhood = on('robinhood', TECH);
    expect((themeOf(robinhood, TECH)?.holds ?? []).map((h) => h.assetId).sort()).toEqual([
      'robinhood:aapl',
      'robinhood:msft',
      'robinhood:nvda',
      'robinhood:tsm',
    ]);
    const markets = slugOf('industry', 'Capital Markets');
    expect(removedSays(on('base', markets), markets)).toEqual([
      'There is no stock for Capital Markets on Base at the moment. We will be adding more soon.',
    ]);
  });
});

describe('PROTECT-NO-STOCKS: a plan to protect or for income holds no stock of a matched theme', () => {
  const growth = (plan: PersonalProposal) =>
    plan.lines.filter((l) => ['stock', 'etf', 'crypto'].includes(assetOf(l.assetId)?.cls ?? ''));

  it.each(['protect', 'income'] as const)(
    'for a goal to %s, every stock is left out by the asset registry and the sleeve is held in dollar yield and cash',
    (goal) => {
      for (const slug of [TECH, CLOUD, HARDWARE]) {
        const plan = run(themed(slug, { goal }));
        expect(growth(plan), slug).toEqual([]);
        expect(namesHeld(plan, slug), slug).toEqual([]);
        expect(themeOf(plan, slug)?.amountUsd).toBe(5000);
        // The stocks are on the chain, so this is not "no stock for it": the goal does not allow them.
        expect(plan.flags, slug).toContain(`theme_empty:${slug}`);
        expect(plan.flags, slug).not.toContain(`theme_no_match:${slug}`);
        expect(allReasons(plan).some((r) => r.rule === 'OVERFLOW_NOT_FOR_GOAL')).toBe(true);
        expect(allReasons(plan).some((r) => r.rule.startsWith('THEME_MATCHED_'))).toBe(false);
      }
      const plan = run(themed(TECH, { goal }));
      for (const symbol of ['AAPLx', 'MSFTx', 'NVDAx'])
        expect(removedWhy(plan, symbol), symbol).toEqual(['NOT_FOR_GOAL']);
    },
  );

  it('the same filter in a plan to grow holds them: the rule is the goal’s, in the registry', () => {
    expect(namesHeld(run(themed(TECH, { goal: 'grow' })), TECH)).toEqual([
      'AAPLx',
      'MSFTx',
      'NVDAx',
    ]);
  });

  it('a fund of gold matched by a keyword follows the registry too: held to protect, never for income', () => {
    expect(namesHeld(run(themed(GOLD, { goal: 'protect' })), GOLD)).toEqual(['GLDx']);
    const income = run(themed(GOLD, { goal: 'income' }));
    expect(namesHeld(income, GOLD)).toEqual([]);
    expect(removedWhy(income, 'GLDx')).toEqual(['NOT_FOR_GOAL']);
    // And an index fund is a stock token to the registry: in neither.
    const funds = slugOf('keyword', 'index fund');
    expect(namesHeld(run(themed(funds)), funds)).toEqual(['QQQx', 'SPYx']);
    for (const goal of ['protect', 'income'] as const)
      expect(namesHeld(run(themed(funds, { goal })), funds)).toEqual([]);
  });
});

describe('a filter with no stock on the chain: the sleeve holds no name, and says so', () => {
  /** Only dollar yield and cash, adding up to the sleeve's dollars. */
  const heldAside = (plan: PersonalProposal, slug: string) => {
    const holds = themeOf(plan, slug)?.holds ?? [];
    expect(holds.length).toBeGreaterThan(0);
    for (const h of holds)
      expect(['dollar_yield', 'cash'], h.assetId).toContain(assetOf(h.assetId)?.cls);
    expect(cents(holds.reduce((n, h) => n + h.amountUsd, 0))).toBe(
      cents(themeOf(plan, slug)?.amountUsd ?? -1),
    );
    return holds.map((h) => assetOf(h.assetId)?.cls);
  };

  it('no stock carries the value: the founder’s sentence, the flag, and the money in dollar yield', () => {
    const plan = run(themed(UTILITIES));
    expect(plan.flags).toContain(`theme_no_match:${UTILITIES}`);
    expect(plan.flags.filter((f) => f.startsWith('theme_')).length).toBe(1);
    expect(removedWhy(plan, UTILITIES)).toEqual(['THEME_NO_MATCH']);
    expect(removedSays(plan, UTILITIES)).toEqual([
      'There is no stock for utilities on Solana at the moment. We will be adding more soon.',
    ]);
    expect(themeOf(plan, UTILITIES)?.amountUsd).toBe(5000);
    expect(themeOf(plan, UTILITIES)?.matched).toEqual({ by: 'sector', value: 'utilities' });
    // Dollar yield has room for all of it here.
    expect(new Set(heldAside(plan, UTILITIES))).toEqual(new Set(['dollar_yield']));
    // The line that took it in says what it was meant for, and why it is there.
    const said = allReasons(plan).filter((r) => r.rule === 'OVERFLOW_THEME_NO_MATCH');
    expect(said.map((r) => r.text)).toContain(
      '$5,000 meant for utilities is held in dollar yield or cash instead: there is no stock for it on Solana at the moment.',
    );
    for (const l of plan.lines)
      if (l.reasons.some((r) => r.rule === 'OVERFLOW_THEME_NO_MATCH'))
        expect(assetOf(l.assetId)?.cls).toBe('dollar_yield');
  });

  it('then cash, where dollar yield takes none of it', () => {
    // No yield is read, so no dollar-yield token is held: the whole sleeve stays in cash.
    const all = sheet({ sleeves: [{ kind: 'theme', shareBps: 10_000, theme: UTILITIES }] });
    const plan = run(all, ctxWith({ yields: [] }));
    expect(themeOf(plan, UTILITIES)?.holds).toEqual([
      { assetId: 'solana:usdc', amountUsd: 10_000 },
    ]);
    expect(plan.lines.map((l) => [l.assetId, l.weightBps])).toEqual([['solana:usdc', 10_000]]);
    expect(rulesOf(plan, 'solana:usdc')).toContain('OVERFLOW_THEME_NO_MATCH');
    expect(plan.flags).toContain(`theme_no_match:${UTILITIES}`);
    // And where it takes part of it, the rest: a rate token at most 40% of the plan.
    const part = run(all);
    expect(new Set(heldAside(part, UTILITIES))).toEqual(new Set(['dollar_yield', 'cash']));
  });

  it('stocks carry the value and the chain lists none of them: the same, by the value as it is written', () => {
    const plan = run(themed(DEFENSE));
    expect(plan.flags).toContain(`theme_no_match:${DEFENSE}`);
    expect(removedSays(plan, DEFENSE)).toEqual([
      'There is no stock for Aerospace & Defense on Solana at the moment. We will be adding more soon.',
    ]);
    expect(themeOf(plan, DEFENSE)?.matched).toEqual({
      by: 'industry',
      value: 'Aerospace & Defense',
    });
    heldAside(plan, DEFENSE);
    // The one sentence says it: the stock the chain does not list is not said again by name.
    expect(plan.removed.map((r) => r.ref)).not.toContain('LMTx');
    expect(plan.flags).not.toContain(`theme_empty:${DEFENSE}`);
  });

  it('no attributes handed in: the same, by the key of the slug', () => {
    const plan = run(themed(TECH), fixtureContext({ themes: [ai] }));
    expect(plan.flags).toContain(`theme_no_match:${TECH}`);
    expect(removedSays(plan, TECH)).toEqual([
      'There is no stock for information-technology on Solana at the moment. We will be adding more soon.',
    ]);
    expect(themeOf(plan, TECH)?.matched).toEqual({ by: 'sector', value: 'information-technology' });
    heldAside(plan, TECH);
    // Attributes with no row in them say the same.
    const bare = run(themed(TECH), ctxWith({ stocks: { ...stocks, stocks: [] } }));
    expect(removedSays(bare, TECH)).toEqual(removedSays(plan, TECH));
    expect(bare.flags).toContain(`theme_no_match:${TECH}`);
  });

  it('in Portuguese, in the founder’s words', () => {
    const plan = run(themed(DEFENSE, { language: 'pt' }));
    expect(removedSays(plan, DEFENSE)).toEqual([
      'No momento não há nenhuma ação para Aerospace & Defense na Solana. Vamos incluir mais em breve.',
    ]);
    expect(allReasons(plan).map((r) => r.text)).toContain(
      'US$ 5.000 que iria para Aerospace & Defense fica em rendimento em dólar ou caixa: no momento não há nenhuma ação para isso na Solana.',
    );
  });

  it('a slug that starts as a filter’s and names none is a theme with no list', () => {
    for (const slug of ['matched-country-brazil', 'matched-industry-Aerospace', 'matched-']) {
      const plan = run(themed(slug));
      expect(plan.flags, slug).toContain(`theme_no_list:${slug}`);
      expect(plan.flags, slug).not.toContain(`theme_no_match:${slug}`);
      expect(removedWhy(plan, slug), slug).toEqual(['THEME_NO_LIST']);
      expect(themeOf(plan, slug)).not.toHaveProperty('matched');
    }
  });
});

describe('what compose is handed', () => {
  it('refuses attributes that do not validate, or of another chain, as it refuses a bad theme list', () => {
    const bad = { ...stocks, version: 0 };
    // Whether or not the sheet asks for a matched theme.
    for (const s of [themed(TECH), sheet()]) {
      expect(() => compose(s, shelf, ctxWith({ stocks: bad }))).toThrow(PersonalInputError);
      expect(() => compose(s, shelf, ctxWith({ stocks: fixtureStocks('base') }))).toThrow(
        'the stock attributes are of base, and the plan is on solana',
      );
    }
    try {
      compose(sheet(), shelf, ctxWith({ stocks: bad }));
      throw new Error('not refused');
    } catch (e) {
      expect(e).toBeInstanceOf(PersonalInputError);
      expect((e as PersonalInputError).code).toBe('InvalidContext');
      expect((e as PersonalInputError).issues.map((i) => i.path)).toEqual(['stocks.version']);
    }
    const twice = { ...stocks, stocks: [...rows, ...rows.slice(0, 1)] };
    expect(() => compose(sheet(), shelf, ctxWith({ stocks: twice }))).toThrow(
      'a symbol is in the file twice',
    );
  });

  it('a curated list never takes a slug that starts with matched-', () => {
    expect(() => parseThemeList({ ...ai, slug: TECH })).toThrow(PersonalInputError);
    expect(() => parseThemeList({ ...ai, slug: 'matched-anything' })).toThrow(
      'a curated list never takes a slug that starts with matched-',
    );
    expect(() =>
      compose(themed(TECH), shelf, ctxWith({ themes: [{ ...ai, slug: TECH }] })),
    ).toThrow(PersonalInputError);
    // The word alone, or inside a slug, is a curated list's to take.
    for (const slug of ['matched', 'well-matched', 'ai'])
      expect(parseThemeList({ ...ai, slug }).slug).toBe(slug);
  });

  it('the hash of the inputs pins what a matched theme read, and nothing of a plan with none', () => {
    const hashOf = (s: PersonalSheet, c: ComposeContext) => compose(s, shelf, c).inputsHash;
    const one = hashOf(themed(TECH), ctx);
    // A new version of the attributes is said on the lines, so it is another plan.
    expect(hashOf(themed(TECH), ctxWith({ stocks: { ...stocks, version: 4 } }))).not.toBe(one);
    expect(hashOf(themed(TECH), ctxWith({ stocks: { ...stocks, readOn: '2026-10-07' } }))).not.toBe(
      one,
    );
    // So is a change in a stock the filter matches: what it says, or that it matches at all.
    const change = (symbol: string, over: Partial<StockAttributes>) => ({
      ...stocks,
      stocks: rows.map((row) => (row.symbol === symbol ? { ...row, ...over } : row)),
    });
    for (const over of [{ company: 'Nvidia' }, { sector: 'Industrials' }])
      expect(hashOf(themed(TECH), ctxWith({ stocks: change('NVDAx', over) }))).not.toBe(one);
    expect(
      hashOf(
        themed(TECH),
        ctxWith({ stocks: change('TSLAx', { sector: 'Information Technology' }) }),
      ),
    ).not.toBe(one);
    // A stock the filter does not match, and the order of the rows, change nothing of it.
    expect(hashOf(themed(TECH), ctxWith({ stocks: change('TSLAx', { company: 'Tesla' }) }))).toBe(
      one,
    );
    expect(
      hashOf(themed(TECH), ctxWith({ stocks: { ...stocks, stocks: [...rows].reverse() } })),
    ).toBe(one);
    // Attributes given where there were none are another plan too.
    expect(hashOf(themed(TECH), fixtureContext({ themes: [ai] }))).not.toBe(one);
    // A plan with no matched theme hashes exactly as it did with no attributes given.
    const plain = hashOf(sheet(), fixtureContext());
    expect(hashOf(sheet(), fixtureContext({ stocks }))).toBe(plain);
    expect(hashOf(sheet(), fixtureContext({ stocks: { ...stocks, version: 9 } }))).toBe(plain);
    const curated = hashOf(themed('ai'), fixtureContext({ themes: [ai] }));
    expect(hashOf(themed('ai'), ctx)).toBe(curated);
    expect(hashOf(themed('ai'), ctxWith({ stocks: { ...stocks, version: 9 } }))).toBe(curated);
  });

  it('is the same plan whatever order the shelf lists its tokens and the attributes their rows', () => {
    for (const s of [themed(TECH), themed(CLOUD, { risk: 'medium' }), themed(DEFENSE)]) {
      const base = compose(s, shelf, ctx);
      expect(compose(s, shelf, ctx)).toEqual(base);
      for (let seed = 1; seed <= 20; seed += 1) {
        const assets = shuffled(shelf.assets, (a) => a.id, seed);
        const turned = shuffled(rows, (row) => row.symbol, seed).map((row) => ({
          ...row,
          keywords: [...row.keywords].reverse(),
        }));
        const c = ctxWith({ stocks: { ...stocks, stocks: turned } });
        expect(compose(s, { ...shelf, assets }, c)).toEqual(base);
      }
    }
  });
});

describe('the three candidates with a matched theme sleeve', () => {
  it.each(['grow', 'protect', 'income'] as const)(
    'for a goal to %s, each keeps every rule and the theme’s share',
    (goal) => {
      for (const risk of ['low', 'medium', 'high'] as const)
        for (const slug of [TECH, CLOUD, DEFENSE]) {
          const s = themed(slug, { goal, risk });
          const answer = candidates(s, shelf, ctx);
          expect(answer.shown.length).toBeGreaterThan(0);
          for (const { id, plan } of answer.shown) {
            expect(violations(plan, shelf, ctx), `${goal} ${risk} ${slug} ${id}`).toEqual([]);
            expect(themeOf(plan, slug)?.amountUsd).toBe(5000);
          }
        }
    },
  );
});

describe('violations() sees a matched sleeve that breaks its rule', () => {
  const plan = run(themed(TECH));
  const empty = run(themed(DEFENSE));
  /** What is wrong with a copy of a plan, changed. */
  const broken = (
    change: (copy: PersonalProposal) => void,
    of: PersonalProposal = plan,
    c: ComposeContext = ctx,
  ) => {
    const copy = structuredClone(of);
    change(copy);
    return violations(copy, shelf, c);
  };
  const flagged = (wrong: string[], what: string) =>
    expect(
      wrong.some((x) => x.includes(what)),
      `${what} in ${JSON.stringify(wrong)}`,
    ).toBe(true);
  const sleeveOf = (copy: PersonalProposal, slug: string) => {
    const sleeve = copy.split?.find((x) => x.theme === slug);
    if (!sleeve) throw new Error('no sleeve');
    return sleeve;
  };
  const eachReason = (
    copy: PersonalProposal,
    rule: string,
    change: (r: { rule: string; params: Record<string, string | number> }) => void,
  ) => {
    for (const l of copy.lines) for (const r of l.reasons) if (r.rule === rule) change(r);
  };

  it('the plans it is tried on are in order', () => {
    expect(broken(() => {})).toEqual([]);
    expect(broken(() => {}, empty)).toEqual([]);
  });

  it('a name its filter does not match', () => {
    // TSLAx is a stock of the shelf that carries another sector.
    const wrong = broken((copy) => {
      const hold = sleeveOf(copy, TECH).holds.find((h) => h.assetId === 'solana:nvdax');
      if (hold) hold.assetId = 'solana:tslax';
    });
    flagged(wrong, 'holds solana:tslax, which its filter does not match');
    // And the same plan read against attributes in which NVDAx no longer carries the value.
    const moved = {
      ...stocks,
      stocks: rows.map((row) => (row.symbol === 'NVDAx' ? { ...row, sector: 'Industrials' } : row)),
    };
    flagged(
      broken(() => {}, plan, ctxWith({ stocks: moved })),
      'holds solana:nvdax, which its filter does not match',
    );
  });

  it('a matched name said as a curated one, or not said as matched', () => {
    const asCurated = broken((copy) =>
      eachReason(copy, 'THEME_MATCHED_MEMBER', (r) => {
        r.rule = 'THEME_MEMBER';
      }),
    );
    flagged(asCurated, 'said of a name no curated theme of the sheet lists');
    flagged(asCurated, 'its line does not say it is matched, and by what');
    const sleeveAsCurated = broken((copy) =>
      eachReason(copy, 'THEME_MATCHED_SLEEVE', (r) => {
        r.rule = 'THEME_SLEEVE';
      }),
    );
    flagged(sleeveAsCurated, 'said of a plan with no such theme sleeve');
    flagged(sleeveAsCurated, 'its line does not say it is matched, and by what');
    // Matched, but by another filter than the sleeve's.
    const byAnother = broken((copy) =>
      eachReason(copy, 'THEME_MATCHED_MEMBER', (r) => {
        r.params.by = 'industry';
      }),
    );
    flagged(byAnother, 'said of a name no filter of the sheet matches');
    // Or from other attributes than the ones given.
    const older = broken((copy) =>
      eachReason(copy, 'THEME_MATCHED_MEMBER', (r) => {
        r.params.version = 2;
      }),
    );
    flagged(older, 'but the attributes given are version 3, read 2026-10-06');
  });

  it('a curated name said as matched', () => {
    const curated = run(themed('ai'));
    const wrong = broken(
      (copy) =>
        eachReason(copy, 'THEME_MEMBER', (r) => {
          r.rule = 'THEME_MATCHED_MEMBER';
          r.params.by = 'sector';
          r.params.value = 'Information Technology';
        }),
      curated,
    );
    flagged(wrong, 'said of a name no filter of the sheet matches');
    flagged(wrong, 'and its line does not say so');
  });

  it('a name held to less than the others with no limit said, as in a curated theme', () => {
    const wrong = broken((copy) => {
      const sleeve = sleeveOf(copy, TECH);
      const hold = sleeve.holds.find((h) => h.assetId === 'solana:nvdax');
      if (hold) hold.amountUsd -= 200;
      sleeve.holds.push({ assetId: 'solana:usdc', amountUsd: 200 });
    });
    flagged(wrong, 'no limit is said');
  });

  it('a split that does not say the theme is matched, or says a curated one is', () => {
    flagged(
      broken((copy) => {
        delete sleeveOf(copy, TECH).matched;
      }),
      'is not labelled as matched on the split',
    );
    flagged(
      broken((copy) => {
        sleeveOf(copy, TECH).matched = { by: 'keyword', value: 'Information Technology' };
      }),
      'is not labelled as matched on the split',
    );
    flagged(
      broken(
        (copy) => {
          sleeveOf(copy, 'ai').matched = { by: 'sector', value: 'AI' };
        },
        run(themed('ai')),
      ),
      'is labelled as matched on the split',
    );
  });

  it('a filter with no stock on the chain, and no flag or no sentence; or either where there is one', () => {
    flagged(
      broken((copy) => {
        copy.flags = copy.flags.filter((f) => !f.startsWith('theme_no_match:'));
      }, empty),
      'the no-match flag is missing',
    );
    flagged(
      broken((copy) => {
        copy.removed = copy.removed.filter((r) => r.ref !== DEFENSE);
      }, empty),
      'matches no stock the chain lists, and the plan does not say so',
    );
    flagged(
      broken((copy) => {
        copy.flags.push(`theme_no_match:${TECH}`);
      }),
      'the no-match flag is misplaced',
    );
    flagged(
      broken((copy) => {
        copy.flags.push(`theme_no_match:${CLOUD}`);
      }),
      'names no theme sleeve of the sheet',
    );
    // The sentence itself, said of a theme that holds its stocks.
    const [said] = empty.removed.flatMap((r) => r.reasons);
    if (!said) throw new Error('no sentence');
    flagged(
      broken((copy) => {
        copy.removed.push({ ref: TECH, reasons: [said] });
      }),
      'said of a plan with no matched theme that matches nothing',
    );
  });
});
