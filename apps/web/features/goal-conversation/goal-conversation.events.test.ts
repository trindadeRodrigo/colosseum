// @vitest-environment happy-dom
import { act, createElement, StrictMode, useState } from 'react';
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
import { withAccount } from '../account/test/screen';
import { GOAL_HANDOFF, GOAL_HANDOFF_OWNER } from '../goal/draft';
import { CHECK_MS } from '../mix/DepositStep';
import { sourceValue } from '../vault-conversation/StrategyPreview';
import { preview } from '../vault-conversation/test/fixtures';
import { fakePort, json, PHANTOM, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { GoalConversation, goalConversationKey } from './GoalConversation';
import { GoalHome } from './GoalHome';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));
const userId = 'did:privy:test';
const en = dictionary('en');
const path = '/v1/conversations/solana/goal/reply';
const calls: { path: string; body: Record<string, unknown> }[] = [];
const response = (messageId: string) => ({
  version: 1,
  chain: 'solana',
  messageId,
  message: 'Here is a private preview.',
  question: null,
  proposal: preview,
});
const person = {
  userId,
  wallets: PHANTOM,
  chain: 'solana',
  chainSource: 'wallet',
  chainOptions: [],
};
const baseApi = async (url: string) => (url === '/v1/me' ? json(person) : json({}, 404));
const send = async (host: HTMLElement, words: string) => {
  await type(find<HTMLTextAreaElement>(host, 'textarea'), words);
  await click(find(host, '[data-ui="composer-send"]'));
  await settle();
};
const show = (lang: 'en' | 'pt' = 'en') => mount(withAccount(lang, createElement(GoalHome)));
async function mode(host: HTMLElement, value: string) {
  const selector = find<HTMLSelectElement>(host, '[data-ui="goal-picker"]');
  selector.value = value;
  await fire(selector, new Event('change', { bubbles: true }));
}
beforeEach(() => {
  window.history.replaceState(null, '', '/goal');
  router.push.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  calls.length = 0;
  portStore.set(signedInPort(PHANTOM, { userId }));
  portStore.setApi(async (url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      calls.push({ path: url, body });
      return json(response(body.messageId));
    }
    return baseApi(url);
  });
});
afterEach(unmountAll);

