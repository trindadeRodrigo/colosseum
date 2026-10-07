import { describe, expect, it, vi } from 'vitest';
import { pinState } from '../../components/ui/provenance';
import { dictionary } from '../../i18n';
import { tokenName } from '../order/amounts';
import { displayName, plainNames } from '../order/plain';
import { json } from '../wallet/test/fake-port';
import { dollars, drift, share, shareExact, sharesOf, tokens, utc } from './figures';
import {
  addDecimals,
  chainTotal,
  holdingsOf,
  PORTFOLIO_PATH,
  positionValueSource,
  readPortfolio,
  unpriced,
  vaultValueSource,
  worst,
} from './portfolio';
import {
  chainOf,
  portfolioBody,
  portfolioOf,
  price,
  READ_AT,
  robinhoodChain,
  SECOND_VAULT,
  vault,
} from './test/portfolio';

// Reading the person's vaults, GET /v1/portfolio, and what each figure's pin is handed. The API is a
// double that answers the way apps/api/src/routes/v1/portfolio.ts and its error handler do.

const answering = (res: Response | Error) =>
  vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  });

const en = dictionary('en');

describe('reading the portfolio', () => {
  it('asks the one route, and hands back the chain it answered for', async () => {
    const api = answering(json(portfolioBody()));
    const outcome = await readPortfolio(api, 'solana');
    expect(api).toHaveBeenCalledWith(PORTFOLIO_PATH);
    expect(outcome.kind).toBe('read');
    if (outcome.kind === 'read') expect(outcome.chains[0].vaults[0]?.address).toBe(vault().address);
  });

  it.each([
    [json({ message: 'Route GET:/v1/portfolio not found' }, 404), 'unavailable'],
    [json({}, 405), 'unavailable'],
    [json({}, 501), 'unavailable'],
    [json({ error: 'slow down' }, 429), 'busy'],
    [json({ error: 'sign in first' }, 401), 'signed-out'],
    [json({ error: 'no identity token was sent' }, 401), 'no-identity'],
    [json({ error: 'forbidden' }, 403), 'signed-out'],
    [
      json({ error: 'Solana is switched off on this server', code: 'CHAIN_UNAVAILABLE' }, 503),
      'chain-down',
    ],
    [
      json(
        { error: 'pick the chain your plans live on first', details: { retryable: false } },
        409,
      ),
      'no-chain',
    ],
    [
      json(
        { error: 'the chain refused', details: { chainCode: 'BadInput', retryable: false } },
        409,
      ),
      'chain-down',
    ],
    [json({ error: 'boom' }, 500), 'unreachable'],
    [new TypeError('fetch failed'), 'unreachable'],
  ] as const)('says what the answer was: %#', async (res, kind) => {
    expect((await readPortfolio(answering(res), 'solana')).kind).toBe(kind);
  });

  it('shows nothing that is not a portfolio in the frozen shape', async () => {
    const body = portfolioBody();
    const broken = {
      ...body,
      chains: [{ ...body.chains[0], vaults: [{ ...vault(), valueUsd: 'a lot' }] }],
    };
    for (const answer of [null, 'text', {}, { chains: 'none' }, broken])
      expect((await readPortfolio(answering(json(answer)), 'solana')).kind).toBe('unreadable');
  });

  it('shows the chains that were read when the current one was not, and says where the current one stands', async () => {
    const other = chainOf([vault({ chain: 'robinhood' })], { chain: 'robinhood' });
    const evmVault = { ...portfolioBody(), chains: [other] };
    // the answer is for Robinhood Chain alone; the person's current chain is Solana, not held here
    expect(await readPortfolio(answering(json(evmVault)), 'solana')).toEqual({
      kind: 'read',
      chains: [other],
      unavailable: [],
      current: 'not-held',
    });
    // Solana could not be read this time: Robinhood Chain is shown, and Solana is said to be out
    const out = {
      chain: 'solana',
      name: 'Solana',
      code: 'CHAIN_UNAVAILABLE',
      error: 'the node did not answer',
      retryable: true,
    };
    expect(
      await readPortfolio(answering(json({ ...evmVault, unavailable: [out] })), 'solana'),
    ).toMatchObject({ kind: 'read', chains: [other], unavailable: [out], current: 'unavailable' });
    // the current chain read, another out: the current first, the other said
    const both = {
      ...portfolioBody(),
      unavailable: [{ ...out, chain: 'robinhood', name: 'Robinhood Chain' }],
    };
    expect(await readPortfolio(answering(json(both)), 'solana')).toMatchObject({
      kind: 'read',
      current: 'read',
      unavailable: [{ chain: 'robinhood' }],
    });
    // a chain both read and out is not an answer
    expect(
      (await readPortfolio(answering(json({ ...portfolioBody(), unavailable: [out] })), 'solana'))
        .kind,
    ).toBe('unreadable');
  });

  it('shows nothing with a chain twice, nor a vault filed under another chain', async () => {
    const other = chainOf([vault({ chain: 'robinhood' })], { chain: 'robinhood' });
    const evmVault = { ...portfolioBody(), chains: [other] };
    // Solana twice
    const twice = { ...portfolioBody(), chains: [chainOf(), chainOf()] };
    expect((await readPortfolio(answering(json(twice)), 'solana')).kind).toBe('unreadable');
    // a vault of another chain inside the person's chain
    const mixed = { ...portfolioBody(), chains: [chainOf([vault(), vault({ chain: 'base' })])] };
    expect((await readPortfolio(answering(json(mixed)), 'solana')).kind).toBe('unreadable');
    // a Solana vault filed under Robinhood Chain, beside the person's own chain
    const misfiled = {
      ...portfolioBody(),
      chains: [chainOf(), chainOf([vault()], { chain: 'robinhood' })],
    };
    expect((await readPortfolio(answering(json(misfiled)), 'solana')).kind).toBe('unreadable');
    // the same answer for the person's own chain is read as theirs
    expect(await readPortfolio(answering(json(evmVault)), 'robinhood')).toMatchObject({
      kind: 'read',
      current: 'read',
    });
  });

  it('reads vaults on two chains, each under its own chain, the person’s first', async () => {
    const outcome = await readPortfolio(
      answering(json(portfolioOf(robinhoodChain(), chainOf()))),
      'solana',
    );
    expect(outcome.kind).toBe('read');
    if (outcome.kind === 'read')
      expect(outcome.chains.map((entry) => entry.chain)).toEqual(['solana', 'robinhood']);
  });
});

