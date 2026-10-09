// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { click, find, fire, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { inLanguage } from '../account/test/screen';
import { PlanPane } from './PlanPane';
import { AssetMark } from './PlanView';
import type { StoredPlan } from './plan-store';
import { planOn } from './test/fixtures';

// The plan as a picture, by the kind of goal (Thom, Oct 7: "the plan on the side panel could be more
// visual"): what the headline is, what is drawn, and that every figure drawn is one the engine gave.

const en = dictionary('en');
const pane = async (plan: StoredPlan, lang: 'en' | 'pt' = 'en') => {
  const host = await mount(
    inLanguage(lang, createElement(PlanPane, { plan, chain: 'solana', level: 3 })),
  );
  await settle();
  return host;
};
const answer = (host: HTMLElement) => find(host, '[data-ui="plan-answer"]').textContent ?? '';
const width = (el: Element | null) => (el as HTMLElement | null)?.style.width;
const ROLL_UP: NonNullable<StoredPlan['rollUp']> = {
  byIssuer: [{ key: 'issuer one', bps: 6000 }],
  byChain: [{ key: 'solana', bps: 10_000 }],
  byClass: [
    { key: 'gold', bps: 3500 },
    { key: 'stock', bps: 6000 },
    { key: 'cash', bps: 500 },
  ],
  flags: [],
  exit: { quotedBps: null, quotedAt: null, measuredWorstBps: 42, measuredShareBps: 6000 },
};
/** The fixture's plan with another goal, and what an income plan asks and pays. */
const of = (
  goal: 'grow' | 'income' | 'protect',
  over: (p: StoredPlan['proposal']) => Partial<StoredPlan['proposal']> = () => ({}),
): StoredPlan => {
  const base = planOn();
  const proposal = { ...base.proposal, sheet: { ...base.proposal.sheet, goal } };
  return { ...base, rollUp: ROLL_UP, proposal: { ...proposal, ...over(proposal) } };
};
afterEach(unmountAll);

describe('a plan to grow', () => {
  it('leads with what it is in and what a bad fall could cost, never with a yield range', async () => {
    const host = await pane(of('grow'));
    // 60% stocks by the roll-up, and the engine's own bad-fall figure
    expect(answer(host)).toBe(en.plan.answer.inFall('60%', 'stocks', '$4,000'));
    expect(answer(host)).toBe('60% in stocks · in a bad fall about −$4,000');
    expect(answer(host)).not.toMatch(/a year|%.*to.*%/);
    // the yield is kept small, with its pin, since the plan has a part that pays one
    const small = find(host, '[data-ui="plan-yield"]');
    expect(small.textContent).toContain('1.00% to 2.00% a year');
    expect(small.querySelector('[data-ui="pin"]')).not.toBeNull();
  });

  it('names the largest holding where the plan came with no spread', async () => {
    const host = await pane({ ...of('grow'), rollUp: null });
    expect(answer(host)).toBe(en.plan.answer.inFall('60%', 'SPYx', '$4,000'));
  });

  it('draws the bad fall as a bar against what goes in, and no curve', async () => {
    const host = await pane(of('grow'));
    // $4,000 of $40,000
    expect(width(find(host, '[data-ui="plan-fall-loss"]'))).toBe('10%');
    expect(find(host, '[data-ui="plan-bad-fall"]').textContent).toBe(
      en.plan.badFall.some('$4,000'),
    );
    expect(find(host, '[data-ui="plan-fall"]').textContent).toContain('$40,000');
    expect(host.querySelector('[data-ui="plan-chart"]')).toBeNull();
    expect(host.querySelector('[data-ui="case-plot"], figure svg')).toBeNull();
    // no promise in any of it
    expect(host.textContent).not.toMatch(/guarantee|will earn|will pay/i);
  });

  it('says no loss is counted where the engine counts none, and keeps no yield line with no reading', async () => {
    const host = await pane(
      of('grow', (p) => ({
        flags: ['yield_not_read'],
        card: { ...p.card, expectedReturn: { ...p.card.expectedReturn, lossInFallUsd: 0 } },
      })),
    );
    expect(answer(host)).toBe(en.plan.answer.inNoFall('60%', 'stocks'));
    expect(width(find(host, '[data-ui="plan-fall-loss"]'))).toBe('0%');
    expect(host.querySelector('[data-ui="plan-yield"]')).toBeNull();
  });
});

