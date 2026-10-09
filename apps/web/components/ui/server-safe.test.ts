import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { read, sourceFiles, WEB } from './test/css';

// Some primitives are client components ('use client': they hold state or listen for events) and the
// rest can be rendered by a server component. A server component may render a client component, but
// it may not call a function exported by a client module: on the server that export is a reference,
// not the function. So a primitive that is not a client module uses what it imports from one only as
// a tag or as a type. Nothing else catches this before a page is built.

const UI = 'components/ui';
const files = [...sourceFiles(join(WEB, UI))].filter(
  (file) => /\.tsx?$/.test(file) && !/\.test\.ts$/.test(file) && !file.includes('/test/'),
);
const isClient = (file: string) => /^\s*(['"])use client\1/.test(read(file));

/** The file a relative import names, with its extension. */
function target(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = relative(WEB, resolve(WEB, dirname(from), spec))
    .split(sep)
    .join('/');
  return files.find((file) => file === `${base}.tsx` || file === `${base}.ts`) ?? null;
}

/** Every use of a client module's export, in a file that is not one, that is not a tag or a type. */
export function calls(file: string, text: string, client: (file: string) => boolean): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Map<string, string>();
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const from = target(file, node.moduleSpecifier.text);
    const clause = node.importClause;
    if (!from || !client(from) || !clause || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const el of bindings.elements) if (!el.isTypeOnly) names.set(el.name.text, from);
    if (clause.name) names.set(clause.name.text, from);
  }
  const found: string[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isIdentifier(node) && names.has(node.text)) {
      const parent = node.parent;
      const tag =
        (ts.isJsxOpeningElement(parent) ||
          ts.isJsxSelfClosingElement(parent) ||
          ts.isJsxClosingElement(parent)) &&
        parent.tagName === node;
      const imported = ts.isImportSpecifier(parent) || ts.isImportClause(parent);
      const typed = ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent);
      if (!tag && !imported && !typed)
        found.push(`${file} uses ${node.text} from ${names.get(node.text)} as a value`);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

/**
 * Everything a client module exports that is not a component or a type: a constant, a helper, a
 * default export. On the server each of those is a reference, so a page that reads one gets nothing.
 */
export function valueExports(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const say = (name: string) => found.push(`${file} exports ${name}, which is not a component`);
  for (const node of source.statements) {
    if (ts.isExportAssignment(node)) say('a default');
    if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      const clause = node.exportClause;
      if (!clause || !ts.isNamedExports(clause)) say('everything from another module');
      else for (const el of clause.elements) if (!el.isTypeOnly) say(el.name.text);
    }
    const exported =
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) continue;
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text ?? 'a default';
      if (!/^[A-Z][A-Za-z0-9]*$/.test(name) || /^[A-Z0-9_]+$/.test(name)) say(name);
    } else if (ts.isVariableStatement(node))
      for (const decl of node.declarationList.declarations) say(decl.name.getText(source));
    else say(node.getText(source).split('\n')[0] ?? 'something');
  }
  return found;
}

describe('a primitive a server component can render calls nothing from a client module', () => {
  const server = files.filter((file) => file.endsWith('.tsx') && !isClient(file));

  it('knows which primitives are client components', () => {
    expect(
      files
        .filter(isClient)
        .map((file) => file.replace(`${UI}/`, ''))
        .sort(),
    ).toEqual([
      'Button.tsx',
      'CaseChart.tsx',
      'CompactNav.tsx',
      'Composer.tsx',
      'ConstraintSheet.tsx',
      'CopyButton.tsx',
      'DistChart.tsx',
      'HeatmapTile.tsx',
      'Hint.tsx',
      'ProvenancePin.tsx',
      'SubscribeBlock.tsx',
      'TimeChart.tsx',
      'Waiting.tsx',
    ]);
    expect(server).toContain(`${UI}/PlanLegs.tsx`);
    expect(server).toContain(`${UI}/GoalCard.tsx`);
  });

  it('finds no such call', () => {
    expect(server.flatMap((file) => calls(file, read(file), isClient))).toEqual([]);
  });

  it('bites: asking the pin’s state from the client module would be one', () => {
    const before =
      "import { ProvenancePin, pinState } from './ProvenancePin';\nexport const A = () => (pinState(null) ? <ProvenancePin value='' obs={null} /> : null);";
    expect(calls(`${UI}/PlanLegs.tsx`, before, isClient)).toEqual([
      `${UI}/PlanLegs.tsx uses pinState from ${UI}/ProvenancePin.tsx as a value`,
    ]);
  });
});

describe('a client module exports components and types, and nothing else', () => {
  const client = files.filter(isClient);

  it('finds no constant, helper or default export in one', () => {
    expect(client).toHaveLength(13);
    expect(client.flatMap((file) => valueExports(file, read(file)))).toEqual([]);
  });

  it('keeps the default labels and the Enter rule in plain modules', () => {
    for (const file of [`${UI}/labels.ts`, `${UI}/composer-keys.ts`, `${UI}/provenance.ts`]) {
      expect(files).toContain(file);
      expect(isClient(file)).toBe(false);
    }
    expect(read(`${UI}/labels.ts`)).toMatch(/export const COMPOSER_LABELS\b/);
    expect(read(`${UI}/composer-keys.ts`)).toMatch(/export function sendsOnKey\b/);
  });

  it('bites: a constant, a helper, a re-export and a default', () => {
    const text = [
      "'use client';",
      'export type Labels = { send: string };',
      "export type { PinState } from './provenance';",
      "export const LABELS: Labels = { send: 'Fit it' };",
      'export function sendsOnKey() { return true; }',
      "export { pinState, type PinSource } from './provenance';",
      'export function Composer() { return null; }',
      'export default Composer;',
    ].join('\n');
    expect(valueExports('Composer.tsx', text)).toEqual([
      'Composer.tsx exports LABELS, which is not a component',
      'Composer.tsx exports sendsOnKey, which is not a component',
      'Composer.tsx exports pinState, which is not a component',
      'Composer.tsx exports a default, which is not a component',
    ]);
  });
});
