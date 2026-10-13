// @vitest-environment happy-dom
import { createElement } from 'react';
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
import { withAccount } from '../account/test/screen';
import { readLocal, type Turn, transcriptOf } from '../vault-conversation/storage';
import { json, PHANTOM, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { GoalHome } from './GoalHome';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// Measured figures on /goal (RELAXED-INTAKE as amended 2026-10-09): a reply's figures are drawn as the
// vault's conversation draws them, and kept in this browser as they were served.
const userId = 'did:privy:test';
const exit = 'exit:solana:tslax:worst';
const capacity = 'capacity:solana:tslax';
const ref = (id: string) => `{{fact:${id}}}`;
const measured = (over: Record<string, unknown> = {}) => ({
  id: exit,
  assetId: 'solana:tslax',
  label: 'Exit cost at the reference size, worst measured regime (weekday off-hours)',
  text: '0.4%',
  value: 0.004,
  unit: 'fraction',
  source: 'Bearing fact sheet',
  method: 'hourly quotes (facts-0.1)',
  fetchedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  provenance: 'sandbox',
  staleAgeSec: null,
  ...over,
});
const SAID =
  'The largest sale of Tesla within the cost tolerance is $42,000.00. Selling Tesla costs about 0.4% in the worst measured regime.';
const TEMPLATE = `The largest sale of Tesla within the cost tolerance is ${ref(capacity)}. Selling Tesla costs about ${ref(exit)} in the worst measured regime.`;
const figures = (
  facts: unknown[] = [
    measured({
      id: capacity,
      text: '$42,000.00',
      value: 42_000,
      unit: 'USD',
      label: 'Largest sale within the cost tolerance',
    }),
    measured(),
  ],
) => ({
  prose: { message: TEMPLATE, question: null, proposal: null },
  facts,
});
const person = {
  userId,
  wallets: PHANTOM,
  chain: 'solana',
  chainSource: 'wallet',
  chainOptions: [],
};
const sent: { messages: { who: string; text: string }[] }[] = [];
/** Our API: each reply is the next of `replies`, the last one again after that. */
const serve = (...replies: Record<string, unknown>[]) =>
  portStore.setApi(async (url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      const reply = replies[Math.min(sent.length - 1, replies.length - 1)];
      return json({
        version: 1,
        chain: 'solana',
        messageId: body.messageId,
        question: null,
        proposal: null,
        ...reply,
      });
    }
    return url === '/v1/me' ? json(person) : json({}, 404);
  });
const show = () => mount(withAccount('en', createElement(GoalHome)));
const say = async (host: HTMLElement, words: string) => {
  await type(find<HTMLTextAreaElement>(host, 'textarea'), words);
  await click(find(host, '[data-ui="composer-send"]'));
  await settle();
};
/** The conversation as this browser keeps it. */
const stored = (): Turn[] => {
  const key = Object.keys(localStorage).find(
    (name) =>
      name.startsWith('tf-goal-conversation:2:') && !/:(?:index|preview|deposit)$/u.test(name),
  );
  return key ? readLocal(key).transcript : [];
};
beforeEach(() => {
  window.history.replaceState(null, '', '/goal');
  localStorage.clear();
  sessionStorage.clear();
  sent.length = 0;
  portStore.set(signedInPort(PHANTOM, { userId }));
});
afterEach(unmountAll);

