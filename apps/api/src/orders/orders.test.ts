import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { mockAddress } from '@colosseum/chain-mock';
import {
  BasketId,
  ChainError,
  type Leg,
  parseChainConfigs,
  parseFlags,
  type VaultState,
} from '@colosseum/schemas';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import {
  AuthError,
  authenticate,
  authFromEnv,
  holds,
  registerAuth,
  rememberFailure,
  walletsFromClaim,
} from '../plugins/auth';
import { registerV1Routes } from '../routes/v1';
import { testIssuer } from '../testing/harness';
import { createChainRegistry } from './chains';
import { Refusal, refusalFromChainError } from './errors';
import { orderStatus } from './legs';
import { basketIdOf } from './prepare';
import { view } from './view';

// The parts of API-1 that need no database. The routes themselves are in routes/v1/orders.test.ts.

const registry = (env: Record<string, string> = {}, seed = 'a') =>
  createChainRegistry(parseFlags(env), parseChainConfigs(env), { seed });

describe('the chain registry', () => {
  it('gives the mock for a chain in mock mode, labelled mock', () => {
    const chains = registry();
    expect(chains.active().map((e) => [e.chain, e.mode, e.provenance, Boolean(e.mock)])).toEqual([
      ['solana', 'mock', 'mock', true],
      ['robinhood', 'mock', 'mock', true],
    ]);
    // Even set to mainnet, a chain on the mock is never labelled live.
    const mainnet = registry({ CHAIN_NETWORK_SOLANA: 'mainnet' });
    expect(mainnet.get('solana').provenance).toBe('mock');
  });

  it('refuses a chain that is off with CHAIN_UNAVAILABLE', () => {
    const chains = registry();
    expect(chains.mode('base')).toBe('off');
    let thrown: unknown;
    try {
      chains.get('base');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Refusal);
    expect((thrown as Refusal).status).toBe(503);
    expect((thrown as Refusal).body()).toMatchObject({
      error: 'Base is switched off on this server',
      code: 'CHAIN_UNAVAILABLE',
    });
  });

  it('stops at start on live or readonly: no adapter is wired, and nothing falls back to the mock', () => {
    const address = '0x00000000000000000000000000000000000000aa';
    const ready = { CHAIN_ROUTER_ROBINHOOD: address };
    for (const mode of ['live', 'readonly'])
      expect(() => registry({ ...ready, CHAIN_MODE_ROBINHOOD: mode })).toThrow(
        `CHAIN_MODE_ROBINHOOD is ${mode}, and the API has no robinhood adapter for that yet`,
      );
  });

  it('never repeats a mock transaction id across restarts: the seed is in every build', async () => {
    const owner = '0x00000000000000000000000000000000000000aa';
    const built = async (seed: string) => {
      const { adapter, mock } = registry({}, seed).get('robinhood');
      const tx = await adapter.buildApprove({ owner, basketId: '1', amountRaw: '1' });
      mock?.fund(owner, { gasRaw: '1000000000000000000' });
      return { hash: tx.messageHash, txId: (await mock?.send(tx))?.txId };
    };
    const [first, again, restarted] = [await built('one'), await built('one'), await built('two')];
    // The same seed gives the same ids, so it is the seed that keeps two runs apart.
    expect(again).toEqual(first);
    expect(restarted.hash).not.toBe(first.hash);
    expect(restarted.txId).not.toBe(first.txId);
  });

  it('keeps the mock clock on the wall clock, so a built transaction goes stale', async () => {
    let now = Date.parse('2026-10-05T15:00:00.000Z');
    const env = {};
    const chains = createChainRegistry(parseFlags(env), parseChainConfigs(env), {
      seed: 'clock',
      now: () => new Date(now),
    });
    const before = chains.get('solana').mock?.now();
    now += 90_000;
    expect((chains.get('solana').mock?.now() ?? 0) - (before ?? 0)).toBe(90);
  });
});

