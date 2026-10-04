import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DEV_ONLY as BUILD_DEV_ONLY } from '../../scripts/check-build.mjs';
import { read, sourceFiles, WEB } from '../ui/test/css';

// What the product's routes are built from, read from the imports themselves. Three rules:
//   1. nothing the product ships imports from a `dev`, `test` or `fixtures` folder;
//   2. the product's routes do not reach the wallet adapter, whose button renders one thing on the
//      server and another in the browser, nor the bar and the providers of the pages not yet rebuilt;
//   3. nothing in product code asks the wallet to sign or to send: the guard that checks the bytes
//      first is not built yet (packages/sdk), so no screen may reach a key.

// next-env.d.ts is Next's own file, written by its build and its dev server.
const files = [...sourceFiles()].filter(
  (file) => /\.(tsx?|mjs|jsx?)$/.test(file) && file !== 'next-env.d.ts',
);

/** A folder of development and test code, wherever it is. */
const devOnly = (file: string) => /(^|\/)(dev|test|fixtures)\//.test(file);
const notShipped = (file: string) =>
  /\.test\.tsx?$/.test(file) || /\.dev\.tsx$/.test(file) || devOnly(file);
const shipped = files.filter((file) => !notShipped(file));

/**
 * The one way in: the provider loads the throwaway wallet's bridge when NODE_ENV is not production.
 * `next build` drops that branch (features/wallet/imports.test.ts holds the import to its guard).
 */
const ALLOWED = 'features/wallet/WalletProvider.tsx -> features/wallet/test/test-bridge.tsx';

type Edge = { spec: string; file: string | null };

/** The file an import names, as a path from apps/web, or null for a package. */
function target(from: string, spec: string): string | null {
  const base = spec.startsWith('@/')
    ? spec.slice(2)
    : spec.startsWith('.')
      ? relative(WEB, resolve(WEB, dirname(from), spec))
          .split(sep)
          .join('/')
      : null;
  if (base === null) return null;
  for (const end of ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx']) {
    const path = join(WEB, `${base}${end}`);
    if (existsSync(path) && statSync(path).isFile()) return `${base}${end}`;
  }
  return base;
}

/** Every import of a file: static, dynamic, re-exported, and of types too. */
export function importsOf(file: string, text: string): Edge[] {
  return ts
    .preProcessFile(text, true, true)
    .importedFiles.map((i) => ({ spec: i.fileName, file: target(file, i.fileName) }));
}

/** Everything a set of files is built from: the files they import, and the files those import. */
function reach(roots: readonly string[]): { files: Set<string>; packages: Map<string, string> } {
  const seen = new Set<string>();
  const packages = new Map<string, string>();
  const walk = (file: string) => {
    if (seen.has(file) || !existsSync(join(WEB, file)) || !/\.(tsx?|mjs|jsx?)$/.test(file)) return;
    seen.add(file);
    for (const edge of importsOf(file, read(file))) {
      if (edge.file === null) packages.set(edge.spec, file);
      else if (`${file} -> ${edge.file}` !== ALLOWED) walk(edge.file);
    }
  };
  for (const root of roots) walk(root);
  return { files: seen, packages };
}

/** A file Next makes a route of, or wraps one in. */
const isRoute = (file: string) =>
  /^app\/(.+\/)?(page|layout|route|template|loading|error|not-found|default)\.[jt]sx?$/.test(file);
const routes = shipped.filter(isRoute);
const product = routes.filter((file) => file.startsWith('app/(app)/'));
const older = routes.filter((file) => file.startsWith('app/(structurer)/'));