describe('private strategy exploration for a new goal', () => {
  it('keeps the same owner’s new-goal words separate across configured networks', async () => {
    const first = goalConversationKey(userId, 'solana', 'mock', 'testnet');
    const other = goalConversationKey(userId, 'solana', 'mock', 'mainnet');
    expect(first).not.toBe(other);
    localStorage.setItem(
      first,
      JSON.stringify({
        revision: 0,
        transcript: [{ id: 'testnet-turn', who: 'person', text: 'Test-network discussion' }],
      }),
    );
    expect(localStorage.getItem(other)).toBeNull();
    localStorage.setItem(
      `tf-goal-conversation:1:${encodeURIComponent(userId)}:solana:mock`,
      JSON.stringify({
        revision: 0,
        transcript: [{ id: 'old-turn', who: 'person', text: 'Unscoped older discussion' }],
      }),
    );
    const host = await show();
    expect(host.textContent).not.toContain('Unscoped older discussion');
    expect(
      localStorage.getItem(`tf-goal-conversation:1:${encodeURIComponent(userId)}:solana:mock`),
    ).toContain('Unscoped older discussion');
  });
  it.each(['en', 'pt'] as const)(
    'offers keyboard-accessible local starters, then sends only the person’s edited words (%s)',
    async (lang) => {
      const host = await show(lang);
      const starters = find(host, '[data-ui="goal-starters"]');
      const buttons = [...starters.querySelectorAll<HTMLButtonElement>('button')];
      expect(buttons.map((button) => button.textContent)).toEqual(
        dictionary(lang).goal.explore.starters,
      );
      const composer = find<HTMLTextAreaElement>(host, 'textarea');
      for (const button of buttons) {
        expect(button.type).toBe('button');
        expect(button.tabIndex).toBe(0);
        button.focus();
        expect(document.activeElement).toBe(button);
        await press(button, 'Enter');
        // Native buttons activate through a click for Enter/Space, as in Button's DOM tests.
        await click(button);
        expect(composer.value).toBe(button.textContent);
        expect(document.activeElement).toBe(composer);
        expect(calls).toHaveLength(0);
        expect(localStorage.getItem(goalConversationKey(userId, 'solana', 'sandbox'))).toBeNull();
      }
      const words =
        lang === 'en' ? 'Explore gold and keep some cash' : 'Explorar ouro e manter parte em caixa';
      await type(composer, words);
      expect(calls).toHaveLength(0);
      await press(composer, 'Enter');
      await settle();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        path,
        body: { messages: [{ who: 'person', text: words }] },
      });
      expect(host.querySelector('[data-ui="goal-starters"]')).toBeNull();
      expect(calls.some((call) => call.path.includes('/orders'))).toBe(false);
    },
  );
  it('keeps signed-out starters disabled without prefilling or sending', async () => {
    portStore.set(fakePort());
    const host = await show();
    const buttons = [...find(host, '[data-ui="goal-starters"]').querySelectorAll('button')];
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.getAttribute('aria-disabled')).toBe('true');
      await click(button);
    }
    expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe('');
    expect(find<HTMLTextAreaElement>(host, 'textarea').disabled).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it.each(['en', 'pt'] as const)(
    'defaults to truthful explore workbench with no fake vault or funding (%s)',
    async (lang) => {
      const host = await show(lang);
      // No Guided or Explore switch (#195): the conversation picker is its own control, under its own id.
      expect(host.querySelector('[data-ui="goal-mode"]')).toBeNull();
      expect(find<HTMLSelectElement>(host, '[data-ui="goal-picker"]').value).toBe('current');
      expect(find(host, '[data-ui="goal-empty-preview"]').textContent).toContain(
        dictionary(lang).goal.explore.empty,
      );
      expect(host.querySelector('[data-ui="invest-screen"]')).toBeNull();
      expect(host.querySelector('[data-ui="mix-joint"]')).toBeNull();
      expect(host.querySelector('[data-ui="buy-card"]')).toBeNull();
      expect(host.querySelector('a[href^="/vaults/"]')).toBeNull();
      await send(host, 'I want a strategy with gold and cash');
      expect(calls).toHaveLength(1);
      expect(calls[0].path).toBe(path);
      expect(calls[0].body).toMatchObject({
        version: 1,
        language: lang,
        messages: [{ who: 'person', text: 'I want a strategy with gold and cash' }],
      });
      expect(calls[0].body).not.toHaveProperty('vault');
      expect(calls[0].body).not.toHaveProperty('address');
      // on a proposal the line over "Deposit" says how the draft is bought, not that it cannot be
      expect(find(host, '[data-ui="goal-strategy"]').textContent).toContain(
        dictionary(lang).goal.explore.draftNote,
      );
      expect(find(host, '[data-ui="goal-strategy"]').textContent).not.toContain(
        dictionary(lang).goal.explore.previewOnly,
      );
      expect(find(host, '[data-ui="goal-strategy"]').textContent).not.toContain(
        dictionary(lang).shared.vault.conversation.comparison,
      );
      expect(
        [...host.querySelectorAll<HTMLElement>('[data-ui="mix-joint"] [data-part="piece"]')].map(
          (e) => e.style.width,
        ),
      ).toEqual(['40%', '60%']);
      expect(host.querySelector('[data-ui="buy-card"]')).toBeNull();
      // The preview's one primary button is "Deposit" (gate DEPOSIT-STEP, Thom, Oct 8): it opens the
      // deposit step, and neither buys, funds nor signs anything.
      const primary = [
        ...find(host, '[data-ui="goal-strategy"]').querySelectorAll(
          'button[data-variant="primary"]',
        ),
      ];
      expect(primary.map((button) => button.textContent)).toEqual([
        dictionary(lang).mix.preview.deposit,
      ]);
      const before = calls.length;
      await click(primary[0] as HTMLElement);
      expect(host.querySelector('[data-ui="deposit-step"]')).not.toBeNull();
      expect(host.querySelector('[data-ui="buy-card"]')).toBeNull();
      expect(calls).toHaveLength(before);
      expect(router.push).not.toHaveBeenCalled();
    },
  );
  it('sends complete words and actual prior nonexecuted draft weights to refine the next turn', async () => {
    const host = await show();
    await send(host, 'Consider gold');
    await send(host, 'Less gold please');
    const messages = calls[1].body.messages as { who: string; text: string }[];
    expect(messages[0]).toEqual({ who: 'person', text: 'Consider gold' });
    expect(
      messages.some(
        (row) =>
          row.who === 'app' &&
          row.text.includes(en.shared.vault.conversation.draftIntro) &&
          row.text.includes('tGLDx (solana:gldx): 40%') &&
          row.text.includes('exit'),
      ),
    ).toBe(true);
    expect(messages.at(-1)).toEqual({ who: 'person', text: 'Less gold please' });
    expect(calls.every((row) => row.path === path)).toBe(true);
  });
  // Rodrigo, Oct 8: the picker holds this conversation and a new one; the last preview is kept
  // in this browser and shown again on return, still a preview with no way to fund it; "New
  // conversation" clears both.
  it('shows the last preview again on return, offers no funding, and keeps earlier conversations to reopen', async () => {
    let host = await show();
    await send(host, 'Consider gold');
    expect(host.querySelector('[data-ui="mix-joint"]')).not.toBeNull();
    await unmountAll();
    host = await show();
    await settle();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain('Consider gold');
    expect(host.querySelector('[data-ui="mix-joint"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="goal-empty-preview"]')).toBeNull();
    expect(host.querySelector('[data-ui="buy-card"]')).toBeNull();
    expect(
      find(host, '[data-ui="goal-strategy"]').querySelector('button[data-variant="primary"]'),
    ).toBeNull();
    expect(
      [...find<HTMLSelectElement>(host, '[data-ui="goal-picker"]').options].map((o) => o.value),
    ).toEqual(['current', 'new']);
    await mode(host, 'new');
    await settle();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toBe('');
    expect(host.querySelector('[data-ui="goal-empty-preview"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="mix-joint"]')).toBeNull();
    // The earlier conversation is kept, listed by its first words, and comes back with its preview.
    await unmountAll();
    host = await show();
    await settle();
    expect(host.querySelector('[data-ui="mix-joint"]')).toBeNull();
    const saved = [...find<HTMLSelectElement>(host, '[data-ui="goal-picker"]').options].find((o) =>
      o.value.startsWith('conversation:'),
    );
    // with its chain as text: the picker lists what lives on one chain (gate CHAIN-AT-THE-PLAN)
    expect(saved?.textContent).toBe('Consider gold · Solana');
    await mode(host, saved?.value ?? '');
    await settle();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain('Consider gold');
    expect(host.querySelector('[data-ui="mix-joint"]')).not.toBeNull();
    expect(calls).toHaveLength(1);
  });
  it('preserves exact plain words across unavailable API and reopen without fabricating reply', async () => {
    portStore.setApi(async (url) => baseApi(url));
    const words = '<img src=x onerror=alert(1)> I like electric vehicles';
    const host = await show();
    await send(host, words);
    expect(host.textContent).toContain(en.goal.explore.unavailable);
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain(words);
    expect(host.querySelector('img[src="x"]')).toBeNull();
    await unmountAll();
    const reopened = await show();
    expect(find(reopened, '[data-ui="goal-transcript"]').textContent).toContain(words);
    expect(reopened.querySelector('[data-ui="goal-empty-preview"]')).not.toBeNull();
  });
  it.each(['en', 'pt'] as const)(
    'after a failed reply the words are back in the box, and trying again sends the one turn (%s)',
    async (lang) => {
      const copy = dictionary(lang).goal.explore;
      const words = 'Explore electric vehicles';
      let down = true;
      portStore.setApi(async (url, init) => {
        if (init?.method !== 'POST') return baseApi(url);
        const body = JSON.parse(String(init.body));
        calls.push({ path: url, body });
        return down ? json({}, 503) : json(response(body.messageId));
      });
      const host = await show(lang);
      expect(host.querySelector('[data-ui="goal-retry"]')).toBeNull();
      await send(host, words);
      expect(host.textContent).toContain(copy.unavailable);
      expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe(words);
      const retry = find(host, '[data-ui="goal-retry"]');
      const again = find<HTMLButtonElement>(retry, 'button[data-act="goal-retry"]');
      expect(again.textContent).toBe(copy.retry);
      const way = find<HTMLAnchorElement>(retry, 'a[href="/shelf"]');
      expect(way.textContent).toBe(copy.elsewhere);
      expect(again.tabIndex).toBe(0);
      expect(way.tabIndex).toBe(0);
      // still down: "Try again" sends the same turn, and so does sending the box as it stands
      await click(again);
      await settle();
      await click(find(host, '[data-ui="composer-send"]'));
      await settle();
      const sent = (i: number) => calls[i].body.messages as { who: string; text: string }[];
      expect(calls).toHaveLength(3);
      for (const i of [0, 1, 2]) expect(sent(i)).toEqual([{ who: 'person', text: words }]);
      const turns = () => [...find(host, '[data-ui="goal-transcript"]').children];
      expect(turns()).toHaveLength(1);
      // back up: one more press, the reply follows the one turn, and the box and the row are clear
      down = false;
      await click(find(host, 'button[data-act="goal-retry"]'));
      await settle();
      expect(sent(3)).toEqual([{ who: 'person', text: words }]);
      expect(turns().filter((turn) => turn.textContent?.includes(words))).toHaveLength(1);
      expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe('');
      expect(host.querySelector('[data-ui="goal-retry"]')).toBeNull();
      expect(host.textContent).not.toContain(copy.unavailable);
      expect(
        JSON.parse(
          localStorage.getItem(goalConversationKey(userId, 'solana', 'sandbox')) ?? '{}',
        ).transcript.filter((turn: { text: string }) => turn.text === words),
      ).toHaveLength(1);
    },
  );
  it.each(['en', 'pt'] as const)(
    'explains only checked server failures and retains the person words (%s)',
    async (lang) => {
      const copy = dictionary(lang).goal.explore;
      for (const reason of ['timeout', 'budget', 'invalid', 'unavailable'] as const) {
        portStore.setApi(async (url, init) =>
          init?.method === 'POST'
            ? json(
                { code: 'GOAL_AGENT_UNAVAILABLE', reason, error: '<script>private error</script>' },
                503,
              )
            : baseApi(url),
        );
        const host = await show(lang);
        await send(host, 'Explore electric vehicles');
        expect(host.textContent).toContain(copy[reason]);
        expect(host.textContent).not.toContain('private error');
        expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain(
          'Explore electric vehicles',
        );
        expect(host.querySelector('[data-ui="goal-empty-preview"]')).not.toBeNull();
        expect(host.querySelector('[data-ui="buy-card"]')).toBeNull();
        await unmountAll();
        localStorage.clear();
      }
    },
  );
  it.each([
    { code: 'OTHER_ERROR', reason: 'budget' },
    { code: 'GOAL_AGENT_UNAVAILABLE', reason: '<img src=x onerror=alert(1)>' },
    { code: 'GOAL_AGENT_UNAVAILABLE', reason: null },
  ])('keeps unknown failure payloads out of product copy: %j', async (failure) => {
    portStore.setApi(async (url, init) =>
      init?.method === 'POST' ? json(failure, 503) : baseApi(url),
    );
    const host = await show();
    await send(host, 'Explore technology');
    expect(host.textContent).toContain(en.goal.explore.unavailable);
    expect(host.textContent).not.toContain(en.goal.explore.budget);
    expect(host.querySelector('img[src="x"]')).toBeNull();
    expect(host.querySelector('[data-ui="goal-empty-preview"]')).not.toBeNull();
  });
  it('ignores a late reply after a chain or person switch and never writes it into another history', async () => {
    let resolve: (value: Response) => void = () => {};
    let messageId = '';
    portStore.setApi(async (url, init) =>
      init?.method === 'POST'
        ? new Promise<Response>((r) => {
            messageId = JSON.parse(String(init?.body)).messageId;
            resolve = r;
          })
        : baseApi(url),
    );
    let change: (user: string, chain: 'solana' | 'robinhood') => void = () => {};
    function Screen() {
      const [state, setState] = useState({
        user: userId,
        chain: 'solana' as 'solana' | 'robinhood',
      });
      change = (user, chain) => setState({ user, chain });
      return createElement(GoalConversation, {
        key: `${state.user}:${state.chain}`,
        userId: state.user,
        chain: state.chain,
        provenance: 'sandbox',
        ready: true,
      });
    }
    const host = await mount(withAccount('en', createElement(Screen)));
    await send(host, 'Consider gold');
    await act(async () => change('another-person', 'robinhood'));
    await act(async () => resolve(json(response(messageId))));
    await settle();
    expect(host.textContent).not.toContain('Consider gold');
    expect(host.textContent).not.toContain('Here is a private preview.');
    expect(
      localStorage.getItem(goalConversationKey('another-person', 'robinhood', 'sandbox')),
    ).toBeNull();
    expect(localStorage.getItem(goalConversationKey(userId, 'solana', 'sandbox'))).toContain(
      'Consider gold',
    );
  });
  it('separates actual network histories and discards a pending sandbox reply after same-chain live switch', async () => {
    let messageId = '';
    let release: (response: Response) => void = () => {};
    portStore.setApi(async (url, init) => {
      if (init?.method === 'POST') {
        messageId = JSON.parse(String(init.body)).messageId;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return baseApi(url);
    });
    const oldKey = `tf-goal-conversation:1:${encodeURIComponent(userId)}:solana`;
    localStorage.setItem(
      oldKey,
      JSON.stringify({
        revision: 0,
        transcript: [{ id: 'old', who: 'person', text: 'Unscoped history must stay separate' }],
      }),
    );
    const host = await show();
    expect(host.textContent).not.toContain('Unscoped history must stay separate');
    await send(host, 'Sandbox-only words');
    await act(async () => portStore.set(signedInPort(PHANTOM, { userId }, 'live')));
    await settle();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).not.toContain(
      'Sandbox-only words',
    );
    await act(async () => release(json(response(messageId))));
    await settle();
    expect(host.querySelector('[data-ui="mix-joint"]')).toBeNull();
    expect(localStorage.getItem(goalConversationKey(userId, 'solana', 'live'))).toBeNull();
    expect(localStorage.getItem(goalConversationKey(userId, 'solana', 'sandbox'))).toContain(
      'Sandbox-only words',
    );
    expect(localStorage.getItem(oldKey)).toContain('Unscoped history must stay separate');
    await act(async () => portStore.set(signedInPort(PHANTOM, { userId }, 'sandbox')));
    await settle();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain('Sandbox-only words');
    expect(host.textContent).not.toContain('Here is a private preview.');
  });
  it.each(['wrongId', 'wrongChain', 'address', 'badWeights'] as const)(
    'rejects %s response without a visual or executable draft',
    async (kind) => {
      portStore.setApi(async (url, init) => {
        if (!init?.method) return baseApi(url);
        const body = JSON.parse(String(init.body));
        const reply = response(body.messageId);
        return json(
          kind === 'wrongId'
            ? { ...reply, messageId: 'wrong' }
            : kind === 'wrongChain'
              ? { ...reply, chain: 'robinhood' }
              : kind === 'address'
                ? { ...reply, address: 'fabricated' }
                : {
                    ...reply,
                    proposal: {
                      ...preview,
                      allocations: [{ ...preview.allocations[0], weightBps: 9000 }],
                    },
                  },
        );
      });
      const host = await show();
      await send(host, 'Consider gold');
      expect(host.textContent).toContain(en.goal.explore.failed);
      expect(host.querySelector('[data-ui="mix-joint"]')).toBeNull();
      expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain('Consider gold');
    },
  );
  it('does not send without the verified account context', async () => {
    const host = await mount(
      withAccount(
        'en',
        createElement(GoalConversation, {
          userId,
          chain: 'solana',
          provenance: 'sandbox',
          ready: false,
        }),
      ),
    );
    expect(find<HTMLTextAreaElement>(host, 'textarea').disabled).toBe(true);
    await send(host, 'Consider gold');
    expect(calls).toHaveLength(0);
  });
});

