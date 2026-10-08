// @vitest-environment happy-dom
import type { MixReview } from '@colosseum/schemas';
import { vaultOf } from '@colosseum/sdk';
import { createElement, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { withAccount } from '../account/test/screen';
import { recallOrder } from '../order/order-record';
import { deploymentsFor } from '../order/readiness';
import { retargetOrder } from '../shared/test/fixtures';
import { reply, read as sample } from '../vault-conversation/test/fixtures';
import { VaultConversation } from '../vault-conversation/VaultConversation';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { UseGoalMix } from './UseGoalMix';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));

// Gate ANY-COMPOSITION (#191): a preview says how its weights were set and what to watch, and leads to
// the server's review, where every warning is ticked before the confirm sends the review's hash.

const userId = 'did:privy:test';
// The vault this app derives from its owner and plan number, as the guard does: the one a retarget
// may name.
const deployment = deploymentsFor('solana', false)?.solana;
if (!deployment) throw new Error('a test-network deployment is committed for Solana');
const derived = vaultOf(deployment, sample.vault.owner, sample.vault.basketId);
if (!derived) throw new Error('the sample vault derives');
const read = { ...sample, vault: { ...sample.vault, address: derived } };
const en = dictionary('en');
const hash = 'ab'.repeat(32);
const figure = {
  label: 'Measured exit capacity',
  value: 12,
  unit: 'USD' as const,
  source: 'fixture exit read',
  fetchedAt: '2026-10-05T12:00:00.000Z',
  method: 'test measured exit',
  provenance: 'sandbox' as const,
};
const reviewOf = (over: Partial<MixReview> = {}): MixReview => ({
  chain: 'solana',
  origin: 'model',
  goal: null,
  amountUsd: 100,
  lines: [
    {
      assetId: 'solana:usdc',
      symbol: 'USDC',
      cls: 'cash',
      weightBps: 6000,
      amountUsd: 60,
      price: null,
      exitCeiling: null,
    },
    {
      assetId: 'solana:gldx',
      symbol: 'tGLDx',
      cls: 'gold',
      weightBps: 4000,
      amountUsd: 40,
      price: {
        usdPerToken: '20',
        source: 'fixture price',
        fetchedAt: '2026-10-05T12:00:00.000Z',
        method: 'test price',
        provenance: 'sandbox',
      },
      exitCeiling: {
        usd: 12,
        measured: true,
        source: 'fixture exit read',
        fetchedAt: '2026-10-05T12:00:00.000Z',
        method: 'test measured exit',
        provenance: 'sandbox',
      },
    },
  ],
  targets: [{ asset: 'solana:gldx', weightBps: 4000 }],
  cashBps: 6000,
  warnings: [
    {
      id: 'EXIT_OVER_CAPACITY:solana:gldx',
      code: 'EXIT_OVER_CAPACITY',
      assetId: 'solana:gldx',
      text: 'tGLDx is larger than its measured exit can sell as planned.',
      figures: [figure],
    },
  ],
  unconfirmed: ['EXIT_OVER_CAPACITY:solana:gldx'],
  reviewHash: hash,
  provenance: 'sandbox',
  disclaimer: 'Test disclaimer',
  ...over,
});
const answer = {
  ...reply,
  address: derived,
  proposal: {
    ...reply.proposal,
    sources: [
      ...reply.proposal.sources,
      { ...figure, id: 'liquidity:solana:gldx', assetId: 'solana:gldx' },
    ],
  },
  warnings: [
    { code: 'over_exit_capacity', assetId: 'solana:gldx', evidenceId: 'liquidity:solana:gldx' },
  ],
  weightNotes: [
    { code: 'stated', assetIds: ['solana:gldx'], quote: '40% gold' },
    { code: 'equal_split', assetIds: ['solana:usdc'] },
    { code: 'share_unread', assetIds: [], quote: 'mostly safe' },
    { code: 'share_withdrawn', assetIds: [], quote: '70% TSLA' },
  ],
};

type Call = { url: string; body: Record<string, unknown> };
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_SOLANA', 'testnet');
  localStorage.clear();
  router.push.mockClear();
  portStore.set(signedInPort(EMBEDDED, { userId }));
});
afterEach(async () => {
  await unmountAll();
  vi.unstubAllEnvs();
});

const buttonNamed = (host: HTMLElement, name: string) => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === name);
  if (!button) throw new Error(`no button named ${name}`);
  return button;
};

