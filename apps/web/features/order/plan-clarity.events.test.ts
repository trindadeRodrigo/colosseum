// @vitest-environment happy-dom
import type { BasketLine, RiskRollUp } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary, type Lang } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { PlanScreen } from './PlanScreen';
import { displayName, flagSentence, flagSentences, kindLabel } from './plain';
import { rememberPlan, type StoredPlan } from './plan-store';
import { PLAN_ID, planOn, serverKeepsPlans, USER } from './test/fixtures';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The plan screen in plain words (Thom, Oct 6): no code of the engine on the page, each asset by its
// name, the plan in one sentence at the top, a short or flat plan said in a sentence instead of a flat
// chart, what a bad fall costs in a sentence, and the engine's notes and the spread of the plan in a
// closed "Details".

const en = dictionary('en');
const pt = dictionary('pt');

/** Every flag the engine and the roll-up write today, with the forms their codes take. */
const FLAGS = [
  'ceiling_from_tier:solana:syrupusdc',
  'coverage_from_tier:solana:jlusdc',
  'exit_capacity_thin:solana:spyx',
  'exit_regime_not_measured:solana:spyx:weekend',
  'liquidity_undated:solana:gldx',
  'fx_open:BRL',
  'no_matching_leg:BRL',
  'schedule_no_fx:BRL',
  'shelf_provenance:sandbox',
  'yield_provenance:sandbox',
  'measured_provenance:fixture',
  'quoted_provenance:mock',
  'exit_not_measured',
  'exit_partly_measured',
  'exit_beyond_measured_size',
  'exit_capacity_short',
  'exit_quote_missing',
  'exit_quote_partial',
  'exit_quote_stale',
  'exit_quote_far_from_size',
  'exit_cost_below_zero',
  'exit_regimes_not_reported',
  'issuer_concentration',
  'asset_not_on_shelf',
  'unplaced',
  'no_dollar_yield',
  'safe_yield_no_rate_leg',
  'yield_not_read',
  'liquidity_unsourced',
  'set_aside_short',
  'coverage_short',
  'coverage_moved',
  'schedule_unpaid',
  'obligations_past',
  'income_not_estimated',
  'income_no_amount_closes',
  'a_code_nobody_wrote_yet:solana:x',
];

const ROLL_UP: RiskRollUp = {
  byIssuer: [{ key: 'Maple Finance', bps: 7500 }],
  byChain: [{ key: 'solana', bps: 10_000 }],
  byClass: [
    { key: 'dollar_yield', bps: 7500 },
    { key: 'cash', bps: 2500 },
  ],
  flags: ['exit_not_measured', 'exit_quote_missing'],
  exit: { quotedBps: null, quotedAt: null, measuredWorstBps: null, measuredShareBps: 0 },
} as RiskRollUp;

/** "$200 for 2 months, high risk": $150 in cash, $50 in syrupUSDC, with the engine's codes on it. */
function small(): StoredPlan {
  const base = planOn('solana', 'sandbox');
  const lines: BasketLine[] = [
    { chain: 'solana', assetId: 'solana:usdc', weightBps: 7500, amountUsd: 150, reasons: [] },
    {
      chain: 'solana',
      assetId: 'solana:syrupusdc',
      weightBps: 2500,
      amountUsd: 50,
      reasons: [
        {
          rule: 'DOLLAR_YIELD',
          inputs: [],
          params: {},
          text: 'Chosen by its yield after haircut, among the dollar-yield tokens you can hold on Solana.',
        },
      ],
    },
  ];
  return {
    ...base,
    rollUp: ROLL_UP,
    proposal: {
      ...base.proposal,
      sheet: { ...base.proposal.sheet, amountUsd: 200, horizonMonths: 2, risk: 'high' },
      lines,
      card: {
        ...base.proposal.card,
        moneyTodayUsd: 200,
        termMonths: 2,
        expectedReturn: {
          lowPct: 4.5,
          highPct: 4.8,
          basis:
            'A yearly range for the dollar-yield part only. No return is assumed for stocks, crypto and gold.',
          lossInFallUsd: 0,
        },
      },
      flags: FLAGS,
    },
  };
}

