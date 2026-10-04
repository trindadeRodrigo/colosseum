import { describe, expect, it } from 'vitest';
import { walletChains } from './chains';
import { checkApi, compareWithApi } from './config-check';
import { buildConfigForTest } from './test/api-config';

// The web reads its networks from NEXT_PUBLIC_ variables and the API from its own. A variable set on
// one side only would leave the wallet signing for a network the API is not on.

const chains = walletChains();

describe('compareWithApi', () => {
  it('finds nothing wrong when both sides are on the test networks', () => {
    expect(compareWithApi(chains, buildConfigForTest({}))).toBeNull();
    // How a chain is run (mock, live) is the API's business; where it is, is what must agree.
    expect(
      compareWithApi(chains, buildConfigForTest({ robinhood: { mode: 'readonly' } })),
    ).toBeNull();
  });

  it('names the chain and the variable when the networks differ', () => {
    const api = buildConfigForTest({ solana: { network: 'mainnet', networkName: 'mainnet-beta' } });
    expect(compareWithApi(chains, api)).toBe(
      'Solana: the API is on mainnet-beta and this app on devnet. Set NEXT_PUBLIC_CHAIN_NETWORK_SOLANA to match CHAIN_NETWORK_SOLANA',
    );
    const web = walletChains({ NEXT_PUBLIC_CHAIN_NETWORK_ROBINHOOD: 'mainnet' });
    expect(compareWithApi(web, buildConfigForTest({}))).toMatch(
      /^Robinhood Chain: the API is on Robinhood Chain testnet and this app on Robinhood Chain\. Set NEXT_PUBLIC_CHAIN_NETWORK_ROBINHOOD/,
    );
  });

  it('a copy of mainnet on the API side never matches: the browser wallet does not sign for one', () => {
    const api = buildConfigForTest({ solana: { network: 'local' } });
    expect(compareWithApi(chains, api)).toMatch(/^Solana: the API is on /);
  });

  it('names the chain when the network agrees and the chain id does not', () => {
    const api = buildConfigForTest({ robinhood: { evmChainId: 4663 } });
    expect(compareWithApi(chains, api)).toBe(
      'Robinhood Chain: the API is on chain id 4663 and this app on 46630',
    );
  });

  it('does not compare a chain the API has switched off', () => {
    const api = buildConfigForTest({
      base: { mode: 'off', provenance: null, network: 'mainnet', evmChainId: 8453 },
    });
    expect(compareWithApi(chains, api)).toBeNull();
    // The same difference on a chain that is on is a problem.
    const on = buildConfigForTest({ base: { mode: 'mock', network: 'mainnet', evmChainId: 8453 } });
    expect(compareWithApi(chains, on)).toMatch(/^Base: /);
  });

  it('refuses an answer it cannot read, and one that leaves a chain out', () => {
    for (const body of [null, {}, { chains: [] }, 'ok', { flags: {}, chains: 'none' }])
      expect(compareWithApi(chains, body)).toBe(
        'the API answered /v1/config in a form this app cannot read',
      );
    const api = buildConfigForTest({});
    const missing = { ...api, chains: api.chains.filter((c) => c.id !== 'solana') };
    expect(compareWithApi(chains, missing)).toBe('Solana: the API does not list this chain');
  });
});

describe('checkApi', () => {
  const API = 'http://localhost:3001';
  const answering = (status: number, body: unknown) => {
    const asked: Array<[string, RequestInit | undefined]> = [];
    const get = (async (url: string, init?: RequestInit) => {
      asked.push([url, init]);
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return { asked, get };
  };

  it('asks GET /v1/config on the API, follows no redirect, and passes when the networks agree', async () => {
    const config = buildConfigForTest({});
    const { asked, get } = answering(200, config);
    // The API's own account of its chains comes back with the answer: how each is run.
    expect(await checkApi(chains, API, get)).toEqual({ ok: true, chains: config.chains });
    expect(config.chains.map((c) => [c.id, c.mode, c.provenance])).toEqual([
      ['solana', 'mock', 'mock'],
      ['robinhood', 'mock', 'mock'],
      ['base', 'off', null],
    ]);
    expect(asked).toEqual([
      ['http://localhost:3001/v1/config', { cache: 'no-store', redirect: 'error' }],
    ]);
  });

  it('reports a difference, and does not ask again for it', async () => {
    const { get } = answering(200, buildConfigForTest({ robinhood: { evmChainId: 4663 } }));
    expect(await checkApi(chains, API, get)).toEqual({
      ok: false,
      problem: 'Robinhood Chain: the API is on chain id 4663 and this app on 46630',
      again: false,
    });
  });

  it('is not ready when the API cannot be reached: it does not fall back to its own table', async () => {
    const problem =
      "the API at localhost:3001 cannot be reached, so its networks cannot be checked against this app's";
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await checkApi(chains, API, down)).toEqual({ ok: false, problem, again: true });
    expect(await checkApi(chains, API, answering(503, {}).get)).toEqual({
      ok: false,
      problem,
      again: true,
    });
    const notJson = (async () =>
      new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    expect(await checkApi(chains, API, notJson)).toEqual({ ok: false, problem, again: true });
  });
});