describe('order status', () => {
  const leg = (chain: Leg['chain'], status: Leg['status']) => ({ chain, status }) as Leg;
  const at = (legs: Leg[], late = false) => orderStatus(legs, 1000, late ? 1001 : 999);

  it('follows the legs and the clock', () => {
    expect(at([leg('solana', 'planned'), leg('robinhood', 'built')])).toBe('open');
    expect(at([leg('solana', 'confirmed'), leg('robinhood', 'sent')])).toBe('open');
    expect(at([leg('solana', 'confirmed'), leg('robinhood', 'confirmed')])).toBe('done');
    expect(at([leg('solana', 'confirmed'), leg('robinhood', 'skipped')], true)).toBe('done');
    // One chain done and a failed leg on another.
    expect(at([leg('solana', 'confirmed'), leg('robinhood', 'failed')])).toBe('partial');
    expect(at([leg('solana', 'planned'), leg('robinhood', 'failed')])).toBe('failed');
    expect(at([leg('solana', 'confirmed'), leg('robinhood', 'planned')], true)).toBe('expired');
    // A leg whose transaction never landed is built again while the order is open.
    expect(at([leg('solana', 'expired')])).toBe('open');
  });
});

describe('a chain refusal as the API answers it', () => {
  it('maps the codes that have an order code, and keeps the chain’s own code and retryable', () => {
    const answer = (e: ChainError) => {
      const r = refusalFromChainError(e);
      return [r.status, r.extra.code, r.extra.details];
    };
    const d = (chainCode: string, retryable: boolean) => ({ chainCode, retryable });
    expect(answer(new ChainError('NotFunded', 'x'))).toEqual([
      409,
      'NOT_FUNDED',
      d('NotFunded', false),
    ]);
    expect(answer(new ChainError('NoGas', 'x'))).toEqual([409, 'NOT_FUNDED', d('NoGas', false)]);
    expect(answer(new ChainError('Unavailable', 'x'))).toEqual([
      503,
      'CHAIN_UNAVAILABLE',
      d('Unavailable', true),
    ]);
    expect(answer(new ChainError('MintNotAccepted', 'x'))[1]).toBe('ASSET_NOT_ELIGIBLE');
    expect(answer(new ChainError('NewAssetNeedsOwner', 'x'))[1]).toBe('NEW_ASSET_NEEDS_APPROVAL');
    expect(answer(new ChainError('VersionMismatch', 'x'))[1]).toBe('VERSION_CHANGED');
    expect(answer(new ChainError('CreatorLimit', 'x'))[1]).toBe('CREATOR_LIMIT');
    // No order code fits: the chain's code still reaches the caller.
    expect(answer(new ChainError('ReceivedTooLittle', 'x'))).toEqual([
      409,
      undefined,
      d('ReceivedTooLittle', true),
    ]);
    // An adapter that says retryable for itself is believed.
    expect(answer(new ChainError('VaultExists', 'x', true))[2]).toEqual(d('VaultExists', true));
    expect(answer(new ChainError('Unknown', 'x'))[0]).toBe(500);
  });
});

describe('view: value, weight and drift, until packages/basket has it', () => {
  const holding = (asset: string, raw: string, multiplier: string, display: string) => ({
    asset,
    raw,
    multiplier,
    display,
  });
  const price = (asset: string, usdPerToken: string) => ({
    asset,
    usdPerToken,
    ageSeconds: 0,
    market: 'open' as const,
    source: 'test',
    method: 'test',
    fetchedAt: '2026-10-05T15:00:00.000Z',
    provenance: 'mock' as const,
  });
  const vault = (positions: VaultState['positions'], cashRaw = '0'): VaultState => ({
    chain: 'solana',
    address: '11111111111111111111111111111111',
    owner: '11111111111111111111111111111111',
    basketId: '1',
    recipeOnchainId: null,
    acceptedVersion: 0,
    autoFollow: false,
    keeper: '11111111111111111111111111111111',
    cash: holding('solana:usdc', cashRaw, '1', (Number(cashRaw) / 1e6).toString()),
    positions,
    lossUsedBps: 0,
    observedAt: '2026-10-05T15:00:00.000Z',
    pending: null,
  });

  it('values a holding with no multiplier: the design’s vector', () => {
    // 8 decimals, raw 250,000,000, multiplier 1.02, price 100: display 2.55 and value 250.00.
    const spy = { ...holding('solana:spy', '250000000', '1.02', '2.55'), targetBps: 10_000 };
    const seen = view(vault([{ ...spy, lastKeeperAt: null }]), [price('solana:spy', '100')]);
    expect(seen.valueUsd).toBe('250.00');
    expect(seen.positions[0]).toMatchObject({ valueUsd: '250.00', weightBps: 10_000, driftBps: 0 });
  });

  it('counts cash in the total, and drift as weight minus target', () => {
    const positions = [
      { ...holding('solana:spy', '300000000', '1', '3'), targetBps: 5000, lastKeeperAt: null },
      { ...holding('solana:gold', '50000000', '1', '0.5'), targetBps: 5000, lastKeeperAt: null },
    ];
    const prices = [
      price('solana:spy', '100'),
      price('solana:gold', '200'),
      price('solana:usdc', '1'),
    ];
    const seen = view(vault(positions, '100000000'), prices);
    expect(seen.valueUsd).toBe('500.00');
    expect(seen.positions.map((p) => [p.valueUsd, p.weightBps, p.driftBps])).toEqual([
      ['300.00', 6000, 1000],
      ['100.00', 2000, -3000],
    ]);
  });

  it('gives an asset with no price a null value, never zero dollars', () => {
    const positions = [
      { ...holding('solana:spy', '300000000', '1', '3'), targetBps: 5000, lastKeeperAt: null },
      { ...holding('solana:odd', '5', '1', '0.00000005'), targetBps: 5000, lastKeeperAt: null },
    ];
    const seen = view(vault(positions), [price('solana:spy', '100')]);
    expect(seen.positions.map((p) => [p.valueUsd, p.weightBps])).toEqual([
      ['300.00', 10_000],
      [null, 0],
    ]);
  });
});

