// @vitest-environment happy-dom

import { VaultConversationTranscript } from '@colosseum/schemas';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  click,
  find,
  mount,
  pinLine,
  settle,
  type,
  unmountAll,
} from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { withAccount } from '../account/test/screen';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { agentReplyOf } from './agent';
import {
  conversationKey,
  conversationNetwork,
  readLocal,
  type Turn,
  transcriptOf,
  withinFigureBudget,
} from './storage';
import { preview, read } from './test/fixtures';
import { VaultConversation } from './VaultConversation';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));

// Figures by reference (gate FIGURES-BY-REFERENCE): what our server measured, drawn as a figure.
const userId = 'did:privy:test';
const en = dictionary('en');
const exit = 'exit:solana:gldx:worst';
const ref = (id: string) => `{{fact:${id}}}`;
const measured = (over: Record<string, unknown> = {}) => ({
  id: exit,
  assetId: 'solana:gldx',
  label: 'Exit cost at the reference size, worst measured regime (weekend)',
  text: '0.4%',
  value: 0.004,
  unit: 'fraction',
  source: 'Bearing fact sheet',
  method: 'exit-cost curve (facts-0.1)',
  fetchedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  provenance: 'sandbox',
  staleAgeSec: null,
  ...over,
});
const missing = {
  id: 'weekend:solana:gldx',
  assetId: 'solana:gldx',
  label: 'Weekend ÷ market-hours exit capacity',
  text: 'not measured (no samples in that regime yet)',
  value: null,
  reason: 'no_samples_in_regime',
};
const answer = (over: Record<string, unknown>) => (init?: RequestInit) => ({
  version: 1,
  chain: read.chain,
  address: read.vault.address,
  messageId: JSON.parse(String(init?.body)).messageId,
  question: null,
  proposal: null,
  ...over,
});
const figured = answer({
  message: 'Selling it all today would cost about 0.4%.',
  figures: {
    prose: {
      message: `Selling it all today would cost about ${ref(exit)}.`,
      question: null,
      proposal: null,
    },
    facts: [measured()],
  },
});
/** Our API: the reply route answers with `reply`, and the history route keeps what it is sent. */
const serve = (reply: (init?: RequestInit) => unknown, kept: { transcript: unknown[] } | null) => {
  const sent: Record<string, unknown>[] = [];
  let revision = 0;
  portStore.setApi(async (url, init) => {
    if (url.endsWith('/reply')) {
      sent.push(JSON.parse(String(init?.body)));
      return json(reply(init));
    }
    if (!kept) return json({}, 404);
    const head = {
      version: 1,
      chain: read.chain,
      address: read.vault.address,
      provenance: read.provenance,
      network: 'testnet',
    };
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      // as our server does: a transcript it refuses is not kept
      const parsed = VaultConversationTranscript.safeParse(body.transcript);
      if (!parsed.success) return json({ error: 'invalid request' }, 400);
      kept.transcript = parsed.data;
      revision = body.expectedRevision + 1;
    }
    return json({ ...head, revision, transcript: kept.transcript });
  });
  return sent;
};
const show = (lang: 'en' | 'pt' = 'en') =>
  mount(withAccount(lang, createElement(VaultConversation, { read, userId })));
const say = async (host: HTMLElement, words: string) => {
  await type(find<HTMLTextAreaElement>(host, 'textarea'), words);
  await click(find(host, '[data-ui="composer-send"]'));
  await settle();
};
const transcriptText = (host: HTMLElement) =>
  find(host, '[data-ui="vault-transcript"]').textContent ?? '';
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_SOLANA', 'testnet');
  localStorage.clear();
  sessionStorage.clear();
  portStore.set(signedInPort(EMBEDDED, { userId }));
});
afterEach(async () => {
  await unmountAll();
  vi.unstubAllEnvs();
});

