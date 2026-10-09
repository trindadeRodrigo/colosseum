import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { hideServerErrors } from './errors';
import { OPEN_WRITES, registerLimits, registerOpenWriteLimit } from './limits';
import { logForwardedHops, proxyTrust, trustedHops } from './proxy';

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
    made.get('/gateway', async () => {
      throw Object.assign(
        new Error('HTTP request failed. URL: https://node.example/v2/a-key-in-the-path'),
        { statusCode: 502 },
      );
    });
    made.get('/gone', async () => {
      throw Object.assign(new Error('that was here once'), { statusCode: 410 });
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

  it('hides the message of every 5xx under its own status: a 502 that names a URL, a 503', async () => {
    const made = app();
    const gateway = await made.inject({ url: '/gateway' });
    expect(gateway.statusCode).toBe(502);
    expect(gateway.json()).toEqual({
      statusCode: 502,
      error: 'Bad Gateway',
      message: expect.stringMatching(/^the server failed on this request \(.+\)$/),
    });
    expect(gateway.body).not.toMatch(/node\.example|a-key-in-the-path|URL/);
    const busy = await made.inject({ url: '/busy' });
    expect([busy.statusCode, busy.json().error]).toEqual([503, 'Service Unavailable']);
    expect(busy.body).not.toContain('the node is not answering');
  });

  it('leaves a 4xx as it was: it is the caller’s to read', async () => {
    const made = app();
    const gone = await made.inject({ url: '/gone' });
    expect([gone.statusCode, gone.json().message]).toEqual([410, 'that was here once']);
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

describe('the structurer’s writes outside /v1', () => {
  const limits = {
    windowSeconds: 60,
    caller: { anonymous: 2, signedIn: 9 },
    class: { standard: null, build: null, parse: null },
  };
  const served = () => {
    let clock = 1_000_000;
    const made = Fastify();
    registerOpenWriteLimit(made, { limits, now: () => new Date(clock) });
    made.post('/goals', async () => 'read');
    made.post('/plans/:id/transactions', async () => 'built');
    made.get('/plans', async () => 'listed');
    made.post('/risk/positions/assess', async () => 'assessed');
    const send = (method: 'GET' | 'POST', url: string, remoteAddress = '10.0.0.1') =>
      made.inject({ method, url, remoteAddress });
    return {
      send,
      tick: (ms: number) => {
        clock += ms;
      },
    };
  };

  it('are the six that store a row or sign, and no read', () => {
    expect(OPEN_WRITES).toHaveLength(6);
    expect(OPEN_WRITES.every((route) => route.startsWith('POST /'))).toBe(true);
    expect(OPEN_WRITES.some((route) => /\/v1|\/risk/.test(route))).toBe(false);
  });

  it('share one budget by address, say when to try again, and start over with the window', async () => {
    const { send, tick } = served();
    expect((await send('POST', '/goals')).statusCode).toBe(200);
    expect((await send('POST', '/plans/abc/transactions')).statusCode).toBe(200);
    const over = await send('POST', '/goals');
    expect([over.statusCode, over.headers['retry-after'], over.json()]).toEqual([
      429,
      '60',
      { error: 'too many requests', fix: 'Try again in 60 seconds.' },
    ]);
    // another address has its own
    expect((await send('POST', '/goals', '10.0.0.2')).statusCode).toBe(200);
    tick(60_000);
    expect((await send('POST', '/goals')).statusCode).toBe(200);
  });

  it('count no read and no route of the risk layer, however many are made', async () => {
    const { send } = served();
    for (let i = 0; i < 5; i++) {
      expect((await send('GET', '/plans')).statusCode).toBe(200);
      expect((await send('POST', '/risk/positions/assess')).statusCode).toBe(200);
    }
    expect((await send('POST', '/goals')).statusCode).toBe(200);
  });
});

describe('the number of proxies a host puts in front', () => {
  const logged = () => {
    const lines: string[] = [];
    const made = Fastify({
      logger: { level: 'info', stream: { write: (line: string) => void lines.push(line) } },
    });
    logForwardedHops(made);
    made.get('/x', async () => 'ok');
    const from = (forwarded?: string) =>
      made.inject({ url: '/x', headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });
    const said = () =>
      lines
        .filter((line) => line.includes('forwarded hops seen'))
        .map((line) => JSON.parse(line).msg as string);
    return { from, said, lines };
  };

  it('is logged for each count seen, once, as a count and never an address', async () => {
    const { from, said, lines } = logged();
    await from();
    await from('203.0.113.7, 10.0.0.2');
    await from('203.0.113.8, 10.0.0.2');
    await from('203.0.113.8');
    expect(said().map((line) => line.split(' (')[0])).toEqual([
      'forwarded hops seen: 2',
      'forwarded hops seen: 1',
    ]);
    expect(lines.join('')).not.toMatch(/203\.0\.113|10\.0\.0/);
  });

  it('is not fixed by a caller who writes entries of their own first: the plain request after is logged, and the line says to take the lowest', async () => {
    const { from, said } = logged();
    // the first forwarded request is a caller's, padded with five addresses of its own
    await from('1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4, 5.5.5.5, 203.0.113.7');
    await from('203.0.113.9');
    expect(said()).toEqual([
      'forwarded hops seen: 6 (lowest so far: 6; set TRUST_PROXY_HOPS to the lowest, a caller can add entries)',
      'forwarded hops seen: 1 (lowest so far: 1; set TRUST_PROXY_HOPS to the lowest, a caller can add entries)',
    ]);
  });

  it('stops at a handful of counts, so a caller cannot fill the log', async () => {
    const { from, said } = logged();
    for (let n = 1; n <= 30; n++) await from(Array.from({ length: n }, () => '9.9.9.9').join(', '));
    expect(said()).toHaveLength(8);
  });
});
