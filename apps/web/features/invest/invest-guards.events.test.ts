// @vitest-environment happy-dom
import type { BasketSheet } from '@colosseum/schemas';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, press, settle, type, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import { ChainSwitch } from '../account/ChainSwitch';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { PERSONALIZE_PATH, PROPOSE_PATH } from '../goal/build-plan';
import { GOAL_DRAFT } from '../goal/draft';
import { proposalFor, READ_IN_DOLLARS, READ_IN_REAIS } from '../goal/test/plan';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { InvestScreen, restoreDraft } from './InvestScreen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));
// the invest card is build-buy's, with its own tests: here it is a mark that it is there
vi.mock('../order/Invest', () => ({
  Invest: () => createElement('div', { 'data-ui': 'invest-card' }),
}));

// What the Invest screen must never do, whatever is pressed or answered: show a plan to someone it
// was not built for, show a plan that is not the one asked for, ask the wallet for anything, build on
// a chain that is off, or say a server's words. These held on the goal form it replaced
// (goal-screen.events.test.ts) and hold here.

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

function api(
  o: {
    person?: Person;
    /** Answers GET /v1/me in place of the person, while set. */
    me?: () => Promise<Response>;
    reading?: unknown;
    plan?: (sheet: BasketSheet, path: string) => Response | Promise<Response>;
  } = {},
) {
  const calls: Call[] = [];
  let down = false;
  portStore.setApi(async (path, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (down) throw new TypeError('fetch failed');
    if (path === '/goals') return json(o.reading ?? READ_IN_DOLLARS);
    if (path === '/v1/me') return o.me ? o.me() : o.person ? json(o.person) : json({}, 401);
    if (path === '/v1/me/chain' && method === 'PUT' && o.person) {
      o.person = { ...o.person, chain: body.chain, chainSource: 'picked' };
      return json(o.person);
    }
    if (path === PERSONALIZE_PATH || path === PROPOSE_PATH) {
      const sheet = (body as { sheet: BasketSheet }).sheet;
      return o.plan ? o.plan(sheet, path) : json({ id: PLAN, proposal: proposalFor(sheet) });
    }
    return json({ error: 'not found' }, 404);
  });
  return {
    calls,
    to: (path: string) => calls.filter((c) => c.path === path),
    setDown(value: boolean) {
      down = value;
    },
  };
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
const last = (host: HTMLElement) => turns(host).at(-1)?.[1] ?? '';
const replies = (host: HTMLElement) =>
  [...(host.querySelector('[data-ui="invest-replies"]')?.querySelectorAll('button') ?? [])].map(
    (b) => b.textContent,
  );
const fact = (host: HTMLElement, name: string) =>
  find(host, `[data-ui="pane-facts"] [data-fact="${name}"]`);
async function say(host: HTMLElement, text: string) {
  await type(box(host), text);
  await press(box(host), 'Enter');
  await settle();
  await settle();
}
const example = (host: HTMLElement, at: number) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent === en.goal.examples.list[at],
  ) as HTMLElement;
/** Example 1 (protect $50,000, 18 months, low risk), then "Yes, build it". */
async function whole(host: HTMLElement) {
  await click(example(host, 1));
  await settle();
  await settle();
  await click(
    [...find(host, '[data-ui="invest-replies"]').querySelectorAll('button')].find(
      (b) => b.textContent === en.talk.replies.build,
    ) as HTMLElement,
  );
  await settle();
  await settle();
}
const signedIn = (over: Parameters<typeof signedInPort>[1] = {}) =>
  portStore.set(signedInPort(EMBEDDED, { userId: USER, ...over }));

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  portStore.set(fakePort());
  Object.defineProperty(window.navigator, 'languages', { value: ['en'], configurable: true });
});
afterEach(unmountAll);

