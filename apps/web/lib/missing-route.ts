// Two things answer 404 on the API, and they are not the same thing to a person. A route the server
// does not have (the rebalance, which it registers only with LEGACY_STRUCTURER on) is answered by the
// framework: `{ message: "Route POST:/… not found", error: "Not Found", statusCode: 404 }`. A route
// that is there and finds nothing ("policy not found") is answered by the API itself: `{ error }`.

/** True when a 404 means the server has no such route, and not that the route found nothing. */
export function isMissingRoute(status: number, body: unknown): boolean {
  if (status !== 404 || typeof body !== 'object' || body === null) return false;
  const { message, statusCode } = body as { message?: unknown; statusCode?: unknown };
  return statusCode === 404 && typeof message === 'string' && /^Route \S+ not found$/.test(message);
}
