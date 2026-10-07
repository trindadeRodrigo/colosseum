import { describe, expect, it, vi } from 'vitest';
import SignInPage from '../../app/(app)/sign-in/page';
import { sourceFiles } from '../../components/ui/test/css';
import { AFTER_SIGN_IN, APP_ROUTES, nextPath } from './next-path';

vi.mock('next/navigation', () => import('../wallet/test/mock-next'));

// `?next=` on the sign-in page: where a person goes once signed in. Anyone can write it into a link.

describe('where sign-in leads on to', () => {
  it('is a page of this app, named by its plain path', () => {
    expect(nextPath('/goal')).toBe('/goal');
    expect(nextPath('/monitor')).toBe('/monitor');
    // `/` is the landing page, not the product's: it is not a place sign-in leads on to, unless a
    // product's routes name it
    expect(nextPath('/')).toBe(AFTER_SIGN_IN);
    expect(nextPath('/', ['/', '/goal'])).toBe('/');
    expect(AFTER_SIGN_IN).toBe('/goal');
    // the plan, buy and order pages, each with one plain segment for its id
    const id = '7d9c2f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f';
    for (const page of [`/plan/${id}`, `/plan/${id}/buy`, `/orders/${id}`])
      expect(nextPath(page)).toBe(page);
    for (const page of ['/plan', '/plan/a/b', '/orders', `/orders/${id}/buy`, '/plan/a.b/buy'])
      expect(nextPath(page)).toBe(AFTER_SIGN_IN);
  });

  it('is the goal when it is told nothing', () => {
    for (const nothing of [undefined, null, '', ['/goal'], 7, {}])
      expect(nextPath(nothing)).toBe(AFTER_SIGN_IN);
  });

  it.each([
    // another site, as a browser or a server reads it
    '//evil.com',
    '/..//evil.com',
    '/..//risk',
    '/.//x',
    '/\\evil.com',
    '/\\/evil.com',
    'https://evil.com/goal',
    'http:/goal',
    'javascript:alert(1)',
    // a way round a plain reading of the path
    '/goal/../sign-in',
    '/goal/./x',
    '/goal//',
    '/goal/',
    '/%2e%2e/goal',
    '/%2Fevil.com',
    '/goal%00',
    '/goal\n',
    ' /goal',
    '/goal ',
    '/goal?next=//evil.com',
    '/goal#//evil.com',
    '/@evil.com',
    // not a page of this app
    '//',
    '/nope',
    '/Goal',
    '/goal/extra',
    '/risk',
    '/dev/ui',
    // not a place to go on to
    '/sign-in',
  ])('takes nothing else: %j', (raw) => {
    expect(nextPath(raw)).toBe(AFTER_SIGN_IN);
  });

  it('knows a route with a segment that varies, for when the app has one', () => {
    const routes = ['/goal', '/plans/[id]'];
    expect(nextPath('/plans/abc-123', routes)).toBe('/plans/abc-123');
    for (const not of ['/plans', '/plans/a/b', '/plans/a%2Fb', '/plans/..', '/plans//goal'])
      expect(nextPath(not, routes)).toBe(AFTER_SIGN_IN);
  });
});

describe('the routes sign-in knows', () => {
  it('are the product’s pages, no more and no fewer', () => {
    const pages = [...sourceFiles()]
      .filter((file) => /^app\/\(app\)\/(.+\/)?page\.tsx$/.test(file))
      .map((file) => file.replace(/^app\/\(app\)/, '').replace(/\/page\.tsx$/, '') || '/')
      .sort();
    expect(pages).toEqual([
      '/analytics',
      '/analytics/[page]',
      '/analytics/methodology',
      '/goal',
      '/indexes/[slug]',
      '/indexes/[slug]/buy',
      '/monitor',
      '/orders/[id]',
      '/plan/[id]',
      '/plan/[id]/buy',
      '/portfolio',
      '/portfolio/exposure',
      '/portfolio/plan/[chain]/[address]',
      '/portfolio/rebalancing',
      '/publish',
      '/shelf',
      '/sign-in',
      '/vaults/[chain]/[address]',
      '/vaults/[chain]/[address]/add',
    ]);
    expect([...APP_ROUTES].sort()).toEqual(pages);
  });

  it('is what the sign-in page hands the screen, whatever the address bar says', async () => {
    const to = async (next: string | string[] | undefined) => {
      const page = await SignInPage({ searchParams: Promise.resolve({ next }) });
      return (page.props as { next: string }).next;
    };
    expect(await to('/goal')).toBe('/goal');
    for (const raw of ['/..//evil.com', '/.//x', '//evil.com', '/\\evil.com', ['/goal', '//x']])
      expect(await to(raw)).toBe('/goal');
    expect(await to(undefined)).toBe('/goal');
  });
});
