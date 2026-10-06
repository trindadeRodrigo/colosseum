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
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { EMBEDDED, fakePort, json, PHANTOM, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { PERSONALIZE_PATH } from './build-plan';
import { GOAL_HANDOFF } from './draft';
import { GoalScreen } from './GoalScreen';
import { INTAKE_PATH } from './intake';
import { builtFor, CANDIDATE_IDS, intakeAsking, intakeSaid, SHEET } from './test/plan';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The goal screen with real events (gate GUIDED-INTAKE): the goal is typed and sent to the intake,
// which reads it, asks what it leaves open and, once nothing is, says back what it understood; the
// person answers in the form or in their own words, and only their confirm sends the sheet the server
// said back to the route that builds a plan. The API is a double of both routes and GET /v1/me.

const en = dictionary('en');
const GOAL = 'Grow $40,000 for an apartment';

type Call = { method: string; path: string; body?: unknown };
type IntakeBody = {
  text: string;
  language: string;
  followUps?: string[];
  answers?: Record<string, unknown>;
};

function api(
  options: {
    person?: Person;
    /** What GET /v1/me answers with when there is no person: by default, a server that is not up. */
    me?: number;
    /** The intake's answer; by default it asks until an amount is answered, then says back. */
    intake?: (body: IntakeBody) => Response;
    plan?: (body: unknown) => Response;
  } = {},
) {
  const calls: Call[] = [];
  let down = false;
  portStore.setApi(async (path, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (down) throw new TypeError('fetch failed');
    if (path === INTAKE_PATH)
      return options.intake
        ? options.intake(body)
        : json((body as IntakeBody).answers?.amountUsd ? intakeSaid() : intakeAsking());
    if (path === '/v1/me')
      return options.person ? json(options.person) : json({}, options.me ?? 503);
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
const intake = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-ui="intake"]');
const control = <T extends HTMLElement = HTMLInputElement>(host: HTMLElement, field: string) =>
  find<T>(host, `[data-field="${field}"]`);
const readBack = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-ui="read-back"]');
const confirm = (host: HTMLElement) =>
  [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith(en.goal.intake.readBack.confirm),
  ) as HTMLElement;
const sendAnswers = (host: HTMLElement) =>
  [...host.querySelectorAll('button[type="submit"]')].find((b) =>
    [en.goal.intake.questions.reply, en.goal.intake.questions.update].some((w) =>
      b.textContent?.startsWith(w),
    ),
  ) as HTMLElement;

async function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  await fire(select, new Event('change', { bubbles: true }));
}

/** Types the goal and sends it, as a person does. */
async function read(host: HTMLElement, text = GOAL) {
  await type(box(host), text);
  await press(box(host), 'Enter');
  await settle();
}

/** Answers what the rules parser left open: the amount and the time frame. */
async function answer(host: HTMLElement) {
  await type(control(host, 'amountUsd'), '40,000');
  await type(control(host, 'horizonMonths'), '36');
  await click(sendAnswers(host));
  await settle();
}

/** A signed-in person on Solana, with the goal read and answered: the read-back is up. */
async function saidBack(options: Parameters<typeof api>[0] = {}, provenance?: 'live' | 'sandbox') {
  const server = api({ person: onSolana, ...options });
  portStore.set(signedInPort(PHANTOM, {}, provenance));
  const host = await screen();
  await read(host);
  await answer(host);
  return { host, server };
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/goal');
  portStore.set(fakePort());
});
afterEach(unmountAll);

