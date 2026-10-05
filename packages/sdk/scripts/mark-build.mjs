// The build is CommonJS, which Node, a bundler and a test runner all load. This package is
// `"type": "module"` like its neighbours, so the built folder says what its own files are.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

writeFileSync(
  join(import.meta.dirname, '..', 'dist', 'package.json'),
  `${JSON.stringify({ type: 'commonjs' })}\n`,
);