describe('a goal with no date', () => {
  it('shows no months it was built over under the bad-fall bar (GLIDE-OPT-IN)', async () => {
    const host = await pane(of('grow', (p) => ({ sheet: { ...p.sheet, horizonOpen: true } })));
    const fall = find(host, '[data-ui="plan-fall"]').textContent ?? '';
    expect(fall).toContain(en.plan.fall.putOpen('$40,000'));
    expect(fall).toContain(en.goal.card.noDate);
    expect(fall).not.toMatch(/36|months/);
  });
});

describe('the risk panel under a plan', () => {
  it('puts what selling costs, as measured, on the pin of the plan’s reading, and says not measured where it is not', async () => {
    const measured = (host: HTMLElement) =>
      [...host.querySelectorAll('dt')].find((dt) => dt.textContent === en.plan.risk.exitMeasured)
        ?.nextElementSibling as HTMLElement;
    const host = await pane(of('grow'));
    expect(measured(host).textContent).toContain('0.42%');
    expect(measured(host).querySelector('[data-ui="figure"] [data-ui="pin"]')).not.toBeNull();
    await unmountAll();
    const none = await pane({
      ...of('grow'),
      rollUp: { ...ROLL_UP, exit: { ...ROLL_UP.exit, measuredWorstBps: null } },
    });
    expect(measured(none).textContent).toBe(en.plan.risk.notMeasured);
  });
});

describe('a plan to protect', () => {
  it('leads with what most of it is kept in and the bad-fall figure, with the bar and no curve', async () => {
    const plan = of('protect');
    const host = await pane({
      ...plan,
      rollUp: {
        ...ROLL_UP,
        byClass: [
          { key: 'dollar_yield', bps: 7000 },
          { key: 'gold', bps: 3000 },
        ],
      },
    });
    expect(answer(host)).toBe('70% in dollar yield · in a bad fall about −$4,000');
    expect(host.querySelector('[data-ui="plan-fall"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="plan-chart"]')).toBeNull();
    expect(host.querySelector('[data-ui="plan-monthly"]')).toBeNull();
  });
});

