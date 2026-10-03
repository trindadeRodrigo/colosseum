import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// DESIGN-VAULT 3.6: `compose` is pure. No clock, no network, no environment, nothing random: the time
// and the data come in as arguments. This reads the source of the folder to hold that, and to hold
// what it may import: schemas, basket, and the three pieces of the engine it reuses.

const dir = fileURLToPath(new URL('.', import.meta.url));
const sources = readdirSync(dir)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'testing.ts')
  .map((name) => ({ name, text: readFileSync(`${dir}/${name}`, 'utf8') }));

const importsOf = (text: string) =>
  [
    ...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+'([^']+)';/gms),
    ...text.matchAll(/\bimport\(\s*'([^']+)'/g),
  ].map((m) => m[1] ?? '');

const REUSED = ['../assets/eligibility', '../risk/index', '../parser/rules'];
const allowed = (from: string) =>
  ['@colosseum/schemas', '@colosseum/basket', 'zod'].includes(from) ||
  (from.startsWith('./') && !from.endsWith('/testing')) ||
  REUSED.includes(from);

describe('packages/engine/src/personal', () => {
  it('imports schemas, basket, its own files and three pieces of the engine, and nothing else', () => {
    expect(sources.length).toBeGreaterThan(10);
    for (const { name, text } of sources) {
      for (const from of importsOf(text)) expect(allowed(from), `${name}: ${from}`).toBe(true);
      expect(text, name).not.toMatch(/\brequire\(/);
    }
    // The parser's model path, the feeds and the solver are not reached from here.
    for (const { name, text } of sources)
      expect(text, name).not.toMatch(/parser\/(index|llm)|\/feeds\/|\/solver\//);
    const planted = "import { parseGoal } from '../parser/index';\nimport fs from 'node:fs';";
    expect(importsOf(planted).filter((from) => !allowed(from))).toHaveLength(2);
  });

  it('reads no clock, no environment, no network and no random source', () => {
    const banned = [
      /\bDate\.now\b/,
      /\bnew Date\(/,
      /\bMath\.random\b/,
      /\bprocess\./,
      /\bfetch\(/,
      /\bcrypto\.\w/,
      /\bperformance\./,
      /\bsetTimeout\b/,
      /\blocalStorage\b/,
    ];
    for (const { name, text } of sources)
      for (const pattern of banned) expect(text, `${name}: ${pattern}`).not.toMatch(pattern);
  });
});
