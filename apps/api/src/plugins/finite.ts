import type { FastifyInstance } from 'fastify';

// A number that is not finite (Infinity, NaN) is not a figure: JSON has no word for it, and a response
// schema refuses it as a 500 with nothing a person can act on. What is about to be sent is searched
// for one before it goes, so the log names where it was.

/** The paths of every number in `value` that is not finite, as `a.b[2].c`. */
export function nonFinitePaths(value: unknown, path = '', found: string[] = []): string[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) found.push(path || '(root)');
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) nonFinitePaths(v, `${path}[${i}]`, found);
  } else if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) nonFinitePaths(v, path ? `${path}.${k}` : k, found);
  }
  return found;
}

/** An answer that held a number that is not finite. Its message has the route and the paths only. */
export class NonFiniteResponse extends Error {
  override name = 'NonFiniteResponse';
  constructor(
    route: string,
    readonly paths: string[],
  ) {
    super(`${route} answered a number that is not finite at ${paths.join(', ')}`);
  }
}

/**
 * Refuses, before it is serialised, any answer of this scope's routes that holds a number that is
 * not finite. The error goes to the scope's own handler: a 500 with the request id, and a log line
 * that says which route and where.
 */
export function refuseNonFinite(app: FastifyInstance): void {
  app.addHook('preSerialization', async (req, _reply, payload) => {
    const paths = nonFinitePaths(payload);
    if (paths.length)
      throw new NonFiniteResponse(
        `${req.method} ${req.routeOptions?.url ?? 'an unknown route'}`,
        paths.slice(0, 8),
      );
    return payload;
  });
}
