// @vitest-environment happy-dom
import { type BasketSheet, DISCLAIMER } from '@colosseum/schemas';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, press, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary, type Lang } from '../../i18n';
import type { Person } from '../account/person';
import { inShell, withAccount } from '../account/test/screen';
import { PERSONALIZE_PATH, PROPOSE_PATH } from '../goal/build-plan';
import { GOAL_DRAFT, GOAL_HANDOFF } from '../goal/draft';
import { proposalFor, READ_IN_DOLLARS } from '../goal/test/plan';
import { recallPlan } from '../order/plan-store';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { keepWay } from './handoff';
import { InvestScreen, restoreDraft } from './InvestScreen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The Invest screen with real events (gate INVEST-TWO-PANE): the conversation, turn by turn, and the
// pane beside it in each of its states. The API is a double: POST /goals as `staging` answers it, the
// two routes that build a plan, and GET /v1/me.

const en = dictionary('en');
const USER = 'did:privy:test';
const PLAN = 'plan-1';
type Call = { method: string; path: string; body?: unknown };

const person: Person = {
  userId: USER,
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: [],
};

function api(o: { person?: Person; plan?: (sheet: BasketSheet, path: string) => Response } = {}) {
  const calls: Call[] = [];
  portStore.setApi(async (path, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (path === '/goals') return json(READ_IN_DOLLARS);
    if (path === '/v1/me') return o.person ? json(o.person) : json({}, 401);
    if (path === PERSONALIZE_PATH || path === PROPOSE_PATH) {
      const sheet = (body as { sheet: BasketSheet }).sheet;
      return o.plan
        ? o.plan(sheet, path)
        : json({ id: PLAN, proposal: proposalFor(sheet, 'sandbox') });
    }
    // a server that keeps the plans it builds
    if (path === `/v1/baskets/${PLAN}`) return json({ error: 'down' }, 503);
    return json({ error: 'not found' }, 404);
  });
  return { calls, to: (path: string) => calls.filter((c) => c.path === path) };
}

const screen = async (lang: Lang = 'en') => {
  const host = await mount(withAccount(lang, createElement(InvestScreen)));
  await settle();
  return host;
};
const box = (host: HTMLElement) => find<HTMLTextAreaElement>(host, 'textarea');
const pane = (host: HTMLElement) => find(host, '[data-ui="invest-pane"]');
const turns = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-ui="invest-turns"] > li')].map((li) => [
    li.getAttribute('data-who'),
    li.textContent,
  ]);
const replies = (host: HTMLElement) =>
  [...(host.querySelector('[data-ui="invest-replies"]')?.querySelectorAll('button') ?? [])].map(
    (b) => b.textContent,
  );
const reply = (host: HTMLElement, label: string) =>
  [...find(host, '[data-ui="invest-replies"]').querySelectorAll('button')].find(
    (b) => b.textContent === label,
  ) as HTMLElement;
const fact = (host: HTMLElement, name: string) =>
  find(host, `[data-ui="pane-facts"] [data-fact="${name}"]`);
async function say(host: HTMLElement, text: string) {
  await type(box(host), text);
  await press(box(host), 'Enter');
  await settle();
  await settle();
}
async function answer(host: HTMLElement, label: string) {
  await click(reply(host, label));
  await settle();
  await settle();
}
const example = (host: HTMLElement, at: number) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent === en.goal.examples.list[at],
  ) as HTMLElement;

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  portStore.set(fakePort());
  Object.defineProperty(window.navigator, 'languages', { value: ['en'], configurable: true });
});
afterEach(unmountAll);

describe('before anything is said', () => {
  it('is one question, the box, three examples, and the outline of a plan beside them', async () => {
    api();
    const host = await screen();
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(find(host, 'h1').textContent).toBe(en.goal.title);
    expect(box(host)).toBeTruthy();
    expect(
      [...find(host, `ul[aria-label="${en.invest.examples}"]`).querySelectorAll('button')].map(
        (b) => b.textContent,
      ),
    ).toEqual(en.goal.examples.list);
    expect(pane(host).getAttribute('data-state')).toBe('empty');
    expect(find(pane(host), '[data-ui="pane-empty"] h2').textContent).toBe(
      en.invest.pane.empty.title,
    );
    expect(turns(host)).toEqual([]);
    // no form, no country, no select anywhere
    expect(host.querySelector('select, input')).toBeNull();
    expect(host.textContent).not.toMatch(/country/i);
  });
});

