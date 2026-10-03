import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PersonalParams } from '@colosseum/schemas';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PERSONAL_PARAMS, PERSONAL_PARAMS_STATUS } from './params';
import { PersonalParameters } from './types';

// One table holds every number the engine uses, and each one is marked as a starting value until
// Rodrigo sets it. The logic holds no number of its own.

const dir = fileURLToPath(new URL('.', import.meta.url));
const GOALS = ['grow', 'income', 'protect'] as const;
const RISKS = ['low', 'medium', 'high'] as const;

describe('the parameter table', () => {
  it('is a valid table, and fits the shared PersonalParams too', () => {
    expect(PersonalParameters.parse(PERSONAL_PARAMS)).toEqual(PERSONAL_PARAMS);
    expect(PersonalParams.safeParse(PERSONAL_PARAMS).success).toBe(true);
  });

  it('has a sleeve row for every goal and risk, none over 100%', () => {
    for (const goal of GOALS)
      for (const risk of RISKS) {
        const row = PERSONAL_PARAMS.sleeves[`${goal}:${risk}`];
        if (!row) throw new Error(`no sleeve row for ${goal}:${risk}`);
        expect(row.growthBps + row.dollarYieldBps + row.goldBps).toBeLessThanOrEqual(10_000);
      }
    expect(Object.keys(PERSONAL_PARAMS.sleeves)).toHaveLength(GOALS.length * RISKS.length);
    for (const risk of RISKS) {
      expect(PERSONAL_PARAMS.capPerStockBps[risk]).toBeGreaterThan(0);
      expect(PERSONAL_PARAMS.capPerIssuerBps[risk]).toBeGreaterThan(0);
    }
  });

  it('gives an income plan no stocks, crypto or gold: the asset list would refuse them anyway', () => {
    for (const risk of RISKS) {
      const row = PERSONAL_PARAMS.sleeves[`income:${risk}`];
      expect(row).toMatchObject({ growthBps: 0, goldBps: 0 });
    }
  });

  it('marks every number as a starting value or as set, and says where it came from', () => {
    const keys = Object.keys(PERSONAL_PARAMS).filter((k) => k !== 'version');
    expect(Object.keys(PERSONAL_PARAMS_STATUS).sort()).toEqual(keys.sort());
    for (const [key, mark] of Object.entries(PERSONAL_PARAMS_STATUS)) {
      expect(['starting', 'set'], key).toContain(mark.status);
      expect(mark.from.length, key).toBeGreaterThan(10);
    }
    // Today nothing is set: Rodrigo tunes the table, and flips a mark when he does.
    expect(Object.values(PERSONAL_PARAMS_STATUS).every((m) => m.status === 'starting')).toBe(true);
    expect(PERSONAL_PARAMS.version).toMatch(/starting/);
  });
});

// Whole numbers that are arithmetic and not a choice: nothing and one, two for a half, ten and a
// hundred for decimals and cents, twelve months, and 10,000 basis points in a whole.
const ARITHMETIC = new Set([0, 1, 2, 10, 12, 100, 10_000]);
const DATA = new Set(['params.ts', 'templates.ts', 'testing.ts']);

function numbersIn(file: string): { value: number; line: number }[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(`${dir}/${file}`, 'utf8'),
    ts.ScriptTarget.Latest,
  );
  const found: { value: number; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node))
      found.push({
        value: Number(node.text.replace(/n$/, '')),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the logic of packages/engine/src/personal', () => {
  const logic = readdirSync(dir).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !DATA.has(name),
  );

  it('holds no number of its own: every tunable one is in params.ts', () => {
    expect(logic).toContain('registry.ts');
    const inline = logic.flatMap((file) =>
      numbersIn(file)
        .filter((n) => !ARITHMETIC.has(n.value))
        .map((n) => `${file}:${n.line}: ${n.value}`),
    );
    expect(inline).toEqual([]);
  });

  it('self-check: a planted number is seen', () => {
    expect(numbersIn('params.ts').some((n) => !ARITHMETIC.has(n.value))).toBe(true);
  });
});
