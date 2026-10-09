// @vitest-environment happy-dom
import type { MixReview } from '@colosseum/schemas';
import { vaultOf } from '@colosseum/sdk';
import { createElement, StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, fire, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
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
import { CHECK_MS, DepositStep, type Purpose } from './DepositStep';

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
const SAID: Purpose = { goal: 'grow', risk: 'medium' };
/** The deposit step as /goal mounts it: the amount is the host's, so another proposal keeps it. */
function Deposit({ said, onChangeMix }: { said: Purpose; onChangeMix: () => void }) {
  const [amountText, setAmountText] = useState('');
  return createElement(DepositStep, {
    chain: 'solana',
    userId,
    allocations: [
      { assetId: 'solana:usdc', weightBps: 6000 },
      { assetId: 'solana:gldx', weightBps: 4000 },
    ],
    said,
    amountText,
    onAmountText: setAmountText,
    provenance: 'sandbox',
    onChangeMix,
    onClose: () => {},
  });
}
const goalMix = (lang: 'en' | 'pt' = 'en', said: Purpose = SAID, onChangeMix = () => {}) =>
  mount(withAccount(lang, createElement(Deposit, { said, onChangeMix })));
const amountBox = (host: HTMLElement) =>
  find<HTMLInputElement>(host, '[data-ui="amount-large"] input');
/** Types the amount and waits for the server's check of it to land. */
const deposit = async (host: HTMLElement, text: string) => {
  await type(amountBox(host), text);
  await settle(CHECK_MS + 50);
};
const toReview = async (host: HTMLElement) => {
  await click(find(host, '[data-action="deposit-review"]'));
  await settle();
};
const openEditor = (host: HTMLElement) => click(find(host, '[data-action="edit-by-hand"]'));
/** What each row of the read-only mix says in its dollars column, by asset. */
const amounts = (host: HTMLElement) =>
  Object.fromEntries(
    [...host.querySelectorAll('[data-ui="mix-lines"] tbody tr')].map((row) => [
      row.getAttribute('data-asset'),
      row.querySelector('[data-ui="mix-line-amount"]')?.textContent,
    ]),
  );

/**
 * What a review echoes of the request it answers: the amount, and the goal and risk it was checked
 * for. One the request left unsaid is the server's, worked out from the mix (DEPOSIT-DERIVE): here
 * always a plan to protect at low risk, named in `fromMix`.
 */
const of = (body: {
  amountUsd: number;
  goal?: MixReview['goal'] | undefined;
  risk?: MixReview['risk'] | null;
}) => {
  const fromMix = [
    ...(body.goal ? [] : (['goal'] as const)),
    ...(body.risk ? [] : (['risk'] as const)),
  ];
  return {
    amountUsd: body.amountUsd,
    goal: body.goal ?? 'protect',
    risk: body.risk ?? 'low',
    ...(fromMix.length ? { fromMix } : {}),
  };
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
  it('takes one amount with the goal the person said, checks, reviews, and stores the plan for the existing buy', async () => {
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
    const host = await goalMix('en', { goal: 'protect', risk: 'low' });
    // no form: nothing to choose from, the goal and risk said as one sentence, the editor closed
    expect(host.querySelectorAll('select')).toHaveLength(0);
    expect(find(host, '[data-ui="deposit-purpose"]').textContent).toContain(
      en.mix.deposit.purpose('protect', 'low'),
    );
    expect(host.querySelectorAll('input')).toHaveLength(1);
    expect(host.querySelector('[data-ui="weight-editor"]')).toBeNull();
    expect(host.textContent).not.toContain(en.mix.editor.unit);
    expect(host.textContent).not.toContain(en.mix.editor.lines(1));
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      en.mix.editor.remove('GLDx'),
    );
    await toReview(host);
    expect(calls).toEqual([]);
    expect(host.textContent).toContain(en.mix.deposit.blocked.amount);
    await deposit(host, '100');
    expect(calls).toHaveLength(1);
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
    // the review the person reads is the check already on the screen: not asked for twice
    await toReview(host);
    expect(calls).toHaveLength(1);
    await click(find(host, '[data-ui="mix-review-warnings"] input[type="checkbox"]'));
    await click(find(host, '[data-action="mix-confirm"]'));
    await settle();
    expect(calls[1]?.body).toMatchObject({
      confirm: true,
      reviewHash: hash,
      acceptedWarnings: ['EXIT_OVER_CAPACITY:solana:gldx'],
      amountUsd: 100,
      goal: 'protect',
      risk: 'low',
    });
    expect(router.push).toHaveBeenCalledWith(`/plan/${proposalId}/buy`);
    expect(localStorage.getItem(`tf-plan:${proposalId}`)).not.toBeNull();
  });

  it('shows each row the dollars the server checked, and a dash until it has', async () => {
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      // figures no arithmetic on the screen would give: only the server's can be what is shown
      const review = reviewFor(body.allocations, of(body));
      return json({
        status: 'review',
        review: {
          ...review,
          lines: review.lines.map((line) => ({
            ...line,
            amountUsd: line.cls === 'cash' ? 61.07 : 38.93,
          })),
        },
      });
    });
    const host = await goalMix();
    expect(amounts(host)).toEqual({
      'solana:gldx': `—${en.mix.deposit.unchecked}`,
      'solana:usdc': `—${en.mix.deposit.unchecked}`,
    });
    expect(find(host, '[data-ui="deposit-check"]').textContent).toBe(en.mix.deposit.needAmount);
    await type(amountBox(host), '100');
    // typed, not yet checked: still no figure
    expect(amounts(host)['solana:gldx']).toBe(`—${en.mix.deposit.unchecked}`);
    expect(find(host, '[data-ui="deposit-check"]').textContent).toBe(en.mix.deposit.checking);
    await settle(CHECK_MS + 50);
    expect(amounts(host)).toEqual({ 'solana:gldx': '$38.93', 'solana:usdc': '$61.07' });
    expect(find(host, '[data-ui="deposit-check"]').textContent).toBe(en.mix.deposit.checked);
    // another amount: the old figures go at once, never shown beside an amount they are not of
    await type(amountBox(host), '250');
    expect(amounts(host)['solana:usdc']).toBe(`—${en.mix.deposit.unchecked}`);
  });

  it('holds the amount to the limits and says which one, without asking the server', async () => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body });
      return json({ status: 'review', review: reviewOf(of(body)) });
    });
    const host = await goalMix();
    const press = () => find(host, '[data-action="deposit-review"]');
    expect(host.textContent).toContain(en.mix.deposit.limits);
    for (const [text, error] of [
      ['9.99', en.mix.deposit.errors.belowMin],
      ['1000000.01', en.mix.deposit.errors.aboveMax],
      ['ten', en.mix.deposit.errors.notAmount],
    ] as const) {
      await deposit(host, text);
      expect(host.textContent).toContain(error);
      expect(amountBox(host).getAttribute('aria-invalid')).toBe('true');
      expect(press().getAttribute('aria-disabled')).toBe('true');
    }
    expect(calls).toEqual([]);
    for (const text of ['10', '1000000']) {
      await deposit(host, text);
      expect(amountBox(host).getAttribute('aria-invalid')).toBeNull();
      expect(press().getAttribute('aria-disabled')).toBeNull();
    }
    expect(calls.map((call) => call.body.amountUsd)).toEqual([10, 1_000_000]);
    // a quick amount types itself, and the press names it
    await click(find(host, '[data-ui="deposit-quick"] li:nth-child(2) button'));
    expect(amountBox(host).value).toBe('500');
    expect(press().textContent).toContain(en.mix.deposit.reviewOf('$500'));
  });

  it('asks nothing it was not told: sends the unsaid goal and risk as not said, and says what the server worked out from the mix', async () => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body });
      return json({ status: 'review', review: reviewOf(of(body)) });
    });
    const host = await goalMix('en', { goal: null, risk: null });
    // no question, no tap, no sentence until the server has read the mix
    expect(host.querySelector('[data-ui="deposit-purpose"]')).toBeNull();
    expect(host.querySelector('[data-ui="deposit-goal"]')).toBeNull();
    expect(host.querySelector('[data-ui="deposit-risk"]')).toBeNull();
    expect(host.querySelectorAll('select')).toHaveLength(0);
    expect(host.querySelectorAll('[aria-pressed]')).toHaveLength(0);
    await deposit(host, '100');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ goal: null, risk: null, confirm: false });
    // the server's goal and risk, said as worked out from the mix, never as the person's
    const worked = `${en.mix.deposit.purpose('protect', 'low')} ${en.mix.deposit.fromMix(true, true)}`;
    expect(find(host, '[data-ui="deposit-purpose"] span').textContent).toBe(worked);
    expect(find(host, '[data-ui="deposit-check"]').textContent).toBe(en.mix.deposit.checked);
    await toReview(host);
    expect(find(host, '[data-ui="mix-review-purpose"]').textContent).toBe(worked);
  });

  it('says what the person said as theirs, and only the rest as worked out from the mix', async () => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body });
      return json({ status: 'review', review: reviewOf(of(body)) });
    });
    const host = await goalMix('en', { goal: 'grow', risk: null });
    expect(find(host, '[data-ui="deposit-purpose"] span').textContent).toBe(
      en.mix.deposit.purpose('grow', null),
    );
    await deposit(host, '100');
    expect(calls[0]?.body).toMatchObject({ goal: 'grow', risk: null });
    expect(find(host, '[data-ui="deposit-purpose"] span').textContent).toBe(
      `${en.mix.deposit.purpose('grow', 'low')} ${en.mix.deposit.fromMix(false, true)}`,
    );
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
    await deposit(host, '100');
    await toReview(host);
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
    await deposit(host, '100');
    await toReview(host);
    await click(box(host));
    expect(find(host, '[data-action="mix-confirm"]').getAttribute('aria-disabled')).toBeNull();
    // back to the deposit, with the amount still there
    await click(buttonNamed(host, en.mix.deposit.backToDeposit));
    expect(amountBox(host).value).toBe('100');
    await openEditor(host);
    await type(find<HTMLInputElement>(host, '[data-ui="targets-lines"] input'), '90');
    await settle(CHECK_MS + 50);
    await toReview(host);
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
    const pt = dictionary('pt');
    const host = await goalMix('pt');
    expect(find(host, '[data-ui="deposit-purpose"]').textContent).toContain(
      pt.mix.deposit.purpose('grow', 'medium'),
    );
    await deposit(host, '100,50');
    expect(calls[0]?.body.amountUsd).toBe(100.5);
    expect(find(host, '[data-action="deposit-review"]').textContent).toMatch(/100,50/);
    await toReview(host);
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
    const host = await goalMix('en', { goal: 'protect', risk: 'low' });
    await deposit(host, '100');
    const said = (find(host, '[data-ui="deposit-refused"]').textContent ?? '').split('\n');
    expect(find(host, '[data-ui="deposit-refused"]').getAttribute('role')).toBe('alert');
    expect(said).toHaveLength(4);
    expect(said[0]).toBe(en.mix.failure.invalid);
    expect(said[1]).toMatch(/gold|GLD/i);
    expect(said[1]).toContain('Take it out, or choose another goal.');
    expect(said[2]).not.toBe(said[1]);
    expect(said[2]).toContain('Take it out, or choose another goal.');
    // and where to do that: the conversation, or the editor
    expect(said[3]).toBe(en.mix.deposit.invalidNext);
    expect(amounts(host)['solana:gldx']).toBe(`—${en.mix.deposit.unchecked}`);
    const pt = dictionary('pt');
    expect(pt.mix.issue('NOT_FOR_GOAL', 'Ouro')).toContain('Ouro');
    expect(pt.mix.issue('NOT_FOR_GOAL', 'Ouro')).not.toBe(pt.mix.issue('', 'Ouro'));
  });

  it('says a check that did not get through, and asks again on the press', async () => {
    let up = false;
    portStore.setApi(async (_url, init) =>
      up
        ? json({ status: 'review', review: reviewOf(of(JSON.parse(String(init?.body ?? '{}')))) })
        : json({}, 502),
    );
    const host = await goalMix();
    await deposit(host, '100');
    expect(find(host, '[data-ui="deposit-refused"]').textContent).toBe(en.mix.failure.unreachable);
    up = true;
    await toReview(host);
    expect(host.querySelector('[data-ui="deposit-refused"]')).toBeNull();
    expect(find(host, '[data-ui="mix-review-lines"]').textContent).toContain('40%');
  });

  it('goes back to the conversation to change the mix, and to change the goal', async () => {
    const back = vi.fn();
    const host = await goalMix('en', SAID, back);
    await click(find(host, '[data-action="change-mix"]'));
    expect(back).toHaveBeenCalledTimes(1);
    await click(find(host, '[data-ui="deposit-purpose"] button'));
    expect(back).toHaveBeenCalledTimes(2);
  });
});