describe('the conversation, turn by turn', () => {
  it('says back what an example says, shows each fact in the pane, and builds nothing until asked', async () => {
    const server = api();
    const host = await screen();
    await click(example(host, 1));
    await settle();
    await settle();
    expect(turns(host)).toEqual([
      ['person', `${en.invest.you}: ${en.goal.examples.list[1]}`],
      [
        'app',
        `${en.invest.me}${en.invest.say.understood('Protect it, $50,000, 18 months, and Low risk')}${en.invest.say.ready}`,
      ],
    ]);
    // the page's own example: no reader is asked, and no plan is built before the person says so
    expect(server.to('/goals')).toEqual([]);
    expect(server.to(PROPOSE_PATH)).toEqual([]);
    expect(pane(host).getAttribute('data-state')).toBe('facts');
    expect(
      [...pane(host).querySelectorAll('[data-fact]')].map((li) => [
        li.getAttribute('data-fact'),
        li.getAttribute('data-set'),
      ]),
    ).toEqual([
      ['goal', 'true'],
      ['amount', 'true'],
      ['horizon', 'true'],
      ['risk', 'true'],
    ]);
    expect(fact(host, 'amount').textContent).toContain('$50,000');
    expect(fact(host, 'horizon').textContent).toContain('18 months');
    // the one reply is to ask for the plan (GUIDED-INTAKE: the solver runs on what was confirmed)
    expect(replies(host)).toEqual([en.invest.replies.build]);
    // the examples are for a start: gone once the conversation has one
    expect(host.querySelector(`ul[aria-label="${en.invest.examples}"]`)).toBeNull();
  });

  it('asks what is open, one question at a time, with quick replies, and fills the pane as answers come', async () => {
    const server = api();
    const host = await screen();
    await say(host, 'Grow $40,000');
    expect(server.to('/goals')).toHaveLength(1);
    // understood, then the one open question
    const last = turns(host).at(-1)?.[1] ?? '';
    expect(last).toContain(en.invest.say.understood('Grow it and $40,000'));
    expect(last).toContain(en.invest.ask.horizon);
    expect(last).not.toContain(en.invest.ask.risk);
    expect(replies(host)).toEqual(['1 year', '3 years', '5 years', '10 years']);
    expect(fact(host, 'horizon').getAttribute('data-set')).toBe('false');
    expect(fact(host, 'horizon').textContent).toContain(en.invest.facts.open);

    await answer(host, '3 years');
    expect(fact(host, 'horizon').textContent).toContain('3 years');
    expect(turns(host).at(-1)?.[1]).toContain(
      en.invest.say.set(en.invest.facts.horizon, '3 years'),
    );
    expect(turns(host).at(-1)?.[1]).toContain(en.invest.ask.risk);
    expect(replies(host)).toEqual(['Low', 'Medium', 'High']);

    await answer(host, 'Medium');
    expect(turns(host).at(-1)?.[1]).toContain(en.invest.say.ready);
    expect(replies(host)).toEqual([en.invest.replies.build]);
    // an income goal has a fifth fact; this one does not show it
    expect(pane(host).querySelector('[data-fact="income"]')).toBeNull();
  });

  it('takes a typed answer too, and says when it is not one the question takes', async () => {
    api();
    const host = await screen();
    await say(host, 'Grow $40,000');
    await say(host, 'not sure');
    expect(turns(host).at(-1)?.[1]).toContain(en.invest.say.unfit.horizon);
    expect(turns(host).at(-1)?.[1]).toContain(en.invest.ask.horizon);
    await say(host, '5');
    expect(fact(host, 'horizon').textContent).toContain('5 years');
  });

  it('says so when the reader cannot be reached, and keeps the box for another try', async () => {
    portStore.setApi(async () => json({}, 503));
    const host = await screen();
    await say(host, 'Something for later');
    expect(turns(host).at(-1)?.[1]).toContain(en.goal.readFailure.unreachable);
    expect(pane(host).getAttribute('data-state')).toBe('facts');
    expect(box(host).getAttribute('aria-disabled')).toBeNull();
  });

  it('asks an income goal what it should pay a month, with "no set amount" among the replies', async () => {
    api();
    const host = await screen();
    await say(host, 'Income from $80,000 for 5 years, low risk');
    expect(turns(host).at(-1)?.[1]).toContain(en.invest.ask.income);
    expect(replies(host)).toEqual([
      '$100 a month',
      '$300 a month',
      '$500 a month',
      en.invest.replies.noIncome,
    ]);
    await answer(host, en.invest.replies.noIncome);
    expect(turns(host).at(-1)?.[1]).toContain(en.invest.say.incomeSkipped);
    expect(fact(host, 'income').textContent).toContain(en.invest.facts.noIncome);
    expect(replies(host)).toEqual([en.invest.replies.build]);
  });
});

