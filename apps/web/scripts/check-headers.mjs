// Run by check-frames.mjs against the production build it starts: every address answers the headers
// of lib/security-headers.ts, a page, the embed and an address no route has alike. A redirect written
// in next.config.ts (`/risk`) is answered before Next's header rules are read and carries none of
// them; it has no body, and the address it leads to answers them all. The
// values are written again here on purpose: the check is of what the build serves, not of the list.
// It also asks two pages for the policy the browser only reports on, and reads their scripts.

/** [header, what it must be] */
export const WANTED = [
  ['strict-transport-security', /^max-age=\d{8,}$/],
  ['x-content-type-options', /^nosniff$/],
  ['referrer-policy', /^strict-origin-when-cross-origin$/],
  ['permissions-policy', /^camera=\(\), microphone=\(\), geolocation=\(\), browsing-topics=\(\)$/],
];

export const HEADER_CASES = [
  '/',
  '/goal',
  '/sign-in',
  '/embed',
  '/analytics/stocks',
  '/no-such-page',
];

/** What `path` answered that it should not have; empty when every header is as wanted. */
export function judgeHeaders(path, headers) {
  return WANTED.flatMap(([name, want]) => {
    const value = headers.get(name);
    return value !== null && want.test(value) ? [] : [`${path}: ${name} is ${value ?? '(none)'}`];
  });
}

const REPORT_ONLY = 'content-security-policy-report-only';
const nonceOf = (policy) => policy?.match(/'nonce-([^']+)'/)?.[1] ?? null;

/**
 * The policy the browser only reports on (lib/content-policy.ts), on a page rendered for the request:
 * the answer carries it with a nonce, and every script the page writes carries that nonce. Without the
 * second, enforcing the policy one day would stop the page's own scripts.
 */
export function judgeReported(path, policy, html) {
  const nonce = nonceOf(policy);
  if (!nonce) return [`${path}: no reported policy with a nonce (${policy ?? 'none'})`];
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  const without = scripts.filter((tag) => !tag.includes(`nonce="${nonce}"`));
  if (scripts.length === 0) return [`${path}: the page has no script to carry the nonce`];
  return without.length
    ? [
        `${path}: ${without.length} of ${scripts.length} scripts carry no nonce, such as ${without[0]}`,
      ]
    : [];
}

/** Pages rendered for each request, where every script must carry the request's nonce. */
export const REPORTED_CASES = ['/goal', '/embed'];

/** What is wrong with the headers on `base`; empty when nothing is. */
export async function headerProblems(base) {
  const problems = [];
  for (const path of HEADER_CASES) {
    const answer = await fetch(base + path, { redirect: 'manual' });
    problems.push(...judgeHeaders(path, answer.headers));
  }
  const seen = new Set();
  for (const path of [...REPORTED_CASES, REPORTED_CASES[0]]) {
    const answer = await fetch(base + path, { redirect: 'manual' });
    const policy = answer.headers.get(REPORT_ONLY);
    problems.push(...judgeReported(path, policy, await answer.text()));
    // nothing of it is enforced: the enforced header is the frame policy's alone
    const enforced = answer.headers.get('content-security-policy') ?? '';
    if (!/^frame-ancestors [^;]+$/.test(enforced))
      problems.push(`${path}: the enforced policy is more than who may frame it: ${enforced}`);
    if (seen.has(nonceOf(policy))) problems.push(`${path}: the same nonce was answered twice`);
    seen.add(nonceOf(policy));
  }
  return problems;
}