describe('a plan’s number onchain', () => {
  it('is a 64-bit number, the same for the same plan and in any letter case', () => {
    const id = '4b1c0f0e-3f8e-4d0e-9d2b-0d7a3a6b1c2d';
    expect(BasketId.parse(basketIdOf(id))).toBe(basketIdOf(id.toUpperCase()));
    expect(basketIdOf(id)).not.toBe(basketIdOf('5b1c0f0e-3f8e-4d0e-9d2b-0d7a3a6b1c2d'));
  });
});

describe('sign-in, without a network', () => {
  it('reads the wallets of an identity token, and nothing that is not a wallet', () => {
    const solana = mockAddress('solana', 'a wallet');
    const linked = [
      { type: 'wallet', address: solana, chain_type: 'solana', wallet_client_type: 'privy' },
      {
        type: 'wallet',
        address: '0xABCDEF0000000000000000000000000000000001',
        chain_type: 'ethereum',
      },
      {
        type: 'wallet',
        address: '0xabcdef0000000000000000000000000000000001',
        chain_type: 'ethereum',
      },
      {
        type: 'wallet',
        address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
        chain_type: 'bitcoin',
      },
      { type: 'wallet', address: 'not-an-address', chain_type: 'solana' },
      { type: 'wallet', address: solana, chain_type: 'ethereum' },
      { type: 'email', address: 'someone@example.invalid' },
      { type: 'smart_wallet', address: '0xabcdef0000000000000000000000000000000002' },
      null,
    ];
    const expected = [
      { family: 'solana', address: solana, kind: 'embedded' },
      { family: 'evm', address: '0xabcdef0000000000000000000000000000000001', kind: 'external' },
    ];
    // Privy sends the claim as a JSON string.
    expect(walletsFromClaim(JSON.stringify(linked))).toEqual(expected);
    expect(walletsFromClaim(linked)).toEqual(expected);
    for (const nothing of [undefined, null, 7, 'not json', '{"type":"wallet"}', {}])
      expect(walletsFromClaim(nothing)).toEqual([]);
  });

  it('trusts no issuer unless an app id is set, and fetches nothing to say so', () => {
    expect(authFromEnv({})).toBeNull();
    expect(authFromEnv({ PRIVY_APP_ID: '  ' })).toBeNull();
    const privy = authFromEnv({ PRIVY_APP_ID: 'app-id-1' });
    expect(privy).toMatchObject({ issuer: 'privy.io', audience: 'app-id-1' });
    // Refused without repeating the value.
    const bad = 'http://keys.example.invalid/jwks.json';
    expect(() => authFromEnv({ PRIVY_APP_ID: 'a', PRIVY_JWKS_URL: bad })).toThrow(
      'PRIVY_JWKS_URL: expected an https URL',
    );
    expect(() => authFromEnv({ PRIVY_APP_ID: 'a b/../c' })).toThrow(
      'PRIVY_APP_ID: expected an app id',
    );
  });

  it('answers 503, not 401, when the issuer’s keys cannot be read', async () => {
    const { issuer, sign } = await testIssuer('unreachable');
    const access = await sign('did:privy:someone', { sid: 'session' });
    const identity = await sign('did:privy:someone', { linked_accounts: '[]' });
    const headers = { authorization: `Bearer ${access}`, 'privy-id-token': identity };
    const keys = () => Promise.reject(new TypeError('fetch failed'));
    const outcome = await authenticate({ ...issuer, keys }, headers, '127.0.0.1').catch(
      (e: unknown) => e,
    );
    expect(outcome).toBeInstanceOf(AuthError);
    expect((outcome as AuthError).status).toBe(503);
    // With the keys in reach, the same headers are a person with no wallet.
    expect(await authenticate(issuer, headers, '127.0.0.1')).toEqual({
      kind: 'user',
      userId: 'did:privy:someone',
      wallets: [],
      ip: '127.0.0.1',
    });
  });

  it('holds each token to its own job, so neither stands in for the other', async () => {
    const { issuer, sign } = await testIssuer('roles');
    const sub = 'did:privy:someone';
    const access = await sign(sub, { sid: 'session' });
    const identity = await sign(sub, { linked_accounts: '[]' });
    const signIn = (bearer: string, id: string) =>
      authenticate(issuer, { authorization: `Bearer ${bearer}`, 'privy-id-token': id }, '::1').then(
        () => 'in',
        (e: unknown) => (e instanceof AuthError ? e.status : e),
      );
    expect(await signIn(access, identity)).toBe('in');
    // The identity token in both places, and the access token in both places.
    expect(await signIn(identity, identity)).toBe(401);
    expect(await signIn(access, access)).toBe(401);
    // A session id that is not one, and a token that claims both jobs.
    expect(await signIn(await sign(sub, { sid: '' }), identity)).toBe(401);
    expect(await signIn(await sign(sub, { sid: 7 }), identity)).toBe(401);
    const both = await sign(sub, { sid: 'session', linked_accounts: '[]' });
    expect(await signIn(both, identity)).toBe(401);
    expect(await signIn(both, both)).toBe(401);
  });

  it('asks an issuer that is down once, not once per caller', async () => {
    let asked = 0;
    let clock = 0;
    const down: Parameters<typeof rememberFailure>[0] = () => {
      asked += 1;
      return Promise.reject(new TypeError('fetch failed'));
    };
    const keys = rememberFailure(down, 15_000, () => clock);
    const ask = () => Promise.resolve(keys({ alg: 'ES256' }, { payload: '', signature: '' }));
    for (let i = 0; i < 10; i++) await expect(ask()).rejects.toThrow('fetch failed');
    expect(asked).toBe(1);
    // After the pause it is asked again, once.
    clock += 15_001;
    for (let i = 0; i < 10; i++) await expect(ask()).rejects.toThrow('fetch failed');
    expect(asked).toBe(2);

    // Through the route: ten requests while the keys are down are ten 503s and one fetch.
    const { issuer, sign } = await testIssuer('down');
    let fetches = 0;
    const app = Fastify();
    registerAuth(app, {
      ...issuer,
      keys: () => {
        fetches += 1;
        return Promise.reject(new TypeError('fetch failed'));
      },
    });
    app.get('/me', { config: { auth: 'user' } }, async () => ({ ok: true }));
    const headers = {
      authorization: `Bearer ${await sign('did:privy:x', { sid: 's' })}`,
      'privy-id-token': await sign('did:privy:x', { linked_accounts: '[]' }),
    };
    for (let i = 0; i < 10; i++)
      expect((await app.inject({ method: 'GET', url: '/me', headers })).statusCode).toBe(503);
    expect(fetches).toBe(1);
    await app.close();
  });

  it('an owner with no address is nobody’s', () => {
    const wallets = [
      { family: 'evm' as const, address: `0x${'ab'.repeat(20)}`, kind: 'embedded' as const },
    ];
    const principal = { kind: 'user' as const, userId: 'x', wallets, ip: '' };
    expect(holds(principal, {})).toBe(false);
    expect(holds(principal, { evm: wallets[0]?.address })).toBe(true);
    expect(holds(principal, { evm: `0x${'cd'.repeat(20)}` })).toBe(false);
  });

  it('closes a route that declares no sign-in rule, unless it is a GET', async () => {
    const app = Fastify();
    registerAuth(app, null);
    app.get('/open', async () => ({ ok: true }));
    app.post('/undeclared', async () => ({ ok: true }));
    app.post('/public', { config: { auth: 'public' } }, async () => ({ ok: true }));
    expect((await app.inject({ method: 'GET', url: '/open' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/public' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/undeclared' })).statusCode).toBe(403);
    await app.close();
  });
});

