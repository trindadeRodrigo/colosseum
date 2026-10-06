import type {
  ConfigResponse,
  FamilyResponse,
  IntentRequest,
  OrderDetail,
  PortfolioResponse,
  ShelfResponse,
  VaultResponse,
} from '@colosseum/schemas';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ApiRefusal } from '../executor/api';
import { createTenonfiClient, pathOf } from './client';
import type {
  GetConfigResponse,
  GetIndexesBySlugResponse,
  GetOrdersByIdResponse,
  GetPortfolioResponse,
  GetShelfResponse,
  GetVaultsByChainByAddressResponse,
  PostOrdersBody,
} from './types';

// The client the MCP server reads and writes through: a route by its method and path, its parameters
// put in the path and the query, its body sent as JSON, and a refusal thrown with the API's own words.

type Sent = { path: string; method?: string; headers?: Record<string, string>; body?: string };

function double(answer: { status: number; body: unknown }) {
  const sent: Sent[] = [];
  const client = createTenonfiClient(async (path, init) => {
    sent.push({ path, ...init });
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body,
    };
  });
  return { client, sent };
}

describe('the API client', () => {
  it('puts the path parameters, encoded, and the query into the route', async () => {
    const { client, sent } = double({ status: 200, body: { family: {} } });
    await client.call('GET /v1/indexes/{slug}', {
      params: { slug: 'a b/c' },
      query: { chain: 'solana' },
    });
    await client.call('GET /v1/shelf', {});
    await client.call('GET /v1/shelf', { query: { chain: undefined } });
    expect(sent.map((s) => [s.method, s.path])).toEqual([
      ['GET', '/v1/indexes/a%20b%2Fc?chain=solana'],
      ['GET', '/v1/shelf'],
      ['GET', '/v1/shelf'],
    ]);
    expect(() => pathOf('/v1/baskets/{id}')).toThrow('no value for {id}');
    // no value steps out of its segment: a slash is escaped, and `.` or `..` is refused
    expect(pathOf('/v1/indexes/{slug}', { slug: '../../me' })).toBe('/v1/indexes/..%2F..%2Fme');
    expect(
      new URL(pathOf('/v1/indexes/{slug}', { slug: '../../me' }), 'https://a.test').pathname,
    ).toBe('/v1/indexes/..%2F..%2Fme');
    for (const slug of ['..', '.', ''])
      expect(() => pathOf('/v1/indexes/{slug}', { slug })).toThrow('not a path segment');
  });

  it('sends a body as JSON, and no content type with no body', async () => {
    const { client, sent } = double({ status: 200, body: {} });
    const sheet = { chains: ['solana'] } as never;
    await client.call('POST /v1/baskets/propose', { body: { sheet } });
    await client.call('POST /v1/orders/{id}/legs/{legId}/build', {
      params: { id: 'o', legId: 'l' },
    });
    expect(sent[0]).toEqual({
      path: '/v1/baskets/propose',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sheet }),
    });
    expect(sent[1]).toEqual({ path: '/v1/orders/o/legs/l/build', method: 'POST' });
  });

  it('throws a refusal with the API’s words, and its status when it sent none', async () => {
    const said = { error: 'no plan made from a link has that id', code: undefined };
    const refused = double({ status: 404, body: said });
    await expect(
      refused.client.call('GET /v1/baskets/{id}', { params: { id: 'x' } }),
    ).rejects.toMatchObject({ name: 'ApiRefusal', status: 404, body: said });
    const blank = double({ status: 502, body: null });
    const error = await blank.client.call('GET /v1/config').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRefusal);
    expect((error as ApiRefusal).body).toEqual({ error: 'the API answered 502' });
  });

  it('reads Bearing’s fact sheet of one asset, which is not under /v1', async () => {
    const { client, sent } = double({ status: 200, body: { disclaimer: 'd' } });
    await client.assetRisk('SPYx', 10_000);
    await client.assetRisk('SPYx');
    expect(sent.map((s) => s.path)).toEqual([
      '/risk/facts/assets/SPYx?sizeUsd=10000',
      '/risk/facts/assets/SPYx',
    ]);
  });

  it('types each answer as the shared schema the route answers with', () => {
    expectTypeOf<GetConfigResponse>().toMatchTypeOf<ConfigResponse>();
    expectTypeOf<GetShelfResponse>().toMatchTypeOf<ShelfResponse>();
    expectTypeOf<GetIndexesBySlugResponse>().toMatchTypeOf<FamilyResponse>();
    expectTypeOf<GetPortfolioResponse>().toMatchTypeOf<PortfolioResponse>();
    expectTypeOf<GetVaultsByChainByAddressResponse>().toMatchTypeOf<VaultResponse>();
    expectTypeOf<GetOrdersByIdResponse>().toMatchTypeOf<OrderDetail>();
    expectTypeOf<IntentRequest>().toMatchTypeOf<PostOrdersBody>();
  });
});
