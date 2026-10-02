/**
 * The address of one API call. `path` is the part after the API's own address and starts with one `/`.
 * Throws on anything that could send the call, and the sign-in token with it, somewhere else:
 * `@evil.example/x` appended to an address makes the API's host a user name, `//evil.example` and
 * `/\evil.example` name a host, and `/../` climbs out of the path the API is mounted under.
 */
export function apiUrl(base: string, path: string): string {
  const root = new URL(base);
  if (root.protocol !== 'http:' && root.protocol !== 'https:')
    throw new Error('the API address is not an http address');
  if (!/^\/(?![/\\])/.test(path)) throw new Error('the path must start with one /');
  const mount = root.pathname.replace(/\/+$/, '');
  const url = new URL(`${root.origin}${mount}${path}`);
  if (url.origin !== root.origin || !url.pathname.startsWith(`${mount}/`))
    throw new Error('the path leads outside the API');
  return url.href;
}