describe('a vault conversation’s preview, applied to the vault', () => {
  it('says how the weights were set and what to watch, with the measured figure and its pin', async () => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return json({}, 404);
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return url.endsWith('/conversation/reply')
        ? json({ ...answer, messageId: calls.at(-1)?.body.messageId })
        : json({}, 404);
    });
    const host = await mount(withAccount('en', createElement(VaultConversation, { read, userId })));
    await type(find<HTMLTextAreaElement>(host, 'textarea'), 'Put 40% in gold, mostly safe');
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    const notes = find(host, '[data-ui="weight-notes"]').textContent ?? '';
    expect(notes).toContain(en.mix.preview.note.stated('tGLDx', '40% gold'));
    expect(notes).toContain(en.mix.preview.note.equalRest('USDC'));
    expect(notes).toContain(en.mix.preview.note.unread('mostly safe'));
    expect(notes).toContain(en.mix.preview.note.withdrawn('70% TSLA'));
    const warnings = find(host, '[data-ui="mix-warnings"]');
    expect(warnings.textContent).toContain(en.mix.preview.warning.overExit('tGLDx'));
    expect(warnings.querySelector('[data-ui="pin"]')).not.toBeNull();
  });

  it('reviews the targets, holds the confirm until every warning is ticked, and keeps the reviewed targets with the order', async () => {
    const calls: Call[] = [];
    const ordered = retargetOrder();
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return json({}, 404);
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      if (url.endsWith('/conversation/reply'))
        return json({ ...answer, messageId: body.messageId });
      if (url.endsWith('/targets'))
        return body.confirm
          ? json({ status: 'ordered', review: reviewOf({ unconfirmed: [] }), order: ordered })
          : json({ status: 'review', review: reviewOf() });
      return json({}, 404);
    });
    const host = await mount(withAccount('en', createElement(VaultConversation, { read, userId })));
    await type(find<HTMLTextAreaElement>(host, 'textarea'), 'Put 40% in gold');
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    await click(buttonNamed(host, en.mix.preview.apply));
    await settle();
    // The preview's weights are where the fields start; nothing is asked of the server yet.
    expect(calls.filter((c) => c.url.endsWith('/targets'))).toEqual([]);
    expect(find<HTMLInputElement>(host, '[data-ui="targets-lines"] input').value).toBe('40');
    await click(find(host, '[data-action="targets-review"]'));
    await settle();
    const asked = calls.find((c) => c.url.endsWith('/targets'));
    expect(asked?.url).toBe(`/v1/vaults/solana/${read.vault.address}/targets`);
    expect(asked?.body).toMatchObject({
      version: 1,
      origin: 'model',
      confirm: false,
      acceptedWarnings: [],
      allocations: [
        { assetId: 'solana:gldx', weightBps: 4000 },
        { assetId: 'solana:usdc', weightBps: 6000 },
      ],
    });
    // Every figure of the review carries its pin; the confirm waits for the tick.
    const lines = find(host, '[data-ui="mix-review-lines"]');
    expect(lines.textContent).toContain('tGLDx');
    expect(find(host, '[data-ui="exit-ceiling"]').textContent).toContain(en.mix.review.measured);
    const confirm = find<HTMLButtonElement>(host, '[data-action="mix-confirm"]');
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    await click(confirm);
    expect(calls.filter((c) => c.url.endsWith('/targets'))).toHaveLength(1);
    await click(find(host, '[data-ui="mix-review-warnings"] input[type="checkbox"]'));
    expect(confirm.getAttribute('aria-disabled')).toBeNull();
    await click(confirm);
    await settle();
    const confirmed = calls.filter((c) => c.url.endsWith('/targets')).at(-1);
    expect(confirmed?.body).toMatchObject({
      confirm: true,
      reviewHash: hash,
      acceptedWarnings: ['EXIT_OVER_CAPACITY:solana:gldx'],
    });
    expect(router.push).toHaveBeenCalledWith(`/orders/${ordered.id}`);
    expect(recallOrder(ordered.id, userId)?.terms).toEqual({
      kind: 'retarget',
      vault: read.vault.address,
      basketId: read.vault.basketId,
      targets: [{ asset: 'solana:gldx', weightBps: 4000 }],
      origin: 'model',
    });
  });

  it('sends a weight the person changed as their own, and the review is of what the field says', async () => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return json({}, 404);
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      if (url.endsWith('/conversation/reply'))
        return json({ ...answer, messageId: body.messageId });
      if (!url.endsWith('/targets')) return json({}, 404);
      const [gold, cash] = reviewOf().lines.slice().reverse();
      return json({
        status: 'review',
        review: reviewOf({
          origin: 'person',
          lines: [
            { ...cash, weightBps: 4500, amountUsd: 45 },
            { ...gold, weightBps: 5500, amountUsd: 55 },
          ] as MixReview['lines'],
        }),
      });
    });
    const host = await mount(withAccount('en', createElement(VaultConversation, { read, userId })));
    await type(find<HTMLTextAreaElement>(host, 'textarea'), 'Put 40% in gold');
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    await click(buttonNamed(host, en.mix.preview.apply));
    await settle();
    await type(find<HTMLInputElement>(host, '[data-ui="targets-lines"] input'), '55');
    await click(find(host, '[data-action="targets-review"]'));
    await settle();
    expect(calls.find((c) => c.url.endsWith('/targets'))?.body).toMatchObject({
      origin: 'person',
      confirm: false,
      allocations: [
        { assetId: 'solana:gldx', weightBps: 5500 },
        { assetId: 'solana:usdc', weightBps: 4500 },
      ],
    });
    expect(find(host, '[data-ui="mix-review-lines"]').textContent).toContain('55%');
  });
});