describe('the plan, built beside the conversation', () => {
  const whole = async (host: HTMLElement) => {
    await click(example(host, 1));
    await settle();
    await settle();
    await answer(host, en.invest.replies.build);
    await settle();
  };

  it('builds a visitor’s plan with no sign-in, shows how, and asks them to sign in to invest', async () => {
    const server = api();
    const host = await screen();
    await whole(host);
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
    expect(server.to(PROPOSE_PATH).map((c) => c.body)).toEqual([
      {
        sheet: {
          basketType: 'standard',
          goal: 'protect',
          amountUsd: 50000,
          horizonMonths: 18,
          risk: 'low',
          themes: [],
          // never asked: sent silently, since the API's sheet still needs one
          country: 'BR',
          chains: ['solana'],
          rules: { useHoldings: true, glide: true },
          language: 'en',
        },
      },
    ]);
    expect(pane(host).getAttribute('data-state')).toBe('plan');
    const plan = find(pane(host), '[data-ui="plan-pane"]');
    // the answer first, then the holdings, the exit plan, and one button that names the amount
    expect(find(plan, '[data-ui="plan-answer"]').textContent).toBe(en.plan.answer.none);
    expect(plan.querySelector('[data-ui="plan-legs"]')).not.toBeNull();
    expect(plan.querySelector('[data-ui="exit-plan-line"]')?.textContent).toContain(
      en.plan.exitUnmeasured,
    );
    const invest = find(plan, '[data-ui="plan-invest"] a');
    expect(invest.textContent).toBe(en.plan.invest('$50,000'));
    expect(invest.getAttribute('href')).toBe('/sign-in?next=/goal');
    expect(turns(host).at(-1)?.[1]).toContain(en.invest.say.built);
    // a visitor's plan is not kept as anyone's
    expect(recallPlan(PLAN, USER)).toBeNull();
    // the facts stay above the plan, to change
    expect(pane(host).querySelector('[data-ui="pane-facts"]')).not.toBeNull();
  });

  it('builds the plan again as the person’s own once they sign in, and opens the invest step they asked for', async () => {
    const server = api({ person });
    const host = await screen();
    await whole(host);
    await click(find(pane(host), '[data-ui="plan-invest"] a'));
    expect(turns(host).at(-1)?.[1]).toContain(en.invest.say.signIn);
    await act(async () => portStore.set(signedInPort(EMBEDDED, { userId: USER })));
    await settle();
    await settle();
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(1);
    expect(recallPlan(PLAN, USER)).not.toBeNull();
    // the conversation is still there, and the pane hosts the invest step
    expect(turns(host)[0]?.[0]).toBe('person');
    expect(pane(host).getAttribute('data-state')).toBe('invest');
    expect(find(pane(host), '[data-ui="invest-step"] [data-ui="buy-steps"]')).toBeTruthy();
  });

  it('signed in: builds the person’s own plan, keeps it, and "Invest" opens the step in the same pane', async () => {
    const server = api({ person });
    portStore.set(signedInPort(EMBEDDED, { userId: USER }));
    const host = await screen();
    await settle();
    await whole(host);
    expect(server.to(PROPOSE_PATH)).toEqual([]);
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(1);
    expect(recallPlan(PLAN, USER)?.proposal.sheet.amountUsd).toBe(50000);
    const own = [...pane(host).querySelectorAll('a')].find(
      (a) => a.textContent === en.invest.pane.ownPage,
    );
    expect(own?.getAttribute('href')).toBe(`/plan/${PLAN}`);
    await click(find(pane(host), '[data-ui="plan-invest"] button'));
    await settle();
    expect(pane(host).getAttribute('data-state')).toBe('invest');
    expect(find(pane(host), '[data-ui="buy-steps"]')).toBeTruthy();
    // and back
    await click(
      [...pane(host).querySelectorAll('button')].find(
        (b) => b.textContent === en.invest.pane.backToPlan,
      ) as HTMLElement,
    );
    expect(pane(host).getAttribute('data-state')).toBe('plan');
  });

  it('asks about a fact again when it is tapped, and builds the plan again from the answer, with no second confirm', async () => {
    const server = api();
    const host = await screen();
    await whole(host);
    await click(find(fact(host, 'risk'), 'button'));
    await settle();
    expect(turns(host).at(-1)?.[1]).toContain(en.invest.ask.risk);
    await answer(host, 'High');
    await settle();
    expect(
      server.to(PROPOSE_PATH).map((c) => (c.body as { sheet: BasketSheet }).sheet.risk),
    ).toEqual(['low', 'high']);
    expect(fact(host, 'risk').textContent).toContain('High');
    expect(pane(host).getAttribute('data-state')).toBe('plan');
  });

  it('makes each way to close a gap a button that is a turn of the conversation and redraws the plan', async () => {
    const WAY = 'You can add $83,100, for $163,100 in all.';
    const server = api({
      plan: (sheet) =>
        json({
          id: PLAN,
          proposal: {
            ...proposalFor(sheet, 'sandbox'),
            verdict:
              sheet.amountUsd < 100_000
                ? { met: false, gapUsdMonthly: 152.8, ways: [{ change: WAY, closesGap: true }] }
                : { met: true, gapUsdMonthly: 0, ways: [] },
          },
        }),
    });
    const host = await screen();
    await click(example(host, 2));
    await settle();
    await settle();
    await answer(host, en.invest.replies.build);
    await settle();
    const plan = find(pane(host), '[data-ui="plan-pane"]');
    expect(find(plan, '[data-ui="plan-answer"]').textContent).toBe(en.plan.verdict.gap('$152.80'));
    const way = find(plan, '[data-ui="plan-ways"] button');
    expect(way.textContent).toBe(WAY);
    await click(way);
    await settle();
    await settle();
    expect(turns(host).some(([who, text]) => who === 'person' && text?.includes(WAY))).toBe(true);
    expect(
      server.to(PROPOSE_PATH).map((c) => (c.body as { sheet: BasketSheet }).sheet.amountUsd),
    ).toEqual([80000, 163100]);
    expect(find(pane(host), '[data-ui="plan-answer"]').textContent).toBe(en.plan.verdict.met);
    expect(fact(host, 'amount').textContent).toContain('$163,100');
  });

  it('says in the conversation why no plan was built, and shows none', async () => {
    api({ plan: () => json({ error: 'x', code: 'GOAL_NOT_ACHIEVABLE' }, 422) });
    const host = await screen();
    await whole(host);
    expect(turns(host).at(-1)?.[1]).toContain(en.invest.failure.noPlan);
    expect(pane(host).querySelector('[data-ui="plan-pane"]')).toBeNull();
    expect(pane(host).getAttribute('data-state')).toBe('facts');
  });

  it('offers to try again when the server did not answer', async () => {
    let down = true;
    const server = api({
      plan: (sheet) =>
        down ? json({}, 503) : json({ id: PLAN, proposal: proposalFor(sheet, 'sandbox') }),
    });
    const host = await screen();
    await whole(host);
    expect(turns(host).at(-1)?.[1]).toContain(en.invest.failure.unavailable);
    down = false;
    await answer(host, en.invest.failure.again);
    await settle();
    expect(server.to(PROPOSE_PATH)).toHaveLength(2);
    expect(pane(host).getAttribute('data-state')).toBe('plan');
  });
});