const person: Person = {
  userId: USER,
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: [],
};
const shown = async (lang: Lang = 'en') => {
  const host = await mount(withAccount(lang, createElement(PlanScreen, { id: PLAN_ID })));
  await settle();
  await settle();
  return host;
};

beforeEach(() => {
  window.sessionStorage.clear();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
  portStore.setApi(
    serverKeepsPlans(async (path) =>
      path === '/v1/me' ? json(person) : json({ error: 'not found' }, 404),
    ),
  );
});
afterEach(unmountAll);

describe('the plan in plain words', () => {
  it('names each asset as a person reads it, never by its id', () => {
    const name = (id: string) => displayName(id, en.plan);
    expect(name('solana:syrupusdc')).toBe('syrupUSDC (Maple)');
    expect(name('solana:jlusdc')).toBe('jlUSDC (Jupiter Lend)');
    expect(name('solana:usdc')).toBe('Cash (USDC)');
    // a chain's dollar by that chain's name for it: Robinhood Chain's is tUSDG, the mock's stand-in too
    expect(name('robinhood:tusdg')).toBe('Cash (tUSDG)');
    expect(name('robinhood:usdc')).toBe('Cash (tUSDG)');
    expect(name('solana:tusdc')).toBe('Cash (USDC)');
    expect(name('solana:spyx')).toBe('SPYx');
    expect(name('robinhood:tspy')).toBe('SPY');
    expect(name('solana:gold')).toBe('Gold');
    expect(name('solana:somethingnew')).toBe('SOMETHINGNEW');
    expect(displayName('solana:usdc', pt.plan)).toBe('Dinheiro (USDC)');
  });

  it('says every flag the engine writes as a sentence, and one it does not know not at all, never as its code', () => {
    for (const d of [en, pt])
      for (const flag of FLAGS) {
        const said = flagSentence(flag, d.plan, (id) => displayName(id, d.plan));
        if (flag.startsWith('a_code_nobody_wrote_yet')) {
          expect(said).toBeNull();
          continue;
        }
        expect(said, flag).not.toMatch(/[a-z]+_[a-z_]+|solana:|:/);
        expect(said, flag).toMatch(/\.$/);
      }
    expect(
      flagSentence('ceiling_from_tier:solana:syrupusdc', en.plan, (id) => displayName(id, en.plan)),
    ).toBe(en.plan.flagWords.ceilingFromTier('syrupUSDC (Maple)'));
    // a note that says only "the engine noted one more thing" tells nobody anything: it is dropped
    expect(flagSentence('a_code_nobody_wrote_yet', en.plan, String)).toBeNull();
    expect(flagSentences(['a_code_nobody_wrote_yet', 'unplaced'], en.plan, String)).toEqual([
      en.plan.flagWords.simple.unplaced,
    ]);
    expect(kindLabel('dollar_yield', en.plan.kinds)).toBe('Dollar yield');
    expect(kindLabel('dollar-yield', en.plan.kinds)).toBe('Dollar yield');
    expect(kindLabel('something_else', en.plan.kinds)).toBe(en.plan.kinds.other);
  });

  it('renders no engine code anywhere on the page, the closed details included', async () => {
    rememberPlan(small());
    const host = await shown();
    const text = host.textContent ?? '';
    expect(text).not.toMatch(/\b[a-z]+_[a-z_]+(:|\b)/);
    expect(text).not.toMatch(/solana:|robinhood:/);
    expect(text).not.toContain('Risk, as our server rolled it up');
    // the notes and the spread are inside a closed "Details"
    const details = find<HTMLDetailsElement>(host, 'details[data-ui="plan-details"]');
    expect(details.open).toBe(false);
    expect(find(details, 'summary').textContent).toBe(en.plan.details);
    expect(details.textContent).toContain(en.plan.flagWords.ceilingFromTier('syrupUSDC (Maple)'));
    expect(details.textContent).toContain(en.plan.risk.title);
    expect(details.textContent).toContain('Dollar yield');
    // each sentence once, though the roll-up says some again
    const notes = [...details.querySelectorAll('li')].map((li) => li.textContent);
    expect(new Set(notes).size).toBe(notes.length);
  });

  it('says the plan in one sentence at the top, from its lines, with the largest holding’s reason', async () => {
    rememberPlan(small());
    const host = await shown();
    expect(find(host, '[data-ui="plan-summary"]').textContent).toBe(
      '$200 for 2 months, high risk, on Solana: $150 stays in Cash (USDC) and $50 goes to syrupUSDC (Maple). Chosen by its yield after haircut, among the dollar-yield tokens you can hold on Solana.',
    );
  });

  it('says a short or flat plan in a sentence on its pin, instead of a flat chart', async () => {
    // a plan with a yield reading: one with none draws no projection at all
    const plan = small();
    rememberPlan({ ...plan, proposal: { ...plan.proposal, flags: [] } });
    const host = await shown();
    const chart = find(host, '[data-ui="plan-chart"]');
    expect(chart.getAttribute('data-kind')).toBe('short');
    expect(chart.querySelector('[data-ui="case-plot"]')).toBeNull();
    expect(find(chart, 'figcaption').textContent).toContain(
      // $200 at 4.5% to 4.8% a year for 2 months: both ends round to $202, so they are told to the cent
      `${en.plan.short('2 months')}${en.plan.shortRange('$201.50', '$201.60')}`,
    );
    expect(chart.querySelector('[data-ui="figure"]')).not.toBeNull();
  });

  it('says what a bad fall costs in a sentence, and the basis with one full stop', async () => {
    rememberPlan(small());
    const host = await shown();
    expect(find(host, '[data-ui="plan-bad-fall"]').textContent).toBe(en.plan.badFall.none);
    expect(host.textContent).not.toMatch(/\.\./);
    expect(host.textContent).not.toContain('estimate$');
  });

  it('draws one tick per dollar label when two values round the same', async () => {
    const plan = planOn();
    rememberPlan({
      ...plan,
      proposal: {
        ...plan.proposal,
        // $100 for 6 months at up to 2% a year: the middle ($100.50) and the end ($101) both read $101
        sheet: { ...plan.proposal.sheet, amountUsd: 100, horizonMonths: 6 },
        card: {
          ...plan.proposal.card,
          termMonths: 6,
          expectedReturn: { ...plan.proposal.card.expectedReturn, lowPct: 1, highPct: 2 },
        },
      },
    });
    const host = await shown();
    const ticks = [...host.querySelectorAll('[data-ui="plan-chart"] svg text')]
      .map((t) => t.textContent)
      .filter((s) => s?.startsWith('$'));
    expect(ticks).toEqual(['$100', '$101']);
  });

  it('never says USDC on a Robinhood plan: its dollar is tUSDG, in the summary and the legs', async () => {
    const plan = planOn('robinhood', 'sandbox');
    rememberPlan(plan);
    portStore.setApi(
      serverKeepsPlans(async (path) =>
        path === '/v1/me'
          ? json({ ...person, chain: 'robinhood' })
          : json({ error: 'not found' }, 404),
      ),
    );
    const host = await shown();
    expect(find(host, '[data-ui="plan-summary"]').textContent).toContain('Cash (tUSDG)');
    expect(host.textContent).not.toMatch(/usdc/i);
  });

  it('is plain in Portuguese too', async () => {
    rememberPlan(small());
    const host = await shown('pt');
    expect(host.textContent).not.toMatch(/\b[a-z]+_[a-z_]+(:|\b)/);
    expect(find(host, 'details summary').textContent).toBe(pt.plan.details);
    expect(find(host, '[data-ui="plan-summary"]').textContent).toContain('Dinheiro (USDC)');
  });
});
