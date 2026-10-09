// @vitest-environment happy-dom
import { PortfolioResponse } from '@colosseum/schemas';
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
import { dictionary } from '../../i18n';
import { ChainSwitch } from '../account/ChainSwitch';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { chainOf, robinhoodChain } from '../portfolio/test/portfolio';
import { preview } from '../vault-conversation/test/fixtures';
import {
  EMBEDDED,
  EVM,
  fakePort,
  json,
  METAMASK,
  SOLANA,
  signedInPort,
} from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { goalConversationKey } from './GoalConversation';
import { GoalHome } from './GoalHome';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The chain of a new plan on /goal (gate CHAIN-AT-THE-PLAN): chosen beside the box before the
// conversation has words, a badge with "Change" after, and never a mode of the app. It reads and
// writes the same thing the bar's switch does (`account.chain`, PUT /v1/me/chain), so the two agree.

const en = dictionary('en');
const c = en.chain.choice;
const userId = 'did:privy:test';
const replies: string[] = [];
const puts: string[] = [];

const passkey = (chain: Person['chain']): Person => ({
  userId,
  wallets: EMBEDDED,
  chain,
  chainSource: 'picked',
  chainOptions: ['solana', 'robinhood'],
});

/** The API's side: the person, the chain switches sent to it, and a proposal for every message. */
function api(start: Person, refuse?: () => Response | null, portfolio?: unknown) {
  let person = start;
  portStore.setApi(async (path, init) => {
    const method = init?.method ?? 'GET';
    if (path === '/v1/me') return json(person);
    if (path === '/v1/me/chain' && method === 'PUT') {
      const { chain } = JSON.parse(String(init?.body));
      puts.push(chain);
      const refused = refuse?.();
      if (refused) return refused;
      person = { ...person, chain, chainSource: 'picked' };
      return json(person);
    }
    if (path === '/v1/portfolio' && portfolio) return json(portfolio);
    const reply = /^\/v1\/conversations\/(\w+)\/goal\/reply$/.exec(path);
    if (reply?.[1] && method === 'POST') {
      replies.push(reply[1]);
      const { messageId } = JSON.parse(String(init?.body));
      return json({
        version: 1,
        chain: reply[1],
        messageId,
        message: 'Here is a private preview.',
        question: null,
        proposal: preview,
      });
    }
    return json({ error: 'not found' }, 404);
  });
}

const show = (withBar = false) =>
  mount(
    withAccount('en', [
      ...(withBar ? [createElement(ChainSwitch, { key: 'bar' })] : []),
      createElement(GoalHome, { key: 'goal' }),
    ]),
  );
const radios = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLInputElement>('[data-ui="chain-choice"] input[type="radio"]'),
];
const checked = (host: HTMLElement) => radios(host).find((r) => r.checked)?.value;
const send = async (host: HTMLElement, words: string) => {
  await type(find<HTMLTextAreaElement>(host, 'textarea'), words);
  await click(find(host, '[data-ui="composer-send"]'));
  await settle();
};
const picker = (host: HTMLElement) => find<HTMLSelectElement>(host, '[data-ui="goal-picker"]');
const bar = (host: HTMLElement) =>
  find(host, '[data-ui="chain-switch"] > button').getAttribute('data-chain');

beforeEach(() => {
  window.history.replaceState(null, '', '/goal');
  localStorage.clear();
  sessionStorage.clear();
  replies.length = 0;
  puts.length = 0;
  portStore.set(signedInPort(EMBEDDED, { userId }));
});
afterEach(unmountAll);

