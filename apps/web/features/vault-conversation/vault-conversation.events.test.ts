// @vitest-environment happy-dom

import { VaultConversationTranscript } from '@colosseum/schemas';
import { act, createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { withAccount } from '../account/test/screen';
import { VaultScreen } from '../shared/VaultScreen';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { agentReplyOf } from './agent';
import { StrategyPreview } from './StrategyPreview';
import {
  conversationKey,
  conversationNetwork,
  plainText,
  readLocal,
  serverConversation,
  transcriptOf,
  writeLocal,
} from './storage';
import {
  cashRead,
  emptyRead,
  evmRead,
  longSourceLabel,
  longSourceReply,
  otherRead,
  read,
  reply,
  unpricedRead,
} from './test/fixtures';
import { VaultConversation } from './VaultConversation';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));
const userId = 'did:privy:test';
const path = `/v1/vaults/${read.chain}/${read.vault.address}/conversation`;
const en = dictionary('en');
const send = async (host: HTMLElement, words: string) => {
  await type(find<HTMLTextAreaElement>(host, 'textarea'), words);
  await click(find(host, '[data-ui="composer-send"]'));
  await settle();
};
const show = (lang: 'en' | 'pt' = 'en') =>
  mount(withAccount(lang, createElement(VaultConversation, { read, userId })));
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_SOLANA', 'testnet');
  vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_ROBINHOOD', 'testnet');
  localStorage.clear();
  sessionStorage.clear();
  portStore.set(signedInPort(EMBEDDED, { userId }));
  portStore.setApi(async () => json({}, 404));
});
afterEach(async () => {
  await unmountAll();
  vi.unstubAllEnvs();
});

