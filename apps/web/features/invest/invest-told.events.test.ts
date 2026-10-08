// @vitest-environment happy-dom
import type { BasketSheet } from '@colosseum/schemas';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { ChainSwitch } from '../account/ChainSwitch';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { PERSONALIZE_PATH } from '../goal/build-plan';
import { proposalFor } from '../goal/test/plan';
import type { InvestProps } from '../order/Invest';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { InvestScreen } from './InvestScreen';
import { INTAKE_PATH } from './intake';

// What the invest card tells the conversation. The card itself is tested where it lives
// (features/order/invest.events.test.ts); here it is a double that hands over what it was given, so
// the test can say what the card says: a step ran, the vault is open, the buy stopped.

const card = vi.hoisted(() => ({ props: null as unknown }));
vi.mock('../order/Invest', async () => {
  const { createElement: element } = await import('react');
  return {
    Invest: (props: unknown) => {
      card.props = props;
      return element('div', { 'data-ui': 'invest-card-double' });
    },
  };
});
vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

const en = dictionary('en');
const USER = 'did:privy:test';
const person: Person = {
  userId: USER,
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: [],
};
const told = () => card.props as InvestProps;
const last = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-ui="invest-turns"] > li[data-who="app"]')].at(-1) as HTMLElement;

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  card.props = null;
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
  portStore.setApi(async (path, init) => {
    if (path === '/v1/me') return json(person);
    if (path === PERSONALIZE_PATH) {
      const sheet = (JSON.parse(String(init?.body)) as { sheet: BasketSheet }).sheet;
      return json({ id: 'plan-1', proposal: proposalFor(sheet, 'sandbox') });
    }
    // an API with no guided intake: the rules reader reads the goal
    if (path === INTAKE_PATH) return json({ error: 'Route not found' }, 404);
    return json({ error: 'down' }, 503);
  });
});
afterEach(unmountAll);

async function built() {
  const host = await mount(withAccount('en', createElement(InvestScreen)));
  await settle();
  await click(
    [...host.querySelectorAll('button')].find(
      (b) => b.textContent === en.goal.examples.list[1],
    ) as HTMLElement,
  );
  await settle();
  await settle();
  await click(find(host, '[data-ui="invest-replies"] button'));
  await settle();
  await settle();
  return host;
}

