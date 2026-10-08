// @vitest-environment happy-dom
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
  localStorage.clear();
  portStore.set(signedInPort(EMBEDDED, { userId }));
  portStore.setApi(async () => json({}, 404));
});
afterEach(unmountAll);

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
      conversationKey(userId, read.chain, read.vault.address, read.provenance),
    );
    expect(saved).not.toHaveProperty('proposal');
    expect(saved).not.toHaveProperty('confirmed');
    const beforeDiscussion = readLocal(
      conversationKey(userId, read.chain, read.vault.address, read.provenance),
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
      readLocal(conversationKey(userId, read.chain, read.vault.address, read.provenance)),
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
          revision: value.expectedRevision + 1,
          transcript: value.transcript,
        });
      }
      return json({
        version: 1,
        chain: read.chain,
        address: read.vault.address,
        provenance: read.provenance,
        revision: 3,
        transcript,
      });
    });
    const host = await show();
    expect(host.textContent).toContain('An earlier actual message.');
    await send(host, 'Continue this discussion.');
    expect(writes.map((write) => write.expectedRevision)).toEqual([3, 4]);
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
        revision: 0,
        transcript: [],
      });
    });
    const host = await show();
    await send(host, 'My offline message.');
    expect(requested).toBe(0);
    expect(host.textContent).toContain(en.shared.vault.conversation.conflict);
    expect(
      readLocal(conversationKey(userId, read.chain, read.vault.address, read.provenance))
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
      readLocal(conversationKey('another-person', read.chain, read.vault.address, read.provenance))
        .transcript,
    ).toEqual([]);
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
          conversationKey(userId, nextRead.chain, nextRead.vault.address, nextRead.provenance),
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
  it('separates users, chains, provenance, normalized EVM identities and exact Solana identities', () => {
    const lower = '0x204faca1764b154221e35c0d20abb3c525710498';
    expect(conversationKey(userId, 'robinhood', lower, 'sandbox')).toBe(
      conversationKey(userId, 'robinhood', lower.toUpperCase().replace('0X', '0x'), 'sandbox'),
    );
    expect(conversationKey(userId, read.chain, read.vault.address, 'sandbox')).not.toBe(
      conversationKey('another', read.chain, read.vault.address, 'sandbox'),
    );
    expect(conversationKey(userId, read.chain, read.vault.address, 'sandbox')).not.toBe(
      conversationKey(userId, read.chain, read.vault.address, 'live'),
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
          revision: 0,
          transcript: [],
        }),
      read.chain,
      read.vault.address,
      read.provenance,
    );
    expect(await store.read()).toBeNull();
  });
  it('retains local pending words when account load fails', async () => {
    writeLocal(conversationKey(userId, read.chain, read.vault.address, read.provenance), {
      revision: 0,
      transcript: [{ id: 'x', who: 'person', text: 'My retained message' }],
    });
    portStore.setApi(async () => {
      throw new Error('offline');
    });
    const host = await show();
    expect(host.textContent).toContain('My retained message');
  });
});
