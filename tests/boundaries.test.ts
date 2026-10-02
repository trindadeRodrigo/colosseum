import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

// The import rules of docs/vault/DESIGN-VAULT.md section 2, read from the import statements of every source
// file under packages/ and apps/. scripts/ and the root tests/ may import anything and are not read.
// Rows are keyed by folder, and a package's name comes from its package.json, so the rename (FRAME-4)
// changes nothing here.

const ROOT = join(import.meta.dirname, '..');

const SCHEMAS = 'packages/schemas';
const BASKET = 'packages/basket';
const ENGINE = 'packages/engine';
const RISK = 'packages/risk';
const DB = 'packages/db';
const SOLANA = 'packages/chain-solana';
const EVM = 'packages/chain-evm';
const MOCK = 'packages/chain-mock';
const SDK = 'packages/sdk';
const CHAINS = [SOLANA, EVM, MOCK];
const LOGIC = [ENGINE, BASKET, RISK];

type Row = {
  /** Workspace folders this one may import. A folder always may import itself. */
  may: readonly string[];
  /** Of those, the ones it may import only with `import type`. */
  typesOnly?: readonly string[];
  /** More folders, for its test files only. */
  inTests?: readonly string[];
  /** If set, the only outside packages it may import. Its test files may also import vitest and node:*. */
  outside?: readonly string[];
};

// The "May import" column of the layout table. A folder under packages/ or apps/ with no row fails the test:
// add the row here and in the design. A row for a folder that does not exist yet is simply not used.
const LAYOUT: Record<string, Row> = {
  [SCHEMAS]: { may: [], outside: ['zod'] },
  [BASKET]: { may: [SCHEMAS] },
  [ENGINE]: { may: [SCHEMAS, BASKET] },
  [RISK]: { may: [SCHEMAS] },
  [DB]: { may: [SCHEMAS] },
  // An adapter's tests run the shared contract cases, which chain-mock exports.
  [SOLANA]: { may: [SCHEMAS], inTests: [MOCK] },
  [EVM]: { may: [SCHEMAS], inTests: [MOCK] },
  [MOCK]: { may: [SCHEMAS, BASKET] },
  // The built SDK carries no workspace code. Its tests may use the parsers.
  [SDK]: { may: [SCHEMAS], typesOnly: [SCHEMAS], inTests: [SCHEMAS] },
  'apps/api': { may: [SCHEMAS, BASKET, ENGINE, RISK, DB, SOLANA, EVM, MOCK, SDK] },
  // "As today": it mounts the /risk routes file of apps/api by a relative path.
  'apps/risk-api': { may: [SCHEMAS, DB, RISK, 'apps/api'] },
  'apps/keeper': { may: [SCHEMAS, BASKET, DB, SOLANA, EVM, MOCK] },
  'apps/mcp': { may: [SDK] },
  'apps/web': { may: [SCHEMAS, SDK] },
};

const RULES = {
  1: 'rule 1: schemas imports nothing but zod',
  2: 'rule 2: risk never imports engine, and basket imports only schemas',
  3: 'rule 3: only apps/api and apps/keeper join logic, chains and the database',
  4: 'rule 4: apps/web and apps/mcp never import db, engine or a chain package',
  5: 'rule 5: only apps/keeper and scripts/ import a signing entry',
  6: 'rule 6: no new library reads process.env',
  table: 'not in the "May import" column of the layout table',
} as const;
type Rule = keyof typeof RULES;

// Rule 5. A chain package keeps its key-holding code in these files, behind a `./server` entry,
// and nothing its root entry loads may reach them.
const SIGNING_FILE = /^src\/(sign|signer|wallet|server)(\.[cm]?[jt]sx?$|\/)/;
const SIGNING_SUBPATH = /^(src\/)?(sign|signer|wallet|server)(\.[cm]?[jt]sx?)?(\/|$)/;
// Where a raw EVM private key becomes a signer.
const SIGNER_MODULES = ['viem/accounts'];
const MAY_SIGN = ['apps/keeper'];

type Exemption = { since: string; why: string; covers: readonly (readonly [string, Kind])[] };

