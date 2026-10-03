import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { draftFromRules } from './draft';

// DESIGN-VAULT 3.6: `compose` is pure. No clock, no network, no environment, nothing random: the time
// and the data come in as arguments. This reads the source of the folder to hold that, and to hold
// what its own files import: schemas, basket, and three pieces of the engine.
//
// What this does not say: that nothing else is loaded. `draft.ts` imports the structurer's rules
// parser, and that file imports the schedule, which imports the solver. Those modules are loaded
// with it and are not called by this folder; the parser's one read of the clock is a default that
// `draftFromRules` never leaves to it, which the last test here holds by moving the clock.

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
    // None of these files imports the parser's model path, the feeds or the solver itself.
    for (const { name, text } of sources)
      expect(text, name).not.toMatch(/parser\/(index|llm)|\/feeds\/|\/solver\//);
    // Only `draft.ts` reaches the rules parser, and `compose` does not reach `draft.ts`.
    const reach = (name: string) => sources.find((x) => x.name === name)?.text ?? '';
    for (const { name, text } of sources)
      if (name !== 'draft.ts') expect(text, name).not.toMatch(/parser\/rules/);
    for (const name of [
      'compose.ts',
      'world.ts',
      'exposure.ts',
      'placement.ts',
      'packaging.ts',
      'card.ts',
    ])
      expect(reach(name), name).not.toMatch(/from '\.\/draft'/);
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

  it('draftFromRules gives the same draft whatever the clock says: the month is its argument', () => {
    const text = 'Juntar R$50 mil em 18 meses';
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
      const now = draftFromRules(text, '2026-10');
      vi.setSystemTime(new Date('2031-01-15T12:00:00Z'));
      expect(draftFromRules(text, '2026-10')).toEqual(now);
      expect(now.draft.horizonMonths).toBe(18);
      // The month it is given is the one that counts.
      expect(draftFromRules('Juntar R$50 mil até 2030', '2026-10').draft.horizonMonths).toBe(39);
      expect(draftFromRules('Juntar R$50 mil até 2030', '2029-01').draft.horizonMonths).toBe(12);
    } finally {
      vi.useRealTimers();
    }
  });
});
