import type { OrderError } from '@colosseum/schemas';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { underV1 } from './paths';

// Rate limits for /v1 (DESIGN-VAULT section 10). The numbers are here and nowhere else. They are kept
// in memory, per process: one API process is what the free host runs.
//
// Every /v1 request is counted against the caller: a signed-in person by who they are, anybody else
// by the address the request came from. That includes a request whose sign-in failed, so guessing at
// tokens is counted too. A route also names a class, and a class may have a tighter budget of its own.

export const LIMITS = {
  /** How long a count is kept, in seconds. */
  windowSeconds: 60,
  /** Requests per window on /v1 as a whole, by who is asking. */
  caller: {
    /** Nobody signed in, or a sign-in that failed: counted by client address. */
    anonymous: 60,
    /** A signed-in person: counted by person, whatever address they come from. */
    signedIn: 120,
  },
  /**
   * Requests per window on one class of routes, by the same caller, on top of the budget above. Every
   * /v1 route declares its class (`config.limit`), and the API does not start with one that does not.
   */
  class: {
    /** Reads and cheap writes: no budget of their own. */
    standard: null,
    /** Planning an order and building a transaction: each one asks the chain for quotes. */
    build: 30,
    /** The sentence parser, which calls a model. No route is in this class yet. */
    parse: 10,
  },
} as const;

export type Limits = {
  windowSeconds: number;
  caller: { anonymous: number; signedIn: number };
  class: Record<LimitClass, number | null>;
};
export type LimitClass = keyof typeof LIMITS.class;
export const LIMIT_CLASSES = Object.keys(LIMITS.class) as LimitClass[];

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The rate-limit class of a /v1 route (`LIMITS.class`). */
    limit?: LimitClass;
    /**
     * The class one request counts against, where it is not the route's: a read that plans an order
     * when its query asks it to counts as a builder then. Read before the handler runs, from the query.
     */
    limitOf?: (req: FastifyRequest) => LimitClass;
  }
}

type Taken = { ok: boolean; limit: number; remaining: number; resetAt: number };

/**
 * Counts per key in fixed windows. A key's window opens with its first request and is forgotten once it
 * has closed, so the table holds only callers seen in the last window.
 */
export function createCounter(windowMs: number) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  let swept = 0;
  return {
    take(key: string, limit: number, now: number): Taken {
      if (now - swept >= windowMs) {
        for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
        swept = now;
      }
      let w = windows.get(key);
      if (!w || w.resetAt <= now) {
        w = { count: 0, resetAt: now + windowMs };
        windows.set(key, w);
      }
      w.count += 1;
      return {
        ok: w.count <= limit,
        limit,
        remaining: Math.max(0, limit - w.count),
        resetAt: w.resetAt,
      };
    },
    size: () => windows.size,
  };
}

/**
 * Adds the limits to a scope, as an `onRequest` hook. It is registered after the hook that works out
 * who is calling and before the one that turns away a failed sign-in, so every request is counted.
 * Answers 429 with the order code `RATE_LIMITED` and says when to try again.
 */
export function registerLimits(
  scope: FastifyInstance,
  options: { limits?: Limits; now?: () => Date } = {},
): void {
  const limits = options.limits ?? LIMITS;
  const now = options.now ?? (() => new Date());
  const counter = createCounter(limits.windowSeconds * 1000);

  scope.addHook('onRequest', async (req, reply) => {
    const at = now().getTime();
    const person = req.principal?.userId;
    const who = person ? `person:${person}` : `address:${req.ip}`;
    const taken = [
      counter.take(who, person ? limits.caller.signedIn : limits.caller.anonymous, at),
    ];
    const { limit, limitOf } = req.routeOptions.config;
    const cls = limitOf?.(req) ?? limit;
    const own = cls ? limits.class[cls] : null;
    if (cls && own !== null) taken.push(counter.take(`${cls}:${who}`, own, at));

    // The budget that is closest to empty is the one the headers describe.
    const tightest = taken.reduce((a, b) => (b.remaining < a.remaining ? b : a));
    const refused = taken.find((t) => !t.ok);
    const shown = refused ?? tightest;
    const wait = Math.max(1, Math.ceil((shown.resetAt - at) / 1000));
    reply.header('ratelimit-limit', shown.limit);
    reply.header('ratelimit-remaining', shown.remaining);
    reply.header('ratelimit-reset', wait);
    if (!refused) return;
    const body: OrderError = {
      error: 'too many requests',
      code: 'RATE_LIMITED',
      fix: `Try again in ${wait} second${wait === 1 ? '' : 's'}.`,
      details: { retryable: true },
    };
    return reply.code(429).header('retry-after', wait).send(body);
  });
}