describe('the /v1 route table', () => {
  const v1Paths = (doc: unknown) =>
    Object.keys((doc as { paths: Record<string, unknown> }).paths)
      .filter((p) => p.startsWith('/v1/'))
      .sort();

  it('is these routes and no others, with the mock ones only while a chain runs on the mock', async () => {
    const app = await buildApp();
    await app.ready();
    expect(v1Paths(app.swagger())).toEqual([
      '/v1/config',
      '/v1/mock/fund',
      '/v1/mock/orders/{id}/legs/{legId}/land',
      '/v1/orders',
      '/v1/orders/{id}',
      '/v1/orders/{id}/legs/{legId}/build',
      '/v1/orders/{id}/legs/{legId}/cancel',
      '/v1/orders/{id}/legs/{legId}/report',
      '/v1/portfolio',
    ]);
    // No route lets a caller through without a token: 503 with no Privy app set, 401 with one.
    const res = await app.inject({ method: 'GET', url: '/v1/portfolio' });
    expect([401, 503]).toContain(res.statusCode);
    await app.close();

    const bare = Fastify();
    bare.setValidatorCompiler(validatorCompiler);
    bare.setSerializerCompiler(serializerCompiler);
    await registerV1Routes(bare, { CHAIN_MODE_SOLANA: 'off', CHAIN_MODE_ROBINHOOD: 'off' });
    await bare.ready();
    const routes = bare.printRoutes({ commonPrefix: false });
    expect(routes).toContain('/v1/orders');
    expect(routes).not.toContain('mock');
    const fund = await bare.inject({ method: 'POST', url: '/v1/mock/fund', payload: {} });
    expect(fund.statusCode).toBe(404);
    await bare.close();
  });
});

