// @vitest-environment happy-dom
import type { BasketLine } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { PlanScreen } from './PlanScreen';
import { bindingReason, leftOut, planSummary, reasonsOf } from './plain';
import { rememberPlan, type StoredPlan } from './plan-store';
import { PLAN_ID, planOn, USER } from './test/fixtures';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// Thom's own test buy (Oct 6): $80,000 for $300 a month, built as 25% syrupUSDC and 75% cash, and a
// page that said "starting share of dollar yield is 100%" beside it. A line is explained by the reason
// that decided it (the cap that binds), what was left out is said, and the goal says its income.

const en = dictionary('en');
const reason = (rule: string, text: string, params: Record<string, string | number> = {}) => ({
  rule,
  inputs: [],
  params,
  text,
});
const SLEEVE = reason(
  'SLEEVE',
  'A plan to earn income at low risk starts with 100% in dollar yield.',
  { shareBps: 10_000 },
);
const CREDIT = reason(
  'CREDIT_BUDGET_UNSAID',
  'No more than 25% of the plan in tokens that lend to borrowers or trade a spread: you have not said how much credit risk you accept, and this is the limit until you do. Those tokens together are at that limit.',
  { capBps: 2500 },
);
const BY_YIELD = reason(
  'BY_YIELD',
  'Chosen by its yield after haircut, among the dollar-yield tokens you can hold on Solana.',
);
const UNPLACED = reason(
  'UNPLACED',
  '$60,000 stays in cash: no token you can hold has room for it at this size.',
  { usd: 60_000 },
);
const NEAR = reason('CASH_NEAR_DATE', 'Cash is kept for what you need soon.');
const NO_YIELD =
  'jlUSDC is left out: there is no yield reading for it, and the plan never counts a missing yield as zero.';

