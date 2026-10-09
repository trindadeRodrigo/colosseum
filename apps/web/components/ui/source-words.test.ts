import { describe, expect, it } from 'vitest';
import * as order from '../../features/order/test/fixtures';
import * as portfolio from '../../features/portfolio/test/portfolio';
import * as answers from '../../features/portfolio-section/fixtures/answers';
import * as lists from '../../features/portfolio-section/fixtures/lists';
import * as plan from '../../features/portfolio-section/fixtures/plan';
import * as shared from '../../features/shared/test/fixtures';
import * as conversation from '../../features/vault-conversation/test/fixtures';
import * as ui from './fixtures/mock';
import { agoWords, exactTime, limitWords, pieces, sourceWords } from './source-words';

// The table that names a source in plain words (gate TOOLTIP-WORDS). Two lists are held against it:
// every source the web's own fixtures carry, found by walking them, and every source the API, the
// chain packages and the risk layer write, as their code writes it. Each is named, or it is in the
// list of the unnamed below with why. A source nobody listed is not guessed at.

/** Every `source` of a stamp (`source` with a `method`) anywhere in a value. */
function stamps(value: unknown, found = new Set<string>(), seen = new Set<unknown>()): Set<string> {
  if (value === null || typeof value !== 'object' || seen.has(value)) return found;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) stamps(item, found, seen);
    return found;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.source === 'string' && typeof row.method === 'string') found.add(row.source);
  for (const item of Object.values(row)) stamps(item, found, seen);
  return found;
}

const FIXTURES = { shared, lists, answers, plan, order, portfolio, conversation, ui };