describe('a goal handed over from the landing page or an embed', () => {
  it('is read as the screen opens, once someone is signed in, and taken out of the tab', async () => {
    const server = api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    window.sessionStorage.setItem(GOAL_HANDOFF, GOAL);
    const host = await screen();
    await settle();
    expect(server.to(INTAKE_PATH)).toEqual([
      { method: 'POST', path: INTAKE_PATH, body: { text: GOAL, language: 'en' } },
    ]);
    expect(box(host).value).toBe(GOAL);
    expect(window.sessionStorage.getItem(GOAL_HANDOFF)).toBeNull();
    expect(intake(host)).not.toBeNull();
  });

  it('is read from the address’s fragment, and the fragment taken out', async () => {
    const server = api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    window.history.replaceState(null, '', `/goal#goal=${encodeURIComponent(GOAL)}`);
    const host = await screen();
    await settle();
    expect(server.to(INTAKE_PATH)).toHaveLength(1);
    expect(box(host).value).toBe(GOAL);
    expect(window.location.hash).toBe('');
  });

  it('waits for a visitor to sign in: the text is kept and nothing is sent', async () => {
    const server = api({});
    window.sessionStorage.setItem(GOAL_HANDOFF, GOAL);
    const host = await screen();
    await settle();
    expect(server.to(INTAKE_PATH)).toEqual([]);
    expect(box(host).value).toBe(GOAL);
    // once they are signed in, it is read
    api({ person: onSolana });
    await act(async () => portStore.set(signedInPort(PHANTOM)));
    await settle();
    expect(intake(host)).not.toBeNull();
  });
});

describe('the goal screen, before anything is read', () => {
  it('asks the one question, in the one serif line, with the typing box and three examples', async () => {
    const server = api({});
    const host = await screen();
    expect(find(host, 'h1').textContent).toBe(en.goal.title);
    expect(host.querySelectorAll('.font-display')).toHaveLength(1);
    expect(find(host, 'label').textContent).toBe(en.goal.composer.label);
    const examples = find(host, `ul[aria-label="${en.goal.examples.label}"]`);
    expect([...examples.querySelectorAll('button')].map((b) => b.textContent)).toEqual(
      en.goal.examples.list,
    );
    expect(intake(host)).toBeNull();
    expect(host.querySelector('button[data-variant="primary"]')).toBeNull();
    expect(server.to(INTAKE_PATH)).toEqual([]);
  });

  it('sends with an arrow, never a paper plane or a wand (composer.md, iconography.md)', async () => {
    api({});
    const host = await screen();
    const send = find(host, '[data-ui="composer-send"]');
    expect(send.querySelector('svg')).not.toBeNull();
    expect(host.innerHTML).not.toMatch(/Sparkles|Wand|PaperPlane/);
  });

  it('tells a visitor, and only a visitor, where a plan of their own comes from', async () => {
    api({});
    const visitor = await screen();
    expect(visitor.textContent).toContain(en.goal.visitor.after);
    await unmountAll();
    api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const signedIn = await screen();
    await settle();
    expect(signedIn.textContent).not.toContain(en.goal.visitor.after);
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
    expect(server.to(INTAKE_PATH)).toEqual([]);
  });

  it('says a goal is too long or too short before anything is sent, signed in or not', async () => {
    const server = api({});
    const host = await screen();
    expect(box(host).getAttribute('maxlength')).toBe('2000');
    await type(box(host), 'x'.repeat(2001));
    await press(box(host), 'Enter');
    await settle();
    expect(find(host, '[data-ui="composer"]').textContent).toContain(en.goal.readFailure.tooLong);
    await type(box(host), 'ab');
    await press(box(host), 'Enter');
    await settle();
    expect(find(host, '[data-ui="composer"]').textContent).toContain(en.goal.readFailure.tooShort);
    expect(server.to(INTAKE_PATH)).toEqual([]);
  });

  it('asks a visitor to sign in to have the goal read, and keeps the text', async () => {
    const server = api({});
    const host = await screen();
    await read(host);
    expect(server.to(INTAKE_PATH)).toEqual([]);
    expect(find(host, '[data-ui="composer"]').textContent).toContain(
      en.goal.intake.failure.signedOut,
    );
    expect(box(host).value).toBe(GOAL);
  });
});