describe('the chain of a new plan, chosen on /goal', () => {
  it('starts on the person’s last chain, as two options with each wallet and the test-network mark', async () => {
    api(passkey('robinhood'));
    const host = await show();
    await settle();
    const group = find(host, 'fieldset[data-ui="chain-choice"]');
    expect(find(group, 'legend').textContent).toBe(c.legend);
    expect(radios(host).map((r) => r.value)).toEqual(['solana', 'robinhood']);
    expect(checked(host)).toBe('robinhood');
    // one group: the arrow keys move inside it, and Tab stops on it once
    expect(new Set(radios(host).map((r) => r.name)).size).toBe(1);
    const solana = find(group, 'label[data-chain="solana"]');
    const robinhood = find(group, 'label[data-chain="robinhood"]');
    expect(solana.textContent).toContain('Solana');
    expect(solana.textContent).toContain('So11…1112');
    expect(solana.textContent).toContain(c.wallet(SOLANA));
    expect(robinhood.textContent).toContain('Robinhood Chain');
    expect(robinhood.textContent).toContain(c.wallet(EVM));
    // never shown as live: the sample glyph, named, with the words
    for (const option of [solana, robinhood]) {
      expect(find(option, '[data-ui="sample-glyph"]').getAttribute('aria-label')).toBe(
        en.shell.sampleFigure,
      );
      expect(option.textContent).toContain(en.shell.testNetwork);
    }
    expect(puts).toEqual([]);
    expect(host.querySelector('[data-act="chain-change"]')).toBeNull();
  });

  it('changes before the first message with no question, keeps the focus, and the bar agrees', async () => {
    api(passkey('solana'));
    const host = await show(true);
    await settle();
    expect([checked(host), bar(host)]).toEqual(['solana', 'solana']);
    await click(find(host, 'label[data-chain="robinhood"] input'));
    await settle();
    expect(puts).toEqual(['robinhood']);
    expect([checked(host), bar(host)]).toEqual(['robinhood', 'robinhood']);
    expect(host.querySelector('[data-ui="goal-chain-confirm"]')).toBeNull();
    expect(document.activeElement).toBe(find(host, 'label[data-chain="robinhood"] input'));
    expect(find(host, '[data-ui="goal-chain-said"]').textContent).toBe(c.done('Robinhood Chain'));
    // the plan is made there
    await send(host, 'Consider gold');
    expect(replies).toEqual(['robinhood']);
    expect(localStorage.getItem(goalConversationKey(userId, 'robinhood', 'sandbox'))).toContain(
      'Consider gold',
    );
  });

  it('follows the bar’s switch while the bar still has one', async () => {
    api(passkey('solana'));
    const host = await show(true);
    await settle();
    await click(find(host, '[data-ui="chain-switch"] > button'));
    await click(find(host, '[data-ui="chain-switch-panel"] button[data-chain="robinhood"]'));
    await settle();
    expect([checked(host), bar(host)]).toEqual(['robinhood', 'robinhood']);
  });

  it('once the conversation has words, shows a badge with "Change", and a change asks first', async () => {
    api(passkey('solana'));
    const host = await show();
    await settle();
    await send(host, 'Consider gold');
    expect(radios(host)).toEqual([]);
    const line = find(host, '[data-ui="goal-chain"]');
    expect(find(line, '[data-ui="chain-badge"]').textContent).toBe('Solana');
    expect(line.textContent).toContain(c.on);
    const change = find(host, '[data-act="chain-change"]');
    expect(change.getAttribute('aria-label')).toBe(c.changeLabel);
    await click(change);
    const ask = find(host, '[data-ui="goal-chain-confirm"]');
    expect(ask.getAttribute('role')).toBe('group');
    expect(ask.textContent).toContain(c.confirm('Robinhood Chain'));
    expect(document.activeElement).toBe(find(ask, '[data-act="chain-start"]'));
    expect(puts).toEqual([]);
    // not taken: nothing changes, and focus is back on "Change"
    await click(find(ask, '[data-act="chain-keep"]'));
    expect(host.querySelector('[data-ui="goal-chain-confirm"]')).toBeNull();
    expect(document.activeElement).toBe(find(host, '[data-act="chain-change"]'));
    await click(find(host, '[data-act="chain-change"]'));
    await press(find(host, '[data-act="chain-start"]'), 'Escape');
    expect(host.querySelector('[data-ui="goal-chain-confirm"]')).toBeNull();
    expect(puts).toEqual([]);
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain('Consider gold');
  });

  it('a change after a proposal starts a new conversation on the other chain and keeps the first', async () => {
    api(passkey('solana'));
    // a conversation with words was last open on the other chain: it is not the one that opens
    const there = goalConversationKey(userId, 'robinhood', 'sandbox');
    localStorage.setItem(
      there,
      JSON.stringify({
        revision: 0,
        transcript: [{ id: 'old', who: 'person', text: 'An older Robinhood idea' }],
      }),
    );
    const host = await show();
    await settle();
    await send(host, 'Consider gold');
    expect(host.querySelector('[data-ui="mix-joint"]')).not.toBeNull();
    await click(find(host, '[data-act="chain-change"]'));
    await click(find(host, '[data-act="chain-start"]'));
    await settle();
    expect(puts).toEqual(['robinhood']);
    // an empty conversation on Robinhood Chain, with the choice back and focus on it
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toBe('');
    expect(host.querySelector('[data-ui="mix-joint"]')).toBeNull();
    expect(checked(host)).toBe('robinhood');
    expect(document.activeElement).toBe(find(host, 'label[data-chain="robinhood"] input'));
    // both earlier conversations are kept, each with its chain as text
    const saved = [...picker(host).options].filter((o) => o.value.startsWith('conversation:'));
    expect(saved.map((o) => o.textContent).sort()).toEqual([
      'Consider gold · Solana',
      `${en.goal.explore.picker.untitled} · Robinhood Chain`,
    ]);
    // nothing of the draft went with the chain
    await send(host, 'Something else');
    expect(replies).toEqual(['solana', 'robinhood']);
    expect(localStorage.getItem(there)).toContain('An older Robinhood idea');
    expect(localStorage.getItem(there)).not.toContain('Something else');
    // the first conversation opens again on its own chain
    const first = [...picker(host).options].find((o) => o.textContent === 'Consider gold · Solana');
    picker(host).value = first?.value ?? '';
    await fire(picker(host), new Event('change', { bubbles: true }));
    await settle();
    expect(puts).toEqual(['robinhood', 'solana']);
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain('Consider gold');
    expect(find(find(host, '[data-ui="goal-chain"]'), '[data-ui="chain-badge"]').textContent).toBe(
      'Solana',
    );
  });

  it('says why a switch was not stored, and stays on the chain it was on', async () => {
    api(passkey('solana'), () => json({ error: 'down' }, 503));
    const host = await show();
    await settle();
    await click(find(host, 'label[data-chain="robinhood"] input'));
    await settle();
    expect(checked(host)).toBe('solana');
    expect(find(host, '[data-ui="goal-chain"] [role="alert"]').textContent).toBe(
      en.chain.failure.unreachable,
    );
  });

  it('shows a person whose wallet signs on one chain that chain alone, and why', async () => {
    portStore.set(signedInPort(METAMASK, { userId }));
    api({
      userId,
      wallets: METAMASK,
      chain: 'robinhood',
      chainSource: 'wallet',
      chainOptions: ['robinhood'],
    });
    const host = await show();
    await settle();
    expect(radios(host)).toEqual([]);
    const line = find(host, '[data-ui="goal-chain"]');
    expect(line.textContent).toContain(c.onlyWallet('Robinhood Chain'));
    expect(line.textContent).not.toContain('Solana');
    expect(line.textContent).toContain(en.shell.testNetwork);
    // and after the first words: the badge, with nothing to change to
    await send(host, 'Consider gold');
    expect(replies).toEqual(['robinhood']);
    expect(find(find(host, '[data-ui="goal-chain"]'), '[data-ui="chain-badge"]').textContent).toBe(
      'Robinhood Chain',
    );
    expect(host.querySelector('[data-act="chain-change"]')).toBeNull();
  });

  it('offers only the chain our server runs when the other is switched off', async () => {
    const port = signedInPort(EMBEDDED, { userId });
    portStore.set({
      ...port,
      network: (chain) => ({ ...port.network(chain), on: chain === 'solana' }) as never,
    });
    api(passkey('solana'));
    const host = await show();
    await settle();
    expect(radios(host)).toEqual([]);
    expect(find(host, '[data-ui="goal-chain"]').textContent).toContain(c.onlyOn('Solana'));
  });

  it('signed out, keeps the choice in this browser and names no wallet', async () => {
    portStore.set(fakePort());
    const host = await show(true);
    await settle();
    expect(checked(host)).toBe('solana');
    expect(find(host, 'fieldset[data-ui="chain-choice"]').textContent).not.toContain('wallet');
    await click(find(host, 'label[data-chain="robinhood"] input'));
    await settle();
    expect([checked(host), bar(host)]).toEqual(['robinhood', 'robinhood']);
    expect(localStorage.getItem('tf-chain')).toBe('robinhood');
    expect(puts).toEqual([]);
  });

  it('names the chain of each vault in the picker', async () => {
    api(
      passkey('solana'),
      undefined,
      PortfolioResponse.parse({
        chains: [chainOf(), robinhoodChain()],
        disclaimer: 'from the constant',
      }),
    );
    const host = await show();
    await settle();
    const vaults = [...picker(host).options].filter((o) => o.value.startsWith('vault:'));
    expect(vaults.map((o) => o.textContent?.split(' · ').at(-1))).toEqual([
      'Solana',
      'Robinhood Chain',
    ]);
  });
});