describe('a figure the conversation states', () => {
  it('is drawn with the pin and the tooltip every other figure has, marked as test network', async () => {
    serve(figured, null);
    const host = await show();
    await say(host, 'What would selling cost?');
    const figure = find(host, '[data-ui="vault-transcript"] [data-ui="figure"]');
    expect(find(figure, '.tf-figure').textContent).toBe('0.4%');
    // not live: the hatched glyph, named for screen readers
    expect(figure.getAttribute('data-state')).toBe('mock');
    expect(find(figure, '[data-ui="pin-glyph"]').hasAttribute('data-hatch')).toBe(true);
    const pin = find(figure, '[data-ui="pin"]');
    expect(pin.getAttribute('aria-label')).toBe(
      'Source for 0.4%, a measured figure, 20 minutes old, sample figure',
    );
    await click(pin);
    const popover = find(figure, '[data-ui="pin-popover"]').textContent ?? '';
    // in plain words first: what the figure is, and that it is not live
    expect(popover).toContain('Exit cost at the reference size, worst measured regime (weekend)');
    expect(popover).toContain('Test network, not live');
    // the API's own source and method, one step away under Details
    const line = await pinLine(figure);
    expect(line).toContain('Bearing fact sheet');
    expect(line).toContain('exit-cost curve (facts-0.1)');
    // the sentence around it is whole, and no placeholder is ever shown
    expect(transcriptText(host)).toContain('Selling it all today would cost about 0.4%');
    expect(host.textContent).not.toMatch(/[{}]|fact:/u);
    // a measurement under an hour old carries no age beside it
    expect(host.querySelector('[data-ui="figure-age"]')).toBeNull();
  });

  it('follows the figure’s own provenance: a live one has the live pin', async () => {
    serve(
      answer({
        message: 'It is priced at $20.00.',
        figures: {
          prose: {
            message: `It is priced at ${ref('price:solana:gldx')}.`,
            question: null,
            proposal: null,
          },
          facts: [
            measured({
              id: 'price:solana:gldx',
              text: '$20.00',
              value: 20,
              unit: 'USD',
              provenance: 'live',
            }),
          ],
        },
      }),
      null,
    );
    const host = await show('pt');
    await say(host, 'Qual o preço?');
    const figure = find(host, '[data-ui="vault-transcript"] [data-ui="figure"]');
    expect(figure.getAttribute('data-state')).toBe('live');
    expect(find(figure, '[data-ui="pin"]').getAttribute('aria-label')).toContain(
      '$20.00, um valor medido',
    );
  });

  it('says a figure that is not measured in words, with no number and no pin', async () => {
    serve(
      answer({
        message: 'Weekend capacity is not measured (no samples in that regime yet).',
        figures: {
          prose: {
            message: `Weekend capacity is ${ref(missing.id)}.`,
            question: null,
            proposal: null,
          },
          facts: [missing],
        },
      }),
      null,
    );
    const host = await show();
    await say(host, 'And at the weekend?');
    expect(find(host, '[data-ui="figure-missing"]').textContent).toBe(missing.text);
    expect(host.querySelector('[data-ui="vault-transcript"] [data-ui="figure"]')).toBeNull();
    expect(transcriptText(host)).not.toMatch(/\d|[{}]/u);
  });

  it('shows no part of a reply whose figures cannot be read: never a bare number, never a brace', async () => {
    const unread = [
      // a placeholder that names no fact
      {
        prose: { message: `It costs ${ref('exit:solana:other')}.`, question: null, proposal: null },
        facts: [measured()],
      },
      // a fact with no source
      {
        prose: { message: `It costs ${ref(exit)}.`, question: null, proposal: null },
        facts: [measured({ source: '' })],
      },
      // a number on a figure that is not measured
      {
        prose: { message: `It costs ${ref(missing.id)}.`, question: null, proposal: null },
        facts: [{ ...missing, value: 3 }],
      },
      'figures',
    ];
    for (const figures of unread)
      expect(
        agentReplyOf(
          answer({ message: 'It costs 0.4%.', figures })({ body: '{"messageId":"m"}' }),
          read,
        ),
      ).toBeNull();
    serve(answer({ message: 'It costs 0.4%.', figures: unread[0] }), null);
    const refused = await show();
    await say(refused, 'What would selling cost?');
    expect(refused.textContent).not.toContain('0.4%');
    expect(refused.textContent).toContain(en.shared.vault.conversation.failed);
    await unmountAll();
    localStorage.clear();
    // a server that sends no figures at all: plain words, as before
    serve(answer({ message: 'It costs little to sell.' }), null);
    const host = await show();
    await say(host, 'What would selling cost?');
    expect(transcriptText(host)).toContain('It costs little to sell.');
    expect(host.querySelector('[data-ui="vault-transcript"] [data-ui="figure"]')).toBeNull();
  });

  it('draws the figures of the proposal’s own prose in the preview', async () => {
    serve(
      answer({
        message: 'Here is a preview to discuss.',
        proposal: { ...preview, objective: 'Keep gold, which costs 0.4% to sell.' },
        warnings: [],
        weightNotes: [],
        figures: {
          prose: {
            message: 'Here is a preview to discuss.',
            question: null,
            proposal: {
              objective: `Keep gold, which costs ${ref(exit)} to sell.`,
              summary: preview.summary,
              tradeoffs: preview.tradeoffs,
              unknowns: preview.unknowns,
              why: {
                'solana:gldx': `It costs ${ref(exit)} to sell.`,
                'solana:usdc': 'Keeps a cash share.',
              },
            },
          },
          facts: [measured()],
        },
      }),
      null,
    );
    const host = await show();
    await say(host, 'Should I keep gold?');
    const drawn = find(host, '[data-ui="vault-proposal"]').querySelectorAll(
      '[data-ui="figure"] .tf-figure',
    );
    expect([...drawn].filter((node) => node.textContent === '0.4%')).toHaveLength(2);
    expect(find(host, '[data-ui="vault-proposal"]').textContent).not.toMatch(/\{\{|fact:/u);
    // the record of the draft kept in the conversation holds the objective's figure too
    const record = find(host, '[data-ui="vault-draft-record"]');
    expect(find(record, '[data-ui="figure"] .tf-figure').textContent).toBe('0.4%');
  });
});

describe('a kept conversation', () => {
  const key = conversationKey(
    userId,
    read.chain,
    read.vault.address,
    read.provenance,
    conversationNetwork(read.chain),
  );

  it('keeps each reply with the figures it stated, and sends the model their places, not their values', async () => {
    const kept = { transcript: [] as unknown[] };
    const sent = serve(figured, kept);
    const host = await show();
    await say(host, 'What would selling cost?');
    const reply = kept.transcript.at(-1) as Turn;
    expect(reply.text).toBe('Selling it all today would cost about 0.4%.');
    expect(reply.figures).toEqual({
      template: `Selling it all today would cost about ${ref(exit)}.`,
      facts: [expect.objectContaining({ id: exit, text: '0.4%', source: 'Bearing fact sheet' })],
    });
    expect(host.textContent).toContain('Saved to your account');
    // the same figures, with their time, in this browser's copy
    expect(readLocal(key).transcript.at(-1)?.figures).toEqual(reply.figures);
    await say(host, 'And tomorrow?');
    expect((sent[1]?.messages as { who: string; text: string }[] | undefined)?.[1]).toEqual({
      who: 'app',
      text: `Selling it all today would cost about ${ref(exit)}.`,
    });
  });

  it('reopens an old answer with the figure measured then, its time and its age, never today’s', async () => {
    const then = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const kept = {
      transcript: [
        { id: 'a', who: 'person', text: 'What would selling cost?' },
        {
          id: 'b',
          who: 'app',
          text: 'Selling it all today would cost about 0.4%.',
          figures: {
            template: `Selling it all today would cost about ${ref(exit)}.`,
            facts: [measured({ fetchedAt: then })],
          },
        },
      ],
    };
    // today's reply would say otherwise; nothing asks for it on reopening
    const sent = serve(answer({ message: 'unused' }), kept);
    const host = await show();
    await settle();
    expect(sent).toHaveLength(0);
    const figure = find(host, '[data-ui="vault-transcript"] [data-ui="figure"]');
    expect(find(figure, '.tf-figure').textContent).toBe('0.4%');
    expect(find(host, '[data-ui="figure-age"]').textContent).toContain('3 days old');
    expect(find(figure, '[data-ui="pin"]').getAttribute('aria-label')).toBe(
      'Source for 0.4%, a measured figure, 3 days old, sample figure',
    );
    // the time it was measured then, as the API wrote it, under Details
    expect(await pinLine(figure)).toContain(then.replace(/\.\d{3}Z$/u, 'Z'));
    expect(host.textContent).not.toMatch(/[{}]/u);
  });

  it('reads kept figures only as our server writes them, on a reply only', () => {
    const row = (figures: unknown, who = 'app') => ({
      revision: 1,
      transcript: [{ id: 'a', who, text: 'It costs 0.4%.', figures }],
    });
    const good = { template: `It costs ${ref(exit)}.`, facts: [measured()] };
    expect(transcriptOf(row(good))?.transcript[0]?.figures).toEqual(good);
    for (const bad of [
      row(good, 'person'),
      row({ ...good, template: `It costs ${ref('exit:other')}.` }),
      row({ ...good, facts: [measured({ method: '' })] }),
      row({ ...good, facts: [measured(), missing] }),
      row({ template: 'It costs 0.4%.', facts: [] }),
      row('figures'),
    ])
      expect(transcriptOf(bad)).toBeNull();
  });

  it('lets the oldest replies give up their figures before a long history refuses to save, and says so in each place', () => {
    const turns: Turn[] = Array.from({ length: 300 }, (_, i) => ({
      id: String(i),
      who: 'app',
      text: 'It costs 0.4%.',
      figures: {
        template: `It costs ${ref(exit)}.`,
        facts: [measured({ method: 'm'.repeat(1000) }) as never],
      },
    }));
    const within = withinFigureBudget(turns, '(figure no longer kept)');
    expect(within[0]).toEqual({ id: '0', who: 'app', text: 'It costs (figure no longer kept).' });
    expect(within.at(-1)).toEqual(turns.at(-1));
    // no turn is left with a bare value and no pin
    for (const turn of within) expect(turn.text).not.toMatch(/[{}]/u);
    expect(within.filter((turn) => !turn.figures).every((turn) => !/\d/u.test(turn.text))).toBe(
      true,
    );
    expect(transcriptOf({ revision: 0, transcript: turns })).toBeNull();
    expect(transcriptOf({ revision: 0, transcript: within })).not.toBeNull();
    expect(VaultConversationTranscript.safeParse(within).success).toBe(true);
  });

  it('counts a kept reply as it is sent back to the model, with its placeholders', () => {
    const long = `${'word '.repeat(1200)}${ref(exit)}.`;
    const row = (id: number): Turn => ({
      id: String(id),
      who: 'app',
      text: 'x',
      figures: { template: long, facts: [measured() as never] },
    });
    // by their one-character texts these fit; by what goes back to the model they do not
    expect(long.length * 40).toBeGreaterThan(220_000);
    expect(
      transcriptOf({ revision: 0, transcript: Array.from({ length: 40 }, (_, i) => row(i)) }),
    ).toBeNull();
    expect(
      transcriptOf({ revision: 0, transcript: Array.from({ length: 30 }, (_, i) => row(i)) }),
    ).not.toBeNull();
  });

  it('starts showing an age in a tab left open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const kept = {
        transcript: [
          { id: 'a', who: 'person', text: 'What would selling cost?' },
          {
            id: 'b',
            who: 'app',
            text: 'Selling it all today would cost about 0.4%.',
            figures: {
              template: `Selling it all today would cost about ${ref(exit)}.`,
              facts: [measured({ fetchedAt: new Date(Date.now() - 50 * 60_000).toISOString() })],
            },
          },
        ],
      };
      serve(answer({ message: 'unused' }), kept);
      const host = await show();
      await settle();
      expect(host.querySelector('[data-ui="figure-age"]')).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(20 * 60_000);
      });
      expect(find(host, '[data-ui="figure-age"]').textContent).toContain('1 hour old');
    } finally {
      vi.useRealTimers();
    }
  });
});