describe('a continuous conversation for one vault', () => {
  it.each(['en', 'pt'] as const)(
    'prefills a starter without requesting a reply or submitting it, %s',
    async (lang) => {
      const calls: string[] = [];
      portStore.setApi(async (url, init) => {
        if (init?.method === 'POST') calls.push(url);
        return json({}, 404);
      });
      const host = await show(lang);
      const copy = dictionary(lang).shared.vault.conversation;
      const starter = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === copy.explain,
      );
      if (!starter) throw new Error('The explanation starter is offered.');
      await click(starter);
      const composer = find<HTMLTextAreaElement>(host, 'textarea');
      expect(composer.value).toBe(copy.explainPrompt);
      expect(document.activeElement).toBe(composer);
      expect(calls).toEqual([]);
      expect(host.querySelector('[data-ui="vault-transcript"]')).toBeNull();
    },
  );

  it('keeps removed targets in the proposal comparison and names the change in percentage points', async () => {
    const proposal = agentReplyOf(reply, read)?.proposal;
    if (!proposal) throw new Error('The fixture provides a validated proposal.');
    const [first] = proposal.allocations;
    if (!first) throw new Error('A sourced proposed allocation exists.');
    const host = await mount(
      withAccount(
        'en',
        createElement(StrategyPreview, {
          proposal: {
            ...proposal,
            allocations: [{ ...first, weightBps: 10000 }],
          },
          targets: [
            { asset: 'solana:gldx', targetBps: 3000 },
            { asset: 'solana:usdc', targetBps: 7000 },
          ],
        }),
      ),
    );
    const rows = [...host.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('30% → 100%');
    expect(rows[0]?.textContent).toContain('+70 pp');
    expect(rows[1]?.textContent).toContain('70% → 0%');
    expect(rows[1]?.textContent).toContain('−70 pp');
    expect(rows[1]?.textContent).toContain(en.shared.vault.conversation.removed);
    // the plan bar beside a vault's targets: one leg for what is proposed, labelled with the proposed
    // share alone, and a removed target has a row, an empty swatch and no leg
    const bar = find(host, '[data-ui="plan-legs-bar"]');
    expect([...bar.children].map((leg) => (leg as HTMLElement).style.width)).toEqual(['100%']);
    expect(
      [...find(host, '[data-ui="plan-legs"] ol').children].map((label) => label.textContent),
    ).toEqual(['tGLDx·100%']);
    expect(find(rows[0] as Element, '[data-part="swatch"]').className).toContain('bg-leg-1');
    expect(find(rows[1] as Element, '[data-part="swatch"]').className).not.toMatch(/bg-leg-/);
    // a vault's draft is never kept while the next is asked for: no pending line on it
    expect(find(host, '[data-ui="preview-pending"]').textContent).toBe('');
    expect(host.querySelector('[data-set-back]')).toBeNull();
    // Source pins may open; the standalone preview offers no execution or discussion command.
    expect(host.querySelector('form')).toBeNull();
    expect(host.querySelector('a[href^="/buy"]')).toBeNull();
    expect(
      [...host.querySelectorAll('button')].some(
        (button) => button.textContent === en.shared.vault.conversation.discuss,
      ),
    ).toBe(false);
    expect(host.textContent).toContain(en.shared.vault.conversation.previewOnly);
  });

  it.each(['en', 'pt'] as const)(
    'shows a one-basis-point change and removal precisely, %s',
    async (lang) => {
      const proposal = agentReplyOf(reply, read)?.proposal;
      if (!proposal) throw new Error('The fixture provides a validated proposal.');
      const [first] = proposal.allocations;
      if (!first) throw new Error('A sourced proposed allocation exists.');
      const host = await mount(
        withAccount(
          lang,
          createElement(StrategyPreview, {
            proposal: { ...proposal, allocations: [{ ...first, weightBps: 10000 }] },
            targets: [
              { asset: 'solana:gldx', targetBps: 9999 },
              { asset: 'solana:usdc', targetBps: 1 },
            ],
          }),
        ),
      );
      const rows = [...host.querySelectorAll('tbody tr')];
      const decimal = lang === 'en' ? '.' : ',';
      expect(rows[0]?.textContent).toContain(`99${decimal}99% → 100%`);
      expect(rows[0]?.textContent).toContain(
        `+0${decimal}01 ${dictionary(lang).shared.vault.conversation.points}`,
      );
      expect(rows[1]?.textContent).toContain(`0${decimal}01% → 0%`);
      expect(rows[1]?.textContent).toContain(
        `−0${decimal}01 ${dictionary(lang).shared.vault.conversation.points}`,
      );
      expect(rows[1]?.textContent).toContain(dictionary(lang).shared.vault.conversation.removed);
    },
  );

  it.each(['en', 'pt'] as const)(
    'keeps real words on unavailable service and reopens plain history, %s',
    async (lang) => {
      const host = await show(lang);
      const words = '<img src=x onerror=alert(1)> Tell me about this vault';
      await send(host, words);
      expect(host.textContent).toContain(dictionary(lang).shared.vault.conversation.unavailable);
      expect(find(host, '[data-ui="vault-transcript"]').textContent).toContain(words);
      expect(host.querySelector('img[src="x"]')).toBeNull();
      await unmountAll();
      const reopened = await show(lang);
      expect(find(reopened, '[data-ui="vault-transcript"]').textContent).toContain(words);
      expect(reopened.querySelector('[data-ui="vault-proposal"]')).toBeNull();
      expect(reopened.textContent).toContain(dictionary(lang).shared.vault.conversation.local);
    },
  );

  it('uses the real reply endpoint with complete history and no goal/build/order calls', async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    portStore.setApi(async (url, init) => {
      if (init?.method === 'POST') {
        calls.push({ path: url, body: JSON.parse(String(init.body)) });
        return json({
          version: 1,
          chain: read.chain,
          address: read.vault.address,
          messageId: JSON.parse(String(init?.body)).messageId,
          message: 'Which part would you like to discuss?',
          question: null,
          proposal: null,
        });
      }
      return json({}, 404);
    });
    const host = await show();
    await send(host, 'Why is there cash?');
    await send(host, 'What if I want more gold?');
    expect(calls.map((call) => call.path)).toEqual([`${path}/reply`, `${path}/reply`]);
    expect(calls[1]?.body.messages).toEqual([
      { who: 'person', text: 'Why is there cash?' },
      { who: 'app', text: 'Which part would you like to discuss?' },
      { who: 'person', text: 'What if I want more gold?' },
    ]);
    expect(calls[1]?.body.version).toBe(1);
    expect(calls[1]?.body).not.toHaveProperty('sheet');
  });

  it('shows a pending reply under the sent message and a card that promises no draft, then the reply in place', async () => {
    const waiting: (() => void)[] = [];
    let fail = false;
    let posts = 0;
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return json({}, 404);
      posts += 1;
      await new Promise<void>((done) => waiting.push(done));
      if (fail) return json({}, 500);
      return json({
        ...reply,
        messageId: JSON.parse(String(init.body)).messageId,
      });
    });
    const release = async () => {
      await act(async () => waiting.shift()?.());
      await settle();
    };
    const copy = en.shared.vault.conversation;
    const host = await show();
    const announced = () => find(host, '[data-ui="reply-announcer"]').textContent;
    const box = find<HTMLTextAreaElement>(host, 'textarea');
    expect(announced()).toBe('');
    await type(box, 'More gold, please');
    await click(find(host, '[data-ui="composer-send"]'));
    const rows = () => [...find(host, '[data-ui="vault-transcript"]').children];
    expect(rows()).toHaveLength(2);
    const pending = find(host, '[data-ui="reply-pending"]');
    expect(rows()[1]).toBe(pending);
    expect(pending.textContent).toBe(`${copy.agent}: ${copy.pendingLines[0]}`);
    expect(pending.closest('[aria-live], [role="status"]')).toBeNull();
    expect(announced()).toBe(copy.reading);
    expect(find(host, '[data-ui="composer"]').querySelector('[role="status"]')).toBeNull();
    // the plan side: where a draft would be, a card says a reply is being worked on, with still boxes
    // and no figure. It promises no draft: most replies here only talk.
    const building = find(host, '[data-ui="vault-plan"] [data-ui="vault-building"]');
    expect(find(building, 'h2').textContent).toBe(copy.building);
    expect(building.textContent).toBe(`${copy.building}${copy.buildingLine}`);
    expect(find(building, '[data-ui="draft-skeleton"]').getAttribute('aria-hidden')).toBe('true');
    expect(find(host, '[data-ui="vault-plan"]').firstElementChild).toBe(building);
    // a vault never keeps a stale draft while the next is asked for
    expect(host.querySelector('[data-ui="vault-proposal"]')).toBeNull();
    // the next thought can be typed; it is not sent
    expect(box.readOnly).toBe(false);
    await type(box, 'and less cash');
    await click(find(host, '[data-ui="composer-send"]'));
    expect(posts).toBe(1);
    await release();
    expect(host.querySelector('[data-ui="reply-pending"]')).toBeNull();
    expect(host.querySelector('[data-ui="vault-building"]')).toBeNull();
    expect(rows()[1]?.textContent).toBe(`${copy.agent}: ${reply.message}`);
    expect(announced()).toBe(`${copy.agent}: ${reply.message} ${copy.draftArrived}`);
    expect(host.querySelector('[data-ui="vault-proposal"]')).not.toBeNull();
    expect(box.value).toBe('and less cash');

    // the next send clears the draft, and a reply that does not come is said where it would have been
    fail = true;
    await click(find(host, '[data-ui="composer-send"]'));
    expect(host.querySelector('[data-ui="vault-proposal"]')).toBeNull();
    expect(find(host, '[data-ui="vault-building"]')).not.toBeNull();
    expect(rows().at(-1)).toBe(find(host, '[data-ui="reply-pending"]'));
    await release();
    expect(host.querySelector('[data-ui="reply-pending"]')).toBeNull();
    expect(host.querySelector('[data-ui="vault-building"]')).toBeNull();
    const failed = find(host, '[data-ui="vault-transcript"] > [data-ui="vault-unanswered"]');
    expect(rows().at(-1)).toBe(failed);
    expect(find(failed, '[role="alert"]').textContent).toBe(copy.failed);
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(announced()).toBe('');
  });

  it('shows measured holdings, cash, and different current/proposed targets without execution', async () => {
    portStore.setApi(async (url, init) =>
      json(
        url.endsWith('/reply')
          ? { ...reply, messageId: JSON.parse(String(init?.body)).messageId }
          : {},
        url.endsWith('/reply') ? 200 : 404,
      ),
    );
    const host = await show();
    await send(host, 'Consider more gold.');
    const proposed = find(host, '[data-ui="vault-proposal"]');
    expect(proposed.textContent).toContain('30% → 40%');
    expect(proposed.textContent).toContain('70% → 60%');
    expect(proposed.textContent).toContain('Measured cost: 0%');
    expect(proposed.textContent).toContain('Missing observation: —');
    expect(host.textContent).toContain(en.shared.vault.conversation.previewOnly);
    expect(host.querySelector('a[href^="/buy"]')).toBeNull();
    expect(
      host.querySelector('[data-ui="vault-proposal"] button[data-ui="composer-send"]'),
    ).toBeNull();
    const saved = readLocal(
      conversationKey(userId, read.chain, read.vault.address, read.provenance, 'testnet'),
    );
    expect(saved).not.toHaveProperty('proposal');
    expect(saved).not.toHaveProperty('confirmed');
    const beforeDiscussion = readLocal(
      conversationKey(userId, read.chain, read.vault.address, read.provenance, 'testnet'),
    );
    const discuss = [...proposed.querySelectorAll('button')].find(
      (button) => button.textContent === en.shared.vault.conversation.discuss,
    );
    if (!discuss) throw new Error('The proposal offers discussion.');
    await click(discuss);
    expect(find<HTMLTextAreaElement>(host, 'textarea').value).toBe(
      en.shared.vault.conversation.discussPrompt,
    );
    expect(
      readLocal(
        conversationKey(userId, read.chain, read.vault.address, read.provenance, 'testnet'),
      ),
    ).toEqual(beforeDiscussion);
  });

  it('loads account history and writes a revision-checked transcript with no executable checkpoint', async () => {
    const transcript = [{ id: 'older', who: 'person', text: 'An earlier actual message.' }];
    const writes: Record<string, unknown>[] = [];
    portStore.setApi(async (url, init) => {
      if (url.endsWith('/reply'))
        return json({
          version: 1,
          chain: read.chain,
          address: read.vault.address,
          messageId: JSON.parse(String(init?.body)).messageId,
          message: 'A current answer.',
          question: null,
          proposal: null,
        });
      if (init?.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)));
        const value = writes.at(-1) as { expectedRevision: number; transcript: unknown[] };
        return json({
          version: 1,
          chain: read.chain,
          address: read.vault.address,
          provenance: read.provenance,
          network: 'testnet',
          revision: value.expectedRevision + 1,
          transcript: value.transcript,
        });
      }
      return json({
        version: 1,
        chain: read.chain,
        address: read.vault.address,
        provenance: read.provenance,
        network: 'testnet',
        revision: 3,
        transcript,
      });
    });
    const host = await show();
    expect(host.textContent).toContain('An earlier actual message.');
    await send(host, 'Continue this discussion.');
    expect(writes.map((write) => write.expectedRevision)).toEqual([3, 4]);
    expect(writes.every((write) => write.expectedNetwork === 'testnet')).toBe(true);
    expect(writes.every((write) => write.checkpoint === null)).toBe(true);
    expect(host.textContent).toContain(en.shared.vault.conversation.saved);
  });

  it('stops on revision conflict and preserves offline words rather than overwriting another device', async () => {
    let requested = 0;
    portStore.setApi(async (url, init) => {
      if (url.endsWith('/reply')) {
        requested += 1;
        return json(reply);
      }
      if (init?.method === 'PUT')
        return json({ details: { reason: 'REVISION_CONFLICT', revision: 1 } }, 409);
      return json({
        version: 1,
        chain: read.chain,
        address: read.vault.address,
        provenance: read.provenance,
        network: 'testnet',
        revision: 0,
        transcript: [],
      });
    });
    const host = await show();
    await send(host, 'My offline message.');
    expect(requested).toBe(0);
    expect(host.textContent).toContain(en.shared.vault.conversation.conflict);
    expect(
      readLocal(conversationKey(userId, read.chain, read.vault.address, read.provenance, 'testnet'))
        .transcript[0]?.text,
    ).toBe('My offline message.');
  });

  it('shows no private conversation and makes no private requests for a non-owner', async () => {
    const calls: string[] = [];
    portStore.setApi(async (url) => {
      calls.push(url);
      if (url === '/v1/me')
        return json({
          userId,
          wallets: EMBEDDED,
          chain: 'solana',
          chainSource: 'picked',
          chainOptions: [],
        });
      return json({
        ...read,
        vault: { ...read.vault, owner: 'Stranger1111111111111111111111111111111111' },
      });
    });
    const host = await mount(
      withAccount(
        'en',
        createElement(VaultScreen, { chain: read.chain, address: read.vault.address }),
      ),
    );
    await settle();
    expect(host.querySelector('[data-ui="vault-conversation"]')).toBeNull();
    expect(calls.some((call) => call.includes('/conversation'))).toBe(false);
  });

  it('ignores a late answer after the signed-in identity changes', async () => {
    let resolve: (response: Response) => void = () => {};
    let messageId = '';
    portStore.setApi(async (url, init) => {
      if (url === '/v1/me')
        return json({
          userId: portStore.get().userId,
          wallets: EMBEDDED,
          chain: 'solana',
          chainSource: 'picked',
          chainOptions: [],
        });
      if (url.endsWith('/reply')) {
        messageId = JSON.parse(String(init?.body)).messageId;
        return new Promise<Response>((done) => {
          resolve = done;
        });
      }
      if (url.endsWith('/conversation')) return json({}, 404);
      return json(read);
    });
    const host = await mount(
      withAccount(
        'en',
        createElement(VaultScreen, { chain: read.chain, address: read.vault.address }),
      ),
    );
    await settle();
    expect(find<HTMLDetailsElement>(host, '[data-ui="vault-details"]').open).toBe(false);
    expect(host.querySelector('[data-ui="vault-withdraw"]')).not.toBeNull();
    await send(host, 'Consider a change for my vault.');
    portStore.set(signedInPort(EMBEDDED, { userId: 'another-person' }));
    await settle();
    resolve(json({ ...reply, messageId }));
    await settle();
    expect(host.querySelector('[data-ui="vault-proposal"]')).toBeNull();
    expect(host.textContent).not.toContain(reply.message);
    expect(
      readLocal(
        conversationKey(
          'another-person',
          read.chain,
          read.vault.address,
          read.provenance,
          'testnet',
        ),
      ).transcript,
    ).toEqual([]);
  });

  it('remounts the same owned vault on a network change and rejects the old in-flight preview', async () => {
    const oldKey = conversationKey(
      userId,
      read.chain,
      read.vault.address,
      read.provenance,
      'testnet',
    );
    const nextKey = conversationKey(
      userId,
      read.chain,
      read.vault.address,
      read.provenance,
      'mainnet',
    );
    writeLocal(oldKey, {
      revision: 0,
      transcript: [{ id: 'test', who: 'person', text: 'Test network words.' }],
    });
    writeLocal(nextKey, {
      revision: 0,
      transcript: [{ id: 'main', who: 'person', text: 'Main network words.' }],
    });
    let resolve: (response: Response) => void = () => {};
    let signal: AbortSignal | null | undefined;
    let messageId = '';
    portStore.setApi(async (url, init) => {
      if (url === '/v1/me')
        return json({
          userId,
          wallets: EMBEDDED,
          chain: 'solana',
          chainSource: 'picked',
          chainOptions: [],
        });
      if (url.endsWith('/conversation')) return json({}, 404);
      if (url.endsWith('/reply')) {
        signal = init?.signal;
        messageId = JSON.parse(String(init?.body)).messageId;
        return new Promise<Response>((done) => {
          resolve = done;
        });
      }
      return json(read);
    });
    const host = await mount(
      withAccount(
        'en',
        createElement(VaultScreen, { chain: read.chain, address: read.vault.address }),
      ),
    );
    await settle();
    expect(host.textContent).toContain('Test network words.');
    expect(host.textContent).not.toContain('Main network words.');
    await send(host, 'A pending test network request.');
    await act(async () => {
      vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_SOLANA', 'mainnet');
      portStore.set(signedInPort(EMBEDDED, { userId }));
    });
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(host.textContent).toContain('Main network words.');
    expect(host.textContent).not.toContain('Test network words.');
    resolve(json({ ...reply, messageId }));
    await settle();
    expect(host.querySelector('[data-ui="vault-proposal"]')).toBeNull();
    expect(host.textContent).not.toContain(reply.message);
    expect(readLocal(nextKey).transcript).toEqual([
      { id: 'main', who: 'person', text: 'Main network words.' },
    ]);
    expect(readLocal(oldKey).transcript.at(-1)?.text).toBe('A pending test network request.');
  });

  it('keeps a delayed old-network write out of the remounted network history', async () => {
    let finishOld: (response: Response) => void = () => {};
    let oldSignal: AbortSignal | null | undefined;
    const writes: Record<string, unknown>[] = [];
    let modelCalls = 0;
    portStore.setApi(async (url, init) => {
      if (url === '/v1/me')
        return json({
          userId,
          wallets: EMBEDDED,
          chain: 'solana',
          chainSource: 'picked',
          chainOptions: [],
        });
      const network = conversationNetwork(read.chain);
      if (url.endsWith('/reply')) {
        modelCalls++;
        return json({
          ...reply,
          messageId: JSON.parse(String(init?.body)).messageId,
          proposal: null,
        });
      }
      if (url.endsWith('/conversation')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body));
          writes.push(body);
          if (body.expectedNetwork === 'testnet') {
            oldSignal = init.signal;
            return new Promise<Response>((done) => {
              finishOld = done;
            });
          }
          return json({
            version: 1,
            chain: read.chain,
            address: read.vault.address,
            provenance: read.provenance,
            network,
            revision: body.expectedRevision + 1,
            transcript: body.transcript,
          });
        }
        return json({
          version: 1,
          chain: read.chain,
          address: read.vault.address,
          provenance: read.provenance,
          network,
          revision: 0,
          transcript:
            network === 'mainnet'
              ? [{ id: 'main', who: 'person', text: 'Current main network history.' }]
              : [],
        });
      }
      return json(read);
    });
    const host = await mount(
      withAccount(
        'en',
        createElement(VaultScreen, { chain: read.chain, address: read.vault.address }),
      ),
    );
    await settle();
    await send(host, 'Pending test network words.');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.expectedNetwork).toBe('testnet');
    expect(writes[0]).not.toHaveProperty('network');
    await act(async () => {
      vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_SOLANA', 'mainnet');
      portStore.set(signedInPort(EMBEDDED, { userId }));
    });
    await settle();
    expect(oldSignal?.aborted).toBe(true);
    finishOld(json({ details: { reason: 'NETWORK_CONFLICT' } }, 409));
    await settle();
    expect(modelCalls).toBe(0);
    expect(host.textContent).toContain('Current main network history.');
    expect(host.textContent).not.toContain('Pending test network words.');
    expect(host.textContent).not.toContain(en.shared.vault.conversation.conflict);
    const mainKey = conversationKey(
      userId,
      read.chain,
      read.vault.address,
      read.provenance,
      'mainnet',
    );
    expect(readLocal(mainKey).revision).toBe(0);
    await send(host, 'Continue on the current network.');
    expect(writes.slice(1).map((write) => write.expectedNetwork)).toEqual(['mainnet', 'mainnet']);
    expect(writes.slice(1).map((write) => write.expectedRevision)).toEqual([0, 1]);
    expect(
      readLocal(mainKey).transcript.some((turn) => turn.text === 'Pending test network words.'),
    ).toBe(false);
  });
});

