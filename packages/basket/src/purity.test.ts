import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// DESIGN-VAULT section 2: `basket` imports only `schemas`. And every function in it is pure: the time,
// the prices and the asset list come in as arguments. This reads the source to hold both.

const dir = fileURLToPath(new URL('.', import.meta.url));
const sources = readdirSync(dir)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => ({ name, text: readFileSync(`${dir}/${name}`, 'utf8') }));

/** Every `import ... from '...'` and `export ... from '...'` statement, and every import('...'). */
const importsOf = (text: string) =>
  [
    ...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+'([^']+)';/gms),
    ...text.matchAll(/\bimport\(\s*'([^']+)'/g),
  ].map((m) => m[1] ?? '');
const allowed = (from: string) => from === '@colosseum/schemas' || from.startsWith('./');

describe('packages/basket', () => {
  it('imports nothing but @colosseum/schemas and its own files', () => {
    expect(sources.length).toBeGreaterThan(8);
    for (const { name, text } of sources) {
      for (const from of importsOf(text)) expect(allowed(from), `${name}: ${from}`).toBe(true);
      expect(text, name).not.toMatch(/\brequire\(/);
    }
    expect(sources.flatMap((s) => importsOf(s.text)).length).toBeGreaterThan(15);
    // The check itself: a planted import of each kind is seen and refused.
    const planted = [
      "import { z } from 'zod';",
      "import type {\n  Shelf,\n} from '@colosseum/engine';",
      "export * from 'node:crypto';",
      "const fs = await import('node:fs');",
      "import { ok } from './amounts';",
    ].join('\n');
    expect(importsOf(planted)).toEqual([
      'zod',
      '@colosseum/engine',
      'node:crypto',
      './amounts',
      'node:fs',
    ]);
    expect(importsOf(planted).filter((from) => !allowed(from))).toHaveLength(4);
  });

  it('reads no clock, no environment, no network and no random source', () => {
    const banned = [
      /\bDate\.now\b/,
      /\bnew Date\(\s*\)/,
      /\bMath\.random\b/,
      /\bprocess\./,
      /\bfetch\(/,
      /\bcrypto\.\w/,
      /\bperformance\./,
      /\bsetTimeout\b/,
    ];
    for (const { name, text } of sources)
      for (const pattern of banned) expect(text, `${name}: ${pattern}`).not.toMatch(pattern);
  });
});
