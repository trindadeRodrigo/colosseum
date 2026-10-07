import { describe, expect, it } from 'vitest';
import evalSet from './fixtures/goals-eval.json';
import recorded from './fixtures/intake-replies.json';
import {
  conversationText,
  type IntakeAnswers,
  type IntakeInput,
  readReply,
  riskForMixEstimate,
  runIntake,
  type ShelfPortfolio,
} from './intake';
import {
  MARKET_IDS,
  type Market,
  marketMentionsIn,
  marketShareIn,
  marketsIn,
  mixIn,
  mixSaidIn,
  NARRATIVES,
  phraseIn,
} from './intake-text';
import {
  attributeKey,
  type FilterMatch,
  isMatchedSlug,
  MARKET_FILTER_BY,
  type MarketFilter,
  matchedSlug,
  type ShelfLabel,
} from './market-filter';
import { INTAKE_LIMITS } from './params';
import { launchShelf } from './testing';
import { PersonalSheet } from './types';

// A market, an industry or a trend the person names to invest in (gates EXPLICIT-MIX, THEMES,
// THEME-MATCHED and THEME-NONE-YET): what the intake reads it to, and what the sheet then holds. The model's replies are
// MOCK, written by hand in the shape the API asks the model for. The curated labels and what the
// stocks' sourced attributes carry are MOCK too: the label files and the attribute files live with
// the theme sleeve, and the intake takes both through its input. No test reaches a network.

const NOW = evalSet.nowMonth;
const portfolios: ShelfPortfolio[] = launchShelf().families.map((f) => ({
  slug: f.meta.slug,
  name: f.meta.name,
}));
const without = (...slugs: string[]) => portfolios.filter((p) => !slugs.includes(p.slug));

const label = (
  slug: string,
  en: string,
  pt: string,
  status: ShelfLabel['status'],
  listed: number,
): ShelfLabel => ({ slug, name: { en, pt }, status, listed });
const LABELS: ShelfLabel[] = [
  label('ai', 'AI', 'IA', 'confirmed', 9),
  label('big-tech', 'Big Tech', 'Big Techs', 'confirmed', 7),
  label('semiconductors', 'Semiconductors', 'Semicondutores', 'confirmed', 6),
  label('broad-market', 'Broad Market', 'Mercado Amplo', 'confirmed', 3),
  // Still a proposal: nobody has confirmed its names.
  label('defense', 'Defense', 'Defesa', 'proposed', 3),
  label('quantum-computing', 'Quantum Computing', 'Computação Quântica', 'proposed', 2),
  // Confirmed, and none of its names is listed on this chain.
  label('space', 'Space', 'Espaço', 'confirmed', 0),
];
// What the stocks' attributes carry, by `attributeKey`, and how many of those stocks the shelf lists.
// A keyword is written as the attribute files write it, in small letters.
const ATTRIBUTES: Record<string, FilterMatch> = {
  'sector:health-care': { value: 'Health Care', listed: 3 },
  'industry:aerospace-defense': { value: 'Aerospace & Defense', listed: 4 },
  'industry:software': { value: 'Software', listed: 5 },
  'industry:pharmaceuticals': { value: 'Pharmaceuticals', listed: 2 },
  'industry:insurance': { value: 'Insurance', listed: 2 },
  'keyword:cloud': { value: 'cloud', listed: 5 },
  'keyword:glp-1': { value: 'GLP-1', listed: 2 },
  // Carried by stocks the shelf does not list on this chain.
  'sub_industry:automobile-manufacturers': { value: 'Automobile Manufacturers', listed: 0 },
};
const matchOf = (filter: MarketFilter): FilterMatch | null =>
  ATTRIBUTES[`${filter.by}:${attributeKey(filter.value)}`] ?? null;
/** The filter an entry of `ATTRIBUTES` answers, from its key and its value. */
const filterOf = (key: string, value: string): MarketFilter => ({
  by: MARKET_FILTER_BY.find((by) => key.startsWith(`${by}:`)) ?? 'keyword',
  value,
});

const reply = (over: Record<string, unknown> = {}) => ({
  goal: 'grow',
  amountUsd: 2000,
  incomeTargetUsdMonthly: null,
  horizonMonths: 60,
  risk: null,
  currency: null,
  chain: null,
  portfolios: [],
  language: 'en',
  noCredit: false,
  cannotHold: [],
  unclear: [],
  openEnded: false,
  mayNeedInMonths: null,
  sleeves: null,
  markets: [],
  mix: null,
  marketFilter: null,
  ...over,
});
const intake = (text: string, r: unknown = reply(), over: Partial<IntakeInput> = {}) =>
  runIntake({
    text,
    nowMonth: NOW,
    reply: r,
    homeChain: 'solana',
    portfolios,
    labels: LABELS,
    matchOf,
    ...over,
  });
const fields = (r: { questions: { field: string }[] }) => r.questions.map((q) => q.field);
const cases = (
  recorded as unknown as {
    narratives: { about: string; cases: Record<string, { text: string; reply: unknown }> };
  }
).narratives;
const recordedCase = (name: string) => {
  const found = cases.cases[name];
  if (!found) throw new Error(`no recorded case ${name}`);
  return found;
};

const WHOLE = 10_000;
const theme = (slug: string, shareBps = WHOLE) => ({
  kind: 'theme' as const,
  theme: slug,
  shareBps,
});
const safe = (shareBps: number) => ({ kind: 'safe_yield' as const, shareBps });

describe('the fixtures are labelled MOCK', () => {
  it('says the replies are written by hand, not recorded from a live model', () => {
    expect(cases.about).toMatch(/^MOCK\./);
    expect(cases.about).toMatch(/Not recorded from a live model/);
  });
});

