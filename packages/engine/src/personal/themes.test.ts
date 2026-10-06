import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlanSleeve, Shelf } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { candidates, compose } from './index';
import { PERSONAL_PARAMS } from './params';
import {
  aiList,
  allReasons,
  editShelf,
  fixtureContext,
  fixtureLiquidity,
  launchShelf,
  sheet,
  violations,
} from './testing';
import { parseThemeList, type ThemeList } from './theme-list';
import { equalCapped } from './theme-sleeve';
import {
  type ComposeContext,
  PersonalInputError,
  type PersonalParameters,
  type PersonalProposal,
  type PersonalSheet,
  PersonalSheet as SheetSchema,
} from './types';

// ENG-3 slice 4 (docs/vault/PROMPT-BUILD-SOLVER.md), the theme sleeve (gates SLEEVES, THEMES): a
// share of the plan in equal parts of the names on a curated list for the person's chain, each up to
// its limits, in at most the lines the plan has left (C17). The list is data
// (`content/themes/solana/ai.json`), handed to `compose` in its context.

const shelf = launchShelf();
const ai = aiList();
const ctxWith = (over: Partial<ComposeContext> = {}) => fixtureContext({ themes: [ai], ...over });
const ctx = ctxWith();
const halves: PlanSleeve[] = [
  { kind: 'goal', shareBps: 5000 },
  { kind: 'theme', shareBps: 5000, theme: 'ai' },
];
const themed = (over: Partial<PersonalSheet> = {}) => sheet({ sleeves: halves, ...over });
const run = (s: PersonalSheet, c: ComposeContext = ctx, onShelf: Shelf = shelf) => {
  const plan = compose(s, onShelf, c);
  expect(violations(plan, onShelf, c)).toEqual([]);
  return plan;
};
const themeOf = (plan: PersonalProposal, slug = 'ai') =>
  plan.split?.find((x) => x.kind === 'theme' && x.theme === slug);
const SYMBOLS = new Set(ai.members.map((m) => m.symbol));
const symbolOf = (id: string) => shelf.assets.find((a) => a.id === id)?.symbol ?? id;
/** What the theme holds in names of its list, by symbol. */
const namesHeld = (plan: PersonalProposal) =>
  new Map(
    (themeOf(plan)?.holds ?? [])
      .filter((h) => SYMBOLS.has(symbolOf(h.assetId)))
      .map((h) => [symbolOf(h.assetId), h.amountUsd]),
  );
const removedWhy = (plan: PersonalProposal, ref: string) =>
  plan.removed.find((r) => r.ref === ref)?.reasons.map((r) => r.rule) ?? [];
const every = (cents: number) => Math.round(cents * 100);
const roomyLines = () => ctxWith({ params: { ...PERSONAL_PARAMS, maxLinesPerChain: 16 } });

describe('the list is data', () => {
  it('every file under content/themes validates, sits at <chain>/<slug>.json, and names tokens its chain lists', () => {
    const root = join(import.meta.dirname, '../../../../content/themes');
    const files = readdirSync(root).flatMap((chain) =>
      readdirSync(join(root, chain)).map((file) => ({ chain, file })),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const { chain, file } of files) {
      const list = parseThemeList(JSON.parse(readFileSync(join(root, chain, file), 'utf8')), file);
      expect(`${list.chain}/${list.slug}.json`).toBe(`${chain}/${file}`);
      const listed = new Set(
        shelf.assets.filter((a) => a.chain === list.chain).map((a) => a.symbol),
      );
      for (const m of list.members) expect(listed.has(m.symbol), m.symbol).toBe(true);
    }
  });

  it('the Solana AI list is the seven names Rodrigo confirmed on Oct 5 (gate THEME-AI-SOLANA)', () => {
    expect(ai.status).toBe('confirmed');
    expect(ai.curator).toBe('Rodrigo');
    expect(ai.decidedOn).toBe('2026-10-05');
    expect(ai.members.map((m) => m.symbol).sort()).toEqual(
      ['AAPLx', 'AMZNx', 'GOOGLx', 'METAx', 'MSFTx', 'NVDAx', 'TSLAx'].sort(),
    );
    // QQQx is a fund that would hold the others twice.
    expect(SYMBOLS.has('QQQx')).toBe(false);
  });

  it('refuses a list that does not validate, and two lists of one theme on one chain', () => {
    const twice = { ...ai, members: [...ai.members, ai.members[0]] };
    expect(() => parseThemeList(twice)).toThrow(PersonalInputError);
    expect(() => parseThemeList({ ...ai, status: 'final' })).toThrow(PersonalInputError);
    expect(() => parseThemeList({ ...ai, extra: 1 })).toThrow(PersonalInputError);
    expect(() =>
      compose(themed(), shelf, ctxWith({ themes: [ai, { ...ai, version: 2 }] })),
    ).toThrow('a theme has two lists on one chain');
  });

  it('the hash of the inputs pins the lists the sheet names, and only those', () => {
    const one = compose(themed(), shelf, ctx).inputsHash;
    const two = compose(themed(), shelf, ctxWith({ themes: [{ ...ai, version: 2 }] })).inputsHash;
    expect(two).not.toBe(one);
    // A plan with no theme sleeve hashes exactly as it did with no list given.
    const plain = compose(sheet(), shelf, fixtureContext()).inputsHash;
    expect(compose(sheet(), shelf, ctx).inputsHash).toBe(plain);
    expect(compose(sheet(), shelf, ctxWith({ themes: [{ ...ai, version: 9 }] })).inputsHash).toBe(
      plain,
    );
    // Editing a list the sheet does not name re-hashes nothing.
    const other: ThemeList = { ...ai, slug: 'chips', version: 1 };
    expect(compose(themed(), shelf, ctxWith({ themes: [ai, other] })).inputsHash).toBe(one);
    expect(
      compose(themed(), shelf, ctxWith({ themes: [ai, { ...other, version: 2 }] })).inputsHash,
    ).toBe(one);
  });
});

