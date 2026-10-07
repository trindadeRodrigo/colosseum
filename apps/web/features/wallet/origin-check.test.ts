import { describe, expect, it } from 'vitest';
import { asksOriginRefused, originRefused } from './origin-check';

// Whether the sign-in service takes sign-ins from this page's address, from the app's public settings
// as Privy answered them on Oct 7 (`allowed_domains`). Refused is said only on a list that leaves the
// address out: anything else is no reason to tell a person their address is wrong.

const SITE = { id: 'app', allowed_domains: ['https://www.tenonfi.xyz', 'https://tenonfi.xyz'] };

describe('the origins a sign-in service allows', () => {
  it('refuses an address its list leaves out, and takes the ones on it', () => {
    expect(originRefused(SITE, 'http://localhost:3000')).toBe(true);
    expect(originRefused(SITE, 'https://www.tenonfi.xyz')).toBe(false);
    expect(originRefused(SITE, 'https://tenonfi.xyz')).toBe(false);
    // the same origin written another way
    expect(originRefused(SITE, 'HTTPS://WWW.TENONFI.XYZ/')).toBe(false);
    // another scheme or host is another origin
    expect(originRefused(SITE, 'http://www.tenonfi.xyz')).toBe(true);
    expect(originRefused(SITE, 'https://evil.tenonfi.xyz')).toBe(true);
  });

  it('refuses nothing on no list, an empty one, or an answer that is not the settings', () => {
    for (const settings of [
      {},
      { allowed_domains: [] },
      { allowed_domains: null },
      { allowed_domains: 'https://tenonfi.xyz' },
      { allowed_domains: ['https://tenonfi.xyz', 7] },
      null,
      'not json',
      [],
    ])
      expect(originRefused(settings, 'http://localhost:3000')).toBe(false);
  });

  it('asks the app’s public settings once, and says refused only on their word', async () => {
    const asked: [string, RequestInit | undefined][] = [];
    const answer = (res: () => Response | Promise<Response>) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        asked.push([String(url), init]);
        return res();
      }) as typeof fetch;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    expect(
      await asksOriginRefused(
        'app id',
        'http://localhost:3000',
        answer(() => json(SITE)),
      ),
    ).toBe(true);
    expect(asked[0]?.[0]).toBe('https://auth.privy.io/api/v1/apps/app%20id');
    expect(asked[0]?.[1]?.redirect).toBe('error');
    // no answer at all when the settings cannot be read: an error, another status, no JSON, nothing
    for (const res of [
      () => json({ error: 'Origin not allowed', code: 'invalid_origin' }, 403),
      () => json(SITE, 500),
      () => json({ id: 'app' }),
      () => new Response('<html>'),
      () => {
        throw new TypeError('fetch failed');
      },
    ])
      expect(await asksOriginRefused('app', 'http://localhost:3000', answer(res))).toBeNull();
    expect(
      await asksOriginRefused(
        'app',
        'https://tenonfi.xyz',
        answer(() => json(SITE)),
      ),
    ).toBe(false);
  });
});
