import { describe, expect, it } from 'vitest';
import { type ApiFetch, ApiRefusal, createOrderApi, isApiRefusal } from './api';

// The order routes over fetch: the paths, the bodies, and a refusal as the API's own body.

type Sent = { path: string; method?: string; headers?: Record<string, string>; body?: string };

function fakeFetch(answer: { status: number; body: unknown }): { fetch: ApiFetch; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (path, init) => {
      sent.push({ path, ...init });
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: async () => {
          if (answer.body === undefined) throw new Error('no body');
          return answer.body;
        },
      };
    },
  };
}

describe('the order routes over fetch', () => {
  it('calls each route with its method, and sends a body only where there is one', async () => {
    const { fetch, sent } = fakeFetch({ status: 200, body: { id: 'o' } });
    const api = createOrderApi(fetch);
    await api.createOrder({ type: 'settings', vault: `0x${'11'.repeat(20)}`, autoFollow: false });
    await api.getOrder('order 1');
    await api.buildLeg('o', 'l');
    await api.reportLeg('o', 'l', { txId: 't' });
    await api.cancelLeg('o', 'l');
    expect(sent.map((s) => [s.method, s.path, s.body !== undefined])).toEqual([
      ['POST', '/v1/orders', true],
      ['GET', '/v1/orders/order%201', false],
      ['POST', '/v1/orders/o/legs/l/build', false],
      ['POST', '/v1/orders/o/legs/l/report', true],
      ['POST', '/v1/orders/o/legs/l/cancel', false],
    ]);
    // A POST with no body carries no content type.
    expect(sent[2]?.headers).toBeUndefined();
    expect(sent[3]).toMatchObject({
      headers: { 'content-type': 'application/json' },
      body: '{"txId":"t"}',
    });
  });

  it("throws the API's refusal with its status and its body", async () => {
    const body = { error: 'not seen yet', details: { retryable: true } };
    const api = createOrderApi(fakeFetch({ status: 409, body }).fetch);
    const thrown = await api.getOrder('o').catch((e: unknown) => e);
    expect(isApiRefusal(thrown)).toBe(true);
    expect(thrown).toBeInstanceOf(ApiRefusal);
    expect(thrown).toMatchObject({ status: 409, body, message: 'not seen yet' });
    // An answer with no body it can read still says what the status was.
    const bare = createOrderApi(fakeFetch({ status: 502, body: undefined }).fetch);
    expect(await bare.getOrder('o').catch((e: unknown) => e)).toMatchObject({
      status: 502,
      body: { error: 'the API answered 502' },
    });
    expect(isApiRefusal(new Error('network'))).toBe(false);
  });
});
