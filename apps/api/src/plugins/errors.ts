import { STATUS_CODES } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { loggable } from './loggable';

// What a route outside /v1 answers when it throws (the /v1 scope has its own shape, routes/v1/index.ts).
// Fastify's own handler sends the error's message, and an error nobody meant to send can carry what a
// caller should not read: a database host, a query, a node's URL. Such an error is logged whole and
// answered with the request id and nothing else, under the status it had: every 5xx, since a 502 or a
// 503 thrown by a library names the address it could not reach as readily as a 500 does. A 4xx (a
// request that does not validate, a body too large) is the caller's to read and is answered as before.
// A route that means to say why it is unavailable replies so itself, and does not throw.
//
// The risk layer's routes (/risk/*) are the other founder's and answer as apps/risk-api does
// (tests/risk-routes-untouched.test.ts): they are left to Fastify's handler, here as there.

/** Sets the root's error handler. Call it before any route is added. */
export function hideServerErrors(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: unknown }).statusCode;
    const risk = /^\/risk(\/|$)/.test(req.routeOptions?.url ?? '');
    if (risk || (typeof status === 'number' && status >= 400 && status < 500))
      return reply.send(err);
    // Any 5xx: a 502 or a 503 a library threw names what it could not reach as readily as a 500 does.
    const code = typeof status === 'number' && status >= 500 && status < 600 ? status : 500;
    req.log.error({ err: loggable(err) }, 'a route failed');
    return reply.code(code).send({
      statusCode: code,
      error: STATUS_CODES[code] ?? 'Internal Server Error',
      message: `the server failed on this request (${req.id})`,
    });
  });
}
