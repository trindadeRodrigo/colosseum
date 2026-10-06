import { createRequire } from 'node:module';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { walletChains } from '../features/wallet/chains';
import { config, proxy } from '../proxy';
import { judgeReported } from '../scripts/check-headers.mjs';
import {
  connectSources,
  DEFAULT_NODES,
  makeNonce,
  REPORT_ONLY,
  reportOnlyPolicy,
  sourceOf,
} from './content-policy';

const { pathToRegexp } = createRequire(import.meta.url)('next/dist/compiled/path-to-regexp') as {
  pathToRegexp: (source: string) => RegExp;
};

// The policy a browser only reports on: what it names, and that nothing in it is enforced.

const directive = (policy: string, name: string) =>
  policy
    .split('; ')
    .find((d) => d.startsWith(`${name} `))
    ?.split(' ')
    .slice(1) ?? [];

describe('the policy the browser only reports on', () => {
  const env = {
    api: 'https://api.tenonfi.example/v1/ignored',
    riskApi: 'https://risk.tenonfi.example',
    nodes: ['https://node.example/?api-key=not-a-real-key', undefined, 'javascript:alert(1)'],
  };

  it('lets scripts run by the request’s nonce and what they load, and never inline or by eval', () => {
    const scripts = directive(reportOnlyPolicy('abc', env), 'script-src');
    expect(scripts).toEqual([
      "'self'",
      "'nonce-abc'",
      "'strict-dynamic'",
      'https://challenges.cloudflare.com',
    ]);
    expect(reportOnlyPolicy('abc', env)).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
    // under `next dev` React's debugging needs eval, and nothing else changes
    expect(directive(reportOnlyPolicy('abc', env, true), 'script-src')).toContain("'unsafe-eval'");
  });

  it('names the API, the nodes and the sign-in’s hosts to connect to, as origins and nothing more', () => {
    const connect = connectSources(env);
    expect(connect).toEqual(expect.arrayContaining(["'self'", 'https://api.tenonfi.example']));
    expect(connect).toContain('https://risk.tenonfi.example');
    // a node set by a deployment, with the socket beside it, and never its path or its key
    expect(connect).toEqual(expect.arrayContaining(['https://node.example', 'wss://node.example']));
    expect(connect.join(' ')).not.toMatch(/api-key|ignored|javascript/);
    expect(connect).toEqual(
      expect.arrayContaining(['https://auth.privy.io', 'wss://relay.walletconnect.com']),
    );
    expect(new Set(connect).size).toBe(connect.length);
    // no scheme alone, and no star for a whole scheme
    expect(connect.some((source) => /^(https?|wss?):$|^\*$/.test(source))).toBe(false);
  });

  it('covers every node the wallet reads by default, on each chain and network', () => {
    for (const network of ['mainnet', 'testnet'] as const) {
      const chains = walletChains({
        NEXT_PUBLIC_CHAIN_NETWORK_SOLANA: network,
        NEXT_PUBLIC_CHAIN_NETWORK_ROBINHOOD: network,
        NEXT_PUBLIC_CHAIN_NETWORK_BASE: network,
      });
      for (const chain of Object.values(chains))
        expect(DEFAULT_NODES as readonly string[], chain.rpcUrl).toContain(chain.rpcUrl);
    }
  });

  it('holds everything else to this app, and sends reports only where a deployment says', () => {
    const policy = reportOnlyPolicy('abc', env);
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    // who may frame a page is the enforced header's, never this one's
    expect(policy).not.toContain('frame-ancestors');
    expect(policy).not.toContain('report-uri');
    expect(reportOnlyPolicy('abc', { reportUri: 'https://reports.example/csp' })).toMatch(
      /; report-uri https:\/\/reports\.example\/csp$/,
    );
    expect(reportOnlyPolicy('abc', { reportUri: 'not an address' })).not.toContain('report-uri');
  });

  it('reads an address as its origin, https or on this machine, or not at all', () => {
    expect(sourceOf('https://a.example:8443/x?y=1')).toBe('https://a.example:8443');
    expect(sourceOf('http://localhost:3001/v1')).toBe('http://localhost:3001');
    for (const value of [undefined, '', 'http://plain.example', 'data:text/html,x', '*'])
      expect(sourceOf(value), String(value)).toBeNull();
  });

  it('makes a nonce of 128 bits, new each time', () => {
    const made = new Set(Array.from({ length: 50 }, makeNonce));
    expect(made.size).toBe(50);
    for (const nonce of made) expect(atob(nonce)).toHaveLength(16);
  });
});

describe('the proxy', () => {
  const at = (path: string, headers: Record<string, string> = {}) =>
    proxy(new NextRequest(new URL(path, 'https://tenonfi.example'), { headers }));
  const nonceOf = (policy: string | null) => policy?.match(/'nonce-([^']+)'/)?.[1];

  it('answers every page with the reported policy and a nonce of its own, and enforces none of it', () => {
    const [a, b] = [at('/goal'), at('/goal')];
    const policy = a.headers.get(REPORT_ONLY);
    expect(policy).toContain("script-src 'self' 'nonce-");
    expect(nonceOf(policy)).not.toBe(nonceOf(b.headers.get(REPORT_ONLY)));
    // the page is rendered with the same policy, so Next reads the nonce from it
    expect(a.headers.get('x-middleware-request-content-security-policy-report-only')).toBe(policy);
    // the enforced header is the frame policy's alone, as before
    expect(a.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(at('/embed').headers.get('content-security-policy')).toBeNull();
    expect(at('/embed').headers.get(REPORT_ONLY)).toContain("'nonce-");
  });

  it('is reached by every page, and by no built file', () => {
    const pages = config.matcher.find((m) => typeof m !== 'string') as { source: string };
    const reaches = (path: string) => pathToRegexp(pages.source).test(path);
    for (const path of ['/', '/goal', '/plan/abc/buy', '/embed', '/analytics/stocks'])
      expect(reaches(path), path).toBe(true);
    for (const path of ['/_next/static/chunks/a.js', '/_next/image', '/favicon.ico', '/icon.svg'])
      expect(reaches(path), path).toBe(false);
  });
});

describe('the build’s check of the reported policy', () => {
  const policy = "default-src 'self'; script-src 'self' 'nonce-abc' 'strict-dynamic'";
  it('passes a page whose every script carries the request’s nonce', () => {
    const html = '<script src="/a.js" nonce="abc"></script><script nonce="abc">x()</script>';
    expect(judgeReported('/goal', policy, html)).toEqual([]);
  });

  it('names a page with no policy, no script, or a script without the nonce', () => {
    expect(judgeReported('/goal', null, '<script nonce="abc"></script>')).toHaveLength(1);
    expect(judgeReported('/goal', policy, '<p>built ahead of time</p>')).toHaveLength(1);
    const [problem] = judgeReported(
      '/goal',
      policy,
      '<script nonce="abc"></script><script>y()</script>',
    );
    expect(problem).toContain('1 of 2 scripts carry no nonce');
  });
});