describe('what is handed to the screen, and what it keeps', () => {
  it('reads a goal typed on the landing page as its first turn', async () => {
    api();
    window.sessionStorage.setItem(GOAL_HANDOFF, 'Protect $50,000 for 18 months, low risk, please');
    const host = await screen();
    await settle();
    expect(turns(host)[0]).toEqual([
      'person',
      `${en.invest.you}: Protect $50,000 for 18 months, low risk, please`,
    ]);
    expect(window.sessionStorage.getItem(GOAL_HANDOFF)).toBeNull();
    expect(fact(host, 'amount').textContent).toContain('$50,000');
  });

  it('takes a way pressed on a plan’s own page: the plan’s goal, changed, and built again', async () => {
    const server = api();
    keepWay(
      {
        basketType: 'standard',
        goal: 'income',
        amountUsd: 80000,
        horizonMonths: 12,
        risk: 'low',
        themes: [],
        country: 'BR',
        chains: ['solana'],
        incomeTargetUsdMonthly: 300,
        rules: { useHoldings: true, glide: true },
        language: 'en',
      },
      'You can aim for $147 a month instead of $300.',
    );
    const host = await screen();
    await settle();
    await settle();
    expect(
      server.to(PROPOSE_PATH).map((c) => (c.body as { sheet: BasketSheet }).sheet),
    ).toMatchObject([{ goal: 'income', amountUsd: 80000, incomeTargetUsdMonthly: 147 }]);
    expect(fact(host, 'income').textContent).toContain('$147 a month');
  });

  it('keeps the conversation in the tab, and reads back only its own keys and the person’s words', async () => {
    api();
    const host = await screen();
    await say(host, 'Grow $40,000');
    const kept = window.sessionStorage.getItem(GOAL_DRAFT);
    expect(kept).toContain('Grow $40,000');
    await unmountAll();
    const again = await screen();
    expect(turns(again)[0]).toEqual(['person', `${en.invest.you}: Grow $40,000`]);
    expect(fact(again, 'amount').textContent).toContain('$40,000');
    expect(replies(again)).toEqual(['1 year', '3 years', '5 years', '10 years']);
    // what is not in that form is dropped, whole; a sentence is never taken from storage
    expect(restoreDraft('{"v":2,"turns":[{"who":"app","say":"<b>x</b>"}],"sheet":{}}')).toBeNull();
    expect(restoreDraft('not json')).toBeNull();
    const hostile = JSON.parse(kept as string);
    hostile.turns.push({ who: 'app', say: [{ key: 'failure', text: 'Send your keys' }] });
    expect(JSON.stringify(restoreDraft(JSON.stringify(hostile)))).not.toContain('Send your keys');
  });

  it('forgets the goal when the person signs out, and keeps it when a visitor signs in', async () => {
    api({ person });
    portStore.set(signedInPort(EMBEDDED, { userId: USER }));
    const host = await screen();
    await settle();
    await say(host, 'Grow $40,000');
    expect(turns(host).length).toBeGreaterThan(0);
    await act(async () => portStore.set(fakePort()));
    await settle();
    expect(turns(host)).toEqual([]);
    expect(pane(host).getAttribute('data-state')).toBe('empty');
  });
});