describe('an answer that arrives late', () => {
  /** A signed-in person whose plan is being built: the route has not answered yet. */
  async function building() {
    let answer: (res: Response) => void = () => {};
    const sent: BasketSheet[] = [];
    const server = api({
      person,
      plan: (sheet) => {
        sent.push(sheet);
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      },
    });
    signedIn();
    const host = await screen();
    await settle();
    await whole(host);
    expect(sent).toHaveLength(1);
    expect(pane(host).querySelector('[data-ui="plan-pane"]')).toBeNull();
    const built = () => answer(json({ id: PLAN, proposal: proposalFor(sent[0] as BasketSheet) }));
    return { host, server, built };
  }

  it('reads no other goal while a plan is being built: the box is off, and the answer is for the sheet that was sent', async () => {
    const { host, server, built } = await building();
    expect(box(host).disabled).toBe(true);
    await type(box(host), 'Grow $25,000 for two years, high risk');
    await press(box(host), 'Enter');
    await settle();
    expect(server.to('/goals')).toEqual([]);
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(1);
    await act(async () => built());
    await settle();
    expect(pane(host).querySelector('[data-ui="plan-pane"]')).not.toBeNull();
    expect(fact(host, 'amount').textContent).toContain('$50,000');
  });

  it('is not shown to whoever is there by then: the person signed out while it was built', async () => {
    const { host, built } = await building();
    await act(async () => portStore.set(fakePort()));
    await settle();
    await act(async () => built());
    await settle();
    expect(pane(host).querySelector('[data-ui="plan-pane"]')).toBeNull();
    expect(pane(host).getAttribute('data-state')).toBe('empty');
    // and the goal went with the person who said it
    expect(turns(host)).toEqual([]);
    expect(box(host).value).toBe('');
  });

  it('is not shown for another person who signed in meanwhile', async () => {
    const { host, built } = await building();
    await act(async () => portStore.set(signedInPort(EMBEDDED, { userId: 'did:privy:other' })));
    await settle();
    await act(async () => built());
    await settle();
    expect(pane(host).querySelector('[data-ui="plan-pane"]')).toBeNull();
    expect(pane(host).querySelector('[data-ui="invest-card"]')).toBeNull();
  });
});

describe('an answer that is not the plan that was asked for', () => {
  it('shows no plan that is for another chain than the one asked for (ONE-CHAIN)', async () => {
    api({
      plan: (sheet) =>
        json({ id: PLAN, proposal: proposalFor({ ...sheet, chains: ['robinhood'] }) }),
    });
    const host = await screen();
    await whole(host);
    expect(pane(host).querySelector('[data-ui="plan-pane"]')).toBeNull();
    expect(pane(host).getAttribute('data-state')).toBe('facts');
    expect(last(host)).toContain(en.talk.failure.unavailable);
    expect(host.textContent).not.toContain('Robinhood Chain');
  });

  it('does not show an answer that is not a plan in the frozen shape', async () => {
    api({ plan: () => json({ id: PLAN, proposal: { lines: [] } }) });
    const host = await screen();
    await whole(host);
    expect(pane(host).querySelector('[data-ui="plan-pane"]')).toBeNull();
    expect(last(host)).toContain(en.talk.failure.unavailable);
  });
});

describe('what the conversation says when no plan comes back', () => {
  const answered = async (plan: () => Response) => {
    const server = api({ person, plan });
    signedIn();
    const host = await screen();
    await settle();
    await whole(host);
    return { host, server };
  };

  it.each([401, 403])(
    'says to sign in again, not that the limits were refused, when the server answers %s',
    async (status) => {
      const { host } = await answered(() => json({ error: 'sign in first' }, status));
      expect(last(host)).toContain(en.goal.blocked.signInAgain);
      expect(last(host)).not.toContain(en.talk.failure.refused);
      expect(host.textContent).not.toContain('sign in first');
      expect(pane(host).querySelector('[data-ui="plan-pane"]')).toBeNull();
    },
  );

  it('says the sign-in service gave no identity token, not to sign in again', async () => {
    const { host } = await answered(() =>
      json({ error: 'sign in first: no identity token was sent' }, 401),
    );
    expect(last(host)).toContain(en.goal.blocked.noIdentity);
    expect(last(host)).not.toContain(en.goal.blocked.signInAgain);
    expect(host.textContent).not.toContain('no identity token was sent');
  });

  it('says to choose the chain first when the server has none for this person', async () => {
    const { host } = await answered(() =>
      json({ error: 'pick the chain your plans live on first' }, 409),
    );
    expect(last(host)).toContain(en.goal.blocked.chainNotChosen);
    expect(last(host)).not.toContain(en.talk.failure.refused);
    expect(host.textContent).not.toContain('pick the chain');
  });

  it('says to slow down when the server asks for fewer requests, and offers to try again', async () => {
    const { host, server } = await answered(() => json({ error: 'too many' }, 429));
    expect(last(host)).toContain(en.shell.slowDown);
    expect(replies(host)).toEqual([en.talk.failure.again]);
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(1);
  });

  it('says plans are in dollars, plainly, not that the limits were refused (USD-ONLY)', async () => {
    const { host } = await answered(() =>
      json({ error: 'Plans are in US dollars for now', code: 'CURRENCY_UNSUPPORTED' }, 422),
    );
    expect(last(host)).toContain(en.goal.blocked.currency);
    expect(last(host)).not.toContain(en.talk.failure.refused);
    expect(replies(host)).toEqual([]);
  });

  it('says the server could not be reached, keeps the goal, and offers to try again', async () => {
    const server = api({ person });
    signedIn();
    const host = await screen();
    await settle();
    await click(example(host, 1));
    await settle();
    await settle();
    server.setDown(true);
    await say(host, 'yes');
    expect(last(host)).toContain(en.talk.failure.unavailable);
    expect(fact(host, 'amount').textContent).toContain('$50,000');
    expect(replies(host)).toEqual([en.talk.failure.again]);
  });
});

