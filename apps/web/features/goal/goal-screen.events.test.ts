// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { EMBEDDED, fakePort, json, PHANTOM, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { PERSONALIZE_PATH } from './build-plan';
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
const GOAL = 'Grow $40,000 for an apartment by June 2028';

type Call = { method: string; path: string; body?: unknown };

function api(options: { person?: Person; reading?: unknown; plan?: (body: unknown) => Response }) {
  const calls: Call[] = [];
  let down = false;
  portStore.setApi(async (path, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (down) throw new TypeError('fetch failed');
    if (path === '/goals') return json(options.reading ?? READ_IN_DOLLARS);
    if (path === '/v1/me') return options.person ? json(options.person) : json({}, 401);
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

beforeEach(() => {
  window.sessionStorage.clear();
  portStore.set(fakePort());
});
afterEach(unmountAll);

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

  it('fills the box from an example and hands it over, without sending it', async () => {
    const server = api({});
    const host = await screen();
    const example = en.goal.examples.list[1] as string;
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent === example) as HTMLElement,
    );
    expect(box(host).value).toBe(example);
    expect(document.activeElement).toBe(box(host));
    expect(server.to('/goals')).toEqual([]);
    expect(sheet(host)).toBeNull();
  });

  it('does not send an empty box', async () => {
    const server = api({});
    const host = await screen();
    await press(box(host), 'Enter');
    await click(find(host, '[data-ui="composer-send"]'));
    expect(server.to('/goals')).toEqual([]);
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
    expect(find(limits, 'h3').textContent).toBe(en.goal.sheet.title);
    // the goal as the person wrote it, and how it was read, with the time
    expect(limits.textContent).toContain(`“${GOAL}”`);
    expect(limits.textContent).toMatch(/parser: llm \(a-model\) · \d{4}-\d{2}-\d{2}T[\d:]+Z/);
    // what the reader found is filled in; what it did not is empty for the person
    expect(find<HTMLSelectElement>(host, `#${FIELD_ID.goal}`).value).toBe('grow');
    expect(find<HTMLSelectElement>(host, `#${FIELD_ID.risk}`).value).toBe('medium');
    expect(input(host, 'amount').value).toBe('');
    expect(input(host, 'horizon').value).toBe('');
    // and the screen says why a dollar amount was not found
    expect(host.textContent).toContain(en.goal.readerNote);
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
    expect(summary(host)?.textContent).toContain('3 things don’t fit yet.');
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

  it('does not build for someone who is not signed in: a plan is for the chain of a wallet', async () => {
    const server = api({});
    const host = await screen();
    await read(host);
    await fill(host);
    expect(summary(host)?.textContent).toContain(en.goal.blocked.signedOut);
    await click(buildButton(host));
    await settle();
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
    // the limits themselves fit: the card says so, and nobody is told to fix a field
    expect(find(host, '[data-ui="goal-card"]').textContent).toContain(en.goal.card.draftSet);
    expect(host.textContent).not.toContain(en.goal.sheet.fixOne);
    expect(buildButton(host).getAttribute('aria-describedby')).toBe(summary(host)?.id);
    // and the way to sign in comes back to this screen
    const facts = find(host, '[data-ui="sheet-facts"]');
    expect(facts.textContent).toContain(en.goal.chain.unset);
    expect(find(facts, 'a').getAttribute('href')).toBe('/sign-in?next=/goal');
    expect(find(facts, 'a').textContent).toBe(en.shell.signIn);
  });

  it('does not build before the chain is chosen, and leads to where it is chosen', async () => {
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
    expect(summary(host)?.textContent).toContain(en.goal.blocked.chainNotChosen);
    await click(buildButton(host));
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
    const way = find(find(host, '[data-ui="sheet-facts"]'), 'a');
    expect([way.textContent, way.getAttribute('href')]).toEqual([
      en.goal.chain.choose,
      '/sign-in?next=/goal',
    ]);
    // the choice is not offered here: it is asked in one place
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
});

describe('the chain on the sheet', () => {
  it('is stated, with what it is, and is not a field', async () => {
    api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    const facts = find(host, '[data-ui="sheet-facts"]');
    expect(find(facts, 'dt').textContent).toBe(en.goal.chain.label);
    expect(facts.textContent).toContain('Solana');
    expect(facts.textContent).toContain(en.goal.chain.note);
    // a test network: the plate, and the words
    expect(facts.querySelectorAll('.tf-mock-plate')).toHaveLength(1);
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

  it('marks a plan built on anything that is not live with the hatch and the word MOCK', async () => {
    const { host } = await built(
      (body) =>
        json({ id: 'plan-1', proposal: proposalFor((body as { sheet: never }).sheet, 'mock') }),
      'live',
    );
    expect(host.textContent).toContain(en.goal.built.done.title);
    expect(host.querySelectorAll('.tf-mock-plate')).toHaveLength(1);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
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

  it('is in Portuguese for someone who reads Portuguese', async () => {
    api({});
    const pt = dictionary('pt');
    const host = await screen('pt');
    expect(find(host, 'h1').textContent).toBe(pt.goal.title);
    expect(box(host).getAttribute('lang')).toBe('pt-BR');
    await read(host, 'Juntar US$ 40.000 até junho de 2028');
    expect(find(find(host, '#limits'), 'h3').textContent).toBe(pt.goal.sheet.title);
    expect(buildButton(host).textContent).toContain(pt.goal.sheet.build);
    expect(host.textContent).toContain(pt.goal.blocked.signedOut);
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