describe('the deposit step of a new goal', () => {
  const accept = '/v1/conversations/solana/goal/accept';
  const strategy = (host: HTMLElement) => find(host, '[data-ui="goal-strategy"]');
  const amount = (host: HTMLElement) =>
    find<HTMLInputElement>(host, '[data-ui="amount-large"] input');
  /** Replies in turn; a null is a reply that failed. */
  const replies = (...turns: (Record<string, unknown> | null)[]) => {
    let n = 0;
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return baseApi(url);
      const body = JSON.parse(String(init.body));
      calls.push({ path: url, body });
      if (url === accept) return json({}, 502);
      const turn = turns[Math.min(n++, turns.length - 1)];
      return turn ? json({ ...response(body.messageId), ...turn }) : json({}, 500);
    });
  };

  it('opens from the proposal with the goal and risk the person said, and no form', async () => {
    replies({ goal: 'grow', risk: 'high' });
    const host = await show();
    await send(host, 'Stocks to grow, I can take high risk');
    // the one action of the preview: named for what it does, and the card's primary button
    const press = find(host, '[data-action="deposit"]');
    expect(press.textContent).toBe(en.mix.preview.deposit);
    expect(en.mix.preview.deposit).toBe('Deposit');
    expect(dictionary('pt').mix.preview.deposit).toBe('Depositar');
    expect(press.getAttribute('data-variant')).toBe('primary');
    expect(find(host, '[data-ui="goal-strategy"]').textContent).not.toMatch(/use this mix/i);
    await click(find(host, '[data-action="deposit"]'));
    const step = find(host, '[data-ui="deposit-step"]');
    expect(find(step, '[data-ui="deposit-purpose"]').textContent).toContain(
      en.mix.deposit.purpose('grow', 'high'),
    );
    expect(step.querySelectorAll('select')).toHaveLength(0);
    expect(step.querySelectorAll('input')).toHaveLength(1);
    // the same rows the preview drew, read only
    for (const line of preview.allocations)
      expect(step.querySelector(`[data-asset="${line.assetId}"]`)).not.toBeNull();
    // nothing is signed or ordered from /goal
    expect(calls.map((call) => call.path)).toEqual([path]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('sends for checking exactly the ids and shares the preview shows, and nothing of its own', async () => {
    // a relaxed-intake mix of three lines, cash among them (gate RELAXED-INTAKE): what the deposit
    // step sends is that mix, never the engine's own picks (gate ANY-COMPOSITION)
    const shown = [
      { assetId: 'solana:spy', weightBps: 5000, symbol: 'SPY' },
      { assetId: 'solana:gldx', weightBps: 3000, symbol: 'tGLDx' },
      { assetId: 'solana:usdc', weightBps: 2000, symbol: 'USDC' },
    ].map((line) => ({ ...line, why: `Why ${line.symbol}.`, evidenceIds: ['exit'] }));
    replies({ goal: 'grow', risk: 'high', proposal: { ...preview, allocations: shown } });
    const host = await show();
    await send(host, 'Half a fund, some gold, the rest cash; grow, high risk');
    await click(find(host, '[data-action="deposit"]'));
    await type(amount(host), '250');
    await settle(CHECK_MS + 50);
    const checked = calls.filter((call) => call.path === accept);
    expect(checked.length).toBeGreaterThan(0);
    for (const call of checked)
      expect(call.body).toMatchObject({
        origin: 'model',
        goal: 'grow',
        risk: 'high',
        amountUsd: 250,
        allocations: shown.map(({ assetId, weightBps }) => ({ assetId, weightBps })),
      });
    // the plan is never handed to the engine to pick its own holdings
    expect(calls.some((call) => call.path.includes('/v1/baskets/'))).toBe(false);
  });

  it('asks nothing by a tap: what an older server or the person left unsaid is sent as not said', async () => {
    // a reply with no goal or risk at all, and one with a value this app does not know
    replies({}, { goal: 'speculate', risk: 'medium' });
    const host = await show();
    await send(host, 'Some stocks');
    await click(find(host, '[data-action="deposit"]'));
    expect(host.querySelector('[data-ui="deposit-purpose"]')).toBeNull();
    expect(host.querySelector('[data-ui="deposit-goal"]')).toBeNull();
    expect(host.querySelector('[data-ui="deposit-risk"]')).toBeNull();
    expect(host.querySelectorAll('[aria-pressed]')).toHaveLength(0);
    await type(amount(host), '250');
    await settle(CHECK_MS + 50);
    expect(calls.filter((call) => call.path === accept).at(-1)?.body).toMatchObject({
      goal: null,
      risk: null,
      amountUsd: 250,
    });
    await send(host, 'medium risk please');
    await click(find(host, '[data-action="deposit"]'));
    expect(find(host, '[data-ui="deposit-purpose"]').textContent).toContain(
      en.mix.deposit.purpose(null, 'medium'),
    );
    expect(host.querySelector('[data-ui="deposit-goal"]')).toBeNull();
  });

  // In StrictMode as `next dev` runs it, where React runs a state update twice.
  it.each([
    ['', false],
    [', in StrictMode', true],
  ])(
    'starts the amount from the sum the person wrote, and never replaces one they typed%s',
    async (_, strict) => {
      replies(
        { amountUsd: 2000 },
        { amountUsd: 3000 },
        { amountUsd: 'lots' },
        { amountUsd: 5000 },
        { amountUsd: null },
      );
      const host = await (strict
        ? mount(withAccount('en', createElement(StrictMode, null, createElement(GoalHome))))
        : show());
      await send(host, 'I want to invest 2k, 70% in safe income and 30% in AI stocks');
      await click(find(host, '[data-action="deposit"]'));
      expect(amount(host).value).toBe('2000');
      // focused and selected: what the person types replaces it
      expect(document.activeElement).toBe(amount(host));
      expect([amount(host).selectionStart, amount(host).selectionEnd]).toEqual([0, 4]);
      expect(find(host, '[data-action="deposit-review"]').textContent).toContain(
        en.mix.deposit.reviewOf('$2,000'),
      );
      // a newer sum replaces the one filled in, and something the app cannot read leaves it
      await send(host, 'make it 3k');
      await click(find(host, '[data-action="deposit"]'));
      expect(amount(host).value).toBe('3000');
      await send(host, 'lots');
      await click(find(host, '[data-action="deposit"]'));
      expect(amount(host).value).toBe('3000');
      // what the person typed is theirs: no later sum replaces it, nor one that is not said
      await type(amount(host), '2500');
      await send(host, 'and 5k?');
      await click(find(host, '[data-action="deposit"]'));
      expect(amount(host).value).toBe('2500');
      await send(host, 'ok');
      await click(find(host, '[data-action="deposit"]'));
      expect(amount(host).value).toBe('2500');
    },
  );

  it('writes a sum with cents the way the page reads an amount back', async () => {
    replies({ amountUsd: 1500.5 });
    const host = await show('pt');
    await send(host, 'US$ 1.500,50 em ouro');
    await click(find(host, '[data-action="deposit"]'));
    expect(amount(host).value).toBe('1500,5');
    expect(host.querySelector('[data-ui="amount-large"] [aria-invalid="true"]')).toBeNull();
  });

  it('changes the mix in the conversation: the box takes focus, and the proposal and amount stay', async () => {
    const more = {
      ...preview,
      objective: 'More of one, less of the other',
      allocations: preview.allocations.map((line, i) => ({
        ...line,
        weightBps: i === 0 ? line.weightBps + 100 : i === 1 ? line.weightBps - 100 : line.weightBps,
      })),
    };
    replies(
      { goal: 'grow', risk: 'high' },
      null,
      { goal: 'grow', risk: 'low', proposal: null, message: 'Lower risk it is.' },
      { goal: 'grow', risk: 'low', proposal: more },
    );
    const host = await show();
    await send(host, 'Stocks to grow, high risk');
    await click(find(host, '[data-action="deposit"]'));
    await type(amount(host), '250');
    await click(find(host, '[data-action="change-mix"]'));
    expect(document.activeElement).toBe(find(host, 'textarea'));
    expect(host.querySelector('[data-ui="deposit-step"]')).not.toBeNull();

    // the chat fails: its error says so by the box, and the deposit step keeps the mix and the amount
    await send(host, 'more of the first, less of the second');
    expect(find(host, '[data-ui="goal-chat"]').textContent).toContain(en.goal.explore.failed);
    expect(find(host, '[data-ui="goal-retry"]').textContent).toContain(en.goal.explore.retry);
    expect(amount(host).value).toBe('250');
    expect(
      strategy(host).querySelector(`[data-asset="${preview.allocations[0]?.assetId}"]`),
    ).not.toBeNull();

    // a reply that only talks changes what was said, not the mix
    await send(host, 'actually low risk');
    expect(find(host, '[data-ui="deposit-purpose"]').textContent).toContain(
      en.mix.deposit.purpose('grow', 'low'),
    );
    expect(amount(host).value).toBe('250');

    // another proposal is read as a preview first; using it finds the amount where it was
    await send(host, 'more of the first, less of the second');
    expect(host.querySelector('[data-ui="deposit-step"]')).toBeNull();
    expect(strategy(host).textContent).toContain('More of one, less of the other');
    await click(find(host, '[data-action="deposit"]'));
    expect(amount(host).value).toBe('250');
    expect(calls.filter((call) => call.path === path).at(-1)?.body.messages).toEqual(
      expect.arrayContaining([{ who: 'person', text: 'more of the first, less of the second' }]),
    );
  });

  it('moves focus with the screen: to the amount when the step opens, to the button on the way back', async () => {
    replies({ goal: 'grow', risk: 'high' });
    const host = await show();
    await send(host, 'Stocks to grow, high risk');
    await click(find(host, '[data-action="deposit"]'));
    expect(document.activeElement).toBe(amount(host));
    await click(
      [...host.querySelectorAll('button')].find(
        (button) => button.textContent === en.mix.deposit.backToProposal,
      ) as HTMLElement,
    );
    expect(document.activeElement).toBe(find(host, '[data-action="deposit"]'));
  });

  it('holds the deposit action while a reply is being worked on', async () => {
    let release: () => void = () => {};
    let n = 0;
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return baseApi(url);
      const body = JSON.parse(String(init.body));
      n += 1;
      if (n === 2)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return json({ ...response(body.messageId), goal: 'grow', risk: 'high' });
    });
    const host = await show();
    await send(host, 'Stocks to grow, high risk');
    await type(find<HTMLTextAreaElement>(host, 'textarea'), 'more of the first');
    await click(find(host, '[data-ui="composer-send"]'));
    // the last mix stays on the screen, and its button waits for the reply
    const press = find(host, '[data-action="deposit"]');
    expect(press.getAttribute('aria-disabled')).toBe('true');
    await click(press);
    expect(host.querySelector('[data-ui="deposit-step"]')).toBeNull();
    release();
    await settle();
    expect(find(host, '[data-action="deposit"]').getAttribute('aria-disabled')).toBeNull();
  });

  it('starts over with no mix, no amount and no deposit step', async () => {
    replies({ goal: 'grow', risk: 'high' });
    const host = await show();
    await send(host, 'Stocks to grow, high risk');
    await click(find(host, '[data-action="deposit"]'));
    await type(amount(host), '250');
    await click(
      [...host.querySelectorAll('button')].find(
        (button) => button.textContent === en.talk.startOver,
      ) as HTMLElement,
    );
    expect(host.querySelector('[data-ui="deposit-step"]')).toBeNull();
    expect(host.querySelector('[data-ui="goal-empty-preview"]')).not.toBeNull();
  });
});