describe('current context and truthful holdings', () => {
  it('renders cash-only, empty and unpriced reads without target weights masquerading as holdings', async () => {
    for (const fixture of [cashRead, emptyRead, unpricedRead]) {
      const host = await mount(
        withAccount('en', createElement(VaultConversation, { read: fixture, userId })),
      );
      const current = find(host, 'section[aria-labelledby$="-held"]');
      if (fixture === emptyRead) {
        expect(current.textContent).toContain(en.shared.vault.conversation.noHoldings);
        expect(current.querySelector('[data-ui="holdings-bar"]')).toBeNull();
      }
      if (fixture === cashRead) {
        expect(current.querySelectorAll('[data-ui="holdings-bar"] span')).toHaveLength(1);
        expect(current.textContent).toContain('100%');
      }
      if (fixture === unpricedRead) {
        expect(current.textContent).toContain(en.portfolio.vault.unpriced(1));
        expect(current.querySelectorAll('[data-ui="holdings-bar"] span')).toHaveLength(1);
        expect(current.textContent).toContain('—');
      }
      await unmountAll();
    }
  });

  it('sets aside a reply asked of the read before when the same vault is read again, and says so', async () => {
    let change: (value: typeof read) => void = () => {};
    let complete: (response: Response) => void = () => {};
    let messageId = '';
    let signal: AbortSignal | null | undefined;
    function Workspace() {
      const [value, setValue] = useState(read);
      change = setValue;
      return createElement(VaultConversation, { read: value, userId });
    }
    portStore.setApi(async (url, init) => {
      if (url.endsWith('/reply')) {
        messageId = JSON.parse(String(init?.body)).messageId;
        signal = init?.signal;
        return new Promise((done) => {
          complete = done;
        });
      }
      return json({}, 404);
    });
    const host = await mount(withAccount('en', createElement(Workspace)));
    await send(host, 'Should I hold more gold?');
    const later = new Date(Date.parse(read.vault.observedAt) + 60_000).toISOString();
    await act(async () => change({ ...read, vault: { ...read.vault, observedAt: later } }));
    expect(signal?.aborted).toBe(true);
    complete(json({ ...reply, messageId }));
    await settle();
    // the answer was for the read before: not shown, and the person is told why, with their words kept
    expect(host.querySelector('[data-ui="vault-proposal"]')).toBeNull();
    expect(host.textContent).not.toContain(reply.message);
    expect(host.textContent).toContain(en.shared.vault.conversation.reread);
    expect(host.textContent).toContain('Should I hold more gold?');
    expect(
      readLocal(
        conversationKey(userId, read.chain, read.vault.address, read.provenance, 'testnet'),
      ).transcript.at(-1)?.text,
    ).toBe('Should I hold more gold?');
    // and the box is open again for the same question
    expect(find<HTMLTextAreaElement>(host, 'textarea').disabled).toBe(false);
  });

  it.each([otherRead, evmRead])(
    'discards an in-flight reply when opening another vault/chain',
    async (nextRead) => {
      let change: (value: typeof read) => void = () => {};
      let complete: (response: Response) => void = () => {};
      let messageId = '';
      let signal: AbortSignal | null | undefined;
      function Workspace() {
        const [value, setValue] = useState(read);
        change = setValue;
        return createElement(VaultConversation, {
          key: `${value.chain}:${value.vault.address}`,
          read: value,
          userId,
        });
      }
      portStore.setApi(async (url, init) => {
        if (url.endsWith('/reply')) {
          messageId = JSON.parse(String(init?.body)).messageId;
          signal = init?.signal;
          return new Promise((done) => {
            complete = done;
          });
        }
        return json({}, 404);
      });
      const host = await mount(withAccount('en', createElement(Workspace)));
      await send(host, 'A change on the original vault.');
      await act(async () => change(nextRead));
      expect(signal?.aborted).toBe(true);
      complete(json({ ...reply, messageId }));
      await settle();
      expect(host.querySelector('[data-ui="vault-proposal"]')).toBeNull();
      expect(host.textContent).not.toContain(reply.message);
      expect(
        readLocal(
          conversationKey(
            userId,
            nextRead.chain,
            nextRead.vault.address,
            nextRead.provenance,
            'testnet',
          ),
        ).transcript,
      ).toEqual([]);
    },
  );

  it('keeps preview context across reopening, but never restores it as an executable proposal', async () => {
    const requests: Record<string, unknown>[] = [];
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/reply')) return json({}, 404);
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return json({ ...reply, messageId: body.messageId });
    });
    const host = await show();
    await send(host, 'Consider a change.');
    expect(host.querySelectorAll('[data-ui="vault-draft-record"]')).toHaveLength(1);
    await unmountAll();
    const reopened = await show();
    expect(reopened.querySelector('[data-ui="vault-proposal"]')).toBeNull();
    await send(reopened, 'Can we refine that draft?');
    const messages = requests.at(-1)?.messages as { who: string; text: string }[];
    expect(
      messages.some(
        (turn) =>
          turn.who === 'app' &&
          turn.text.includes('solana:gldx') &&
          turn.text.includes('40%') &&
          turn.text.includes('[exit]'),
      ),
    ).toBe(true);
    expect(messages.at(-1)?.text).toBe('Can we refine that draft?');
  });

  it('does not accept replies for a different message or vault identity', async () => {
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/reply')) return json({}, 404);
      return json({
        ...reply,
        messageId: JSON.parse(String(init?.body)).messageId,
        chain: 'robinhood',
        address: evmRead.vault.address,
      });
    });
    const host = await show();
    await send(host, 'Discuss this vault.');
    expect(host.querySelector('[data-ui="vault-proposal"]')).toBeNull();
    expect(host.textContent).toContain(en.shared.vault.conversation.failed);
    portStore.setApi(async () => json({ ...reply, messageId: 'unrelated' }));
    await send(host, 'Keep discussing the same vault.');
    expect(host.querySelector('[data-ui="vault-proposal"]')).toBeNull();
  });
});

