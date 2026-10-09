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

/** A review of the lines sent, as the server reads them back: its targets and cash are those lines. */
const reviewFor = (
  sent: { assetId: string; weightBps: number }[],
  over: Partial<MixReview> = {},
): MixReview => {
  const lines = sent.map((line) => {
    const sample = reviewOf().lines.find((l) => l.assetId === line.assetId);
    if (!sample) throw new Error(`no sample line for ${line.assetId}`);
    return { ...sample, weightBps: line.weightBps, amountUsd: line.weightBps / 100 };
  });
  const held = lines.filter((line) => line.cls !== 'cash');
  return reviewOf({
    lines,
    targets: held.map((line) => ({ asset: line.assetId, weightBps: line.weightBps })),
    cashBps: 10_000 - held.reduce((n, line) => n + line.weightBps, 0),
    ...over,
  });
};
/** The same warning, by the same id, on a figure that moved: only the hash tells the two apart. */
const moved = (over: Partial<MixReview> = {}): Partial<MixReview> => ({
  reviewHash: 'cd'.repeat(32),
  warnings: [
    {
      ...(reviewOf().warnings[0] as MixReview['warnings'][number]),
      figures: [{ ...figure, value: 3 }],
    },
  ],
  ...over,
});
const box = (host: HTMLElement) =>
  find<HTMLInputElement>(host, '[data-ui="mix-review-warnings"] input[type="checkbox"]');