describe('the words of a narrative, read by code', () => {
  // One way to say each in English and one in Portuguese.
  const WORDS: Record<Market, [string, string]> = {
    big_tech: ['big tech', 'gigantes de tecnologia'],
    us_market: ['the US market', 'bolsa americana'],
    ai: ['AI', 'inteligência artificial'],
    semiconductors: ['chip makers', 'semicondutores'],
    ai_infrastructure: ['data centers', 'infraestrutura de IA'],
    crypto_economy: ['crypto stocks', 'empresas de cripto'],
    fintech: ['fintech', 'corretoras'],
    space: ['space stocks', 'setor espacial'],
    quantum: ['quantum computing', 'computação quântica'],
    ev_autonomy: ['electric vehicles', 'carros elétricos'],
    cloud_software: ['SaaS', 'nuvem'],
    emerging_markets: ['emerging markets', 'mercados emergentes'],
    commodities: ['oil', 'petróleo'],
    broad_market: ['index funds', 'fundos de índice'],
    retail_favourites: ['meme stocks', 'ações meme'],
    defense: ['defense stocks', 'setor de defesa'],
    health_care: ['health care stocks', 'setor de saúde'],
    social_media: ['social media stocks', 'empresas de redes sociais'],
  };

  it('has words in English and Portuguese for each, and reads each to its id alone', () => {
    expect(Object.keys(WORDS).sort()).toEqual([...MARKET_IDS].sort());
    for (const id of MARKET_IDS) {
      const [en, pt] = WORDS[id];
      expect(marketsIn(`I want to invest in ${en}`), en).toEqual([
        { market: id, words: en, at: 'I want to invest in '.length },
      ]);
      expect(marketsIn(`Quero investir em ${pt}`), pt).toEqual([
        { market: id, words: pt, at: 'Quero investir em '.length },
      ]);
    }
  });

  // The table as the stock data of Oct 6 sets it: the filters of each narrative, in the order they are
  // tried. A keyword serves where GICS would mislead (a stablecoin issuer is filed under Software).
  it('reads each to the portfolio, label, filters in order and nearest offers of the table', () => {
    const row = (id: Market) => {
      const n = NARRATIVES[id];
      return [n.portfolio, n.label, n.filters.map((f) => `${f.by}: ${f.value}`), n.nearest];
    };
    expect(Object.fromEntries(MARKET_IDS.map((id) => [id, row(id)]))).toEqual({
      big_tech: ['the-seven', 'big-tech', [], ['the-seven', 'ai', 'the-500']],
      us_market: ['the-500', 'broad-market', [], ['the-500', 'the-seven']],
      ai: [null, 'ai', [], ['the-seven', 'the-500']],
      semiconductors: [
        null,
        'semiconductors',
        ['industry: Semiconductors & Semiconductor Equipment'],
        ['sand-to-server', 'ai', 'the-seven'],
      ],
      ai_infrastructure: [
        null,
        'ai-infrastructure',
        ['keyword: data centers'],
        ['ai', 'semiconductors', 'the-seven'],
      ],
      crypto_economy: [null, 'crypto-economy', [], ['crypto-in-a-suit']],
      fintech: [null, 'fintech', [], ['crypto-economy', 'crypto-in-a-suit']],
      space: [null, 'space', ['keyword: launch services'], []],
      quantum: [
        null,
        'quantum-computing',
        ['keyword: quantum computers'],
        ['ai', 'semiconductors'],
      ],
      ev_autonomy: [
        null,
        'ev-autonomy',
        ['keyword: electric vehicles', 'sub_industry: Automobile Manufacturers'],
        ['ai', 'the-seven'],
      ],
      cloud_software: [null, 'cloud-software', ['keyword: cloud'], ['the-seven', 'ai']],
      emerging_markets: [null, 'emerging-markets-asia', ['keyword: emerging markets'], []],
      commodities: [null, 'commodities', [], ['storm-cellar']],
      broad_market: [null, 'broad-market', ['keyword: index fund'], ['the-500']],
      retail_favourites: [null, 'retail-favourites', [], []],
      defense: [null, 'defense', ['industry: Aerospace & Defense', 'keyword: defense'], []],
      health_care: [null, 'health-care', ['sector: Health Care'], []],
      social_media: [null, 'social-media', ['keyword: social media'], []],
    });
    // Every filter of the table makes a slug a theme sleeve can take, and no two the same slug.
    const slugs = MARKET_IDS.flatMap((id) => NARRATIVES[id].filters.map((f) => matchedSlug(f)));
    for (const slug of slugs) expect(slug).toMatch(/^matched-/);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('keeps the longer reading where two share words', () => {
    const read = (text: string) => marketsIn(text).map((m) => `${m.market}: ${m.words}`);
    expect(read('invest in AI infrastructure')).toEqual(['ai_infrastructure: AI infrastructure']);
    expect(read('invest in AI chips')).toEqual(['semiconductors: AI chips']);
    expect(read('invest in AI data centers')).toEqual(['ai_infrastructure: AI data centers']);
    expect(read('invest in S&P 500 index funds')).toEqual(['us_market: S&P 500 index funds']);
    expect(read('invest in cloud software')).toEqual(['cloud_software: cloud software']);
    // Two narratives side by side are two.
    expect(read('I like AI and big tech')).toEqual(['big_tech: big tech', 'ai: AI']);
    // The shorter reading is kept as written and not read, so it is not taken for words not written.
    expect(
      marketMentionsIn('invest in AI infrastructure').map((m) => [m.market, m.words, m.skipped]),
    ).toEqual([
      ['ai_infrastructure', 'AI infrastructure', null],
      ['ai', 'AI', 'within'],
    ]);
  });

  it('"space", "defense", "crypto" and "gold" name no narrative where the sentence is not about investing in them', () => {
    for (const text of [
      'I need more space to think about it',
      'Give me some space, I will decide next week',
      'In the space of two years I want to double it',
      'My best defense is patience',
      'In defense of my plan, I hold cash',
      'Em defesa do meu dinheiro, prefiro esperar',
      // Crypto is an asset class the plan can hold, and gold a part of a mix: neither is a narrative.
      'I want crypto',
      'all in crypto',
      'no crypto',
      'I like gold',
      'all in gold',
      'quero ouro e cripto',
      // "Ai" is a word in Portuguese, and blue chips are not chip makers.
      'ai, não sei',
      'only blue chips and blue-chip stocks',
      'a quantum leap for my savings',
      // Health care and social media are everywhere: alone, they are read only where money goes in.
      'I need money for health care next year',
      'My health care costs are high',
      'Preciso do dinheiro para a saúde da minha mãe',
      'I saw it on social media',
      'I read about it in social media posts',
      'Vi nas redes sociais que a bolsa caiu',
    ])
      expect(marketsIn(text), text).toEqual([]);
    // Where the sentence is about investing in them, they are read.
    const first = (text: string) => marketsIn(text)[0]?.market;
    expect(first('invest in space')).toBe('space');
    expect(first('put it all in defense')).toBe('defense');
    expect(first('tudo na defesa')).toBe('defense');
    expect(first('I like crypto stocks')).toBe('crypto_economy');
    for (const text of [
      'invest in health care',
      'put 30% in healthcare',
      'I like health stocks',
      'all of it in pharma',
      'pharmaceuticals',
      'investir em saúde',
      'quero farmacêuticas',
    ])
      expect(first(text), text).toBe('health_care');
    for (const text of [
      'invest in social media',
      'put half of it in social networks',
      'I like social media stocks',
      'investir em redes sociais',
      'tudo em redes sociais',
    ])
      expect(first(text), text).toBe('social_media');
    // Through the intake: no narrative, and no question about one.
    const result = intake(
      'I want to grow $2,000 over 5 years. I need more space to think about the risk, and my best defense is patience.',
    );
    expect(result.narratives).toEqual([]);
    expect(fields(result)).toEqual(['risk']);
  });

  it('a narrative under a negation, or said of the person, is no ask', () => {
    const skipped = (text: string) => marketMentionsIn(text).map((m) => m.skipped);
    for (const text of [
      'no big tech',
      "I don't want AI",
      'without chips',
      'no quiero big tech',
      'sem petróleo',
      'nada de big tech',
      'não quero semicondutores',
    ]) {
      expect(skipped(text), text).toEqual(['negated']);
      expect(marketsIn(text), text).toEqual([]);
    }
    for (const text of [
      'I work in software and have $5,000',
      'I am a software engineer with $5,000',
      'I live in Asia and want to grow $5,000',
      'I plan to retire in Asia in 10 years',
      'I sold my software company',
      'sou engenheiro de software',
      'trabalho na área de software',
      'minha empresa de software vai bem',
    ]) {
      expect(skipped(text), text).toEqual(['aside']);
      expect(marketsIn(text), text).toEqual([]);
    }
    // A negation stops at a comma, a sentence or a new message; "no" is "in the" in Portuguese.
    for (const text of [
      'no stocks, invest in AI',
      "I'm not sure\n\nAI stocks",
      'not only AI',
      'quero investir no S&P 500',
      'Quero investir US$ 2.000 no setor de defesa',
      'invest in software',
      'investir na Ásia',
    ])
      expect(skipped(text), text).toEqual([null]);
  });

  it('words inside a shared portfolio name name the portfolio, not a market', () => {
    const text = 'Grow $5,000 by 2031, starting from Chips & Agents';
    expect(marketsIn(text).map((m) => m.market)).toEqual(['semiconductors']);
    expect(marketsIn(text, ['Chips & Agents'])).toEqual([]);
    // The intake knows the names on the shelf, and the names the model says the text holds.
    const onShelf = intake(text, reply({ horizonMonths: 51, portfolios: ['Chips & Agents'] }));
    expect(onShelf.narratives).toEqual([]);
    expect(onShelf.draft.themes).toEqual(['chips-and-agents']);
    const offShelf = intake(
      'Grow $5,000 by 2031, starting from Rockets & Chips',
      reply({ horizonMonths: 51, portfolios: ['Rockets & Chips'] }),
    );
    expect(offShelf.narratives).toEqual([]);
    expect(offShelf.flags).toContain('not_on_shelf:themes');
    // A name that is the words themselves hides nothing: a portfolio called "Big Tech" is big tech
    // still, and so is one whose name only shares a word with what is written.
    expect(marketsIn('invest in Big Tech', ['Big Tech']).map((m) => m.market)).toEqual([
      'big_tech',
    ]);
    expect(
      marketsIn('invest in chip makers', ['Chips & Agents', 'Makers']).map((m) => m.market),
    ).toEqual(['semiconductors']);
    const named = intake('Invest $2,000 in semiconductors for 5 years', reply(), {
      portfolios: [...portfolios, { slug: 'semis', name: 'Semiconductors' }],
    });
    expect(named.narratives.map((n) => [n.id, n.kind, n.slug])).toEqual([
      ['semiconductors', 'label', 'semiconductors'],
    ]);
  });

  it('finds words as written, case and spacing aside, as whole words', () => {
    expect(phraseIn('I like Obesity  Drugs a lot', 'obesity drugs')).toEqual([
      { words: 'Obesity  Drugs', at: 7, end: 21 },
    ]);
    expect(phraseIn('the drugstore', 'drug')).toEqual([]);
    expect(phraseIn('anything', '   ')).toEqual([]);
  });

  it('reads the share of the money: the whole, a sum, a second sum of the sentence, in both languages', () => {
    const shares = (text: string) =>
      marketsIn(text).map((m) => {
        const share = marketShareIn(text, m.at);
        return share === null ? null : share.kind === 'whole' ? 'whole' : share.value;
      });
    expect(shares('invest in semiconductors')).toEqual(['whole']);
    expect(shares('all of it in AI')).toEqual(['whole']);
    expect(shares('investir no setor de defesa')).toEqual(['whole']);
    expect(shares('put $500 in semiconductors and $300 in AI')).toEqual([300, 500]);
    expect(shares('colocar US$ 500 em IA e US$ 300 em semicondutores')).toEqual([500, 300]);
    // A sum written as Portuguese writes it: a mark, a space, a point for the thousands.
    expect(shares('Quero investir US$ 2.000 em semicondutores por 5 anos')).toEqual([2000]);
    expect(shares('investir 2 mil dólares em IA')).toEqual([2000]);
    // A sum in another currency is no share in dollars, and no share said is none.
    expect(shares('investir R$ 500 em IA')).toEqual([null]);
    expect(shares('I like semiconductors')).toEqual([null]);
  });
});

describe('a narrative reads to a shared portfolio, a curated label, a filter, or nothing', () => {
  it('a shared portfolio on the shelf first: big tech is The Seven, held as before', () => {
    const result = intake(
      'Invest $2,000 in big tech for 5 years',
      reply({ markets: ['big_tech'] }),
    );
    expect(result.narratives).toEqual([
      {
        id: 'big_tech',
        words: 'big tech',
        kind: 'portfolio',
        slug: 'the-seven',
        filter: null,
        name: 'The Seven',
      },
    ]);
    expect(result.questions).toEqual([]);
    expect(result.flags).toContain('mix_from_market');
    expect(result.sheet).toMatchObject({ themes: ['the-seven'], risk: 'high' });
    expect(result.sheet?.mix).toEqual({
      growthBps: WHOLE,
      dollarYieldBps: 0,
      goldBps: 0,
      cashBps: 0,
    });
    expect(result.sheet?.sleeves).toBeUndefined();
    const us = intake('Invest $2,000 in US stocks for 5 years', reply({ markets: ['us_market'] }));
    expect(us.narratives[0]).toMatchObject({ kind: 'portfolio', slug: 'the-500', name: 'The 500' });
  });

  it('then its curated label: big tech is the Big Tech label where The Seven is not on the shelf', () => {
    const result = intake(
      'Invest $2,000 in big tech for 5 years',
      reply({ markets: ['big_tech'] }),
      {
        portfolios: without('the-seven'),
      },
    );
    expect(result.narratives).toEqual([
      {
        id: 'big_tech',
        words: 'big tech',
        kind: 'label',
        slug: 'big-tech',
        filter: null,
        name: 'Big Tech',
      },
    ]);
    expect(result.questions).toEqual([]);
    const sheet = result.sheet as PersonalSheet;
    expect(PersonalSheet.safeParse(sheet).success).toBe(true);
    expect(sheet.sleeves).toEqual([theme('big-tech')]);
    expect(sheet.themes).toEqual([]);
    expect(sheet.mix).toBeUndefined();
    const us = intake('Invest $2,000 in US stocks for 5 years', reply({ markets: ['us_market'] }), {
      portfolios: without('the-500'),
    });
    expect(us.narratives[0]).toMatchObject({ kind: 'label', slug: 'broad-market' });
    expect(us.sheet?.sleeves).toEqual([theme('broad-market')]);
  });

  it('AI is the `ai` label, held as a theme sleeve', () => {
    const result = intake(
      'I want to grow $2,000 over 5 years, all of it in AI',
      reply({ markets: ['ai'] }),
    );
    expect(result.narratives).toEqual([
      { id: 'ai', words: 'AI', kind: 'label', slug: 'ai', filter: null, name: 'AI' },
    ]);
    expect(result.questions).toEqual([]);
    expect(result.sheet?.sleeves).toEqual([theme('ai')]);
    expect(result.draft.sleeves).toEqual([theme('ai')]);
    expect(result.mix).toBeNull();
    expect(result.readBack).toContain('100% of the plan for the theme AI.');
    expect(result.flags).not.toContain('market_not_on_shelf:ai');
    expect(result.assumptions.join(' ')).not.toMatch(/no stock for/);
  });

  it('then a filter: a proposed label and stocks that carry the industry are matched, and said as matched', () => {
    const result = intake(
      'Invest $2,000 in defense stocks for 5 years',
      reply({ markets: ['defense'] }),
    );
    const slug = 'matched-industry-aerospace-defense';
    expect(matchedSlug(NARRATIVES.defense.filters[0] as MarketFilter)).toBe(slug);
    expect(result.narratives).toEqual([
      {
        id: 'defense',
        words: 'defense stocks',
        kind: 'matched',
        slug,
        filter: { by: 'industry', value: 'Aerospace & Defense' },
        name: 'names matched by industry: Aerospace & Defense',
      },
    ]);
    // The label is there and holds nothing yet: the operator is told which.
    expect(result.flags).toContain('label_proposed:defense');
    expect(result.questions).toEqual([]);
    expect(result.sheet?.sleeves).toEqual([theme(slug)]);
    expect(result.assumptions).toContain(
      'No curated list covers “defense stocks” on Solana, so the plan holds the names matched by industry: Aerospace & Defense. Matched from the sourced attributes of each, not a curated theme.',
    );
    expect(result.readBack).toContain(
      '100% of the plan for names matched by industry: Aerospace & Defense.',
    );
    expect((result.readBack ?? []).join(' ')).not.toMatch(/the theme/);
    // No label at all, and a filter that matches: a keyword, as the attributes write it.
    const cloud = intake(
      'Invest $2,000 in software for 5 years',
      reply({ markets: ['cloud_software'] }),
    );
    expect(cloud.narratives[0]).toMatchObject({
      kind: 'matched',
      slug: 'matched-keyword-cloud',
      filter: { by: 'keyword', value: 'cloud' },
      name: 'names matched by keyword: cloud',
    });
    expect(cloud.flags.filter((f) => f.startsWith('label_'))).toEqual([]);
  });

  it('the filters of a narrative are tried in the order written: the first that matches a listed stock fills the sleeve', () => {
    const listed =
      (...keys: string[]) =>
      (filter: MarketFilter): FilterMatch | null =>
        keys.includes(`${filter.by}:${attributeKey(filter.value)}`)
          ? { value: filter.value, listed: 2 }
          : null;
    const ev = (keys: string[]) =>
      intake(
        'Invest $2,000 in electric vehicles for 5 years',
        reply({ markets: ['ev_autonomy'] }),
        {
          matchOf: listed(...keys),
        },
      );
    const KEYWORD = 'keyword:electric-vehicles';
    const SUB = 'sub_industry:automobile-manufacturers';
    // Both match: the first of the table, the keyword.
    const both = ev([KEYWORD, SUB]);
    expect(both.narratives[0]).toMatchObject({
      kind: 'matched',
      slug: 'matched-keyword-electric-vehicles',
      filter: { by: 'keyword', value: 'electric vehicles' },
    });
    expect(both.sheet?.sleeves).toEqual([theme('matched-keyword-electric-vehicles')]);
    // The first matches nothing listed: the second fills the sleeve, and is the one said.
    const second = ev([SUB]);
    expect(second.narratives[0]).toMatchObject({
      kind: 'matched',
      slug: 'matched-subindustry-automobile-manufacturers',
      filter: { by: 'sub_industry', value: 'Automobile Manufacturers' },
      name: 'names matched by sub-industry: Automobile Manufacturers',
    });
    expect(second.sheet?.sleeves).toEqual([theme('matched-subindustry-automobile-manufacturers')]);
    expect(second.flags).not.toContain('filter_no_match:ev_autonomy');
    expect(second.assumptions.join(' ')).toMatch(
      /matched by sub-industry: Automobile Manufacturers/,
    );
    expect(JSON.stringify(second)).not.toMatch(/electric-vehicles/);
    // None matches: nothing is held, and that is said.
    const none = ev([]);
    expect(none.narratives[0]).toMatchObject({ kind: 'none', slug: null, filter: null });
    expect(none.flags).toContain('filter_no_match:ev_autonomy');
    // Defense, where the industry lists nothing here and the keyword does.
    const defense = intake(
      'Invest $2,000 in defense stocks for 5 years',
      reply({ markets: ['defense'] }),
      { matchOf: listed('keyword:defense') },
    );
    expect(defense.narratives[0]).toMatchObject({
      kind: 'matched',
      slug: 'matched-keyword-defense',
      name: 'names matched by keyword: defense',
    });
    // A match that lists no stock on the chain is no match: the next filter is tried. (The keyword
    // lists two here: since Oct 7 a filter that lists one name alone is no match either, below.)
    const unlisted = intake(
      'Invest $2,000 in defense stocks for 5 years',
      reply({ markets: ['defense'] }),
      {
        matchOf: (filter) =>
          filter.by === 'industry'
            ? { value: 'Aerospace & Defense', listed: 0 }
            : { value: 'defense', listed: 2 },
      },
    );
    expect(unlisted.narratives[0]?.slug).toBe('matched-keyword-defense');
    // The same for a filter that lists one name alone: the next one is tried.
    const oneThenTwo = intake(
      'Invest $2,000 in defense stocks for 5 years',
      reply({ markets: ['defense'] }),
      {
        matchOf: (filter) =>
          filter.by === 'industry'
            ? { value: 'Aerospace & Defense', listed: 1 }
            : { value: 'defense', listed: 2 },
      },
    );
    expect(oneThenTwo.narratives[0]?.slug).toBe('matched-keyword-defense');
    expect(oneThenTwo.flags.filter((f) => f.startsWith('filter_'))).toEqual([]);
    // A curated label that is usable still comes before any filter.
    const curated = intake(
      'Invest $2,000 in defense stocks for 5 years',
      reply({ markets: ['defense'] }),
      { labels: [label('defense', 'Defense', 'Defesa', 'confirmed', 3)] },
    );
    expect(curated.narratives[0]).toMatchObject({ kind: 'label', slug: 'defense' });
  });

  it('health care and social media (Oct 6): their label, then their filter, or nothing', () => {
    // Health care: no label on this shelf, and the sector matches.
    const pharma = intake(
      'Invest $2,000 in pharma for 5 years',
      reply({ markets: ['health_care'] }),
    );
    expect(pharma.narratives).toEqual([
      {
        id: 'health_care',
        words: 'pharma',
        kind: 'matched',
        slug: 'matched-sector-health-care',
        filter: { by: 'sector', value: 'Health Care' },
        name: 'names matched by sector: Health Care',
      },
    ]);
    expect(pharma.questions).toEqual([]);
    expect(pharma.sheet?.sleeves).toEqual([theme('matched-sector-health-care')]);
    expect(pharma.readBack).toContain('100% of the plan for names matched by sector: Health Care.');
    const saude = intake(
      'Quero investir US$ 2.000 em saúde por 5 anos',
      reply({ language: 'pt', markets: ['health_care'] }),
    );
    expect(saude.narratives[0]).toMatchObject({
      words: 'saúde',
      slug: 'matched-sector-health-care',
      name: 'nomes filtrados por setor: Health Care',
    });
    // With its label confirmed and listed, the label holds it.
    const curated = intake(
      'Invest $2,000 in health care stocks for 5 years',
      reply({ markets: ['health_care'] }),
      { labels: [label('health-care', 'Health Care', 'Saúde', 'confirmed', 4)] },
    );
    expect(curated.narratives[0]).toMatchObject({
      kind: 'label',
      slug: 'health-care',
      name: 'Health Care',
    });
    expect(curated.sheet?.sleeves).toEqual([theme('health-care')]);
    // Social media: no label, and no stock that carries the keyword here. Nothing near is offered.
    const social = intake(
      'Invest $2,000 in social media stocks for 5 years',
      reply({ markets: ['social_media'] }),
    );
    expect(social.narratives).toEqual([
      {
        id: 'social_media',
        words: 'social media stocks',
        kind: 'none',
        slug: null,
        filter: null,
        name: null,
      },
    ]);
    expect(social.assumptions).toEqual([
      'There is no stock for “social media stocks” on Solana at the moment. We will be adding more soon.',
    ]);
    const matched = intake(
      'Quero investir US$ 2.000 em redes sociais por 5 anos',
      reply({ language: 'pt', markets: ['social_media'] }),
      { matchOf: () => ({ value: 'social media', listed: 3 }) },
    );
    expect(matched.narratives[0]).toMatchObject({
      words: 'redes sociais',
      kind: 'matched',
      slug: 'matched-keyword-social-media',
      name: 'nomes filtrados por palavra-chave: social media',
    });
    expect(matched.sheet?.sleeves).toEqual([theme('matched-keyword-social-media')]);
  });

  it('or nothing: said in the one sentence, with the nearest the shelf has where it has one', () => {
    // Space: its label lists nothing on this chain, its filter matches no stock, and nothing is near.
    const text = 'Invest $2,000 in space for 5 years';
    const space = intake(text, reply({ markets: ['space'] }));
    expect(space.narratives).toEqual([
      { id: 'space', words: 'space', kind: 'none', slug: null, filter: null, name: null },
    ]);
    expect(space.flags).toEqual(
      expect.arrayContaining([
        'label_not_listed:space',
        'filter_no_match:space',
        'market_not_on_shelf:space',
      ]),
    );
    expect(space.assumptions).toEqual([
      'There is no stock for “space” on Solana at the moment. We will be adding more soon.',
    ]);
    // Nothing is held for it (gate THEME-NONE-YET, Oct 6): no mix, no sleeve, no share asked, and no
    // line about limits. The rest goes on as if it had not been named: the risk is asked.
    expect(fields(space)).toEqual(['risk']);
    expect(space.mix).toBeNull();
    expect(space.draft.sleeves).toBeNull();
    expect(space.draft.themes).toBeNull();
    expect(space.flags.filter((f) => /^mix_|^sleeves_|^risk_from|share_unclear/.test(f))).toEqual(
      [],
    );
    const answered = intake(text, reply({ markets: ['space'] }), { answers: { risk: 'low' } });
    expect(answered.questions).toEqual([]);
    expect(answered.sheet).toMatchObject({ risk: 'low', themes: [] });
    expect(answered.sheet?.sleeves).toBeUndefined();
    expect(answered.sheet?.mix).toBeUndefined();
    expect(answered.readBack).toEqual([
      'You set a goal to grow with $2,000 over 5 years, at low risk.',
      'The plan lives on Solana, the chain of your wallet.',
      'Tokens you already hold count toward the plan.',
      'There is no stock for “space” on Solana at the moment. We will be adding more soon.',
      'Nothing moves toward cash as the date nears unless you ask for it.',
      'If this is right, confirm it and the plan is made from it.',
    ]);
    // The sheet is the one the same goal gives with the narrative not named.
    const plain = intake('Invest $2,000 for 5 years', reply(), { answers: { risk: 'low' } });
    expect(answered.sheet).toEqual(plain.sheet);

    // Quantum: a proposed label and a filter that matches nothing; the nearest is the AI label, by
    // its name.
    const quantum = intake(
      'Invest $2,000 in quantum computing for 5 years',
      reply({ markets: ['quantum'] }),
    );
    expect(quantum.flags).toContain('label_proposed:quantum-computing');
    expect(quantum.assumptions).toContain(
      'There is no stock for “quantum computing” on Solana at the moment, and we will be adding more soon. The nearest today is AI, which you can choose.',
    );
    // Electric vehicles: no label, and a filter whose stocks the shelf does not list here.
    const ev = intake(
      'Invest $2,000 in electric vehicles for 5 years',
      reply({ markets: ['ev_autonomy'] }),
    );
    expect(ev.narratives[0]).toMatchObject({ kind: 'none', slug: null, filter: null });
    expect(ev.flags).toEqual(
      expect.arrayContaining(['filter_no_match:ev_autonomy', 'market_not_on_shelf:ev_autonomy']),
    );
    // The nearest is a shared portfolio where the shelf has it, in the order of the table.
    const chips = intake(
      'Invest $2,000 in semiconductors for 5 years',
      reply({ markets: ['semiconductors'] }),
      { labels: [], matchOf: undefined },
    );
    expect(chips.assumptions).toContain(
      'There is no stock for “semiconductors” on Solana at the moment, and we will be adding more soon. The nearest today is Sand to Server, which you can choose.',
    );
    const noSand = intake(
      'Invest $2,000 in semiconductors for 5 years',
      reply({ markets: ['semiconductors'] }),
      { labels: LABELS.filter((l) => l.slug === 'ai'), matchOf: undefined, portfolios: [] },
    );
    expect(noSand.assumptions).toContain(
      'There is no stock for “semiconductors” on Solana at the moment, and we will be adding more soon. The nearest today is AI, which you can choose.',
    );
    // The chain is the person's.
    const onRobinhood = intake(
      'Invest $2,000 in space for 5 years',
      reply({ markets: ['space'] }),
      {
        homeChain: 'robinhood',
      },
    );
    expect(onRobinhood.assumptions).toContain(
      'There is no stock for “space” on Robinhood Chain at the moment. We will be adding more soon.',
    );
  });

  it('a part word inside the words of a narrative names the narrative, not a mix: "all of it in crypto stocks"', () => {
    // "Crypto", "stocks", "ações" and "bolsa" are parts of a mix on their own. Inside a narrative's
    // words the longer reading is the one read, so the share is the narrative's.
    for (const text of [
      'All of it in crypto stocks',
      'everything in bitcoin miners',
      'tudo em ações americanas',
      'tudo na bolsa americana',
      '70% in crypto stocks and 30% cash',
      'crypto stocks only',
      'half crypto stocks, half cash',
      'all in emerging markets equities',
    ])
      expect(mixSaidIn(text), text).toBeNull();
    for (const text of [
      'all of it in crypto',
      'everything in bitcoin',
      'tudo em ações',
      'tudo na bolsa',
      'stocks only',
      'all in equities',
    ])
      expect(mixIn(text)?.mix.growthBps, text).toBe(WHOLE);
    // Where the chain has nothing for the crypto economy, nothing is held for it (THEME-NONE-YET):
    // the words do not come back as a plan all in stocks and crypto.
    const none = intake(
      'I want to grow $2,000 over 5 years. All of it in crypto stocks.',
      reply({ markets: ['crypto_economy'] }),
    );
    expect(none.narratives.map((n) => [n.id, n.kind])).toEqual([['crypto_economy', 'none']]);
    expect(none.mix).toBeNull();
    expect(none.draft.sleeves).toBeNull();
    expect(fields(none)).toEqual(['risk']);
    expect(none.assumptions.join(' ')).toMatch(/There is no stock for “crypto stocks” on Solana/);
    // Where the shelf has it, the share is the narrative's and it is held as before.
    const us = intake(
      'Quero investir US$ 2.000 por 5 anos, tudo em ações americanas',
      reply({ language: 'pt', markets: ['us_market'] }),
    );
    expect(us.questions).toEqual([]);
    expect(us.flags).toContain('mix_from_market');
    expect(us.sheet).toMatchObject({ themes: ['the-500'], mix: { growthBps: WHOLE } });
    expect(us.assumptions).toContain(
      'Para manter “ações americanas”, o plano usa os limites de risco alto.',
    );
  });

  it('a label holds a narrative only when it is confirmed and lists a stock on the chain', () => {
    const kindWith = (status: ShelfLabel['status'], listed: number) =>
      intake('Invest $2,000 in AI for 5 years', reply({ markets: ['ai'] }), {
        labels: [label('ai', 'AI', 'IA', status, listed)],
        portfolios: [],
      });
    expect(kindWith('confirmed', 1).narratives[0]?.kind).toBe('label');
    const proposed = kindWith('proposed', 5);
    expect(proposed.narratives[0]?.kind).toBe('none');
    expect(proposed.flags).toContain('label_proposed:ai');
    const unlisted = kindWith('confirmed', 0);
    expect(unlisted.narratives[0]?.kind).toBe('none');
    expect(unlisted.flags).toContain('label_not_listed:ai');
    // With no labels handed in at all, there is none, and no flag about one.
    const none = intake('Invest $2,000 in AI for 5 years', reply({ markets: ['ai'] }), {
      labels: undefined,
    });
    expect(none.narratives[0]?.kind).toBe('none');
    expect(none.flags.filter((f) => f.startsWith('label_'))).toEqual([]);
  });

  it('a filter matches only what the attributes write as the same value', () => {
    const wrong = intake('Invest $2,000 in defense stocks for 5 years', reply(), {
      // A caller that answers with another value than the one asked for is not believed.
      matchOf: () => ({ value: 'Airlines', listed: 9 }),
    });
    expect(wrong.narratives[0]?.kind).toBe('none');
    expect(wrong.flags).toContain('filter_no_match:defense');
    const none = intake('Invest $2,000 in defense stocks for 5 years', reply(), {
      matchOf: () => null,
    });
    expect(none.narratives[0]?.kind).toBe('none');
  });

  it('the same text gives the same answer whatever the order of the labels', () => {
    const texts: [string, IntakeAnswers][] = [
      ['Invest $2,000 in semiconductors for 5 years', {}],
      ['I want to grow $2,000 over 5 years. Put $500 in semiconductors and $300 in AI', {}],
      // Nothing on the chain for it: the risk is asked as for any goal, and answered here.
      ['Invest $2,000 in quantum computing for 5 years', { risk: 'medium' }],
      ['Invest $2,000 in defense stocks for 5 years', {}],
    ];
    const orders = [
      LABELS,
      [...LABELS].reverse(),
      [...LABELS.slice(3), ...LABELS.slice(0, 3)],
      [...LABELS].sort((a, b) => a.name.pt.localeCompare(b.name.pt)),
    ];
    for (const [text, answers] of texts) {
      const said = orders.map((labels) =>
        JSON.stringify(intake(text, reply(), { labels, answers })),
      );
      expect(new Set(said).size, text).toBe(1);
      expect(JSON.parse(said[0] as string).sheet, text).not.toBeNull();
    }
  });

  // Gate THEME-NONE-YET (Rodrigo, Oct 6): what the chain has nothing for is said, and nothing more.
  it('a narrative the chain has nothing for is never held and never asked its share, however its share is said', () => {
    const none = (words: string) =>
      `There is no stock for “${words}” on Solana at the moment. We will be adding more soon.`;
    const NONE = none('space');
    const ALL_STOCKS = {
      growthPct: 100,
      dollarYieldPct: 0,
      goldPct: 0,
      cashPct: 0,
      creditPct: null,
    };
    // With a model that reads no mix, with no model, and, where the text gives the narrative a
    // share, with a model that reads that share as a mix: the share is the narrative's, so that mix
    // is no second holding and is not asked either.
    for (const [said, words, shared] of [
      ['Invest in space.', 'space', true],
      ['All of it in space.', 'space', true],
      ['Put $500 in space.', 'space', true],
      ['Put 30% in space.', 'space', true],
      ['Half in space.', 'space', true],
      ['I like space stocks.', 'space stocks', false],
    ] as const)
      for (const r of [
        reply({ markets: ['space'] }),
        null,
        ...(shared ? [reply({ markets: ['space'], mix: ALL_STOCKS })] : []),
      ]) {
        const text = `I want to grow $2,000 over 5 years. ${said}`;
        const where = `${said} ${r === null ? 'rules' : JSON.stringify(r.mix)}`;
        const result = intake(
          text,
          r,
          r === null ? { answers: { goal: 'grow', horizonMonths: 60 } } : {},
        );
        expect(
          result.narratives.map((n) => n.kind),
          where,
        ).toEqual(['none']);
        expect(result.mix, where).toBeNull();
        expect(result.draft.sleeves, where).toBeNull();
        expect(result.assumptions, where).toEqual([none(words)]);
        const asked = fields(result);
        expect(asked, where).not.toContain('mix');
        expect(asked, where).not.toContain('sleeves');
        expect(asked, where).toContain('risk');
        expect(
          result.flags.filter((f) =>
            /mix_from|sleeves_from|risk_from_|share_unclear|mix_asked/.test(f),
          ),
          where,
        ).toEqual([]);
      }
    // The three first markets too: big tech and the US market where the shelf has neither their
    // portfolio nor their label, and AI with no label.
    for (const [words, id] of [
      ['big tech', 'big_tech'],
      ['US stocks', 'us_market'],
      ['AI', 'ai'],
    ] as const) {
      const result = intake(`Invest $2,000 in ${words} for 5 years`, reply({ markets: [id] }), {
        portfolios: [],
        labels: [],
      });
      expect(
        result.narratives.map((n) => [n.id, n.kind]),
        words,
      ).toEqual([[id, 'none']]);
      expect(fields(result), words).toEqual(['risk']);
      expect(result.mix, words).toBeNull();
      expect(result.assumptions, words).toEqual([
        `There is no stock for “${words}” on Solana at the moment. We will be adding more soon.`,
      ]);
    }
    // A mix the person states of the whole money is theirs all the same, with the sentence beside it.
    const stated = intake(
      'I want to grow $2,000 over 5 years. I like space stocks. All of it in stocks.',
      reply({ markets: ['space'], mix: ALL_STOCKS }),
    );
    expect(stated.questions).toEqual([]);
    expect(stated.sheet?.mix?.growthBps).toBe(WHOLE);
    expect(stated.assumptions).toEqual([
      'To hold “All of it in stocks”, the plan uses the limits for high risk.',
      none('space stocks'),
      'Nothing moves toward cash as the date nears unless you ask for it.',
    ]);
    // On a goal of income or to protect it is said too, and nothing else changes.
    const income = intake(
      'I want $50 a month of income from $10,000 for 5 years, all of it in space',
      reply({ goal: 'income', amountUsd: 10_000, incomeTargetUsdMonthly: 50, markets: ['space'] }),
    );
    expect(fields(income)).toEqual(['risk']);
    expect(income.assumptions).toEqual([NONE]);
  });
});

describe('a market the lists have no word for, named by the model as a filter (MOCK replies)', () => {
  it('a filter whose words are written, and that matches: a theme sleeve, said as matched', () => {
    const { text, reply: r } = recordedCase('obesity-drugs');
    const result = intake(text, r);
    expect(result.narratives).toEqual([
      {
        id: null,
        words: 'obesity drugs',
        kind: 'matched',
        slug: 'matched-keyword-glp-1',
        filter: { by: 'keyword', value: 'GLP-1' },
        name: 'names matched by keyword: GLP-1',
      },
    ]);
    expect(result.questions).toEqual([]);
    expect(result.sheet?.sleeves).toEqual([theme('matched-keyword-glp-1')]);
    expect(result.sheet?.risk).toBe('high');
    expect(result.assumptions).toContain(
      'No curated list covers “obesity drugs” on Solana, so the plan holds the names matched by keyword: GLP-1. Matched from the sourced attributes of each, not a curated theme.',
    );
    expect(result.readBack).toContain('100% of the plan for names matched by keyword: GLP-1.');
  });

  it('words that are not written in the text: dropped, flagged, and nothing asked about it', () => {
    const { text, reply: r } = recordedCase('obesity-drugs-words-not-written');
    const result = intake(text, r);
    expect(result.flags).toContain('no_cue:marketFilter');
    expect(result.narratives).toEqual([]);
    expect(result.draft.sleeves).toBeNull();
    // The goal is read as any goal with no narrative: only the risk is left to ask.
    expect(fields(result)).toEqual(['risk']);
  });

  it('a filter that is not one attribute and one value: dropped and flagged', () => {
    const { text, reply: r } = recordedCase('obesity-drugs-names-a-stock');
    const picked = intake(text, r);
    expect(picked.flags).toContain('model_invalid:marketFilter');
    expect(picked.narratives).toEqual([]);
    expect(fields(picked)).toEqual(['risk']);
    for (const marketFilter of [
      { by: 'ticker', value: 'LLY', words: 'obesity drugs' },
      { by: 'keyword', value: '&', words: 'obesity drugs' },
      { by: 'keyword', value: 'GLP-1' },
      { by: 'keyword', value: 'GLP-1', words: '' },
      'GLP-1',
    ]) {
      const result = intake(text, reply({ marketFilter }));
      expect(result.flags, JSON.stringify(marketFilter)).toContain('model_invalid:marketFilter');
      expect(result.narratives, JSON.stringify(marketFilter)).toEqual([]);
      expect(fields(result), JSON.stringify(marketFilter)).toEqual(['risk']);
    }
  });

  it('a filter that matches no stock on the chain: the one sentence, and no filter said', () => {
    const result = intake(
      'Invest $2,000 in uranium miners for 5 years',
      reply({ marketFilter: { by: 'keyword', value: 'Uranium', words: 'uranium miners' } }),
    );
    expect(result.narratives).toEqual([
      { id: null, words: 'uranium miners', kind: 'none', slug: null, filter: null, name: null },
    ]);
    expect(result.flags).toEqual(
      expect.arrayContaining(['filter_no_match:marketFilter', 'market_not_on_shelf:marketFilter']),
    );
    expect(result.assumptions).toContain(
      'There is no stock for “uranium miners” on Solana at the moment. We will be adding more soon.',
    );
    // The model's value is not said anywhere.
    expect(JSON.stringify(result)).not.toMatch(/Uranium/);
  });

  it('words a fixed list already reads: the list reads them, the filter is dropped', () => {
    const { text, reply: r } = recordedCase('semiconductors-and-a-filter-for-them');
    const result = intake(text, r);
    expect(result.flags).toContain('market_covers:marketFilter');
    expect(result.narratives.map((n) => [n.id, n.kind, n.slug])).toEqual([
      ['semiconductors', 'label', 'semiconductors'],
    ]);
    expect(result.sheet?.sleeves).toEqual([theme('semiconductors')]);
    // The same for the name of a shared portfolio: a filter never stands in for a portfolio the
    // person named, whatever it would match.
    const named = intake(
      'Grow $2,000 over 5 years at high risk, starting from The Seven',
      reply({
        risk: 'high',
        portfolios: ['The Seven'],
        marketFilter: { by: 'industry', value: 'Software', words: 'The Seven' },
      }),
    );
    expect(named.flags).toContain('market_covers:marketFilter');
    expect(named.narratives).toEqual([]);
    expect(named.sheet).toMatchObject({ themes: ['the-seven'] });
    expect(named.sheet?.sleeves).toBeUndefined();
  });

  it('a filter under a negation is no ask', () => {
    const result = intake(
      'Grow $2,000 over 5 years, high risk, no obesity drugs',
      reply({
        risk: 'high',
        marketFilter: { by: 'keyword', value: 'GLP-1', words: 'obesity drugs' },
      }),
    );
    expect(result.flags).toContain('market_negated:marketFilter');
    expect(result.narratives).toEqual([]);
    expect(result.questions).toEqual([]);
    expect(result.sheet?.sleeves).toBeUndefined();
  });

  it('in Portuguese: the value as the attributes write it, the words as the person wrote them', () => {
    const { text, reply: r } = recordedCase('insurers-in-portuguese');
    const result = intake(text, r);
    expect(result.narratives).toEqual([
      {
        id: null,
        words: 'seguradoras',
        kind: 'matched',
        slug: 'matched-industry-insurance',
        filter: { by: 'industry', value: 'Insurance' },
        name: 'nomes filtrados por indústria: Insurance',
      },
    ]);
    expect(result.sheet?.sleeves).toEqual([theme('matched-industry-insurance')]);
    expect(result.assumptions).toContain(
      'Nenhuma lista com curadoria cobre “seguradoras” na Solana, então o plano fica com os nomes filtrados por indústria: Insurance. Filtrados pelos atributos de cada um, que têm fonte; não é um tema com curadoria.',
    );
    expect(result.readBack).toContain(
      '100% do plano para nomes filtrados por indústria: Insurance.',
    );
  });

  it('"farmacêuticas" is a fixed word since Oct 6: the health care narrative reads it, and a filter the model still names for it is dropped', () => {
    const { text, reply: r } = recordedCase('pharma-in-portuguese');
    const result = intake(text, r);
    expect(result.flags).toContain('market_covers:marketFilter');
    expect(result.narratives).toEqual([
      {
        id: 'health_care',
        words: 'farmacêuticas',
        kind: 'matched',
        slug: 'matched-sector-health-care',
        filter: { by: 'sector', value: 'Health Care' },
        name: 'nomes filtrados por setor: Health Care',
      },
    ]);
    expect(result.sheet?.sleeves).toEqual([theme('matched-sector-health-care')]);
    // The model's own filter is said nowhere, though stocks carry it.
    expect(JSON.stringify(result)).not.toMatch(/[Pp]harmaceuticals/);
  });

  it('bounds the value and the words a model may send for a filter', () => {
    const text = 'Invest $2,000 in obesity drugs for 5 years';
    const filter = (value: string, words: string) => ({ by: 'keyword', value, words });
    const at = (n: number) => 'x'.repeat(n);
    expect(INTAKE_LIMITS).toMatchObject({ filterValueChars: 80, filterWordsChars: 100 });
    // At the bound a value is read; one character more and the field is dropped, and flagged.
    expect(readReply({ marketFilter: filter(at(80), 'obesity drugs') }).flags).toEqual([]);
    expect(readReply({ marketFilter: filter('GLP-1', at(100)) }).flags).toEqual([]);
    for (const marketFilter of [filter(at(81), 'obesity drugs'), filter('GLP-1', at(101))]) {
      expect(readReply({ marketFilter }).flags).toEqual(['model_invalid:marketFilter']);
      const result = intake(text, reply({ marketFilter }));
      expect(result.flags).toContain('model_invalid:marketFilter');
      expect(result.narratives).toEqual([]);
      expect(fields(result)).toEqual(['risk']);
    }
    // A value of spaces around a long word is measured as the word it is.
    expect(readReply({ marketFilter: filter(`  ${at(80)}  `, 'obesity drugs') }).flags).toEqual([]);
  });

  it('with no model, only the fixed words are read', () => {
    const { text } = recordedCase('obesity-drugs');
    const free = intake(text, null);
    expect(free.method).toBe('rules');
    expect(free.narratives).toEqual([]);
    expect(free.flags.filter((f) => f.includes('marketFilter'))).toEqual([]);
    expect(fields(free)).not.toContain('mix');
    // A narrative of the fixed lists is read all the same.
    const fixed = intake('Invest $2,000 in semiconductors for 5 years', null, {
      answers: { goal: 'grow', amountUsd: 2000, horizonMonths: 60 },
    });
    expect(fixed.method).toBe('rules');
    expect(fixed.narratives.map((n) => [n.id, n.kind, n.slug])).toEqual([
      ['semiconductors', 'label', 'semiconductors'],
    ]);
    expect(fixed.questions).toEqual([]);
    expect(fixed.sheet?.sleeves).toEqual([theme('semiconductors')]);
  });

  it('a market the model names that the text has no word for is asked; one the text rules out is dropped', () => {
    const unnamed = intake(
      'I want to grow $2,000 over 5 years, high risk',
      reply({ risk: 'high', markets: ['semiconductors'] }),
    );
    expect(unnamed.flags).toContain('no_cue:market:semiconductors');
    expect(fields(unnamed)).toEqual(['themes']);
    const ruledOut = intake(
      'I want to grow $2,000 over 5 years, high risk, no big tech',
      reply({ risk: 'high', markets: ['big_tech'] }),
    );
    expect(ruledOut.flags).toContain('market_negated:big_tech');
    expect(ruledOut.narratives).toEqual([]);
    expect(ruledOut.questions).toEqual([]);
    expect(ruledOut.sheet?.themes).toEqual([]);
    // Words a longer reading holds are written, and not read: the market is dropped, and nothing asked.
    const within = intake(
      'Invest $2,000 in AI infrastructure for 5 years, high risk',
      reply({ risk: 'high', markets: ['ai', 'ai_infrastructure'] }),
      { labels: [] },
    );
    expect(within.flags).toContain('market_within:ai');
    expect(within.flags).not.toContain('no_cue:market:ai');
    expect(fields(within)).not.toContain('themes');
    expect(within.narratives.map((n) => n.id)).toEqual(['ai_infrastructure']);
    // A market id the lists do not hold is not a market: the field is dropped.
    const unknown = intake(
      'I want to grow $2,000 over 5 years, high risk',
      reply({ risk: 'high', markets: ['nuclear'] }),
    );
    expect(unknown.flags).toContain('model_invalid:markets');
  });
});

describe('the share of a theme, and the risk', () => {
  it('the whole: one theme sleeve of the whole plan, and the risk is never asked', () => {
    const result = intake(
      'Invest $2,000 in semiconductors for 5 years',
      reply({ markets: ['semiconductors'] }),
    );
    expect(result.questions).toEqual([]);
    expect(result.flags).toEqual(
      expect.arrayContaining(['sleeves_from_market', 'risk_from_themes']),
    );
    const sheet = result.sheet as PersonalSheet;
    expect(PersonalSheet.safeParse(sheet).success).toBe(true);
    expect(sheet.sleeves).toEqual([theme('semiconductors')]);
    // The limits follow what is held: the estimate a mix of the same share in stocks takes.
    expect(sheet.risk).toBe('high');
    expect(result.assumptions.filter((s) => /limits for/.test(s))).toEqual([
      'To hold “semiconductors”, the plan uses the limits for high risk.',
    ]);
    // The goal line says no risk, and no sentence gives the risk to a part that seeks the goal.
    const said = result.readBack ?? [];
    // The time frame is said as the person said it: "for 5 years".
    expect(said[0]).toBe('You set a goal to grow with $2,000 over 5 years.');
    expect(said.filter((s) => /risk/.test(s))).toEqual([
      'To hold “semiconductors”, the plan uses the limits for high risk.',
    ]);
    expect(said.at(-1)).toBe('If this is right, confirm it and the plan is made from it.');
  });

  it('a written sum: that share in the theme, and the rest in the safe-yield sleeve', () => {
    const result = intake(
      'I want to grow $2,000 over 5 years. Put $500 in semiconductors',
      reply({ markets: ['semiconductors'] }),
    );
    expect(result.questions).toEqual([]);
    expect(result.sheet?.sleeves).toEqual([theme('semiconductors', 2500), safe(7500)]);
    expect(result.sheet?.risk).toBe('low');
    expect(result.readBack).toEqual(
      expect.arrayContaining([
        '25% of the plan for the theme Semiconductors.',
        '75% of the plan for dollar yield from a rate alone.',
        'To hold “semiconductors”, the plan uses the limits for low risk.',
      ]),
    );
    expect((result.readBack ?? []).join(' ')).not.toMatch(/part that seeks the goal/);
    // The sum is the whole amount: the whole plan.
    const all = intake(
      'I want to grow $2,000 over 5 years. Put $2,000 in semiconductors',
      reply({ markets: ['semiconductors'] }),
    );
    expect(all.sheet?.sleeves).toEqual([theme('semiconductors')]);
  });

  it('several narratives, each with a written sum: one theme sleeve each', () => {
    const result = intake(
      'I want to grow $2,000 over 5 years. Put $500 in semiconductors and $300 in AI',
      reply({ markets: ['semiconductors', 'ai'] }),
    );
    expect(result.questions).toEqual([]);
    expect(result.sheet?.sleeves).toEqual([
      theme('semiconductors', 2500),
      theme('ai', 1500),
      safe(6000),
    ]);
    // 40% in themes is within the cap of low risk.
    expect(result.sheet?.risk).toBe('low');
    expect(result.assumptions).toContain(
      'To hold “semiconductors and AI”, the plan uses the limits for low risk.',
    );
    // Two narratives that read to one label are one sleeve, their sums together.
    const one = intake(
      'I want to grow $2,000 over 5 years. Put $500 in the US market and $300 in index funds',
      reply({ markets: ['us_market', 'broad_market'] }),
      { portfolios: without('the-500') },
    );
    expect(one.sheet?.sleeves).toEqual([theme('broad-market', 4000), safe(6000)]);
    // A matched theme and a curated one, side by side.
    const mixed = intake(
      'I want to grow $2,000 over 5 years. Put $1,000 in AI and $600 in defense stocks',
      reply({ markets: ['ai', 'defense'] }),
    );
    expect(mixed.sheet?.sleeves).toEqual([
      theme('ai', 5000),
      theme('matched-industry-aerospace-defense', 3000),
      safe(2000),
    ]);
    expect(mixed.sheet?.risk).toBe('high');
  });

  it('no share said: how much is asked once, and never the risk', () => {
    const text = 'I want to grow $2,000 over 5 years. I like semiconductors';
    const asked = intake(text, reply({ markets: ['semiconductors'] }));
    expect(asked.questions).toEqual([
      { field: 'mix', template: 'marketShare', text: 'How much of the $2,000 for semiconductors?' },
    ]);
    expect(asked.flags).toContain('market_share_unclear');
    expect(asked.sheet).toBeNull();
    expect(asked.narratives[0]).toMatchObject({ kind: 'label', slug: 'semiconductors' });
    // Answered in the person's words, on a later turn.
    const inWords = intake(
      conversationText(text, ['put all of it in semiconductors']),
      reply({ markets: ['semiconductors'] }),
    );
    expect(inWords.questions).toEqual([]);
    expect(inWords.sheet?.sleeves).toEqual([theme('semiconductors')]);
    const aSum = intake(
      conversationText(text, ['put $1,000 in semiconductors']),
      reply({ markets: ['semiconductors'] }),
    );
    expect(aSum.sheet?.sleeves).toEqual([theme('semiconductors', 5000), safe(5000)]);
    // Answered on the form, as the split it is.
    const bySleeves = intake(text, reply({ markets: ['semiconductors'] }), {
      answers: { sleeves: [theme('semiconductors', 4000), safe(6000)] },
    });
    expect(bySleeves.questions).toEqual([]);
    expect(bySleeves.sheet?.sleeves).toEqual([theme('semiconductors', 4000), safe(6000)]);
    expect(bySleeves.sheet?.risk).toBe('low');
    // Answered on the form as "how much in stocks, how much in cash": that share is the theme's.
    const byMix = intake(text, reply({ markets: ['semiconductors'] }), {
      answers: { mix: { growthBps: 7000, dollarYieldBps: 0, goldBps: 0, cashBps: 3000 } },
    });
    expect(byMix.questions).toEqual([]);
    expect(byMix.flags).toContain('sleeves_from_mix_answer');
    expect(byMix.sheet?.sleeves).toEqual([theme('semiconductors', 7000), safe(3000)]);
    expect(byMix.sheet?.mix).toBeUndefined();
    expect(byMix.mix).toBeNull();
    expect(byMix.sheet?.risk).toBe('medium');
    // An answer that holds more than stocks and cash cannot be one theme's share: it stays the mix
    // the person entered, and the operator is told the theme is not held.
    const withGold = intake(text, reply({ markets: ['semiconductors'] }), {
      answers: { mix: { growthBps: 5000, dollarYieldBps: 0, goldBps: 2000, cashBps: 3000 } },
    });
    expect(withGold.flags).toContain('theme_not_held:semiconductors');
    expect(withGold.sheet?.sleeves).toBeUndefined();
    expect(withGold.sheet?.mix?.goldBps).toBe(2000);
  });

  it('several themes whose shares are not all written: the split is asked once, never the risk', () => {
    const SPLIT = {
      field: 'sleeves',
      template: 'sleeves',
      text: 'How do you want to split the money: how much kept safe and easy to take out, and how much to seek a return?',
    };
    const r = reply({ markets: ['semiconductors', 'ai'] });
    // Sums that come to more than the money.
    const over = intake(
      'I want to grow $2,000 over 5 years. Put $1,500 in semiconductors and $900 in AI',
      r,
    );
    expect(over.questions).toEqual([SPLIT]);
    expect(over.flags).toContain('theme_shares_unclear');
    expect(over.sheet).toBeNull();
    // One with the whole and one with no share.
    const half = intake(
      'I want to grow $2,000 over 5 years. Invest in semiconductors, and I like AI',
      r,
    );
    expect(half.questions).toEqual([SPLIT]);
    // None with a share. Only a split can say a share for each, so the split is what is asked: an
    // answer of "how much in stocks" could not say whose it is.
    const text = 'I want to grow $2,000 over 5 years. I like semiconductors and AI';
    const none = intake(text, r);
    expect(none.questions).toEqual([SPLIT]);
    expect(none.narratives.map((n) => n.slug)).toEqual(['semiconductors', 'ai']);
    // Answered on the form, as a split that names each theme.
    const bySleeves = intake(text, r, {
      answers: { sleeves: [theme('semiconductors', 3000), theme('ai', 3000), safe(4000)] },
    });
    expect(bySleeves.questions).toEqual([]);
    expect(bySleeves.sheet?.sleeves).toEqual([
      theme('semiconductors', 3000),
      theme('ai', 3000),
      safe(4000),
    ]);
    expect(bySleeves.sheet?.risk).toBe('medium');
    // Answered in the person's words, each with its sum.
    const inWords = intake(
      conversationText(text, ['put $600 in semiconductors and $400 in AI']),
      r,
    );
    expect(inWords.questions).toEqual([]);
    expect(inWords.sheet?.sleeves).toEqual([
      theme('semiconductors', 3000),
      theme('ai', 2000),
      safe(5000),
    ]);
    // A mix sent for it cannot say whose share it is: it stays the mix entered, and the operator is
    // told that neither theme is held.
    const byMix = intake(text, r, {
      answers: { mix: { growthBps: 5000, dollarYieldBps: 0, goldBps: 0, cashBps: 5000 } },
    });
    expect(byMix.flags).toEqual(
      expect.arrayContaining(['theme_not_held:semiconductors', 'theme_not_held:ai']),
    );
    expect(byMix.sheet?.sleeves).toBeUndefined();
    expect(byMix.sheet?.mix?.growthBps).toBe(5000);
  });

  it('a sum with no amount yet: the amount is asked, and neither the share nor the risk', () => {
    const text = 'I want to grow my savings over 5 years. Put $500 in semiconductors';
    const waiting = intake(text, reply({ amountUsd: null, markets: ['semiconductors'] }));
    expect(fields(waiting)).toEqual(['amountUsd']);
    const answered = intake(text, reply({ amountUsd: null, markets: ['semiconductors'] }), {
      answers: { amountUsd: 5000 },
    });
    expect(answered.questions).toEqual([]);
    expect(answered.sheet?.sleeves).toEqual([theme('semiconductors', 1000), safe(9000)]);
  });

  // The review of Oct 6, finding 4: the limits follow what is held, and a risk the person gave is
  // never replaced in silence. The sheet takes the risk the engine will use, and one line says both.
  it('a risk the person answered beside a theme: the sheet takes the risk the themes need, and one line says both', () => {
    const text = 'Invest $2,000 in semiconductors for 5 years';
    const result = intake(text, reply({ markets: ['semiconductors'] }), {
      answers: { risk: 'medium' },
    });
    expect(result.questions).toEqual([]);
    expect(result.sheet?.risk).toBe('high');
    expect(result.flags).toEqual(
      expect.arrayContaining(['risk_from_themes', 'risk_said_not_used:medium']),
    );
    expect(result.assumptions.filter((s) => /limits for/.test(s))).toEqual([
      'You said medium risk, but to hold “semiconductors” the plan uses the limits for high risk.',
    ]);
    expect((result.readBack ?? []).filter((s) => /risk/.test(s))).toEqual([
      'You said medium risk, but to hold “semiconductors” the plan uses the limits for high risk.',
    ]);
    // An answer that is the risk the themes need changes nothing, and the plain line is said.
    const same = intake(text, reply({ markets: ['semiconductors'] }), {
      answers: { risk: 'high' },
    });
    expect(same.sheet?.risk).toBe('high');
    expect(same.flags.filter((f) => f.startsWith('risk_said_not_used'))).toEqual([]);
    expect(same.assumptions.filter((s) => /limits for/.test(s))).toEqual([
      'To hold “semiconductors”, the plan uses the limits for high risk.',
    ]);
    // A risk written in the text, read by the model, is the person's word too.
    const written = intake(
      'Invest $2,000 in semiconductors for 5 years, at low risk',
      reply({ markets: ['semiconductors'], risk: 'low' }),
    );
    expect(written.sheet?.risk).toBe('high');
    expect(written.assumptions).toContain(
      'You said low risk, but to hold “semiconductors” the plan uses the limits for high risk.',
    );
    // An answered split held in themes, with an answered risk beside it.
    const split = intake('I want to grow $2,000 over 5 years', reply(), {
      answers: { sleeves: [theme('ai', 6000), safe(4000)], risk: 'low' },
    });
    expect(split.sheet?.risk).toBe('medium');
    expect(split.assumptions).toContain(
      'You said low risk, but to hold “AI” the plan uses the limits for medium risk.',
    );
    // In Portuguese.
    const pt = intake(
      'Quero investir US$ 2.000 em semicondutores por 5 anos',
      reply({ language: 'pt', markets: ['semiconductors'] }),
      { answers: { risk: 'low' } },
    );
    expect(pt.assumptions).toContain(
      'Você disse risco baixo, mas para manter “semicondutores” o plano usa os limites de risco alto.',
    );
  });

  it('the same goal sent 10 times gives one sheet', () => {
    const sent = Array.from({ length: 10 }, () =>
      JSON.stringify(
        intake(
          'I want to grow $2,000 over 5 years. Put $500 in semiconductors and $300 in AI',
          reply({ markets: ['semiconductors', 'ai'] }),
        ),
      ),
    );
    expect(new Set(sent).size).toBe(1);
  });
});

describe('a mix and sleeves are never combined by guessing: asked once instead', () => {
  it('a theme beside a shared portfolio the text also names: the split, once', () => {
    const result = intake(
      'Invest $2,000 in big tech and semiconductors for 5 years',
      reply({ markets: ['big_tech', 'semiconductors'] }),
    );
    expect(result.narratives.map((n) => [n.id, n.kind])).toEqual([
      ['big_tech', 'portfolio'],
      ['semiconductors', 'label'],
    ]);
    // Sums for both would not settle it either: a shared portfolio is where a plan starts from, a
    // theme is a sleeve, and only the person's split says how the two sit together.
    expect(fields(result)).toEqual(['sleeves']);
    expect(result.flags).toEqual(
      expect.arrayContaining(['theme_beside_portfolio', 'theme_shares_unclear']),
    );
    expect(result.flags).not.toContain('mix_from_market');
    expect(result.flags).not.toContain('market_share_unclear');
    const sums = intake(
      'I want to grow $2,000 over 5 years. Put $1,000 in big tech and $500 in semiconductors',
      reply({ markets: ['big_tech', 'semiconductors'] }),
    );
    expect(fields(sums)).toEqual(['sleeves']);
    expect(result.draft.themes).toEqual(['the-seven']);
    expect(result.sheet).toBeNull();
    // The answer says the split: the theme its share, the rest for the goal, from The Seven.
    const answered = intake(
      'Invest $2,000 in big tech and semiconductors for 5 years',
      reply({ markets: ['big_tech', 'semiconductors'] }),
      {
        answers: {
          sleeves: [theme('semiconductors', 4000), { kind: 'goal', shareBps: 6000 }],
          risk: 'high',
        },
      },
    );
    expect(answered.questions).toEqual([]);
    expect(answered.sheet).toMatchObject({ themes: ['the-seven'], risk: 'high' });
    expect(answered.sheet?.sleeves).toEqual([
      theme('semiconductors', 4000),
      { kind: 'goal', shareBps: 6000 },
    ]);
  });

  it('a theme beside a split of the money the text writes: the split, once', () => {
    const text = 'Grow $2,000 over 5 years: 70% safe and 30% in semiconductors';
    const asked = intake(text, reply({ markets: ['semiconductors'] }));
    expect(fields(asked)).toEqual(['sleeves']);
    expect(asked.flags).toContain('theme_beside_split');
    expect(asked.sheet).toBeNull();
    // A split the model reads beside it is not taken either.
    const withSplit = intake(
      text,
      reply({
        markets: ['semiconductors'],
        sleeves: [
          { kind: 'safe_yield', sharePct: 70 },
          { kind: 'goal', sharePct: 30 },
        ],
      }),
    );
    expect(fields(withSplit)).toEqual(['sleeves']);
    const answered = intake(text, reply({ markets: ['semiconductors'] }), {
      answers: { sleeves: [safe(7000), theme('semiconductors', 3000)] },
    });
    expect(answered.questions).toEqual([]);
    expect(answered.sheet?.sleeves).toEqual([safe(7000), theme('semiconductors', 3000)]);
    expect(answered.sheet?.risk).toBe('low');
  });

  it('a theme beside a mix the text states that says another share: how much, once', () => {
    const text = 'Invest $2,000 in semiconductors for 5 years, 70% stocks and 30% cash';
    const asked = intake(text, reply({ markets: ['semiconductors'] }));
    expect(asked.questions).toEqual([
      { field: 'mix', template: 'marketShare', text: 'How much of the $2,000 for semiconductors?' },
    ]);
    expect(asked.flags).toEqual(expect.arrayContaining(['theme_beside_mix']));
    expect(asked.flags).not.toContain('risk_from_mix');
    expect(asked.assumptions.filter((s) => /limits for/.test(s))).toEqual([]);
    expect(asked.sheet).toBeNull();
    const answered = intake(text, reply({ markets: ['semiconductors'] }), {
      answers: { mix: { growthBps: 7000, dollarYieldBps: 0, goldBps: 0, cashBps: 3000 } },
    });
    expect(answered.questions).toEqual([]);
    expect(answered.sheet?.sleeves).toEqual([theme('semiconductors', 7000), safe(3000)]);
    expect(answered.sheet?.mix).toBeUndefined();
    // Answered as a split that holds the theme: the split is what is held, and the mix the text
    // states beside it is not applied.
    const bySleeves = intake(text, reply({ markets: ['semiconductors'] }), {
      answers: { sleeves: [theme('semiconductors', 7000), safe(3000)] },
    });
    expect(bySleeves.questions).toEqual([]);
    expect(bySleeves.flags).toContain('mix_dropped_for_sleeves');
    expect(bySleeves.sheet?.sleeves).toEqual([theme('semiconductors', 7000), safe(3000)]);
    expect(bySleeves.sheet?.mix).toBeUndefined();
    expect(bySleeves.mix).toBeNull();
    // Two themes beside such a mix: only a split can say each share, so the split is asked.
    const two = intake(
      'Invest $2,000 in semiconductors and AI for 5 years, 70% stocks and 30% cash',
      reply({ markets: ['semiconductors', 'ai'] }),
    );
    expect(fields(two)).toEqual(['sleeves']);
    expect(two.flags).toEqual(expect.arrayContaining(['theme_beside_mix', 'theme_shares_unclear']));
    expect(two.sheet).toBeNull();
    const twoAnswered = intake(
      'Invest $2,000 in semiconductors and AI for 5 years, 70% stocks and 30% cash',
      reply({ markets: ['semiconductors', 'ai'] }),
      { answers: { sleeves: [theme('semiconductors', 4000), theme('ai', 3000), safe(3000)] } },
    );
    expect(twoAnswered.questions).toEqual([]);
    expect(twoAnswered.sheet?.sleeves).toEqual([
      theme('semiconductors', 4000),
      theme('ai', 3000),
      safe(3000),
    ]);
    expect(twoAnswered.sheet?.mix).toBeUndefined();
  });

  it('a mix that says the same as the theme is no second mechanism: the sleeves are made', () => {
    const same = intake(
      'Invest $2,000 in semiconductors for 5 years. All of it in stocks',
      reply({ markets: ['semiconductors'] }),
    );
    expect(same.questions).toEqual([]);
    expect(same.sheet?.sleeves).toEqual([theme('semiconductors')]);
    expect(same.sheet?.mix).toBeUndefined();
    expect(same.mix).toBeNull();
    const part = intake(
      'I want to grow $2,000 over 5 years. Put $1,400 in semiconductors: 70% stocks and 30% cash',
      reply({ markets: ['semiconductors'] }),
    );
    expect(part.questions).toEqual([]);
    expect(part.sheet?.sleeves).toEqual([theme('semiconductors', 7000), safe(3000)]);
  });

  it('a narrative the chain has nothing for, beside a theme: said, and neither held nor asked', () => {
    const result = intake(
      'Invest $2,000 in semiconductors for 5 years. I also like space stocks',
      reply({ markets: ['semiconductors', 'space'] }),
    );
    expect(result.questions).toEqual([]);
    expect(result.sheet?.sleeves).toEqual([theme('semiconductors')]);
    expect(result.assumptions).toContain(
      'There is no stock for “space stocks” on Solana at the moment. We will be adding more soon.',
    );
  });
});

describe('a theme on a goal of income or to protect (gate PROTECT-NO-STOCKS)', () => {
  it('is not held, as a market is not: its share is not read, the risk is asked, and it is said', () => {
    const text =
      'I want $50 a month of income from $10,000 for 5 years, all of it in semiconductors';
    const r = reply({
      goal: 'income',
      amountUsd: 10_000,
      incomeTargetUsdMonthly: 50,
      markets: ['semiconductors'],
    });
    const result = intake(text, r);
    expect(result.narratives[0]).toMatchObject({ kind: 'label', slug: 'semiconductors' });
    expect(result.flags).toContain('themes_dropped_for_goal');
    expect(result.flags).not.toContain('sleeves_from_market');
    expect(fields(result)).toEqual(['risk']);
    expect(result.draft.sleeves).toBeNull();
    const done = intake(text, r, { answers: { risk: 'low' } });
    expect(done.questions).toEqual([]);
    expect(done.sheet).toMatchObject({ goal: 'income', risk: 'low' });
    expect(done.sheet?.sleeves).toBeUndefined();
    expect(done.sheet?.mix).toBeUndefined();
    expect(done.assumptions).toContain(
      'A plan for a goal of income holds no stocks or crypto, so “semiconductors” is not held.',
    );
    // To protect, with a matched theme: the same, and nothing is said to be matched.
    const protect = intake(
      'Protect $10,000 for 2 years at low risk, in defense stocks',
      reply({ goal: 'protect', amountUsd: 10_000, horizonMonths: 24, risk: 'low' }),
      // The rules parser reads this goal and risk another way, so both are confirmed by the person.
      { answers: { goal: 'protect', risk: 'low' } },
    );
    expect(protect.questions).toEqual([]);
    expect(protect.sheet).toMatchObject({ goal: 'protect', risk: 'low' });
    expect(protect.sheet?.sleeves).toBeUndefined();
    expect(protect.assumptions).toContain(
      'A plan for a goal to protect holds no stocks or crypto, so “defense stocks” is not held.',
    );
    expect(protect.assumptions.join(' ')).not.toMatch(/matched by/);
  });

  it('a market with a shared portfolio on such a goal is read as before', () => {
    const result = intake(
      'I want $50 a month of income from $10,000 for 5 years, invested in big tech',
      reply({
        goal: 'income',
        amountUsd: 10_000,
        incomeTargetUsdMonthly: 50,
        markets: ['big_tech'],
      }),
    );
    expect(result.draft.themes).toEqual(['the-seven']);
    expect(result.mix).toBeNull();
    expect(fields(result)).toEqual(['risk']);
  });

  it('a goal answered as income after the theme was read drops it, and says so', () => {
    const text = 'I have $2,000 for 5 years, all of it in semiconductors';
    const first = intake(text, reply({ goal: null, markets: ['semiconductors'] }));
    expect(fields(first)).toEqual(['goal']);
    expect(first.draft.sleeves).toEqual([theme('semiconductors')]);
    const grow = intake(text, reply({ goal: null, markets: ['semiconductors'] }), {
      answers: { goal: 'grow' },
    });
    expect(grow.sheet?.sleeves).toEqual([theme('semiconductors')]);
    const income = intake(text, reply({ goal: null, markets: ['semiconductors'] }), {
      answers: { goal: 'income', incomeTargetUsdMonthly: 10, risk: 'low' },
    });
    expect(income.sheet?.sleeves).toBeUndefined();
    expect(income.flags).toContain('themes_dropped_for_goal');
  });
});

describe('an answer that carries a theme sleeve is held to the shelf', () => {
  const text = 'I want to grow $2,000 over 5 years';

  it('a curated label that holds a stock on the chain, or a filter that matches one, is taken', () => {
    const byLabel = intake(text, reply(), {
      answers: { sleeves: [theme('ai', 6000), safe(4000)] },
    });
    expect(byLabel.questions).toEqual([]);
    expect(byLabel.sheet?.sleeves).toEqual([theme('ai', 6000), safe(4000)]);
    // No goal part: the limits follow the themes, and the risk is not asked.
    expect(byLabel.sheet?.risk).toBe('medium');
    expect(byLabel.readBack).toEqual(
      expect.arrayContaining([
        '60% of the plan for the theme AI.',
        'To hold “AI”, the plan uses the limits for medium risk.',
      ]),
    );
    const slug = 'matched-industry-aerospace-defense';
    const byFilter = intake(text, reply(), { answers: { sleeves: [theme(slug)] } });
    expect(byFilter.questions).toEqual([]);
    expect(byFilter.sheet?.sleeves).toEqual([theme(slug)]);
    expect(byFilter.readBack).toContain(
      '100% of the plan for names matched by industry: Aerospace & Defense.',
    );
    expect(byFilter.assumptions).toContain(
      'To hold “names matched by industry: Aerospace & Defense”, the plan uses the limits for high risk.',
    );
  });

  it('anything else is refused, flagged, and the split asked again', () => {
    for (const slug of [
      'moon-rockets',
      // A label that is a proposal, and one that lists nothing here.
      'defense',
      'space',
      // A filter that matches nothing on the chain, and one whose stocks are not listed here.
      'matched-industry-banks',
      'matched-subindustry-automobile-manufacturers',
      // A slug that is not written as a filter writes one.
      'matched-industry-Aerospace',
      // A shared portfolio is where a plan starts from, not a theme sleeve.
      'the-seven',
    ]) {
      const result = intake(text, reply(), {
        answers: { risk: 'high', sleeves: [theme(slug, 5000), safe(5000)] },
      });
      expect(result.flags, slug).toContain('answer_not_on_shelf:sleeves');
      expect(fields(result), slug).toEqual(['sleeves']);
      expect(result.sheet, slug).toBeNull();
    }
  });

  it('with a part for the goal beside the theme, the risk is asked as for any goal', () => {
    const sleeves = [theme('ai', 3000), { kind: 'goal' as const, shareBps: 7000 }];
    const asked = intake(text, reply(), { answers: { sleeves } });
    expect(fields(asked)).toEqual(['risk']);
    expect(asked.flags).not.toContain('risk_from_themes');
    const done = intake(text, reply(), { answers: { sleeves, risk: 'medium' } });
    expect(done.sheet?.sleeves).toEqual(sleeves);
    expect(done.readBack?.[0]).toBe(
      'You set a goal to grow with $2,000 over 5 years, at medium risk.',
    );
  });
});

describe('while the person has no chain', () => {
  it('nothing is resolved, nothing is said of what a chain has, and the chain is asked first', () => {
    for (const [text, r, flag] of [
      [
        'Invest $2,000 in semiconductors for 5 years',
        reply({ markets: ['semiconductors'] }),
        'market_unresolved:semiconductors',
      ],
      [
        'Invest $2,000 in big tech for 5 years',
        reply({ markets: ['big_tech'] }),
        'market_unresolved:big_tech',
      ],
      [
        'Invest $2,000 in space for 5 years',
        reply({ markets: ['space'] }),
        'market_unresolved:space',
      ],
      [
        recordedCase('obesity-drugs').text,
        recordedCase('obesity-drugs').reply,
        'market_unresolved:marketFilter',
      ],
    ] as const) {
      const result = intake(text, r, { homeChain: null });
      expect(result.narratives, text).toEqual([]);
      expect(result.flags, text).toContain(flag);
      expect(
        result.flags.filter((f) => /not_on_shelf|^label_|no_match/.test(f)),
        text,
      ).toEqual([]);
      // Neither the risk nor the share is asked before the chain: what holds it is not known yet.
      expect(fields(result), text).toEqual(['chains']);
      expect(result.draft.themes, text).toBeNull();
      expect(result.draft.sleeves, text).toBeNull();
      expect(result.assumptions.join(' '), text).not.toMatch(/no stock|curated|nearest/);
      expect(result.sheet, text).toBeNull();
    }
    // A theme sleeve answered before the chain is not judged yet.
    const answered = intake('I want to grow $2,000 over 5 years', reply(), {
      homeChain: null,
      answers: { sleeves: [theme('moon-rockets')] },
    });
    expect(answered.flags).not.toContain('answer_not_on_shelf:sleeves');
    expect(answered.sheet).toBeNull();
  });
});

describe('the read-back and the assumptions, in English and Portuguese', () => {
  const pt = (over: Record<string, unknown> = {}) => reply({ language: 'pt', ...over });

  it('a curated label is said by its name in the person language', () => {
    const result = intake('Quero investir US$ 2.000 em IA por 5 anos', pt({ markets: ['ai'] }));
    expect(result.narratives).toEqual([
      { id: 'ai', words: 'IA', kind: 'label', slug: 'ai', filter: null, name: 'IA' },
    ]);
    expect(result.readBack).toEqual([
      'Você definiu um objetivo de crescimento com US$ 2.000 em 5 anos.',
      'O plano fica na rede Solana, a rede da sua carteira.',
      'Os tokens que você já tem contam para o plano.',
      '100% do plano para o tema IA.',
      'Uma parte do plano que cresceu fica como cresceu.',
      'Para manter “IA”, o plano usa os limites de risco alto.',
      'Nada vai para caixa conforme a data se aproxima, a menos que você peça.',
      'Se estiver certo, confirme e o plano é feito a partir disso.',
    ]);
    const en = intake('Invest $2,000 in AI for 5 years', reply({ markets: ['ai'] }));
    expect(en.readBack).toEqual([
      'You set a goal to grow with $2,000 over 5 years.',
      'The plan lives on Solana, the chain of your wallet.',
      'Tokens you already hold count toward the plan.',
      '100% of the plan for the theme AI.',
      'A part of the plan that has grown is left as it grew.',
      'To hold “AI”, the plan uses the limits for high risk.',
      'Nothing moves toward cash as the date nears unless you ask for it.',
      'If this is right, confirm it and the plan is made from it.',
    ]);
  });

  it('a matched theme is said by what it was matched by, never as a curated theme', () => {
    const result = intake(
      'Quero investir US$ 2.000 no setor de defesa por 5 anos',
      pt({ markets: ['defense'] }),
    );
    expect(result.narratives[0]?.name).toBe('nomes filtrados por indústria: Aerospace & Defense');
    expect(result.readBack).toEqual(
      expect.arrayContaining([
        '100% do plano para nomes filtrados por indústria: Aerospace & Defense.',
        'Para manter “setor de defesa”, o plano usa os limites de risco alto.',
        'Nenhuma lista com curadoria cobre “setor de defesa” na Solana, então o plano fica com os nomes filtrados por indústria: Aerospace & Defense. Filtrados pelos atributos de cada um, que têm fonte; não é um tema com curadoria.',
      ]),
    );
    expect((result.readBack ?? []).join(' ')).not.toMatch(/para o tema/);
    // Each kind of filter has its word, in both languages.
    // (Two names listed: since Oct 7 a filter that lists one alone is held by no sleeve.)
    const words = (language: 'en' | 'pt', by: MarketFilter['by']) =>
      intake('Invest $2,000 in uranium miners for 5 years', reply({ language }), {
        matchOf: () => ({ value: 'Uranium', listed: 2 }),
        answers: { sleeves: [theme(matchedSlug({ by, value: 'Uranium' }) as string)] },
      }).readBack?.find((s) => /Uranium/.test(s));
    expect(
      (['sector', 'industry', 'sub_industry', 'keyword'] as const).map((by) => words('en', by)),
    ).toEqual([
      '100% of the plan for names matched by sector: Uranium.',
      '100% of the plan for names matched by industry: Uranium.',
      '100% of the plan for names matched by sub-industry: Uranium.',
      '100% of the plan for names matched by keyword: Uranium.',
    ]);
    expect(
      (['sector', 'industry', 'sub_industry', 'keyword'] as const).map((by) => words('pt', by)),
    ).toEqual([
      '100% do plano para nomes filtrados por setor: Uranium.',
      '100% do plano para nomes filtrados por indústria: Uranium.',
      '100% do plano para nomes filtrados por subindústria: Uranium.',
      '100% do plano para nomes filtrados por palavra-chave: Uranium.',
    ]);
  });

  it('nothing on the chain is said as the founder wrote it, with and without a nearest', () => {
    const none = intake(
      'Quero investir US$ 2.000 no setor espacial por 5 anos',
      pt({ markets: ['space'] }),
    );
    expect(none.assumptions).toContain(
      'No momento não há nenhuma ação para “setor espacial” na Solana. Vamos incluir mais em breve.',
    );
    const nearest = intake(
      'Quero investir US$ 2.000 em computação quântica por 5 anos',
      pt({ markets: ['quantum'] }),
    );
    expect(nearest.assumptions).toContain(
      'No momento não há nenhuma ação para “computação quântica” na Solana, e vamos incluir mais em breve. O mais próximo hoje é IA, que você pode escolher.',
    );
    const onBase = intake(
      'Quero investir US$ 2.000 no setor espacial por 5 anos',
      pt({ markets: ['space'] }),
      { homeChain: 'base' },
    );
    expect(onBase.assumptions).toContain(
      'No momento não há nenhuma ação para “setor espacial” na Base. Vamos incluir mais em breve.',
    );
  });

  it('the share is asked in the person language, by the words they wrote', () => {
    const asked = intake(
      'Quero crescer US$ 2.000 em 5 anos. Gosto de semicondutores',
      pt({ markets: ['semiconductors'] }),
    );
    expect(asked.questions.map((q) => q.text)).toEqual([
      'Quanto dos US$ 2.000 para semicondutores?',
    ]);
  });
});

// The second review of the intake (Oct 7), rule 6: a filter is never used to pick one stock. "I want
// to invest $5,000 in my future" with a reply naming the industry Automobiles gave a sheet all in the
// one car maker the chain lists.
describe('a filter that matches one name alone is no theme', () => {
  const one =
    (...keys: string[]) =>
    (filter: MarketFilter): FilterMatch | null =>
      keys.includes(`${filter.by}:${attributeKey(filter.value)}`)
        ? { value: filter.value, listed: 1 }
        : null;
  const FUTURE = 'I want to invest $5,000 in my future over 5 years';
  const cars = { by: 'industry', value: 'Automobiles', words: 'my future' };

  it('holds nothing for it and says so in its own sentence, never the sentence for no stock at all', () => {
    const result = intake(FUTURE, reply({ amountUsd: 5000, marketFilter: cars }), {
      matchOf: one('industry:automobiles'),
    });
    expect(result.narratives).toEqual([
      { id: null, words: 'my future', kind: 'none', slug: null, filter: null, name: null },
    ]);
    expect(result.flags).toEqual(
      expect.arrayContaining(['filter_one_name:marketFilter', 'market_not_on_shelf:marketFilter']),
    );
    expect(result.flags).not.toContain('filter_no_match:marketFilter');
    expect(result.assumptions).toContain(
      'There is only one stock for “my future” on Solana at the moment, and a theme is not made of one. We will be adding more soon.',
    );
    expect(result.assumptions.join(' ')).not.toMatch(/There is no stock for/);
    // Nothing is held and nothing is asked of it: the risk is asked, as for any goal.
    expect(result.sheet).toBeNull();
    expect(result.mix).toBeNull();
    expect(result.draft.sleeves).toBeNull();
    expect(fields(result)).toEqual(['risk']);
    const done = intake(FUTURE, reply({ amountUsd: 5000, marketFilter: cars }), {
      matchOf: one('industry:automobiles'),
      answers: { risk: 'medium' },
    });
    expect(done.sheet).toMatchObject({ risk: 'medium', themes: [] });
    expect(done.sheet?.sleeves).toBeUndefined();
    expect(JSON.stringify(done.sheet)).not.toMatch(/automobiles/);
    // Two names listed: the same filter is a theme, said as matched.
    const two = intake(FUTURE, reply({ amountUsd: 5000, marketFilter: cars }), {
      matchOf: () => ({ value: 'Automobiles', listed: 2 }),
    });
    expect(two.narratives[0]).toMatchObject({
      kind: 'matched',
      slug: 'matched-industry-automobiles',
    });
  });

  it('is the same for a fixed fallback of a narrative, with the nearest offered where the shelf has one', () => {
    // Electric vehicles: the keyword lists nothing here and the sub-industry lists one car maker.
    const ev = intake(
      'Invest $2,000 in electric vehicles for 5 years',
      reply({ markets: ['ev_autonomy'] }),
      { matchOf: one('sub_industry:automobile-manufacturers') },
    );
    expect(ev.narratives[0]).toMatchObject({ kind: 'none', slug: null, filter: null });
    expect(ev.flags).toContain('filter_one_name:ev_autonomy');
    expect(ev.assumptions).toContain(
      'There is only one stock for “electric vehicles” on Solana at the moment, and a theme is not made of one. We will be adding more soon. The nearest today is AI, which you can choose.',
    );
    expect(ev.sheet).toBeNull();
    expect(fields(ev)).toEqual(['risk']);
    // In Portuguese, with no nearest on the shelf.
    const pt = intake(
      'Quero investir US$ 2.000 em carros elétricos por 5 anos',
      reply({ language: 'pt', markets: ['ev_autonomy'] }),
      { matchOf: one('sub_industry:automobile-manufacturers'), labels: [], portfolios: [] },
    );
    expect(pt.assumptions).toContain(
      'No momento há só uma ação para “carros elétricos” na Solana, e um tema não se faz de uma só. Vamos incluir mais em breve.',
    );
  });

  it('a confirmed label is a person list and may hold one name', () => {
    const curated = intake('Invest $2,000 in AI for 5 years', reply({ markets: ['ai'] }), {
      labels: [label('ai', 'AI', 'IA', 'confirmed', 1)],
    });
    expect(curated.narratives[0]).toMatchObject({ kind: 'label', slug: 'ai' });
    expect(curated.sheet?.sleeves).toEqual([theme('ai')]);
  });

  it('an answered split cannot hold it either: refused, and asked again', () => {
    const slug = matchedSlug({ by: 'industry', value: 'Automobiles' }) as string;
    const answered = intake(
      'I want to grow $2,000 over 5 years at medium risk',
      reply({ risk: 'medium' }),
      { matchOf: one('industry:automobiles'), answers: { sleeves: [theme(slug)] } },
    );
    expect(answered.flags).toContain('answer_not_on_shelf:sleeves');
    expect(answered.sheet).toBeNull();
    expect(fields(answered)).toEqual(['sleeves']);
  });
});

// The second review of the intake (Oct 7), rule 7: two inputs a caller with the shelf hands in.
describe('what a caller with the shelf hands in: the risk of a split held in themes, and a shelf it could not read', () => {
  const SEMIS = 'I want to grow $2,000 over 5 years. Put 30% in semiconductors.';
  const semis = () => reply({ markets: ['semiconductors'] });

  it('riskOfSleeves: the limits a sheet held in themes takes are the caller rule, said in the read-back', () => {
    // Left out: the estimate on the issuer caps, which reads 30% in a theme as low risk.
    const estimated = intake(SEMIS, semis());
    expect(estimated.sheet).toMatchObject({
      risk: 'low',
      sleeves: [theme('semiconductors', 3000), safe(7000)],
    });
    expect(estimated.readBack).toContain(
      'To hold “semiconductors”, the plan uses the limits for low risk.',
    );
    // Handed in: the caller sees the sleeves and the shared portfolios read, and its answer is the
    // sheet's risk and the one line of the read-back.
    const seen: unknown[] = [];
    const exact = intake(SEMIS, semis(), {
      riskOfSleeves: (sleeves, themes) => {
        seen.push([sleeves, themes]);
        return 'high';
      },
    });
    expect(seen).toEqual([[[theme('semiconductors', 3000), safe(7000)], []]]);
    expect(exact.sheet).toMatchObject({
      risk: 'high',
      sleeves: [theme('semiconductors', 3000), safe(7000)],
    });
    expect(exact.readBack).toContain(
      'To hold “semiconductors”, the plan uses the limits for high risk.',
    );
    expect(exact.flags).toContain('risk_from_themes');
    // A risk the person said that is another is said with it, never dropped.
    const said = intake(`${SEMIS} Low risk.`, reply({ markets: ['semiconductors'], risk: 'low' }), {
      riskOfSleeves: () => 'high',
    });
    expect(said.sheet?.risk).toBe('high');
    expect(said.flags).toContain('risk_said_not_used:low');
    expect(said.readBack).toContain(
      'You said low risk, but to hold “semiconductors” the plan uses the limits for high risk.',
    );
    // It is not called for a plan that holds no theme.
    const plain = intake(
      'I want to grow $2,000 over 5 years at medium risk',
      reply({ risk: 'medium' }),
      {
        riskOfSleeves: () => {
          throw new Error('not held in themes');
        },
      },
    );
    expect(plain.sheet?.risk).toBe('medium');
  });

  it('shelfKnown false: a narrative is left unresolved, as with no chain, and no sentence says the chain has no stock', () => {
    const AI = 'I want to invest $2,000 in AI for 5 years';
    for (const r of [reply({ markets: ['ai'] }), null]) {
      const answers: IntakeAnswers = r ? {} : { goal: 'grow', horizonMonths: 60 };
      // With the shelf read and nothing on it for AI, the founder's sentence is said.
      const read = intake(AI, r, { labels: [], portfolios: [], matchOf: undefined, answers });
      expect(read.narratives.map((n) => n.kind)).toEqual(['none']);
      expect(read.assumptions.join(' ')).toMatch(/There is no stock for “AI” on Solana/);
      // With the shelf not read, nobody looked: it is not said, and nothing is resolved.
      const unread = intake(AI, r, {
        labels: [],
        portfolios: [],
        matchOf: undefined,
        shelfKnown: false,
        answers: { ...answers, risk: 'medium' },
      });
      expect(unread.narratives).toEqual([]);
      expect(unread.flags).toEqual(
        expect.arrayContaining(['market_unresolved:ai', 'shelf_unread']),
      );
      expect(unread.flags.filter((f) => /not_on_shelf|filter_no_match|label_/.test(f))).toEqual([]);
      const said = [...unread.assumptions, ...unread.questions.map((q) => q.text)].join(' ');
      expect(said).not.toMatch(/There is no stock|only one stock|nearest|curated list/);
      expect(unread.assumptions).toContain(
        'What is listed on Solana could not be read just now, so nothing is held for “AI” yet.',
      );
      // No sheet is made that would leave out, without a word, what the person asked for.
      expect(unread.sheet).toBeNull();
      expect(unread.readBack).toBeNull();
      expect(unread.mix).toBeNull();
      expect(unread.draft.sleeves).toBeNull();
    }
    // The same for a filter the model names, and for a shared portfolio it names.
    const filter = intake(
      'I want to invest $2,000 in obesity drugs for 5 years',
      reply({ marketFilter: { by: 'keyword', value: 'GLP-1', words: 'obesity drugs' } }),
      { shelfKnown: false, portfolios: [], labels: [], answers: { risk: 'medium' } },
    );
    expect(filter.flags).toEqual(
      expect.arrayContaining(['market_unresolved:marketFilter', 'shelf_unread']),
    );
    expect(filter.sheet).toBeNull();
    const named = intake(
      'I want to grow $2,000 over 5 years at medium risk, starting from The Seven',
      reply({ risk: 'medium', portfolios: ['The Seven'] }),
      { shelfKnown: false, portfolios: [] },
    );
    expect(named.flags).not.toContain('not_on_shelf:themes');
    expect(fields(named)).toEqual([]);
    expect(named.sheet).toBeNull();
    expect(named.assumptions).toContain(
      'What is listed on Solana could not be read just now, so nothing is held for “The Seven” yet.',
    );
    // A goal that names nothing the shelf settles is read as ever.
    const plain = intake(
      'I want to grow $2,000 over 5 years at medium risk',
      reply({ risk: 'medium' }),
      { shelfKnown: false, portfolios: [] },
    );
    expect(plain.flags).not.toContain('shelf_unread');
    expect(plain.sheet).toMatchObject({ risk: 'medium', themes: [] });
  });
});

// Whatever the text says, whatever the shelf holds and whatever is answered: goals put together from
// parts, each read on shelves with other labels and other matches, and answered as a form would, turn
// after turn. No clock and no random source: the sequence below is the same on every run.
describe('whatever the text, the shelf and the answers', () => {
  const openers: { text: string; reply: Record<string, unknown> }[] = [
    { text: 'I want to grow $2,000 over 5 years.', reply: {} },
    {
      text: 'Quero fazer US$ 2.000 crescer em 5 anos.',
      reply: { language: 'pt' },
    },
    {
      text: 'I want $50 a month of income from $10,000 for 5 years.',
      reply: { goal: 'income', amountUsd: 10_000, incomeTargetUsdMonthly: 50 },
    },
    {
      text: 'Protect $8,000 for 2 years, low risk.',
      reply: { goal: 'protect', amountUsd: 8000, horizonMonths: 24, risk: 'low' },
    },
    { text: 'I have some savings.', reply: { goal: null, amountUsd: null, horizonMonths: null } },
  ];
  const named = [
    'big tech',
    'the S&P 500',
    'AI',
    'semiconductors',
    'AI infrastructure',
    'space',
    'quantum computing',
    'software',
    'defense stocks',
    'setor de defesa',
    'obesity drugs',
    'pharma',
    'social media stocks',
    'The Seven',
    'Chips & Agents',
  ];
  const said: ((n: string) => string)[] = [
    (n) => `Invest in ${n}.`,
    (n) => `All of it in ${n}.`,
    (n) => `Put $500 in ${n}.`,
    (n) => `I like ${n}.`,
    (n) => `No ${n}.`,
    (n) => `Put 30% in ${n}.`,
    (n) => `Put $900 in ${n} and $300 in AI.`,
    (n) => `I work in ${n}.`,
    (n) => `Quero investir em ${n}.`,
    (n) => `Half in ${n}.`,
    (n) => `Should I invest in ${n}?`,
    (n) => `I already hold ${n} through my pension.`,
  ];
  const more = [
    '',
    'All of it in stocks.',
    '70% stocks and 30% cash.',
    '70% safe and 30% to risk.',
    "I wouldn't put all of it in stocks.",
    'Should I put all of it in stocks?',
    'Stocks only.',
    'No stocks please.',
    'I have no problem with stocks.',
  ];
  const mixes = [
    { growthBps: 5000, dollarYieldBps: 0, goldBps: 0, cashBps: 5000 },
    { growthBps: 3000, dollarYieldBps: 0, goldBps: 7000, cashBps: 0 },
    { growthBps: WHOLE, dollarYieldBps: 0, goldBps: 0, cashBps: 0 },
  ];

  it('never throws, never holds what the shelf has not, never a mix with sleeves, never asks the risk with a share, never holds or asks what the chain has nothing for, never loses a refusal', () => {
    let state = 20_261_006;
    const next = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    const pick = <T>(from: readonly T[]): T => from[Math.floor(next() * from.length)] as T;
    let sheets = 0;
    let themed = 0;
    let noneOnly = 0;
    let otherRisk = 0;
    let refusals = 0;
    for (let run = 0; run < 400; run += 1) {
      const opener = pick(openers);
      const words = [pick(named), pick(named)].slice(0, Math.floor(next() * 3));
      const text = [opener.text, ...words.map((w) => pick(said)(w)), pick(more)]
        .filter(Boolean)
        .join(pick([' ', '\n\n']));
      const labels = LABELS.filter(() => next() < 0.7).map((l) => ({
        ...l,
        status: pick(['confirmed', 'confirmed', 'proposed'] as const),
        listed: pick([0, 1, 5]),
      }));
      const shelf = portfolios.filter(() => next() < 0.7);
      const match = next() < 0.7 ? matchOf : undefined;
      const usable = (slug: string) =>
        labels.some((l) => l.slug === slug && l.status === 'confirmed' && l.listed > 0) ||
        (isMatchedSlug(slug) &&
          match !== undefined &&
          Object.entries(ATTRIBUTES).some(
            ([key, m]) => m.listed > 0 && matchedSlug(filterOf(key, m.value)) === slug,
          ));
      const r =
        next() < 0.7
          ? reply({
              ...opener.reply,
              mix: pick([
                null,
                null,
                { growthPct: 100, dollarYieldPct: 0, goldPct: 0, cashPct: 0 },
              ]),
              marketFilter: pick([
                null,
                { by: 'keyword', value: 'GLP-1', words: 'obesity drugs' },
                { by: 'industry', value: 'Software', words: words[0] ?? 'savings' },
                { by: 'ticker', value: 'LLY', words: 'obesity drugs' },
              ]),
            })
          : null;
      const homeChain = pick(['solana', 'solana', 'robinhood', null] as const);
      let answers: IntakeAnswers = {};
      for (let turn = 0; turn < 4; turn += 1) {
        const input = { labels, portfolios: shelf, matchOf: match, homeChain, answers };
        const result = intake(text, r, input);
        const where = JSON.stringify({ text, answers, homeChain });
        // The same input gives the same answer, in any order of the labels and the portfolios.
        expect(JSON.stringify(intake(text, r, input)), where).toBe(JSON.stringify(result));
        expect(
          JSON.stringify(
            intake(text, r, {
              ...input,
              labels: [...labels].reverse(),
              portfolios: [...shelf].reverse(),
            }),
          ),
          where,
        ).toBe(JSON.stringify(result));
        // No sentence has a hole in it.
        const sentences = [
          ...result.assumptions,
          ...(result.readBack ?? []),
          ...result.questions.map((q) => q.text),
        ];
        expect(sentences.join(' '), where).not.toMatch(/[{}]|undefined|NaN/);
        // Each narrative reads to what the shelf has, and one with nothing is said.
        for (const n of result.narratives) {
          if (n.kind === 'portfolio')
            expect(
              shelf.map((p) => p.slug),
              where,
            ).toContain(n.slug);
          if (n.kind === 'label' || n.kind === 'matched')
            expect(usable(n.slug as string), where).toBe(true);
          if (n.kind === 'none') {
            expect([n.slug, n.filter, n.name], where).toEqual([null, null, null]);
            expect(
              result.assumptions.some(
                (s) =>
                  s.includes(`“${n.words}”`) && /There is no stock for|não há nenhuma ação/.test(s),
              ),
              where,
            ).toBe(true);
          }
        }
        if (homeChain === null) {
          expect(result.narratives, where).toEqual([]);
          expect(result.sheet, where).toBeNull();
          expect(result.assumptions.join(' '), where).not.toMatch(
            /There is no stock for|não há nenhuma ação|curated list|lista com curadoria/,
          );
        }
        const asked = fields(result);
        expect(new Set(asked).size, where).toBe(asked.length);
        expect(asked.includes('risk') && asked.includes('mix'), where).toBe(false);
        // A refusal the text states is read on every turn, with or without a model, and nothing
        // else is: a ruled-out narrative ("No defense stocks.") and "no problem with stocks" leave
        // out no class. Stocks refused are no stocks through a fund either: both classes.
        const refuses = text.includes('No stocks please.');
        if (refuses) refusals += 1;
        expect(result.limits, where).toEqual({
          creditTolerance: null,
          cannotHoldClasses: refuses ? ['etf', 'stock'] : null,
        });
        if (result.sheet) {
          expect(result.sheet.limits, where).toEqual(
            refuses ? { cannotHold: { classes: ['etf', 'stock'] } } : undefined,
          );
          expect(
            (result.readBack ?? []).some((s) =>
              /^You left out stocks and stock funds\.$|^Você deixou de fora ações e fundos de ações\.$/.test(
                s,
              ),
            ),
            where,
          ).toBe(refuses);
        }
        // A share is asked only of a narrative the chain holds something for, and where every
        // narrative named has nothing there, none of them makes a mix or a sleeve (THEME-NONE-YET).
        const share = result.questions.find((q) => q.field === 'mix' && q.template !== 'mix');
        if (share)
          expect(
            result.narratives.some((n) => n.kind !== 'none' && share.text.includes(n.words)),
            where,
          ).toBe(true);
        if (result.narratives.length > 0 && result.narratives.every((n) => n.kind === 'none')) {
          noneOnly += 1;
          expect(
            result.flags.filter((f) =>
              /^mix_from_market$|^sleeves_from_market$|share_unclear/.test(f),
            ),
            where,
          ).toEqual([]);
        }
        // The model's mix is never held: a mix is the text's own words, or the person's answer.
        if (result.mix && !('mix' in answers))
          expect(
            result.flags.some((f) => f === 'mix_from_market') || /stocks|cash/i.test(text),
            where,
          ).toBe(true);
        const sheet = result.sheet;
        if (sheet) {
          sheets += 1;
          expect(asked, where).toEqual([]);
          expect(PersonalSheet.safeParse(sheet).success, where).toBe(true);
          expect(sheet.mix !== undefined && sheet.sleeves !== undefined, where).toBe(false);
          const held = (sheet.sleeves ?? []).flatMap((s) => (s.kind === 'theme' ? [s.theme] : []));
          if (held.length > 0) themed += 1;
          for (const slug of held) expect(usable(slug), where).toBe(true);
          // With a mix, or a plan held in themes, the sheet's risk is the one the limits need, and a
          // risk the person answered that is another is said in the read-back, never dropped.
          const inThemes = held.length > 0 && !sheet.sleeves?.some((s) => s.kind === 'goal');
          const growthBps = sheet.mix
            ? sheet.mix.growthBps
            : inThemes
              ? (sheet.sleeves ?? []).reduce((n, s) => (s.kind === 'theme' ? n + s.shareBps : n), 0)
              : null;
          if (growthBps !== null) {
            expect(sheet.risk, where).toBe(riskForMixEstimate({ growthBps }));
            const limits = (result.readBack ?? []).filter((s) => /limits for|limites de/.test(s));
            expect(limits, where).toHaveLength(1);
            if (answers.risk !== undefined && answers.risk !== sheet.risk) {
              otherRisk += 1;
              expect(limits[0], where).toMatch(/^You said |^Você disse /);
            }
          }
          // A theme the text names is never held on a goal of income or to protect.
          if (sheet.goal !== 'grow' && answers.sleeves === undefined)
            expect(held, where).toEqual([]);
          break;
        }
        if (asked.every((f) => f === 'chains')) break;
        // Something is asked, or there is a sheet: never neither.
        expect(asked.length, where).toBeGreaterThan(0);
        // Answer what is asked, as a form would; a split that was refused is not sent again.
        const slugs = result.narratives.flatMap((n) =>
          (n.kind === 'label' || n.kind === 'matched') && n.slug ? [n.slug] : [],
        );
        const refused = result.flags.includes('answer_not_on_shelf:sleeves');
        const before = JSON.stringify(answers);
        answers = {
          ...answers,
          ...(asked.includes('goal') ? { goal: pick(['grow', 'grow', 'income'] as const) } : {}),
          ...(asked.includes('amountUsd') ? { amountUsd: 2000 } : {}),
          ...(asked.includes('horizonMonths') ? { horizonMonths: 60 } : {}),
          ...(asked.includes('risk') ? { risk: pick(['low', 'medium', 'high'] as const) } : {}),
          ...(asked.includes('incomeTargetUsdMonthly') ? { incomeTargetUsdMonthly: 20 } : {}),
          ...(asked.includes('currency') ? { currency: 'USD' } : {}),
          ...(asked.includes('themes') ? { themes: [] } : {}),
          ...(asked.includes('mix') ? { mix: pick(mixes) } : {}),
          ...(asked.includes('sleeves')
            ? {
                sleeves: refused
                  ? [safe(7000), { kind: 'goal' as const, shareBps: 3000 }]
                  : pick([
                      [theme(slugs[0] ?? 'moon-rockets', 6000), safe(4000)],
                      [theme(slugs[0] ?? 'ai', 3000), { kind: 'goal' as const, shareBps: 7000 }],
                      [safe(7000), { kind: 'goal' as const, shareBps: 3000 }],
                    ]),
              }
            : {}),
        };
        // Every turn moves: the same question is never asked of the same answers.
        expect(JSON.stringify(answers), where).not.toBe(before);
      }
    }
    // The run reaches sheets, sheets that hold a theme, narratives the chain has nothing for, and a
    // risk answered beside limits of another: the checks above were not idle.
    expect(sheets).toBeGreaterThan(100);
    expect(themed).toBeGreaterThan(20);
    expect(noneOnly).toBeGreaterThan(20);
    expect(otherRisk).toBeGreaterThan(0);
    expect(refusals).toBeGreaterThan(20);
    // Thousands of generated goals in one test: it gets the time of a property test, so a busy
    // machine does not fail it at the default five seconds.
  }, 60_000);
});
