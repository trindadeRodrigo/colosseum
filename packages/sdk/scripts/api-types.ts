// The TypeScript types of the API, written from its committed OpenAPI document (packages/sdk/openapi.json).
// `renderApiTypes` is pure: the document in, the source of src/api/types.ts out, before formatting.
// gen-api-types.ts writes the file; api-types.test.ts fails while the committed file is not what this
// writes from the committed document, so the SDK's types never drift from the API (DESIGN-VAULT
// section 12).
//
// The document is what Fastify emits from the routes' zod schemas: plain JSON Schema with no `$ref`,
// so each type is written out where it is used. What a type cannot say (a pattern, a length, a bound) is
// the API's to check, and is left out.

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  items?: Schema;
  prefixItems?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  propertyNames?: Schema;
  additionalProperties?: boolean | Schema;
  description?: string;
};

type Parameter = {
  in: 'path' | 'query' | 'header';
  name: string;
  required?: boolean;
  schema: Schema;
};

type Operation = {
  summary?: string;
  parameters?: Parameter[];
  requestBody?: { content: { 'application/json': { schema: Schema } } };
  responses: Record<string, { content?: { 'application/json'?: { schema: Schema } } }>;
};

export type OpenApiDocument = { paths: Record<string, Record<string, Operation>> };

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (name: string) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));
const comment = (text: string | undefined, indent: string) =>
  text ? `${indent}/** ${text.replaceAll('*/', '*\\/').replaceAll('\n', ' ')} */\n` : '';

/** One schema as a TypeScript type, written inline. */
export function typeOf(schema: Schema, indent = ''): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  const union = schema.anyOf ?? schema.oneOf;
  if (union) return union.map((s) => wrap(typeOf(s, indent))).join(' | ');
  if (schema.allOf) return schema.allOf.map((s) => wrap(typeOf(s, indent))).join(' & ');
  if (Array.isArray(schema.type))
    return schema.type.map((t) => typeOf({ ...schema, type: t }, indent)).join(' | ');
  switch (schema.type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      if (schema.prefixItems)
        return `[${schema.prefixItems.map((s) => typeOf(s, indent)).join(', ')}]`;
      return `${wrap(schema.items ? typeOf(schema.items, indent) : 'unknown')}[]`;
    case 'object':
      return objectOf(schema, indent);
    default:
      return schema.properties ? objectOf(schema, indent) : 'unknown';
  }
}

/** A union or an intersection inside an array or another union keeps its own parentheses. */
function wrap(type: string): string {
  let depth = 0;
  for (const c of type) {
    if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') depth -= 1;
    else if (depth === 0 && (c === '|' || c === '&')) return `(${type})`;
  }
  return type;
}

function objectOf(schema: Schema, indent: string): string {
  const inner = `${indent}  `;
  const required = new Set(schema.required ?? []);
  const lines = Object.entries(schema.properties ?? {}).map(
    ([name, s]) =>
      `${comment(s.description, inner)}${inner}${key(name)}${required.has(name) ? '' : '?'}: ${typeOf(s, inner)};\n`,
  );
  const extra = schema.additionalProperties;
  // A record whose keys are named (zod's `z.record(enum, …)`): every key, each required as the schema says.
  const keys = schema.propertyNames?.enum;
  if (keys && extra && typeof extra === 'object' && !schema.properties) {
    const all = keys.every((k) => (schema.required ?? []).includes(String(k)));
    return `${all ? 'Record' : 'Partial<Record'}<${keys.map((k) => JSON.stringify(k)).join(' | ')}, ${typeOf(extra, indent)}>${all ? '' : '>'}`;
  }
  if (extra && typeof extra === 'object')
    lines.push(`${inner}[key: string]: ${typeOf(extra, inner)};\n`);
  else if (extra === true || (!schema.properties && extra === undefined))
    lines.push(`${inner}[key: string]: unknown;\n`);
  return lines.length ? `{\n${lines.join('')}${indent}}` : 'Record<string, never>';
}

/** The name of one operation: its method and path, `GET /v1/baskets/{id}` as `GetBasketsById`. */
export function operationName(method: string, path: string): string {
  const words = path
    .replace(/^\/v1\//, '')
    .split('/')
    .map((part) => (part.startsWith('{') ? `by-${part.slice(1, -1)}` : part))
    .flatMap((part) => part.split(/[-_]/))
    .filter(Boolean);
  const pascal = (w: string) => w[0]?.toUpperCase() + w.slice(1);
  return pascal(method.toLowerCase()) + words.map(pascal).join('');
}

function paramsOf(parameters: Parameter[], where: 'path' | 'query'): Schema | null {
  const own = parameters.filter((p) => p.in === where);
  if (own.length === 0) return null;
  return {
    type: 'object',
    properties: Object.fromEntries(own.map((p) => [p.name, p.schema])),
    required: own.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false,
  };
}

const HEADER = `// Generated by packages/sdk/scripts/gen-api-types.ts from packages/sdk/openapi.json. Do not edit:
// change the API's routes, run \`pnpm openapi:emit\`, then \`pnpm --filter @colosseum/sdk api-types\`.
// scripts/api-types.test.ts fails while this file is not what the committed document gives.
`;

/** The source of src/api/types.ts. */
export function renderApiTypes(doc: OpenApiDocument): string {
  const out: string[] = [HEADER];
  const paths: string[] = [];
  for (const [path, methods] of Object.entries(doc.paths))
    for (const [method, op] of Object.entries(methods)) {
      const name = operationName(method, path);
      const parts: [string, Schema | null][] = [
        ['Params', paramsOf(op.parameters ?? [], 'path')],
        ['Query', paramsOf(op.parameters ?? [], 'query')],
        ['Body', op.requestBody?.content['application/json'].schema ?? null],
        ['Response', op.responses['200']?.content?.['application/json']?.schema ?? null],
      ];
      const named: string[] = [];
      for (const [part, schema] of parts) {
        if (!schema) continue;
        out.push(
          `\n${comment(`${method.toUpperCase()} ${path}: ${part.toLowerCase()}. ${op.summary ?? ''}`.trim(), '')}export type ${name}${part} = ${typeOf(schema)};\n`,
        );
        named.push(`${part.toLowerCase()}: ${name}${part}`);
      }
      paths.push(
        `  ${JSON.stringify(`${method.toUpperCase()} ${path}`)}: { ${named.join('; ')} };\n`,
      );
    }
  out.push(
    `\n/** Every route of the document, by its method and path: what each takes and answers. */\nexport interface ApiRoutes {\n${paths.join('')}}\n`,
  );
  return out.join('');
}