describe('no /v1 route can make the server sign', () => {
  const src = resolve(__dirname, '..');
  /** Every file the /v1 route table reaches, and every package those files import. */
  function reach(entry: string) {
    const files = new Set<string>();
    const packages = new Map<string, Set<string>>();
    const visit = (file: string) => {
      if (files.has(file)) return;
      files.add(file);
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1] ?? '';
        if (!spec.startsWith('.')) {
          const at = packages.get(spec) ?? new Set();
          packages.set(spec, at.add(relative(src, file)));
          continue;
        }
        const base = join(dirname(file), spec);
        const target = [`${base}.ts`, join(base, 'index.ts')].find(existsSync);
        if (!target) throw new Error(`cannot follow ${spec} from ${file}`);
        visit(target);
      }
    };
    visit(entry);
    return { files: [...files], packages };
  }

  it('reaches no key, no signer and no chain package that can sign', () => {
    const { files, packages } = reach(join(src, 'routes/v1/index.ts'));
    expect(files.map((f) => relative(src, f)).sort()).toEqual([
      'orders/chains.ts',
      'orders/errors.ts',
      'orders/legs.ts',
      'orders/prepare.ts',
      'orders/store.ts',
      'orders/view.ts',
      'plugins/auth.ts',
      'routes/v1/config.ts',
      'routes/v1/index.ts',
      'routes/v1/mock.ts',
      'routes/v1/orders.ts',
      'routes/v1/portfolio.ts',
    ]);
    // The chain packages hold the signers (chain-solana re-exports sign.ts and wallet.ts): not here.
    expect([...packages.keys()].sort()).toEqual([
      '@colosseum/chain-mock',
      '@colosseum/db',
      '@colosseum/schemas',
      'drizzle-orm',
      'fastify',
      'fastify-type-provider-zod',
      'jose',
      'node:crypto',
      'zod',
    ]);
    // jose is used to verify and nowhere to sign; node:crypto to hash and to make ids.
    expect([...(packages.get('jose') ?? [])]).toEqual(['plugins/auth.ts']);
    for (const file of files) {
      // The code, without its comments.
      const text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const name = relative(src, file);
      expect([
        name,
        /SignJWT|CompactSign|FlattenedSign|GeneralSign|importPKCS8/.test(text),
      ]).toEqual([name, false]);
      expect([
        name,
        /createSign|createPrivateKey|generateKeyPair|privateKey|secretKey/i.test(text),
      ]).toEqual([name, false]);
      expect([name, /process\.env|readFileSync|node:fs|KEYPAIR/.test(text)]).toEqual([name, false]);
    }
  });
});