describe('the chain a plan is built on', () => {
  it('builds the plan again on the chain the person switched to', async () => {
    const server = api({ person });
    signedIn();
    const host = await mount(
      withAccount('en', [
        createElement(ChainSwitch, { key: 's' }),
        createElement(InvestScreen, { key: 'g' }),
      ]),
    );
    await settle();
    await settle();
    await whole(host);
    const built = () =>
      server.to(PERSONALIZE_PATH).map((c) => (c.body as { sheet: BasketSheet }).sheet.chains);
    expect(built()).toEqual([['solana']]);
    await click(find(host, '[data-ui="chain-switch"] > button'));
    await click(find(host, '[data-ui="chain-switch-panel"] button[data-chain="robinhood"]'));
    await settle();
    await settle();
    await settle();
    expect(server.to('/v1/me/chain')).toEqual([
      { method: 'PUT', path: '/v1/me/chain', body: { chain: 'robinhood' } },
    ]);
    expect(built()).toEqual([['solana'], ['robinhood']]);
    expect(find(pane(host), '[data-ui="plan-pane"]').textContent).toContain('Robinhood Chain');
  });

  it('builds nothing on a chain our server has switched off, and says so', async () => {
    const server = api({ person });
    signedIn({
      network: (chain) => {
        const network = fakePort().network(chain);
        return network && { ...network, on: chain !== 'solana' };
      },
    });
    const host = await screen();
    await settle();
    await whole(host);
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
    expect(server.to(PROPOSE_PATH)).toEqual([]);
    expect(last(host)).toContain(en.plan.chainOff('Solana'));
    expect(pane(host).querySelector('[data-ui="plan-pane"]')).toBeNull();
    expect(pane(host).querySelector('[data-ui="invest-card"]')).toBeNull();
    // the goal is kept, to build once the chain is back or on another
    expect(fact(host, 'amount').textContent).toContain('$50,000');
  });
});

describe('the Invest screen and the wallet', () => {
  it('asks the wallet to sign nothing and to send nothing: talking, answering, tapping facts, building', async () => {
    const sign = vi.fn(async () => []);
    const send = vi.fn(async () => ({ txId: 'x' }));
    const signMessage = vi.fn(async () => 'x');
    api({ person });
    signedIn({ sign, send, signMessage });
    const host = await screen();
    await settle();
    await say(host, 'Grow $40,000');
    // every quick reply in turn, until nothing is asked
    for (let i = 0; i < 6 && replies(host).length > 0; i++) {
      await click(find(host, '[data-ui="invest-replies"]').querySelector('button') as HTMLElement);
      await settle();
      await settle();
    }
    expect(pane(host).querySelector('[data-ui="plan-pane"]')).not.toBeNull();
    await say(host, 'make it 7 years');
    // every button on the screen that is not the invest card's
    for (const button of host.querySelectorAll('button')) {
      if (button.closest('[data-ui="invest-step"]')) continue;
      await click(button);
      await settle();
    }
    expect(sign).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
  });
});

describe('the binding rules at every step', () => {
  it('has no hatch without its word, no exclamation mark, and a name on every control', async () => {
    api({ person });
    portStore.set(signedInPort(EMBEDDED, { userId: USER, test: true }, 'mock'));
    const host = await screen();
    await settle();
    const check = (step: string) => {
      expect(hatchProblems(parse(host.innerHTML)), step).toEqual([]);
      expect(host.textContent, step).not.toMatch(/!/);
      for (const control of host.querySelectorAll<HTMLElement>('input, select, textarea')) {
        const label =
          control.getAttribute('aria-label') ??
          host.querySelector(`label[for="${control.id}"]`)?.textContent;
        expect(label?.trim(), `${step}: ${control.outerHTML.slice(0, 60)}`).toBeTruthy();
      }
      for (const button of host.querySelectorAll('button'))
        expect(
          (button.getAttribute('aria-label') ?? button.textContent ?? '').trim(),
          `${step}: ${button.outerHTML.slice(0, 80)}`,
        ).not.toBe('');
    };
    check('empty');
    await say(host, 'Grow $40,000');
    check('a question open');
    await say(host, '3 years, medium risk');
    check('whole');
    await say(host, 'yes');
    check('built');
    await click(find(fact(host, 'risk'), 'button'));
    await settle();
    check('a fact reopened');
  });
});