describe('the proposed mix drawn as a joint', () => {
  const lineOf = (symbol: string, weightBps: number) => ({
    assetId: `solana:${symbol.toLowerCase()}`,
    weightBps,
    why: `Why ${symbol} is in it.`,
    evidenceIds: ['exit'],
    symbol,
  });
  const mixOf = (...lines: [string, number][]) => ({
    ...preview,
    allocations: lines.map(([symbol, bps]) => lineOf(symbol, bps)),
  });
  /** Answers each turn with the next of `replies`; with `hold`, only once it is let through. */
  const answer = (replies: Record<string, unknown>[], hold = false) => {
    const waiting: (() => void)[] = [];
    let turn = 0;
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return baseApi(url);
      const body = JSON.parse(String(init.body));
      const reply = replies[Math.min(turn++, replies.length - 1)];
      if (hold) await new Promise<void>((done) => waiting.push(done));
      return json({ ...response(body.messageId), ...reply });
    });
    return async () => {
      await act(async () => waiting.shift()?.());
      await settle();
    };
  };
  const pieces = (host: HTMLElement) => [
    ...host.querySelectorAll<HTMLElement>('[data-ui="mix-joint"] [data-part="piece"]'),
  ];
  const rowOf = (host: HTMLElement, symbol: string) =>
    find(host, `tr[data-row="solana:${symbol.toLowerCase()}"]`);
  const touch = (type: string) =>
    new PointerEvent(type, { bubbles: true, pointerType: 'touch' } as PointerEventInit);
  const SIX: [string, number][] = [
    ['SPY', 1667],
    ['QQQ', 1667],
    ['NVDA', 1667],
    ['AAPL', 1667],
    ['GLD', 1666],
    ['USDC', 1666],
  ];
  afterEach(() => vi.unstubAllGlobals());

  it.each(['en', 'pt'] as const)(
    'names each piece with the share its row shows, which is the proposal’s own (%s)',
    async (lang) => {
      answer([{ proposal: mixOf(...SIX) }]);
      const host = await show(lang);
      await send(host, 'Six things');
      const joint = find(host, '[data-ui="mix-joint"]');
      expect(joint.getAttribute('data-motion')).toBe('arrive');
      // every piece here is as wide as its share, and the drawing says so
      expect(find(joint, '[data-part="hint"]').textContent).toBe(
        dictionary(lang).shared.vault.conversation.jointHint,
      );
      expect(find(joint, '[role="toolbar"]').getAttribute('aria-label')).toBe(
        dictionary(lang).shared.vault.conversation.jointLabel,
      );
      expect(pieces(host)).toHaveLength(SIX.length);
      for (const [i, [symbol, bps]] of SIX.entries()) {
        const shown = sourceValue(lang, bps / 10000, 'fraction');
        // the row shows the final figure whole while its piece is still on its way in
        expect(find(rowOf(host, symbol), '[data-part="share"]').textContent).toBe(shown);
        expect(pieces(host)[i].getAttribute('aria-label')).toBe(`${symbol}, ${shown}`);
        // and the piece and its row carry one colour
        const fill = find(pieces(host)[i], '[data-part="fill"]').className.match(/bg-leg-\d/)?.[0];
        expect(fill).toBe(`bg-leg-${(i % 4) + 1}`);
        expect(find(rowOf(host, symbol), '[data-part="swatch"]').className).toContain(fill);
      }
      // one tab stop for the beam
      expect(pieces(host).map((p) => p.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    },
  );

  it('lights a row from its piece and a piece from its row, and lets go', async () => {
    answer([{ proposal: mixOf(...SIX) }]);
    const host = await show();
    await send(host, 'Six things');
    const [spy, qqq] = pieces(host);
    // focus on a piece lights its row, and only its row
    await act(async () => qqq.focus());
    // a highlight, not a toggle: nothing is announced as pressed
    expect(qqq.getAttribute('data-lit')).toBe('true');
    expect(qqq.hasAttribute('aria-pressed')).toBe(false);
    expect(rowOf(host, 'QQQ').getAttribute('data-lit')).toBe('true');
    expect(rowOf(host, 'SPY').getAttribute('data-lit')).toBe('false');
    expect(find(host, '[data-ui="mix-joint-readout"]').textContent).toContain('QQQ');
    // the arrows walk the beam, and Escape lets go
    await press(qqq, 'ArrowLeft');
    expect(document.activeElement).toBe(spy);
    expect(rowOf(host, 'SPY').getAttribute('data-lit')).toBe('true');
    expect(pieces(host).map((p) => p.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    await press(spy, 'End');
    expect(rowOf(host, 'USDC').getAttribute('data-lit')).toBe('true');
    await press(document.activeElement as HTMLElement, 'Escape');
    expect(host.querySelectorAll('[data-lit="true"]')).toHaveLength(0);
    // a finger on a row lights its piece; a second tap, or a tap elsewhere, lets it go
    await fire(rowOf(host, 'NVDA'), touch('pointerup'));
    expect(pieces(host)[2].getAttribute('data-lit')).toBe('true');
    expect(rowOf(host, 'NVDA').getAttribute('data-lit')).toBe('true');
    await fire(rowOf(host, 'NVDA'), touch('pointerup'));
    expect(pieces(host)[2].getAttribute('data-lit')).toBe('false');
    await fire(pieces(host)[3], touch('pointerup'));
    expect(rowOf(host, 'AAPL').getAttribute('data-lit')).toBe('true');
    await fire(find(host, '[data-ui="goal-chat"]'), touch('pointerdown'));
    expect(host.querySelectorAll('[data-lit="true"]')).toHaveLength(0);
    expect(host.querySelector('[data-ui="mix-joint-readout"] [data-part="lit"]')).toBeNull();
    expect(find(host, '[data-ui="mix-joint-readout"]').textContent).toBe(
      en.shared.vault.conversation.jointHint,
    );
  });

  it.each(['en', 'pt'] as const)(
    'says so, under the beam and in its name, when a small share is drawn wider than it is (%s)',
    async (lang) => {
      const words = dictionary(lang).shared.vault.conversation;
      // 90% and ten lines of 1%: the ten are drawn at 3% each, a third of the beam for a tenth of the money
      const small = Array.from({ length: 10 }, (_, i) => [`S${i}`, 100] as [string, number]);
      answer([{ proposal: mixOf(['SPY', 9000], ...small) }, { proposal: mixOf(...SIX) }]);
      const host = await show(lang);
      await send(host, 'Mostly one fund');
      const joint = find(host, '[data-ui="mix-joint"]');
      expect(pieces(host).map((p) => p.style.width)).toEqual(['70%', ...small.map(() => '3%')]);
      expect(find(joint, '[data-part="hint"]').textContent).toBe(words.jointHintWidened);
      expect(find(joint, '[role="toolbar"]').getAttribute('aria-label')).toBe(
        words.jointLabelWidened,
      );
      expect(pieces(host).map((p) => p.dataset.widened)).toEqual([
        undefined,
        ...small.map(() => 'true'),
      ]);
      // the figures are exact all the same, in the row and in the piece's name
      const one = sourceValue(lang, 0.01, 'fraction');
      expect(find(rowOf(host, 'S0'), '[data-part="share"]').textContent).toBe(one);
      expect(pieces(host)[1].getAttribute('aria-label')).toBe(`S0, ${one}`);
      // and the plain sentence comes back with a mix that is drawn as it is
      await send(host, 'Six things instead');
      expect(find(joint, '[data-part="hint"]').textContent).toBe(words.jointHint);
      expect(find(joint, '[role="toolbar"]').getAttribute('aria-label')).toBe(words.jointLabel);
      expect(host.querySelectorAll('[data-part="piece"][data-widened]')).toHaveLength(0);
    },
  );

  it('lets a lit piece go, and takes the focus on the beam, when the next draft drops it', async () => {
    answer([
      { proposal: mixOf(['SPY', 5000], ['GLD', 3000], ['USDC', 2000]) },
      { proposal: mixOf(['SPY', 6000], ['USDC', 4000]) },
    ]);
    const host = await show();
    await send(host, 'A fund, gold and cash');
    const gold = pieces(host)[1];
    await act(async () => gold.focus());
    expect(rowOf(host, 'GLD').getAttribute('data-lit')).toBe('true');
    // off and on again by a finger on its row: it is lit when the next draft comes
    await fire(rowOf(host, 'GLD'), touch('pointerup'));
    await fire(rowOf(host, 'GLD'), touch('pointerup'));
    expect(gold.getAttribute('data-lit')).toBe('true');
    await send(host, 'No gold');
    expect(pieces(host).map((p) => p.dataset.asset)).toEqual(['solana:spy', 'solana:usdc']);
    // nothing is lit, so nothing is dimmed, and the readout is the hint again
    expect(pieces(host).map((p) => p.dataset.lit)).toEqual(['false', 'false']);
    expect(pieces(host).some((p) => p.className.includes('opacity-45'))).toBe(false);
    expect(host.querySelector('[data-ui="mix-joint-readout"] [data-part="lit"]')).toBeNull();
    expect(host.querySelectorAll('tr[data-lit="true"]')).toHaveLength(0);
  });

  it('moves the focus to the beam when the piece that had it is dropped', async () => {
    const release = answer(
      [
        { proposal: mixOf(['SPY', 5000], ['GLD', 3000], ['USDC', 2000]) },
        { proposal: mixOf(['SPY', 6000], ['USDC', 4000]) },
      ],
      true,
    );
    const host = await show();
    await send(host, 'A fund, gold and cash');
    await release();
    await send(host, 'No gold');
    await act(async () => pieces(host)[1].focus());
    await release();
    expect(pieces(host)).toHaveLength(2);
    expect(document.activeElement).toBe(find(host, '[data-ui="mix-joint"] [role="toolbar"]'));
  });

  it('keeps the last mix when the next reply is only a question, and never called it a new draft', async () => {
    const release = answer(
      [
        { proposal: mixOf(['SPY', 5000], ['GLD', 3000], ['USDC', 2000]) },
        { proposal: null, message: 'I need one thing first.', question: 'For how long?' },
      ],
      true,
    );
    const host = await show();
    const strategy = find(host, '[data-ui="goal-strategy"]');
    await send(host, 'A fund, gold and cash');
    await release();
    await send(host, 'Make it safer');
    // the line promises no new draft: the reply may be a question
    const line = find(strategy, '[data-ui="preview-pending"]').textContent ?? '';
    expect(line).toBe(en.shared.vault.conversation.reworking);
    expect(line).not.toMatch(/new draft/i);
    await release();
    // the settled rule (gate DEPOSIT-STEP): a reply with no proposal keeps the last mix, no longer
    // marked as waiting, and its deposit action is the person's again
    expect(pieces(host).map((p) => p.dataset.asset)).toEqual([
      'solana:spy',
      'solana:gld',
      'solana:usdc',
    ]);
    expect(find(strategy, '[data-ui="preview-pending"]').textContent).toBe('');
    expect(strategy.querySelector('[data-ui="goal-empty-preview"]')).toBeNull();
    expect(find(strategy, '[data-action="deposit"]').getAttribute('aria-disabled')).toBeNull();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain(
      'I need one thing first.\n\nFor how long?',
    );
  });

  it('says a draft is being worked on, keeps the one before it unusable, then moves only what changed', async () => {
    const release = answer(
      [
        { proposal: mixOf(['SPY', 5000], ['GLD', 3000], ['USDC', 2000]) },
        { proposal: mixOf(['SPY', 6000], ['USDC', 2000], ['QQQ', 2000]) },
      ],
      true,
    );
    const host = await show();
    const strategy = find(host, '[data-ui="goal-strategy"]');
    const status = find(strategy, '[data-ui="goal-empty-preview"] [role="status"]');
    expect(status.textContent).toBe(en.goal.explore.empty);
    await send(host, 'A fund, gold and cash');
    // the first wait: the empty card says so, and draws nothing yet
    expect(find(strategy, '[data-ui="goal-working"]').textContent).toBe(en.goal.explore.working);
    expect(find(strategy, '[data-ui="goal-working"]').getAttribute('role')).toBe('status');
    // the region was there before the words came
    expect(status).toBe(find(strategy, '[data-ui="goal-working"]'));
    expect(strategy.querySelector('[data-ui="mix-joint"]')).toBeNull();
    await release();
    expect(strategy.querySelector('[data-ui="goal-working"]')).toBeNull();
    expect(find(strategy, '[data-ui="mix-joint"]').getAttribute('data-motion')).toBe('arrive');
    const use = () => find(strategy, '[data-action="deposit"]');
    expect(use().getAttribute('aria-disabled')).not.toBe('true');

    // the next wait: the draft stays, said to be the last one, and its action waits
    // the button opens the deposit step; back on the proposal, the next words are sent
    await click(use());
    expect(host.querySelector('[data-action="deposit-review"]')).not.toBeNull();
    await click(
      [...host.querySelectorAll('button')].find(
        (button) => button.textContent === en.mix.deposit.backToProposal,
      ) as HTMLElement,
    );
    // the line is there, empty, before its words change
    const pendingLine = find(strategy, '[data-ui="preview-pending"]');
    expect(pendingLine.getAttribute('role')).toBe('status');
    expect(pendingLine.textContent).toBe('');
    await send(host, 'Swap the gold for a second fund');
    expect(find(strategy, '[data-ui="preview-pending"]').textContent).toBe(
      en.shared.vault.conversation.reworking,
    );
    expect(pendingLine).toBe(find(strategy, '[data-ui="preview-pending"]'));
    // only the beam recedes: its hint, the rows and their figures are not inside what is dimmed
    const dimmed = find(strategy, '[data-receded]');
    expect(dimmed.getAttribute('role')).toBe('toolbar');
    expect(dimmed.querySelector('[data-part="hint"]')).toBeNull();
    expect(pieces(host).map((p) => p.dataset.asset)).toEqual([
      'solana:spy',
      'solana:gld',
      'solana:usdc',
    ]);
    // the button cannot open the deposit step while the reply is on its way
    expect(use().getAttribute('aria-disabled')).toBe('true');
    await click(use());
    expect(host.querySelector('[data-action="deposit-review"]')).toBeNull();

    await release();
    const joint = find(strategy, '[data-ui="mix-joint"]');
    expect(joint.getAttribute('data-motion')).toBe('change');
    expect(find(strategy, '[data-ui="preview-pending"]').textContent).toBe('');
    expect(use().getAttribute('aria-disabled')).not.toBe('true');
    expect(strategy.querySelector('[data-receded]')).toBeNull();
    expect(pieces(host).map((p) => [p.dataset.asset, p.style.width])).toEqual([
      ['solana:spy', '60%'],
      ['solana:usdc', '20%'],
      ['solana:qqq', '20%'],
    ]);
    const body = (i: number) => find(pieces(host)[i], '[data-part="body"]');
    // SPY stays where it starts and grows; cash slides along at the size it had; the new piece seats
    expect(body(0).className).not.toContain('tf-joint-move');
    expect(find(pieces(host)[0], '[data-part="fill"]').className).toContain('tf-joint-size');
    expect(
      find(pieces(host)[0], '[data-part="fill"]').style.getPropertyValue('--tf-joint-sx'),
    ).toBe(String(50 / 60));
    expect(body(1).className).toContain('tf-joint-move');
    expect(body(1).style.getPropertyValue('--tf-joint-x')).toBe('20cqw');
    expect(find(pieces(host)[1], '[data-part="fill"]').className).not.toContain('tf-joint-size');
    expect(body(2).className).toContain('tf-joint-arrive');
    // gold fades where it lay, out of reach of a pointer and of a reader
    const ghost = find(joint, '[data-part="ghost"]');
    expect([ghost.style.left, ghost.style.width]).toEqual(['50%', '30%']);
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    // only a figure that changed drops in again, and it is the final one
    const figure = (symbol: string) => find(rowOf(host, symbol), '[data-part="share"]');
    expect(figure('SPY').textContent).toBe('60%');
    expect(figure('SPY').className).toContain('tf-joint-figure');
    expect(figure('USDC').className).not.toContain('tf-joint-figure');
    expect(rowOf(host, 'QQQ').className).toContain('tf-joint-row');
    expect(rowOf(host, 'USDC').className).not.toContain('tf-joint-row');
    expect(strategy.querySelector('tr[data-row="solana:gld"]')).toBeNull();
  });

  it('keeps the mix before it when the next reply does not come', async () => {
    let fail = false;
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return baseApi(url);
      if (fail) return json({}, 500);
      return json(response(JSON.parse(String(init.body)).messageId));
    });
    const host = await show();
    await send(host, 'Gold and cash');
    expect(host.querySelector('[data-ui="mix-joint"]')).not.toBeNull();
    fail = true;
    await send(host, 'Something else');
    // the settled rule (gate DEPOSIT-STEP): the chat says it failed, and the last mix stays usable
    expect(find(host, '[role="alert"]').textContent).toBe(en.goal.explore.failed);
    expect(host.querySelector('[data-ui="mix-joint"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="goal-empty-preview"]')).toBeNull();
    expect(find(host, '[data-ui="preview-pending"]').textContent).toBe('');
    expect(find(host, '[data-action="deposit"]').getAttribute('aria-disabled')).toBeNull();
  });

  it('moves nothing for a person who asked for reduced motion: each mix is simply there', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    answer([
      { proposal: mixOf(['SPY', 5000], ['GLD', 3000], ['USDC', 2000]) },
      { proposal: mixOf(['SPY', 6000], ['USDC', 2000], ['QQQ', 2000]) },
    ]);
    const host = await show();
    const moving = () => host.querySelectorAll('[class*="tf-joint-"]');
    await send(host, 'A fund, gold and cash');
    expect(find(host, '[data-ui="mix-joint"]').getAttribute('data-motion')).toBe('still');
    expect(moving()).toHaveLength(0);
    await send(host, 'Swap the gold for a second fund');
    expect(find(host, '[data-ui="mix-joint"]').getAttribute('data-motion')).toBe('still');
    expect(moving()).toHaveLength(0);
    expect(host.querySelector('[data-part="ghost"]')).toBeNull();
    expect(pieces(host).map((p) => p.style.width)).toEqual(['60%', '20%', '20%']);
    expect(find(rowOf(host, 'SPY'), '[data-part="share"]').textContent).toBe('60%');
  });

  it('says a question once when the message already ends with it', async () => {
    const question = 'How long can this money stay invested?';
    answer([
      {
        proposal: null,
        message: `I can work with that.  how long can this money\nstay invested?`,
        question,
      },
      { proposal: null, message: 'I can work with that.', question },
    ]);
    const host = await show();
    await send(host, 'Something steady');
    const said = () => [...find(host, '[data-ui="goal-transcript"]').children].at(-1)?.textContent;
    expect(said()).toBe(
      `${en.talk.me}: I can work with that.  how long can this money\nstay invested?`,
    );
    await send(host, 'Tell me more');
    expect(said()).toBe(`${en.talk.me}: I can work with that.\n\n${question}`);
  });
});

