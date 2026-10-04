import type { EnvLike } from '@colosseum/schemas';
import type { FastifyCorsOptions, FastifyCorsOptionsDelegateCallback } from '@fastify/cors';

// CORS, decided by path. /v1 answers a browser only from an origin on the allowlist. Everything else
// the API serves (the structurer's routes and the risk layer's /risk/*) keeps what it had: any origin
// is reflected. One registration at the root, because a preflight is answered before any route is
// matched: a list on the routes alone would let a preflight for /v1 through from anywhere.

/** Where the web app runs under `pnpm dev`. What /v1 allows when `CORS_ORIGINS` is not set. */
export const DEFAULT_CORS_ORIGINS: readonly string[] = ['http://localhost:3000'];

/**
 * The origins a browser may call /v1 from: `CORS_ORIGINS`, separated by commas, each a scheme and a
 * host with no path (`https://app.example`). Unset or empty means the development origin. `none`
 * means no origin at all, for a host whose browsers only reach the API through the web app's own
 * server. Throws on anything else, a `*` included, and never repeats the value.
 */
export function corsAllowlist(env: EnvLike): string[] {
  const raw = env.CORS_ORIGINS?.trim();
  if (!raw) return [...DEFAULT_CORS_ORIGINS];
  if (raw.toLowerCase() === 'none') return [];
  return raw.split(',').map((part) => {
    const origin = part.trim();
    let url: URL | null = null;
    try {
      url = new URL(origin);
    } catch {
      // Reported below, with the others.
    }
    // A star is refused too: an origin is matched whole, so a pattern would allow nobody.
    if (!url || url.origin !== origin || !/^https?:$/.test(url.protocol) || origin.includes('*'))
      throw new Error(
        'CORS_ORIGINS: expected origins such as https://app.example, separated by commas',
      );
    return origin;
  });
}

/** True for a path the /v1 allowlist governs. */
export const underV1 = (url: string) => /^\/v1(?:[/?]|$)/.test(url);

/** The methods /v1 uses. A preflight for any other is not answered with it. */
const V1_METHODS = ['GET', 'HEAD', 'POST', 'PUT'];

/** The CORS options of each request: the allowlist under /v1, any origin elsewhere, as before. */
export function corsByPath(allow: readonly string[]): FastifyCorsOptionsDelegateCallback {
  const v1: FastifyCorsOptions = { origin: [...allow], methods: V1_METHODS };
  const elsewhere: FastifyCorsOptions = { origin: true };
  return (req, callback) => callback(null, underV1(req.url) ? v1 : elsewhere);
}