const chooseGoal = async (host: HTMLElement, goal = 'grow', risk = 'medium') => {
  for (const [i, value] of [goal, risk].entries()) {
    const select = host.querySelectorAll('select')[i] as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  await settle();
};
const goalMix = (lang: 'en' | 'pt' = 'en') =>
  mount(
    withAccount(
      lang,
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

/** What a review echoes of the request it answers: the amount and the goal it was checked for. */
const of = (body: { amountUsd: number; goal: MixReview['goal'] }) => ({
  amountUsd: body.amountUsd,
  goal: body.goal,
});

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
      return json({ status: 'review', review: reviewFor(body.allocations, { origin: 'person' }) });
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
    expect(find(host, '[data-ui="mix-review-total"]').textContent).toContain('$100.00');
  });

  /** The conversation with a preview shown, its editor opened and the review asked for. */
  const reviewing = async (targetsAnswer: (body: Call['body'], n: number) => Response) => {
    let n = 0;
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST') return json({}, 404);
      const body = JSON.parse(String(init.body));
      if (url.endsWith('/conversation/reply'))
        return json({ ...answer, messageId: body.messageId });
      if (!url.endsWith('/targets')) return json({}, 404);
      n += 1;
      return targetsAnswer(body, n);
    });
    const host = await mount(withAccount('en', createElement(VaultConversation, { read, userId })));
    await type(find<HTMLTextAreaElement>(host, 'textarea'), 'Put 40% in gold');
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    await click(buttonNamed(host, en.mix.preview.apply));
    await settle();
    await click(find(host, '[data-action="targets-review"]'));
    await settle();
    return host;
  };

  it('unticks a warning whose figure moved under the same id, and holds the confirm again', async () => {
    const host = await reviewing((body) =>
      json({ status: 'review', review: body.confirm ? reviewOf(moved()) : reviewOf() }),
    );
    await click(box(host));
    await click(find(host, '[data-action="mix-confirm"]'));
    await settle();
    expect(host.textContent).toContain(en.mix.review.changed);
    expect(box(host).checked).toBe(false);
    expect(find(host, '[data-action="mix-confirm"]').getAttribute('aria-disabled')).toBe('true');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('refuses a review whose targets are not the lines it was sent', async () => {
    const host = await reviewing(() =>
      json({
        status: 'review',
        review: reviewOf({ targets: [{ asset: 'solana:gldx', weightBps: 9000 }], cashBps: 1000 }),
      }),
    );
    expect(host.querySelector('[data-ui="mix-review-lines"]')).toBeNull();
    expect(find(host, '[role="alert"]').textContent).toBe(en.mix.failure.unreadable);
  });

  it('does not say nothing was stored when the server took the confirm and its order does not match', async () => {
    const host = await reviewing((body) =>
      body.confirm
        ? json({
            status: 'ordered',
            review: reviewOf({ unconfirmed: [] }),
            order: { ...retargetOrder(), type: 'buy' },
          })
        : json({ status: 'review', review: reviewOf() }),
    );
    await click(box(host));
    await click(find(host, '[data-action="mix-confirm"]'));
    await settle();
    expect(find(host, '[role="alert"]').textContent).toBe(en.mix.failure.unchecked);
    expect(en.mix.failure.unchecked).not.toContain('Nothing was stored');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('closes the editor when another proposal arrives, and offers the new one', async () => {
    const host = await reviewing(() => json({ status: 'review', review: reviewOf() }));
    expect(host.querySelector('[data-ui="mix-review-lines"]')).not.toBeNull();
    await type(find<HTMLTextAreaElement>(host, 'textarea'), 'And now?');
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    expect(host.querySelector('[data-ui="mix-review-lines"]')).toBeNull();
    expect(host.querySelector('[data-ui="weight-editor"]')).toBeNull();
    expect(buttonNamed(host, en.mix.preview.apply)).not.toBeNull();
  });

  it('shows a note on a share that was not applied when the reply has no proposal', async () => {
    portStore.setApi(async (url, init) => {
      if (init?.method !== 'POST' || !url.endsWith('/conversation/reply')) return json({}, 404);
      return json({
        ...answer,
        messageId: JSON.parse(String(init.body)).messageId,
        proposal: null,
        warnings: [],
        weightNotes: [{ code: 'share_unmet', assetIds: [], quote: '70% TSLA' }],
      });
    });
    const host = await mount(withAccount('en', createElement(VaultConversation, { read, userId })));
    await type(find<HTMLTextAreaElement>(host, 'textarea'), 'I want 70% TSLA');
    await click(find(host, '[data-ui="composer-send"]'));
    await settle();
    const notes = find(host, '[data-ui="weight-notes"]').textContent ?? '';
    expect(notes).toContain(en.mix.preview.notesAlone);
    expect(notes).toContain(en.mix.preview.note.unmet('70% TSLA'));
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
            review: reviewOf({ ...of(body), unconfirmed: [] }),
            proposalId,
            proposal: plan.proposal,
          })
        : json({ status: 'review', review: reviewOf(of(body)) });
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

  it('unticks a warning whose figure moved under the same id, and holds the confirm again', async () => {
    let n = 0;
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      n += 1;
      return json({
        status: 'review',
        review: body.confirm ? reviewOf(moved(of(body))) : reviewOf(of(body)),
      });
    });
    const host = await goalMix();
    await type(host.querySelector('input') as HTMLInputElement, '100');
    await chooseGoal(host);
    await click(find(host, '[data-action="mix-review"]'));
    await settle();
    await click(box(host));
    await click(find(host, '[data-action="mix-confirm"]'));
    await settle();
    expect(n).toBe(2);
    expect(host.textContent).toContain(en.mix.review.changed);
    expect(box(host).checked).toBe(false);
    expect(find(host, '[data-action="mix-confirm"]').getAttribute('aria-disabled')).toBe('true');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('starts a review of changed weights with nothing ticked', async () => {
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      const gold = body.allocations.find((l: { assetId: string }) => l.assetId === 'solana:gldx');
      // the same warning id at 40% and at 90%; the hash is the review's own
      return json({
        status: 'review',
        review: reviewFor(body.allocations, gold.weightBps === 4000 ? of(body) : moved(of(body))),
      });
    });
    const host = await goalMix();
    await type(host.querySelector('input') as HTMLInputElement, '100');
    await chooseGoal(host);
    await click(find(host, '[data-action="mix-review"]'));
    await settle();
    await click(box(host));
    expect(find(host, '[data-action="mix-confirm"]').getAttribute('aria-disabled')).toBeNull();
    await click(buttonNamed(host, en.mix.review.back));
    await type(find<HTMLInputElement>(host, '[data-ui="targets-lines"] input'), '90');
    await click(find(host, '[data-action="mix-review"]'));
    await settle();
    expect(find(host, '[data-ui="mix-review-lines"]').textContent).toContain('90%');
    expect(box(host).checked).toBe(false);
    expect(find(host, '[data-action="mix-confirm"]').getAttribute('aria-disabled')).toBe('true');
  });

  it('reads a Portuguese amount with a decimal comma, and shows the total reviewed', async () => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body });
      return json({ status: 'review', review: reviewOf(of(body)) });
    });
    const host = await goalMix('pt');
    await type(host.querySelector('input') as HTMLInputElement, '100,50');
    await chooseGoal(host);
    await click(find(host, '[data-action="mix-review"]'));
    await settle();
    expect(calls[0]?.body.amountUsd).toBe(100.5);
    expect(find(host, '[data-ui="mix-review-total"]').textContent).toMatch(/100,50/);
  });

  it('says each asset the goal refuses on a line of its own, with what to do', async () => {
    portStore.setApi(async (url) =>
      url.endsWith('/goal/accept')
        ? json(
            {
              error: 'this mix cannot be bought as it is',
              code: 'MIX_NOT_VALID',
              details: { issues: ['NOT_FOR_GOAL:solana:gldx', 'NOT_FOR_GOAL:solana:btc'] },
            },
            422,
          )
        : json({}, 404),
    );
    const host = await goalMix();
    await type(host.querySelector('input') as HTMLInputElement, '100');
    await chooseGoal(host, 'protect', 'low');
    await click(find(host, '[data-action="mix-review"]'));
    await settle();
    const said = (find(host, '[role="alert"]').textContent ?? '').split('\n');
    expect(said).toHaveLength(3);
    expect(said[0]).toBe(en.mix.failure.invalid);
    expect(said[1]).toMatch(/gold|GLD/i);
    expect(said[1]).toContain('Take it out, or choose another goal.');
    expect(said[2]).not.toBe(said[1]);
    expect(said[2]).toContain('Take it out, or choose another goal.');
    const pt = dictionary('pt');
    expect(pt.mix.issue('NOT_FOR_GOAL', 'Ouro')).toContain('Ouro');
    expect(pt.mix.issue('NOT_FOR_GOAL', 'Ouro')).not.toBe(pt.mix.issue('', 'Ouro'));
  });

  it('refuses a review that is not of the amount or the goal it was asked for', async () => {
    let wrong: Partial<MixReview> = { amountUsd: 200 };
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      return json({ status: 'review', review: reviewOf({ ...of(body), ...wrong }) });
    });
    const host = await goalMix();
    await type(host.querySelector('input') as HTMLInputElement, '100');
    await chooseGoal(host);
    await click(find(host, '[data-action="mix-review"]'));
    await settle();
    expect(host.querySelector('[data-ui="mix-review-lines"]')).toBeNull();
    expect(find(host, '[role="alert"]').textContent).toBe(en.mix.failure.unreadable);
    wrong = { goal: 'protect' };
    await click(find(host, '[data-action="mix-review"]'));
    await settle();
    expect(host.querySelector('[data-ui="mix-review-lines"]')).toBeNull();
    expect(find(host, '[role="alert"]').textContent).toBe(en.mix.failure.unreadable);
  });

  it('keeps focus in the editor when a row is removed', async () => {
    const host = await goalMix();
    const remove = [...host.querySelectorAll('[data-ui="weight-editor"] button')].find(
      (button) => button.textContent === en.mix.editor.remove('GLDx'),
    );
    if (!remove) throw new Error('no remove button for the gold row');
    await click(remove as HTMLElement);
    await settle(50);
    // the only row is gone: the way to add one takes focus
    expect(document.activeElement).toBe(
      find(host, '[data-ui="weight-editor"] [data-ui="targets-lines"] ~ div select'),
    );
  });
});

describe('a new goal’s mix, with a weight the person changed', () => {
  it('reviews the weights in the fields and says the person chose them', async () => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body });
      return json({
        status: 'review',
        review: reviewFor(body.allocations, { ...of(body), origin: 'person' }),
      });
    });
    const host = await goalMix();
    await type(host.querySelector('input') as HTMLInputElement, '100');
    await chooseGoal(host);
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
    const lines = find(host, '[data-ui="mix-review-lines"]').textContent ?? '';
    expect(lines).toContain('25%');
    expect(lines).toContain('75%');
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
        return json({
          status: 'review',
          review: reviewFor(body.allocations, { origin: 'person' }),
        });
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

  it('empties a weight that did not read when the unit changes, never giving it another meaning', async () => {
    const host = await showEditor([]);
    await type(inputs(host)[0] as HTMLInputElement, '150');
    const unit = host.querySelector('select') as HTMLSelectElement;
    unit.value = 'bps';
    unit.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(inputs(host)[0]?.value).toBe('');
    expect(find(host, '[data-action="targets-review"]').getAttribute('aria-disabled')).toBe('true');
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