/** What the code writes, with a made-up account, network or count where the code puts one. */
const ACCOUNT = 'HSk67BDSrh8486PHxqVgyHMHCbwrnstLbcGfKYdG3q9g';
const OWNER = '2ticePjZZ6e34bNUgUXz7v3uHm3jS8jvV13gesdvKn4f';
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7';
const WRITTEN: ReadonlyArray<readonly [source: string, from: string]> = [
  // packages/chain-solana/src/vault
  [
    `price account ${ACCOUNT} (Scope layout, owner ${OWNER}), entry 484`,
    'the Kamino Scope price feed',
  ],
  [`the price account ${ACCOUNT} at the same moment`, 'the Kamino Scope price feed'],
  ['Solana devnet, read over RPC by the vault reader', 'the vault’s own balances on Solana devnet'],
  [
    'Solana devnet, read over RPC by the vault adapter',
    'the vault’s own balances on Solana devnet',
  ],
  [
    `simulation of the transaction on devnet, vault program ${OWNER}`,
    'a dry run of the transaction on devnet',
  ],
  [`test exchange ${OWNER}, pair ${ACCOUNT}`, 'the test network’s exchange'],
  ['https://api.jup.ag/swap/v1/quote', 'a Jupiter quote'],
  ['klend-sdk getUserVanillaObligation', 'the Kamino lending position, read on chain'],
  ['getTokenAccountsByOwner', 'the wallet’s own balances, read on chain'],
  // packages/chain-evm/src/vault
  [
    `Chainlink feed ${EVM} on Robinhood Chain testnet, as the factory ${EVM} lists it for robinhood:nvda`,
    'the Chainlink price feed on Robinhood Chain testnet',
  ],
  [
    'Robinhood Chain testnet, read over JSON-RPC by the EVM vault reader',
    'the vault’s own balances on Robinhood Chain testnet',
  ],
  [
    'Robinhood Chain testnet, read over JSON-RPC by the EVM vault adapter',
    'the vault’s own balances on Robinhood Chain testnet',
  ],
  [
    `Uniswap v4 Quoter ${EVM} on Robinhood Chain testnet`,
    'a Uniswap quote on Robinhood Chain testnet',
  ],
  [
    `simulation of the call on Robinhood Chain testnet, factory ${EVM}`,
    'a dry run of the transaction on Robinhood Chain testnet',
  ],
  // packages/chain-mock, and the feeds of packages/engine
  ['chain-mock', 'the sample chain'],
  ['Pyth Hermes', 'the Pyth price feed'],
  ['Pyth Hermes + Jupiter', 'Pyth and Jupiter prices'],
  ['Pyth Hermes + Scope', 'Pyth and Kamino Scope prices'],
  ['Scope', 'the Kamino Scope price feed'],
  ['Jupiter', 'Jupiter'],
  [
    'https://api.kamino.finance/kamino-market/7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF/reserves/metrics',
    'Kamino’s own figures for its lending market',
  ],
  [
    'https://yields.llama.fi/pools#747c1d2a-c668-4682-b9f9-296708a3dd90',
    'DefiLlama’s list of pool rates',
  ],
  [
    'https://coins.llama.fi/chart/solana:XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W?span=31&period=1d',
    'DefiLlama’s price history',
  ],
  ['apps/api/src/testing/fixtures/mock-yields.json', 'sample rates'],
  ['offline historical yields', 'sample past rates'],
  ['offline catalog', 'the sample catalog'],
  ['offline catalog fixture', 'the sample catalog'],
  ['offline fact sheet', 'a sample fact sheet'],
  ['offline measured fixture', 'sample measurements'],
  ['offline measured input', 'sample measurements'],
  ['offline reference fixture', 'sample measurements'],
  ['offline analytics fixture', 'sample measurements'],
  ['issuer page', 'the issuer’s own page'],
  ['server registry', 'this app’s list of assets'],
  ['policy input platformFeeBps', 'this app’s fee setting'],
  ['tenonfi API /stats', 'this app’s own counts'],
  // apps/api/src/portfolio
  [
    "the person's confirmed deposits in this app's order record on Solana",
    'confirmed deposits recorded here on Solana',
  ],
  [
    "the person's confirmed deposits in this app's order record on Robinhood Chain",
    'confirmed deposits recorded here on Robinhood Chain',
  ],
  // packages/risk and the risk routes: Bearing's tables
  ['Bearing', 'Bearing’s measurements'],
  ['bearing', 'Bearing’s measurements'],
  [
    'Bearing, from the pools its collectors read each hour',
    'Bearing’s measured exit, from the pools it reads each hour',
  ],
  [
    'vault_snapshots: no snapshot of a vault of yours was found for this answer',
    'this app’s kept readings of your vaults, which hold none yet',
  ],
  ['Bearing test curves', 'Bearing’s test curves'],
  ['risk_depth_curves', 'Bearing’s measured exit'],
  ['risk_depth_curves (GET /risk/assets)', 'Bearing’s measured exit'],
  ['risk_depth_curves (depth-0.4, depth-0.3) of 3 legs', 'Bearing’s measured exit'],
  ['risk_asset_snapshots (last 30 days)', 'Bearing’s hourly measurements of the asset'],
  ['risk_asset_snapshots.ref_mid_usd', 'Bearing’s reference prices'],
  [
    'risk_pool_snapshots (GET /risk/assets/:id/heatmap)',
    'Bearing’s hourly measurements of the pool',
  ],
  ['risk_pool_flow', 'Bearing’s record of trading in the pool'],
  ['risk_pool_flow (24 h window, every regime)', 'Bearing’s record of trading in the pool'],
  ['risk_pool_flow (fixture flow rows)', 'Bearing’s record of trading in the pool'],
  [
    'risk_pools.tvl_usd, read when each pool was registered',
    'the pool’s size when Bearing first recorded it',
  ],
  [
    'risk_pools.tvl_usd (GET /risk/pools), read when each pool was registered',
    'the pool’s size when Bearing first recorded it',
  ],
  ['risk_reference_prices (pool mids; step-11)', 'Bearing’s reference prices'],
  [
    'risk_reference_prices (pool mids): hours priced at the pool mid',
    'the pool’s own mid price, as Bearing recorded it',
  ],
  [
    "risk_lending_positions (4 markets, each market's latest hour)",
    'Bearing’s hourly record of the lending markets',
  ],
  [
    'risk_lending_snapshots (kamino, jupiter_lend)',
    'Bearing’s hourly record of the lending markets',
  ],
  ['risk_events (lp_withdrawal, last 30 days)', 'Bearing’s record of withdrawals from the pool'],
  ['risk_lp_concentration', 'Bearing’s record of who supplies the pool'],
  ['AssetFacts of 3 legs (risk_depth_curves; tier source)', 'Bearing’s measurements of 3 holdings'],
  ['AssetFacts of 1 legs (risk_depth_curves)', 'Bearing’s measurements of 1 holding'],
  ['split snapshot (pnpm risk:split-snapshot)', 'Bearing’s hourly record of each pool’s two sides'],
  ['lite-api.jup.ag/price/v3', 'Jupiter’s price'],
  ['stable_par', 'a dollar stablecoin, counted at one dollar'],
  [
    'tier B of TSLAx on mainnet, applied to the test-network token tTSLA',
    'a liquidity tier standing in for a measurement, taken from TSLAx on mainnet',
  ],
  ['tier source', 'a liquidity tier standing in for a measurement'],
  ['fixtures/risk/curves-synthetic.json', 'sample exit curves'],
  ['fixtures/risk/vault-price-limits.json (docs/vault/DESIGN-VAULT.md)', 'sample price limits'],
  [
    'fixtures/testnet: the test-network stand-in of jlUSDC, typed as jlUSDC is (sandbox)',
    'a test-network stand-in for the asset',
  ],
  // what the API's own tests and the stub hand a figure
  ['sample feed', 'a sample feed'],
  ['sample', 'sample data'],
  ['fixture', 'sample data'],
  ['fixture file', 'sample data'],
  ['fixture rows', 'sample data'],
  ['fixture flow rows', 'sample data'],
  ['fixture exit read', 'a sample exit measurement'],
  ['fixture exit table', 'a sample exit measurement'],
  ['fixture price', 'a sample price'],
  ['MOCK price', 'a sample price'],
  ['test fixture', 'sample data'],
  ['test fixture (MOCK)', 'sample data'],
  ['offline adapter', 'sample data'],
  ['offline exit fixture', 'sample data'],
  ['sample measurements on a test network', 'sample measurements'],
  ['the e2e stub', 'sample data'],
  ['devnet RPC', 'Solana devnet, read directly'],
  ['solana devnet node', 'Solana devnet, read directly'],
  ['Solana devnet', 'Solana devnet, read directly'],
  ['Solana', 'Solana, read directly'],
  ['Robinhood Chain', 'Robinhood Chain, read directly'],
  ['a node of the test network', 'the test network, read directly'],
  ['a test network node', 'the test network, read directly'],
  ['a mainnet node', 'the chain, read directly'],
  ['a price account', 'an on-chain price feed'],
  ['test exchange', 'the test network’s exchange'],
  ['feed of solana:jlusdc', 'the asset’s price feed'],
  ['solana:spyx feed', 'the asset’s price feed'],
  ['the pool’s own rate', 'the pool itself'],
  ['Ondo', 'Ondo'],
];