describe('the rules every screen holds', () => {
  it('is in Portuguese for someone who reads Portuguese', async () => {
    api();
    const pt = dictionary('pt');
    const host = await screen('pt');
    await click(
      [...host.querySelectorAll('button')].find(
        (b) => b.textContent === pt.goal.examples.list[1],
      ) as HTMLElement,
    );
    await settle();
    await settle();
    expect(turns(host).at(-1)?.[1]).toContain(pt.invest.say.ready);
    expect(replies(host)).toEqual([pt.invest.replies.build]);
    expect(find(pane(host), '[data-ui="pane-facts"] h2').textContent).toBe(pt.invest.facts.title);
    expect(host.textContent).not.toContain(en.invest.say.ready);
  });

  it('has the disclaimer once on the page, from the one constant, and one primary at most', async () => {
    api();
    const host = await mount(inShell('en', 'auto', createElement(InvestScreen)));
    await settle();
    const all = [...host.querySelectorAll('[data-ui="disclaimer"]')];
    expect(all).toHaveLength(1);
    expect(find(all[0] as HTMLElement, 'p[lang]').textContent).toBe(DISCLAIMER.en);
    await click(example(host, 1));
    await settle();
    await settle();
    expect(host.querySelectorAll('main [data-variant="primary"]')).toHaveLength(1);
    // no exclamation mark, and no word MOCK
    expect(find(host, 'main').textContent).not.toMatch(/!|MOCK/);
  });
});