describe('a plan for income', () => {
  const income = (met: boolean) =>
    of('income', (p) => ({
      sheet: { ...p.sheet, incomeTargetUsdMonthly: 100 },
      card: { ...p.card, cashFlow: 'monthly' as const },
      verdict: { met, gapUsdMonthly: met ? 0 : 33.4, ways: [] },
    }));

  it('shows what it pays a month against what was asked: solid to the low end, lighter on to the high end', async () => {
    const host = await pane(income(false));
    expect(answer(host)).toBe(en.plan.verdict.gap('$33.40'));
    const meter = find(host, '[data-ui="plan-income-meter"]');
    // $40,000 at 1% to 2% a year: $33 to $67 a month, against $100 asked
    expect(find(meter, '[data-ui="plan-monthly"]').textContent).toContain(
      en.plan.monthly.figure('$33', '$67'),
    );
    expect(meter.querySelector('[data-ui="plan-monthly"] [data-ui="pin"]')).not.toBeNull();
    expect(meter.textContent).toContain(en.plan.income.asked('$100'));
    // the low end, which the verdict is measured on, is the solid part; the rest runs to the high end
    const low = Number.parseFloat(width(find(meter, '[data-ui="income-low"]')) ?? '');
    const high = Number.parseFloat(width(find(meter, '[data-ui="income-high"]')) ?? '');
    expect(low).toBeCloseTo(33.33, 1);
    expect(low + high).toBeCloseTo(66.67, 1);
    expect(meter.getAttribute('data-reached')).toBe('false');
    // an estimate, never what the plan pays
    expect(meter.textContent).toContain(en.plan.monthly.after);
    // the yield is not said again as a line of its own
    expect(host.querySelector('[data-ui="plan-yield"]')).toBeNull();
  });

  it('never reads full under a headline that says there is a gap (the review’s case: $50 asked, $16.60 short)', async () => {
    const plan = income(false);
    const host = await pane({
      ...plan,
      proposal: {
        ...plan.proposal,
        sheet: { ...plan.proposal.sheet, incomeTargetUsdMonthly: 50 },
        verdict: { met: false, gapUsdMonthly: 16.6, ways: [] },
      },
    });
    expect(answer(host)).toBe(en.plan.verdict.gap('$16.60'));
    const meter = find(host, '[data-ui="plan-income-meter"]');
    // the high end ($67) is past the $50 asked; the solid part stops at the low end ($33)
    const low = Number.parseFloat(width(find(meter, '[data-ui="income-low"]')) ?? '');
    const high = Number.parseFloat(width(find(meter, '[data-ui="income-high"]')) ?? '');
    expect(low).toBeCloseTo(66.67, 1);
    expect(low + high).toBe(100);
    expect(meter.getAttribute('data-reached')).toBe('false');
  });

  it('is solid to the end only where the engine says the income is met, whatever the page rounds to', async () => {
    const plan = income(true);
    const met = await pane({
      ...plan,
      proposal: { ...plan.proposal, sheet: { ...plan.proposal.sheet, incomeTargetUsdMonthly: 30 } },
    });
    expect(width(find(met, '[data-ui="income-low"]'))).toBe('100%');
    expect(find(met, '[data-ui="plan-income-meter"]').getAttribute('data-reached')).toBe('true');
    await unmountAll();
    // the low end works out past the ask here, and the engine still says a gap: not solid to the end
    const short = income(false);
    const host = await pane({
      ...short,
      proposal: {
        ...short.proposal,
        sheet: { ...short.proposal.sheet, incomeTargetUsdMonthly: 30 },
      },
    });
    expect(width(find(host, '[data-ui="income-low"]'))).toBe('98%');
  });

  it('draws what is paid out over the months as a projected band, on the yield’s pin', async () => {
    const chart = find(await pane(income(true)), '[data-ui="plan-chart"]');
    expect(chart.getAttribute('data-kind')).toBe('paid');
    expect(chart.querySelector('svg path')).not.toBeNull();
    expect(chart.querySelectorAll('svg line[stroke-dasharray]')).toHaveLength(2);
    // $40,000 for 36 months at 1% to 2% a year
    expect(find(chart, '[data-ui="figure"]').textContent).toContain('$1,200 – $2,400');
    expect(chart.querySelector('[data-ui="pin"]')).not.toBeNull();
    expect(chart.textContent).toContain(en.plan.chart.projected);
  });

  it('has no meter and no band when the yield has no reading', async () => {
    const plan = income(false);
    const host = await pane({
      ...plan,
      proposal: { ...plan.proposal, flags: ['yield_not_read'] },
    });
    expect(host.querySelector('[data-ui="plan-income-meter"]')).toBeNull();
    expect(host.querySelector('[data-ui="plan-chart"]')).toBeNull();
  });
});