describe('a figure the Invest chat states', () => {
  it('is drawn in the reply with its pin, hatched on a test network, with source, time and method', async () => {
    serve({ message: SAID, figures: figures() });
    const host = await show();
    await say(host, 'how deep are their pools?');
    const drawn = [...host.querySelectorAll('[data-ui="goal-transcript"] [data-ui="figure"]')];
    expect(drawn.map((figure) => find(figure as HTMLElement, '.tf-figure').textContent)).toEqual([
      '$42,000.00',
      '0.4%',
    ]);
    // the sentence is whole around the figures, and no placeholder is shown
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain(
      'Selling Tesla costs about 0.4%',
    );
    expect(host.textContent).not.toMatch(/[{}]|fact:/u);
    const figure = drawn[1] as HTMLElement;
    expect(figure.getAttribute('data-state')).toBe('mock');
    expect(find(figure, '[data-ui="pin-glyph"]').hasAttribute('data-hatch')).toBe(true);
    const pin = find(figure, '[data-ui="pin"]');
    expect(pin.getAttribute('aria-label')).toBe(
      'Source for 0.4%, a measured figure, 20 minutes old, sample figure',
    );
    await click(pin);
    const popover = find(figure, '[data-ui="pin-popover"]').textContent ?? '';
    expect(popover).toContain(
      'Exit cost at the reference size, worst measured regime (weekday off-hours)',
    );
    expect(popover).toContain('Test network, not live');
    const line = await pinLine(figure);
    expect(line).toContain('Bearing fact sheet');
    expect(line).toContain('hourly quotes (facts-0.1)');
  });

  it('marks a sample figure, and a price past its age as stale, as the pin does everywhere', async () => {
    serve({
      message: SAID,
      figures: figures([
        measured({
          id: capacity,
          text: '$42,000.00',
          value: 42_000,
          unit: 'USD',
          provenance: 'live',
          staleAgeSec: 7200,
        }),
        measured({ provenance: 'mock' }),
      ]),
    });
    const host = await show();
    await say(host, 'how deep are their pools?');
    const [closed, sample] = [
      ...host.querySelectorAll<HTMLElement>('[data-ui="goal-transcript"] [data-ui="figure"]'),
    ];
    expect(closed?.getAttribute('data-state')).toBe('stale');
    await click(find(closed as HTMLElement, '[data-ui="pin"]'));
    expect(find(closed as HTMLElement, '[data-ui="pin-popover"]').textContent).toContain(
      'Last updated 2 hours ago, which is stale',
    );
    expect(sample?.getAttribute('data-state')).toBe('mock');
    await click(find(sample as HTMLElement, '[data-ui="pin"]'));
    expect(find(sample as HTMLElement, '[data-ui="pin-popover"]').textContent).toContain(
      'Sample figure, not live',
    );
  });

  it('says a figure that is not measured in words, with no number and no pin', async () => {
    const missing = {
      id: 'weekend:solana:tslax',
      assetId: 'solana:tslax',
      label: 'Weekend ÷ market-hours exit capacity',
      text: 'not measured (no samples in that regime yet)',
      value: null,
      reason: 'no_samples_in_regime',
    };
    serve({
      message: 'Weekend exit capacity for Tesla is not measured (no samples in that regime yet).',
      figures: {
        prose: {
          message: `Weekend exit capacity for Tesla is ${ref(missing.id)}.`,
          question: null,
          proposal: null,
        },
        facts: [missing],
      },
    });
    const host = await show();
    await say(host, 'and on weekends?');
    expect(find(host, '[data-ui="figure-missing"]').textContent).toBe(
      'not measured (no samples in that regime yet)',
    );
    expect(host.querySelector('[data-ui="goal-transcript"] [data-ui="figure"]')).toBeNull();
  });

  it('keeps the turn in this browser as { text, figures }, and sends the model the places, not the values', async () => {
    serve({ message: SAID, figures: figures() }, { message: 'Noted.' });
    const host = await show();
    await say(host, 'how deep are their pools?');
    const kept = stored().at(-1);
    expect(kept?.text).toBe(SAID);
    expect(kept?.figures?.template).toBe(TEMPLATE);
    expect(kept?.figures?.facts.map((fact) => [fact.id, fact.text])).toEqual([
      [capacity, '$42,000.00'],
      [exit, '0.4%'],
    ]);
    await say(host, 'thanks');
    expect(sent[1]?.messages[1]).toEqual({ who: 'app', text: TEMPLATE });
    expect(JSON.stringify(sent[1])).not.toContain('42,000');
  });

  it('reopens the conversation with the figure measured then and its age, and asks for nothing new', async () => {
    serve({
      message: SAID,
      figures: figures([
        measured({
          id: capacity,
          text: '$42,000.00',
          value: 42_000,
          unit: 'USD',
          fetchedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        }),
        measured({ fetchedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
      ]),
    });
    const first = await show();
    await say(first, 'how deep are their pools?');
    await unmountAll();
    sent.length = 0;
    serve({ message: 'today it is different' });
    const host = await show();
    await settle();
    expect(sent).toHaveLength(0);
    const drawn = [...host.querySelectorAll('[data-ui="goal-transcript"] .tf-figure')];
    expect(drawn.map((figure) => figure.textContent)).toEqual(['$42,000.00', '0.4%']);
    const ages = [...host.querySelectorAll('[data-ui="figure-age"]')];
    expect(ages.map((age) => age.textContent)).toEqual([' (3 days old)', ' (3 days old)']);
    expect(host.textContent).not.toMatch(/[{}]|fact:/u);
  });

  it('lets the oldest replies give up their figures before the history is too large to keep, and says so', async () => {
    // a browser that already holds close to all the figures it keeps
    serve({
      message: 'First.',
      figures: {
        prose: {
          message: `Tesla trades at ${ref('price:solana:tslax')}.`,
          question: null,
          proposal: null,
        },
        facts: [measured({ id: 'price:solana:tslax', text: '$250.00', value: 250, unit: 'USD' })],
      },
    });
    const first = await show();
    await say(first, 'price?');
    const key = Object.keys(localStorage).find(
      (name) =>
        name.startsWith('tf-goal-conversation:2:') && !/:(?:index|preview|deposit)$/u.test(name),
    ) as string;
    const old: Turn[] = Array.from({ length: 96 }, (_, at) => ({
      id: `old-${at}`,
      who: at % 2 ? ('app' as const) : ('person' as const),
      text: at % 2 ? 'Tesla trades at $250.00.' : 'price?',
      ...(at % 2
        ? {
            figures: {
              template: `Tesla trades at ${ref('price:solana:tslax')}.`,
              facts: [
                measured({
                  id: 'price:solana:tslax',
                  text: '$250.00',
                  value: 250,
                  unit: 'USD',
                  method: 'm'.repeat(1900),
                  source: 's'.repeat(1900),
                }) as never,
              ],
            },
          }
        : {}),
    }));
    expect(transcriptOf({ revision: 0, transcript: old })).not.toBeNull();
    await unmountAll();
    localStorage.setItem(key, JSON.stringify({ revision: 0, transcript: old }));
    sent.length = 0;
    serve({
      message: 'Tesla trades at $250.00.',
      figures: {
        prose: {
          message: `Tesla trades at ${ref('price:solana:tslax')}.`,
          question: null,
          proposal: null,
        },
        facts: [
          measured({
            id: 'price:solana:tslax',
            text: '$250.00',
            value: 250,
            unit: 'USD',
            method: 'm'.repeat(1900),
            source: 's'.repeat(1900),
          }),
        ],
      },
    });
    const host = await show();
    await say(host, 'and now?');
    const kept = stored();
    expect(kept.at(-1)?.figures).toBeDefined();
    const gaveUp = kept.filter((turn) => turn.who === 'app' && !turn.figures);
    expect(gaveUp.length).toBeGreaterThan(0);
    for (const turn of gaveUp) expect(turn.text).toBe('Tesla trades at (figure no longer kept).');
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain(
      'Tesla trades at (figure no longer kept).',
    );
  });
});

describe('an API or a web that does not know figures', () => {
  it('shows a reply with no `figures` as plain words, and keeps it as plain text', async () => {
    serve({ message: 'Tesla is on this chain. How much will you deposit?' });
    const host = await show();
    await say(host, 'I want Tesla');
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain(
      'Tesla is on this chain. How much will you deposit?',
    );
    expect(host.querySelector('[data-ui="goal-transcript"] [data-ui="figure"]')).toBeNull();
    expect(stored().at(-1)).toEqual({
      id: expect.any(String),
      who: 'app',
      text: 'Tesla is on this chain. How much will you deposit?',
    });
  });

  it('reads a conversation kept before figures as it was', async () => {
    serve({ message: 'First.' });
    const first = await show();
    await say(first, 'I want Tesla');
    await unmountAll();
    const host = await show();
    await settle();
    expect(find(host, '[data-ui="goal-transcript"]').textContent).toContain('First.');
  });

  it('gives an older web the same words with the values written in and no braces: `message` is plain', () => {
    // the API's own contract (relaxed-goal-figures.test.ts): `message` never holds a placeholder,
    // so a web that ignores `figures` shows this
    expect(SAID).not.toMatch(/[{}]|fact:/u);
  });
});