describe('the box', () => {
  it('sends nothing empty', async () => {
    const server = api();
    const host = await screen();
    await press(box(host), 'Enter');
    await click(find(host, '[data-ui="composer-send"]'));
    await type(box(host), '   ');
    await press(box(host), 'Enter');
    await settle();
    expect(server.to('/goals')).toEqual([]);
    expect(turns(host)).toEqual([]);
  });

  it('takes no more text than the reader does, and says a goal is too long, or too short', async () => {
    const server = api();
    const host = await screen();
    expect(box(host).getAttribute('maxlength')).toBe('2000');
    // a text that got past the box all the same, as a pasted one can in some browsers
    await say(host, 'x'.repeat(2001));
    expect(server.to('/goals')).toEqual([]);
    expect(host.textContent).toContain(en.goal.readFailure.tooLong);
    expect(host.textContent).not.toContain(en.goal.readFailure.tooShort);
    await say(host, 'ab');
    expect(server.to('/goals')).toEqual([]);
    expect(host.textContent).toContain(en.goal.readFailure.tooShort);
  });
});

describe('a goal in reais', () => {
  it('is read as far as the dollars sheet goes: no amount is converted, and the amount is asked', async () => {
    const pt = dictionary('pt');
    api({ reading: READ_IN_REAIS });
    const host = await screen('pt');
    await say(host, 'Quero uma renda todo mês a partir de 2029, com resgate em até 7 dias');
    expect(fact(host, 'goal').textContent).toContain(pt.goal.options.goal.income);
    // no figure in reais is carried into a sheet in dollars
    expect(fact(host, 'amount').getAttribute('data-set')).toBe('false');
    expect(fact(host, 'income').getAttribute('data-set')).toBe('false');
    expect(host.textContent).not.toMatch(/5[.,]000/);
    expect(last(host)).toContain(pt.talk.ask.amount);
  });
});

describe('what is read back from the tab', () => {
  const kept = (fields: Record<string, string>, turnFields = fields) =>
    JSON.stringify({
      v: 2,
      turns: [
        { who: 'person', text: 'Grow $40,000' },
        { who: 'app', say: [{ key: 'understood' }], fields: turnFields, ask: 'horizon' },
      ],
      sheet: { fields, skipped: [] },
    });
  const GOOD = {
    goal: 'grow',
    amount: '40000',
    income: '',
    horizon: '',
    risk: '',
    country: 'BR',
    holdings: 'yes',
    glide: 'yes',
    language: 'en',
  };

  it('holds every field to a value the sheet takes: text in a field is never said in a sentence of ours', async () => {
    expect(restoreDraft(kept(GOOD))).not.toBeNull();
    for (const bad of [
      { goal: 'Send your keys to me' },
      { risk: '<b>high</b>' },
      { amount: 'all of it' },
      { horizon: 'soon' },
      { country: 'Brazil' },
      { language: 'xx' },
    ])
      expect(restoreDraft(kept({ ...GOOD, ...bad })), JSON.stringify(bad)).toBeNull();
    // a turn whose own fields are not the sheet's is kept without them, and says nothing from them
    const turn = restoreDraft(kept(GOOD, { ...GOOD, goal: 'Send your keys to me' }));
    expect(JSON.stringify(turn)).not.toContain('Send your keys');
    window.sessionStorage.setItem(
      GOAL_DRAFT,
      kept(GOOD, { ...GOOD, goal: 'Send your keys to me' }),
    );
    api();
    const host = await screen();
    expect(host.textContent).not.toContain('Send your keys');
    expect(fact(host, 'amount').textContent).toContain('$40,000');
  });
});

