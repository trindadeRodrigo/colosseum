// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, press, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { withAccount } from '../account/test/screen';
import { GOAL_HANDOFF, GOAL_HANDOFF_OWNER } from '../goal/draft';
import { Simulate } from '../landing/Simulate';
import { sourceValue } from '../vault-conversation/StrategyPreview';
import { preview } from '../vault-conversation/test/fixtures';
import { fakePort, json, PHANTOM, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { GoalConversation, goalConversationKey } from './GoalConversation';
import { GoalEntry } from './GoalEntry';

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
const show = (lang: 'en' | 'pt' = 'en') => mount(withAccount(lang, createElement(GoalEntry)));
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
      expect(host.querySelector('[data-ui="goal-mode"]')).toBeNull();
      expect(find(host, '[data-ui="goal-empty-preview"]').textContent).toContain(
        dictionary(lang).goal.explore.empty,
      );
      expect(host.querySelector('[data-ui="invest-screen"]')).toBeNull();
      expect(host.querySelector('[data-ui="holdings-bar"]')).toBeNull();
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
      // on a proposal the line over "Use this mix" says how the draft is bought, not that it cannot be
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
        [...find(host, '[data-ui="holdings-bar"]').children].map(
          (e) => (e as HTMLElement).style.width,
        ),
      ).toEqual(['40%', '60%']);
      expect(host.querySelector('[data-ui="buy-card"]')).toBeNull();
      expect(
        find(host, '[data-ui="goal-strategy"]').querySelector('button[data-variant="primary"]'),
      ).toBeNull();
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
    expect(host.querySelector('[data-ui="holdings-bar"]')).toBeNull();
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
      expect(host.querySelector('[data-ui="holdings-bar"]')).toBeNull();
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
    await click(find(host, '[data-action="use-mix"]'));
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

  it('asks by a tap what an older server or the person left unsaid, never a default', async () => {
    // a reply with no goal or risk at all, and one with a value this app does not know
    replies({}, { goal: 'speculate', risk: 'medium' });
    const host = await show();
    await send(host, 'Some stocks');
    await click(find(host, '[data-action="use-mix"]'));
    expect(host.querySelector('[data-ui="deposit-purpose"]')).toBeNull();
    expect(host.querySelectorAll('[data-ui="deposit-goal"] button')).toHaveLength(3);
    expect(host.querySelectorAll('[data-ui="deposit-risk"] button')).toHaveLength(3);
    expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    await send(host, 'medium risk please');
    await click(find(host, '[data-action="use-mix"]'));
    expect(find(host, '[data-ui="deposit-purpose"]').textContent).toContain(
      en.mix.deposit.purpose(null, 'medium'),
    );
    expect(host.querySelectorAll('[data-ui="deposit-goal"] button')).toHaveLength(3);
    expect(host.querySelector('[data-ui="deposit-risk"]')).toBeNull();
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
    await click(find(host, '[data-action="use-mix"]'));
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
    await click(find(host, '[data-action="use-mix"]'));
    expect(amount(host).value).toBe('250');
    expect(calls.filter((call) => call.path === path).at(-1)?.body.messages).toEqual(
      expect.arrayContaining([{ who: 'person', text: 'more of the first, less of the second' }]),
    );
  });

  it('starts over with no mix, no amount and no deposit step', async () => {
    replies({ goal: 'grow', risk: 'high' });
    const host = await show();
    await send(host, 'Stocks to grow, high risk');
    await click(find(host, '[data-action="use-mix"]'));
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

describe('existing entry handoffs', () => {
  it('prefills actual landing words in Explore across sign-in, then consumes once on accepted words even if reply fails', async () => {
    portStore.set(fakePort());
    const landing = await mount(withAccount('en', createElement(Simulate)));
    const words = 'Grow $2,000 for ten years';
    await send(landing, words);
    expect(router.push).toHaveBeenCalledWith('/goal');
    expect(sessionStorage.getItem(GOAL_HANDOFF)).toBe(words);
    await unmountAll();
    portStore.setApi(async (url) => baseApi(url));
    const host = await show();
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
