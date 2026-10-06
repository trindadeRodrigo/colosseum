// @vitest-environment happy-dom
import type { PlanCandidateId, PlanScorecard, PlanStatus } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonClass } from '../../components/ui/button-class';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { PlanScreen } from './PlanScreen';
import { rememberChoice, rememberPlan, type StoredPlan } from './plan-store';
import { planOn, USER } from './test/fixtures';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The candidates of one goal on the plan screen, with real events (gate THREE-PLANS, CANDIDATE-NAMES):
// in the fixed order, none picked and none marked; each with what it holds, what it is compared on and
// its status; the ones not shown with why; and the buy, off until the person picks one, then naming
// that candidate's own id.

const en = dictionary('en');
const pt = dictionary('pt');
const KEY = 'a1b2c3d4-0000-4000-8000-000000000001';
const IDS: Record<PlanCandidateId, string> = {
  cover: '1c0a7e3b-5d2f-4a6b-8c9d-0e1f2a3b4c5d',
  spread: '2d1b8f4c-6e3a-4b7c-9d0e-1f2a3b4c5d6e',
  carry: '3e2c9a5d-7f4b-4c8d-8e1f-2a3b4c5d6e7f',
};

const scorecard = (over: Partial<PlanScorecard> = {}): PlanScorecard => ({
  monthsCovered: 6,
  base: { monthsPaid: 10, monthsWithWithdrawal: 12, shortfall: 1200 },
  stresses: [{ id: 'yields_fall', monthsPaid: 8, shortfall: 2400 }],
  carryObservedBps: 410,
  exit: { costBps: 35, measuredShareBps: 6000 },
  concentration: {
    byIssuer: [{ key: 'one', bps: 6000 }],
    byClass: [{ key: 'dollar-yield', bps: 10_000 }],
    largestIssuerBps: 6000,
    issuers: 2,
  },
  creditBasisBps: 1250,
  ...over,
});
const status = (over: Partial<PlanStatus> = {}): PlanStatus => ({
  observedOn: '2026-10-05',
  base: { monthsPaid: 10, monthsWithWithdrawal: 12, shortfall: 1200 },
  stresses: [
    {
      id: 'yields_fall',
      params: { fallBps: 5000 },
      monthsPaid: 8,
      monthsWithWithdrawal: 12,
      shortfall: 2400,
    },
  ],
  carryObservedBps: 410,
  carryNeededBps: 620,
  met: false,
  ways: [{ change: 'Put in $5,000 more.', closesGap: true }],
  ...over,
});

function candidate(name: PlanCandidateId, over: Partial<StoredPlan['candidate']> = {}): StoredPlan {
  return {
    ...planOn('solana', 'sandbox'),
    id: IDS[name],
    candidate: { name, scorecard: scorecard(), status: status(), ...over },
  };
}

function keep(plans: StoredPlan[], notShown: { candidate: PlanCandidateId; why: string }[] = []) {
  for (const p of plans) rememberPlan(p);
  rememberChoice({ key: KEY, userId: USER, ids: plans.map((p) => p.id), notShown });
}

const person: Person = {
  userId: USER,
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: [],
};

const shown = async (lang: Lang = 'en') => {
  const host = await mount(withAccount(lang, createElement(PlanScreen, { id: KEY })));
  await settle();
  await settle();
  return host;
};
const cards = (host: HTMLElement) => [...host.querySelectorAll('section[data-candidate]')];
const radios = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
];
const primaries = (host: HTMLElement) =>
  [...host.querySelectorAll('a, button')].filter(
    (el) =>
      el.className.includes(buttonClass({ variant: 'primary' })) ||
      el.className.includes(buttonClass({ variant: 'primary', disabled: true })),
  );

beforeEach(() => {
  window.sessionStorage.clear();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
  portStore.setApi(async (path) =>
    path === '/v1/me' ? json(person) : json({ error: 'not found' }, 404),
  );
});
afterEach(async () => {
  await unmountAll();
});

