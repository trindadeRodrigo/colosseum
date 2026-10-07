// @vitest-environment happy-dom
import { TEST_FUNDS_LOW, TRUST_STATUS } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { EMBEDDED, json, SOLANA, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { BuyScreen } from './BuyScreen';
import { rememberPlan } from './plan-store';
import { PLAN_ID, planOn, USER } from './test/fixtures';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The buy as four steps (Thom, Oct 6), with real events against a double of the API: the amount the
// plan was built for, the funds in one line with the test faucet where the server offers it, the four
// points of the trust notice with the whole notice behind a disclosure, and the review. One step is
// open at a time; the card carries the test network's plate once.

const en = dictionary('en');

type Call = { method: string; path: string; body?: unknown };

/** GET /v1/funding on the test network: nothing held unless `funded`, test funds where `faucet`. */
const funding = (o: { funded: boolean; faucet?: boolean; provenance?: string }) => {
  const provenance = o.provenance ?? 'sandbox';
  const stamp = {
    source: 'devnet RPC',
    fetchedAt: '2026-10-06T12:00:00.000Z',
    method: 'balance',
    provenance,
  };
  return {
    chain: 'solana',
    name: 'Solana',
    mode: provenance === 'mock' ? 'mock' : 'live',
    provenance,
    wallet: SOLANA,
    cash: {
      ...stamp,
      asset: 'solana:usdc',
      symbol: 'USDC',
      decimals: 6,
      haveRaw: o.funded ? '50000000000' : '0',
      needRaw: '40000000000',
      missingRaw: o.funded ? '0' : '40000000000',
    },
    gas: {
      ...stamp,
      symbol: 'SOL',
      decimals: 9,
      haveRaw: o.funded ? '1000000000' : '0',
      needRaw: '10100000',
      missingRaw: o.funded ? '0' : '10100000',
    },
    steps: 3,
    newVault: true,
    ok: o.funded,
    ...(o.faucet ? { testFunds: true } : {}),
  };
};

function api(
  o: {
    funded?: boolean;
    faucet?: boolean;
    provenance?: string;
    /** The answer of POST /v1/testnet/fund. Default: what was sent, and the wallet funded after. */
    fund?: () => Response;
  } = {},
) {
  const calls: Call[] = [];
  const person: Person = {
    userId: USER,
    wallets: EMBEDDED,
    chain: 'solana',
    chainSource: 'picked',
    chainOptions: [],
  };
  let funded = o.funded ?? false;
  portStore.setApi(async (path, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/v1/me') return json(person);
    if (path.startsWith('/v1/funding?'))
      return json(funding({ funded, faucet: o.faucet ?? false, provenance: o.provenance }));
    if (path === '/v1/testnet/fund' && method === 'POST') {
      if (o.fund) return o.fund();
      funded = true;
      return json({
        chain: 'solana',
        provenance: 'sandbox',
        wallet: SOLANA,
        cash: { symbol: 'tUSDC', decimals: 6, raw: '40400000000' },
        gas: { symbol: 'SOL', decimals: 9, raw: '12625000' },
        txIds: ['devnet-signature'],
        left: 2,
      });
    }
    return json({ error: 'not found' }, 404);
  });
  return { calls, to: (prefix: string) => calls.filter((c) => c.path.startsWith(prefix)) };
}

const buy = async () => {
  const host = await mount(withAccount('en', createElement(BuyScreen, { id: PLAN_ID })));
  await settle();
  await settle(350);
  await settle();
  return host;
};

const step = (host: HTMLElement, id: string) =>
  find(host, `[data-ui="buy-step"][data-step="${id}"]`);
const head = (host: HTMLElement, id: string) =>
  find<HTMLButtonElement>(step(host, id), 'h2 button');
const panel = (host: HTMLElement, id: string) =>
  find(host, `#${CSS.escape(head(host, id).getAttribute('aria-controls') ?? '')}`);
const next = (host: HTMLElement, id: string) =>
  find(
    panel(host, id),
    ':scope > div > [data-variant="primary"], :scope > form > [data-variant="primary"]',
  );
const opened = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-ui="buy-step"]')]
    .filter((s) => s.querySelector('h2 button')?.getAttribute('aria-expanded') === 'true')
    .map((s) => s.getAttribute('data-step'));