describe('a new goal’s mix, made into a plan', () => {
  it('asks the amount and goal, reviews, and stores the plan for the existing buy', async () => {
    const calls: Call[] = [];
    const proposalId = '0f6a3b9e-2c4d-4e5f-8a7b-1c2d3e4f5a6b';
    const { planOn } = await import('../order/test/fixtures');
    const plan = planOn('solana');
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body });
      return body.confirm
        ? json({
            status: 'stored',
            review: reviewOf({ unconfirmed: [] }),
            proposalId,
            proposal: plan.proposal,
          })
        : json({ status: 'review', review: reviewOf() });
    });
    const host = await mount(
      withAccount(
        'en',
        createElement(UseGoalMix, {
          chain: 'solana',
          userId,
          allocations: [
            { assetId: 'solana:usdc', weightBps: 6000 },
            { assetId: 'solana:gldx', weightBps: 4000 },
          ],
          onClose: () => {},
        }),
      ),
    );
    await click(find(host, '[data-action="mix-review"]'));
    expect(calls).toEqual([]);
    expect(host.textContent).toContain(en.mix.goal.errors.amount);
    await type(host.querySelector('input') as HTMLInputElement, '100');
    const [goal, risk] = [...host.querySelectorAll('select')];
    if (!goal || !risk) throw new Error('goal and risk are asked');
    goal.value = 'protect';
    goal.dispatchEvent(new Event('change', { bubbles: true }));
    risk.value = 'low';
    risk.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await click(find(host, '[data-action="mix-review"]'));
    await settle();
    expect(calls[0]).toMatchObject({
      url: '/v1/conversations/solana/goal/accept',
      body: {
        origin: 'model',
        goal: 'protect',
        risk: 'low',
        amountUsd: 100,
        confirm: false,
        allocations: [
          { assetId: 'solana:gldx', weightBps: 4000 },
          { assetId: 'solana:usdc', weightBps: 6000 },
        ],
      },
    });
    await click(find(host, '[data-ui="mix-review-warnings"] input[type="checkbox"]'));
    await click(find(host, '[data-action="mix-confirm"]'));
    await settle();
    expect(calls[1]?.body).toMatchObject({
      confirm: true,
      reviewHash: hash,
      acceptedWarnings: ['EXIT_OVER_CAPACITY:solana:gldx'],
      amountUsd: 100,
    });
    expect(router.push).toHaveBeenCalledWith(`/plan/${proposalId}/buy`);
    expect(localStorage.getItem(`tf-plan:${proposalId}`)).not.toBeNull();
  });

  it('shows a new review, unticked, when the figures moved before the confirm', async () => {
    let n = 0;
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      n += 1;
      return json({
        status: 'review',
        review: body.confirm
          ? reviewOf({
              reviewHash: 'cd'.repeat(32),
              warnings: [
                {
                  ...(reviewOf().warnings[0] as MixReview['warnings'][number]),
                  id: 'NOT_FOR_GOAL:solana:gldx',
                  code: 'NOT_FOR_GOAL',
                },
              ],
            })
          : reviewOf(),
      });
    });
    const host = await mount(
      withAccount(
        'en',
        createElement(UseGoalMix, {
          chain: 'solana',
          userId,
          allocations: [
            { assetId: 'solana:usdc', weightBps: 6000 },
            { assetId: 'solana:gldx', weightBps: 4000 },
          ],
          onClose: () => {},
        }),
      ),
    );
    await type(host.querySelector('input') as HTMLInputElement, '100');
    for (const [i, value] of ['grow', 'medium'].entries()) {
      const select = host.querySelectorAll('select')[i] as HTMLSelectElement;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await settle();
    await click(find(host, '[data-action="mix-review"]'));
    await settle();
    await click(find(host, '[data-ui="mix-review-warnings"] input[type="checkbox"]'));
    await click(find(host, '[data-action="mix-confirm"]'));
    await settle();
    expect(n).toBe(2);
    expect(host.textContent).toContain(en.mix.review.changed);
    expect(find(host, '[data-action="mix-confirm"]').getAttribute('aria-disabled')).toBe('true');
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('a new goal’s mix, with a weight the person changed', () => {
  it('reviews the weights in the fields and says the person chose them', async () => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return json({}, 500);
    });
    const host = await mount(
      withAccount(
        'en',
        createElement(UseGoalMix, {
          chain: 'solana',
          userId,
          allocations: [
            { assetId: 'solana:usdc', weightBps: 6000 },
            { assetId: 'solana:gldx', weightBps: 4000 },
          ],
          onClose: () => {},
        }),
      ),
    );
    await type(host.querySelector('input') as HTMLInputElement, '100');
    for (const [i, value] of ['grow', 'medium'].entries()) {
      const select = host.querySelectorAll('select')[i] as HTMLSelectElement;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const weight = find<HTMLInputElement>(host, '[data-ui="targets-lines"] input');
    expect(weight.value).toBe('40');
    // a weight that does not read holds the review back
    await type(weight, '140');
    expect(find(host, '[data-action="mix-review"]').getAttribute('aria-disabled')).toBe('true');
    await type(weight, '25');
    await settle();
    await click(find(host, '[data-action="mix-review"]'));
    await settle();
    expect(calls[0]?.body).toMatchObject({
      origin: 'person',
      confirm: false,
      allocations: [
        { assetId: 'solana:gldx', weightBps: 2500 },
        { assetId: 'solana:usdc', weightBps: 7500 },
      ],
    });
  });
});

