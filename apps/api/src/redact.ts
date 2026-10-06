// No node's address in a server log (as the keeper's `hide`, apps/keeper/src/main.ts): a private
// node's URL carries its key, and a library's error names the URL it failed on ("HTTP request
// failed.\n\nURL: …", viem). What is logged has every configured RPC URL taken out, by its setting's
// name, and every "URL: …" line cut to "URL: <hidden>". Applied once, to everything the logger is
// handed (`loggerOptions`), so no route has to remember it.

/** The configured node URLs, by setting: every variable whose name ends in `_RPC_URL` or `_RPC_URL_FALLBACK`. */
export function nodeUrls(env: NodeJS.ProcessEnv): [name: string, url: string][] {
  return (
    Object.entries(env)
      .filter(([name, value]) => /_RPC_URL(_FALLBACK)?$/.test(name) && value?.trim())
      .map(([name, value]) => [name, (value as string).trim()] as [string, string])
      // the longer first, so a URL that contains another is taken out whole
      .sort((a, b) => b[1].length - a[1].length)
  );
}

/** The text with every configured node URL and every "URL: …" taken out. */
export function hideNodeUrls(text: string, urls: [string, string][]): string {
  const named = urls.reduce((t, [name, url]) => t.split(url).join(`<${name}>`), text);
  // a URL already named by its setting stays named
  return named.replace(/\bURL:\s*(?!<)\S+/g, 'URL: <hidden>');
}

/**
 * A value as the logger may keep it: strings hidden, an error turned into its type, message, stack and
 * cause (each hidden), arrays and plain objects walked. Cycles end in "[circular]".
 */
export function hideDeep(
  value: unknown,
  urls: [string, string][],
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return hideNodeUrls(value, urls);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      type: value.name,
      message: hideNodeUrls(value.message, urls),
      ...(value.stack ? { stack: hideNodeUrls(value.stack, urls) } : {}),
    };
    for (const [k, v] of Object.entries(value)) if (k !== 'cause') out[k] = hideDeep(v, urls, seen);
    if (value.cause !== undefined) out.cause = hideDeep(value.cause, urls, seen);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => hideDeep(v, urls, seen));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hideDeep(v, urls, seen)]));
}

/** The Fastify logger's options: every call has its arguments hidden before pino reads them. */
export function loggerOptions(env: NodeJS.ProcessEnv) {
  const urls = nodeUrls(env);
  return {
    hooks: {
      logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
        method.apply(
          this,
          args.map((arg) => hideDeep(arg, urls)),
        );
      },
    },
  };
}