describe('equal parts, each up to its cap', () => {
  it('shares equally, and hands what a capped part leaves to the others', () => {
    expect(equalCapped(900, [1000, 1000, 1000])).toEqual([300, 300, 300]);
    expect(equalCapped(900, [100, 1000, 1000])).toEqual([100, 400, 400]);
    expect(equalCapped(1000, [100, 200, 300])).toEqual([100, 200, 300]);
    expect(equalCapped(10, [0, 5, 100])).toEqual([0, 5, 5]);
    expect(equalCapped(7, [10, 10, 10])).toEqual([3, 2, 2]);
  });
});

describe('a split goal 50% / theme 50%', () => {
  it('at high risk, the theme holds its whole share in its names, in equal parts', () => {
    const plan = run(themed({ risk: 'high' }));
    const theme = themeOf(plan);
    expect(theme?.amountUsd).toBe(5000);
    const held = [...namesHeld(plan).values()];
    // The goal holds SPYx and one dollar-yield token at high risk: six lines are left for seven names.
    expect(held.length).toBe(6);
    expect(Math.max(...held) - Math.min(...held)).toBeLessThanOrEqual(0.01);
    expect(every(held.reduce((n, x) => n + x, 0))).toBe(every(5000));
    // Every line of a name says the theme, the share and why the name is on the list.
    const nvda = plan.lines.find((l) => l.assetId === 'solana:nvdax');
    expect(nvda?.reasons.map((r) => r.text)).toContain(
      'You set 50% of the plan for the theme AI: equal shares of the names on its list for Solana that you can hold and that can be sold at this size, each up to its limit.',
    );
    expect(nvda?.reasons.map((r) => r.text)).toContain(
      'NVDAx is on the AI list for Solana, version 1, kept by Rodrigo: Nvidia makes most of the chips used to train and run AI models.',
    );
  });

  it('THEME-FIRST: at medium risk the theme keeps its share of the one issuer, and the goal’s SPYx shrinks, said', () => {
    const plan = run(themed());
    const theme = themeOf(plan);
    expect(theme?.amountUsd).toBe(5000);
    const held = [...namesHeld(plan).values()];
    // Every stock token on Solana has one issuer (Backed): 70% of the plan at medium risk. The theme
    // holds its $5,000 in full, in equal parts; the goal's GLDx keeps $250, and SPYx takes the rest.
    expect(every(held.reduce((n, x) => n + x, 0))).toBe(every(5000));
    expect(Math.max(...held) - Math.min(...held)).toBeLessThanOrEqual(0.01);
    expect(theme?.holds.every((h) => SYMBOLS.has(symbolOf(h.assetId)))).toBe(true);
    const spy = plan.lines.find((l) => l.assetId === 'solana:spyx');
    expect(spy?.amountUsd).toBe(1750);
    expect(spy?.reasons.map((r) => r.rule)).toContain('ISSUER_CAP');
    const said = allReasons(plan).find((r) => r.rule === 'OVERFLOW_ISSUER');
    expect(said?.params.assets).toBe('SPY');
    expect(said?.params.usd).toBe(2250);
  });

  it('THEME-FIRST holds when the goal follows a shared portfolio of the same issuer', () => {
    // The Seven is held whole only if it fits beside the theme; else it is opened and shrinks.
    const plan = run(themed({ themes: ['the-seven'] }));
    expect(every([...namesHeld(plan).values()].reduce((n, x) => n + x, 0))).toBe(every(5000));
  });

  it('the theme in Portuguese names it IA, with the reason in Portuguese', () => {
    const plan = run(themed({ language: 'pt', risk: 'high' }));
    const texts = plan.lines.find((l) => l.assetId === 'solana:nvdax')?.reasons.map((r) => r.text);
    expect(texts).toContain(
      'NVDAx está na lista IA da Solana, versão 1, mantida por Rodrigo: a Nvidia fabrica a maior parte dos chips usados para treinar e rodar modelos de IA.',
    );
  });

  it('a theme sleeve alone, the whole plan, holds the names the lines allow', () => {
    const plan = run(
      sheet({ risk: 'high', sleeves: [{ kind: 'theme', shareBps: 10_000, theme: 'ai' }] }),
    );
    // Seven names, eight lines, $10,000: each name $1,428 or $1,429, under the 35% cap.
    const held = [...namesHeld(plan).values()];
    expect(held.length).toBe(7);
    expect(Math.max(...held) - Math.min(...held)).toBeLessThanOrEqual(0.01);
  });
});

