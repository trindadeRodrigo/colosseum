import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { HEADER_CASES, judgeHeaders, WANTED } from '../scripts/check-headers.mjs';
import { frameHeaders } from './frame-policy';
import { SECURITY_HEADERS, securityHeaders } from './security-headers';

// Next's own path matcher, the one that reads `source` in next.config.ts.
const { pathToRegexp } = createRequire(import.meta.url)('next/dist/compiled/path-to-regexp') as {
  pathToRegexp: (source: string) => RegExp;
};

// The headers every address answers, and the check the build is held to (scripts/check-headers.mjs).

const answered = (path: string) =>
  new Headers(
    securityHeaders()
      .filter((rule) => pathToRegexp(rule.source).test(path))
      .flatMap((rule) => rule.headers.map((h) => [h.key, h.value] as [string, string])),
  );

describe('the security headers', () => {
  it('are on every address: a page, the embed, an asset and one no route has', () => {
    for (const path of [...HEADER_CASES, '/embed/solana/abc', '/plan/abc/buy', '/icon.svg'])
      expect(judgeHeaders(path, answered(path)), path).toEqual([]);
  });

  it('send https back for two years, name no subdomain, and leak no path to another site', () => {
    const value = (key: string) => SECURITY_HEADERS.find((h) => h.key === key)?.value;
    expect(value('Strict-Transport-Security')).toBe('max-age=63072000');
    expect(value('X-Content-Type-Options')).toBe('nosniff');
    expect(value('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    // nothing the sign-in or a wallet needs is switched off
    expect(value('Permissions-Policy')).not.toMatch(/publickey|clipboard|usb|hid/);
  });

  it('share no header with the framing policy, so neither rule overwrites the other', () => {
    const framing = new Set(frameHeaders({}).flatMap((r) => r.headers.map((h) => h.key)));
    for (const { key } of SECURITY_HEADERS) expect(framing.has(key), key).toBe(false);
  });

  it('are judged header by header: one missing or weakened is named', () => {
    const headers = answered('/goal');
    headers.delete('referrer-policy');
    headers.set('x-content-type-options', 'sniff');
    expect(judgeHeaders('/goal', headers)).toEqual([
      '/goal: x-content-type-options is sniff',
      '/goal: referrer-policy is (none)',
    ]);
    expect(WANTED).toHaveLength(SECURITY_HEADERS.length);
  });
});
