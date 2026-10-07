// @vitest-environment happy-dom
import type { BasketSheet, PlanCandidateId } from '@colosseum/schemas';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, press, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { PERSONALIZE_PATH, PROPOSE_PATH } from '../goal/build-plan';
import { READ_IN_DOLLARS } from '../goal/test/plan';
import { recallPlan } from '../order/plan-store';
import { builtFor, CANDIDATE_ID } from '../order/test/candidates';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { InvestScreen } from './InvestScreen';

// what the invest card is given: which plan it buys
const card = vi.hoisted(() => ({
  props: null as { of?: { plan?: string }; amount?: number } | null,
}));
vi.mock('../order/Invest', () => ({
  Invest: (props: { of?: { plan?: string }; amount?: number }) => {
    card.props = props;
    return createElement('div', { 'data-ui': 'invest-card' });
  },
}));
vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The pane once the plans are made (gate THREE-PLANS): the candidates side by side with none picked,
// then the one the person picks, by a press or by its name, and only then the invest step.

const en = dictionary('en');
const USER = 'did:privy:test';
const names = en.plan.choice.names;
type Call = { path: string; body?: unknown };

const person: Person = {
  userId: USER,
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: [],
};

function api(o: { signedIn?: boolean; shown?: PlanCandidateId[] } = {}) {
  const calls: Call[] = [];
  portStore.setApi(async (path, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path === '/v1/me') return o.signedIn === false ? json({}, 401) : json(person);
    if (path === '/goals') return json(READ_IN_DOLLARS);
    if (path === PERSONALIZE_PATH || path === PROPOSE_PATH)
      return json(builtFor((body as { sheet: BasketSheet }).sheet, o.shown));
    return json({ error: 'not found' }, 404);
  });
  return { calls, to: (path: string) => calls.filter((c) => c.path === path) };
}

const box = (host: HTMLElement) => find<HTMLTextAreaElement>(host, 'textarea');
const pane = (host: HTMLElement) => find(host, '[data-ui="invest-pane"]');
const last = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-ui="invest-turns"] > li')].at(-1)?.textContent ?? '';
const shown = (host: HTMLElement) =>
  [...pane(host).querySelectorAll('section[data-candidate]')].map((c) =>
    c.getAttribute('data-candidate'),
  );
const choose = (host: HTMLElement, name: PlanCandidateId) =>
  find(pane(host), `section[data-candidate="${name}"] [data-ui="candidate-pick"] button`);
async function say(host: HTMLElement, text: string) {
  await type(box(host), text);
  await press(box(host), 'Enter');
  await settle();
  await settle();
}
/** Example 1 (protect $50,000, 18 months, low risk), then "yes". */
async function built(o: Parameters<typeof api>[0] = {}) {
  const server = api(o);
  const host = await mount(withAccount('en', createElement(InvestScreen)));
  await settle();
  await settle();
  await click(
    [...host.querySelectorAll('button')].find(
      (b) => b.textContent === en.goal.examples.list[1],
    ) as HTMLElement,
  );
  await settle();
  await settle();
  await say(host, 'yes');
  await settle();
  return { host, server };
}

beforeEach(() => {
  card.props = null;
  window.sessionStorage.clear();
  window.localStorage.clear();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
  Object.defineProperty(window.navigator, 'languages', { value: ['en'], configurable: true });
});
afterEach(unmountAll);

