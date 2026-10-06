import type { EnvLike } from '@colosseum/schemas';

// Whose address a request is counted against (plugins/limits.ts). By default it is the address the
// connection came from, and a forwarded one is not believed. Behind a host's proxy that address is the
// proxy's, the same for every caller, so everybody who is not signed in shares one budget and one of
// them can spend it for all. `TRUST_PROXY_HOPS` says how many proxies stand in front of this process:
// the caller's address is then read that many entries from the right of `X-Forwarded-For`, which are
// the ones those proxies wrote. Anything further left is the caller's own claim and is never read.

/** The most proxies a host is taken to put in front of one process. */
const MAX_HOPS = 5;

/**
 * How many proxies stand in front: 0 when `TRUST_PROXY_HOPS` is unset or empty. Throws on anything
 * but a number from 0 to five, a `true` included: every hop trusted is a header any caller can write.
 */
export function trustedHops(env: EnvLike): number {
  const raw = env.TRUST_PROXY_HOPS?.trim();
  if (!raw) return 0;
  const hops = Number(raw);
  if (!/^\d+$/.test(raw) || hops > MAX_HOPS)
    throw new Error(`TRUST_PROXY_HOPS: expected a number of proxies from 0 to ${MAX_HOPS}`);
  return hops;
}

/**
 * What Fastify's `trustProxy` takes: `false` for no proxy, else a function that believes the
 * connection and the entries the proxies wrote, counted from the right, and nothing before them.
 * (A bare number means something else to Fastify: its 1 trusts nobody.)
 */
export function proxyTrust(env: EnvLike): false | ((address: string, hop: number) => boolean) {
  const hops = trustedHops(env);
  return hops === 0 ? false : (_address, hop) => hop < hops;
}
