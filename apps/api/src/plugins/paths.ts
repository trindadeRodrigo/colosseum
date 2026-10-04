// How a request's path is read wherever a rule is about /v1: the CORS allowlist and default deny.

/**
 * A request's path as plainly as it can be read, so that no spelling of a path gets past a rule about
 * it: the query cut off, every percent-escape decoded (the router decodes them before it matches a
 * route, so `/%761/config` is `/v1/config`), dot segments resolved, doubled slashes and a `;suffix`
 * dropped, in lower case. It reads more loosely than the router does, on purpose: a spelling the
 * router would answer 404 is still held to the rule.
 */
export function plainPath(url: string): string {
  const cut = (text: string) => text.split(/[?#]/, 1)[0] ?? '';
  let path = cut(url);
  // Twice-escaped is escaped once more than the router reads, and is decoded here all the same.
  for (let pass = 0; pass < 3 && path.includes('%'); pass++)
    path = cut(
      path.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      ),
    );
  const segments: string[] = [];
  for (const raw of path.split('/')) {
    const segment = raw.split(';', 1)[0] ?? '';
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`.toLowerCase();
}

/** True for a path the /v1 allowlist governs, however it is spelled. */
export const underV1 = (url: string) => /^\/v1(?:\/|$)/.test(plainPath(url));
