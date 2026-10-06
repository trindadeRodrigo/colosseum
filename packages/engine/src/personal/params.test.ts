import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXIT_TAU, EXIT_WINDOW_DAYS } from '@colosseum/basket';
import { PersonalParams } from '@colosseum/schemas';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PERSONAL_PARAMS, PERSONAL_PARAMS_STATUS } from './params';
import { PersonalParameters } from './types';

// One table holds the numbers the engine uses, and each one is marked as a starting value until
// Rodrigo sets it. The second half of this file reads the logic for numbers of its own, and says
// what it cannot see: two numbers stay in packages/basket.

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

  // Decided on Oct 3 (gate PROTECT-NO-STOCKS). The stock share of each protect row went to dollar
  // yield as a starting value, and the rows are marked as changed for Rodrigo to read.
  it('gives a plan to protect no stocks or crypto, and starts it from no shared portfolio', () => {
    for (const risk of RISKS) {
      const row = PERSONAL_PARAMS.sleeves[`protect:${risk}`];
      expect(row).toMatchObject({ growthBps: 0 });
    }
    expect(PERSONAL_PARAMS.defaultTheme.protect).toBeNull();
    expect(PERSONAL_PARAMS_STATUS.sleeves.changed).toMatch(/PROTECT-NO-STOCKS/);
    expect(PERSONAL_PARAMS_STATUS.defaultTheme.changed).toMatch(/PROTECT-NO-STOCKS/);
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
// The table itself, and the builders of the tests. The wording (templates.ts) is read like the logic.
const DATA = new Set(['params.ts', 'testing.ts']);
// Constants a file of the folder may take from outside it. Two are numbers the table does not hold:
// see "what this cannot see" below.
const FROM_OUTSIDE = new Set(['EXIT_WINDOW_DAYS', 'DISCLAIMER']);

type Found = { value: string; line: number };

/** What a file holds that could be a number of its own: literals, numbers parsed from text, and constants imported from outside the folder. */
const numbersIn = (file: string) => scan(file, readFileSync(`${dir}/${file}`, 'utf8'));

function scan(
  file: string,
  text: string,
): { literals: (Found & { n: number })[]; parsed: Found[]; imported: Found[] } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const literals: (Found & { n: number })[] = [];
  const parsed: Found[] = [];
  const imported: Found[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) {
      const n = Number(node.text.replace(/n$/, ''));
      literals.push({ n, value: node.text, line: lineOf(node) });
    }
    // Number('3500'), parseInt('35'), parseFloat('0.25'), BigInt('7'): a number written as text.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['Number', 'parseInt', 'parseFloat', 'BigInt'].includes(node.expression.text) &&
      node.arguments.some((a) => ts.isStringLiteralLike(a) && /\d/.test(a.text))
    )
      parsed.push({ value: node.getText(source), line: lineOf(node) });
    // A constant in capitals imported from outside the folder may be a number.
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      !node.moduleSpecifier.text.startsWith('./') &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    )
      for (const e of node.importClause.namedBindings.elements) {
        const name = (e.propertyName ?? e.name).text;
        if (/^[A-Z][A-Z0-9_]+$/.test(name)) imported.push({ value: name, line: lineOf(node) });
      }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { literals, parsed, imported };
}

describe('the logic of packages/engine/src/personal', () => {
  const logic = readdirSync(dir).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !DATA.has(name),
  );

  it('holds no number of its own, written as a number, as text or brought in from outside', () => {
    expect(logic).toEqual(expect.arrayContaining(['registry.ts', 'compose.ts', 'templates.ts']));
    const own = logic.flatMap((file) => {
      const found = numbersIn(file);
      return [
        ...found.literals.filter((x) => !ARITHMETIC.has(x.n)),
        ...found.parsed,
        ...found.imported.filter((x) => !FROM_OUTSIDE.has(x.value)),
      ].map((x) => `${file}:${x.line}: ${x.value}`);
    });
    expect(own).toEqual([]);
  });

  it('self-check: a number is seen however it is written', () => {
    expect(numbersIn('params.ts').literals.some((x) => !ARITHMETIC.has(x.n))).toBe(true);
    const planted = scan(
      'planted.ts',
      "import { EXIT_TAU } from '@colosseum/basket';\nconst a = Number('3500');\nconst b = 35;",
    );
    expect(planted.imported.map((x) => x.value)).toEqual(['EXIT_TAU']);
    expect(planted.parsed.map((x) => x.value)).toEqual(["Number('3500')"]);
    expect(planted.literals.map((x) => x.n)).toEqual([35]);
  });

  // What this cannot see, said plainly, so nobody reads "no number in the logic" as more than it is.
  //
  // 1. Arithmetic on the numbers it allows: `10 * 10 * 5` is 500 and passes.
  // 2. Two numbers that live in packages/basket and not in the table. The card's exit figures come
  //    from basket's `rollUp`, which reads exit cost over its own window (`EXIT_WINDOW_DAYS`, 7 days;
  //    the engine reads capacity over the same one) and flags a short capacity at its own cost
  //    (`EXIT_TAU`, 1%). `rollUp` takes neither as an argument. So `tau` in the table moves the
  //    ceilings and not that flag: the test below fails if the two are set apart.
  // 3. Numbers inside testing.ts and the fixtures, which are test data.
  it("the table's tau is the one packages/basket reads exit capacity at", () => {
    expect(PERSONAL_PARAMS.tau).toBe(EXIT_TAU);
    expect(EXIT_WINDOW_DAYS).toBeGreaterThan(0);
  });
});