describe('the deposit step, kept honest while things move', () => {
  const accepts = (answer: (body: Record<string, unknown>, n: number) => Promise<Response>) => {
    const calls: Call[] = [];
    portStore.setApi(async (url, init) => {
      if (!url.endsWith('/goal/accept')) return json({}, 404);
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url, body });
      return answer(body, calls.length);
    });
    return calls;
  };
  const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('drops a late answer about an amount that is no longer the one typed', async () => {
    // the check of 100 answers after the check of 250 has
    accepts(async (body) => {
      if (body.amountUsd === 100) await later(400);
      return json({
        status: 'review',
        review: reviewFor(body.allocations as never, of(body as never)),
      });
    });
    const host = await goalMix();
    await type(amountBox(host), '100');
    await settle(CHECK_MS + 20);
    await type(amountBox(host), '250');
    await settle(CHECK_MS + 100);
    const shown = amounts(host);
    await settle(400);
    // the rows are still the newer amount's check, and the review opens at it
    expect(amounts(host)).toEqual(shown);
    expect(find(host, '[data-ui="deposit-check"]').textContent).toBe(en.mix.deposit.checked);
    await toReview(host);
    expect(find(host, '[data-ui="mix-review-total"]').textContent).toContain('$250.00');
  });

  it('locks the amount and the editor while the press is checked', async () => {
    let release: () => void = () => {};
    const calls = accepts(async (body) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return json({ status: 'review', review: reviewOf(of(body as never)) });
    });
    const host = await goalMix('en', { goal: 'grow', risk: null });
    await openEditor(host);
    await type(amountBox(host), '200');
    // pressed before the check of the pause has gone out: the press asks, and the step is held
    await click(find(host, '[data-action="deposit-review"]'));
    expect(amountBox(host).disabled).toBe(true);
    for (const held of [
      amountBox(host).closest('[inert]'),
      find(host, '[data-ui="weight-editor"]').closest('[inert]'),
    ])
      expect(held).not.toBeNull();
    release();
    await settle(CHECK_MS + 50);
    release();
    await settle();
    // the review is of the amount in the field, and says what it was checked for
    expect(calls.every((call) => call.body.amountUsd === 200)).toBe(true);
    expect(find(host, '[data-ui="mix-review-total"]').textContent).toContain('$200.00');
    expect(find(host, '[data-ui="mix-review-purpose"]').textContent).toBe(
      `${en.mix.deposit.purpose('grow', 'low')} ${en.mix.deposit.fromMix(false, true)}`,
    );
  });

  it('refuses a review that is not of the amount, the goal or the risk it was asked for', async () => {
    let wrong: Record<string, unknown> = { amountUsd: 200 };
    accepts(async (body) =>
      json({ status: 'review', review: reviewOf({ ...of(body as never), ...wrong }) }),
    );
    const host = await goalMix();
    await deposit(host, '500');
    expect(find(host, '[data-ui="deposit-refused"]').textContent).toBe(en.mix.failure.unreadable);
    expect(amounts(host)['solana:gldx']).toBe(`—${en.mix.deposit.unchecked}`);
    // a goal or risk the person said, changed by the server, even when it says it worked it out
    for (const over of [
      { goal: 'protect' },
      { risk: 'high' },
      { risk: 'high', fromMix: ['risk'] },
    ]) {
      wrong = over;
      await toReview(host);
      expect(host.querySelector('[data-ui="mix-review-lines"]')).toBeNull();
      expect(find(host, '[data-ui="deposit-refused"]').textContent).toBe(en.mix.failure.unreadable);
    }
  });

  it('refuses a goal or risk the person did not say that the server fills in without saying so', async () => {
    let wrong: Record<string, unknown> = { fromMix: ['risk'] };
    accepts(async (body) =>
      json({ status: 'review', review: reviewOf({ ...of(body as never), ...wrong }) }),
    );
    const host = await goalMix('en', { goal: null, risk: null });
    await deposit(host, '500');
    expect(find(host, '[data-ui="deposit-refused"]').textContent).toBe(en.mix.failure.unreadable);
    expect(host.querySelector('[data-ui="deposit-purpose"]')).toBeNull();
    wrong = { fromMix: undefined };
    await toReview(host);
    expect(host.querySelector('[data-ui="mix-review-lines"]')).toBeNull();
    wrong = {};
    await toReview(host);
    expect(find(host, '[data-ui="mix-review-lines"]').textContent).toContain('40%');
  });

  it('moves focus on purpose: the amount on open, the heading of the review, the press on the way back', async () => {
    accepts(async (body) => json({ status: 'review', review: reviewOf(of(body as never)) }));
    const host = await goalMix();
    expect(document.activeElement).toBe(amountBox(host));
    await deposit(host, '100');
    await toReview(host);
    const heading = find(host, '[data-ui="deposit-review"] h2');
    expect(heading.textContent).toBe(en.mix.review.title);
    expect(document.activeElement).toBe(heading);
    await click(buttonNamed(host, en.mix.deposit.backToDeposit));
    expect(document.activeElement).toBe(find(host, '[data-action="deposit-review"]'));
  });

  it('keeps focus in the editor when a row is removed', async () => {
    accepts(async (body) =>
      json({ status: 'review', review: reviewFor(body.allocations as never, of(body as never)) }),
    );
    const host = await goalMix();
    await openEditor(host);
    await click(buttonNamed(host, en.mix.editor.remove('GLDx')));
    await settle(50);
    // the only row is gone: the way to add one takes focus
    expect(document.activeElement).toBe(find(host, '[data-ui="weight-editor"] select'));
  });

  it('does not call an amount wrong on the first digit, only after a pause or on leaving the field', async () => {
    accepts(async (body) => json({ status: 'review', review: reviewOf(of(body as never)) }));
    const host = await goalMix();
    await type(amountBox(host), '5');
    expect(host.textContent).not.toContain(en.mix.deposit.errors.belowMin);
    expect(amountBox(host).getAttribute('aria-invalid')).toBeNull();
    await fire(amountBox(host), new FocusEvent('focusout', { bubbles: true }));
    expect(host.textContent).toContain(en.mix.deposit.errors.belowMin);
    await type(amountBox(host), '7');
    expect(host.textContent).not.toContain(en.mix.deposit.errors.belowMin);
    await settle(CHECK_MS + 50);
    expect(host.textContent).toContain(en.mix.deposit.errors.belowMin);
  });

  it('says the wallet is checked on the buy screen, and holds the press while a reply is on its way', async () => {
    const host = await mount(
      withAccount(
        'en',
        createElement(DepositStep, {
          chain: 'solana',
          userId,
          allocations: [{ assetId: 'solana:gldx', weightBps: 4000 }],
          said: SAID,
          amountText: '100',
          onAmountText: () => {},
          provenance: 'sandbox',
          onChangeMix: () => {},
          onClose: () => {},
          waiting: true,
        }),
      ),
    );
    expect(host.textContent).toContain(en.mix.deposit.balance);
    const press = find(host, '[data-action="deposit-review"]');
    expect(press.getAttribute('aria-disabled')).toBe('true');
    await click(press);
    expect(host.textContent).toContain(en.mix.deposit.blocked.reply);
  });

  it('keeps the edited mark and the way back while the hand weights do not add up, and shows no stale mix', async () => {
    accepts(async (body) =>
      json({ status: 'review', review: reviewFor(body.allocations as never, of(body as never)) }),
    );
    const host = await goalMix();
    await deposit(host, '100');
    await openEditor(host);
    await type(find<HTMLInputElement>(host, '[data-ui="targets-lines"] input'), '140');
    expect(find(host, '[data-ui="deposit-edited"]').textContent).toBe(en.mix.deposit.edited);
    expect(host.querySelector('[data-action="reset-mix"]')).not.toBeNull();
    // the proposal's 40% is not shown as if it were the mix now
    expect(host.querySelector('[data-ui="mix-lines"]')).toBeNull();
    expect(find(host, '[data-ui="deposit-broken"]').textContent).toBe(en.mix.deposit.brokenMix);
    expect(find(host, '[data-action="deposit-review"]').getAttribute('aria-disabled')).toBe('true');
    await click(find(host, '[data-action="reset-mix"]'));
    expect(host.querySelector('[data-ui="deposit-edited"]')).toBeNull();
    expect(find(host, '[data-ui="mix-lines"]').textContent).toContain('40%');
  });
});

