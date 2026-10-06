import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Next's own path matcher, the one that reads `source` in next.config.ts.
const { pathToRegexp } = createRequire(import.meta.url)('next/dist/compiled/path-to-regexp') as {
  pathToRegexp: (source: string) => RegExp;
};

import { frameHeaders, partnerOrigins } from './frame-policy';

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
    for (const path of ['/', '/goal', '/orders/1', '/sign-in', '/embedded', '/dev/embed'])
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
});