describe('the candidates on the plan screen', () => {
  it('are side by side in the order Cover, Spread, Carry, none picked and none marked', async () => {
    keep([candidate('cover'), candidate('spread'), candidate('carry')]);
    const host = await shown();
    expect(find(host, 'h1').textContent).toBe(en.plan.choice.title);
    expect(cards(host).map((c) => c.getAttribute('data-candidate'))).toEqual([
      'cover',
      'spread',
      'carry',
    ]);
    expect(cards(host).map((c) => c.querySelector('h2')?.textContent)).toEqual([
      'Cover',
      'Spread',
      'Carry',
    ]);
    // nothing chosen for the person, and nothing that reads as advice
    expect(radios(host).map((r) => r.checked)).toEqual([false, false, false]);
    expect(host.textContent).not.toMatch(/best|recommend|suggested|popular/i);
    // the one primary is the buy, off until a plan is picked, and it says why
    expect(primaries(host)).toHaveLength(1);
    const off = find<HTMLButtonElement>(host, 'button[aria-disabled="true"]');
    expect(off.textContent).toBe(en.plan.buy);
    expect(find(host, `#${off.getAttribute('aria-describedby')}`).textContent).toBe(
      en.plan.choice.picker.none,
    );
  });

  it('buys the candidate the person picks, by that candidate’s own stored id', async () => {
    keep([candidate('cover'), candidate('spread'), candidate('carry')]);
    const host = await shown();
    await click(radios(host)[1] as HTMLInputElement);
    let buy = find<HTMLAnchorElement>(host, 'a[href$="/buy"]');
    expect(buy.textContent).toBe(en.plan.choice.picker.buy('Spread'));
    expect(buy.getAttribute('href')).toBe(`/plan/${IDS.spread}/buy`);
    await click(radios(host)[2] as HTMLInputElement);
    buy = find<HTMLAnchorElement>(host, 'a[href$="/buy"]');
    expect(buy.getAttribute('href')).toBe(`/plan/${IDS.carry}/buy`);
    expect(primaries(host)).toHaveLength(1);
    // each card also leads to its plan in full
    expect(
      [...host.querySelectorAll('section[data-candidate] a')].map((a) => a.getAttribute('href')),
    ).toEqual([`/plan/${IDS.cover}`, `/plan/${IDS.spread}`, `/plan/${IDS.carry}`]);
  });

  it('shows each one’s withdrawals: paid now and under each stress, carry needed beside observed, and the ways', async () => {
    keep([
      candidate('cover', { status: status({ met: true, ways: [], carryNeededBps: 0 }) }),
      candidate('spread', {
        status: status({
          carryNeededBps: null,
          noAmountCloses: 'No larger amount pays every withdrawal.',
        }),
      }),
      candidate('carry'),
    ]);
    const host = await shown();
    const [cover, spread, carry] = cards(host) as HTMLElement[];
    expect(cover?.textContent).toContain(en.plan.choice.status.met);
    expect(cover?.textContent).toContain(en.plan.choice.status.neededNone('4.1%'));
    expect(cover?.textContent).not.toContain(en.plan.choice.status.ways);
    expect(spread?.textContent).toContain(en.plan.choice.status.neededOut('4.1%'));
    expect(spread?.textContent).toContain('No larger amount pays every withdrawal.');
    expect(carry?.textContent).toContain(en.plan.choice.status.notMet);
    expect(carry?.textContent).toContain(en.plan.choice.status.needed('6.2%', '4.1%'));
    expect(carry?.textContent).toContain(en.plan.choice.status.observedOn('Oct 5, 2026'));
    expect(carry?.textContent).toContain('Put in $5,000 more.');
    // the comparison, the stress named with its size, each figure on a pin
    const rows = [...(carry?.querySelectorAll('[data-ui="candidate-score"] > div') ?? [])].map(
      (r) => [r.querySelector('dt')?.textContent, r.querySelector('dd')?.textContent],
    );
    expect(rows.map(([term]) => term)).toEqual([
      en.plan.choice.score.covered,
      en.plan.choice.score.paidNow,
      en.plan.choice.score.paidUnder(en.plan.choice.stress.yields_fall('50%')),
      en.plan.choice.score.carry,
      en.plan.choice.score.exit,
      en.plan.choice.score.issuer,
      en.plan.choice.score.credit,
    ]);
    expect(rows[1]?.[1]).toContain('10 of 12');
    expect(rows[2]?.[1]).toContain('8 of 12');
    for (const row of carry?.querySelectorAll('[data-ui="candidate-score"] > div') ?? [])
      if (/Yield observed|Cost to sell|Months/.test(row.textContent ?? ''))
        expect(row.querySelector('[data-ui="figure"]'), row.textContent ?? '').not.toBeNull();
  });

  it('lists the ones not shown, each with why', async () => {
    keep(
      [candidate('cover'), candidate('carry')],
      [{ candidate: 'spread', why: 'Spread holds the same as Carry.' }],
    );
    const host = await shown();
    expect(cards(host)).toHaveLength(2);
    expect(find(host, 'li[data-candidate="spread"]').textContent).toBe(
      'Spread: Spread holds the same as Carry.',
    );
  });

  it('says once, quietly, on each card that its figures are samples on a test network, with no plate', async () => {
    keep([candidate('cover'), candidate('spread'), candidate('carry')]);
    const host = await shown();
    expect(cards(host).map((c) => c.querySelector('[data-ui="sample-line"]')?.textContent)).toEqual(
      Array(3).fill(en.plan.choice.sample.sandbox),
    );
    for (const card of cards(host))
      expect(
        card.querySelector(':scope > [data-ui="mock-plate"], :scope > .tf-mock-plate'),
      ).toBeNull();
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('leads each card with a sentence and three figures at most, and keeps the rest in a closed Details', async () => {
    keep([candidate('cover'), candidate('spread'), candidate('carry')]);
    const host = await shown();
    for (const card of cards(host)) {
      expect(card.querySelector('[data-ui="candidate-summary"]')?.textContent).toMatch(
        /^\$40,000 for 36 months, medium risk, on Solana: \$24,000 goes to SPYx/,
      );
      const headline = card.querySelectorAll('[data-ui="candidate-headline"] > div');
      expect(headline.length).toBeLessThanOrEqual(3);
      const details = card.querySelector<HTMLDetailsElement>(
        'details[data-ui="candidate-details"]',
      );
      expect(details?.open).toBe(false);
      expect(details?.querySelector('[data-ui="candidate-score"]')).not.toBeNull();
    }
    // the worst case in words: the stress that pays the fewest months
    expect(cards(host)[2]?.querySelector('[data-ui="candidate-headline"]')?.textContent).toContain(
      en.plan.choice.headline.worstMonths(en.plan.choice.stress.yields_fall('50%'), 8, 12),
    );
    // no engine code and no id on the page
    expect(host.textContent).not.toMatch(/\b[a-z]+_[a-z_]+(:|\b)|solana:/);
  });

  it('keeps the picker in reach on a phone: held at the foot while the plans stack', async () => {
    keep([candidate('cover'), candidate('spread'), candidate('carry')]);
    const host = await shown();
    const picker = find(host, '[data-ui="plan-picker"]');
    expect(picker.className).toMatch(/max-md:sticky/);
    expect(picker.className).toMatch(/max-md:bottom-0/);
    expect(find(picker, 'legend').textContent).toBe(en.plan.choice.picker.legend);
  });

  it('names them in Portuguese, in the same order', async () => {
    keep([candidate('cover'), candidate('spread'), candidate('carry')]);
    const host = await shown('pt');
    expect(cards(host).map((c) => c.querySelector('h2')?.textContent)).toEqual([
      'Cobertura',
      'Diversificação',
      'Rendimento',
    ]);
    expect(pt.plan.choice.names).toEqual({
      cover: 'Cobertura',
      spread: 'Diversificação',
      carry: 'Rendimento',
    });
  });

  it('shows no choice that is another person’s, or that misses a plan', async () => {
    keep([candidate('cover'), candidate('spread'), candidate('carry')]);
    window.sessionStorage.removeItem(`tf-plan:${IDS.spread}`);
    let host = await shown();
    expect(host.textContent).toContain(en.plan.missing.title);
    await unmountAll();
    window.sessionStorage.clear();
    keep([candidate('cover')]);
    rememberChoice({ key: KEY, userId: 'did:privy:someone-else', ids: [IDS.cover], notShown: [] });
    host = await shown();
    expect(host.textContent).toContain(en.plan.missing.title);
  });
});
