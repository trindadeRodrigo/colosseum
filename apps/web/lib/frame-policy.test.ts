import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Next's own path matcher, the one that reads `source` in next.config.ts.
const { pathToRegexp } = createRequire(import.meta.url)('next/dist/compiled/path-to-regexp') as {
  pathToRegexp: (source: string, keys?: unknown[], options?: { sensitive?: boolean }) => RegExp;
};

import { NextRequest } from 'next/server';
import { config, proxy } from '../proxy';
import { frameHeaders, isEmbedPage, partnerOrigins } from './frame-policy';

// Who may frame the app: the embed, by this app and the partners a deployment names; nothing else, by
// nobody (embed-shell.md, binding rule 7).

const rulesFor = (path: string, env = {}) =>
  frameHeaders(env).filter((rule) => pathToRegexp(rule.source).test(path));
const csp = (path: string, env = {}) =>
  rulesFor(path, env)
    .flatMap((r) => r.headers)
    .filter((h) => h.key === 'Content-Security-Policy')
    .map((h) => h.value);

describe('the framing policy', () => {
  it('lets this app and the named partners frame the embed, and nobody frame anything else', () => {
    const env = { EMBED_FRAME_ANCESTORS: 'https://partner.example https://app.bank.example:8443' };
    for (const path of ['/embed', '/embed/solana/abc'])
      expect(csp(path, env)).toEqual([
        "frame-ancestors 'self' https://partner.example https://app.bank.example:8443",
      ]);
    for (const path of [
      '/',
      '/goal',
      '/orders/1',
      '/sign-in',
      '/embedded',
      '/dev/embed',
      '/embed/x',
      '/embed/a/b/c',
      '/embed/solana/abc/more',
    ])
      expect(csp(path, env)).toEqual(["frame-ancestors 'none'"]);
    expect(rulesFor('/goal').flatMap((r) => r.headers)).toContainEqual({
      key: 'X-Frame-Options',
      value: 'DENY',
    });
    expect(
      rulesFor('/embed')
        .flatMap((r) => r.headers)
        .map((h) => h.key),
    ).not.toContain('X-Frame-Options');
  });

  it('takes a partner only as an https origin, exactly, and widens nothing it cannot read', () => {
    expect(
      partnerOrigins(
        "https://ok.example * http://plain.example https://*.wild.example https://x.example/path 'unsafe-inline' https://ok2.example:443",
      ),
    ).toEqual(['https://ok.example', 'https://ok2.example:443']);
    expect(csp('/embed')).toEqual(["frame-ancestors 'self'"]);
  });

  it('holds to nobody what Next’s rules give the partners’ policy by case alone, or under /embed and not the embed', () => {
    // a header's source is matched without regard to case, so `/Embed` takes the embed's rule…
    expect(csp('/Embed')).toEqual(["frame-ancestors 'self'"]);
    // …and the proxy, which every spelling of /embed reaches, takes it back
    // the proxy's first matchers are the embed's; its last is every page, for the policy the browser
    // only reports on (content-policy.test.ts)
    const reaches = (path: string) =>
      config.matcher
        .filter((m): m is string => typeof m === 'string')
        .some((m) => pathToRegexp(m, [], { sensitive: true }).test(path));
    for (const path of ['/Embed', '/EMBED/solana/abc', '/eMbEd/x', '/embed/x', '/embed/a/b/c']) {
      expect(reaches(path), path).toBe(true);
      expect(isEmbedPage(path), path).toBe(false);
      const answer = proxy(new NextRequest(new URL(path, 'https://tenonfi.example')));
      expect(answer.headers.get('content-security-policy'), path).toBe("frame-ancestors 'none'");
      expect(answer.headers.get('x-frame-options'), path).toBe('DENY');
    }
    for (const path of ['/embed', '/embed/solana/abc']) {
      expect(isEmbedPage(path)).toBe(true);
      const answer = proxy(new NextRequest(new URL(path, 'https://tenonfi.example')));
      expect(answer.headers.get('content-security-policy')).toBeNull();
      expect(answer.headers.get('x-frame-options')).toBeNull();
    }
    // and they are reached by nothing else
    for (const path of ['/goal', '/embedded', '/dev/embed'])
      expect(reaches(path), path).toBe(false);
  });
});