function income(): StoredPlan {
  const base = planOn('solana', 'sandbox');
  const lines: BasketLine[] = [
    {
      chain: 'solana',
      assetId: 'solana:syrupusdc',
      weightBps: 2500,
      amountUsd: 20_000,
      reasons: [SLEEVE, BY_YIELD, CREDIT],
    },
    {
      chain: 'solana',
      assetId: 'solana:usdc',
      weightBps: 7500,
      amountUsd: 60_000,
      reasons: [NEAR, UNPLACED],
    },
  ];
  return {
    ...base,
    proposal: {
      ...base.proposal,
      sheet: {
        ...base.proposal.sheet,
        goal: 'income',
        amountUsd: 80_000,
        horizonMonths: 12,
        risk: 'low',
        incomeTargetUsdMonthly: 300,
      },
      lines,
      removed: [{ ref: 'solana:jlusdc', reasons: [reason('NO_YIELD', NO_YIELD)] }],
      flags: ['unplaced'],
      verdict: { met: false, gapUsdMonthly: 228.23, ways: [] },
      card: { ...base.proposal.card, moneyTodayUsd: 80_000, termMonths: 12, cashFlow: 'monthly' },
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
const shown = async () => {
  const host = await mount(withAccount('en', createElement(PlanScreen, { id: PLAN_ID })));
  await settle();
  await settle();
  return host;
};

beforeEach(() => {
  window.sessionStorage.clear();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
  portStore.setApi(async (path) =>
    path === '/v1/me' ? json(person) : json({ error: 'not found' }, 404),
  );
});
afterEach(unmountAll);

describe('why a plan holds what it holds', () => {
  it('is the reason that decided the line: the cap that binds, not the share it started from', () => {
    const [syrup, cash] = income().proposal.lines as [BasketLine, BasketLine];
    expect(bindingReason(syrup)?.rule).toBe('CREDIT_BUDGET_UNSAID');
    expect(bindingReason(cash)?.rule).toBe('UNPLACED');
    expect(reasonsOf(syrup)[0]).toBe(CREDIT.text);
    // every reason is still there, each once
    expect(reasonsOf(syrup)).toEqual([CREDIT.text, SLEEVE.text, BY_YIELD.text]);
    // with no cap, how it was chosen; with only where it started, that
    expect(bindingReason({ ...syrup, reasons: [SLEEVE, BY_YIELD] })?.rule).toBe('BY_YIELD');
    expect(bindingReason({ ...syrup, reasons: [SLEEVE] })?.rule).toBe('SLEEVE');
    expect(bindingReason({ ...syrup, reasons: [] })).toBeUndefined();
    for (const rule of ['ASSET_CAP', 'ISSUER_CAP_PLAN', 'EXIT_CEILING', 'TIER_CEILING'])
      expect(bindingReason({ ...syrup, reasons: [SLEEVE, reason(rule, 'x')] })?.rule).toBe(rule);
  });

  it('says the plan in one sentence that never states a share its lines contradict', () => {
    const { proposal } = income();
    const summary = planSummary(proposal, en, 'en', 'Solana');
    expect(summary).toBe(
      `$80,000 for 12 months, low risk, on Solana: $60,000 stays in Cash (USDC) and $20,000 goes to syrupUSDC (Maple). ${CREDIT.text} ${UNPLACED.text}`,
    );
    expect(summary).not.toContain('100%');
    // every share the sentence states is the share of one of the plan's lines
    const shares = proposal.lines.map((l) => l.weightBps / 100);
    const stated = [...summary.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
    expect(stated.length).toBeGreaterThan(0);
    for (const pct of stated) expect(shares, `${pct}%`).toContain(pct);
    // and every dollar amount is a line's, or the whole
    const amounts = [...summary.matchAll(/\$([\d,]+)/g)].map((m) =>
      Number(m[1]?.replace(/,/g, '')),
    );
    for (const usd of amounts)
      expect([80_000, ...proposal.lines.map((l) => l.amountUsd)], `$${usd}`).toContain(usd);
  });

  it('shows on the page the goal with its income, the binding reason on each leg, and what was left out', async () => {
    rememberPlan(income());
    const host = await shown();
    expect(find(host, 'h1').textContent).toBe('Earn $300 a month from $80,000 for 12 months.');
    expect(find(host, '[data-ui="plan-summary"]').textContent).not.toContain('100%');
    const legs = find(host, '[data-ui="plan-legs"]').textContent ?? '';
    expect(legs).toContain(CREDIT.text);
    expect(legs).toContain(UNPLACED.text);
    expect(legs).not.toContain(SLEEVE.text);
    // in Details: what the engine left out, in its own sentence, and why money stayed in cash, once
    const details = find(host, 'details[data-ui="plan-details"]');
    expect(find(details, '[data-ui="plan-left-out"] h3').textContent).toBe(en.plan.leftOut);
    expect(find(details, '[data-ui="plan-left-out"] li').textContent).toBe(NO_YIELD);
    expect(leftOut(income().proposal)).toEqual([NO_YIELD]);
    expect(details.textContent).toContain(UNPLACED.text);
    expect(details.textContent).not.toContain(en.plan.flagWords.simple.unplaced);
    expect(details.textContent?.split(UNPLACED.text)).toHaveLength(2);
    // no id and no plate
    expect(host.textContent).not.toMatch(/solana:|MOCK/);
  });

  it('keeps the general note for money not placed when no line says why', async () => {
    const plan = income();
    const [syrup, cash] = plan.proposal.lines as [BasketLine, BasketLine];
    rememberPlan({
      ...plan,
      proposal: { ...plan.proposal, lines: [syrup, { ...cash, reasons: [NEAR] }], removed: [] },
    });
    const host = await shown();
    const details = find(host, 'details[data-ui="plan-details"]');
    expect(details.textContent).toContain(en.plan.flagWords.simple.unplaced);
    expect(details.querySelector('[data-ui="plan-left-out"]')).toBeNull();
  });
});