describe('the intake: read, ask, answer', () => {
  it('sends the text to the intake and shows what was read, by what, and what is still open', async () => {
    const server = api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    expect(server.to(INTAKE_PATH)).toEqual([
      { method: 'POST', path: INTAKE_PATH, body: { text: GOAL, language: 'en' } },
    ]);
    const card = intake(host) as HTMLElement;
    expect(find(card, 'h2').textContent).toBe(en.goal.intake.title);
    expect(find(card, '[data-ui="intake-source"]').textContent).toBe(en.goal.intake.readBy.rules);
    expect(card.textContent).toContain(`“${GOAL}”`);
    expect(card.textContent).toContain(en.goal.intake.questions.other(3));
    // each question is the label of its control, and a field read is the control's start
    expect(find(card, `label[for="${control(host, 'amountUsd').id}"]`).textContent).toBe(
      'How much do you put in, in dollars?',
    );
    expect(control<HTMLSelectElement>(host, 'risk').value).toBe('medium');
    // nothing is built while anything is open
    expect(readBack(host)).toBeNull();
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
  });

  it('says a reply made up for a test is one, quietly, beside what read it', async () => {
    api({
      person: onSolana,
      intake: () => json(intakeAsking({ method: 'model', provenance: 'mock' })),
    });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    const card = intake(host) as HTMLElement;
    // said once, quietly, beside what read it: no plate
    expect(card.querySelectorAll('.tf-mock-plate, [data-ui="mock-plate"]')).toHaveLength(0);
    expect(find(card, '[data-ui="intake-source"]').textContent).toBe(
      `${en.goal.intake.readBy.model('claude-haiku-4-5')} · ${en.goal.intake.sampleReply}`,
    );
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('sends nothing that does not fit, and says what to change in each field', async () => {
    const server = api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    await type(control(host, 'amountUsd'), 'forty');
    await type(control(host, 'horizonMonths'), '600');
    await click(sendAnswers(host));
    await settle();
    expect(server.to(INTAKE_PATH)).toHaveLength(1);
    expect(intake(host)?.textContent).toContain(en.goal.intake.errors.amount);
    expect(intake(host)?.textContent).toContain(en.goal.intake.errors.horizon);
  });

  it('sends the answers with the same text, by field, and says back what was understood', async () => {
    const server = api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    await choose(control<HTMLSelectElement>(host, 'risk'), 'high');
    await answer(host);
    expect(server.to(INTAKE_PATH)[1]?.body).toEqual({
      text: GOAL,
      language: 'en',
      answers: {
        amountUsd: 40000,
        horizonMonths: 36,
        horizonOpen: false,
        risk: 'high',
        obligations: [],
      },
    });
    const said = readBack(host) as HTMLElement;
    expect(find(said, 'h3').textContent).toBe(en.goal.intake.readBack.title);
    expect([...said.querySelectorAll('li')].map((li) => li.textContent)).toEqual(
      intakeSaid().readBack,
    );
    // the goal is the heading now, from the sheet said back
    expect(find(host, 'h1').textContent).toBe('Grow $40,000 over 36 months.');
    // one primary: the confirm
    expect(host.querySelectorAll('button[data-variant="primary"]')).toHaveLength(1);
    expect(confirm(host).getAttribute('data-variant')).toBe('primary');
  });

  it('takes "no date" for a goal with none', async () => {
    const server = api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    await type(control(host, 'amountUsd'), '40000');
    const noDate = [...host.querySelectorAll('label')]
      .find((l) => l.textContent === en.goal.intake.questions.noDate)
      ?.querySelector('input') as HTMLInputElement;
    await click(noDate);
    await click(sendAnswers(host));
    await settle();
    expect(server.to(INTAKE_PATH)[1]?.body).toMatchObject({
      answers: { amountUsd: 40000, horizonOpen: true },
    });
    expect((server.to(INTAKE_PATH)[1]?.body as IntakeBody | undefined)?.answers).not.toHaveProperty(
      'horizonMonths',
    );
  });

  it('takes withdrawals from the form, as answers', async () => {
    const server = api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    await click(
      [...host.querySelectorAll('button')].find(
        (b) => b.textContent === en.goal.intake.withdrawals.add,
      ) as HTMLElement,
    );
    const row = find(host, '[data-ui="withdrawal"]');
    const [month, amount, currency] = [...row.querySelectorAll('input')];
    await type(month as HTMLInputElement, '2027-06');
    await type(amount as HTMLInputElement, '500');
    expect((currency as HTMLInputElement).value).toBe('USD');
    await answer(host);
    expect(
      (server.to(INTAKE_PATH)[1]?.body as IntakeBody | undefined)?.answers?.obligations,
    ).toEqual([{ month: '2027-06', amount: 500, currency: 'USD' }]);
  });

  it('takes the person’s own words as a follow-up, with the same text and answers so far', async () => {
    const server = api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    expect(find(host, '[data-ui="composer"] label').textContent).toBe(
      en.goal.intake.followUp.label,
    );
    await read(host, '70-30, I want to grow it');
    expect(server.to(INTAKE_PATH)[1]?.body).toEqual({
      text: GOAL,
      language: 'en',
      followUps: ['70-30, I want to grow it'],
    });
    expect(box(host).value).toBe('');
    expect(intake(host)?.textContent).toContain('“70-30, I want to grow it”');
  });

  it('keeps the text and says what to do when the intake cannot be reached', async () => {
    const server = api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    server.setDown(true);
    await read(host);
    expect(find(host, '[data-ui="composer"]').textContent).toContain(
      en.goal.readFailure.unreachable,
    );
    expect(box(host).value).toBe(GOAL);
    expect(intake(host)).toBeNull();
  });

  it.each([
    [404, en.goal.intake.failure.unavailable],
    [400, en.goal.intake.failure.refused],
    [429, en.shell.slowDown],
  ])('says what an answer of %s means, in its own sentence', async (status, sentence) => {
    api({ person: onSolana, intake: () => json({ error: 'raw words' }, status) });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    expect(find(host, '[data-ui="composer"]').textContent).toContain(sentence);
    expect(host.textContent).not.toContain('raw words');
  });

  it('shows no sheet to confirm while a question is still open, whatever the server sent', async () => {
    api({
      person: onSolana,
      intake: () => json({ ...intakeSaid(), questions: intakeAsking().questions }),
    });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    expect(readBack(host)).toBeNull();
  });
});

describe('the confirm: “Build my plan”', () => {
  it('sends the sheet the server said back, as it came, once, and nothing before it', async () => {
    const plans: unknown[] = [];
    const { host, server } = await saidBack({
      plan: (body) => {
        plans.push(body);
        return json(builtFor((body as { sheet: BasketSheet }).sheet, 'live'));
      },
    });
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
    await click(confirm(host));
    await settle();
    expect(plans).toEqual([{ sheet: intakeSaid().sheet }]);
    expect(host.textContent).toContain(en.goal.built.done.body(3, 'Solana'));
  });

  it('does not build before the chain is chosen, and says why', async () => {
    api({
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
    await answer(host);
    expect(readBack(host)?.textContent).toContain(en.goal.blocked.chainNotChosen);
    expect(confirm(host).getAttribute('aria-disabled')).toBe('true');
  });

  it('builds nothing on a chain our server has switched off, and says so', async () => {
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
    await answer(host);
    expect(readBack(host)?.textContent).toContain(en.goal.blocked.chainOff('Solana'));
    await click(confirm(host));
    await settle();
    expect(server.to(PERSONALIZE_PATH)).toEqual([]);
  });

  it('says the plans are built, how many and where, and leads to the choice this tab kept', async () => {
    const { host } = await saidBack(
      { plan: (body) => json(builtFor((body as { sheet: never }).sheet, 'live')) },
      'live',
    );
    await click(confirm(host));
    await settle();
    expect(host.querySelectorAll('.tf-hatch, .tf-mock-plate')).toHaveLength(0);
    const link = find<HTMLAnchorElement>(host, 'a[href^="/plan/"]');
    expect(link.textContent).toBe(en.goal.built.done.see(3));
    const key = decodeURIComponent(link.getAttribute('href')?.slice('/plan/'.length) ?? '');
    const choice = JSON.parse(window.sessionStorage.getItem(`tf-choice:${key}`) ?? 'null');
    expect(choice.ids).toEqual([CANDIDATE_IDS.cover, CANDIDATE_IDS.spread, CANDIDATE_IDS.carry]);
  });

  it('marks a plan built on anything not live with the plate, and from a test network with its words', async () => {
    const mock = await saidBack(
      { plan: (body) => json(builtFor((body as { sheet: never }).sheet, 'mock')) },
      'live',
    );
    await click(confirm(mock.host));
    await settle();
    expect(mock.host.querySelectorAll('.tf-mock-plate')).toHaveLength(1);
    await unmountAll();
    window.sessionStorage.clear();
    const sandbox = await saidBack(
      { plan: (body) => json(builtFor((body as { sheet: never }).sheet, 'sandbox')) },
      'live',
    );
    await click(confirm(sandbox.host));
    await settle();
    expect(find(sandbox.host, '[data-ui="mock-note"]').textContent).toBe(en.shell.testNetwork);
    expect(hatchProblems(parse(sandbox.host.innerHTML))).toEqual([]);
  });

  it('says honestly when the plan cannot be built yet, and shows no plan in its place', async () => {
    const { host } = await saidBack();
    await click(confirm(host));
    await settle();
    expect(host.textContent).toContain(en.goal.built.unavailable.title);
    for (const part of ['plan-legs', 'pin', 'stat', 'exit-plan', 'data-table'])
      expect(host.querySelector(`[data-ui="${part}"]`), part).toBeNull();
  });

  it('shows no plan for another chain', async () => {
    const other = await saidBack({
      plan: (body) =>
        json(builtFor({ ...(body as { sheet: BasketSheet }).sheet, chains: ['robinhood'] })),
    });
    await click(confirm(other.host));
    await settle();
    expect(find(other.host, '[role="alert"]').textContent).toBe(en.goal.built.unreadable);
    expect(other.host.textContent).not.toContain('Robinhood Chain');
  });

  it('says no plan fits, that the server refused, or to sign in again, each in its own words', async () => {
    const cases: [number, unknown, string][] = [
      [422, { error: 'x', code: 'GOAL_NOT_ACHIEVABLE' }, en.goal.sheet.noPlan],
      [400, { error: 'body/sheet must be object' }, en.goal.blocked.refused],
      [401, { error: 'sign in first' }, en.goal.blocked.signInAgain],
      [401, { error: 'sign in first: no identity token was sent' }, en.goal.blocked.noIdentity],
      [409, { error: 'pick the chain first' }, en.goal.blocked.chainNotChosen],
      // plans are in dollars for now (gate USD-ONLY): said plainly, not as a refusal of the limits
      [422, { error: 'x', code: 'CURRENCY_UNSUPPORTED' }, en.goal.blocked.currency],
    ];
    for (const [status, body, sentence] of cases) {
      const { host } = await saidBack({ plan: () => json(body, status) });
      await click(confirm(host));
      await settle();
      expect(host.textContent, String(status)).toContain(sentence);
      expect(host.textContent).not.toMatch(/body\/sheet|no identity token was sent/);
      await unmountAll();
      window.sessionStorage.clear();
    }
  });
});

describe('an answer that arrives late', () => {
  async function building() {
    let answerWith: (res: Response) => void = () => {};
    const sent: unknown[] = [];
    const { host, server } = await saidBack({
      plan: (body) => {
        sent.push(body);
        return new Promise<Response>((resolve) => (answerWith = resolve)) as never;
      },
    });
    await click(confirm(host));
    await settle();
    expect(sent).toHaveLength(1);
    const built = () => answerWith(json(builtFor((sent[0] as { sheet: BasketSheet }).sheet)));
    return { host, server, built };
  }

  it('reads nothing more while a plan is being built', async () => {
    const { host, server, built } = await building();
    await type(box(host), 'and protect half of it');
    await press(box(host), 'Enter');
    await settle();
    expect(server.to(INTAKE_PATH)).toHaveLength(2);
    await act(async () => built());
    await settle();
    expect(host.textContent).toContain(en.goal.built.done.title);
  });

  it('is not shown to whoever is there by then', async () => {
    const { host, built } = await building();
    await act(async () => portStore.set(fakePort()));
    await settle();
    await act(async () => built());
    await settle();
    expect(host.textContent).not.toContain(en.goal.built.done.title);
    expect(intake(host)).toBeNull();
    expect(box(host).value).toBe('');
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
    await answer(host);
    await click(confirm(host));
    await settle();
    expect(sign).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    expect(host.textContent).not.toMatch(/\bbuy\b|\bsign:|deposit/i);
  });

  it('keeps what was typed and sent in the tab, through a trip away and back, and reads it again', async () => {
    const server = api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const first = await screen();
    await read(first);
    await unmountAll();
    const back = await screen();
    await settle();
    expect(box(back).value).toBe(GOAL);
    expect(intake(back)?.textContent).toContain(`“${GOAL}”`);
    expect(server.to(INTAKE_PATH)).toHaveLength(2);
    // what is in the tab's storage is not trusted: anything else is dropped
    await unmountAll();
    window.sessionStorage.setItem('tf-goal', '{"text":7,"turn":"<script>"}');
    const fresh = await screen();
    await settle();
    expect(box(fresh).value).toBe('');
    expect(intake(fresh)).toBeNull();
  });

  it('forgets what a person typed and read when they sign out, or another signs in', async () => {
    api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const host = await screen();
    await read(host);
    expect(window.sessionStorage.getItem('tf-goal')).toContain('apartment');
    await act(async () => portStore.set(fakePort()));
    await settle();
    expect(box(host).value).toBe('');
    expect(intake(host)).toBeNull();
    expect(window.sessionStorage.getItem('tf-goal') ?? '').not.toContain('apartment');
    await unmountAll();
    portStore.set(signedInPort(PHANTOM));
    const again = await screen();
    await read(again);
    await act(async () => portStore.set(signedInPort(PHANTOM, { userId: 'did:privy:other' })));
    await settle();
    expect(intake(again)).toBeNull();
  });

  it('has headings that descend in order: the goal, the reading, what came of it', async () => {
    const levels = (host: HTMLElement) =>
      [...host.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => Number(h.tagName[1]));
    const { host } = await saidBack({
      plan: (body) => json(builtFor((body as { sheet: never }).sheet, 'live')),
    });
    expect(levels(host)[0]).toBe(1);
    await click(confirm(host));
    await settle();
    const all = levels(host);
    for (let i = 1; i < all.length; i++)
      expect((all[i] as number) - (all[i - 1] as number)).toBeLessThanOrEqual(1);
    expect(all.filter((l) => l === 2)).toHaveLength(2);
  });

  it('is in Portuguese for someone who reads Portuguese', async () => {
    api({ person: onSolana });
    portStore.set(signedInPort(PHANTOM));
    const pt = dictionary('pt');
    const host = await screen('pt');
    expect(find(host, 'h1').textContent).toBe(pt.goal.title);
    expect(box(host).getAttribute('lang')).toBe('pt-BR');
    await read(host, 'Juntar US$ 40.000 até junho de 2028');
    expect(find(intake(host) as HTMLElement, 'h2').textContent).toBe(pt.goal.intake.title);
    expect(host.textContent).toContain(pt.goal.intake.questions.reply);
  });

  it('holds the binding rules at every step: no hatch without its word, no exclamation mark, a label on every control', async () => {
    api({
      person: onSolana,
      intake: (body) =>
        json(
          body.answers?.amountUsd
            ? intakeSaid()
            : intakeAsking({ method: 'model', provenance: 'mock' }),
        ),
      plan: (body) => json(builtFor((body as { sheet: never }).sheet, 'mock')),
    });
    portStore.set(signedInPort(PHANTOM, { test: true }, 'mock'));
    const host = await screen();
    const check = () => {
      expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
      expect(host.textContent).not.toMatch(/!/);
      for (const c of host.querySelectorAll<HTMLElement>('input, select, textarea')) {
        const label = c.closest('label') ?? host.querySelector(`label[for="${c.id}"]`);
        expect(label?.textContent?.trim(), c.outerHTML.slice(0, 80)).toBeTruthy();
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
    await answer(host);
    check();
    await click(confirm(host));
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

  it('is badged on the goal’s card and on the plans it built, and Robinhood’s never says USDC', async () => {
    const sheet = { ...SHEET, chains: [chain], rules: { useHoldings: true, glide: false } };
    api({
      person,
      intake: (body) => json(body.answers?.amountUsd ? intakeSaid(sheet) : intakeAsking()),
      plan: (body) => json(builtFor((body as { sheet: never }).sheet, 'mock')),
    });
    portStore.set(signedInPort(person.wallets));
    const host = await screen();
    await read(host);
    await answer(host);
    const named = [[chain, CHAIN_NAMES[chain]]];
    expect(badged(host.querySelector('[data-ui="goal-card"]'))).toEqual(named);
    await click(confirm(host));
    await settle();
    const done = [...host.querySelectorAll('[data-ui="card"]')].find((card) =>
      card.textContent?.includes(en.goal.built.done.title),
    );
    expect(badged(done ?? null)).toEqual(named);
    if (chain === 'robinhood') expect(host.textContent).not.toMatch(/usdc/i);
  });
});