describe('the routes of the app', () => {
  it('are the product’s, under one layout, and the pages not yet rebuilt, under theirs', () => {
    expect(product.sort()).toEqual([
      'app/(app)/goal/page.tsx',
      'app/(app)/layout.tsx',
      'app/(app)/sign-in/page.tsx',
    ]);
    expect(older.sort()).toEqual([
      // an address no route answers: 404 inside this group's layout, as before there were two
      'app/(structurer)/[...missing]/page.tsx',
      'app/(structurer)/embed/[id]/layout.tsx',
      'app/(structurer)/embed/[id]/page.tsx',
      'app/(structurer)/layout.tsx',
      'app/(structurer)/monitor/page.tsx',
      'app/(structurer)/page.tsx',
      'app/(structurer)/plans/[id]/page.tsx',
      'app/(structurer)/risk/[asset]/page.tsx',
      'app/(structurer)/risk/methodology/page.tsx',
      'app/(structurer)/risk/page.tsx',
    ]);
    // every route is in one group or the other: there is no layout above the two
    expect(routes.filter((file) => !product.includes(file) && !older.includes(file))).toEqual([]);
    expect(files).not.toContain('app/layout.tsx');
  });
});

describe('rule 1: nothing the product ships imports from a dev, test or fixtures folder', () => {
  const found = shipped.flatMap((file) =>
    importsOf(file, read(file))
      .filter((edge) => edge.file !== null && notShipped(edge.file))
      .map((edge) => `${file} -> ${edge.file}`),
  );

  it('reads the app: the product’s screens and what they are tested with', () => {
    expect(shipped).toContain('features/goal/GoalScreen.tsx');
    expect(shipped).toContain('features/account/SignInScreen.tsx');
    expect(shipped).toContain('components/shell/AppDocument.tsx');
    for (const helper of [
      'features/goal/test/plan.ts',
      'features/wallet/test/fake-port.ts',
      'features/wallet/test/mock-provider.ts',
      'components/ui/fixtures/mock.ts',
      'app/(app)/dev/ui/Showcase.tsx',
    ]) {
      expect(files, helper).toContain(helper);
      expect(shipped, helper).not.toContain(helper);
    }
  });

  it('finds one such import, the guarded one, and no other', () => {
    expect(found).toEqual([ALLOWED]);
  });

  it('finds none at all in what the product’s routes are built from', () => {
    const built = [...reach(product).files];
    expect(built.length).toBeGreaterThan(40);
    expect(built).toContain('features/goal/GoalScreen.tsx');
    expect(built).toContain('features/wallet/privy-bridge.tsx');
    expect(built.filter(notShipped)).toEqual([]);
  });

  it('is what the build check looks for too, after a build', () => {
    for (const file of [
      'features/goal/test/plan.ts',
      'features/account/test/person.ts',
      'features/wallet/test/fake-port.ts',
      'features/wallet/dev/DevWallet.tsx',
      'components/shell/test/cases.tsx',
      'components/ui/fixtures/mock.ts',
      'app/(app)/dev/ui/Showcase.tsx',
    ])
      expect(BUILD_DEV_ONLY.test(`../../apps/web/${file}`), file).toBe(true);
    for (const file of [
      'features/goal/sheet.ts',
      'features/account/person.ts',
      'components/shell/AppNav.tsx',
      'app/(app)/goal/page.tsx',
      'i18n/pt.ts',
    ])
      expect(BUILD_DEV_ONLY.test(`../../apps/web/${file}`), file).toBe(false);
  });

  it('bites: a screen that imports a double, and a page that imports the showcase', () => {
    const bad = (file: string, text: string) =>
      importsOf(file, text).filter((edge) => edge.file !== null && notShipped(edge.file));
    expect(
      bad('features/goal/GoalScreen.tsx', "import { SHEET } from './test/plan';"),
    ).toHaveLength(1);
    expect(
      bad('app/(app)/goal/page.tsx', "const S = () => import('../dev/ui/Showcase');"),
    ).toHaveLength(1);
    expect(
      bad('components/shell/AppNav.tsx', "import { sheetGroups } from '../ui/fixtures/mock';"),
    ).toHaveLength(1);
    expect(
      bad('features/goal/sheet.ts', "import { x } from './testing'; import y from 'vitest';"),
    ).toEqual([]);
  });
});