describe('C17: at most the lines left, each within its cap, the same under shuffling', () => {
  /** Every name measured, each with its own depth, so the order of ease is known. */
  const depth: Record<string, number> = {
    'solana:nvdax': 3_000_000,
    'solana:tslax': 2_500_000,
    'solana:aaplx': 2_000_000,
    'solana:msftx': 1_500_000,
    'solana:googlx': 1_000_000,
    'solana:metax': 800_000,
    'solana:amznx': 600_000,
    'solana:spyx': 5_000_000,
    'solana:gldx': 40_000,
  };
  const measured = ctxWith({ liquidity: fixtureLiquidity(depth) });
  const byEase = Object.entries(depth)
    .filter(([id]) => SYMBOLS.has(symbolOf(id)))
    .sort(([, a], [, b]) => b - a)
    .map(([id]) => symbolOf(id));
  const table = (over: Partial<PersonalParameters>): PersonalParameters => ({
    ...PERSONAL_PARAMS,
    ...over,
  });

  it.each([3, 4, 5, 6, 8, 12])(
    'with %i lines a plan, the theme holds the easiest names that fit in the lines the goal leaves',
    (max) => {
      const c = { ...measured, params: table({ maxLinesPerChain: max }) };
      const plan = run(themed({ risk: 'high' }), c);
      const held = namesHeld(plan);
      const goalLines = plan.lines.filter(
        (l) => !SYMBOLS.has(symbolOf(l.assetId)) && !l.assetId.endsWith(':usdc'),
      ).length;
      const left = Math.max(0, max - goalLines);
      expect(held.size).toBeLessThanOrEqual(left);
      expect(held.size).toBe(Math.min(7, left));
      expect([...held.keys()].sort()).toEqual(byEase.slice(0, held.size).sort());
      for (const symbol of byEase.slice(held.size))
        expect(removedWhy(plan, symbol), symbol).toContain('MAX_LINES');
      // Each within its cap: the cap on one stock, its exit ceiling, its issuer (violations checks
      // them all); and the names not at a limit in equal parts.
      const stockCap = (10_000 * (PERSONAL_PARAMS.capPerStockBps.high ?? 0)) / 10_000;
      for (const usd of held.values()) expect(usd).toBeLessThanOrEqual(stockCap);
    },
  );

  it('the cap on one stock holds a name, and the others share what it leaves', () => {
    // At low risk one stock is at most 10% of the plan: $1,000 of $10,000. Seven names of a $10,000
    // theme ask $1,428 each.
    const c = {
      ...measured,
      params: table({ capPerIssuerBps: { low: 10_000, medium: 10_000, high: 10_000 } }),
    };
    const plan = run(
      sheet({ risk: 'low', sleeves: [{ kind: 'theme', shareBps: 10_000, theme: 'ai' }] }),
      c,
    );
    for (const usd of namesHeld(plan).values()) expect(usd).toBeLessThanOrEqual(1000);
    expect(allReasons(plan).some((r) => r.rule === 'OVERFLOW_STOCK_CAP')).toBe(true);
  });

  it('is the same plan whatever order the shelf lists its tokens and the list its names', () => {
    const s = themed({ risk: 'high' });
    const base = compose(s, shelf, measured);
    for (let seed = 1; seed <= 20; seed += 1) {
      const order = (key: string) =>
        [...key].reduce((n, ch) => (n * seed + ch.charCodeAt(0)) % 9973, seed);
      const assets = [...shelf.assets].sort((a, b) => order(a.id) - order(b.id));
      const members = [...ai.members].sort((a, b) => order(a.symbol) - order(b.symbol));
      const c = { ...measured, themes: [{ ...ai, members }] };
      expect(compose(s, { ...shelf, assets }, c)).toEqual(base);
    }
  });
});

