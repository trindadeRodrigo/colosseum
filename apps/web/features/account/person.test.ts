import { describe, expect, it, vi } from 'vitest';
import { EMBEDDED, EVM, json, METAMASK, PHANTOM, SOLANA } from '../wallet/test/fake-port';
import {
  fetchPerson,
  HOME_CHAIN,
  localPerson,
  type Person,
  PersonError,
  readPerson,
  storeChain,
} from './person';

// The chain a person's plan lives on is the API's to say and to store: GET /v1/me and PUT /v1/me/chain,
// in the shapes of the branch that adds them (api/orders-real). These run against a double of it.

const UNPICKED: Person = {
  userId: 'did:privy:abc',
  wallets: EMBEDDED,
  chain: null,
  chainSource: null,
  chainOptions: ['solana', 'robinhood'],
};
const PICKED: Person = { ...UNPICKED, chain: 'solana', chainSource: 'picked', chainOptions: [] };

const failed = async (run: Promise<unknown>) => {
  const e = await run.then(
    () => null,
    (error: unknown) => error,
  );
  expect(e).toBeInstanceOf(PersonError);
  return (e as PersonError).kind;
};

describe('reading the API’s answer about a person', () => {
  it('takes the shape of GET /v1/me', () => {
    expect(readPerson(UNPICKED)).toEqual(UNPICKED);
    expect(readPerson(PICKED)).toEqual(PICKED);
    expect(
      readPerson({ ...PICKED, wallets: PHANTOM, chainSource: 'wallet', chain: 'solana' }),
    ).toMatchObject({ chainSource: 'wallet', wallets: PHANTOM });
  });

  it('takes nothing else', () => {
    for (const body of [
      null,
      'ok',
      {},
      { ...UNPICKED, userId: '' },
      { ...UNPICKED, wallets: 'none' },
      { ...UNPICKED, wallets: [{ family: 'solana', address: EVM, kind: 'embedded' }] },
      { ...UNPICKED, chain: 'ethereum' },
      { ...UNPICKED, chainSource: 'guessed' },
      { ...UNPICKED, chainOptions: ['solana', 'polygon'] },
      { ...UNPICKED, chainOptions: undefined },
    ])
      expect(readPerson(body), JSON.stringify(body)).toBeNull();
  });
});

describe('GET /v1/me', () => {
  it('asks the API and hands back who is signed in', async () => {
    const api = vi.fn(async () => json(PICKED));
    expect(await fetchPerson(api)).toEqual(PICKED);
    expect(api).toHaveBeenCalledWith('/v1/me', undefined);
  });

  it('says why when it cannot: not signed in, asked too often, or no answer it can read', async () => {
    expect(await failed(fetchPerson(async () => json({ error: 'sign in' }, 401)))).toBe(
      'signed_out',
    );
    expect(await failed(fetchPerson(async () => json({ error: 'slow down' }, 429)))).toBe('busy');
    // the route is not on this API yet, the API is down, or it answers something else
    expect(await failed(fetchPerson(async () => json({ error: 'not found' }, 404)))).toBe(
      'unreachable',
    );
    expect(await failed(fetchPerson(async () => json({}, 503)))).toBe('unreachable');
    expect(
      await failed(
        fetchPerson(async () => {
          throw new TypeError('fetch failed');
        }),
      ),
    ).toBe('unreachable');
    expect(await failed(fetchPerson(async () => new Response('<html>')))).toBe('unreachable');
    expect(await failed(fetchPerson(async () => json({ userId: 'x' })))).toBe('unreachable');
  });
});

describe('PUT /v1/me/chain', () => {
  it('sends the chain and hands back the person with it', async () => {
    const api = vi.fn(async () => json(PICKED));
    expect(await storeChain(api, 'solana')).toEqual(PICKED);
    expect(api).toHaveBeenCalledWith('/v1/me/chain', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'solana' }),
    });
  });

  it('says no wallet signs on the chain, it is not offered, or it was not stored', async () => {
    const noWallet = json({ error: 'no wallet', code: 'NO_WALLET_FOR_CHAIN' }, 409);
    expect(await failed(storeChain(async () => noWallet, 'solana'))).toBe('no_wallet');
    expect(await failed(storeChain(async () => json({ error: 'not yours' }, 422), 'base'))).toBe(
      'not_offered',
    );
    expect(await failed(storeChain(async () => json({ error: 'sign in' }, 401), 'solana'))).toBe(
      'signed_out',
    );
    expect(await failed(storeChain(async () => json({}, 500), 'solana'))).toBe('unreachable');
  });
});

describe('the throwaway wallet’s person, worked out the way the API does it', () => {
  it('needs a choice for a wallet made in the app, of the chains it holds a wallet for', () => {
    expect(localPerson('test:1', EMBEDDED, null)).toEqual({
      userId: 'test:1',
      wallets: EMBEDDED,
      chain: null,
      chainSource: null,
      chainOptions: ['solana', 'robinhood'],
    });
    // Base cannot be chosen: an EVM wallet means Robinhood Chain while Base is not deployed
    expect(HOME_CHAIN).toEqual({ solana: 'solana', evm: 'robinhood' });
    const solanaOnly = EMBEDDED.filter((w) => w.family === 'solana');
    expect(localPerson('test:1', solanaOnly, null).chainOptions).toEqual(['solana']);
  });

  it('is on the chain of the one outside wallet, which is all it can switch to', () => {
    expect(localPerson('test:1', PHANTOM, null)).toMatchObject({
      chain: 'solana',
      chainSource: 'wallet',
      chainOptions: ['solana'],
    });
    expect(localPerson('test:1', METAMASK, null)).toMatchObject({
      chain: 'robinhood',
      chainSource: 'wallet',
    });
  });

  it('needs a choice with outside wallets of both families, and keeps a choice it can sign on', () => {
    const both = [...PHANTOM, ...METAMASK];
    expect(localPerson('test:1', both, null)).toMatchObject({
      chain: null,
      chainOptions: ['solana', 'robinhood'],
    });
    expect(localPerson('test:1', EMBEDDED, 'robinhood')).toMatchObject({
      chain: 'robinhood',
      chainSource: 'picked',
      chainOptions: ['solana', 'robinhood'],
    });
    // MetaMask alone cannot be on Solana, as the API would refuse it
    expect(localPerson('test:1', METAMASK, 'solana')).toMatchObject({ chain: 'robinhood' });
    expect(SOLANA).toMatch(/^So1/);
  });
});