describe('rule 2: the product’s routes do not reach the wallet adapter', () => {
  const built = reach(product);
  const ADAPTER = /^@solana\/(wallet-adapter|web3\.js)/;

  it('imports no wallet-adapter package and no web3.js, from any file they are built from', () => {
    const used = [...built.packages].filter(([spec]) => ADAPTER.test(spec));
    expect(used).toEqual([]);
    // the wallet comes through the port, which the routes do reach
    expect([...built.packages.keys()]).toContain('@privy-io/react-auth');
  });

  it('does not render the bar or the providers of the pages not yet rebuilt', () => {
    for (const file of [
      'components/Nav.tsx',
      'app/(structurer)/providers.tsx',
      'components/GoalFlow.tsx',
    ])
      expect(built.files.has(file), file).toBe(false);
  });

  it('bites: those pages do reach all three, by the same reading', () => {
    const theirs = reach(older);
    expect(theirs.files.has('components/Nav.tsx')).toBe(true);
    expect(theirs.files.has('app/(structurer)/providers.tsx')).toBe(true);
    expect([...theirs.packages.keys()].filter((spec) => ADAPTER.test(spec)).length).toBeGreaterThan(
      1,
    );
  });
});

describe('rule 3: no screen asks the wallet to sign or to send', () => {
  /** The calls a screen must not make: `anything.sign(…)`, `.send(…)`, `.signMessage(…)`, `.exportKey(…)`. */
  const KEYS = new Set(['sign', 'send', 'signMessage', 'exportKey']);
  function reaches(file: string, text: string): string[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found: string[] = [];
    const walk = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        (ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression))
      ) {
        const name = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : node.expression.argumentExpression.getText(source).replace(/['"`]/g, '');
        if (KEYS.has(name)) found.push(`${file} calls .${name}()`);
      }
      // taking the function off the port to call it later is the same thing
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
        const from = node.propertyName ?? node.name;
        if (ts.isIdentifier(from) && KEYS.has(from.text)) found.push(`${file} takes ${from.text}`);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
    return found;
  }

  /**
   * The wallet seam itself is where those calls are made real: the port, the bridge and the driver.
   * One more file is of the seam: signing in with an outside wallet has that wallet sign the
   * provider's sign-in message, which is a line of text and not a transaction. Everything else the
   * product's routes are built from is a screen, or serves one.
   */
  const SEAM = new Set([
    'features/wallet/port.ts',
    'features/wallet/privy-bridge.tsx',
    'features/wallet/driver.ts',
    'features/wallet/WalletProvider.tsx',
    'features/wallet/sign-in-flows.ts',
  ]);
  const screens = [...reach(product).files].filter((file) => !SEAM.has(file));

  it('reads every file a product route is built from, the screens among them', () => {
    for (const file of [
      'features/goal/GoalScreen.tsx',
      'features/account/SignInScreen.tsx',
      'features/account/ChainPick.tsx',
      'features/wallet/SignIn.tsx',
      'components/shell/AppNav.tsx',
    ])
      expect(screens).toContain(file);
  });

  it('finds no such call', () => {
    expect(screens.flatMap((file) => reaches(file, read(file)))).toEqual([]);
  });

  it('bites: a call, a call by name, and the function taken off the port', () => {
    const file = 'features/goal/GoalScreen.tsx';
    expect(reaches(file, "const signed = await port.sign('solana', [tx]);")).toEqual([
      `${file} calls .sign()`,
    ]);
    expect(reaches(file, 'await useWalletPort().send(chain, tx);')).toHaveLength(1);
    expect(reaches(file, "await port['sign'](chain, txs);")).toHaveLength(1);
    expect(reaches(file, 'const { sign, accounts } = port;')).toEqual([`${file} takes sign`]);
    expect(reaches(file, 'const { send: later } = useWalletPort();')).toHaveLength(1);
    // signing in and out are not signing
    expect(reaches(file, "await port.signIn('passkey'); await port.signOut();")).toEqual([]);
  });
});