// What breaks a rule today and is allowed to, for now. Each entry must still match a violation:
// when the code is fixed the test fails until the entry is deleted.
const EXEMPT: readonly Exemption[] = [
  {
    since: '2026-10-02',
    why: 'In Rodrigo\'s code: the chain-solana root entry re-exports sign.ts and wallet.ts, and the monitor route loads the keypair through it. With LEGACY_STRUCTURER=off the route is not registered. API-2 moves both files behind "./server" and deletes this entry.',
    covers: [
      ['packages/chain-solana/src/index.ts', 'root-reaches-signing'],
      ['apps/api/src/routes/monitor.ts', 'signing'],
    ],
  },
];

// Rule 6 says "new". These read process.env before the rule existed (2026-10-02): the entry points and the
// config of db, the RPC, Jupiter and wallet settings of chain-solana, the LLM settings of the parser.
// A file leaves the list when it stops reading it; nothing is added.
const READ_ENV_BEFORE_THE_RULE: readonly string[] = [
  'packages/chain-solana/src/jupiter.ts',
  'packages/chain-solana/src/rpc.ts',
  'packages/chain-solana/src/wallet.ts',
  'packages/db/drizzle.config.ts',
  'packages/db/src/index.ts',
  'packages/db/src/migrate.ts',
  'packages/engine/src/parser/llm.ts',
];

// ---------------------------------------------------------------------------------------------------------
// The checker.

type Kind =
  | 'import' // a workspace folder the row does not allow
  | 'outside' // an outside package, where the row lists them (schemas)
  | 'leaves-workspace' // a relative path out of the folder that lands in no package
  | 'signing' // a signing entry, from somewhere that may not sign
  | 'root-reaches-signing' // a chain package's root entry loads a signing file
  | 'env' // process.env in a library
  | 'unreadable' // import(x) where x is not a string: the test cannot tell what it loads
  | 'manifest' // package.json lists a workspace folder the row does not allow
  | 'no-row'; // a folder with no row in the table
type Violation = { file: string; line: number; kind: Kind; target: string; rule: Rule };

type Import = { spec: string | null; line: number; typeOnly: boolean; names: string[] | '*' };
type Parsed = { imports: Import[]; envLines: number[]; exported: string[] };
type Unit = { dir: string; name: string; manifest: Record<string, unknown>; files: string[] };

const SKIP = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'target', 'out']);
const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)(__tests__|tests?)\/)/;
const posix = (p: string) => p.split(sep).join('/');

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (SOURCE.test(entry.name)) yield path;
  }
}