describe('the plans, once made', () => {
  it('are side by side in the fixed order with none picked, and nothing can be invested in yet', async () => {
    const { host } = await built();
    expect(pane(host).getAttribute('data-state')).toBe('choice');
    expect(shown(host)).toEqual(['cover', 'spread', 'carry']);
    // no plan in full, no invest card, no button that invests
    expect(pane(host).querySelector('[data-ui="plan-pane"]')).toBeNull();
    expect(pane(host).querySelector('[data-ui="invest-card"]')).toBeNull();
    expect(pane(host).querySelector('[data-ui="plan-invest"]')).toBeNull();
    expect(card.props).toBeNull();
    expect(pane(host).textContent).not.toMatch(/Invest \$/);
    expect(last(host)).toContain(en.talk.say.builtChoice);
    // each candidate is kept as its own plan, which is what a buy names
    for (const id of Object.values(CANDIDATE_ID)) expect(recallPlan(id, USER)).not.toBeNull();
    // the facts stay above, to change
    expect(pane(host).querySelector('[data-ui="pane-facts"]')).not.toBeNull();
  });

  it('opens the one that is pressed in full, and invests in that candidate by its own plan id', async () => {
    const { host } = await built();
    await click(choose(host, 'spread'));
    await settle();
    expect(pane(host).getAttribute('data-state')).toBe('invest');
    expect(find(pane(host), '[data-ui="pane-picked"]').textContent).toBe(
      en.talk.pane.picked('Spread'),
    );
    expect(pane(host).querySelector('[data-ui="plan-pane"]')).not.toBeNull();
    expect(pane(host).querySelector('[data-ui="plan-candidates"]')).toBeNull();
    // the invest step names the amount and the candidate
    expect(find(pane(host), '[data-ui="invest-in"]').textContent).toBe('Invest $50,000 in Spread');
    expect(card.props?.of).toEqual({ plan: CANDIDATE_ID.spread });
    expect(card.props?.amount).toBe(50_000);
    // said in the conversation, as the person's turn and the app's
    expect(last(host)).toContain(en.talk.say.picked('Spread'));
    // and the plans can be seen again: none is picked then
    await click(
      [...pane(host).querySelectorAll('button')].find(
        (b) => b.textContent === en.talk.pane.backToPlans,
      ) as HTMLElement,
    );
    await settle();
    expect(pane(host).getAttribute('data-state')).toBe('choice');
    expect(pane(host).querySelector('[data-ui="invest-card"]')).toBeNull();
  });

  it.each([
    ['carry', 'carry'],
    ['Cover.', 'cover'],
    ['choose Spread', 'spread'],
    ['I’ll take carry', 'carry'],
    ["i'll take cover", 'cover'],
  ] as const)('picks a candidate the person names: "%s"', async (typed, name) => {
    const { host, server } = await built();
    await say(host, typed);
    expect(pane(host).getAttribute('data-state')).toBe('invest');
    expect(card.props?.of).toEqual({ plan: CANDIDATE_ID[name] });
    expect(last(host)).toContain(en.talk.say.picked(names[name]));
    // nothing was read or built again for it
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(1);
    expect(server.to('/goals')).toEqual([]);
  });

  it('does not take a sentence that only mentions a name, or names two, as a pick', async () => {
    const { host } = await built();
    for (const typed of ['what does cover mean?', 'cover or carry', 'cover my losses please']) {
      await say(host, typed);
      expect(pane(host).getAttribute('data-state'), typed).toBe('choice');
      expect(card.props, typed).toBeNull();
    }
  });

  it('makes the plans again from a change, and none is picked among the new ones', async () => {
    const { host, server } = await built();
    await click(choose(host, 'cover'));
    await settle();
    expect(card.props?.of).toEqual({ plan: CANDIDATE_ID.cover });
    await click(find(pane(host), '[data-ui="pane-facts"] [data-fact="risk"] button'));
    await settle();
    await click(
      [...find(host, '[data-ui="invest-replies"]').querySelectorAll('button')].find(
        (b) => b.textContent === en.goal.options.risk.medium,
      ) as HTMLElement,
    );
    await settle();
    await settle();
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(2);
    expect(pane(host).getAttribute('data-state')).toBe('choice');
    expect(pane(host).querySelector('[data-ui="invest-card"]')).toBeNull();
  });

  it('names the candidates the engine did not offer with its reason, and opens the only one there is', async () => {
    const two = await built({ shown: ['carry', 'cover'] });
    expect(shown(two.host)).toEqual(['cover', 'carry']);
    expect(find(pane(two.host), '[data-ui="candidates-not-shown"]').textContent).toContain(
      'Spread: spread came out the same as another.',
    );
    await unmountAll();
    window.sessionStorage.clear();
    // one plan alone is nothing to choose between: it is the plan, by its own id
    const one = await built({ shown: ['spread'] });
    expect(pane(one.host).getAttribute('data-state')).toBe('invest');
    expect(card.props?.of).toEqual({ plan: CANDIDATE_ID.spread });
    expect(pane(one.host).querySelector('[data-ui="invest-in"]')).toBeNull();
    expect(last(one.host)).toContain(en.talk.say.built);
  });
});

describe('a visitor’s plans', () => {
  it('are compared and picked without a sign-in, which only investing asks for; the pick is kept once they are in', async () => {
    portStore.set(fakePort());
    const who = { signedIn: false };
    const { host, server } = await built(who);
    expect(server.to(PROPOSE_PATH)).toHaveLength(1);
    expect(pane(host).getAttribute('data-state')).toBe('choice');
    await click(choose(host, 'carry'));
    await settle();
    expect(pane(host).getAttribute('data-state')).toBe('plan');
    const invest = find(pane(host), '[data-ui="plan-invest"] a');
    expect(invest.textContent).toBe('Invest $50,000 in Carry');
    expect(invest.getAttribute('href')).toBe('/sign-in?next=/goal');
    expect(card.props).toBeNull();
    // signed in: the same plans are made theirs, and Carry is still the one
    who.signedIn = true;
    await act(async () => portStore.set(signedInPort(EMBEDDED, { userId: USER })));
    await settle();
    await settle();
    await settle();
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(1);
    expect(pane(host).getAttribute('data-state')).toBe('invest');
    expect(card.props?.of).toEqual({ plan: CANDIDATE_ID.carry });
  });
});
