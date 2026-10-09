// No node's address and no database address in anything the worker prints or stores: a private node's
// URL carries its key, a database URL its password, and a library's error names the URL it failed on
// ("HTTP request failed.\n\nURL: …", viem). This is a copy of apps/api/src/redact.ts (`nodeUrls`,
// `hideNodeUrls`), because an app cannot import an app, with the database and the ping added. The
// keeper's `hide` (apps/keeper/src/main.ts) is the same idea for two variables.

/** Settings that are not a node's and still hold an address with a secret in it. */
const ALSO_HIDDEN = ['DATABASE_URL', 'SNAPSHOT_PING_URL'];

/**
 * What a line is passed through before it is printed or kept: every configured node URL (any variable
 * ending in `_RPC_URL` or `_RPC_URL_FALLBACK`), the database URL and the ping URL replaced by their
 * setting's name, and every other "URL: …" cut to "URL: <hidden>". Read once, at start.
 */
export function hiderFromEnv(env: Record<string, string | undefined>): (text: string) => string {
  const secrets = Object.entries(env)
    .filter(([name]) => /_RPC_URL(_FALLBACK)?$/.test(name) || ALSO_HIDDEN.includes(name))
    .map(([name, value]) => [name, value?.trim() ?? ''] as const)
    .filter(([, value]) => value !== '')
    // the longer first, so a URL that contains another is taken out whole
    .sort((a, b) => b[1].length - a[1].length);
  return (text) =>
    secrets
      .reduce((t, [name, value]) => t.split(value).join(`<${name}>`), text)
      // a URL already named by its setting stays named
      .replace(/\bURL:\s*(?!<)\S+/g, 'URL: <hidden>');
}
