import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

// `pnpm dev` and `pnpm --filter` start each package in its own directory, while the env file lives at the
// repo root. Load the root file first, then a local one if present. Existing variables are never overridden.
config({ path: [fileURLToPath(new URL('../../../.env', import.meta.url)), '.env'] });