const button = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.includes(name) && !b.closest('[hidden]'),
  );

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  router.push.mockClear();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
  rememberPlan(planOn());
});
afterEach(unmountAll);

describe('the amount', () => {
  it('starts at the amount the plan was built for, with the limits as a hint', async () => {
    api();
    const host = await buy();
    const input = find<HTMLInputElement>(host, 'input[inputmode="decimal"]');
    expect(planOn().proposal.sheet.amountUsd).toBe(40_000);
    expect(input.value).toBe('40000');
    expect(host.textContent).toContain(en.buy.amount.hint('$40,000'));
    expect(en.buy.amount.hint('$40,000')).toMatch(/\$10 to \$1,000,000/);
  });

  it('holds its Continue while the amount is not one from $10 to $1,000,000', async () => {
    api();
    const host = await buy();
    const input = find<HTMLInputElement>(host, 'input[inputmode="decimal"]');
    await type(input, '5');
    expect(next(host, 'amount').getAttribute('aria-disabled')).toBe('true');
    expect(host.textContent).toContain(en.buy.blocked.amount);
    await click(next(host, 'amount'));
    expect(opened(host)).toEqual(['amount']);
    await type(input, '200');
    expect(next(host, 'amount').getAttribute('aria-disabled')).toBeNull();
  });

  it('reads a lone mark as the page’s language does: three decimals are no amount of money', async () => {
    api();
    const host = await buy();
    const input = find<HTMLInputElement>(host, 'input[inputmode="decimal"]');
    // in English "10.555" is not ten thousand: it is refused, not read as $10,555
    await type(input, '10.555');
    expect(next(host, 'amount').getAttribute('aria-disabled')).toBe('true');
    expect(host.textContent).toContain(en.buy.blocked.amount);
    for (const fine of ['10.55', '10,555', '1,000.5']) {
      await type(input, fine);
      expect(next(host, 'amount').getAttribute('aria-disabled'), fine).toBeNull();
    }
  });

  it('says plainly that the plan was built for another amount when the amount is changed', async () => {
    api();
    const host = await buy();
    expect(host.textContent).not.toContain(en.buy.amount.other('$40,000'));
    await type(find<HTMLInputElement>(host, 'input[inputmode="decimal"]'), '100');
    expect(host.textContent).toContain(en.buy.amount.other('$40,000'));
    expect(host.textContent).not.toContain(en.buy.amount.hint('$40,000'));
  });
});

