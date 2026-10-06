// @vitest-environment happy-dom
import type { BasketSheet } from '@colosseum/schemas';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAIN_NAMES } from '../../components/ui/ChainBadge';
import {
  click,
  find,
  fire,
  mount,
  press,
  settle,
  type,
  unmountAll,
} from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import { ChainSwitch } from '../account/ChainSwitch';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { EMBEDDED, fakePort, json, PHANTOM, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { PERSONALIZE_PATH } from './build-plan';
import { GOAL_HANDOFF } from './draft';
import { GoalScreen } from './GoalScreen';
import { FIELD_ID } from './sheet';
import { proposalFor, READ_IN_DOLLARS, READ_IN_REAIS } from './test/plan';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The goal screen with real events: the goal is typed and read, the limits are checked and changed,
// and a plan is asked for only from limits the shared schema parsed. The API is a double: POST /goals
// as `staging` answers it, GET /v1/me, and the route that builds a plan, which is not there yet.

const en = dictionary('en');
// Words the reader here does not read either (pre-read.ts), so what the API's reader leaves empty stays
// empty for the person; the words that do fill it are read in 'the words of a goal fill what the
// reader leaves'.
const GOAL = 'Grow forty thousand for an apartment by June 2028';

type Call = { method: string; path: string; body?: unknown };

function api(options: {
  person?: Person;
  /** What GET /v1/me answers with when there is no person: by default, a server that is not up. */
  me?: number;
  reading?: unknown;
  plan?: (body: unknown) => Response;
}) {
  const calls: Call[] = [];
  let down = false;
  portStore.setApi(async (path, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (down) throw new TypeError('fetch failed');
    if (path === '/goals') return json(options.reading ?? READ_IN_DOLLARS);
    if (path === '/v1/me')
      return options.person ? json(options.person) : json({}, options.me ?? 503);
    // a switch of the current chain (CHAIN-SWITCH)
    if (path === '/v1/me/chain' && method === 'PUT' && options.person) {
      options.person = { ...options.person, chain: body.chain, chainSource: 'picked' };
      return json(options.person);
    }
    // today's API: there is no route that builds a plan
    if (path === PERSONALIZE_PATH)
      return options.plan ? options.plan(body) : json({ error: 'Route not found' }, 404);
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

const onSolana: Person = {
  userId: 'did:privy:test',
  wallets: PHANTOM,
  chain: 'solana',
  chainSource: 'wallet',
  chainOptions: [],
};

const screen = (lang: Lang = 'en') => mount(withAccount(lang, createElement(GoalScreen)));
const box = (host: HTMLElement) => find<HTMLTextAreaElement>(host, 'textarea');
const input = (host: HTMLElement, key: keyof typeof FIELD_ID) =>
  find<HTMLInputElement>(host, `#${FIELD_ID[key]}`);
const buildButton = (host: HTMLElement) => find(host, 'button[data-variant="primary"]');
const sheet = (host: HTMLElement) => host.querySelector('[data-ui="constraint-sheet"]');
const summary = (host: HTMLElement) => host.querySelector('[data-ui="sheet-errors"]');

async function choose(host: HTMLElement, key: keyof typeof FIELD_ID, value: string) {
  const select = find<HTMLSelectElement>(host, `#${FIELD_ID[key]}`);
  select.value = value;
  await fire(select, new Event('change', { bubbles: true }));
}

/** Types the goal and sends it, as a person does. */
async function read(host: HTMLElement, text = GOAL) {
  await type(box(host), text);
  await press(box(host), 'Enter');
  await settle();
}

/** Fills what today's reader leaves empty for a goal in dollars. */
async function fill(host: HTMLElement) {
  await type(input(host, 'amount'), '40,000');
  await type(input(host, 'horizon'), '36');
  await choose(host, 'country', 'BR');
}

/** The browser's languages, as navigator.languages says them. */
function browserSays(languages: string[]) {
  Object.defineProperty(window.navigator, 'languages', { value: languages, configurable: true });
}

beforeEach(() => {
  window.sessionStorage.clear();
  // the chain this browser was last on (CHAIN-SWITCH): each test starts where nobody has chosen
  window.localStorage.removeItem('tf-chain');
  portStore.set(fakePort());
  // a language that names no country, so the country is the person's to state unless a test says
  browserSays(['en']);
});
afterEach(unmountAll);

describe('a goal handed over from the landing page', () => {
  it('is read as the screen opens, once, and taken out of the tab', async () => {
    const server = api({});
    window.sessionStorage.setItem(GOAL_HANDOFF, GOAL);
    const host = await screen();
    await settle();
    expect(server.to('/goals')).toEqual([
      { method: 'POST', path: '/goals', body: { text: GOAL, language: 'en' } },
    ]);
    expect(box(host).value).toBe(GOAL);
    expect(window.sessionStorage.getItem(GOAL_HANDOFF)).toBeNull();
    expect(sheet(host)).not.toBeNull();
  });

  it('is read from the address’s fragment, as a partner’s embed hands it, and the fragment taken out', async () => {
    const server = api({});
    window.history.replaceState(null, '', `/goal#goal=${encodeURIComponent(GOAL)}`);
    const host = await screen();
    await settle();
    expect(server.to('/goals')).toEqual([
      { method: 'POST', path: '/goals', body: { text: GOAL, language: 'en' } },
    ]);
    expect(box(host).value).toBe(GOAL);
    expect(window.location.hash).toBe('');
  });

  it('reads nothing when nothing was handed over', async () => {
    const server = api({});
    await screen();
    await settle();
    expect(server.to('/goals')).toEqual([]);
  });
});

describe('the goal screen, before anything is read', () => {
  it('asks the one question, in the one serif line, with the typing box and three examples', async () => {
    const server = api({});
    const host = await screen();
    expect(find(host, 'h1').textContent).toBe(en.goal.title);
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelectorAll('.font-display')).toHaveLength(1);
    expect(find(host, 'label').textContent).toBe(en.goal.composer.label);
    const examples = find(host, `ul[aria-label="${en.goal.examples.label}"]`);
    expect([...examples.querySelectorAll('button')].map((b) => b.textContent)).toEqual(
      en.goal.examples.list,
    );
    // nothing to build from, and nothing asked of the server
    expect(sheet(host)).toBeNull();
    expect(host.querySelector('button[data-variant="primary"]')).toBeNull();
    expect(server.to('/goals')).toEqual([]);
  });

  it('says how to send under the chips, in the mono face, and the box is described by it', async () => {
    api({});
    const host = await screen();
    const hint = [...host.querySelectorAll('p')].find(
      (p) => p.textContent === en.goal.composer.hint,
    ) as HTMLElement;
    expect(hint.className).toContain('font-mono');
    const chips = find(host, `ul[aria-label="${en.goal.examples.label}"]`);
    expect(chips.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(box(host).getAttribute('aria-describedby')?.split(' ')).toContain(hint.id);
  });

  it('tells a visitor, and only a visitor, where a plan of their own comes from', async () => {
    api({});
    const visitor = await screen();
    const link = [...visitor.querySelectorAll('a')].find(
      (a) => a.textContent === en.goal.visitor.link,
    );
    expect(link?.getAttribute('href')).toBe('/sign-in?next=/goal');
    expect(visitor.textContent).toContain(en.goal.visitor.after);
    await unmountAll();
    api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const signedIn = await screen();
    await settle();
    expect(signedIn.textContent).not.toContain(en.goal.visitor.after);
  });

  it('reads an example on the click: the box is filled and the limits open, with no Enter', async () => {
    const server = api({});
    const host = await screen();
    const example = en.goal.examples.list[1] as string;
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent === example) as HTMLElement,
    );
    await settle();
    expect(box(host).value).toBe(example);
    expect(sheet(host)).not.toBeNull();
    expect(find(host, '#limits').textContent).toContain(`“${example}”`);
    // the page's own example: its limits are known here, and the reader is not asked
    expect(server.to('/goals')).toEqual([]);
  });

  it('reads every example back as it says, in each language, without asking the reader', async () => {
    // what each chip says, field by field: the goal, the amount, the time frame, the risk, the income
    const said = [
      { goal: 'grow', amount: '2000', horizon: '120', risk: 'high', income: '' },
      { goal: 'protect', amount: '50000', horizon: '18', risk: 'low', income: '' },
      { goal: 'income', amount: '80000', horizon: '60', risk: 'low', income: '300' },
    ];
    // a browser that names a country, as most do: nothing is left for the person to fill
    browserSays(['en-US']);
    for (const lang of ['en', 'pt'] as const) {
      const words = dictionary(lang);
      expect(words.goal.examples.list).toHaveLength(said.length);
      for (const [i, example] of words.goal.examples.list.entries()) {
        const server = api({});
        const host = await screen(lang);
        await click(
          [...host.querySelectorAll('button')].find(
            (b) => b.textContent === example,
          ) as HTMLElement,
        );
        await settle();
        const want = said[i] as (typeof said)[number];
        expect(
          {
            goal: find<HTMLSelectElement>(host, `#${FIELD_ID.goal}`).value,
            amount: input(host, 'amount').value.replace(/\D/g, ''),
            horizon: input(host, 'horizon').value,
            risk: find<HTMLSelectElement>(host, `#${FIELD_ID.risk}`).value,
            // the income field is there for a goal of income only
            income: host.querySelector<HTMLInputElement>(`#${FIELD_ID.income}`)?.value ?? '',
          },
          `${lang}: ${example}`,
        ).toEqual(want);
        // the page's own example: the reader made for reais is not asked, and does not say so
        expect(server.to('/goals')).toEqual([]);
        expect(host.textContent).not.toContain(words.goal.readerMissed('').slice(0, 20));
        // our own example is complete: nothing is missing, nothing is assumed, nothing is in red
        expect(summary(host), `${lang}: ${example}`).toBeNull();
        expect(host.textContent).not.toContain(words.goal.hints.notFound);
        expect(host.textContent).not.toContain(words.goal.hints.assumed);
        await unmountAll();
        window.sessionStorage.clear();
      }
    }
  });

  it('fills what the reader leaves from the goal’s own words', async () => {
    // the reader made for reais answers "accumulation", "medium" and no amount or time frame
    const cases = [
      [
        'en',
        'Protect $50,000 for 18 months, low risk, please',
        ['protect', '50000', '18', 'low', ''],
      ],
      ['en', 'Pay me $500 a month from $150,000', ['income', '150000', '', 'low', '500']],
      [
        'pt',
        'Quero proteger US$ 50.000 por 18 meses, risco baixo',
        ['protect', '50000', '18', 'low', ''],
      ],
      [
        'pt',
        'Fazer 20k dólares crescer em 2 anos, risco alto',
        ['grow', '20000', '24', 'high', ''],
      ],
    ] as const;
    for (const [lang, text, [goal, amount, horizon, risk, income]] of cases) {
      const words = dictionary(lang);
      const server = api(
        goal === 'income'
          ? {
              reading: {
                ...READ_IN_DOLLARS,
                candidate: { ...READ_IN_DOLLARS.candidate, profile: 'income', riskBudget: 'low' },
              },
            }
          : {},
      );
      const host = await screen(lang);
      await read(host, text);
      expect(server.to('/goals')).toHaveLength(1);
      expect(
        {
          goal: find<HTMLSelectElement>(host, `#${FIELD_ID.goal}`).value,
          amount: input(host, 'amount').value.replace(/\D/g, ''),
          horizon: input(host, 'horizon').value,
          risk: find<HTMLSelectElement>(host, `#${FIELD_ID.risk}`).value,
          income: host.querySelector<HTMLInputElement>(`#${FIELD_ID.income}`)?.value ?? '',
        },
        `${lang}: ${text}`,
      ).toEqual({ goal, amount, horizon, risk, income });
      // what the words said is read, not assumed; the risk the reader gives any income is assumed
      const hints = (key: 'goal' | 'risk') =>
        find(host, `#${FIELD_ID[key]}`).closest('[data-ui="field"]')?.textContent;
      expect(hints('goal')).not.toContain(words.goal.hints.assumed);
      if (goal === 'income') expect(hints('risk')).toContain(words.goal.hints.assumed);
      else expect(hints('risk')).not.toContain(words.goal.hints.assumed);
      await unmountAll();
      window.sessionStorage.clear();
    }
  });

  it('takes the country from the browser’s language when nothing says it, and says where it came from', async () => {
    browserSays(['pt-BR', 'en']);
    api({});
    const host = await screen();
    await read(host);
    expect(find<HTMLSelectElement>(host, `#${FIELD_ID.country}`).value).toBe('BR');
    const field = () =>
      find(host, `#${FIELD_ID.country}`).closest('[data-ui="field"]')?.textContent;
    expect(field()).toContain(en.goal.hints.countryFromBrowser);
    expect(field()).not.toContain(en.goal.hints.notFound);
    // once the person picks their own, the hint is the field's own again
    await choose(host, 'country', 'PT');
    expect(field()).toContain(en.goal.hints.country);
    expect(field()).not.toContain(en.goal.hints.countryFromBrowser);
  });

  it('reads an example the person changed like any other text', async () => {
    const server = api({});
    const host = await screen();
    await click(
      [...host.querySelectorAll('button')].find(
        (b) => b.textContent === en.goal.examples.list[1],
      ) as HTMLElement,
    );
    await type(box(host), `${en.goal.examples.list[1]} and some cash`);
    await press(box(host), 'Enter');
    await settle();
    expect(server.to('/goals')).toHaveLength(1);
  });

  it('does not send an empty box', async () => {
    const server = api({});
    const host = await screen();
    await press(box(host), 'Enter');
    await click(find(host, '[data-ui="composer-send"]'));
    expect(server.to('/goals')).toEqual([]);
  });

  it('takes no more text than the reader does, and says a goal is too long, not too short', async () => {
    const server = api({});
    const host = await screen();
    expect(box(host).getAttribute('maxlength')).toBe('2000');
    // a text that got past the box all the same, as a pasted one can in some browsers
    await type(box(host), 'x'.repeat(2001));
    await press(box(host), 'Enter');
    await settle();
    expect(server.to('/goals')).toEqual([]);
    const said = find(host, '[data-ui="composer"]').textContent;
    expect(said).toContain(en.goal.readFailure.tooLong);
    expect(said).not.toContain(en.goal.readFailure.tooShort);
    // and a goal of two letters is too short
    await type(box(host), 'ab');
    await press(box(host), 'Enter');
    await settle();
    expect(find(host, '[data-ui="composer"]').textContent).toContain(en.goal.readFailure.tooShort);
  });
});

describe('reading a typed goal', () => {
  it('sends the text to the API’s reader and shows how it was read, to check and change', async () => {
    const server = api({});
    const host = await screen();
    await read(host);
    expect(server.to('/goals')).toEqual([
      { method: 'POST', path: '/goals', body: { text: GOAL, language: 'en' } },
    ]);
    const limits = find(host, '#limits');
    expect(limits.getAttribute('data-ui')).toBe('constraint-sheet');
    expect(find(limits, 'h2').textContent).toBe(en.goal.sheet.title);
    // the goal as the person wrote it, and how it was read, with the time
    expect(limits.textContent).toContain(`“${GOAL}”`);
    // how it was read is the fields below, not a line about the reader (the flow audit, finding 4)
    expect(limits.textContent).not.toMatch(/parser|a-model|\d{4}-\d{2}-\d{2}T/);
    expect(host.textContent).not.toMatch(/reais/);
    // what the reader found is filled in; what it did not is empty for the person
    expect(find<HTMLSelectElement>(host, `#${FIELD_ID.goal}`).value).toBe('grow');
    expect(find<HTMLSelectElement>(host, `#${FIELD_ID.risk}`).value).toBe('medium');
    expect(input(host, 'amount').value).toBe('');
    expect(input(host, 'horizon').value).toBe('');
    // and the screen says why a dollar amount was not found, and names what is left to fill
    expect(host.textContent).toContain(
      en.goal.readerMissed('Amount (dollars), Time frame (months), and Country where you live'),
    );
    // each field left empty says it was not found, before what it takes
    for (const key of ['amount', 'horizon', 'country'] as const)
      expect(find(host, `#${FIELD_ID[key]}`).closest('[data-ui="field"]')?.textContent).toContain(
        en.goal.hints.notFound,
      );
    expect(find(host, `#${FIELD_ID.risk}`).closest('[data-ui="field"]')?.textContent).not.toContain(
      en.goal.hints.notFound,
    );
  });

  it('shows the five limits a first plan needs and folds the rest under “More limits”', async () => {
    api({});
    const host = await screen();
    await read(host);
    const more = find<HTMLDetailsElement>(host, '[data-ui="sheet-more"]');
    expect(find(more, 'summary').textContent).toBe(en.goal.sheet.more);
    expect(more.open).toBe(false);
    const folded = (['holdings', 'glide', 'language'] as const).map((key) => FIELD_ID[key]);
    expect([...more.querySelectorAll('select, input')].map((el) => el.id)).toEqual(folded);
    const shown = [...find(host, '#limits').querySelectorAll('select, input')]
      .map((el) => el.id)
      .filter((id) => !folded.includes(id));
    expect(shown).toEqual(
      (['goal', 'horizon', 'risk', 'country', 'amount'] as const).map((key) => FIELD_ID[key]),
    );
  });

  it('stops naming a field once the person has filled it', async () => {
    api({});
    const host = await screen();
    await read(host);
    await fill(host);
    expect(host.textContent).not.toContain(en.goal.readerMissed('').slice(0, 20));
    expect(host.textContent).not.toContain(en.goal.hints.notFound);
  });

  it('makes the goal the heading of the page once it is read: still one heading, one serif line', async () => {
    api({});
    const host = await screen();
    await read(host);
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelectorAll('.font-display')).toHaveLength(1);
    const card = find(host, '[data-ui="goal-card"]');
    expect(card.getAttribute('data-state')).toBe('draft');
    // no status and no amount on a draft: those come from the engine, with a plan
    expect(card.querySelector('[data-ui="status"]')).toBeNull();
    expect(find(card, 'h1').textContent).toBe(en.goal.card.unfinished);
    expect(card.textContent).toContain(en.goal.card.draftOpen);
    expect(find(card, 'a').getAttribute('href')).toBe('#limits');
    await fill(host);
    expect(find(card, 'h1').textContent).toBe('Grow $40,000 over 36 months.');
  });

  it('keeps the text and says what to do when the reader cannot be reached', async () => {
    const server = api({});
    server.setDown(true);
    const host = await screen();
    await read(host);
    expect(find(host, '[role="alert"]').textContent).toBe(en.goal.readFailure.unreachable);
    expect(box(host).value).toBe(GOAL);
    expect(sheet(host)).toBeNull();
    expect(host.textContent).not.toContain('fetch failed');
  });

  it('reads a goal in reais as far as the dollars sheet goes: no amount is converted', async () => {
    api({ reading: READ_IN_REAIS });
    const host = await screen('pt');
    await read(host, 'R$ 5.000 por mês a partir de 2029, resgate em até 7 dias');
    expect(find<HTMLSelectElement>(host, `#${FIELD_ID.goal}`).value).toBe('income');
    expect(input(host, 'horizon').value).toBe('147');
    expect(input(host, 'amount').value).toBe('');
    expect(input(host, 'income').value).toBe('');
    expect(host.textContent).toContain(dictionary('pt').goal.captions.income);
  });
});

describe('“Build my plan”', () => {
  it('cannot build from limits that do not fit: nothing is sent, and focus goes to what to fix', async () => {
    const server = api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    // the reader left the amount, the time frame and the country empty
    expect(buildButton(host).getAttribute('aria-disabled')).toBe('true');
    await click(buildButton(host));
    await click(buildButton(host));
    await settle();
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
    expect(document.activeElement).toBe(summary(host));
    // each thing to fix is said in words, with a way to its field
    const items = [...(summary(host)?.querySelectorAll('li') ?? [])].map((li) => li.textContent);
    expect(items).toEqual([
      `${en.goal.fields.horizon}: ${en.goal.errors.horizon} ${en.goal.sheet.goToField}`,
      `${en.goal.fields.country}: ${en.goal.errors.country} ${en.goal.sheet.goToField}`,
      `${en.goal.fields.amount}: ${en.goal.errors.amountEmpty} ${en.goal.sheet.goToField}`,
    ]);
    // right after a reading, what the reader left empty is missing: it has not failed to fit
    expect(summary(host)?.textContent).toContain(
      '3 things are still missing. Fill them in to build the plan.',
    );
    expect(summary(host)?.textContent).not.toContain('fit yet');
    expect(host.textContent).toContain('Fill in the 3 fields above to continue.');
    expect(input(host, 'amount').getAttribute('aria-invalid')).toBe('true');
    // one field fixed is not all of them
    await type(input(host, 'amount'), '40,000');
    await click(buildButton(host));
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
    // an amount the schema refuses does not pass either
    await type(input(host, 'horizon'), '36');
    await choose(host, 'country', 'BR');
    await type(input(host, 'amount'), '5');
    await click(buildButton(host));
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
    expect(summary(host)?.textContent).toContain(en.goal.errors.amountLow);
    // a value that is there and wrong is what does not fit
    expect(summary(host)?.textContent).toContain(
      '1 thing doesn’t fit yet. Fix it to build the plan.',
    );
    expect(summary(host)?.textContent).not.toContain('missing');
    expect(host.textContent).toContain('Fix the field above to continue.');
  });

  it('sends the parsed sheet, once, on the chain of the wallet, when everything fits', async () => {
    const server = api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    await fill(host);
    expect(summary(host)).toBeNull();
    expect(buildButton(host).getAttribute('aria-disabled')).toBeNull();
    await click(buildButton(host));
    await settle();
    expect(server.to(PERSONALIZE_PATH)).toEqual([
      {
        method: 'POST',
        path: PERSONALIZE_PATH,
        body: {
          sheet: {
            basketType: 'standard',
            goal: 'grow',
            amountUsd: 40000,
            horizonMonths: 36,
            risk: 'medium',
            themes: [],
            country: 'BR',
            chains: ['solana'],
            rules: { useHoldings: true, glide: true },
            language: 'en',
          },
        },
      },
    ]);
  });

  it('gives someone who is not signed in the next step, not an error: a link to sign in where the build button is', async () => {
    const server = api({});
    const host = await screen();
    await read(host);
    await fill(host);
    expect(summary(host)).toBeNull();
    expect(host.querySelector('button[data-variant="primary"]')).toBeNull();
    const next = find(host, 'a[data-variant="primary"]');
    expect(next.textContent).toBe(en.goal.sheet.signInToBuild);
    expect(next.getAttribute('href')).toBe('/sign-in?next=/goal');
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
    // the limits themselves fit: the card says so, and nobody is told to fix a field
    expect(find(host, '[data-ui="goal-card"]').textContent).toContain(en.goal.card.draftSet);
    expect(host.textContent).not.toContain(en.goal.sheet.fixOne);
    // the risk the reader answers when the goal names none is marked as assumed, until it is changed
    const risk = () => find(host, `#${FIELD_ID.risk}`).closest('[data-ui="field"]')?.textContent;
    expect(risk()).toContain(en.goal.hints.assumed);
    await choose(host, 'risk', 'low');
    expect(risk()).not.toContain(en.goal.hints.assumed);
    // and the way to sign in comes back to this screen
    const facts = find(host, '[data-ui="sheet-facts"]');
    expect(facts.textContent).toContain(en.goal.chain.unset);
    expect(find(facts, 'a').getAttribute('href')).toBe('/sign-in?next=/goal');
    expect(find(facts, 'a').textContent).toBe(en.shell.signIn);
  });

  it('starts a person with no chain yet on the chain they were looking at, and builds there', async () => {
    const server = api({
      person: {
        ...onSolana,
        wallets: EMBEDDED,
        chain: null,
        chainSource: null,
        chainOptions: ['solana', 'robinhood'],
      },
    });
    portStore.set(signedInPort(EMBEDDED));
    const host = await screen();
    await read(host);
    await fill(host);
    // nobody is asked (CHAIN-SWITCH): Solana, where nobody has chosen, is stored
    expect(server.to('/v1/me/chain')).toEqual([
      { method: 'PUT', path: '/v1/me/chain', body: { chain: 'solana' } },
    ]);
    expect(summary(host)?.textContent ?? '').not.toContain(en.goal.blocked.chainNotChosen);
    await click(buildButton(host));
    await settle();
    const sent = server.to(PERSONALIZE_PATH).at(-1)?.body as { sheet: BasketSheet };
    expect(sent.sheet.chains).toEqual(['solana']);
    expect(host.querySelector('[role="group"]')).toBeNull();
  });

  it('does not build while the chain is still being read: there is no sheet without a chain', async () => {
    const calls: string[] = [];
    // the API's reader answers; its word on the person never comes
    portStore.setApi(async (path) => {
      calls.push(path);
      if (path === '/goals') return json(READ_IN_DOLLARS);
      return new Promise<Response>(() => {});
    });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    await fill(host);
    // every field fits, and nothing is listed as wrong: the button is still not a way through
    expect(summary(host)).toBeNull();
    expect(buildButton(host).getAttribute('aria-disabled')).toBe('true');
    await click(buildButton(host));
    await settle();
    expect(calls).not.toContain(PERSONALIZE_PATH);
    expect(find(host, '[data-ui="sheet-facts"]').textContent).toContain(en.chain.reading);
  });

  it('does not build while the API has not said which chain, and asks it again when told to', async () => {
    const server = api({});
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    await fill(host);
    expect(summary(host)?.textContent).toContain(en.goal.blocked.chainUnknown);
    await click(buildButton(host));
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
    const facts = find(host, '[data-ui="sheet-facts"]');
    await click(find(facts, 'button'));
    await settle();
    expect(server.to('/v1/me')).toHaveLength(2);
  });

  it('says what to do when the server no longer knows the sign-in, or asks for fewer requests', async () => {
    for (const [me, sentence] of [
      [401, en.chain.unknown.signedOut],
      [429, en.shell.slowDown],
    ] as const) {
      const server = api({ me });
      portStore.set(signedInPort(PHANTOM));
      const host = await screen();
      await read(host);
      await fill(host);
      expect(summary(host)?.textContent, String(me)).toContain(sentence);
      expect(summary(host)?.textContent).not.toContain(en.chain.unknown.body);
      await click(buildButton(host));
      expect(server.to(PERSONALIZE_PATH)).toEqual([]);
      // asking again is offered only where it can help
      const again = find(host, '[data-ui="sheet-facts"]').querySelectorAll('button');
      expect(again, String(me)).toHaveLength(me === 401 ? 0 : 1);
      await unmountAll();
      window.sessionStorage.clear();
    }
  });
});

describe('an answer that arrives late', () => {
  /** A signed-in person whose plan is being built: the route has not answered yet. */
  async function building() {
    let answer: (res: Response) => void = () => {};
    const sent: unknown[] = [];
    const server = api({
      person: onSolana,
      plan: (body) => {
        sent.push(body);
        return new Promise<Response>((resolve) => (answer = resolve)) as never;
      },
    });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    await fill(host);
    await click(buildButton(host));
    await settle();
    expect(sent).toHaveLength(1);
    const built = () =>
      answer(
        json({ id: 'plan-1', proposal: proposalFor((sent[0] as { sheet: BasketSheet }).sheet) }),
      );
    return { host, server, built };
  }

  it('reads no other goal while a plan is being built: the limits stand as they were sent', async () => {
    const { host, server, built } = await building();
    await type(box(host), 'Protect $25,000 for two years, low risk');
    await press(box(host), 'Enter');
    await settle();
    expect(server.to('/goals')).toHaveLength(1);
    for (const chip of host.querySelectorAll('ul[aria-label] button'))
      expect(chip.getAttribute('aria-disabled')).toBe('true');
    // and the answer, when it comes, is for the limits still on the page
    await act(async () => built());
    await settle();
    expect(host.textContent).toContain(en.goal.built.done.title);
    expect(input(host, 'amount').value).toBe('40,000');
    // the plan lands below the limits: the keyboard goes to it
    expect(document.activeElement).toBe(find(host, '[data-ui="built-plan"]'));
  });

  it('is not shown to whoever is there by then: the person signed out while it was built', async () => {
    const { host, built } = await building();
    await act(async () => portStore.set(fakePort()));
    await settle();
    await act(async () => built());
    await settle();
    expect(host.textContent).not.toContain(en.goal.built.done.title);
    // and the goal went with the person who typed it
    expect(sheet(host)).toBeNull();
    expect(box(host).value).toBe('');
  });

  it('is not shown for another person who signed in meanwhile', async () => {
    const { host, built } = await building();
    await act(async () => portStore.set(signedInPort(PHANTOM, { userId: 'did:privy:other' })));
    await settle();
    await act(async () => built());
    await settle();
    expect(host.textContent).not.toContain(en.goal.built.done.title);
  });
});

describe('a chain our server has switched off', () => {
  it('builds nothing there, and says so', async () => {
    const server = api({ person: onSolana, plan: (body) => json(body) });
    portStore.set(
      signedInPort(PHANTOM, {
        network: (chain) => {
          const network = fakePort().network(chain);
          return network && { ...network, on: chain !== 'solana' };
        },
      }),
    );
    const host = await screen();
    await read(host);
    await fill(host);
    expect(summary(host)?.textContent).toContain(en.goal.blocked.chainOff('Solana'));
    await click(buildButton(host));
    await settle();
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
  });
});

describe('the chain on the sheet', () => {
  it('is the current chain: switched in the bar, the next plan is built on the new one', async () => {
    const server = api({
      person: { ...onSolana, wallets: EMBEDDED, chainSource: 'picked' },
      plan: (body) =>
        json({ id: 'plan-1', proposal: proposalFor((body as { sheet: BasketSheet }).sheet) }),
    });
    portStore.set(signedInPort(EMBEDDED));
    const host = await mount(
      withAccount('en', [
        createElement(ChainSwitch, { key: 's' }),
        createElement(GoalScreen, { key: 'g' }),
      ]),
    );
    await settle();
    await click(find(host, '[data-ui="chain-switch"] > button'));
    await click(find(host, '[data-ui="chain-switch-panel"] button[data-chain="robinhood"]'));
    await settle();
    expect(server.to('/v1/me/chain')).toEqual([
      { method: 'PUT', path: '/v1/me/chain', body: { chain: 'robinhood' } },
    ]);
    await read(host);
    expect(find(host, '[data-ui="sheet-facts"]').textContent).toContain('Robinhood Chain');
    await fill(host);
    await click(buildButton(host));
    await settle();
    const sent = server.to(PERSONALIZE_PATH).at(-1)?.body as { sheet: BasketSheet };
    expect(sent.sheet.chains).toEqual(['robinhood']);
  });

  it('is stated, with what it is, and is not a field', async () => {
    api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    const facts = find(host, '[data-ui="sheet-facts"]');
    expect(find(facts, 'dt').textContent).toBe(en.goal.chain.label);
    expect(facts.textContent).toContain('Solana');
    expect(facts.textContent).toContain(en.goal.chain.note);
    // a test network: the named glyph, and the words
    expect(facts.querySelectorAll('[data-ui="sample-glyph"]')).toHaveLength(1);
    expect(facts.textContent).not.toContain('MOCK');
    expect(facts.textContent).toContain(en.shell.testNetwork);
    // no control sets it
    expect(facts.querySelectorAll('input, select, textarea')).toHaveLength(0);
    const labels = [...host.querySelectorAll('label')].map((l) => l.textContent?.toLowerCase());
    expect(labels.some((label) => /chain|network/.test(label ?? ''))).toBe(false);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });
});

describe('what comes back from “Build my plan”', () => {
  const built = async (
    plan?: (body: unknown) => Response,
    provenance: 'sandbox' | 'live' = 'sandbox',
  ) => {
    const server = api({ person: onSolana, plan });
    portStore.set(signedInPort(PHANTOM, {}, provenance));
    const host = await screen();
    await read(host);
    await fill(host);
    await click(buildButton(host));
    await settle();
    return { host, server };
  };

  it('says honestly that the plan cannot be built yet, and shows no plan in its place', async () => {
    const { host, server } = await built();
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(1);
    expect(host.textContent).toContain(en.goal.built.unavailable.title);
    expect(host.textContent).toContain(en.goal.built.unavailable.body);
    // nothing that looks like a plan: no legs, no figure, no status, no rate
    for (const part of ['plan-legs', 'pin', 'status', 'stat', 'exit-plan', 'data-table'])
      expect(host.querySelector(`[data-ui="${part}"]`), part).toBeNull();
    expect(host.textContent).not.toMatch(/\d+(\.\d+)?\s*%/);
    // the limits are as they were, and the card still says there is no plan
    expect(input(host, 'amount').value).toBe('40,000');
    expect(find(host, '[data-ui="goal-card"]').textContent).toContain(en.goal.card.draftSet);
    // it is not a refusal of the limits: nothing is marked wrong
    expect(summary(host)).toBeNull();
  });

  it('says it again when asked again, and forgets it when the limits change', async () => {
    const { host, server } = await built();
    await click(buildButton(host));
    await settle();
    expect(server.to(PERSONALIZE_PATH)).toHaveLength(2);
    await type(input(host, 'horizon'), '48');
    expect(host.textContent).not.toContain(en.goal.built.unavailable.title);
    expect(find(host, `#${FIELD_ID.horizon}-hint`).textContent).toContain(en.goal.sheet.edited);
  });

  it('says a plan is built when the route answers one, with how many lines and where, and nothing bought', async () => {
    const { host } = await built(
      (body) =>
        json({ id: 'plan-1', proposal: proposalFor((body as { sheet: never }).sheet, 'live') }),
      'live',
    );
    expect(host.textContent).toContain(en.goal.built.done.title);
    expect(host.textContent).toContain(en.goal.built.done.body(2, 'Solana'));
    expect(host.querySelectorAll('.tf-hatch, .tf-mock-plate')).toHaveLength(0);
  });

  it('marks a plan built on anything that is not live with the hatch and a quiet line', async () => {
    const { host } = await built(
      (body) =>
        json({ id: 'plan-1', proposal: proposalFor((body as { sheet: never }).sheet, 'mock') }),
      'live',
    );
    expect(host.textContent).toContain(en.goal.built.done.title);
    expect(host.querySelectorAll('[data-ui="sample-note"]')).toHaveLength(1);
    expect(host.textContent).not.toContain('MOCK');
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('draws a plan that names no figure as not live: the line, never a bare card', async () => {
    const { host } = await built((body) => {
      const proposal = proposalFor((body as { sheet: never }).sheet, 'live');
      return json({ id: 'plan-1', proposal: { ...proposal, observations: [] } });
    }, 'live');
    expect(host.textContent).toContain(en.goal.built.done.title);
    expect(find(host, '[data-ui="sample-note"]').textContent).toBe(en.shell.mockAnnounce);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('marks a plan from a test network with the line and the words "test network"', async () => {
    const { host } = await built(
      (body) =>
        json({ id: 'plan-1', proposal: proposalFor((body as { sheet: never }).sheet, 'sandbox') }),
      'live',
    );
    expect(find(host, '[data-ui="sample-note"]').textContent).toBe(
      `${en.shell.mockAnnounce} · ${en.shell.testNetwork}`,
    );
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('shows no plan that is for another chain than the one asked for', async () => {
    const { host } = await built((body) => {
      const sheet = (body as { sheet: BasketSheet }).sheet;
      return json({ id: 'plan-1', proposal: proposalFor({ ...sheet, chains: ['robinhood'] }) });
    });
    expect(find(host, '[role="alert"]').textContent).toBe(en.goal.built.unreadable);
    expect(host.textContent).not.toContain(en.goal.built.done.title);
    expect(host.textContent).not.toContain('Robinhood Chain');
  });

  it('does not show an answer that is not a plan in the frozen shape', async () => {
    const { host } = await built(() => json({ id: 'plan-1', proposal: { lines: [] } }));
    expect(find(host, '[role="alert"]').textContent).toBe(en.goal.built.unreadable);
    expect(host.textContent).not.toContain(en.goal.built.done.title);
  });

  it('says no plan fits when the engine says so, and that the server refused when it did', async () => {
    const none = await built(() => json({ error: 'no plan', code: 'GOAL_NOT_ACHIEVABLE' }, 422));
    expect(find(none.host, '[data-ui="sheet-no-plan"]').textContent).toContain(
      en.goal.sheet.noPlan,
    );
    await unmountAll();
    window.sessionStorage.clear();
    const refused = await built(() => json({ error: 'body/sheet must be object' }, 400));
    expect(summary(refused.host)?.textContent).toContain(en.goal.blocked.refused);
    expect(refused.host.textContent).not.toContain('body/sheet');
    await unmountAll();
    window.sessionStorage.clear();
    // plans are in dollars for now (gate USD-ONLY): said plainly, not as a refusal of the limits
    const currency = await built(() =>
      json({ error: 'Plans are in US dollars for now', code: 'CURRENCY_UNSUPPORTED' }, 422),
    );
    expect(summary(currency.host)?.textContent).toContain(en.goal.blocked.currency);
    expect(summary(currency.host)?.textContent).not.toContain(en.goal.blocked.refused);
  });

  it.each([401, 403])(
    'says to sign in again, not that the limits were refused, when the server answers %s',
    async (status) => {
      const { host } = await built(() => json({ error: 'sign in first' }, status));
      expect(summary(host)?.textContent).toContain(en.goal.blocked.signInAgain);
      expect(summary(host)?.textContent).not.toContain(en.goal.blocked.refused);
      expect(host.textContent).not.toContain('sign in first');
    },
  );

  it('says the sign-in service gave no identity token, not to sign in again, when the server says so', async () => {
    const { host } = await built(() =>
      json({ error: 'sign in first: no identity token was sent' }, 401),
    );
    expect(summary(host)?.textContent).toContain(en.goal.blocked.noIdentity);
    expect(summary(host)?.textContent).not.toContain(en.goal.blocked.signInAgain);
    expect(host.textContent).not.toContain('no identity token was sent');
  });

  it('says to choose the chain first when the server has none for this person, and asks who they are again', async () => {
    const { host, server } = await built(() =>
      json({ error: 'pick the chain your plans live on first' }, 409),
    );
    expect(summary(host)?.textContent).toContain(en.goal.blocked.chainNotChosen);
    expect(summary(host)?.textContent).not.toContain(en.goal.blocked.refused);
    expect(server.to('/v1/me')).toHaveLength(2);
  });

  it('says the server could not be reached, and leaves the limits as they are', async () => {
    const server = api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    await fill(host);
    server.setDown(true);
    await click(buildButton(host));
    await settle();
    expect(find(host, '[role="alert"]').textContent).toBe(en.goal.built.unreachable);
    expect(input(host, 'amount').value).toBe('40,000');
  });
});

describe('the goal screen and the rest of the product', () => {
  it('asks the wallet to sign nothing and to send nothing, whatever is pressed', async () => {
    const sign = vi.fn(async () => []);
    const send = vi.fn(async () => ({ txId: 'x' }));
    const signMessage = vi.fn(async () => 'x');
    api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM, { sign, send, signMessage }));
    const host = await screen();
    await read(host);
    await fill(host);
    await click(buildButton(host));
    await settle();
    for (const button of host.querySelectorAll('button')) await click(button);
    await settle();
    expect(sign).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    // and there is no button to buy with
    expect(host.textContent).not.toMatch(/\bbuy\b|\bsign:|deposit/i);
  });

  it('keeps what was typed and read in the tab, through a trip to sign in and back', async () => {
    api({});
    const first = await screen();
    await read(first);
    await type(input(first, 'amount'), '40,000');
    await unmountAll();
    const back = await screen();
    await settle();
    expect(box(back).value).toBe(GOAL);
    expect(input(back, 'amount').value).toBe('40,000');
    expect(find(back, '#limits').textContent).toContain(`“${GOAL}”`);
    // what is in the tab's storage is not trusted: anything else is dropped
    await unmountAll();
    window.sessionStorage.setItem('tf-goal', '{"text":7,"sheet":"<script>"}');
    const fresh = await screen();
    await settle();
    expect(box(fresh).value).toBe('');
    expect(sheet(fresh)).toBeNull();
  });

  it('forgets what a person typed and read when they sign out: it is not the next person’s', async () => {
    api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    await fill(host);
    expect(window.sessionStorage.getItem('tf-goal')).toContain('apartment');
    await act(async () => portStore.set(fakePort()));
    await settle();
    expect(box(host).value).toBe('');
    expect(sheet(host)).toBeNull();
    expect(host.textContent).toContain(en.goal.title);
    expect(window.sessionStorage.getItem('tf-goal') ?? '').not.toContain('apartment');
    expect(window.sessionStorage.getItem('tf-goal') ?? '').not.toContain('40,000');
  });

  it('forgets it for another person who signs in after the first, too', async () => {
    api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    await act(async () => portStore.set(signedInPort(PHANTOM, { userId: 'did:privy:other' })));
    await settle();
    expect(box(host).value).toBe('');
    expect(sheet(host)).toBeNull();
  });

  it('has headings that descend in order: the goal, then the limits, then what came of them', async () => {
    const levels = (host: HTMLElement) =>
      [...host.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => Number(h.tagName[1]));
    api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    expect(levels(host)).toEqual([1]);
    await read(host);
    expect(levels(host)).toEqual([1, 2]);
    await fill(host);
    await click(buildButton(host));
    await settle();
    // the limits and the outcome are both sections of the page: no level is skipped
    expect(levels(host)).toEqual([1, 2, 2]);
    expect(find(host, 'h1').textContent).toContain('$40,000');
  });

  it('is in Portuguese for someone who reads Portuguese', async () => {
    api({});
    const pt = dictionary('pt');
    const host = await screen('pt');
    expect(find(host, 'h1').textContent).toBe(pt.goal.title);
    expect(box(host).getAttribute('lang')).toBe('pt-BR');
    await read(host, 'Juntar US$ 40.000 até junho de 2028');
    expect(find(find(host, '#limits'), 'h2').textContent).toBe(pt.goal.sheet.title);
    expect(find(host, 'a[data-variant="primary"]').textContent).toBe(pt.goal.sheet.signInToBuild);
  });

  it('holds the binding rules at every step: no hatch without its word, no exclamation mark, labels on every control', async () => {
    api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM, { test: true }, 'mock'));
    const host = await screen();
    const check = () => {
      expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
      expect(host.textContent).not.toMatch(/!/);
      for (const control of host.querySelectorAll<HTMLElement>('input, select, textarea')) {
        const label = host.querySelector(`label[for="${control.id}"]`);
        expect(label?.textContent?.trim(), control.id).toBeTruthy();
      }
      for (const button of host.querySelectorAll('button'))
        expect(
          (button.getAttribute('aria-label') ?? button.textContent ?? '').trim(),
          button.outerHTML.slice(0, 80),
        ).not.toBe('');
    };
    check();
    await read(host);
    check();
    await fill(host);
    check();
    await click(buildButton(host));
    await settle();
    check();
  });
});

describe.each(['solana', 'robinhood'] as const)('the chain of a goal on %s', (chain) => {
  const person: Person = {
    ...onSolana,
    wallets: chain === 'solana' ? PHANTOM : EMBEDDED,
    chain,
    chainSource: chain === 'solana' ? 'wallet' : 'picked',
  };
  const badged = (el: Element | null) =>
    [...(el?.querySelectorAll('[data-ui="chain-badge"]') ?? [])].map((b) => [
      b.getAttribute('data-chain'),
      b.textContent,
    ]);

  it('is badged on the sheet, on the goal’s card, and on the plan it built', async () => {
    api({
      person,
      plan: (body) =>
        json({ id: 'plan-1', proposal: proposalFor((body as { sheet: never }).sheet, 'mock') }),
    });
    portStore.set(signedInPort(person.wallets));
    const host = await screen();
    await read(host);
    await fill(host);
    const named = [[chain, CHAIN_NAMES[chain]]];
    expect(badged(host.querySelector('[data-ui="sheet-facts"]'))).toEqual(named);
    expect(badged(host.querySelector('[data-ui="goal-card"]'))).toEqual(named);
    await click(buildButton(host));
    await settle();
    const done = [...host.querySelectorAll('[data-ui="card"]')].find((card) =>
      card.textContent?.includes(en.goal.built.done.title),
    );
    expect(badged(done ?? null)).toEqual(named);
    if (chain === 'robinhood') expect(host.textContent).not.toMatch(/usdc/i);
  });
});