describe('the invest card, in the pane', () => {
  it('is given the plan and the plan’s amount', async () => {
    await built();
    expect(told().of).toEqual({ plan: 'plan-1' });
    expect(told().amount).toBe(50000);
  });

  it('says one line in the conversation as each step runs, in the card’s own words, each once', async () => {
    const host = await built();
    const before = host.querySelectorAll('[data-ui="invest-turns"] > li').length;
    await act(async () => {
      // the press itself has no line yet
      told().onProgress?.({ orderId: 'o', step: 0, of: 0, line: '' });
      told().onProgress?.({ orderId: 'o', step: 1, of: 2, line: 'Opening your vault · 1 of 2' });
      told().onProgress?.({ orderId: 'o', step: 1, of: 2, line: 'Opening your vault · 1 of 2' });
      told().onProgress?.({
        orderId: 'o',
        step: 2,
        of: 2,
        line: 'Deposit confirmed · Buying USDY · 2 of 2',
      });
    });
    const lines = [...host.querySelectorAll('[data-ui="invest-turns"] > li')]
      .slice(before)
      .map((li) => li.textContent);
    expect(lines).toEqual([
      `${en.talk.me}Opening your vault · 1 of 2`,
      `${en.talk.me}Deposit confirmed · Buying USDY · 2 of 2`,
    ]);
  });

  it('says the vault is open when every step is confirmed, with the way to the portfolio', async () => {
    const host = await built();
    await act(async () => told().onDone?.({ orderId: 'o', vault: 'vault-address' }));
    expect(last(host).textContent).toContain(en.talk.say.done);
    const link = find(last(host), 'a');
    expect([link.textContent, link.getAttribute('href')]).toEqual([
      en.order.outcome.seePortfolio,
      '/monitor',
    ]);
  });

  it('says the buy stopped, that what landed is kept, and where it is finished', async () => {
    const host = await built();
    await act(async () => told().onStopped?.({ orderId: 'order-7' }));
    expect(last(host).textContent).toContain(en.talk.say.stopped);
    const link = find(last(host), 'a');
    expect([link.textContent, link.getAttribute('href')]).toEqual([
      en.talk.say.finish,
      '/orders/order-7',
    ]);
  });

  it('keeps a running card on the pane, with nothing offered that would change or take away its plan, until it stops', async () => {
    const host = await built();
    const box = () => find<HTMLTextAreaElement>(host, '[data-ui="invest-chat"] textarea');
    const startOver = () =>
      find(host, '[data-ui="invest-start-over"] button').getAttribute('aria-disabled');
    const facts = () => [...host.querySelectorAll('[data-ui="pane-facts"] [aria-disabled="true"]')];
    expect(box().disabled).toBe(false);
    expect(startOver()).toBeNull();
    expect(facts()).toEqual([]);
    // the press approves the order: the run is under way from here
    await act(async () => told().onProgress?.({ orderId: 'o', step: 0, of: 0, line: '' }));
    expect(box().disabled).toBe(true);
    expect(startOver()).toBe('true');
    expect(facts().length).toBeGreaterThan(0);
    expect(host.querySelector('[data-ui="invest-replies"]')).toBeNull();
    // what is typed meanwhile is not sent: no turn is added, and the card is still there with its run
    const turns = host.querySelectorAll('[data-ui="invest-turns"] > li').length;
    await type(box(), 'why gold?');
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    expect(host.querySelectorAll('[data-ui="invest-turns"] > li')).toHaveLength(turns);
    expect(
      host.querySelector('[data-ui="invest-step"] [data-ui="invest-card-double"]'),
    ).not.toBeNull();
    // once it stops, the conversation is open again
    await act(async () => told().onStopped?.({ orderId: 'o' }));
    expect(box().disabled).toBe(false);
    expect(startOver()).toBeNull();
    expect(
      host.querySelector('[data-ui="invest-step"] [data-ui="invest-card-double"]'),
    ).not.toBeNull();
  });

  it('keeps the plan and its running card when the person changes chain, and builds for the new chain once the run has stopped', async () => {
    const asked: string[][] = [];
    let me = person;
    portStore.setApi(async (path, init) => {
      if (path === '/v1/me') return json(me);
      if (path === '/v1/me/chain' && init?.method === 'PUT') {
        me = { ...me, chain: (JSON.parse(String(init.body)) as { chain: 'robinhood' }).chain };
        return json(me);
      }
      if (path === PERSONALIZE_PATH) {
        const sheet = (JSON.parse(String(init?.body)) as { sheet: BasketSheet }).sheet;
        asked.push(sheet.chains);
        return json({ id: `plan-${asked.length}`, proposal: proposalFor(sheet, 'sandbox') });
      }
      if (path === INTAKE_PATH) return json({ error: 'Route not found' }, 404);
      return json({ error: 'down' }, 503);
    });
    const host = await mount(
      withAccount('en', [
        createElement(ChainSwitch, { key: 'switch' }),
        createElement(InvestScreen, { key: 'screen' }),
      ]),
    );
    await settle();
    await click(
      [...host.querySelectorAll('button')].find(
        (b) => b.textContent === en.goal.examples.list[1],
      ) as HTMLElement,
    );
    await settle();
    await settle();
    await click(find(host, '[data-ui="invest-replies"] button'));
    await settle();
    await settle();
    expect(asked).toEqual([['solana']]);
    expect(told().of).toEqual({ plan: 'plan-1' });
    await act(async () => told().onProgress?.({ orderId: 'o', step: 0, of: 0, line: '' }));
    // the bar's switch, pressed while the steps run
    await click(find(host, '[data-ui="chain-switch"] > button'));
    await click(find(host, '[data-ui="chain-switch-panel"] button[data-chain="robinhood"]'));
    await settle();
    await settle();
    await settle();
    // no plan is built over the one being bought, and its card is the one on the pane
    expect(asked).toEqual([['solana']]);
    expect(told().of).toEqual({ plan: 'plan-1' });
    expect(
      host.querySelector('[data-ui="invest-step"] [data-ui="invest-card-double"]'),
    ).not.toBeNull();
    // the run stops: the plan is built for the chain the person is on now
    await act(async () => told().onStopped?.({ orderId: 'o' }));
    await settle();
    await settle();
    expect(asked).toEqual([['solana'], ['robinhood']]);
  });

  it('keeps none of the card’s lines in the tab: a sentence is never read back from storage', async () => {
    const host = await built();
    await act(async () =>
      told().onProgress?.({ orderId: 'o', step: 1, of: 2, line: 'Opening your vault · 1 of 2' }),
    );
    await unmountAll();
    const again = await mount(withAccount('en', createElement(InvestScreen)));
    await settle();
    expect(again.textContent).not.toContain('Opening your vault');
    expect(host).toBeTruthy();
  });
});
