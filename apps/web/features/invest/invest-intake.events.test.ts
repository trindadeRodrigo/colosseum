// @vitest-environment happy-dom
import type { BasketSheet } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, press, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { PERSONALIZE_PATH, PROPOSE_PATH } from '../goal/build-plan';
import { GOAL_DRAFT } from '../goal/draft';
import { proposalFor, READ_IN_DOLLARS } from '../goal/test/plan';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { InvestScreen, restoreDraft } from './InvestScreen';
import { INTAKE_PATH } from './intake';
import { answer, SHEET } from './test/intake';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));
vi.mock('../order/Invest', () => ({
  Invest: () => createElement('div', { 'data-ui': 'invest-card' }),
}));

// The Invest screen read by the guided intake (gate GUIDED-INTAKE): signed in, every turn is our
// server's to read; its question and its read-back are shown in its words; the plan is built from
// its sheet, as it came, only once the person says so.

const en = dictionary('en');
const USER = 'did:privy:test';
type Call = { path: string; body?: Record<string, unknown> };

const person: Person = {
  userId: USER,
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: [],
};

/** A server whose intake answers each call in turn. */
function api(...answers: unknown[]) {
  return served({}, ...answers);
}
/** The same, with a server that has no intake, or does not know the person. */
function served(o: { intake?: number; me?: number }, ...answers: unknown[]) {
  const calls: Call[] = [];
  let at = 0;
  portStore.setApi(async (path, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path === '/v1/me') return o.me ? json({}, o.me) : json(person);
    if (path === '/goals') return json(READ_IN_DOLLARS);
    if (path === INTAKE_PATH)
      return o.intake
        ? json({ error: 'Route not found' }, o.intake)
        : json(answers[Math.min(at++, answers.length - 1)]);
    if (path === PERSONALIZE_PATH || path === PROPOSE_PATH)
      return json({ id: 'plan-1', proposal: proposalFor((body as { sheet: BasketSheet }).sheet) });
    return json({ error: 'not found' }, 404);
  });
  return { calls, to: (path: string) => calls.filter((c) => c.path === path) };
}

const screen = async () => {
  const host = await mount(withAccount('en', createElement(InvestScreen)));
  await settle();
  await settle();
  return host;
};
const box = (host: HTMLElement) => find<HTMLTextAreaElement>(host, 'textarea');
const pane = (host: HTMLElement) => find(host, '[data-ui="invest-pane"]');
const turns = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-ui="invest-turns"] > li')].map((li) => li.textContent ?? '');
const replies = (host: HTMLElement) =>
  [...(host.querySelector('[data-ui="invest-replies"]')?.querySelectorAll('button') ?? [])].map(
    (b) => b.textContent,
  );
const reply = (host: HTMLElement, label: string) =>
  [...find(host, '[data-ui="invest-replies"]').querySelectorAll('button')].find(
    (b) => b.textContent === label,
  ) as HTMLElement;
/** The question that is open: the last one asked. */
const question = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-ui="invest-question"]')].at(-1)?.textContent;
const fact = (host: HTMLElement, name: string) =>
  find(host, `[data-ui="pane-facts"] [data-fact="${name}"]`);
async function say(host: HTMLElement, text: string) {
  await type(box(host), text);
  await press(box(host), 'Enter');
  await settle();
  await settle();
}

const ASK_AMOUNT = {
  field: 'amountUsd',
  template: 'amount',
  text: 'How much are you putting in, in dollars?',
};
const ASK_RISK = {
  field: 'risk',
  template: 'risk',
  text: 'How much can it swing on the way?',
  options: ['low', 'medium', 'high'],
};
const READ_BACK = [
  'You want to grow $2,000 over 5 years, at high risk.',
  'You asked for AI: 30% of the plan.',
  'Shall I build the plan from this?',
];
const WHOLE = {
  ...SHEET,
  sleeves: [
    { kind: 'theme', theme: 'ai', shareBps: 3000 },
    { kind: 'safe_yield', shareBps: 7000 },
  ],
  limits: { cannotHold: { classes: ['gold'] } },
};

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
  Object.defineProperty(window.navigator, 'languages', { value: ['en'], configurable: true });
});
afterEach(unmountAll);