describe('existing entry handoffs', () => {
  it('prefills handed-over words in Explore across sign-in, then consumes once on accepted words even if reply fails', async () => {
    portStore.set(fakePort());
    // The words another screen handed over (features/goal/draft.ts), as the old landing's box did.
    const words = 'Grow $2,000 for ten years';
    sessionStorage.setItem(GOAL_HANDOFF, words);
    portStore.setApi(async (url) => baseApi(url));
    const host = await show();
    expect(find<HTMLSelectElement>(host, '[data-ui="goal-picker"]').value).toBe('current');
    expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe(words);
    expect(find<HTMLTextAreaElement>(host, 'textarea').disabled).toBe(true);
    expect(calls).toHaveLength(0);
    await act(async () => portStore.set(signedInPort(PHANTOM, { userId })));
    await settle();
    expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe(words);
    expect(sessionStorage.getItem(GOAL_HANDOFF)).toBe(words);
    expect(sessionStorage.getItem(GOAL_HANDOFF_OWNER)).toBe(userId);
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    expect(sessionStorage.getItem(GOAL_HANDOFF)).toBeNull();
    expect(sessionStorage.getItem(GOAL_HANDOFF_OWNER)).toBeNull();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain(words);
    expect(host.textContent).toContain(en.goal.explore.unavailable);
    expect(localStorage.getItem(goalConversationKey(userId, 'solana', 'sandbox'))).toContain(words);
    expect(host.querySelector('[data-ui="invest-screen"]')).toBeNull();
  });
  it('does not prefill another verified person with an unconsumed signed-in handoff', async () => {
    sessionStorage.setItem(GOAL_HANDOFF, 'My private pending goal');
    const host = await show();
    expect(sessionStorage.getItem(GOAL_HANDOFF_OWNER)).toBe(userId);
    expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe('My private pending goal');
    portStore.setApi(async (url) =>
      url === '/v1/me' ? json({ ...person, userId: 'another-person' }) : json({}, 404),
    );
    await act(async () => portStore.set(signedInPort(PHANTOM, { userId: 'another-person' })));
    await settle();
    expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe('');
    expect(host.textContent).not.toContain('My private pending goal');
    expect(sessionStorage.getItem(GOAL_HANDOFF)).toBe('My private pending goal');
    expect(calls).toHaveLength(0);
  });
  it('keeps a bounded goal fragment as unconfirmed Explore prefill until explicit send', async () => {
    const words = 'Consider gold with a small budget';
    window.history.replaceState(null, '', `/goal#goal=${encodeURIComponent(words)}`);
    const host = await show();
    expect(find<HTMLSelectElement>(host, '[data-ui="goal-picker"]').value).toBe('current');
    expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe(words);
    expect(sessionStorage.getItem(GOAL_HANDOFF)).toBe(words);
    expect(calls).toHaveLength(0);
    await send(host, words);
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem(GOAL_HANDOFF)).toBeNull();
    expect(calls[0].body.messages).toEqual([{ who: 'person', text: words }]);
  });
  it('ignores a continuation the removed guided flow left in the tab', async () => {
    const saved = JSON.stringify({ sheet: { goal: 'income' }, way: 'Aim for $147 a month.' });
    sessionStorage.setItem('tf-invest-way', saved);
    const host = await show();
    await settle();
    expect(host.querySelector('[data-ui="goal-conversation"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="invest-screen"]')).toBeNull();
    expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe('');
    expect(sessionStorage.getItem('tf-invest-way')).toBe(saved);
    expect(calls).toHaveLength(0);
  });
});