describe('the steps', () => {
  it('opens one step at a time, marks each done, and moves the focus to the step it opens', async () => {
    api({ funded: true });
    const host = await buy();
    const progress = find(host, 'ol[data-ui="buy-progress"]');
    expect(progress.getAttribute('aria-label')).toBe(en.buy.steps.label);
    expect([...progress.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '1Amount',
      // a funded wallet: the funds are done before the step is opened
      '2Funds, done',
      '3Trust',
      '4Review',
    ]);
    const current = () =>
      progress.querySelector('[aria-current="step"]')?.getAttribute('data-step');
    expect(opened(host)).toEqual(['amount']);
    expect(current()).toBe('amount');
    // the other panels are in the page, hidden
    expect(panel(host, 'funds').hidden).toBe(true);

    await click(next(host, 'amount'));
    expect(opened(host)).toEqual(['funds']);
    expect(current()).toBe('funds');
    expect(document.activeElement).toBe(head(host, 'funds'));
    // the amount is done, and says so in words to a screen reader
    expect(step(host, 'amount').getAttribute('data-done')).toBe('true');
    expect(head(host, 'amount').textContent).toContain(`, ${en.buy.steps.done}`);
    expect(head(host, 'amount').textContent).toContain('$40,000');
    expect(progress.querySelector('[data-step="amount"]')?.textContent).toContain(
      en.buy.steps.done,
    );

    // a funded wallet: the funds are done, and the trust notice is next
    expect(step(host, 'funds').getAttribute('data-done')).toBe('true');
    await click(next(host, 'funds'));
    expect(opened(host)).toEqual(['trust']);
    expect(next(host, 'trust').getAttribute('aria-disabled')).toBe('true');
    await click(find(panel(host, 'trust'), 'input[type="checkbox"]'));
    await click(next(host, 'trust'));
    expect(opened(host)).toEqual(['review']);
    expect(panel(host, 'review').textContent).toContain(
      en.buy.steps.reviewLead('$40,000', 'Solana'),
    );
    const review = find(panel(host, 'review'), '[data-variant="primary"]');
    expect(review.getAttribute('aria-disabled')).toBeNull();

    // any step opens again from its heading, and closes the one that was open
    await click(head(host, 'amount'));
    expect(opened(host)).toEqual(['amount']);
    expect(document.activeElement).toBe(head(host, 'amount'));
  });

  it('holds the funds step until the wallet has what the buy needs', async () => {
    api({ funded: false });
    const host = await buy();
    await click(next(host, 'amount'));
    expect(step(host, 'funds').getAttribute('data-done')).toBe('false');
    expect(next(host, 'funds').getAttribute('aria-disabled')).toBe('true');
    expect(head(host, 'funds').textContent).not.toContain(en.buy.steps.done);
  });

  it('says once, in a quiet line on the card, that its figures are the test network’s, and never MOCK', async () => {
    api({ funded: false });
    const host = await buy();
    const card = find(host, 'section[data-ui="card"]');
    expect(find(card, '[data-ui="data-note"]').textContent).toBe(
      en.buy.steps.note.testNetwork('Solana'),
    );
    expect(host.querySelectorAll('section[data-ui="card"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-ui="mock-plate"], [data-ui="hatch-band"]')).toHaveLength(0);
    expect(host.textContent).not.toMatch(/MOCK/);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('on the mock: says the figures are samples, and its funding button says so in words', async () => {
    portStore.set(signedInPort(EMBEDDED, { userId: USER }, 'mock'));
    api({ funded: false, provenance: 'mock' });
    const host = await buy();
    // the card's hatch band and its one quiet line at the foot (MOCK-QUIET), and no top line
    expect(find(host, '[data-ui="sample-note"]').textContent).toBe(en.shell.mockAnnounce);
    expect(host.querySelector('[data-ui="data-note"]')).toBeNull();
    await click(next(host, 'amount'));
    expect(button(host, en.buy.funding.mockFund)).toBeDefined();
    expect(host.textContent).not.toMatch(/MOCK/);
  });
});

describe('the funds', () => {
  it('says the need in one line, with the details behind a disclosure', async () => {
    api({ funded: false });
    const host = await buy();
    const line = find(host, '[data-ui="funding-line"]');
    expect(line.textContent).toBe(
      `${en.buy.funding.needs('40,000 USDC', '0.0101 SOL')} ${en.buy.funding.haveNone}`,
    );
    const details = find<HTMLDetailsElement>(host, 'details[data-ui="funding-details"]');
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe(en.buy.funding.details);
    expect(details.querySelector('table')).not.toBeNull();
  });

  it('offers test funds where the server can send them, sends for this buy, then reads the wallet again', async () => {
    const server = api({ funded: false, faucet: true });
    const host = await buy();
    await click(next(host, 'amount'));
    const get = button(host, en.buy.funding.testFunds);
    expect(get).toBeDefined();
    // the old instructions give way to the button
    expect(host.textContent).not.toContain(en.buy.funding.short('Solana'));
    expect(host.textContent).toContain(en.buy.funding.testNote);
    const reads = server.to('/v1/funding').length;
    await click(get as HTMLButtonElement);
    await settle();
    await settle();
    expect(server.to('/v1/testnet/fund').map((c) => c.body)).toEqual([
      { proposalId: PLAN_ID, amountUsd: 40000, wallet: SOLANA },
    ]);
    await settle(350);
    await settle();
    expect(server.to('/v1/funding').length).toBeGreaterThan(reads);
    expect(find(host, '[data-ui="test-funds-sent"]').textContent).toBe(
      en.buy.funding.testSent('40,400 USDC and 0.012625 SOL'),
    );
    expect(find(host, '[data-ui="funding-line"]').textContent).toContain(en.buy.funding.ok);
    expect(next(host, 'funds').getAttribute('aria-disabled')).toBeNull();
  });

  it('offers one way to fill the wallet at a time, and names the cash as the plan does', async () => {
    api({ funded: false, faucet: true });
    portStore.set(signedInPort(EMBEDDED, { userId: USER, test: true }, 'mock'));
    const host = await buy();
    await click(next(host, 'amount'));
    expect(button(host, en.buy.funding.testFunds)).toBeDefined();
    expect(button(host, en.buy.funding.mockFund)).toBeUndefined();
    // the source line of the details names the token as every screen does, at the one time format
    const sources = [...find(host, '[data-ui="funding-details"]').querySelectorAll('ul li')].map(
      (li) => li.textContent ?? '',
    );
    expect(sources[0]).toMatch(/^USDC · /);
    expect(sources[0]).toMatch(/[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2} UTC/);
  });

  it('hides the button where the server has no faucet key, and shows the address to fund', async () => {
    api({ funded: false, faucet: false });
    const host = await buy();
    expect(button(host, en.buy.funding.testFunds)).toBeUndefined();
    await click(next(host, 'amount'));
    expect(button(host, en.buy.funding.testFunds)).toBeUndefined();
    expect(host.textContent).toContain(en.buy.funding.short('Solana'));
    expect(host.textContent).toContain(en.buy.funding.address(SOLANA));
  });

  it('never offers test funds on figures that are not the test network’s', async () => {
    api({ funded: false, faucet: true, provenance: 'live' });
    const host = await buy();
    await click(next(host, 'amount'));
    expect(button(host, en.buy.funding.testFunds)).toBeUndefined();
  });

  it('says when the faucet has sent all it may today, and sends nothing more', async () => {
    const server = api({
      funded: false,
      faucet: true,
      fund: () => json({ error: 'x', code: 'RATE_LIMITED' }, 429),
    });
    const host = await buy();
    await click(next(host, 'amount'));
    await click(button(host, en.buy.funding.testFunds) as HTMLButtonElement);
    await settle();
    expect(find(panel(host, 'funds'), '[role="alert"]').textContent).toBe(
      en.buy.funding.testFailure.busy,
    );
    expect(server.to('/v1/testnet/fund')).toHaveLength(1);
    expect(next(host, 'funds').getAttribute('aria-disabled')).toBe('true');
  });

  it('says when the faucet’s float is low, and that the team tops it up', async () => {
    for (const [error, sentence] of [
      [TEST_FUNDS_LOW.cash, en.buy.funding.testFailure.lowCash],
      [TEST_FUNDS_LOW.gas, en.buy.funding.testFailure.lowGas],
    ] as const) {
      api({ funded: false, faucet: true, fund: () => json({ error }, 409) });
      const host = await buy();
      await click(next(host, 'amount'));
      await click(button(host, en.buy.funding.testFunds) as HTMLButtonElement);
      await settle();
      expect(find(panel(host, 'funds'), '[role="alert"]').textContent).toBe(sentence);
      await unmountAll();
    }
  });
});

describe('a notice accepted before', () => {
  it('is not a step again: three steps, and the notice is still there to read at the review', async () => {
    api({ funded: true });
    window.localStorage.setItem(
      `tf-trust:${USER}`,
      JSON.stringify({ textVersion: TRUST_STATUS.textVersion }),
    );
    const host = await buy();
    const progress = find(host, 'ol[data-ui="buy-progress"]');
    expect([...progress.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '1Amount',
      '2Funds, done',
      '3Review',
    ]);
    expect(host.querySelector('[data-ui="buy-step"][data-step="trust"]')).toBeNull();
    await click(next(host, 'amount'));
    await click(next(host, 'funds'));
    expect(opened(host)).toEqual(['review']);
    const kept = find<HTMLDetailsElement>(panel(host, 'review'), '[data-ui="trust-kept"]');
    expect(kept.open).toBe(false);
    expect(kept.textContent).toContain(en.trust.accepted);
    expect(kept.querySelector('input[type="checkbox"]')).toBeNull();
  });
});

describe('the first deposit', () => {
  const reviewButton = (host: HTMLElement) =>
    find(panel(host, 'review'), ':scope > div > [data-variant="primary"]');

  it('cannot reach an order without the notice: the step is there, and the review holds until it is ticked', async () => {
    const server = api({ funded: true });
    const host = await buy();
    expect(step(host, 'trust')).toBeTruthy();
    // the review step can be opened from its heading, and its button still refuses
    await click(head(host, 'review'));
    expect(reviewButton(host).getAttribute('aria-disabled')).toBe('true');
    expect(panel(host, 'review').textContent).toContain(en.buy.blocked.trust);
    await click(reviewButton(host));
    await settle();
    expect(server.to('/v1/orders')).toEqual([]);
    expect(window.localStorage.getItem(`tf-trust:${USER}`)).toBeNull();
    // ticked, it lets go
    await click(head(host, 'trust'));
    await click(find(panel(host, 'trust'), 'input[type="checkbox"]'));
    await click(head(host, 'review'));
    expect(reviewButton(host).getAttribute('aria-disabled')).toBeNull();
  });

  it('asks again where the acceptance is not this person’s, not this text’s, or not in this browser', async () => {
    const stored = (who: string, textVersion: string) =>
      window.localStorage.setItem(`tf-trust:${who}`, JSON.stringify({ textVersion }));
    for (const seed of [
      // another person accepted in this browser
      () => stored('did:privy:someone-else', TRUST_STATUS.textVersion),
      // this person accepted an earlier text
      () => stored(USER, 'an-earlier-text'),
      // a new device: nothing is stored
      () => undefined,
    ]) {
      window.localStorage.clear();
      rememberPlan(planOn());
      seed();
      api({ funded: true });
      const host = await buy();
      expect(step(host, 'trust')).toBeTruthy();
      await click(head(host, 'review'));
      expect(reviewButton(host).getAttribute('aria-disabled')).toBe('true');
      await unmountAll();
    }
  });
});

describe('what you’re trusting', () => {
  it('says in short only what applies to a plan’s own vault, and keeps every item of the notice behind "Read the full list"', async () => {
    api({ funded: true });
    const host = await buy();
    const notice = find(host, '[data-ui="trust-notice"]');
    const short = [...find(notice, '[data-ui="trust-short"]').querySelectorAll('li')].map(
      (li) => li.textContent,
    );
    expect(short).toEqual([
      en.trust.short.unaudited,
      en.trust.short.keys,
      // no keeper line: a plan's vault follows nothing, so the keeper does not trade it
      en.trust.short.issuers,
    ]);
    const full = find<HTMLDetailsElement>(notice, 'details[data-ui="trust-full"]');
    expect(full.open).toBe(false);
    expect(full.querySelector('summary')?.textContent).toBe(en.trust.short.full);
    const items = [...full.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual([
      en.trust.unaudited,
      en.trust.keys,
      en.trust.admin(TRUST_STATUS.admin.solana as string),
      en.trust.keeper('0.75%', '1%'),
      en.trust.issuers,
      en.trust.notUnitedStates,
      en.trust.passkey,
      en.trust.openChecks(TRUST_STATUS.openChecks.map((c) => en.trust.checks[c]).join('; ')),
    ]);
    // and the acceptance, ticked once before the first deposit
    expect(find(notice, 'input[type="checkbox"]').closest('label')?.textContent).toBe(
      en.trust.accept,
    );
  });
});