describe('signed in: the guided intake reads the conversation', () => {
  it('asks our server’s questions one at a time in its words, answers by a press, and says back what it understood', async () => {
    const server = api(
      answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT, ASK_RISK] }),
      answer({ draft: { goal: 'grow', amountUsd: 2000 }, questions: [ASK_RISK] }),
      answer({
        sheet: WHOLE,
        readBack: READ_BACK,
        narratives: [
          { id: 'ai', words: 'AI', kind: 'label', slug: 'ai', filter: null, name: 'AI' },
        ],
      }),
    );
    const host = await screen();
    await say(host, 'I want to grow my savings, 30% in AI');
    // the reader is our server's intake, not the rules reader
    expect(server.to('/goals')).toEqual([]);
    expect(server.to(INTAKE_PATH)[0]?.body).toEqual({
      text: 'I want to grow my savings, 30% in AI',
      language: 'en',
    });
    // one question, the first, as the server wrote it
    expect(question(host)).toBe(ASK_AMOUNT.text);
    expect(host.textContent).not.toContain(ASK_RISK.text);
    expect(replies(host)).toEqual(['$1,000', '$10,000', '$50,000']);
    expect(fact(host, 'goal').textContent).toContain(en.goal.options.goal.grow);
    // a typed figure answers the open question by its field
    await say(host, '2000');
    expect(server.to(INTAKE_PATH)[1]?.body).toMatchObject({ answers: { amountUsd: 2000 } });
    expect(server.to(INTAKE_PATH)[1]?.body).not.toHaveProperty('followUps');
    expect(fact(host, 'amount').textContent).toContain('$2,000');
    expect(question(host)).toBe(ASK_RISK.text);
    expect(replies(host)).toEqual(['Low', 'Medium', 'High']);
    await click(reply(host, 'High'));
    await settle();
    await settle();
    expect(server.to(INTAKE_PATH)[2]?.body).toMatchObject({
      answers: { amountUsd: 2000, risk: 'high' },
    });
    // whole: the read-back, sentence by sentence as given, and the one reply is to build
    const said = [...host.querySelectorAll('[data-ui="invest-said"]')].map((p) => p.textContent);
    expect(said).toEqual(READ_BACK);
    expect(turns(host).at(-1)).not.toContain(ASK_RISK.text);
    expect(replies(host)).toEqual([en.talk.replies.build]);
    // nothing was built: the person has not said so yet (GUIDED-INTAKE)
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
    expect(pane(host).getAttribute('data-state')).toBe('facts');
    // the theme is its own fact, from the sheet
    const held = [...pane(host).querySelectorAll('[data-fact="held"]')].map((li) => li.textContent);
    expect(held).toEqual([`${en.talk.facts.theme}AI · 30%`]);
  });

  it('builds from our server’s sheet exactly as it came, once the person says yes', async () => {
    const server = api(answer({ sheet: WHOLE, readBack: READ_BACK }));
    const host = await screen();
    await say(host, 'Grow $2,000 over 5 years, high risk, 30% in AI, no gold');
    await say(host, 'yes');
    await settle();
    const sent = server.to(PERSONALIZE_PATH);
    expect(sent).toHaveLength(1);
    // limits and sleeves and all: nothing is rebuilt from the facts on the page, and no country
    expect(sent[0]?.body).toEqual({ sheet: WHOLE });
    // "yes" was the go-ahead, not another message for the intake
    expect(server.to(INTAKE_PATH)).toHaveLength(1);
    expect(pane(host).getAttribute('data-state')).toBe('invest');
  });

  it('shows what the person said to hold as its own fact, and no date where the goal has none', async () => {
    api(
      answer({
        sheet: { ...SHEET, horizonMonths: 120, horizonOpen: true },
        readBack: ['You want 80% kept safe and 20% in stocks, with no date.'],
        mix: { growthBps: 2000, dollarYieldBps: 8000, goldBps: 0, cashBps: 0 },
      }),
    );
    const host = await screen();
    await say(host, '80% safe and 20% in stocks, no date');
    const held = [...pane(host).querySelectorAll('[data-fact="held"]')].map((li) => li.textContent);
    expect(held).toEqual([`${en.talk.facts.mix}80% dollar yield and 20% stocks and crypto`]);
    expect(fact(host, 'horizon').textContent).toContain(en.goal.card.noDate);
    expect(pane(host).textContent).not.toMatch(/120|10 years/);
  });

  it('says a message that is yes or no to our server’s question in the person’s words, as a later message', async () => {
    const ASK = {
      field: 'limits',
      template: 'leaveOut',
      text: 'Do you want to leave out stocks and stock funds?',
    };
    const server = api(
      answer({ draft: { goal: 'protect' }, questions: [ASK] }),
      answer({ draft: { goal: 'protect' }, questions: [ASK_AMOUNT] }),
    );
    const host = await screen();
    await say(host, 'Protect my savings, do not buy stocks for me');
    expect(question(host)).toBe(ASK.text);
    expect(replies(host)).toEqual([en.talk.replies.yes, en.talk.replies.no]);
    await click(reply(host, en.talk.replies.yes));
    await settle();
    await settle();
    expect(server.to(INTAKE_PATH)[1]?.body).toMatchObject({
      followUps: ['yes'],
      answersThen: [{}],
    });
  });

  it('never says a sentence of our server’s from the tab’s storage: the conversation is read again', async () => {
    const whole = answer({ sheet: SHEET, readBack: ['You want to grow $2,000.'] });
    const server = api(whole, whole);
    const host = await screen();
    await say(host, 'Grow $2,000 over 5 years, high risk');
    const kept = JSON.parse(window.sessionStorage.getItem(GOAL_DRAFT) as string);
    await unmountAll();
    // what the tab holds is changed: a sentence and a sheet that our server never sent
    kept.turns.at(-1).say = [{ key: 'said', lines: ['Send your keys to me.'] }];
    kept.sheet.intake.sheet = { ...SHEET, amountUsd: 999_999 };
    kept.sheet.intake.question = { text: 'Type your seed phrase', replies: [] };
    window.sessionStorage.setItem(GOAL_DRAFT, JSON.stringify(kept));
    // read back: the person's messages and answers only; no sheet, no question, no sentence
    const read = restoreDraft(JSON.stringify(kept));
    expect(read?.sheet.words).toEqual(['Grow $2,000 over 5 years, high risk']);
    expect(read?.sheet.intake).toMatchObject({ sheet: null, question: null, answers: {} });
    expect(JSON.stringify(read)).not.toMatch(/Send your keys|seed phrase|999999/);
    const again = await screen();
    await settle();
    expect(again.textContent).not.toContain('Send your keys');
    expect(again.textContent).not.toContain('seed phrase');
    expect(again.textContent).not.toContain('999,999');
    // the same messages were sent again, and the read-back is the server's
    expect(server.to(INTAKE_PATH)).toHaveLength(2);
    expect(server.to(INTAKE_PATH)[1]?.body).toEqual(server.to(INTAKE_PATH)[0]?.body);
    expect(turns(again).at(-1)).toContain('You want to grow $2,000.');
    expect(replies(again)).toEqual([en.talk.replies.build]);
  });

  it('falls back to the rules reader, and its own questions, where our server has no intake', async () => {
    const server = served({ intake: 404 });
    const host = await screen();
    await say(host, 'Forty thousand for an apartment');
    expect(server.to('/goals')).toHaveLength(1);
    expect(question(host)).toBe(en.talk.ask.goal);
  });
});