describe('a chain’s total', () => {
  it('adds decimal strings exactly, never through a float', () => {
    expect(addDecimals(['1040', '20.5'])).toBe('1060.5');
    expect(addDecimals(['0.1', '0.2'])).toBe('0.3');
    expect(addDecimals(['0.05', '0.95'])).toBe('1');
    expect(addDecimals(['12345678901234567890.01', '1'])).toBe('12345678901234567891.01');
    expect(addDecimals([])).toBe('0');
  });

  it('is its vaults’ values added, with a pin on every source and the label that is not live', () => {
    const entry = chainOf([
      vault(),
      vault({ address: SECOND_VAULT, valueUsd: '20.5', provenance: 'mock' }),
    ]);
    const total = chainTotal(entry, 'their sum', 'the vaults added');
    expect(total.valueUsd).toBe('1060.5');
    expect(total.obs.method).toBe('the vaults added');
    expect(total.obs.provenance).toBe('mock');
    expect(total.obs.source).toBe('Pyth Hermes');
  });
});

describe('the pin of a value', () => {
  const method = (m: string) => `${m}; times the amount`;

  it('is never live when the vault or the price is not', () => {
    expect(worst('live', 'live')).toBe('live');
    expect(worst('live', 'sandbox')).toBe('sandbox');
    expect(worst('sandbox', 'live')).toBe('sandbox');
    expect(worst('sandbox', 'sandbox')).toBe('sandbox');
    expect(worst('sandbox', 'mock')).toBe('mock');
    expect(worst('fixture', 'sandbox')).toBe('mock');
    const liveVault = vault({ provenance: 'live' });
    const mockPrice = price('solana:usdy', '1.1', { provenance: 'mock' });
    expect(positionValueSource(liveVault, mockPrice, method).provenance).toBe('mock');
    expect(pinState(positionValueSource(liveVault, mockPrice, method))).toBe('mock');
    const livePrice = price('solana:usdy', '1.1', { provenance: 'live' });
    expect(pinState(positionValueSource(liveVault, livePrice, method))).toBe('live');
    expect(pinState(positionValueSource(vault(), livePrice, method))).toBe('mock');
  });

  it('of a holding: its price’s source and time, the price’s method and how the value was made', () => {
    const p = price('solana:usdy', '1.1');
    expect(positionValueSource(vault(), p, method)).toEqual({
      source: p.source,
      fetchedAt: p.fetchedAt,
      method: `${p.method}; times the amount`,
      provenance: 'sandbox',
      staleAgeSec: null,
    });
  });

  it('is stale only when the API’s price says so, with the price’s own age', () => {
    const old = price('solana:usdy', '1.1', { ageSeconds: 900, maxAgeSeconds: 120 });
    expect(positionValueSource(vault(), old, method).staleAgeSec).toBe(900);
    const fresh = price('solana:usdy', '1.1', { ageSeconds: 120, maxAgeSeconds: 120 });
    expect(positionValueSource(vault(), fresh, method).staleAgeSec).toBeNull();
  });

  it('of a vault: every price it stands on, the oldest time of them and the read, the stalest age', () => {
    const chain = chainOf(undefined, {
      prices: [
        price('solana:usdy', '1.1', { fetchedAt: '2026-10-05T13:50:00Z' }),
        price('solana:paxg', '2600', {
          source: 'Scope',
          ageSeconds: 600,
          maxAgeSeconds: 300,
          provenance: 'mock',
        }),
      ],
    });
    const pin = vaultValueSource(chain, vault(), 'the method');
    expect(pin).toEqual({
      source: 'Pyth Hermes + Scope',
      fetchedAt: '2026-10-05T13:50:00Z',
      method: 'the method',
      provenance: 'mock',
      staleAgeSec: 600,
    });
  });

  it('of a vault of cash alone: the chain’s read, at the time of the read', () => {
    const chain = chainOf([vault({ positions: [], valueUsd: '250' })]);
    const pin = vaultValueSource(chain, vault({ positions: [], valueUsd: '250' }), 'm');
    expect(pin).toEqual({
      source: chain.name,
      fetchedAt: READ_AT,
      method: 'm',
      provenance: 'sandbox',
      staleAgeSec: null,
    });
  });

  it('of a vault leaves out a holding with no price, and the screen can count it', () => {
    const v = vault();
    const [usdy, paxg] = v.positions;
    if (!usdy || !paxg) throw new Error('fixture');
    const withOneUnpriced = vault({ positions: [usdy, { ...paxg, valueUsd: null }] });
    const chain = chainOf(undefined, {
      prices: [price('solana:usdy', '1.1'), price('solana:paxg', '2600', { source: 'Scope' })],
    });
    expect(vaultValueSource(chain, withOneUnpriced, 'm').source).toBe('Pyth Hermes');
    expect(unpriced(withOneUnpriced)).toBe(1);
    expect(unpriced(v)).toBe(0);
  });
});

