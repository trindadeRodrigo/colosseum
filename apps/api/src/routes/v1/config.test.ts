import { ConfigResponse } from '@colosseum/schemas';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import { buildConfig } from './config';
import { registerV1Routes } from './index';

async function get(env: Record<string, string>) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerV1Routes(app, env);
  const res = await app.inject({ method: 'GET', url: '/v1/config' });
  await app.close();
  return res;
}

describe('GET /v1/config', () => {
  it('is served by the app and listed in the OpenAPI document', async () => {
    const app = await buildApp();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/v1/config' });
    expect(res.statusCode).toBe(200);
    expect(ConfigResponse.parse(res.json())).toEqual(res.json());
    const doc = app.swagger() as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain('/v1/config');
    await app.close();
  });

  it('with nothing set: Solana and Robinhood Chain on the mock, Base off, nothing automatic', async () => {
    const body = ConfigResponse.parse((await get({})).json());
    expect(body.flags).toEqual({
      chainMode: { solana: 'mock', robinhood: 'mock', base: 'off' },
      autoFollow: { solana: false, robinhood: false, base: false },
      keeperEnabled: false,
      agentSurface: false,
      // Off: the structurer's server-signing routes are registered only when it is on.
      legacyStructurer: false,
    });
    expect(body.chains.map((c) => [c.id, c.mode, c.network, c.provenance])).toEqual([
      ['solana', 'mock', 'testnet', 'mock'],
      ['robinhood', 'mock', 'testnet', 'mock'],
      ['base', 'off', 'testnet', null],
    ]);
    expect(body.chains.map((c) => c.evmChainId)).toEqual([null, 46630, 84532]);
  });

  it('never labels a chain on the mock as live, whatever network it is set to', async () => {
    const body = ConfigResponse.parse(
      (
        await get({
          CHAIN_NETWORK_SOLANA: 'mainnet',
          CHAIN_NETWORK_BASE: 'mainnet',
          AUTO_FOLLOW_SOLANA: 'on',
        })
      ).json(),
    );
    const [solana, , base] = body.chains;
    expect(solana).toMatchObject({ mode: 'mock', network: 'mainnet', provenance: 'mock' });
    expect(base).toMatchObject({ mode: 'off', network: 'mainnet', provenance: null });
    expect(body.flags.autoFollow.solana).toBe(true);
  });

  it('refuses to start a chain live on a config that cannot run it', async () => {
    await expect(get({ CHAIN_MODE_SOLANA: 'live' })).rejects.toThrow(
      /CHAIN_MODE_SOLANA is live on devnet, but these are not set: CHAIN_ROUTER_SOLANA/,
    );
    await expect(
      get({ CHAIN_MODE_ROBINHOOD: 'readonly', CHAIN_NETWORK_ROBINHOOD: 'mainnet' }),
    ).rejects.toThrow(/contracts\.robinhood\.factory/);
  });

  it('labels a test network as one, and only mainnet as live', () => {
    const address = '0x00000000000000000000000000000000000000aa';
    const deployed = { robinhood: { factory: address, registry: address } };
    const testnet = buildConfig(
      { CHAIN_MODE_ROBINHOOD: 'live', CHAIN_ROUTER_ROBINHOOD: address },
      deployed,
    );
    expect(testnet.chains[1]).toMatchObject({
      mode: 'live',
      network: 'testnet',
      networkName: 'Robinhood Chain testnet',
      provenance: 'sandbox',
    });
    const mainnet = buildConfig(
      { CHAIN_MODE_ROBINHOOD: 'readonly', CHAIN_NETWORK_ROBINHOOD: 'mainnet' },
      deployed,
    );
    expect(mainnet.chains[1]).toMatchObject({
      mode: 'readonly',
      network: 'mainnet',
      evmChainId: 4663,
      provenance: 'live',
    });
  });

  it('returns no secret and no RPC URL, whatever the environment holds', async () => {
    const res = await get({
      SOLANA_RPC_URL: 'https://rpc.example.invalid/?api-key=SECRET-RPC-KEY',
      JUPITER_API_KEY: 'SECRET-JUPITER',
      DATABASE_URL: 'postgres://user:SECRET-DB@db.example.invalid/x',
      CHAIN_NETWORK_SOLANA: 'mainnet',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/SECRET|example\.invalid|postgres|api-key/i);
    const urls = res.body.match(/https?:\/\/[^"]+/g) ?? [];
    // The only links are explorer templates.
    for (const url of urls) expect(url).toContain('/tx/{txId}');
  });

  it('refuses to start on a flag it cannot read', async () => {
    await expect(get({ CHAIN_MODE_SOLANA: 'mainnet' })).rejects.toThrow(/CHAIN_MODE_SOLANA/);
    await expect(get({ CHAIN_MODE_ROBINHOD: 'live' })).rejects.toThrow(/CHAIN_MODE_ROBINHOD/);
    const token = 'abcdefghijkmnopqrstuvwxyzABCDEFG';
    await expect(get({ CHAIN_ROUTER_ROBINHOOD: token })).rejects.toThrow(
      'CHAIN_ROUTER_ROBINHOOD: expected a 0x address',
    );
  });
});
