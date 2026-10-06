import openapi from '@colosseum/sdk/openapi.json' with { type: 'json' };

// The tools' schemas are cut from the API's committed OpenAPI document (packages/sdk/openapi.json), the
// same file the SDK's types are written from: what a tool takes and answers is what the API takes and
// answers, and a change to a route changes the tool with it.

export type JsonSchema = { [key: string]: unknown };

type Operation = {
  requestBody?: { content: { 'application/json': { schema: JsonSchema } } };
  responses: Record<string, { content?: { 'application/json'?: { schema: JsonSchema } } }>;
};

const paths = (openapi as unknown as { paths: Record<string, Record<string, Operation>> }).paths;

function operation(route: string): Operation {
  const [method = '', path = ''] = route.split(' ');
  const op = paths[path]?.[method.toLowerCase()];
  if (!op) throw new Error(`the OpenAPI document has no route ${route}`);
  return op;
}

/** The schema of what a route answers with a 200. */
export function responseOf(route: string): JsonSchema {
  const schema = operation(route).responses['200']?.content?.['application/json']?.schema;
  if (!schema) throw new Error(`${route} answers no JSON`);
  return schema;
}

/** The schema of the body a route takes. */
export function bodyOf(route: string): JsonSchema {
  const schema = operation(route).requestBody?.content['application/json'].schema;
  if (!schema) throw new Error(`${route} takes no body`);
  return schema;
}

/** One property of an object schema. */
export function propertyOf(schema: JsonSchema, name: string): JsonSchema {
  const found = (schema.properties as Record<string, JsonSchema> | undefined)?.[name];
  if (!found) throw new Error(`the schema has no property ${name}`);
  return found;
}

/** An object schema, every property required unless named in `optional`. */
export function objectOf(
  properties: Record<string, JsonSchema>,
  optional: string[] = [],
): JsonSchema {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties).filter((k) => !optional.includes(k)),
    additionalProperties: false,
  };
}
