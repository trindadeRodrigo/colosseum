// Where a person goes after signing in. `?next=` is written in the address bar, so anyone can write
// it, in a link sent to someone else too. It is taken only when it names a page of this app, and by
// nothing but its plain path: a browser and a server each read slashes, dots and escapes in their own
// way, and "//host" or "/..//host" is another site to one of them.

/**
 * The product's pages a sign-in may lead on to, as Next names them: `[id]` stands for one segment.
 * next-path.test.ts holds this list to the pages under app/(app).
 */
export const APP_ROUTES: readonly string[] = [
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
];

/** Where sign-in leads when it is told nothing, or nothing it accepts: the goal. */
export const AFTER_SIGN_IN = '/goal';

const SEGMENT = /^[A-Za-z0-9_-]+$/;

const matches = (route: string, segments: readonly string[]) => {
  const want = route.split('/').slice(1);
  return (
    want.length === segments.length &&
    want.every((part, i) => (/^\[[^\]]+\]$/.test(part) ? true : part === segments[i]))
  );
};

/**
 * `raw` when it is a page of this app, and home otherwise. Accepted: home itself (`/`, exactly), or one
 * leading slash, then segments of letters, digits, `-` and `_` with single slashes between them. So no
 * second slash in a row, no backslash, no dot segment, nothing percent-encoded, no query and no
 * fragment. And the path has to be one of the app's routes. The sign-in page itself is not a place to
 * go on to.
 */
export function nextPath(raw: unknown, routes: readonly string[] = APP_ROUTES): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return AFTER_SIGN_IN;
  if (raw === '/') return routes.includes('/') ? raw : AFTER_SIGN_IN;
  const segments = raw.slice(1).split('/');
  if (!segments.every((segment) => SEGMENT.test(segment))) return AFTER_SIGN_IN;
  const known = routes.some((route) => route !== '/sign-in' && matches(route, segments));
  return known ? raw : AFTER_SIGN_IN;
}