describe('a name is left out, with why', () => {
  const roomy = (over: Partial<ComposeContext> = {}) =>
    ctxWith({ params: { ...PERSONAL_PARAMS, maxLinesPerChain: 16 }, ...over });

  it('not listed on the chain', () => {
    const without = { ...shelf, assets: shelf.assets.filter((a) => a.id !== 'solana:amznx') };
    const plan = run(themed({ risk: 'high' }), roomy(), without);
    expect(namesHeld(plan).has('AMZNx')).toBe(false);
    expect(removedWhy(plan, 'AMZNx')).toEqual(['NOT_ON_CHAIN']);
    expect(namesHeld(plan).size).toBe(6);
  });

  it('not offered in the person’s country', () => {
    const blocked = editShelf(shelf, (a) =>
      a.id === 'solana:metax' ? { ...a, blockedCountries: ['BR'] } : a,
    );
    const plan = run(themed({ risk: 'high' }), roomy(), blocked);
    expect(namesHeld(plan).has('METAx')).toBe(false);
    expect(removedWhy(plan, 'METAx')).toEqual(['NOT_IN_COUNTRY']);
  });

  it('ruled out by the person', () => {
    const plan = run(
      themed({ risk: 'high', limits: { cannotHold: { underlyings: ['TSLA'] } } }),
      roomy(),
    );
    expect(namesHeld(plan).has('TSLAx')).toBe(false);
    expect(removedWhy(plan, 'TSLAx')).toEqual(['EXCLUDED']);
  });

  it('too thin to sell at this size: its measured exit cannot take a line', () => {
    const thin = fixtureLiquidity({ 'solana:msftx': 10, 'solana:nvdax': 1_500_000 });
    const plan = run(themed({ risk: 'high' }), roomy({ liquidity: thin }));
    expect(namesHeld(plan).has('MSFTx')).toBe(false);
    expect(removedWhy(plan, 'MSFTx')).toEqual(['THEME_TOO_THIN', 'EXIT_CEILING']);
  });

  it('a name on a tier, with nothing measured, says its limit is a tier and is flagged', () => {
    const plan = run(themed({ risk: 'high' }), roomy());
    const aapl = plan.lines.find((l) => l.assetId === 'solana:aaplx');
    expect(aapl?.reasons.map((r) => r.rule)).toContain('TIER_CEILING');
    expect(plan.flags).toContain('ceiling_from_tier:solana:aaplx');
  });
});

describe('PROTECT-NO-STOCKS: a plan to protect or for income holds no name of a theme of stocks', () => {
  it.each(['protect', 'income'] as const)(
    'for a goal to %s, every name is left out and the sleeve is held in dollar yield and cash, said',
    (goal) => {
      const plan = run(themed({ goal }));
      expect(namesHeld(plan).size).toBe(0);
      for (const symbol of SYMBOLS)
        expect(removedWhy(plan, symbol), symbol).toEqual(['NOT_FOR_GOAL']);
      expect(plan.flags).toContain('theme_empty:ai');
      expect(allReasons(plan).some((r) => r.rule === 'OVERFLOW_NOT_FOR_GOAL')).toBe(true);
      const lines = plan.lines.map((l) => shelf.assets.find((a) => a.id === l.assetId)?.cls);
      expect(lines.every((cls) => cls === 'dollar_yield' || cls === 'cash' || cls === 'gold')).toBe(
        true,
      );
      expect(themeOf(plan)?.amountUsd).toBe(5000);
    },
  );
});