describe('the allocation, as the picture', () => {
  it.each(['jlusdc', 'syrupusdc', 'paxg'])(
    'uses real local PNG artwork for native and test %s asset identities',
    async (token) => {
      const bytes = readFileSync(`apps/web/public/assets/tokens/${token}.png`);
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(bytes.readUInt32BE(16)).toBeGreaterThan(0);
      expect(bytes.readUInt32BE(20)).toBeGreaterThan(0);
      for (const asset of [`solana:${token}`, `solana:t${token}`]) {
        const host = await mount(createElement(AssetMark, { asset }));
        const mark = find(host, '[data-ui="asset-mark"]');
        expect(find(mark, 'img').getAttribute('src')).toBe(`/assets/tokens/${token}.png`);
        expect(mark.textContent).toBe('');
      }
    },
  );

  it('keeps asset names available when a local logo fails, without changing allocation controls', async () => {
    const host = await mount(createElement(AssetMark, { asset: 'solana:tjlusdc' }));
    const mark = find(host, '[data-ui="asset-mark"]');
    const image = find(mark, 'img');
    expect(image.getAttribute('src')).toBe('/assets/tokens/jlusdc.png');
    expect(image.getAttribute('alt')).toBe('');
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    await fire(image, new Event('error'));
    expect(mark.querySelector('img')).toBeNull();
    expect(mark.textContent).toBe('jlU');
  });

  it('draws one bar as a picture, a part per holding by its share, with a label to press under each', async () => {
    const host = await pane(of('grow'));
    const bar = find(host, '[data-ui="plan-bar"]');
    const picture = find(bar, '[role="img"]');
    // the picture is said once in words, and nothing in it can be pressed or focused
    expect(picture.getAttribute('aria-label')).toBe('SPYx, 60%; GLDx, 35%; Cash (USDC), 5%');
    expect(picture.querySelector('button, a, [tabindex]')).toBeNull();
    expect(picture.style.gridTemplateColumns).toBe('6000fr 3500fr 500fr');
    const parts = [...picture.querySelectorAll('[data-part]')];
    // the warm ramp, in order; nothing blue or violet
    expect(parts.map((p) => p.className.match(/bg-leg-\d/)?.[0])).toEqual([
      'bg-leg-1',
      'bg-leg-2',
      'bg-leg-3',
    ]);
    // a part too thin for its mark is plain: 5% of a phone's bar is under 24px
    expect(
      parts.map((p) => p.querySelector('[data-ui="asset-mark"] img')?.getAttribute('src') ?? null),
    ).toEqual(['/assets/tokens/spyx.png', '/assets/tokens/gldx.png', null]);
    // every holding has a label under the bar, a real target with its mark, name and share
    const labels = [...bar.querySelectorAll('[data-ui="plan-labels"] button')];
    expect(labels.map((l) => l.getAttribute('aria-label'))).toEqual([
      'SPYx, 60%',
      'GLDx, 35%',
      'Cash (USDC), 5%',
    ]);
    for (const label of labels) {
      expect(label.className).toMatch(/min-h-8 min-w-8/);
      expect(label.className).toContain('focus-visible:outline-2');
      expect(label.querySelector('[data-ui="asset-mark"]')).not.toBeNull();
    }
    expect(labels[2]?.textContent).toContain('5%');
    // it settles in as the plan arrives, only where motion is wanted
    for (const part of parts) expect(part.className).toContain('motion-safe:animate-seat');
    expect(bar.innerHTML).not.toMatch(/(?<!motion-safe:)animate-/);
  });

  it('lights the part and the row of the label that is focused, pointed at or pressed, the thin one too', async () => {
    const host = await pane(of('grow'));
    for (const asset of ['solana:gldx', 'solana:usdc']) {
      const label = find(host, `[data-ui="plan-labels"] button[data-label^="${asset}"]`);
      const row = () => find(host, `[data-ui="plan-rows"] [data-row^="${asset}"]`);
      const part = () => find(host, `[data-ui="plan-bar"] [data-part^="${asset}"]`);
      const lit = () => [row().getAttribute('data-lit'), part().getAttribute('data-lit')];
      expect(lit()).toEqual([null, null]);
      await click(label);
      expect(lit()).toEqual(['true', 'true']);
      expect(label.getAttribute('aria-pressed')).toBe('true');
      expect(host.querySelectorAll('[data-row][data-lit]')).toHaveLength(1);
      await click(label);
      expect(lit()).toEqual([null, null]);
      // the keyboard does what the pointer does
      await fire(label, new FocusEvent('focusin', { bubbles: true }));
      expect(lit()).toEqual(['true', 'true']);
      await fire(label, new FocusEvent('focusout', { bubbles: true }));
      expect(lit()).toEqual([null, null]);
      const over = () =>
        new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body });
      const out = () => new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body });
      for (const el of [label, part(), row()]) {
        await fire(el, over());
        expect(lit()).toEqual(['true', 'true']);
        await fire(el, out());
        expect(lit()).toEqual([null, null]);
      }
    }
  });

  it('has one line a holding, with the reason closed under "Why this share"', async () => {
    const host = await pane(of('grow'));
    const rows = [...host.querySelectorAll('[data-ui="plan-rows"] [data-row]')];
    expect(rows).toHaveLength(3);
    const gold = rows[1] as HTMLElement;
    expect(gold.textContent).toContain('GLDx');
    expect(gold.textContent).toContain('35%');
    expect(gold.textContent).toContain('$14,000');
    const fold = find<HTMLDetailsElement>(gold, 'details[data-ui="row-why"]');
    expect(fold.open).toBe(false);
    expect(find(fold, 'summary').textContent).toBe(en.plan.whyShare);
    expect(fold.textContent).toContain('Gold steadies the plan.');
    // a holding with no reason has no fold, and a plan's lines carry no yield of their own
    expect(rows[0]?.querySelector('details')).toBeNull();
    expect(host.querySelector('[data-ui="row-yield"]')).toBeNull();
  });
});