describe('the weight editor of a vault the person owns', () => {
  const vaultPath = `/v1/vaults/solana/${derived}`;
  const showEditor = async (calls: Call[]) => {
    portStore.setApi(async (url, init) => {
      if (url === vaultPath && !init?.method) return json(read);
      if (url === `${vaultPath}/targets` && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        calls.push({ url, body });
        // The review reads back the lines sent, as the server does.
        const sent = body.allocations as { assetId: string; weightBps: number }[];
        const lines = sent.map((line) => {
          const sample = reviewOf().lines.find((l) => l.assetId === line.assetId);
          if (!sample) throw new Error(`no sample line for ${line.assetId}`);
          return { ...sample, weightBps: line.weightBps, amountUsd: line.weightBps / 100 };
        });
        return json({ status: 'review', review: reviewOf({ origin: 'person', lines }) });
      }
      return json({}, 404);
    });
    const { TargetsScreen } = await import('./TargetsScreen');
    // Mounted twice, as development does: the review still arrives.
    const host = await mount(
      withAccount(
        'en',
        createElement(
          StrictMode,
          null,
          createElement(TargetsScreen, { chain: 'solana', address: derived }),
        ),
      ),
    );
    await settle();
    return host;
  };
  const inputs = (host: HTMLElement) => [
    ...host.querySelectorAll<HTMLInputElement>('[data-ui="targets-lines"] input'),
  ];

  it('starts from the vault’s targets, shows the rest as cash, and says what to change', async () => {
    const calls: Call[] = [];
    const host = await showEditor(calls);
    expect(inputs(host).map((input) => input.value)).toEqual(['30']);
    expect(find(host, '[data-ui="targets-cash"]').textContent).toBe(en.mix.editor.cash('70%'));
    await type(inputs(host)[0] as HTMLInputElement, '120');
    expect(host.textContent).toContain(en.mix.editor.issues['not-whole']);
    await type(inputs(host)[0] as HTMLInputElement, '');
    expect(find(host, '[data-ui="targets-issues"]').textContent).toContain(
      en.mix.editor.issues['all-cash'],
    );
    const review = find(host, '[data-action="targets-review"]');
    expect(review.getAttribute('aria-disabled')).toBe('true');
    await click(review);
    expect(calls).toEqual([]);
  });

  it('switches between percents and basis points without changing a weight, and sends the person’s mix', async () => {
    const calls: Call[] = [];
    const host = await showEditor(calls);
    await type(inputs(host)[0] as HTMLInputElement, '62.5');
    const unit = host.querySelector('select') as HTMLSelectElement;
    unit.value = 'bps';
    unit.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(inputs(host)[0]?.value).toBe('6250');
    expect(find(host, '[data-ui="targets-cash"]').textContent).toBe(en.mix.editor.cash('37.5%'));
    await click(find(host, '[data-action="targets-review"]'));
    await settle();
    expect(calls[0]?.body).toMatchObject({
      origin: 'person',
      confirm: false,
      allocations: [
        { assetId: 'solana:gldx', weightBps: 6250 },
        { assetId: 'solana:usdc', weightBps: 3750 },
      ],
    });
    expect(find(host, '[data-ui="mix-review-lines"]')).not.toBeNull();
  });
});