describe('sourced metrics in a strategy preview', () => {
  it.each(['en', 'pt'] as const)(
    'uses actual percentage scales and locale currency (%s)',
    (lang) => {
      expect(sourceValue(lang, 0.03, 'fraction')).toBe(lang === 'en' ? '3%' : '3%');
      expect(sourceValue(lang, 12, 'bps')).toBe(lang === 'en' ? '0.12%' : '0,12%');
      expect(sourceValue(lang, null, 'fraction')).toBe('—');
      expect(sourceValue(lang, 12.5, 'USD')).toContain(lang === 'en' ? '12.50' : '12,50');
    },
  );
});

describe('the relaxed intake’s plan on /goal (RELAXED-INTAKE)', () => {
  const sheet = { goal: 'grow', amountUsd: 2000, chains: ['solana'] };
  const projection = {
    currency: 'USD',
    rate: 0.04,
    step: 1,
    months: [
      { month: '2026-11-01', balance: 2006, earned: 6, withdrawn: 0 },
      { month: '2026-12-01', balance: 2013, earned: 13, withdrawn: 0 },
    ],
    basis: 'Past-rate arithmetic from the sourced yield readings, never a promise.',
    sourceIds: [],
  };
  const answerWith = (extra: Record<string, unknown>) =>
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return baseApi(url);
      const body = JSON.parse(String(init.body));
      calls.push({ path: url, body });
      return json({ ...response(body.messageId), proposal: { ...preview, ...extra } });
    });

  it('leads to the deposit step only: no "Invest in this plan", and nothing sent to the engine', async () => {
    // a reply from a server that still carries an engine sheet: it is not read, and nothing invests from it
    answerWith({ investSheet: sheet });
    const host = await show();
    await send(host, 'Grow $2,000');
    expect(host.querySelector('[data-action="invest-plan"]')).toBeNull();
    const primary = [
      ...find(host, '[data-ui="goal-strategy"]').querySelectorAll('button[data-variant="primary"]'),
    ];
    expect(primary.map((button) => button.getAttribute('data-action'))).toEqual(['deposit']);
    expect(calls.some((call) => call.path === '/v1/baskets/personalize')).toBe(false);
  });

  it('shows the mix alone when the reply carries no projection, as the model-led conversation’s does', async () => {
    answerWith({});
    const host = await show();
    await send(host, 'Grow $2,000');
    expect(
      find(host, '[data-ui="goal-strategy"]').querySelector('[data-ui="mix-joint"]'),
    ).not.toBeNull();
    expect(host.querySelector('[data-ui="preview-view"]')).toBeNull();
    expect(host.querySelector('[data-ui="projection-chart"]')).toBeNull();
    expect(
      [...host.querySelectorAll('button[data-variant="primary"]')].map((button) =>
        button.getAttribute('data-action'),
      ),
    ).toContain('deposit');
  });

  it('draws the projected months in honey on a chalk baseline, once asked for', async () => {
    answerWith({ projection });
    const host = await show();
    await send(host, 'Grow $2,000 and add monthly');
    const views = find(host, '[data-ui="preview-view"]');
    expect(host.querySelector('[data-ui="projection-chart"]')).toBeNull();
    const monthly = [...views.querySelectorAll('button')].find(
      (button) => button.textContent === en.shared.vault.conversation.view.monthly,
    );
    if (!monthly) throw new Error('no monthly view');
    await click(monthly);
    const chart = find(host, '[data-ui="projection-chart"]');
    expect(monthly.getAttribute('aria-pressed')).toBe('true');
    expect(chart.querySelectorAll('.bg-primary').length).toBeGreaterThanOrEqual(2);
    expect(chart.querySelector('fieldset')?.className).toContain('border-info');
    expect(chart.textContent).toContain(projection.basis);
  });

  it('marks projected figures from a test-network reading as sample, quietly, and live ones not', async () => {
    const openChart = async () => {
      const host = await show();
      await send(host, 'Grow $2,000 and add monthly');
      const monthly = [...find(host, '[data-ui="preview-view"]').querySelectorAll('button')].find(
        (button) => button.textContent === en.shared.vault.conversation.view.monthly,
      );
      if (!monthly) throw new Error('no monthly view');
      await click(monthly);
      return find(host, '[data-ui="projection-chart"]');
    };
    const reading = preview.sources[0];
    if (!reading) throw new Error('no source in the fixture');
    answerWith({ projection: { ...projection, sourceIds: [reading.id] } });
    let chart = await openChart();
    expect(reading.provenance).not.toBe('live');
    expect(chart.querySelector('[data-ui="mock-plate"]')).not.toBeNull();
    expect(chart.textContent).not.toMatch(/MOCK/);
    await unmountAll();
    answerWith({
      projection: { ...projection, sourceIds: [reading.id] },
      sources: [{ ...reading, provenance: 'live' }],
    });
    chart = await openChart();
    expect(chart.querySelector('[data-ui="mock-plate"]')).toBeNull();
  });

  it('lists this conversation, a new one and the saved ones in the picker, and opens a new one empty', async () => {
    const host = await show();
    await send(host, 'Consider gold');
    await mode(host, 'new');
    await settle();
    const options = [...find<HTMLSelectElement>(host, '[data-ui="goal-picker"]').options];
    expect(options.map((o) => o.textContent)).toEqual([
      en.goal.explore.picker.current,
      en.goal.explore.picker.fresh,
      'Consider gold · Solana',
    ]);
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toBe('');
  });
});
