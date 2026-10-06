// Run by check-frames.mjs against the production build it starts: every address answers the headers
// of lib/security-headers.ts, a page, the embed, a redirect and an address no route has alike. The
// values are written again here on purpose: the check is of what the build serves, not of the list.

/** [header, what it must be] */
export const WANTED = [
  ['strict-transport-security', /^max-age=\d{8,}$/],
  ['x-content-type-options', /^nosniff$/],
  ['referrer-policy', /^strict-origin-when-cross-origin$/],
  ['permissions-policy', /^camera=\(\), microphone=\(\), geolocation=\(\), browsing-topics=\(\)$/],
];

export const HEADER_CASES = ['/', '/goal', '/sign-in', '/embed', '/risk', '/no-such-page'];

/** What `path` answered that it should not have; empty when every header is as wanted. */
export function judgeHeaders(path, headers) {
  return WANTED.flatMap(([name, want]) => {
    const value = headers.get(name);
    return value !== null && want.test(value) ? [] : [`${path}: ${name} is ${value ?? '(none)'}`];
  });
}

/** What is wrong with the headers on `base`; empty when nothing is. */
export async function headerProblems(base) {
  const problems = [];
  for (const path of HEADER_CASES) {
    const answer = await fetch(base + path, { redirect: 'manual' });
    problems.push(...judgeHeaders(path, answer.headers));
  }
  return problems;
}
