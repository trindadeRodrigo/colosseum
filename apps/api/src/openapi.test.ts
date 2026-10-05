import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DISCLAIMER } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import {
  emitV1OpenApi,
  OPENAPI_FILE,
  type OpenApiDocument,
  V1_SECURITY_SCHEMES,
  v1Transform,
} from './openapi';
import { LIMIT_CLASSES } from './plugins/limits';

// API-2: the OpenAPI document of /v1 is committed at packages/sdk/openapi.json, where the SDK takes
// its types from. This fails when the routes and the committed file differ: run `pnpm openapi:emit`
// and commit the file with the change that moved it.

const committed = JSON.parse(
  readFileSync(fileURLToPath(new URL(`../../../${OPENAPI_FILE}`, import.meta.url)), 'utf8'),
) as OpenApiDocument;

/** The paths on which two documents differ, with the methods that do. */
function differences(a: OpenApiDocument['paths'], b: OpenApiDocument['paths']): string[] {
  const out: string[] = [];
  for (const path of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const [x, y] = [a[path] ?? {}, b[path] ?? {}];
    for (const method of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort())
      if (!isDeepStrictEqual(x[method], y[method])) out.push(`${method.toUpperCase()} ${path}`);
  }
  return out;
}

describe('the committed OpenAPI document (packages/sdk/openapi.json)', () => {
  it('is what the /v1 routes emit: run `pnpm openapi:emit` when this fails', async () => {
    const emitted = await emitV1OpenApi();
    expect(differences(committed.paths, emitted.paths)).toEqual([]);
    expect(committed.info).toEqual(emitted.info);
    expect(committed).toEqual(emitted);
  });

  it('is what the server serves under /v1, less the routes that exist only on the mock', async () => {
    const app = await buildApp({ env: {} });
    await app.ready();
    const whole = app.swagger() as unknown as OpenApiDocument;
    const served = whole.paths;
    await app.close();
    expect(whole.components.securitySchemes).toEqual(committed.components.securitySchemes);
    const real = Object.fromEntries(
      Object.entries(served).filter(([p]) => p.startsWith('/v1/') && !p.startsWith('/v1/mock/')),
    );
    expect(Object.keys(real).sort()).toEqual(Object.keys(committed.paths));
    expect(differences(real, committed.paths)).toEqual([]);
    // The mock routes are served while a chain runs on the mock, and are not in the document.
    expect(Object.keys(served).some((p) => p.startsWith('/v1/mock/'))).toBe(true);
  });

  it('holds /v1 and nothing else, with the disclaimer, and every route says how it refuses', () => {
    const paths = Object.keys(committed.paths);
    expect(paths.length).toBeGreaterThan(8);
    expect(paths.filter((p) => !p.startsWith('/v1/'))).toEqual([]);
    expect(paths.filter((p) => p.includes('mock'))).toEqual([]);
    expect(committed.info.description).toContain(DISCLAIMER.en);
    expect(committed.openapi).toBe('3.1.0');
    for (const [path, methods] of Object.entries(committed.paths))
      for (const [method, operation] of Object.entries(methods)) {
        const { summary, responses } = operation as {
          summary?: string;
          responses?: Record<string, unknown>;
        };
        expect(summary, `${method} ${path}`).toBeTruthy();
        expect(Object.keys(responses ?? {}), `${method} ${path}`).toContain('200');
      }
  });

  it('says who may call each route and which budget it counts against, as the route declares', async () => {
    // The two headers of a sign-in, declared once: a bearer token and a header of its own.
    expect(committed.components).toEqual({ securitySchemes: V1_SECURITY_SCHEMES });
    expect(committed.components.securitySchemes).toMatchObject({
      accessToken: { type: 'http', scheme: 'bearer' },
      identityToken: { type: 'apiKey', in: 'header', name: 'privy-id-token' },
    });
    const open: string[] = [];
    const classes: Record<string, string[]> = {};
    for (const [path, methods] of Object.entries(committed.paths))
      for (const [method, operation] of Object.entries(methods)) {
        const name = `${method.toUpperCase()} ${path}`;
        const { security, responses, ...rest } = operation as {
          security?: Record<string, string[]>[];
          responses: Record<string, unknown>;
          'x-rate-limit'?: string;
        };
        // Both tokens together, or nothing: no route takes one of the two.
        if (isDeepStrictEqual(security, [])) open.push(name);
        else expect(security, name).toEqual([{ accessToken: [], identityToken: [] }]);
        const cls = rest['x-rate-limit'] ?? '';
        expect(LIMIT_CLASSES, name).toContain(cls);
        classes[cls] = [...(classes[cls] ?? []), name];
        // Every route is counted, so every route can refuse: a 429 has the one refusal shape.
        expect(Object.keys(responses), name).toContain('default');
      }
    // The routes anybody may call, by name: a route opened by mistake fails here. The shelf and a
    // shared portfolio's page are the same for everyone (DESIGN-VAULT section 10).
    expect(open).toEqual([
      'GET /v1/config',
      'GET /v1/indexes/{slug}',
      'GET /v1/indexes/{slug}/versions',
      'GET /v1/shelf',
      'GET /v1/vaults/{chain}/{address}',
    ]);
    // The routes that ask a chain for quotes, and the one that runs the engine on a chain's shelf,
    // are the ones with the tighter budget.
    expect(classes.build).toEqual([
      'POST /v1/baskets/personalize',
      'POST /v1/orders',
      'POST /v1/orders/{id}/legs/{legId}/build',
    ]);
    expect(classes.parse).toBeUndefined();
  });

  it('self-check: a route whose rule changed is another document', () => {
    const route = (config: object) =>
      v1Transform({
        schema: { summary: 'a route' },
        url: '/v1/x',
        route: { config },
        openapiObject: { openapi: '3.1.0' },
      } as unknown as Parameters<typeof v1Transform>[0]).schema;
    const user = route({ auth: 'user', limit: 'standard' });
    expect(user).toEqual({
      summary: 'a route',
      security: [{ accessToken: [], identityToken: [] }],
      'x-rate-limit': 'standard',
    });
    expect(route({ auth: 'public', limit: 'standard' })).toEqual({ ...user, security: [] });
    expect(route({ auth: 'user', limit: 'build' })).toEqual({ ...user, 'x-rate-limit': 'build' });
    // A route that is not under /v1 declares neither, and its document is left as it was.
    expect(route({})).toEqual({ summary: 'a route' });
  });

  it('self-check: a route that changed is a difference, named by its method and path', async () => {
    const emitted = await emitV1OpenApi();
    const moved = structuredClone(emitted);
    const order = moved.paths['/v1/orders/{id}'];
    if (!order) throw new Error('no such path');
    order.get = { ...(order.get as object), summary: 'another summary' };
    delete moved.paths['/v1/funding'];
    expect(differences(emitted.paths, moved.paths)).toEqual([
      'GET /v1/funding',
      'GET /v1/orders/{id}',
    ]);
  });
});