describe('a theme with no confirmed list on the chain holds no name, and says so', () => {
  it('no list on Robinhood Chain', () => {
    const plan = run(themed({ chains: ['robinhood'] }));
    expect(plan.flags).toContain('theme_no_list:ai');
    expect(removedWhy(plan, 'ai')).toEqual(['THEME_NO_LIST']);
    expect(allReasons(plan).map((r) => r.text)).toContain(
      'The theme ai holds no name: there is no list for it on Robinhood Chain.',
    );
  });

  it('a list that is only proposed is not used', () => {
    const proposed: ThemeList = { ...ai, status: 'proposed' };
    const plan = run(themed(), ctxWith({ themes: [proposed] }));
    expect(namesHeld(plan).size).toBe(0);
    expect(plan.flags).toContain('theme_not_confirmed:ai');
    expect(removedWhy(plan, 'ai')).toEqual(['THEME_NOT_CONFIRMED']);
  });
});

describe('the sleeves stay apart', () => {
  it('what must not be lost cannot be more than the sleeves outside the themes hold', () => {
    const over = { ...themed(), limits: { mustKeepUsd: 6000 } };
    expect(SheetSchema.safeParse(over).success).toBe(false);
    expect(() => compose(over, shelf, ctx)).toThrow(PersonalInputError);
    expect(SheetSchema.safeParse({ ...over, limits: { mustKeepUsd: 5000 } }).success).toBe(true);
  });

  it('the goal’s withdrawals do not sell the theme', () => {
    const owing = themed({
      risk: 'high',
      obligations: [{ month: '2026-11', amount: 4000, currency: 'USD' }],
    });
    const plan = run(owing);
    const held = [...namesHeld(plan).values()];
    expect(held.length).toBeGreaterThan(0);
    expect(Math.max(...held) - Math.min(...held)).toBeLessThanOrEqual(0.01);
    expect(themeOf(plan)?.amountUsd).toBe(5000);
  });
});

describe('the three candidates with a theme sleeve', () => {
  it.each(['grow', 'protect'] as const)(
    'for a goal to %s, each keeps every rule and the theme’s share',
    (goal) => {
      for (const risk of ['low', 'medium', 'high'] as const) {
        const s = themed({ goal, risk });
        const answer = candidates(s, shelf, ctx);
        expect(answer.shown.length).toBeGreaterThan(0);
        for (const { id, plan } of answer.shown) {
          expect(violations(plan, shelf, ctx), `${goal} ${risk} ${id}`).toEqual([]);
          expect(themeOf(plan)?.amountUsd).toBe(5000);
        }
      }
    },
  );
});

describe('C17: names on a tier that tie are ordered by id, whatever the order given', () => {
  it('with nothing measured, the tier-B names fill the lines left in the order of their ids', () => {
    // NVDAx and TSLAx are tier A, the other five tier B at one ceiling: a tie, broken by id.
    const c = ctxWith({
      liquidity: fixtureLiquidity({}),
      params: { ...PERSONAL_PARAMS, maxLinesPerChain: 6 },
    });
    const s = themed({ risk: 'high' });
    const base = run(s, c);
    const held = [...namesHeld(base).keys()].sort();
    const tierB = ['AAPLx', 'AMZNx', 'GOOGLx', 'METAx', 'MSFTx'];
    const takenB = held.filter((x) => tierB.includes(x));
    expect(held).toEqual(expect.arrayContaining(['NVDAx', 'TSLAx']));
    expect(takenB.length).toBeGreaterThan(0);
    expect(takenB.length).toBeLessThan(tierB.length);
    // By id: solana:aaplx < solana:amznx < solana:googlx < solana:metax < solana:msftx.
    expect(takenB).toEqual(tierB.slice(0, takenB.length));
    for (let seed = 1; seed <= 20; seed += 1) {
      const order = (key: string) =>
        [...key].reduce((n, ch) => (n * seed + ch.charCodeAt(0)) % 9973, seed);
      const assets = [...shelf.assets].sort((a, b) => order(a.id) - order(b.id));
      const members = [...ai.members].sort((a, b) => order(a.symbol) - order(b.symbol));
      expect(compose(s, { ...shelf, assets }, { ...c, themes: [{ ...ai, members }] })).toEqual(
        base,
      );
    }
  });
});