describe('conservative stored history and provider validation', () => {
  it('uses exact configured networks and does not import old unscoped local history', async () => {
    expect(conversationNetwork(read.chain)).toBe('testnet');
    vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_SOLANA', 'mainnet');
    expect(conversationNetwork(read.chain)).toBe('mainnet');
    vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_SOLANA', 'testnet');
    const keys = (['mainnet', 'testnet', 'local', null] as const).map((network) =>
      conversationKey(userId, read.chain, read.vault.address, read.provenance, network),
    );
    expect(new Set(keys).size).toBe(4);
    const legacy = `tf-vault-conversation:1:${encodeURIComponent(userId)}:${read.chain}:${read.vault.address}:${read.provenance}`;
    writeLocal(legacy, {
      revision: 0,
      transcript: [{ id: 'old', who: 'person', text: 'Unscoped old words.' }],
    });
    const host = await show();
    expect(host.textContent).not.toContain('Unscoped old words.');
    expect(readLocal(legacy).transcript[0]?.text).toBe('Unscoped old words.');
  });

  it.each([undefined, 'mainnet', 'local'])(
    'rejects a server read for missing or different network %s',
    async (network) => {
      const store = serverConversation(
        async () =>
          json({
            version: 1,
            chain: read.chain,
            address: read.vault.address,
            provenance: read.provenance,
            network,
            revision: 0,
            transcript: [],
          }),
        read.chain,
        read.vault.address,
        read.provenance,
        'testnet',
      );
      expect(await store.read()).toBeNull();
    },
  );

  it.each([undefined, 'mainnet', 'local', 'testnet'])(
    'accepts a write acknowledgement only on the exact expected network %s',
    async (network) => {
      const value = {
        revision: 3,
        transcript: [{ id: 'x', who: 'person' as const, text: 'My words.' }],
      };
      let sent: Record<string, unknown> = {};
      const store = serverConversation(
        async (_path, init) => {
          sent = JSON.parse(String(init?.body));
          return json({
            version: 1,
            chain: read.chain,
            address: read.vault.address,
            provenance: read.provenance,
            network,
            revision: 4,
            transcript: value.transcript,
          });
        },
        read.chain,
        read.vault.address,
        read.provenance,
        'testnet',
      );
      expect(await store.write(value)).toBe(network === 'testnet' ? 'saved' : 'unavailable');
      expect(sent).toEqual({
        version: 1,
        expectedNetwork: 'testnet',
        expectedRevision: 3,
        transcript: value.transcript,
        checkpoint: null,
      });
    },
  );

  it('takes out of a message exactly what our server refuses in one, and keeps lines', () => {
    const accepted = (text: string) =>
      VaultConversationTranscript.safeParse([{ id: 'a', who: 'app', text }]).success;
    const codes = [
      ...Array.from({ length: 0xa1 }, (_, i) => i),
      ...Array.from({ length: 0x30 }, (_, i) => 0x600 + i),
      ...Array.from({ length: 0x80 }, (_, i) => 0x2000 + i),
      0xfeff,
    ];
    for (const code of codes) {
      const text = `a${String.fromCharCode(code)}b`;
      // what the schema refuses is changed, what it accepts is left as it is
      expect(plainText(text) === text, `U+${code.toString(16)}`).toBe(accepted(text));
      expect(accepted(plainText(text)), `U+${code.toString(16)}`).toBe(true);
    }
    expect(plainText('one\r\ntwo\rthree\n\tfour')).toBe('one\ntwo\nthree\n\tfour');
  });

  it('sends our server no character it refuses, whatever text the save is handed', async () => {
    const value = {
      revision: 0,
      transcript: [
        { id: 'a', who: 'person' as const, text: 'Why\u2066 gold?\r\nTell me.' },
        { id: 'b', who: 'app' as const, text: 'Gold\u0000 is\u202e here\u0007.\u009f' },
        // nothing but what is taken out: an empty row would be refused, so it is not sent
        { id: 'c', who: 'app' as const, text: '\u0007\u202e \u200f' },
      ],
    };
    let sent: { transcript: unknown } = { transcript: null };
    const store = serverConversation(
      async (_path, init) => {
        sent = JSON.parse(String(init?.body));
        // our server, by its own schema: a refused row is a 400, as it would be for every save after
        if (!VaultConversationTranscript.safeParse(sent.transcript).success) return json({}, 400);
        return json({
          version: 1,
          chain: read.chain,
          address: read.vault.address,
          provenance: read.provenance,
          network: 'testnet',
          revision: 1,
          transcript: sent.transcript,
        });
      },
      read.chain,
      read.vault.address,
      read.provenance,
      'testnet',
    );
    expect(await store.write(value)).toBe('saved');
    expect(sent.transcript).toEqual([
      { id: 'a', who: 'person', text: 'Why gold?\nTell me.' },
      { id: 'b', who: 'app', text: 'Gold is here.' },
    ]);
  });

  it('saves a reply with characters our server refuses as plain text, so later saves still go through', async () => {
    const writes: { transcript: unknown }[] = [];
    portStore.setApi(async (url, init) => {
      if (url.endsWith('/reply'))
        return json({
          ...reply,
          messageId: JSON.parse(String(init?.body)).messageId,
          message: 'First line.\r\nSecond \u202eline\u0007 here.\u200f',
          proposal: null,
        });
      if (url === path && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        return json({
          version: 1,
          chain: read.chain,
          address: read.vault.address,
          provenance: read.provenance,
          network: 'testnet',
          revision: body.expectedRevision + 1,
          transcript: body.transcript,
          checkpoint: null,
          updatedAt: null,
        });
      }
      if (url === path)
        return json({
          version: 1,
          chain: read.chain,
          address: read.vault.address,
          provenance: read.provenance,
          network: 'testnet',
          revision: 0,
          transcript: [],
          checkpoint: null,
          updatedAt: null,
        });
      return json({}, 404);
    });
    const host = await show();
    await settle();
    await send(host, 'Why\u2066 gold?\r\nTell me.');
    await send(host, 'And after that?');
    // every save, the first and the ones after the reply, is one the schema takes
    expect(writes.length).toBeGreaterThanOrEqual(3);
    for (const write of writes)
      expect(VaultConversationTranscript.safeParse(write.transcript).success).toBe(true);
    const kept = readLocal(
      conversationKey(userId, read.chain, read.vault.address, read.provenance, 'testnet'),
    ).transcript.map((turn) => turn.text);
    expect(kept.slice(0, 2)).toEqual(['Why gold?\nTell me.', 'First line.\nSecond line here.']);
    expect(kept.at(-2)).toBe('And after that?');
  });

  it('asks an API without the history route once a tab, and a vault’s own 404 every time', async () => {
    const value = { revision: 0, transcript: [] };
    const missing = vi.fn(async (_path: string) =>
      json({ message: `Route GET:${path} not found`, error: 'Not Found', statusCode: 404 }, 404),
    );
    const one = serverConversation(
      missing,
      read.chain,
      read.vault.address,
      read.provenance,
      'testnet',
    );
    expect(await one.read()).toBeNull();
    expect(missing).toHaveBeenCalledTimes(1);
    // the route is not there: another vault's page, a write, asks nothing more in this tab
    const two = serverConversation(
      missing,
      read.chain,
      'another-vault',
      read.provenance,
      'testnet',
    );
    expect(await two.read()).toBeNull();
    expect(await two.write(value)).toBe('unavailable');
    expect(missing).toHaveBeenCalledTimes(1);
    // a 404 for one vault on an API that has the route is that vault's, and is asked again
    sessionStorage.clear();
    const notYours = vi.fn(async (_path: string) => json({ error: 'not found' }, 404));
    const three = serverConversation(
      notYours,
      read.chain,
      read.vault.address,
      read.provenance,
      'testnet',
    );
    expect(await three.read()).toBeNull();
    expect(await three.read()).toBeNull();
    expect(notYours).toHaveBeenCalledTimes(2);
  });

  it('does not ask for private history without a valid configured network', async () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_SOLANA', 'invalid-network');
    expect(conversationNetwork(read.chain)).toBeNull();
    const api = vi.fn(async (_path: string) => json({}));
    const store = serverConversation(api, read.chain, read.vault.address, read.provenance, null);
    expect(await store.read()).toBeNull();
    expect(await store.write({ revision: 0, transcript: [] })).toBe('unavailable');
    expect(api).not.toHaveBeenCalled();
    portStore.setApi(api);
    await show();
    expect(api.mock.calls.map(([path]) => path)).toEqual(['/v1/me']);
  });
  it('separates users, chains, provenance, normalized EVM identities and exact Solana identities', () => {
    const lower = '0x204faca1764b154221e35c0d20abb3c525710498';
    expect(conversationKey(userId, 'robinhood', lower, 'sandbox', 'testnet')).toBe(
      conversationKey(
        userId,
        'robinhood',
        lower.toUpperCase().replace('0X', '0x'),
        'sandbox',
        'testnet',
      ),
    );
    expect(conversationKey(userId, read.chain, read.vault.address, 'sandbox', 'testnet')).not.toBe(
      conversationKey('another', read.chain, read.vault.address, 'sandbox', 'testnet'),
    );
    expect(conversationKey(userId, read.chain, read.vault.address, 'sandbox', 'testnet')).not.toBe(
      conversationKey(userId, read.chain, read.vault.address, 'live', 'testnet'),
    );
  });
  it('accepts the server’s full 200-character source label and renders it without truncation', async () => {
    expect(longSourceLabel).toHaveLength(200);
    expect(agentReplyOf(longSourceReply, read)?.proposal?.sources[0]?.label).toBe(longSourceLabel);
    expect(
      agentReplyOf(
        {
          ...longSourceReply,
          proposal: {
            ...longSourceReply.proposal,
            sources: longSourceReply.proposal.sources.map((source) => ({
              ...source,
              label: 'x'.repeat(201),
            })),
          },
        },
        read,
      ),
    ).toBeNull();
    portStore.setApi(async (url, init) =>
      json(
        url.endsWith('/reply')
          ? { ...longSourceReply, messageId: JSON.parse(String(init?.body)).messageId }
          : {},
        url.endsWith('/reply') ? 200 : 404,
      ),
    );
    const host = await show();
    await send(host, 'Review the source behind this proposal.');
    expect(find(host, '[data-ui="vault-proposal"]').textContent).toContain(longSourceLabel);
  });
  it('never accepts unvalidated/off-chain or incomplete allocations as a preview', () => {
    expect(agentReplyOf(reply, read)?.proposal?.allocations).toHaveLength(2);
    expect(
      agentReplyOf(
        {
          ...reply,
          proposal: {
            ...reply.proposal,
            allocations: [
              { ...reply.proposal.allocations[0], assetId: 'robinhood:tspy', weightBps: 10000 },
            ],
          },
        },
        read,
      ),
    ).toBeNull();
    expect(
      agentReplyOf(
        {
          ...reply,
          proposal: {
            ...reply.proposal,
            allocations: [{ ...reply.proposal.allocations[0], weightBps: 9999 }],
          },
        },
        read,
      ),
    ).toBeNull();
    expect(
      agentReplyOf(
        {
          ...reply,
          proposal: {
            ...reply.proposal,
            allocations: [
              { ...reply.proposal.allocations[0], weightBps: 10000, evidenceIds: ['invented'] },
            ],
          },
        },
        read,
      ),
    ).toBeNull();
  });
  it('rejects malformed or oversized stored person words without accepting stored server sheets', () => {
    expect(
      transcriptOf({
        revision: 0,
        transcript: [{ id: 'x', who: 'person', text: 'x'.repeat(2001) }],
      }),
    ).toBeNull();
    const value = transcriptOf({
      revision: 0,
      transcript: [{ id: 'x', who: 'person', text: 'My actual words' }],
      sheet: reply.proposal,
    });
    expect(value).not.toHaveProperty('sheet');
  });
  it('rejects private history answered for a different vault', async () => {
    const store = serverConversation(
      async () =>
        json({
          version: 1,
          chain: read.chain,
          address: read.vault.owner,
          provenance: read.provenance,
          network: 'testnet',
          revision: 0,
          transcript: [],
        }),
      read.chain,
      read.vault.address,
      read.provenance,
      'testnet',
    );
    expect(await store.read()).toBeNull();
  });
  it('retains local pending words when account load fails', async () => {
    writeLocal(
      conversationKey(userId, read.chain, read.vault.address, read.provenance, 'testnet'),
      {
        revision: 0,
        transcript: [{ id: 'x', who: 'person', text: 'My retained message' }],
      },
    );
    portStore.setApi(async () => {
      throw new Error('offline');
    });
    const host = await show();
    expect(host.textContent).toContain('My retained message');
  });
});