describe('how the figures are written', () => {
  it('in dollars, in both languages', () => {
    expect(dollars('en', '1040')).toBe('$1,040.00');
    expect(dollars('pt', '1040').replace(/\s/g, ' ')).toBe('US$ 1.040,00');
  });

  it('as shares and differences with one decimal at most, and a true minus', () => {
    expect(share('en', 6346)).toBe('63.5%');
    // a plan's round share is said round: 24.99% beside 25.00% read as noise
    expect(share('en', 2500)).toBe('25%');
    expect(share('en', 2499)).toBe('25%');
    expect(drift('en', 346)).toBe('+3.5%');
    expect(drift('en', -250)).toBe('−2.5%');
    expect(drift('en', -250)).not.toContain('-');
    expect(drift('en', 0)).toBe('0%');
    expect(drift('pt', -250).replace(/\s/g, ' ')).toBe('−2,5%');
  });

  it('rounds the shares of one whole together, so they add up to it', () => {
    // each rounded alone: 33.4 + 33.4 + 33.3 = 100.1
    expect(sharesOf('en', [3335, 3335, 3330])).toEqual(['33.4%', '33.3%', '33.3%']);
    expect(sharesOf('en', [6346, 1250, 2404])).toEqual(['63.5%', '12.5%', '24%']);
    expect(sharesOf('en', [2499, 7501])).toEqual(['25%', '75%']);
    for (const bps of [
      [3335, 3335, 3330],
      [6346, 1250, 2404],
      [1111, 2222, 3333, 3334],
      [9999, 1],
    ]) {
      const tenths = sharesOf('en', bps).map((s) => Math.round(Number.parseFloat(s) * 10));
      expect(
        tenths.reduce((a, b) => a + b, 0),
        String(bps),
      ).toBe(1000);
    }
    // a vault with nothing in it has no whole to add up to
    expect(sharesOf('en', [0, 0])).toEqual(['0%', '0%']);
    expect(shareExact('en', 12)).toBe('0.12%');
  });

  it('counts cash among what a vault holds, so the shares add up to the whole', () => {
    const rows = holdingsOf(vault());
    expect(rows.map((row) => [row.asset, row.weightBps, row.targetBps, row.driftBps])).toEqual([
      ['solana:usdy', 6346, 6000, 346],
      ['solana:paxg', 1250, 1500, -250],
      ['solana:usdc', 2404, 2500, -96],
    ]);
    expect(rows.reduce((sum, row) => sum + row.weightBps, 0)).toBe(10_000);
    expect(rows.reduce((sum, row) => sum + row.targetBps, 0)).toBe(10_000);
    expect(rows.at(-1)).toMatchObject({ cash: true, valueUsd: vault().cash.display });
    // a vault with nothing in it has no share to give its cash, and cash is never counted twice
    expect(holdingsOf(vault({ positions: [], valueUsd: '0' })).at(-1)?.weightBps).toBe(0);
    const [usdy] = vault().positions;
    if (!usdy) throw new Error('fixture');
    const cashHeld = vault({ positions: [{ ...usdy, asset: vault().cash.asset }] });
    expect(holdingsOf(cashHeld)).toHaveLength(1);
  });

  it('as token amounts, and instants in UTC that say so', () => {
    expect(tokens('en', '0.05')).toBe('0.05');
    expect(tokens('pt', '1234.5')).toBe('1.234,5');
    expect(utc('en', READ_AT)).toBe('Oct 5, 2026, 14:00 UTC');
    expect(utc('en', Date.parse(READ_AT) / 1000)).toBe('Oct 5, 2026, 14:00 UTC');
  });

  it('names a token one way on every screen, and a test token by the token it stands in for', () => {
    expect(tokenName('solana:usdy')).toBe('USDY');
    expect(tokenName('robinhood:tsla-x')).toBe('TSLA-X');
    // Robinhood Chain's dollar is tUSDG, on the mock too, where its id says usdc
    expect(tokenName('robinhood:usdc')).toBe('tUSDG');
    expect(tokenName('robinhood:tusdg')).toBe('tUSDG');
    expect(tokenName('solana:usdc')).toBe('USDC');
    // the flow audit, finding 13: syrupUSDC / tsyrupUSDC / SYRUPUSDC, USDC / tUSDC, SPY / TSPY
    for (const id of ['solana:syrupusdc', 'solana:tsyrupusdc', 'solana:SYRUPUSDC'])
      expect(tokenName(id)).toBe('syrupUSDC');
    expect(tokenName('solana:tusdc')).toBe('USDC');
    expect(tokenName('robinhood:tspy')).toBe('SPY');
    expect(tokenName('robinhood:tgld')).toBe('GLD');
    expect(tokenName('solana:tsla')).toBe('TSLA');
    expect(tokenName('solana:tslax')).toBe('TSLAx');
    // the label of a row is the same name, with who issues it, and cash as cash
    expect(displayName('solana:tsyrupusdc', en.plan)).toBe('syrupUSDC (Maple)');
    expect(displayName('solana:tusdc', en.plan)).toBe('Cash (USDC)');
    expect(displayName('robinhood:usdc', en.plan)).toBe('Cash (tUSDG)');
    // and a sentence of the engine names them the same way, changing no other word
    expect(plainNames('tsyrupUSDC is left out: tUSDC stays. A meta de tUSDG fica.')).toBe(
      'syrupUSDC is left out: USDC stays. A meta de tUSDG fica.',
    );
  });
});