/**
 * Left unnamed, on purpose. Each opens on "Source details below", and its own words are under
 * Details. A test's placeholder says nothing a person could be told; the rest are sentences already.
 */
const UNNAMED: ReadonlyArray<readonly [source: string, why: string]> = [
  ['a test', 'a placeholder in the API’s tests and the web’s fixtures'],
  ['test', 'a placeholder in the API’s tests'],
  ['s', 'a placeholder in the API’s tests'],
  ['unit', 'a placeholder in the API’s tests'],
  ['a test reading', 'a placeholder in the API’s tests'],
  ['a second reader', 'a placeholder in the API’s tests'],
  ['another reader', 'a placeholder in the API’s tests'],
  ['a second feed', 'a placeholder in the engine’s tests'],
  ['the earlier read', 'a placeholder in the API’s tests'],
  ['the later read', 'a placeholder in the API’s tests'],
  ['snapshots a; snapshots b', 'a placeholder in the API’s tests'],
  [
    'a row made by pipeline.test.ts for the list of addresses',
    'a placeholder in the worker’s tests',
  ],
  ['https://example.com/mock', 'a placeholder in the engine’s tests'],
  ['packages/schemas/src/order-api.test.ts', 'a placeholder in the schemas’ tests'],
];

describe('the table of source names', () => {
  it('names every source the code writes', () => {
    for (const [source, from] of WRITTEN) expect(sourceWords(source), source).toEqual({ from });
  });

  it('names every source in the web’s fixtures, or lists it as left unnamed', () => {
    const unnamed = new Set(UNNAMED.map(([source]) => source));
    const found = [...stamps(FIXTURES)].sort();
    expect(found.length).toBeGreaterThan(10);
    const missing = found.filter(
      (source) => sourceWords(source).from === null && !unnamed.has(source),
    );
    expect(missing).toEqual([]);
  });

  it('leaves a source it does not know unnamed, rather than guess', () => {
    for (const [source] of UNNAMED) expect(sourceWords(source), source).toEqual({ from: null });
    for (const odd of ['', ' ', 'ledger 7 of the back office', 'feed', 'price', 'Bearingish thing'])
      expect(sourceWords(odd).from, odd).toBeNull();
  });

  it('names a test network’s price account as the test network’s, never as Kamino’s', () => {
    const source = `price account ${ACCOUNT} (Scope layout, owner ${OWNER}), entry 484`;
    expect(sourceWords(source, 'sandbox')).toEqual({ from: 'the test network’s price feed' });
    expect(sourceWords(source, 'live').from).toBe('the Kamino Scope price feed');
  });

  it('says whose reading a test token’s price is', () => {
    const source = `price account ${ACCOUNT} (Scope layout, owner ${OWNER}), entry 3 (TSLAx's reading, applied to tTSLA on a test network)`;
    expect(sourceWords(source, 'sandbox')).toEqual({
      from: 'the test network’s price feed, using TSLAx’s price for the test token tTSLA',
    });
  });

  it('names a figure made of several by each part once, and leaves it unnamed if one part is', () => {
    const price = (entry: number) =>
      `price account ${ACCOUNT} (Scope layout, owner ${OWNER}), entry ${entry}`;
    // a vault's value stands on its prices: one feed, said once
    expect(sourceWords(`${price(1)} + ${price(2)}`, 'sandbox')).toEqual({
      from: 'the test network’s price feed',
    });
    expect(sourceWords('risk_depth_curves; split snapshot (pnpm risk:split-snapshot)').from).toBe(
      'Bearing’s measured exit and Bearing’s hourly record of each pool’s two sides',
    );
    expect(sourceWords('Scope; chain-mock; Bearing').from).toBe(
      'the Kamino Scope price feed, the sample chain and Bearing’s measurements',
    );
    expect(sourceWords('Scope; ledger 7').from).toBeNull();
    // a source with a plus in its own name is one source
    expect(sourceWords('Pyth Hermes + Jupiter').from).toBe('Pyth and Jupiter prices');
    expect(
      sourceWords('Solana devnet, read over RPC by the vault reader, on its second node').from,
    ).toBe('the vault’s own balances on Solana devnet');
  });

  it('never calls a sample a feed, and never promises anything', () => {
    for (const [, from] of WRITTEN)
      expect(from).not.toMatch(/guarantee|risk-free|earn|\bmix\b|\bbuy\b/i);
  });
});