describe('what the person already holds counts in the theme sleeve, as in the goal', () => {
  it('NVDA held in full: the theme buys no NVDAx, says so, and the others take more', () => {
    const s = themed({ risk: 'high', rules: { useHoldings: true, glide: true } });
    const plain = run(s);
    const plan = run(s, ctxWith({ holdings: [{ underlying: 'NVDA', valueUsd: 9000 }] }));
    expect(namesHeld(plain).has('NVDAx')).toBe(true);
    expect(namesHeld(plan).has('NVDAx')).toBe(false);
    expect(removedWhy(plan, 'NVDAx')).toEqual(['ALREADY_HELD_NONE']);
    const texts = allReasons(plan).map((r) => r.text);
    expect(texts).toContain('No NVDA: you already hold $9,000 of it.');
    const others = [...namesHeld(plan).values()];
    expect(every(others.reduce((n, x) => n + x, 0))).toBe(every(5000));
    expect(texts).toContain(
      'A larger share here: you already hold $9,000 of NVDA, so this plan buys less of it.',
    );
  });

  it('NVDA held in part: NVDAx is bought less, and its line says why', () => {
    const s = themed({ risk: 'high', rules: { useHoldings: true, glide: true } });
    const plan = run(s, ctxWith({ holdings: [{ underlying: 'NVDA', valueUsd: 300 }] }));
    const nvda = namesHeld(plan).get('NVDAx') ?? 0;
    const others = [...namesHeld(plan).entries()].filter(([k]) => k !== 'NVDAx').map(([, v]) => v);
    expect(nvda).toBeGreaterThan(0);
    expect(nvda).toBeLessThan(Math.min(...others));
    const line = plan.lines.find((l) => l.assetId === 'solana:nvdax');
    expect(line?.reasons.map((r) => r.rule)).toContain('ALREADY_HELD');
  });

  it('with holdings switched off, a holding changes nothing', () => {
    const s = themed({ risk: 'high', rules: { useHoldings: false, glide: true } });
    const withHeld = compose(
      s,
      shelf,
      ctxWith({ holdings: [{ underlying: 'NVDA', valueUsd: 9000 }] }),
    );
    expect(withHeld.lines).toEqual(compose(s, shelf, ctx).lines);
  });
});

describe('edge cases of the names', () => {
  it('two tokens under one symbol: the first by id the person can hold is the name’s', () => {
    const nvda = shelf.assets.find((a) => a.id === 'solana:nvdax');
    if (!nvda) throw new Error('no NVDAx');
    const twin = { ...nvda, id: 'solana:nvdax-a', issuer: 'Twin issuer', blockedCountries: ['BR'] };
    const second = { ...nvda, id: 'solana:nvdax-b', issuer: 'Twin issuer' };
    const doubled = {
      ...shelf,
      assets: [...shelf.assets.filter((a) => a.id !== 'solana:nvdax'), second, twin],
    };
    const plan = run(themed({ risk: 'high' }), roomyLines(), doubled);
    expect(plan.lines.some((l) => l.assetId === 'solana:nvdax-b')).toBe(true);
    expect(plan.lines.some((l) => l.assetId === 'solana:nvdax-a')).toBe(false);
    // Both blocked: the name is left out for the first one's reason.
    const both = editShelf(doubled, (a) =>
      a.id === 'solana:nvdax-b' ? { ...a, blockedCountries: ['BR'] } : a,
    );
    expect(removedWhy(run(themed({ risk: 'high' }), roomyLines(), both), 'NVDAx')).toEqual([
      'NOT_IN_COUNTRY',
    ]);
  });

  it('a list with a stock and a gold token of one issuer reads each name’s own issuer room', () => {
    const mixed: ThemeList = {
      ...ai,
      slug: 'mixed',
      members: [
        { symbol: 'GLDx', reason: { en: 'gold', pt: 'ouro' } },
        { symbol: 'NVDAx', reason: { en: 'chips', pt: 'chips' } },
      ],
    };
    // The plan's issuer cap (dollar yield, gold and cash) at 1%: gold is held to it, the stock is not.
    const c = ctxWith({
      themes: [mixed],
      params: { ...PERSONAL_PARAMS, issuerCapBps: 100, maxLinesPerChain: 16 },
    });
    const plan = run(
      sheet({ risk: 'high', sleeves: [{ kind: 'theme', shareBps: 10_000, theme: 'mixed' }] }),
      c,
    );
    const holds = new Map(
      (themeOf(plan, 'mixed')?.holds ?? []).map((h) => [symbolOf(h.assetId), h.amountUsd]),
    );
    expect(holds.get('GLDx')).toBe(100);
    expect(holds.get('NVDAx')).toBe(3500);
  });
});