function parse(file: string, text: string): Parsed {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const out: Parsed = { imports: [], envLines: [], exported: [] };
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const exportedFlag = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier)) {
      const clause = n.importClause;
      const bindings = clause?.namedBindings;
      const named = bindings && ts.isNamedImports(bindings) ? [...bindings.elements] : [];
      const names = named.map((e) => (e.propertyName ?? e.name).text);
      if (clause?.name) names.push('default');
      out.imports.push({
        spec: n.moduleSpecifier.text,
        line: lineOf(n),
        typeOnly:
          clause !== undefined &&
          (clause.isTypeOnly ||
            (!clause.name && named.length > 0 && named.every((e) => e.isTypeOnly))),
        names: bindings && ts.isNamespaceImport(bindings) ? '*' : names,
      });
    } else if (
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier &&
      ts.isStringLiteralLike(n.moduleSpecifier)
    ) {
      const named = n.exportClause && ts.isNamedExports(n.exportClause) ? n.exportClause : null;
      out.imports.push({
        spec: n.moduleSpecifier.text,
        line: lineOf(n),
        typeOnly:
          n.isTypeOnly ||
          (named !== null &&
            named.elements.length > 0 &&
            named.elements.every((e) => e.isTypeOnly)),
        names: named ? named.elements.map((e) => (e.propertyName ?? e.name).text) : '*',
      });
    } else if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference) &&
      ts.isStringLiteralLike(n.moduleReference.expression)
    ) {
      out.imports.push({
        spec: n.moduleReference.expression.text,
        line: lineOf(n),
        typeOnly: n.isTypeOnly,
        names: '*',
      });
    } else if (ts.isCallExpression(n)) {
      const dynamic = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(n.expression) && n.expression.text === 'require';
      const arg = n.arguments[0];
      if ((dynamic || required) && arg && ts.isStringLiteralLike(arg))
        out.imports.push({ spec: arg.text, line: lineOf(n), typeOnly: false, names: '*' });
      else if (dynamic)
        out.imports.push({ spec: null, line: lineOf(n), typeOnly: false, names: '*' });
    } else if (
      ts.isImportTypeNode(n) &&
      ts.isLiteralTypeNode(n.argument) &&
      ts.isStringLiteralLike(n.argument.literal)
    ) {
      out.imports.push({
        spec: n.argument.literal.text,
        line: lineOf(n),
        typeOnly: true,
        names: '*',
      });
    }

    // process.env, process['env'], const { env } = process, import { env } from 'node:process'.
    const isProcess = (e: ts.Node) =>
      (ts.isIdentifier(e) && e.text === 'process') ||
      (ts.isPropertyAccessExpression(e) && e.name.text === 'process');
    if (
      (ts.isPropertyAccessExpression(n) && n.name.text === 'env' && isProcess(n.expression)) ||
      (ts.isElementAccessExpression(n) &&
        ts.isStringLiteralLike(n.argumentExpression) &&
        n.argumentExpression.text === 'env' &&
        isProcess(n.expression)) ||
      (ts.isVariableDeclaration(n) &&
        ts.isObjectBindingPattern(n.name) &&
        n.initializer !== undefined &&
        isProcess(n.initializer) &&
        n.name.elements.some((e) => (e.propertyName ?? e.name).getText(sf) === 'env')) ||
      (ts.isImportDeclaration(n) &&
        ts.isStringLiteralLike(n.moduleSpecifier) &&
        /^(node:)?process$/.test(n.moduleSpecifier.text) &&
        n.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(n.importClause.namedBindings) &&
        n.importClause.namedBindings.elements.some(
          (e) => (e.propertyName ?? e.name).text === 'env',
        ))
    )
      out.envLines.push(lineOf(n));

    // What the file exports under its own names (used for the signing files only).
    if (exportedFlag(n)) {
      if (ts.isVariableStatement(n))
        for (const d of n.declarationList.declarations)
          if (ts.isIdentifier(d.name)) out.exported.push(d.name.text);
      const named = n as ts.Node & { name?: ts.Node };
      if (named.name && ts.isIdentifier(named.name)) out.exported.push(named.name.text);
    }
    if (ts.isExportDeclaration(n) && !n.moduleSpecifier && n.exportClause) {
      if (ts.isNamedExports(n.exportClause))
        for (const e of n.exportClause.elements) out.exported.push(e.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const ref of sf.referencedFiles)
    out.imports.push({
      spec: ref.fileName.startsWith('.') ? ref.fileName : `./${ref.fileName}`,
      line: sf.getLineAndCharacterOfPosition(ref.pos).line + 1,
      typeOnly: true,
      names: '*',
    });
  for (const ref of sf.typeReferenceDirectives)
    out.imports.push({
      spec: ref.fileName,
      line: sf.getLineAndCharacterOfPosition(ref.pos).line + 1,
      typeOnly: true,
      names: '*',
    });
  return out;
}

function ruleFor(from: string, to: string): Rule {
  const group = (dir: string) =>
    CHAINS.includes(dir) ? 'chain' : dir === DB ? 'db' : LOGIC.includes(dir) ? 'logic' : null;
  if (from === SCHEMAS) return 1;
  if (from === BASKET || (from === RISK && to === ENGINE)) return 2;
  if (
    ['apps/web', 'apps/mcp'].includes(from) &&
    (to === DB || to === ENGINE || group(to) === 'chain')
  )
    return 4;
  const [a, b] = [group(from), group(to)];
  if ((a && b && a !== b) || (from.startsWith('apps/') && b === 'chain')) return 3;
  return 'table';
}