describe('how long ago', () => {
  it('says minutes under an hour, hours under two days, then days', () => {
    expect(agoWords(0)).toBe('less than a minute ago');
    expect(agoWords(44)).toBe('less than a minute ago');
    expect(agoWords(60)).toBe('1 minute ago');
    expect(agoWords(120)).toBe('2 minutes ago');
    expect(agoWords(3599)).toBe('60 minutes ago');
    expect(agoWords(3600)).toBe('1 hour ago');
    expect(agoWords(19 * 3600)).toBe('19 hours ago');
    expect(agoWords(3 * 86_400)).toBe('3 days ago');
  });

  it('takes a time ahead of the clock as now, and what is not an age as none', () => {
    expect(agoWords(-30)).toBe('less than a minute ago');
    for (const odd of [Number.NaN, Number.POSITIVE_INFINITY, '60' as never])
      expect(agoWords(odd)).toBeNull();
  });

  it('says it in the words it is handed', () => {
    const pt = {
      now: 'há menos de um minuto',
      ago: 'há {n} {unit}',
      minute: ['minuto', 'minutos'],
      hour: ['hora', 'horas'],
      day: ['dia', 'dias'],
    };
    expect(agoWords(120, pt)).toBe('há 2 minutos');
    expect(agoWords(3600, pt)).toBe('há 1 hora');
  });

  it('says a limit as the feed states it', () => {
    expect(limitWords(120)).toBe('2 minute');
    expect(limitWords(30)).toBe('30 second');
    expect(limitWords(3600)).toBe('1 hour');
    expect(limitWords(0)).toBeNull();
    expect(limitWords(Number.NaN)).toBeNull();
  });

  it('writes the exact time for a person, in UTC', () => {
    expect(exactTime('2026-10-09T18:26:20Z')).toBe('9 Oct 2026, 18:26:20 UTC');
    expect(exactTime('2026-10-09T15:26:20-03:00')).toBe('9 Oct 2026, 18:26:20 UTC');
    expect(exactTime('yesterday')).toBe('yesterday');
  });
});

describe('the addresses in a source', () => {
  it('cuts the words where an address stands, Solana’s and an EVM chain’s', () => {
    const cut = pieces(`price account ${ACCOUNT} (Scope layout, owner ${OWNER}), entry 484`);
    expect(cut.map((piece) => [piece.text, piece.address])).toEqual([
      ['price account ', false],
      [ACCOUNT, true],
      [' (Scope layout, owner ', false],
      [OWNER, true],
      ['), entry 484', false],
    ]);
    expect(pieces(`Chainlink feed ${EVM} on a test network`)[1]).toMatchObject({
      text: EVM,
      address: true,
    });
  });

  it('takes a long word for a word, and plain words for one piece', () => {
    expect(pieces('klend-sdk getUserVanillaObligationOfTheWholeMarketNow')).toHaveLength(1);
    expect(pieces('haircut v2')).toEqual([{ text: 'haircut v2', address: false, at: 0 }]);
    expect(pieces('')).toEqual([]);
  });
});