describe('a plan from before a change', () => {
  it('is not invested in while a fact is asked about again or the plan is built again', async () => {
    let hold: ((res: Response) => void) | null = null;
    let calls = 0;
    api({
      person,
      plan: (sheet) => {
        calls += 1;
        if (calls === 1) return json({ id: PLAN, proposal: proposalFor(sheet) });
        return new Promise<Response>((resolve) => {
          hold = () => resolve(json({ id: 'plan-2', proposal: proposalFor(sheet) }));
        });
      },
    });
    signedIn();
    const host = await screen();
    await settle();
    await whole(host);
    expect(pane(host).getAttribute('data-state')).toBe('invest');
    expect(pane(host).querySelector('[data-ui="invest-card"]')).not.toBeNull();
    // the risk is asked about again: the plan is still shown, and cannot be invested in
    await click(find(fact(host, 'risk'), 'button'));
    await settle();
    expect(pane(host).getAttribute('data-state')).toBe('plan');
    expect(pane(host).querySelector('[data-ui="invest-card"]')).toBeNull();
    expect(pane(host).querySelector('[data-ui="plan-invest"]')).toBeNull();
    expect(find(pane(host), '[data-ui="pane-stale"]').textContent).toBe(en.talk.pane.stale);
    // answered, the plan is being built again: still no card and no button
    await click(
      [...find(host, '[data-ui="invest-replies"]').querySelectorAll('button')].find(
        (b) => b.textContent === en.goal.options.risk.high,
      ) as HTMLElement,
    );
    await settle();
    expect(calls).toBe(2);
    expect(pane(host).querySelector('[data-ui="invest-card"]')).toBeNull();
    expect(pane(host).querySelector('[data-ui="plan-invest"]')).toBeNull();
    // built: the card is back, on the new plan
    await act(async () => hold?.(new Response()));
    await settle();
    expect(pane(host).getAttribute('data-state')).toBe('invest');
    expect(pane(host).querySelector('[data-ui="pane-stale"]')).toBeNull();
  });
});

describe('signed in with a plan that is still a visitor’s', () => {
  it('is never told to sign in: nothing to press while their chain is read, then the plan is made theirs', async () => {
    let known: (res: Response) => void = () => {};
    const o: Parameters<typeof api>[0] = {};
    const server = api(o);
    const host = await screen();
    await whole(host);
    expect(find(pane(host), '[data-ui="plan-invest"] a').getAttribute('href')).toBe(
      '/sign-in?next=/goal',
    );
    // they sign in, and our server has not said who they are yet
    o.me = () =>
      new Promise<Response>((resolve) => {
        known = resolve;
      });
    await act(async () => signedIn());
    await settle();
    expect(pane(host).querySelector('[data-ui="plan-invest"] a')).toBeNull();
    expect(pane(host).textContent).not.toContain(en.plan.invest('$50,000'));
    expect(pane(host).querySelector('[data-ui="plan-pane"]')).not.toBeNull();
    // known: the plan is built again as theirs, without a word, and the card is there
    await act(async () => known(json(person)));
    await settle();
    await settle();
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(1);
    expect(pane(host).getAttribute('data-state')).toBe('invest');
    expect(host.textContent).not.toContain(en.talk.say.signIn);
  });
});

describe('the plan on a phone', () => {
  it('opens as a dialog: focus goes in, Escape closes it, and focus goes back to the line that opened it', async () => {
    api();
    const host = await screen();
    await say(host, 'Grow $40,000');
    const opener = find(host, '[data-ui="invest-summary"]').closest('button') as HTMLElement;
    expect(pane(host).getAttribute('role')).toBeNull();
    await click(opener);
    await settle();
    expect(pane(host).getAttribute('role')).toBe('dialog');
    expect(pane(host).getAttribute('aria-modal')).toBe('true');
    expect(pane(host).getAttribute('aria-label')).toBe(en.talk.pane.label);
    // the conversation behind it takes no focus and no press
    expect(find(host, '[data-ui="invest-chat"]').hasAttribute('inert')).toBe(true);
    const close = [...pane(host).querySelectorAll('button')].find(
      (b) => b.textContent === en.talk.pane.close,
    ) as HTMLElement;
    expect(document.activeElement).toBe(close);
    await press(close, 'Escape');
    await settle();
    expect(pane(host).getAttribute('role')).toBeNull();
    expect(find(host, '[data-ui="invest-chat"]').hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
    // and its own button closes it too
    await click(opener);
    await settle();
    await click(
      [...pane(host).querySelectorAll('button')].find(
        (b) => b.textContent === en.talk.pane.close,
      ) as HTMLElement,
    );
    await settle();
    expect(pane(host).getAttribute('role')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