describe('the way out, as a meter', () => {
  it('fills the meter with the pinned exit cost against 1%, and says how fast', async () => {
    const exit = find(await pane(of('grow')), '[data-ui="exit-plan-line"]');
    // 30 basis points of the 100 a full bar stands for
    expect(width(exit.querySelector('[data-ui="meter"] span'))).toBe('30%');
    expect(find(exit, '[data-ui="figure"]').textContent).toContain('≤ 0.3%');
    expect(exit.querySelector('[data-ui="pin"]')).not.toBeNull();
    expect(exit.textContent).toContain('up to $40,000 within a day');
    expect(exit.textContent).toContain(en.plan.exitScale);
    // one sentence under it: tokens out at any time, selling to cash not offered yet
    expect(exit.textContent).toContain(en.plan.inKind);
    expect(exit.querySelectorAll('p')).toHaveLength(1);
  });

  it('shows an empty meter and "not measured yet" once where no cost is measured, never a zero', async () => {
    const exit = find(
      await pane(
        of('grow', (p) => ({ card: { ...p.card, exit: { ...p.card.exit, costBps: null } } })),
      ),
      '[data-ui="exit-plan-line"]',
    );
    const meter = find(exit, '[data-ui="meter"]');
    expect(meter.getAttribute('data-empty')).toBe('true');
    expect(width(meter.querySelector('span'))).toBe('0%');
    expect(exit.textContent?.split(en.plan.exitUnmeasured)).toHaveLength(2);
    expect(exit.querySelector('[data-ui="figure"]')).toBeNull();
    expect(exit.textContent).not.toMatch(/0(\.0+)?%/);
  });
});

describe('the pane in Portuguese', () => {
  it('says the headline and the fold in Portuguese', async () => {
    const pt = dictionary('pt');
    const host = await pane(of('grow'), 'pt');
    expect(answer(host)).toMatch(/^60% em ações · numa queda forte, cerca de −US\$\s4\.000$/);
    expect(answer(host)).toContain(pt.plan.answer.inFall('60%', 'ações', '').trim());
    expect(host.textContent).toContain(pt.plan.whyShare);
  });
});
