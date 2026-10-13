import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type OpenApiDocument, operationName, renderApiTypes, typeOf } from './api-types';

// The SDK's types are written from the API's committed OpenAPI document, and this holds the committed
// file to what that document gives (DESIGN-VAULT section 12: CI fails on drift). When it fails, run
// `pnpm openapi:emit` and then `pnpm --filter @colosseum/sdk api-types`.

const ROOT = join(import.meta.dirname, '..');
const doc = JSON.parse(readFileSync(join(ROOT, 'openapi.json'), 'utf8')) as OpenApiDocument;

/** The source as the repository formats it. */
const formatted = (source: string) =>
  execFileSync('pnpm', ['exec', 'biome', 'format', '--stdin-file-path=src/api/types.ts'], {
    cwd: ROOT,
    input: source,
    encoding: 'utf8',
  });

describe('the API types', () => {
  it('are what the committed OpenAPI document gives: run `pnpm --filter @colosseum/sdk api-types` when this fails', () => {
    const committed = readFileSync(join(ROOT, 'src', 'api', 'types.ts'), 'utf8');
    expect(formatted(renderApiTypes(doc))).toBe(committed);
  });

  it('name every route of the document, each by its method and path', () => {
    const source = renderApiTypes(doc);
    for (const [path, methods] of Object.entries(doc.paths))
      for (const method of Object.keys(methods))
        expect(source).toContain(`${JSON.stringify(`${method.toUpperCase()} ${path}`)}: {`);
    expect(operationName('get', '/v1/baskets/{id}')).toBe('GetBasketsById');
    expect(operationName('post', '/v1/orders/{id}/legs/{legId}/build')).toBe(
      'PostOrdersByIdLegsByLegIdBuild',
    );
  });

  it('write each kind of schema the document holds', () => {
    expect(typeOf({ type: ['string', 'null'] })).toBe('string | null');
    expect(typeOf({ enum: ['a', 'b'] })).toBe('"a" | "b"');
    expect(typeOf({ const: 3 })).toBe('3');
    // a union inside an array keeps its parentheses, objects included
    expect(
      typeOf({
        type: 'array',
        items: {
          anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'null' }],
        },
      }),
    ).toBe('({\n  a?: string;\n} | null)[]');
    expect(
      typeOf({
        type: 'object',
        properties: { 'not-an-identifier': { type: 'integer' }, b: { type: 'boolean' } },
        required: ['b'],
        additionalProperties: false,
      }),
    ).toBe('{\n  "not-an-identifier"?: number;\n  b: boolean;\n}');
    const chains = { type: 'string', enum: ['solana', 'base'] };
    expect(
      typeOf({
        type: 'object',
        propertyNames: chains,
        additionalProperties: { type: 'boolean' },
        required: ['solana', 'base'],
      }),
    ).toBe('Record<"solana" | "base", boolean>');
    expect(
      typeOf({ type: 'object', propertyNames: chains, additionalProperties: { type: 'boolean' } }),
    ).toBe('Partial<Record<"solana" | "base", boolean>>');
    expect(typeOf({ type: 'object', additionalProperties: { type: 'number' } })).toBe(
      '{\n  [key: string]: number;\n}',
    );
  });
});
