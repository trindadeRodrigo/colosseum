import { describe, expect, it, vi } from 'vitest';
import { pinState } from '../../components/ui/provenance';
import { json } from '../wallet/test/fake-port';
import { dollars, drift, share, tokens, utc } from './figures';
import {
  assetName,
  PORTFOLIO_PATH,
  positionValueSource,
  readPortfolio,
  unpriced,
  vaultValueSource,
  worst,
} from './portfolio';
import { chainOf, portfolioBody, price, READ_AT, vault } from './test/portfolio';

// Reading the person's vaults, GET /v1/portfolio, and what each figure's pin is handed. The API is a
// double that answers the way apps/api/src/routes/v1/portfolio.ts and its error handler do.

const answering = (res: Response | Error) =>
  vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  });

describe('reading the portfolio', () => {
  it('asks the one route, and hands back the chain it answered for', async () => {
    const api = answering(json(portfolioBody()));
    const outcome = await readPortfolio(api, 'solana');
    expect(api).toHaveBeenCalledWith(PORTFOLIO_PATH);
    expect(outcome.kind).toBe('read');
    if (outcome.kind === 'read') expect(outcome.chain.vaults[0]?.address).toBe(vault().address);
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

  it('shows nothing for another chain than the person’s, nor for two chains (ONE-CHAIN)', async () => {
    const other = chainOf([vault({ chain: 'robinhood' })], { chain: 'robinhood' });
    const evmVault = { ...portfolioBody(), chains: [other] };
    // the answer is for Robinhood Chain; the person's plan lives on Solana
    expect((await readPortfolio(answering(json(evmVault)), 'solana')).kind).toBe('unreadable');
    const both = { ...portfolioBody(), chains: [chainOf(), other] };
    expect((await readPortfolio(answering(json(both)), 'solana')).kind).toBe('unreadable');
    // a vault of another chain inside the person's chain
    const mixed = { ...portfolioBody(), chains: [chainOf([vault(), vault({ chain: 'base' })])] };
    expect((await readPortfolio(answering(json(mixed)), 'solana')).kind).toBe('unreadable');
    // the bite: the same answer for the person's own chain is read
    expect((await readPortfolio(answering(json(evmVault)), 'robinhood')).kind).toBe('read');
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

  it('as shares and drifts with two decimals, and a true minus', () => {
    expect(share('en', 6346)).toBe('63.46%');
    expect(drift('en', 346)).toBe('+3.46%');
    expect(drift('en', -250)).toBe('−2.50%');
    expect(drift('en', -250)).not.toContain('-');
    expect(drift('en', 0)).toBe('0.00%');
    expect(drift('pt', -250).replace(/\s/g, ' ')).toBe('−2,50%');
  });

  it('as token amounts, and instants in UTC that say so', () => {
    expect(tokens('en', '0.05')).toBe('0.05');
    expect(tokens('pt', '1234.5')).toBe('1.234,5');
    expect(utc('en', READ_AT)).toBe('Oct 5, 2026, 14:00 UTC');
    expect(utc('en', Date.parse(READ_AT) / 1000)).toBe('Oct 5, 2026, 14:00 UTC');
  });

  it('names an asset by the part of its id after the chain', () => {
    expect(assetName('solana:usdy')).toBe('USDY');
    expect(assetName('robinhood:tsla-x')).toBe('TSLA-X');
  });
});