describe('a new goal’s mix, with a weight the person changed', () => {
  it('keeps the editor closed until asked, marks the mix as edited, and sends the person’s weights', async () => {
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
    const open = find(host, '[data-action="edit-by-hand"]');
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[data-ui="targets-lines"]')).toBeNull();
    expect(host.querySelector('[data-ui="deposit-edited"]')).toBeNull();
    await deposit(host, '100');
    expect(calls[0]?.body.origin).toBe('model');
    await openEditor(host);
    expect(open.getAttribute('aria-expanded')).toBe('true');
    // tidied: percents only, no count of lines
    expect(host.querySelectorAll('select')).toHaveLength(1);
    expect(host.textContent).not.toContain(en.mix.editor.unit);
    expect(host.textContent).not.toContain(en.mix.editor.lines(1));
    const weight = find<HTMLInputElement>(host, '[data-ui="targets-lines"] input');
    expect(weight.value).toBe('40');
    // a weight that does not read holds the review back
    await type(weight, '140');
    expect(find(host, '[data-action="deposit-review"]').getAttribute('aria-disabled')).toBe('true');
    await type(weight, '25');
    await settle(CHECK_MS + 50);
    expect(find(host, '[data-ui="deposit-edited"]').textContent).toBe(en.mix.deposit.edited);
    expect(calls.at(-1)?.body).toMatchObject({
      origin: 'person',
      confirm: false,
      allocations: [
        { assetId: 'solana:gldx', weightBps: 2500 },
        { assetId: 'solana:usdc', weightBps: 7500 },
      ],
    });
    // the read-only rows are the edited mix, with the server's dollars for it
    expect(find(host, '[data-ui="mix-lines"]').textContent).toContain('25%');
    expect(amounts(host)).toEqual({ 'solana:gldx': '$25.00', 'solana:usdc': '$75.00' });
    await toReview(host);
    const lines = find(host, '[data-ui="mix-review-lines"]').textContent ?? '';
    expect(lines).toContain('25%');
    expect(lines).toContain('75%');
    // back, and back to the proposed weights: the mix is the conversation's again
    await click(buttonNamed(host, en.mix.deposit.backToDeposit));
    await click(find(host, '[data-action="reset-mix"]'));
    await settle(CHECK_MS + 50);
    expect(host.querySelector('[data-ui="deposit-edited"]')).toBeNull();
    expect(calls.at(-1)?.body).toMatchObject({ origin: 'model' });
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