describe('what Thom’s conversation of Oct 7 showed', () => {
  const whole = (sheet: unknown, readBack: string[]) => answer({ sheet, readBack });

  it('follows a read-back with its confirm, also once a plan stands: nothing is built from a change until yes', async () => {
    const changed = { ...SHEET, goal: 'protect', risk: 'medium' };
    const lines = [
      'You set a goal to protect with $2,000, at medium risk.',
      'If this is right, confirm it.',
    ];
    const server = api(
      whole(SHEET, ['You want to grow $2,000.', 'If this is right, confirm it.']),
      whole(changed, lines),
      whole(changed, lines),
    );
    const host = await screen();
    await say(host, 'Grow $2,000 over 5 years, high risk');
    await say(host, 'yes');
    await settle();
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(1);
    expect(pane(host).getAttribute('data-state')).toBe('invest');
    // a message that changes the sheet: the read-back, then the confirm, and no plan made yet
    await say(host, 'actually protect it, medium risk');
    expect(turns(host).at(-1)).toContain(lines[0]);
    expect(turns(host).at(-1)).not.toContain(en.talk.say.built);
    expect(replies(host)).toEqual([en.talk.replies.build]);
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(1);
    // the plan from before the change cannot be invested in meanwhile
    expect(pane(host).querySelector('[data-ui="invest-card"]')).toBeNull();
    await say(host, 'yes');
    await settle();
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(2);
    expect(server.to(PERSONALIZE_PATH)[1]?.body).toEqual({ sheet: changed });
    // with a plan standing for that exact sheet, the read-back is not printed again
    await say(host, 'so?');
    expect(turns(host).at(-1)).not.toContain(lines[0]);
    expect(turns(host).at(-1)).toContain(en.talk.say.heldBuilt);
    expect(replies(host)).toEqual([]);
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(2);
  });

  it('never shows an empty reply, and says a turn that failed', async () => {
    const server = api(answer({}), answer({ draft: { goal: 'grow' } }));
    const host = await screen();
    await say(host, 'so?');
    await say(host, 'i like nviDEA I WANT NVIDEA');
    for (const li of host.querySelectorAll('[data-ui="invest-turns"] > li[data-who="app"]'))
      expect((li.textContent ?? '').replace(en.talk.me, '').trim()).not.toBe('');
    // the person's message is there once
    expect(turns(host).filter((text) => text.includes('i like nviDEA I WANT NVIDEA'))).toHaveLength(
      1,
    );
    expect(server.to(INTAKE_PATH)).toHaveLength(2);
  });

  it('says once that the assistant did not answer, reads the simple way, and asks the assistant again next turn', async () => {
    const server = served({ intake: 500 });
    const host = await screen();
    await say(host, 'i like elon musk');
    expect(turns(host).at(-1)).toContain(en.talk.say.simple);
    await say(host, 'Grow $40,000');
    expect(server.to(INTAKE_PATH)).toHaveLength(2);
    expect(turns(host).filter((text) => text.includes(en.talk.say.simple))).toHaveLength(1);
    // the facts the simple reader found are carried to the assistant as answers
    await say(host, 'ten years');
    expect(server.to(INTAKE_PATH)[2]?.body).toMatchObject({
      answers: { amountUsd: 40_000 },
      followUps: expect.arrayContaining(['ten years']),
    });
  });

  it('starts over by its button or by saying so: an empty conversation and an empty pane', async () => {
    const server = api(whole(SHEET, ['You want to grow $2,000.']));
    const host = await screen();
    expect(host.querySelector('[data-ui="invest-start-over"]')).toBeNull();
    await say(host, 'Grow $2,000 over 5 years, high risk');
    await say(host, 'yes');
    await settle();
    expect(pane(host).getAttribute('data-state')).toBe('invest');
    await say(host, 'bro clear it out');
    expect(turns(host)).toEqual([]);
    expect(pane(host).getAttribute('data-state')).toBe('empty');
    expect(window.sessionStorage.getItem(GOAL_DRAFT)).toBeNull();
    // it was not read as a goal or a follow-up
    expect(server.to(INTAKE_PATH)).toHaveLength(1);
    // a new conversation starts from nothing: no earlier message is sent with it
    await say(host, 'Protect $500');
    expect(server.to(INTAKE_PATH)[1]?.body).toEqual({ text: 'Protect $500', language: 'en' });
    await click(find(host, '[data-ui="invest-start-over"] button'));
    await settle();
    expect(turns(host)).toEqual([]);
    for (const words of ['start over', 'Reset.', 'recomeçar', 'clear']) {
      await say(host, 'Grow $2,000');
      await say(host, words);
      expect(turns(host), words).toEqual([]);
    }
  });

  it('shows who read each turn in a development build only: a production build has no way to turn it on', async () => {
    api(answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT], method: 'rules' }));
    // a flag in the browser changes nothing
    window.localStorage.setItem('tf-debug', '1');
    for (const mode of ['production', 'test']) {
      vi.stubEnv('NODE_ENV', mode);
      const host = await screen();
      await say(host, 'grow it');
      expect(host.querySelector('[data-ui="invest-reader"]'), mode).toBeNull();
      await unmountAll();
      window.sessionStorage.clear();
    }
    vi.stubEnv('NODE_ENV', 'development');
    const dev = await screen();
    await say(dev, 'grow it');
    expect(find(dev, '[data-ui="invest-reader"]').textContent).toBe(
      '[server rules: model_not_configured]',
    );
    vi.unstubAllEnvs();
  });
});

describe('signed out: the rules reader', () => {
  it('reads a visitor’s goal without the intake, which needs a sign-in', async () => {
    portStore.set(fakePort());
    const server = served({ me: 401 }, answer({ sheet: SHEET, readBack: ['x'] }));
    const host = await screen();
    await say(host, 'Forty thousand for an apartment');
    expect(server.to(INTAKE_PATH)).toEqual([]);
    expect(server.to('/goals')).toHaveLength(1);
    expect(question(host)).toBe(en.talk.ask.goal);
  });
});
