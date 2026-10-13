import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type OpenApiDocument, renderApiTypes } from './api-types';

// Writes src/api/types.ts from the committed OpenAPI document. Run it whenever packages/sdk/openapi.json
// changes (after `pnpm openapi:emit`):
//
//   pnpm --filter @colosseum/sdk api-types
//
// It reads nothing but that file and writes nothing but src/api/types.ts.

const ROOT = join(import.meta.dirname, '..');
const doc = JSON.parse(readFileSync(join(ROOT, 'openapi.json'), 'utf8')) as OpenApiDocument;
writeFileSync(join(ROOT, 'src', 'api', 'types.ts'), renderApiTypes(doc));
