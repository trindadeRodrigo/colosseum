import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { hideServerErrors } from './errors';
import { registerLimits } from './limits';
import { proxyTrust, trustedHops } from './proxy';

// What a route outside /v1 answers when it throws, and whose address a request is counted against.

describe('an error nobody meant to send', () => {
  const app = () => {
    const made = Fastify();
    hideServerErrors(made);
    made.get('/db', async () => {
      throw new Error('getaddrinfo ENOTFOUND db.internal.example password=hunter2');
    });
    made.get('/busy', async () => {
      throw Object.assign(new Error('the node is not answering'), { statusCode: 503 });
    });
    made.get('/risk/assets', async () => {
      throw new Error('the risk layer’s own words');
    });
    made.post('/echo', { schema: { body: { type: 'object', required: ['n'] } } }, async () => 'ok');
    return made;
  };

  it('is answered with the request id, never its message', async () => {
    const res = await app().inject({ url: '/db' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: expect.stringMatching(/^the server failed on this request \(.+\)$/),
    });
    expect(res.body).not.toMatch(/ENOTFOUND|hunter2|db\.internal/);
  });

  it('leaves an error with a status of its own as it was', async () => {
    const made = app();
    const busy = await made.inject({ url: '/busy' });
    expect([busy.statusCode, busy.json().message]).toEqual([503, 'the node is not answering']);
    const bad = await made.inject({ method: 'POST', url: '/echo', payload: {} });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain("must have required property 'n'");
    // and the risk layer's routes answer as its own API does
    const risk = await made.inject({ url: '/risk/assets' });
    expect([risk.statusCode, risk.json().message]).toEqual([500, 'the risk layer’s own words']);
  });
});

describe('the proxies in front of the API', () => {
  it('are none unless a deployment says how many', () => {
    expect(trustedHops({})).toBe(0);
    expect(trustedHops({ TRUST_PROXY_HOPS: ' ' })).toBe(0);
    expect(trustedHops({ TRUST_PROXY_HOPS: '0' })).toBe(0);
    expect(trustedHops({ TRUST_PROXY_HOPS: '2' })).toBe(2);
    expect(proxyTrust({})).toBe(false);
    for (const value of ['true', '*', '-1', '1.5', '6', '10.0.0.0/8'])
      expect(() => trustedHops({ TRUST_PROXY_HOPS: value }), value).toThrow(/TRUST_PROXY_HOPS/);
  });

  const limits = {
    windowSeconds: 60,
    caller: { anonymous: 2, signedIn: 2 },
    class: { standard: null, build: null, parse: null },
  };
  const served = async (env: Record<string, string>) => {
    const made = Fastify({ trustProxy: proxyTrust(env) });
    registerLimits(made, { limits });
    made.get('/v1/x', { config: { limit: 'standard' } }, async () => 'ok');
    const from = (forwarded: string) =>
      made
        .inject({ url: '/v1/x', headers: { 'x-forwarded-for': forwarded } })
        .then((res) => res.statusCode);
    return from;
  };

  it('count each caller by the address the last proxy wrote, once one is trusted', async () => {
    const from = await served({ TRUST_PROXY_HOPS: '1' });
    expect([await from('203.0.113.7'), await from('203.0.113.7')]).toEqual([200, 200]);
    expect(await from('203.0.113.7')).toBe(429);
    // another caller has a budget of their own
    expect(await from('203.0.113.8')).toBe(200);
    // and an address the caller wrote in front of the proxy's is not read
    expect(await from('198.51.100.1, 203.0.113.7')).toBe(429);
  });

  it('read past two proxies to the caller, and no further', async () => {
    const from = await served({ TRUST_PROXY_HOPS: '2' });
    // the caller's own claim, then the caller as the first proxy saw it, then that proxy
    expect([
      await from('198.51.100.1, 203.0.113.7, 10.0.0.2'),
      await from('198.51.100.2, 203.0.113.7, 10.0.0.2'),
    ]).toEqual([200, 200]);
    expect(await from('198.51.100.3, 203.0.113.7, 10.0.0.2')).toBe(429);
    expect(await from('198.51.100.3, 203.0.113.8, 10.0.0.2')).toBe(200);
  });

  it('believe no forwarded address when none is trusted: everybody is the connection', async () => {
    const from = await served({});
    expect([await from('203.0.113.7'), await from('203.0.113.8')]).toEqual([200, 200]);
    expect(await from('203.0.113.9')).toBe(429);
  });
});
