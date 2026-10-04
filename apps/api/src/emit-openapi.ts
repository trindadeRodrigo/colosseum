import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emitV1OpenApi, OPENAPI_FILE } from './openapi';

// Writes the /v1 OpenAPI document to packages/sdk/openapi.json: `pnpm openapi:emit`, which formats
// the file afterwards. apps/api/src/openapi.test.ts fails while the file and the routes differ.
const file = fileURLToPath(new URL(`../../../${OPENAPI_FILE}`, import.meta.url));
writeFileSync(file, `${JSON.stringify(await emitV1OpenApi(), null, 2)}\n`);
console.log(`wrote ${OPENAPI_FILE}`);