/**
 * The structurer's writes outside /v1, by method and route: each stores a row, and `POST /goals`
 * reaches the model when one is configured. None asks for a sign-in.
 */
export const OPEN_WRITES: readonly string[] = [
  'POST /goals',
  'POST /plans',
  'POST /plans/:id/transactions',
  'POST /executions/:id/report',
  'POST /policies/:id/revoke',
  'POST /policies/:id/rebalance',
];

/**
 * A budget for those writes, on the root: the anonymous caller's, by address, counted apart from /v1.
 * Nothing else about the routes changes, and no other route is counted. Until the host's proxies are
 * named (`TRUST_PROXY_HOPS`, plugins/proxy.ts) the address is the proxy's, so the budget is one that
 * every caller shares.
 */
export function registerOpenWriteLimit(
  root: FastifyInstance,
  options: { limits?: Limits; now?: () => Date } = {},
): void {
  const limits = options.limits ?? LIMITS;
  const now = options.now ?? (() => new Date());
  const counter = createCounter(limits.windowSeconds * 1000);
  root.addHook('onRequest', async (req, reply) => {
    if (!OPEN_WRITES.includes(`${req.method} ${req.routeOptions?.url ?? ''}`)) return;
    const at = now().getTime();
    const taken = counter.take(`address:${req.ip}`, limits.caller.anonymous, at);
    if (taken.ok) return;
    const wait = Math.max(1, Math.ceil((taken.resetAt - at) / 1000));
    return reply
      .code(429)
      .header('retry-after', wait)
      .send({
        error: 'too many requests',
        fix: `Try again in ${wait} second${wait === 1 ? '' : 's'}.`,
      });
  });
}

/**
 * Default deny, at start, for every path under /v1 wherever it is registered. Called on the root
 * before any route is added. The API then does not start with:
 * - a /v1 route that does not say who may call it (`config.auth`) or which budget it counts against
 *   (`config.limit`): refused as the route is registered;
 * - a /v1 route registered outside the /v1 scope, where the hooks that check a sign-in and count a
 *   request do not run, whatever the route declares: refused when the app is made ready.
 *
 * Answers the function that marks the /v1 scope: call it on the scope before its routes.
 */
export function requireDeclared(root: FastifyInstance): (scope: FastifyInstance) => void {
  const name = (route: { method: string | string[]; url: string }) =>
    `${[route.method].flat().join(',')} ${route.url}`;
  const seen: string[] = [];
  const scoped = new Set<string>();
  root.addHook('onRoute', (route) => {
    if (!underV1(route.url)) return;
    // A HEAD route made for a GET shares its config.
    const { auth, limit } = route.config ?? {};
    if (auth !== 'public' && auth !== 'user')
      throw new Error(`${name(route)} declares no sign-in rule (config.auth)`);
    if (!limit || !LIMIT_CLASSES.includes(limit))
      throw new Error(`${name(route)} declares no rate-limit class (config.limit)`);
    seen.push(name(route));
  });
  root.addHook('onReady', async () => {
    const outside = seen.find((route) => !scoped.has(route));
    if (outside)
      throw new Error(
        `${outside} is registered outside the /v1 scope, where no sign-in is checked and no request is counted`,
      );
  });
  return (scope) => {
    scope.addHook('onRoute', (route) => {
      scoped.add(name(route));
    });
  };
}
