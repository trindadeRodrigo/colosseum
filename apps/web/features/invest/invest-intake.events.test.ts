// @vitest-environment happy-dom
import type { BasketSheet } from '@colosseum/schemas';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, press, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { ChainSwitch } from '../account/ChainSwitch';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { PERSONALIZE_PATH, PROPOSE_PATH } from '../goal/build-plan';
import { GOAL_DRAFT } from '../goal/draft';
import { proposalFor, READ_IN_DOLLARS } from '../goal/test/plan';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { InvestScreen, restoreDraft } from './InvestScreen';
import { INTAKE_PATH } from './intake';
import * as guidedReader from './intake-conversation';
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
/** Exact expected wire, including the additive capability and chronological question origins. */
function wire(body: Record<string, unknown> | Record<string, unknown>[]): unknown {
  if (Array.isArray(body)) return body.map((entry) => wire(entry));
  const later = (body.followUps ?? []) as string[];
  return { dialogueVersion: 1, questionThen: later.map(() => null), ...body };
}

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
    if (path === INTAKE_PATH) {
      const next = answers[Math.min(at++, answers.length - 1)];
      return o.intake
        ? json({ error: 'Route not found' }, o.intake)
        : typeof next === 'function'
          ? next()
          : json(next);
    }
    if (path === PERSONALIZE_PATH || path === PROPOSE_PATH)
      return json({ id: 'plan-1', proposal: proposalFor((body as { sheet: BasketSheet }).sheet) });
    return json({ error: 'not found' }, 404);
  });
  return { calls, to: (path: string) => calls.filter((c) => c.path === path) };
}

