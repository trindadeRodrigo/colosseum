import type { FastifyInstance } from 'fastify';

// What a route outside /v1 answers when it throws (the /v1 scope has its own shape, routes/v1/index.ts).
// Fastify's own handler sends the error's message, and an error nobody meant to send can carry what a
// caller should not read: a database host, a query, a node's URL. Such an error is logged whole and
// answered with the request id and nothing else. An error with a status of its own (a request that
// does not validate, a body too large, a 503 a route threw on purpose) is answered as before.
//
// The risk layer's routes (/risk/*) are the other founder's and answer as apps/risk-api does
// (tests/risk-routes-untouched.test.ts): they are left to Fastify's handler, here as there.

/** Sets the root's error handler. Call it before any route is added. */
export function hideServerErrors(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: unknown }).statusCode;
    const risk = /^\/risk(\/|$)/.test(req.routeOptions?.url ?? '');
    if (risk || (typeof status === 'number' && status >= 400 && status !== 500))
      return reply.send(err);
    req.log.error({ err }, 'a route failed');
    return reply.code(500).send({
      statusCode: 500,
      error: 'Internal Server Error',
      message: `the server failed on this request (${req.id})`,
    });
  });
}