function check(root: string, plant?: string): Violation[] {
  const violations: Violation[] = [];
  const rel = (path: string) => posix(relative(root, path));

  const units: Unit[] = [];
  for (const base of ['packages', 'apps']) {
    if (!existsSync(join(root, base))) continue;
    for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
      const dir = `${base}/${entry.name}`;
      const manifestPath = join(root, dir, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      // A planted file counts only for the run that planted it (see "What this test writes").
      const files = [...walk(join(root, dir))]
        .map(rel)
        .filter((file) => file === plant || !isPlant(root, file))
        .sort();
      units.push({ dir, name: String(manifest.name), manifest, files });
    }
  }
  const parsed = new Map<string, Parsed>();
  for (const unit of units)
    for (const file of unit.files)
      parsed.set(file, parse(file, readFileSync(join(root, file), 'utf8')));
  const unitOfPath = (path: string) =>
    units.find((u) => path === u.dir || path.startsWith(`${u.dir}/`));

  /** Where an import lands: a workspace folder and the path inside it, an outside package, or nowhere. */
  const land = (file: string, spec: string) => {
    if (/^\.{1,2}(\/|$)/.test(spec) || spec.startsWith('/')) {
      const path = rel(resolve(root, dirname(file), spec));
      const unit = unitOfPath(path);
      return unit
        ? { unit, sub: path.slice(unit.dir.length + 1) }
        : { leaves: path, unit: undefined, sub: '' };
    }
    if (/^[@~]\//.test(spec)) return { unit: unitOfPath(file), sub: spec.slice(2) }; // a path alias
    const unit = units.find((u) => spec === u.name || spec.startsWith(`${u.name}/`));
    if (unit) return { unit, sub: spec.slice(unit.name.length + 1) };
    const parts = spec.split('/');
    return {
      unit: undefined,
      sub: '',
      pkg: spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec),
    };
  };

  // Rule 5, first half: what a chain package's root entry loads must not include a signing file.
  // While it does, the names those files export count as a signing entry wherever the root is imported.
  const signingNames = new Map<string, Set<string>>();
  for (const unit of units.filter((u) => CHAINS.includes(u.dir))) {
    const files = new Set(unit.files);
    const fileAt = (path: string) =>
      ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js']
        .map((ext) => path + ext)
        .find((candidate) => files.has(candidate));
    const dot = (unit.manifest.exports as Record<string, unknown> | undefined)?.['.'];
    const main = typeof dot === 'string' ? dot : (unit.manifest.main ?? './src/index.ts');
    const entry = fileAt(posix(join(unit.dir, String(main))));
    const seen = new Set<string>();
    const queue = entry ? [entry] : [];
    for (let file = queue.shift(); file; file = queue.shift()) {
      if (seen.has(file)) continue;
      seen.add(file);
      for (const imp of parsed.get(file)?.imports ?? []) {
        if (imp.spec === null || imp.typeOnly) continue;
        const to = land(file, imp.spec);
        if (to.unit !== unit) continue;
        const next = fileAt(`${unit.dir}/${to.sub}`.replace(/\/$/, ''));
        if (!next) continue;
        const sub = next.slice(unit.dir.length + 1);
        if (!SIGNING_FILE.test(sub)) {
          queue.push(next);
          continue;
        }
        violations.push({
          file,
          line: imp.line,
          kind: 'root-reaches-signing',
          target: next,
          rule: 5,
        });
        const names = signingNames.get(unit.dir) ?? new Set<string>();
        for (const name of parsed.get(next)?.exported ?? []) names.add(name);
        signingNames.set(unit.dir, names);
      }
    }
  }

  for (const unit of units) {
    const row = LAYOUT[unit.dir];
    if (!row) {
      violations.push({
        file: `${unit.dir}/package.json`,
        line: 1,
        kind: 'no-row',
        target: unit.dir,
        rule: 'table',
      });
      continue;
    }
    const allowed = (dir: string, inTest: boolean, typeOnly: boolean) =>
      dir === unit.dir ||
      (inTest && (row.inTests ?? []).includes(dir)) ||
      (row.may.includes(dir) && (typeOnly || !(row.typesOnly ?? []).includes(dir)));

    for (const [field, lenient] of [
      ['dependencies', false],
      ['peerDependencies', false],
      ['devDependencies', true],
    ] as const) {
      for (const dep of Object.keys((unit.manifest[field] as object | undefined) ?? {})) {
        const to = units.find((u) => u.name === dep);
        if (to && !allowed(to.dir, lenient, lenient || !(row.typesOnly ?? []).includes(to.dir)))
          violations.push({
            file: `${unit.dir}/package.json`,
            line: 1,
            kind: 'manifest',
            target: to.dir,
            rule: ruleFor(unit.dir, to.dir),
          });
        if (!to && !lenient && row.outside && !row.outside.includes(dep))
          violations.push({
            file: `${unit.dir}/package.json`,
            line: 1,
            kind: 'outside',
            target: dep,
            rule: ruleFor(unit.dir, dep),
          });
      }
    }

    for (const file of unit.files) {
      const inTest = TEST_FILE.test(file.slice(unit.dir.length + 1));
      const signingFile =
        CHAINS.includes(unit.dir) && SIGNING_FILE.test(file.slice(unit.dir.length + 1));
      const maySign = MAY_SIGN.includes(unit.dir) || inTest;
      const { imports, envLines } = parsed.get(file) ?? { imports: [], envLines: [] };
      const add = (line: number, kind: Kind, target: string, rule: Rule) =>
        violations.push({ file, line, kind, target, rule });

      if (unit.dir.startsWith('packages/') && !inTest)
        for (const line of envLines) add(line, 'env', 'process.env', 6);

      for (const imp of imports) {
        if (imp.spec === null) {
          add(imp.line, 'unreadable', 'import(...)', 'table');
          continue;
        }
        const to = land(file, imp.spec);
        if (to.leaves !== undefined) {
          // Data files at the root (fixtures, content, idl) are not code; anything else out there is.
          if (row.outside || SOURCE.test(to.leaves) || !/\.\w+$/.test(to.leaves))
            add(imp.line, 'leaves-workspace', to.leaves, row.outside ? 1 : 'table');
          continue;
        }
        if (to.pkg !== undefined) {
          const builtinOrVitest = to.pkg.startsWith('node:') || to.pkg === 'vitest';
          if (row.outside && !row.outside.includes(to.pkg) && !(inTest && builtinOrVitest))
            add(imp.line, 'outside', to.pkg, ruleFor(unit.dir, to.pkg));
          if (SIGNER_MODULES.includes(imp.spec) && !maySign && !signingFile)
            add(imp.line, 'signing', imp.spec, 5);
          continue;
        }
        if (!to.unit || to.unit === unit) continue;
        if (!allowed(to.unit.dir, inTest, imp.typeOnly))
          add(imp.line, 'import', to.unit.dir, ruleFor(unit.dir, to.unit.dir));
        if (!CHAINS.includes(to.unit.dir) || maySign) continue;
        const exposed = signingNames.get(to.unit.dir);
        const viaRoot =
          to.sub === '' &&
          exposed !== undefined &&
          (imp.names === '*' || imp.names.some((name) => exposed.has(name)));
        if (SIGNING_SUBPATH.test(to.sub) || viaRoot) add(imp.line, 'signing', to.unit.dir, 5);
      }
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const show = (v: Violation) => `${v.file}:${v.line} ${v.kind} ${v.target} (${RULES[v.rule]})`;
const isExempt = (v: Violation) =>
  EXEMPT.some((e) => e.covers.some(([file, kind]) => file === v.file && kind === v.kind)) ||
  (v.kind === 'env' && READ_ENV_BEFORE_THE_RULE.includes(v.file));

// ---------------------------------------------------------------------------------------------------------
// The tests.

// What this test writes. Two things, both inside the checkout this file is in (`inside` refuses any other
// path), each under a name of its own per run, so two runs in one checkout never meet:
// - one planted file at a time in packages/db/migrations: a watched folder, and one that the other tests
//   which walk the tree while this one runs all skip, so a file that appears and disappears cannot trip them;
// - a made-up repo under node_modules/.cache, which every walker skips and git ignores.
// Each is removed in a `finally`. A killed process runs no `finally`, so a process of its own removes the
// path 30 s later whatever happens to this one, and the next run sweeps what is older than a minute.
// The planted name is in .gitignore, and the checker counts a planted file only for the run that wrote it.
const PLANT_DIR = 'packages/db/migrations';
const PLANT_NAME = /^boundary-plant-[0-9a-f]+\.ts$/;
const PLANT_MARK = '// Planted for a moment by tests/boundaries.test.ts. Safe to delete.\n';
const CACHE_DIR = 'node_modules/.cache/boundaries';

/** A file under the planted name that carries the marker, or that another run has just removed. */
function isPlant(root: string, file: string): boolean {
  if (dirname(file) !== PLANT_DIR || !PLANT_NAME.test(basename(file))) return false;
  try {
    return readFileSync(join(root, file), 'utf8').startsWith(PLANT_MARK);
  } catch {
    return true;
  }
}

function inside(path: string): string {
  const full = resolve(ROOT, path);
  if (!full.startsWith(ROOT + sep)) throw new Error(`${path} is outside ${ROOT}`);
  return full;
}

function removeLater(full: string): void {
  const script =
    "setTimeout(() => require('node:fs').rmSync(process.argv[1], { recursive: true, force: true }), 30000)";
  spawn(process.execPath, ['-e', script, full], { detached: true, stdio: 'ignore' }).unref();
}

function sweep(): void {
  const stale = (full: string) => Date.now() - statSync(full).mtimeMs > 60_000;
  for (const dir of [PLANT_DIR, CACHE_DIR]) {
    if (!existsSync(inside(dir))) continue;
    for (const name of readdirSync(inside(dir))) {
      const full = inside(join(dir, name));
      try {
        const ours =
          dir === CACHE_DIR ||
          (PLANT_NAME.test(name) && readFileSync(full, 'utf8').startsWith(PLANT_MARK));
        if (ours && stale(full)) rmSync(full, { recursive: true, force: true });
      } catch {
        // Another run removed it first.
      }
    }
  }
}

const nameOf = (dir: string) =>
  (JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as { name: string }).name;

/** Plants `source` (after the marker line), runs the checker, removes the file. */
function withPlant(source: string): { file: string; caught: Violation[] } {
  const file = `${PLANT_DIR}/boundary-plant-${randomBytes(6).toString('hex')}.ts`;
  const full = inside(file);
  removeLater(full);
  writeFileSync(full, PLANT_MARK + source, { flag: 'wx' });
  try {
    return { file, caught: check(ROOT, file).filter((v) => v.file === file) };
  } finally {
    rmSync(full, { force: true });
  }
}

describe('import boundaries (DESIGN-VAULT.md section 2)', () => {
  sweep();
  const found = check(ROOT);

  it('finds no import that breaks a rule', () => {
    expect(found.filter((v) => !isExempt(v)).map(show)).toEqual([]);
  });

  it('has no exemption that is no longer needed', () => {
    const stale = EXEMPT.flatMap((e) => e.covers)
      .filter(([file, kind]) => !found.some((v) => v.file === file && v.kind === kind))
      .map(([file, kind]) => `${file} (${kind}): fixed, delete the exemption`);
    const dry = READ_ENV_BEFORE_THE_RULE.filter(
      (file) => !found.some((v) => v.file === file && v.kind === 'env'),
    ).map((file) => `${file}: no longer reads process.env, take it off the list`);
    expect([...stale, ...dry]).toEqual([]);
    for (const e of EXEMPT) expect(e.since, e.why).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('keeps rules 1 to 4 in the table, whatever else a row gains', () => {
    expect(LAYOUT[SCHEMAS]).toEqual({ may: [], outside: ['zod'] });
    expect(LAYOUT[BASKET]?.may).toEqual([SCHEMAS]);
    expect(LAYOUT[RISK]?.may).not.toContain(ENGINE);
    expect(LAYOUT[MOCK]?.may).toEqual([SCHEMAS, BASKET]);
    for (const [dir, row] of Object.entries(LAYOUT)) {
      const reach = [dir, ...row.may];
      const joins = reach.includes(DB) && reach.some((d) => CHAINS.includes(d));
      expect(joins, `${dir} joins a chain and the database`).toBe(
        dir === 'apps/api' || dir === 'apps/keeper',
      );
    }
    for (const dir of ['apps/web', 'apps/mcp'])
      for (const banned of [DB, ENGINE, ...CHAINS]) expect(LAYOUT[dir]?.may).not.toContain(banned);
  });

  it('self-check: catches an import planted in a watched folder, then removes it', () => {
    const { file, caught } = withPlant(
      `import { REGISTRY } from '${nameOf(ENGINE)}';\nexport const n = REGISTRY.length;\n`,
    );
    expect(caught).toEqual([{ file, line: 2, kind: 'import', target: ENGINE, rule: 3 }]);
    expect(existsSync(inside(file))).toBe(false);
  });

  it('self-check: catches a planted `import type` too', () => {
    const { file, caught } = withPlant(
      `// a comment first\nimport type { Asset } from '${nameOf(ENGINE)}';\nexport type A = Asset;\n`,
    );
    expect(caught).toEqual([{ file, line: 3, kind: 'import', target: ENGINE, rule: 3 }]);
    expect(existsSync(inside(file))).toBe(false);
  });

  it('self-check: writes nowhere but this checkout', () => {
    expect(() => inside('../boundary-plant-00.ts')).toThrow(/outside/);
    expect(() => inside('/tmp/boundary-plant-00.ts')).toThrow(/outside/);
    expect(inside(PLANT_DIR)).toBe(join(ROOT, PLANT_DIR));
  });
});

// Every rule, in a made-up repo that has the folders this one does not have yet (basket, sdk, keeper, mcp)
// and another package scope. Each bad line is listed with what it must be caught as; everything else is allowed.
describe('import boundaries: each rule bites', () => {
  mkdirSync(inside(CACHE_DIR), { recursive: true });
  const repo = mkdtempSync(join(inside(CACHE_DIR), 'repo-'));
  removeLater(repo);
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const FILES: Record<string, string> = {
    'packages/schemas/src/index.ts':
      "import { z } from 'zod';\nimport './tx';\nimport { readFileSync } from 'node:fs';\nimport data from '../../../fixtures/x.json';",
    'packages/schemas/src/tx.test.ts':
      "import { it } from 'vitest';\nimport 'node:fs';\nimport 'fast-check';",
    'packages/basket/src/index.ts':
      "import '@x/schemas';\nimport { hash } from 'node:crypto';\nimport '@x/engine';",
    'packages/engine/src/index.ts':
      "import '@x/schemas';\nimport '@x/basket';\nexport const model = process.env.LLM_MODEL;\n// process.env in a comment is not a read",
    'packages/engine/src/x.test.ts': "process.env.X = '1';",
    'packages/risk/src/index.ts':
      "export * from '@x/engine';\nimport '../../engine/src/index';\nimport '../../../scripts/lib';\nimport rows from '../../../fixtures/rows.json';",
    'packages/db/src/index.ts':
      "import '@x/schemas';\nconst { env } = process;\nconst e = await import('@x/chain-evm');",
    'packages/chain-solana/src/index.ts':
      "export * from './build';\nexport type { Sent } from './sign';",
    'packages/chain-solana/src/build.ts':
      "import '@x/schemas';\nimport '@x/chain-mock/contract';\nexport const build = 1;",
    'packages/chain-solana/src/build.test.ts':
      "import { cases } from '@x/chain-mock/contract';\nimport { load } from './wallet';",
    'packages/chain-solana/src/sign.ts': 'export type Sent = string;\nexport const sign = 1;',
    'packages/chain-solana/src/wallet.ts': 'export const load = 1;',
    'packages/chain-solana/src/server.ts': "export * from './sign';\nexport * from './wallet';",
    'packages/chain-evm/src/index.ts':
      "export * from './read';\nexport { signer } from './signer';",
    'packages/chain-evm/src/read.ts':
      "import { privateKeyToAccount } from 'viem/accounts';\nexport const read = 1;",
    'packages/chain-evm/src/signer.ts':
      "import { privateKeyToAccount } from 'viem/accounts';\nexport const signer = 1;",
    'packages/chain-mock/src/index.ts':
      "import '@x/schemas';\nimport '@x/basket';\nimport '@x/chain-mock/contract';\nconst db = require('@x/db');",
    'packages/chain-mock/src/contract.ts': "import { it } from 'vitest';\nexport const cases = 1;",
    'packages/sdk/src/index.ts':
      "import type { Order } from '@x/schemas';\nimport { type Leg } from '@x/schemas';\nimport { parse } from '@x/schemas';\ntype T = import('@x/basket').Target;",
    'packages/sdk/src/guard.test.ts': "import { parse } from '@x/schemas';",
    'packages/new-thing/src/index.ts': "import '@x/schemas';",
    'apps/api/src/server.ts':
      "import '@x/db';\nimport '@x/engine';\nimport { build } from '@x/chain-solana';\nimport '@x/sdk';\nimport { sign } from '@x/chain-solana/server';\nimport { read, signer } from '@x/chain-evm';\nconst m = await import(process.argv[2]);\nconst port = process.env.PORT;",
    'apps/keeper/src/main.ts':
      "import '@x/db';\nimport '@x/basket';\nimport { sign } from '@x/chain-solana/server';\nimport 'viem/accounts';\nimport '@x/engine';",
    'apps/risk-api/src/server.ts': "import '@x/db';\nimport '@x/risk';\nimport '@x/chain-evm';",
    'apps/mcp/src/server.ts': "import '@x/sdk';\nconst engine = require('@x/engine');",
    'apps/web/app/page.tsx':
      "import type { Plan } from '@x/schemas';\nimport { X } from '@/components/X';\nimport type { Db } from '@x/db';\nimport '@x/chain-solana/server';\nexport default () => <X />;",
    'scripts/lib.ts': "import '@x/engine';\nimport '@x/db';\nimport '@x/chain-solana/server';",
    // A workspace package outside packages/ and apps/, as contracts/ is: not read.
    'contracts/script/check.mjs': "import '@x/db';\nimport '@x/chain-solana/server';",
  };
  const DEPS: Record<string, string[]> = {
    'packages/schemas': ['zod', 'lodash'],
    'packages/db': ['@x/schemas', '@x/engine'],
    'apps/web': ['@x/schemas', '@x/sdk', 'next'],
  };
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
    const [base, folder] = file.split('/');
    if (base !== 'packages' && base !== 'apps') continue;
    const dependencies = Object.fromEntries(
      (DEPS[`${base}/${folder}`] ?? []).map((dep) => [dep, '*']),
    );
    writeFileSync(
      join(repo, base ?? '', folder ?? '', 'package.json'),
      JSON.stringify({ name: `@x/${folder}`, main: './src/index.ts', dependencies }),
    );
  }

  writeFileSync(
    join(repo, 'contracts', 'package.json'),
    JSON.stringify({ name: '@x/contracts', dependencies: { '@x/db': '*', '@x/engine': '*' } }),
  );

  it('catches every bad line and nothing else', () => {
    expect(check(repo).map(show)).toEqual(
      [
        `apps/api/src/server.ts:5 signing ${SOLANA} (${RULES[5]})`,
        `apps/api/src/server.ts:6 signing ${EVM} (${RULES[5]})`,
        `apps/api/src/server.ts:7 unreadable import(...) (${RULES.table})`,
        `apps/keeper/src/main.ts:5 import ${ENGINE} (${RULES.table})`,
        `apps/mcp/src/server.ts:2 import ${ENGINE} (${RULES[4]})`,
        `apps/risk-api/src/server.ts:3 import ${EVM} (${RULES[3]})`,
        `apps/web/app/page.tsx:3 import ${DB} (${RULES[4]})`,
        `apps/web/app/page.tsx:4 import ${SOLANA} (${RULES[4]})`,
        `apps/web/app/page.tsx:4 signing ${SOLANA} (${RULES[5]})`,
        `packages/basket/src/index.ts:3 import ${ENGINE} (${RULES[2]})`,
        `packages/chain-evm/src/index.ts:2 root-reaches-signing packages/chain-evm/src/signer.ts (${RULES[5]})`,
        `packages/chain-evm/src/read.ts:1 signing viem/accounts (${RULES[5]})`,
        `packages/chain-mock/src/index.ts:4 import ${DB} (${RULES[3]})`,
        `packages/chain-solana/src/build.ts:2 import ${MOCK} (${RULES.table})`,
        `packages/db/package.json:1 manifest ${ENGINE} (${RULES[3]})`,
        `packages/db/src/index.ts:2 env process.env (${RULES[6]})`,
        `packages/db/src/index.ts:3 import ${EVM} (${RULES[3]})`,
        `packages/db/src/index.ts:3 signing ${EVM} (${RULES[5]})`,
        `packages/engine/src/index.ts:3 env process.env (${RULES[6]})`,
        `packages/new-thing/package.json:1 no-row packages/new-thing (${RULES.table})`,
        `packages/risk/src/index.ts:1 import ${ENGINE} (${RULES[2]})`,
        `packages/risk/src/index.ts:2 import ${ENGINE} (${RULES[2]})`,
        `packages/risk/src/index.ts:3 leaves-workspace scripts/lib (${RULES.table})`,
        `packages/schemas/package.json:1 outside lodash (${RULES[1]})`,
        `packages/schemas/src/index.ts:3 outside node:fs (${RULES[1]})`,
        `packages/schemas/src/index.ts:4 leaves-workspace fixtures/x.json (${RULES[1]})`,
        `packages/schemas/src/tx.test.ts:3 outside fast-check (${RULES[1]})`,
        `packages/sdk/src/index.ts:3 import ${SCHEMAS} (${RULES.table})`,
        `packages/sdk/src/index.ts:4 import ${BASKET} (${RULES.table})`,
      ].sort(),
    );
  });
});