const screen = async (lang: 'en' | 'pt' = 'en') => {
  const host = await mount(withAccount(lang, createElement(InvestScreen)));
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
  it.each([
    [
      'en',
      'i like elon',
      'When you say “i like elon”, is there a business or industry you want this plan to reflect? Tell me which one.',
      'I want to invest in electric vehicle businesses',
    ],
    [
      'pt',
      'eu gosto do elon',
      'Quando você diz “eu gosto do elon”, há um negócio ou setor que você quer refletir neste plano? Diga qual.',
      'Quero investir em negócios de veículos elétricos',
    ],
  ] as const)(
    'keeps a contextual interest question unresolved through reload and resumes normal intake only after explicit business intent (%s)',
    async (lang, text, contextual, business) => {
      const interest = {
        ...answer({
          questions: [
            {
              field: 'themes',
              template: 'interestClarification',
              text: contextual,
              options: [lang === 'en' ? 'Ignore that interest.' : 'Ignore esse interesse.'],
            },
          ],
        }),
        language: lang,
      };
      const server = api(interest, interest, {
        ...answer({ draft: { goal: 'grow' }, questions: [ASK_AMOUNT] }),
        language: lang,
      });
      let host = await screen(lang);
      await say(host, text);
      expect(question(host)).toBe(contextual);
      expect(replies(host)).toEqual([
        lang === 'en' ? 'Ignore that interest.' : 'Ignore esse interesse.',
      ]);
      expect(host.querySelector('[data-ui="pane-facts"]')).toBeNull();
      expect(host.querySelector('[data-ui="plan-pane"]')).toBeNull();
      expect(host.querySelector('[data-ui="invest-card"]')).toBeNull();
      expect(turns(host).join(' ')).not.toMatch(/Tesla|TSLA|NVDA/);
      expect(server.to(PERSONALIZE_PATH)).toEqual([]);
      expect(server.to(PROPOSE_PATH)).toEqual([]);
      const restored = restoreDraft(window.sessionStorage.getItem(GOAL_DRAFT));
      expect(restored?.sheet.words).toEqual([text]);
      expect(restored?.sheet.intake?.sheet).toBeNull();
      expect(restored?.sheet.intake?.question).toBeNull();
      await unmountAll();
      host = await screen(lang);
      expect(question(host)).toBe(contextual);
      expect(replies(host)).toEqual([
        lang === 'en' ? 'Ignore that interest.' : 'Ignore esse interesse.',
      ]);
      expect(server.to(PERSONALIZE_PATH)).toEqual([]);
      await say(host, business);
      expect(question(host)).toBe(ASK_AMOUNT.text);
      expect(server.to(INTAKE_PATH).at(-1)?.body).toEqual(
        wire({
          text,
          language: lang,
          followUps: [business],
          questionThen: ['interestClarification'],
          answersThen: [{}],
        }),
      );
      expect(server.to(PERSONALIZE_PATH)).toEqual([]);
      expect(host.querySelector('[data-ui="invest-card"]')).toBeNull();
    },
  );

  it.each(['en', 'pt'] as const)(
    'keeps old funding paused through contextual yes, reader failure, legacy reply and reload, then confirms actual resolved terms (%s)',
    async (lang) => {
      const t = dictionary(lang);
      const initial = 'Grow $2000 for five years at high risk';
      const words = lang === 'en' ? 'i like elon' : 'eu gosto do elon';
      const marker = { quote: words, sourceTurn: 1 };
      const contextual = {
        field: 'themes',
        template: 'interestClarification',
        text:
          lang === 'en'
            ? 'Which business do you want this plan to reflect?'
            : 'Qual negócio você quer refletir neste plano?',
      };
      const server = api(
        { ...answer({ sheet: SHEET, readBack: READ_BACK }), pendingInterest: null },
        { ...answer({ draft: SHEET, questions: [contextual] }), pendingInterest: marker },
        () => json({}, 500),
        answer({ sheet: SHEET, readBack: READ_BACK }), // legacy cannot discharge a marker
        answer({ sheet: SHEET, readBack: READ_BACK }), // another yes must keep its contextual origin
        { ...answer({ draft: SHEET, questions: [contextual] }), pendingInterest: marker },
        {
          ...answer({
            sheet: { ...SHEET, amountUsd: 3000 },
            readBack: ['Grow $3000 for five years at high risk.'],
          }),
          pendingInterest: null,
        },
      );
      let host = await screen(lang);
      await say(host, initial);
      await click(reply(host, t.talk.replies.build));
      await settle();
      expect(host.querySelector('[data-ui="invest-card"]')).not.toBeNull();
      await say(host, words);
      await say(host, lang === 'en' ? 'yes' : 'sim');
      expect(host.querySelector('[data-ui="invest-card"]')).toBeNull();
      expect(host.querySelector('[data-ui="pane-stale"]')).not.toBeNull();
      expect(replies(host)).not.toContain(t.talk.replies.build);
      expect(server.to(INTAKE_PATH).at(-1)?.body).toMatchObject({
        dialogueVersion: 1,
        pendingInterest: marker,
        followUps: [words, lang === 'en' ? 'yes' : 'sim'],
        questionThen: [null, 'interestClarification'],
        answersThen: [{}, {}],
      });
      await say(host, lang === 'en' ? 'thanks' : 'obrigado');
      expect(host.querySelector('[data-ui="invest-card"]')).toBeNull();
      await say(host, lang === 'en' ? 'yes' : 'sim');
      expect(host.querySelector('[data-ui="invest-card"]')).toBeNull();
      expect(server.to(INTAKE_PATH).at(-1)?.body).toMatchObject({
        questionThen: [
          null,
          'interestClarification',
          'interestClarification',
          'interestClarification',
        ],
      });
      const stored = sessionStorage.getItem(GOAL_DRAFT);
      const restored = restoreDraft(stored);
      expect(restored?.sheet.intake?.pendingInterest).toEqual(marker);
      expect(restored?.sheet.intake?.questionThen).toEqual([
        null,
        'interestClarification',
        'interestClarification',
        'interestClarification',
      ]);
      expect(restored?.sheet.intake?.sheet).toBeNull();
      expect(restored?.sheet.intake?.question).toBeNull();
      await unmountAll();
      host = await screen(lang);
      expect(host.querySelector('[data-ui="invest-card"]')).toBeNull();
      expect(server.to(PERSONALIZE_PATH)).toHaveLength(1);
      expect(server.to(INTAKE_PATH).at(-1)?.body).toMatchObject({
        pendingInterest: marker,
        followUps: [
          words,
          lang === 'en' ? 'yes' : 'sim',
          lang === 'en' ? 'thanks' : 'obrigado',
          lang === 'en' ? 'yes' : 'sim',
        ],
        questionThen: [
          null,
          'interestClarification',
          'interestClarification',
          'interestClarification',
        ],
      });
      await say(host, 'Grow $3000 for five years at high risk in electric vehicle businesses');
      expect(replies(host)).toContain(t.talk.replies.build);
      expect(host.querySelector('[data-ui="invest-card"]')).toBeNull();
      await click(reply(host, t.talk.replies.build));
      await settle();
      expect(server.to(PERSONALIZE_PATH)).toHaveLength(2);
      expect(server.to(PERSONALIZE_PATH).at(-1)?.body).toEqual({
        sheet: { ...SHEET, amountUsd: 3000 },
      });
      expect(host.querySelector('[data-ui="invest-card"]')).not.toBeNull();
      expect(server.to('/goals')).toEqual([]);
      expect(server.calls.some((call) => /\/orders|\/transactions/.test(call.path))).toBe(false);
    },
  );

  it.each(['en', 'pt'] as const)(
    'lets the person ignore the interest even when the model is unavailable, then confirms the actual unchanged read-back (%s)',
    async (lang) => {
      const t = dictionary(lang);
      const words = lang === 'en' ? 'i like elon' : 'eu gosto do elon';
      const ignore = lang === 'en' ? 'Ignore that interest.' : 'Ignore esse interesse.';
      const marker = { quote: words, sourceTurn: 1 };
      const server = api(
        { ...answer({ sheet: SHEET, readBack: READ_BACK }), pendingInterest: null },
        {
          ...answer({
            questions: [
              {
                field: 'themes',
                template: 'interestClarification',
                text: 'Which business?',
                options: [ignore],
              },
            ],
          }),
          pendingInterest: marker,
        },
        {
          ...answer({ method: 'rules', sheet: SHEET, readBack: READ_BACK }),
          pendingInterest: null,
        },
      );
      const host = await screen(lang);
      await say(host, 'Grow $2000 for five years at high risk');
      await click(reply(host, t.talk.replies.build));
      await settle();
      await say(host, words);
      expect(host.querySelector('[data-ui="invest-card"]')).toBeNull();
      await click(reply(host, ignore));
      await settle();
      expect(server.to(INTAKE_PATH).at(-1)?.body).toMatchObject({
        pendingInterest: marker,
        followUps: [words, ignore],
        questionThen: [null, 'interestClarification'],
        answersThen: [{}, {}],
      });
      expect(replies(host)).toContain(t.talk.replies.build);
      expect(host.querySelector('[data-ui="invest-card"]')).toBeNull();
      expect(server.to(PERSONALIZE_PATH)).toHaveLength(1);
      await click(reply(host, t.talk.replies.build));
      await settle();
      expect(server.to(PERSONALIZE_PATH).at(-1)?.body).toEqual({ sheet: SHEET });
      expect(server.to(PERSONALIZE_PATH)).toHaveLength(2);
      expect(host.querySelector('[data-ui="invest-card"]')).not.toBeNull();
    },
  );

  it('holds an already built plan while a server interest question has no validated sheet', async () => {
    const interest = {
      field: 'themes',
      template: 'interestClarification',
      text: 'When you say “i like elon”, is there a business or industry you want this plan to reflect? Tell me which one.',
    };
    const server = api(
      answer({ sheet: SHEET, readBack: READ_BACK }),
      answer({ questions: [interest] }),
      answer({
        sheet: { ...SHEET, amountUsd: 3000 },
        readBack: ['Grow $3000 for five years, at high risk.'],
      }),
    );
    const host = await screen();
    await say(host, 'Grow $2000 for five years at high risk');
    await click(reply(host, en.talk.replies.build));
    await settle();
    expect(host.querySelector('[data-ui="invest-card"]')).not.toBeNull();
    await say(host, 'i like elon');
    expect(question(host)).toBe(interest.text);
    expect(host.querySelector('[data-ui="invest-card"]')).toBeNull();
    expect(host.querySelector('[data-ui="pane-stale"]')).not.toBeNull();
    expect(replies(host)).not.toContain(en.talk.replies.build);
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(1);
    await say(
      host,
      'I want to invest $3000 in electric vehicle businesses for five years at high risk',
    );
    expect(turns(host).at(-1)).not.toContain(interest.text);
    expect(replies(host)).toContain(en.talk.replies.build);
    expect(host.querySelector('[data-ui="invest-card"]')).toBeNull();
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(1);
    await click(reply(host, en.talk.replies.build));
    await settle();
    expect(server.to(PERSONALIZE_PATH).at(-1)?.body).toEqual({
      sheet: { ...SHEET, amountUsd: 3000 },
    });
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(2);
    expect(host.querySelector('[data-ui="invest-card"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="pane-stale"]')).toBeNull();
    expect(server.calls.some((c) => /\/orders|\/transactions/.test(c.path))).toBe(false);
  });

  it.each(['en', 'pt'] as const)(
    'pauses old income funding before an allocation amendment is read, keeps its bound unresolved through growth, and requires confirmation after withdrawal (%s)',
    async (lang) => {
      const t = dictionary(lang);
      const income: BasketSheet = {
        ...SHEET,
        goal: 'income',
        amountUsd: 1000,
        incomeTargetUsdMonthly: 300,
        horizonOpen: true,
      };
      const growth: BasketSheet = { ...SHEET, amountUsd: 1000, horizonOpen: true };
      const request =
        lang === 'en'
          ? 'i think i want way more stocks on them. like at least40%'
          : 'acho que quero bem mais ações nesses planos, pelo menos40%';
      let release!: (value: Response) => void;
      let reads = 0;
      const builtSheets: BasketSheet[] = [];
      portStore.setApi(async (path, init) => {
        if (path === '/v1/me') return json(person);
        if (path === INTAKE_PATH) {
          reads++;
          if (reads === 2)
            return new Promise<Response>((resolve) => {
              release = resolve;
            });
          return json(
            answer({
              sheet: reads >= 3 ? growth : income,
              readBack:
                reads >= 3
                  ? ['The growth goal has no monthly income target.']
                  : ['The income goal is read back.'],
            }),
          );
        }
        if (path === PERSONALIZE_PATH) {
          const body = JSON.parse(String(init?.body)) as { sheet: BasketSheet };
          builtSheets.push(body.sheet);
          return json({ id: `plan-${builtSheets.length}`, proposal: proposalFor(body.sheet) });
        }
        return json({}, 404);
      });
      const host = await screen(lang);
      await say(host, 'Income $300 monthly from $1000, high risk, no date');
      await click(reply(host, t.talk.replies.build));
      await settle();
      expect(host.querySelector('[data-ui="invest-card"]')).not.toBeNull();
      await type(box(host), request);
      await press(box(host), 'Enter');
      expect(host.querySelector('[data-ui="invest-card"]')).toBeNull();
      expect(host.querySelector('[data-ui="pane-stale"]')).not.toBeNull();
      await act(async () =>
        release(json(answer({ sheet: income, readBack: ['The income goal is read back.'] }))),
      );
      await settle();
      expect(turns(host).at(-1)).toContain(
        t.talk.say.allocation(request, true, lang === 'en' ? 'at least40%' : 'pelo menos40%'),
      );
      expect(host.querySelector('[data-ui="invest-card"]')).toBeNull();
      expect(builtSheets).toEqual([income]);
      const stored = window.sessionStorage.getItem(GOAL_DRAFT);
      const restored = restoreDraft(stored);
      expect(restored?.sheet.allocation).toMatchObject({
        text: request,
        baseline: null,
        minimum: true,
      });
      expect(restored?.sheet.intake?.sheet).toBeNull();
      await click(reply(host, t.talk.replies.growGoal));
      await settle();
      expect(host.querySelector('[data-ui="invest-card"]')).toBeNull();
      expect(replies(host)).not.toContain(t.talk.replies.build);
      expect(builtSheets).toEqual([income]);
      await click(reply(host, t.talk.replies.dropAllocation));
      await settle();
      expect(replies(host)).toContain(t.talk.replies.build);
      expect(builtSheets).toEqual([income]);
      await click(reply(host, t.talk.replies.build));
      await settle();
      expect(builtSheets).toEqual([income, growth]);
      expect(reads).toBe(3);
    },
  );

  it('keeps a vague reader response in the conversation without an empty facts heading', async () => {
    const asked = {
      field: 'goal',
      template: 'goal',
      text: 'What would you like these stocks to do for you?',
      options: ['grow', 'income', 'protect'],
    };
    const server = api(answer({ questions: [asked] }));
    const host = await screen();
    await say(host, 'i want cool stocks');
    expect(server.to(INTAKE_PATH)).toHaveLength(1);
    expect(question(host)).toBe(asked.text);
    expect(turns(host).join(' ')).toContain('i want cool stocks');
    expect(host.querySelector('[data-ui="pane-facts"]')).toBeNull();
    expect(find(host, '[data-ui="invest-screen"]').getAttribute('data-layout')).toBe('intake');
    expect(host.querySelector('[data-ui="invest-summary"]')).toBeNull();
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
  });

  it('renders the capacity explanation without accepting the excessive turn, and Start over clears it', async () => {
    const server = api(answer({ sheet: SHEET, readBack: ['Your accepted goal'] }));
    const host = await screen();
    await say(host, 'x'.repeat(2000));
    for (let i = 0; i < 9; i++) await say(host, 'y'.repeat(2000));
    await say(host, 'z'.repeat(1980));
    expect(server.to(INTAKE_PATH)).toHaveLength(11);
    const storedBefore = JSON.parse(window.sessionStorage.getItem(GOAL_DRAFT) as string);
    await say(host, 'This turn exceeds capacity');
    expect(server.to(INTAKE_PATH)).toHaveLength(11);
    expect(host.querySelector('[data-ui="invest-turns"]')?.textContent).toContain(en.talk.capacity);
    const storedAfter = JSON.parse(window.sessionStorage.getItem(GOAL_DRAFT) as string);
    expect(storedAfter.sheet).toEqual(storedBefore.sheet);
    expect(storedAfter.sheet.words).not.toContain('This turn exceeds capacity');
    await click(find(host, '[data-ui="invest-start-over"] button'));
    expect(host.textContent).not.toContain(en.talk.capacity);
    expect(turns(host)).toHaveLength(0);
    expect(window.sessionStorage.getItem(GOAL_DRAFT)).toBeNull();
  });

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
    expect(server.to(INTAKE_PATH)[0]?.body).toEqual(
      wire({
        text: 'I want to grow my savings, 30% in AI',
        language: 'en',
      }),
    );
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

  it('keeps a long unbroken theme intact in the compact wrapping facts without building a plan', async () => {
    const name = 'UnbrokenThemeName'.repeat(10);
    const server = api(
      answer({
        sheet: WHOLE,
        narratives: [{ id: 'ai', words: name, kind: 'label', slug: 'ai', filter: null, name }],
        readBack: ['Your theme is held as stated.'],
      }),
    );
    const host = await screen();
    await say(host, 'Grow $2,000 over 5 years, high risk, 30% in my theme');
    expect(find(host, '[data-ui="invest-screen"]').getAttribute('data-layout')).toBe('intake');
    const held = find(pane(host), '[data-fact="held"]');
    expect(held.textContent).toBe(`${en.talk.facts.theme}${en.talk.facts.themeShare(name, '30%')}`);
    expect(held.classList.contains('min-w-0')).toBe(true);
    expect(held.classList.contains('max-w-full')).toBe(true);
    expect(held.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
    expect(pane(host).textContent).not.toContain(en.talk.facts.open);
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
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

  it('offers "Make it a growth goal" under the read-back that says stocks are not held for an income goal', async () => {
    const income = { ...SHEET, goal: 'income', incomeTargetUsdMonthly: 300 };
    const line =
      'A plan for a goal of income holds no stocks or crypto, so “100% stocks and crypto” is not held.';
    const server = api(
      {
        ...whole(income, [line, 'If this is right, confirm it.']),
        flags: ['mix_dropped_for_goal'],
      },
      whole(SHEET, ['You want to grow $2,000 over 5 years.', 'If this is right, confirm it.']),
    );
    const host = await screen();
    await say(host, 'income of $300 a month from $2,000, 100% stocks and crypto');
    expect(turns(host).at(-1)).toContain(line);
    // the way out is one press, beside the confirm
    expect(replies(host)).toEqual([en.talk.replies.growGoal, en.talk.replies.build]);
    await click(reply(host, en.talk.replies.growGoal));
    await settle();
    await settle();
    expect(server.to(INTAKE_PATH)[1]?.body).toMatchObject({ answers: { goal: 'grow' } });
    expect(fact(host, 'goal').textContent).toContain(en.goal.options.goal.grow);
    expect(replies(host)).toEqual([en.talk.replies.build]);
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
  });

  it('says what was understood before our server’s question, in this app’s words over the server’s fields', async () => {
    const ASK_GOAL = {
      field: 'goal',
      template: 'goal',
      text: 'What is this money for: to grow it, to earn an income from it, or to protect it?',
      options: ['grow', 'income', 'protect'],
    };
    api(
      answer({
        questions: [ASK_GOAL],
        narratives: [
          { id: 'ai', words: 'AI', kind: 'label', slug: 'ai', filter: null, name: 'AI' },
        ],
      }),
    );
    const host = await screen();
    await say(host, 'i want to invest on the 5 biggest stoks on solana by liquidity');
    const last = turns(host).at(-1) ?? '';
    expect(last).toContain(en.talk.say.heardThemes('AI'));
    expect(last).toContain(en.talk.say.first);
    expect(last.indexOf(en.talk.say.heardThemes('AI'))).toBeLessThan(last.indexOf(ASK_GOAL.text));
    expect(last).not.toMatch(/biggest|stoks/);
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
    expect(server.to(INTAKE_PATH)[1]?.body).toEqual(wire({ text: 'Protect $500', language: 'en' }));
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
    // The flag cannot expose details in production or test builds.
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
    window.localStorage.removeItem('tf-debug');
    const ordinary = await screen();
    await say(ordinary, 'grow it');
    expect(ordinary.querySelector('[data-ui="invest-reader"]')).toBeNull();
    await unmountAll();
    window.sessionStorage.clear();
    window.localStorage.setItem('tf-debug', '1');
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
    expect(server.to(INTAKE_PATH)).toEqual(wire([]));
    expect(server.to('/goals')).toHaveLength(1);
    expect(question(host)).toBe(en.talk.ask.goal);
  });
});

describe('conversation response ownership', () => {
  function delayed(fallback = false) {
    let current = person;
    const pending: Array<(response: Response) => void> = [];
    const chainRequests: string[] = [];
    portStore.setApi(async (path, init) => {
      if (path === '/v1/me') return json(current);
      if (path === '/v1/me/chain') {
        current = { ...current, chain: JSON.parse(String(init?.body)).chain };
        chainRequests.push(current.chain as string);
        return json(current);
      }
      if (path === INTAKE_PATH && fallback) return json({}, 404);
      if (path === (fallback ? '/goals' : INTAKE_PATH))
        return new Promise<Response>((finish) => pending.push(finish));
      return json({}, 404);
    });
    return {
      pending,
      chainRequests,
      switchPerson: async (id: string | null) => {
        current = { ...current, userId: id ?? USER };
        await act(async () =>
          portStore.set(id ? signedInPort(EMBEDDED, { userId: id }) : fakePort()),
        );
        await settle();
      },
      finish: async (index: number, response: Response) => {
        await act(async () => pending[index]?.(response));
        await settle();
      },
    };
  }

  it.each([false, true])(
    'discards a late %s reader after A→B, and cannot release B’s pending read',
    async (fallback) => {
      const server = delayed(fallback);
      const host = await screen();
      await say(host, 'Grow $2,000 over 5 years, high risk');
      expect(server.pending).toHaveLength(1);
      await server.switchPerson('did:privy:other');
      await say(host, 'Grow $40,000 over 10 years, high risk');
      expect(server.pending).toHaveLength(2);
      await server.finish(
        0,
        json(
          fallback
            ? READ_IN_DOLLARS
            : answer({ sheet: SHEET, readBack: ['Earlier account private goal'] }),
        ),
      );
      expect(host.textContent).not.toContain('Earlier account private goal');
      expect(pane(host).textContent).not.toContain('$40,000');
      // The old finally must leave the second request busy: Enter cannot send a third turn.
      await say(host, 'Do not send this while the new read is busy');
      expect(server.pending).toHaveLength(2);
      await server.finish(
        1,
        json(
          fallback
            ? READ_IN_DOLLARS
            : answer({ sheet: SHEET, readBack: ['New account read-back'] }),
        ),
      );
      expect(host.textContent).toContain(fallback ? '$40,000' : 'New account read-back');
    },
  );

  it('discards obsolete catch and finally updates when the reader throws', async () => {
    const original = guidedReader.intakeConversation;
    const reader = vi.spyOn(guidedReader, 'intakeConversation').mockImplementation((...args) => {
      const actual = original(...args);
      return {
        turn: async (input, sheet) => {
          const result = await actual.turn(input, sheet);
          if (input.kind === 'text' && input.text === 'Old throwing goal')
            throw new Error('obsolete turn');
          return result;
        },
      };
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const server = delayed();
      const host = await screen();
      await say(host, 'Old throwing goal');
      await server.switchPerson('did:privy:other');
      await say(host, 'Grow $2,000 over 5 years, high risk');
      await server.finish(0, json(answer({ sheet: SHEET, readBack: ['Obsolete reply'] })));
      expect(log).not.toHaveBeenCalled();
      expect(host.textContent).not.toContain('Obsolete reply');
      await say(host, 'Still busy');
      expect(server.pending).toHaveLength(2);
      await server.finish(1, json(answer({ sheet: SHEET, readBack: ['Current reply'] })));
      expect(host.textContent).toContain('Current reply');
    } finally {
      reader.mockRestore();
      log.mockRestore();
    }
  });

  it('ignores a late failure after sign-out', async () => {
    const server = delayed();
    const host = await screen();
    await say(host, 'Grow $2,000 over 5 years, high risk');
    await server.switchPerson(null);
    await server.finish(0, json({ error: 'old failure' }, 422));
    expect(host.querySelectorAll('[data-ui="invest-turns"] > li')).toHaveLength(0);
  });

  it('discarding a visitor’s late response does not erase their existing words on sign-in', async () => {
    portStore.set(fakePort());
    const server = delayed(true);
    const host = await screen();
    await say(host, 'Visitor’s goal stays');
    expect(server.pending).toHaveLength(1);
    await server.switchPerson(USER);
    await server.finish(0, json(READ_IN_DOLLARS));
    expect(host.textContent).toContain('Visitor’s goal stays');
    expect(host.textContent).not.toContain('$40,000');
  });

  it('can reset while a read is pending, and its old finally does not release a new read', async () => {
    const server = delayed();
    const host = await screen();
    await say(host, 'Old goal');
    await click(find(host, '[data-ui="invest-start-over"] button'));
    await say(host, 'Fresh goal');
    expect(server.pending).toHaveLength(2);
    await server.finish(0, json(answer({ sheet: SHEET, readBack: ['Old goal private reply'] })));
    expect(host.textContent).not.toContain('Old goal private reply');
    await say(host, 'Still busy');
    expect(server.pending).toHaveLength(2);
    await server.finish(1, json(answer({ sheet: SHEET, readBack: ['Fresh goal reply'] })));
    expect(host.textContent).toContain('Fresh goal reply');
  });

  it('drops a pending read after switching chains', async () => {
    const server = delayed();
    const host = await mount(
      withAccount('en', [
        createElement(ChainSwitch, { key: 'chain' }),
        createElement(InvestScreen, { key: 'screen' }),
      ]),
    );
    await settle();
    await settle();
    await say(host, 'Grow $2,000 over 5 years, high risk');
    await click(find(host, '[data-ui="chain-switch"] > button'));
    await click(find(host, '[data-ui="chain-switch-panel"] button[data-chain="robinhood"]'));
    await settle();
    expect(server.chainRequests).toEqual(['robinhood']);
    expect(server.pending).toHaveLength(1);
    await server.finish(0, json(answer({ sheet: SHEET, readBack: ['Old Solana reply'] })));
    expect(host.textContent).not.toContain('Old Solana reply');
  });

  it('ignores a restored replay after the account changes', async () => {
    const seed = api(answer({ sheet: SHEET, readBack: ['Old goal'] }));
    const host = await screen();
    await say(host, 'Grow $2,000 over 5 years, high risk');
    expect(seed.to(INTAKE_PATH)).toHaveLength(1);
    expect(window.sessionStorage.getItem(GOAL_DRAFT)).not.toBeNull();
    await unmountAll();
    const server = delayed();
    const restored = await screen();
    expect(server.pending).toHaveLength(1);
    await server.switchPerson('did:privy:other');
    await say(restored, 'New goal');
    await server.finish(
      0,
      json(answer({ sheet: SHEET, readBack: ['Restored old private reply'] })),
    );
    expect(restored.textContent).not.toContain('Restored old private reply');
    await say(restored, 'Still reading');
    expect(server.pending).toHaveLength(2);
    await server.finish(1, json(answer({ sheet: SHEET, readBack: ['New reply'] })));
    expect(restored.textContent).toContain('New reply');
    // No late update after unmount can overwrite the stored draft for the new screen.
    await say(restored, 'Last pending turn');
    expect(server.pending).toHaveLength(3);
    const saved = window.sessionStorage.getItem(GOAL_DRAFT);
    await unmountAll();
    await server.finish(2, json(answer({ sheet: SHEET, readBack: ['Unmounted reply'] })));
    expect(window.sessionStorage.getItem(GOAL_DRAFT)).toBe(saved);
  });
});

describe('pressed allocation survives the tab round-trip', () => {
  it.each([5000, null])(
    'preserves the person’s %s allocation press through storage, reload and replay',
    async (share) => {
      const half = { growthBps: 5000, dollarYieldBps: 0, goldBps: 0, cashBps: 5000 };
      const server = api(
        answer({
          draft: { goal: 'grow' },
          questions: [{ field: 'mix', template: 'mix', text: 'How much in stocks?' }],
        }),
        answer({ sheet: SHEET, mix: share === null ? null : half, readBack: ['Your allocation'] }),
        answer({
          sheet: SHEET,
          mix: share === null ? null : half,
          readBack: ['Allocation read again'],
        }),
      );
      const host = await screen();
      await say(host, 'I want to grow my savings');
      const choices = find(host, '[data-ui="invest-replies"]').querySelectorAll('button');
      await click(choices[share === null ? 4 : 2] as HTMLElement);
      await settle();
      const held = share === null ? null : half;
      expect(server.to(INTAKE_PATH)[1]?.body?.answers).toEqual({ mix: held });
      const stored = JSON.parse(window.sessionStorage.getItem(GOAL_DRAFT) as string);
      expect(stored.sheet.intake).toHaveProperty('held', held);
      stored.sheet.intake.sheet = { ...SHEET, amountUsd: 999999 };
      stored.sheet.intake.readBack = ['Arbitrary server words'];
      const cleaned = restoreDraft(JSON.stringify(stored));
      expect(cleaned?.sheet.intake).toHaveProperty('held', held);
      expect(cleaned?.sheet.intake?.sheet).toBeNull();
      expect(cleaned?.sheet.intake?.readBack).toBeUndefined();
      await unmountAll();
      window.sessionStorage.setItem(GOAL_DRAFT, JSON.stringify(stored));
      const next = await screen();
      expect(server.to(INTAKE_PATH)[2]?.body?.answers).toEqual({ mix: held });
      expect(next.textContent).not.toContain('Arbitrary server words');
      expect(next.textContent).not.toContain('999,999');
    },
  );

  it('does not restore invalid allocation shares or mistake absent held for explicit none', () => {
    const raw = {
      v: 2,
      turns: [{ who: 'person', text: 'grow' }],
      sheet: {
        fields: {
          goal: 'grow',
          amount: '2000',
          income: '',
          horizon: '60',
          risk: 'high',
          country: '',
          holdings: 'yes',
          glide: 'no',
          language: 'en',
        },
        skipped: [],
        words: ['grow'],
        intake: { answers: {}, answersThen: [] },
      },
    };
    for (const held of [
      undefined,
      { growthBps: -1, dollarYieldBps: 0, goldBps: 0, cashBps: 10001 },
      { growthBps: 0.5, dollarYieldBps: 0, goldBps: 0, cashBps: 9999.5 },
      { growthBps: 5000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 },
    ]) {
      const restored = restoreDraft(
        JSON.stringify({ ...raw, sheet: { ...raw.sheet, intake: { ...raw.sheet.intake, held } } }),
      );
      expect(restored?.sheet.intake).not.toHaveProperty('held');
    }
  });
});
