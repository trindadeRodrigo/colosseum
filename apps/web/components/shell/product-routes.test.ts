import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SIGNING_MEMBERS, screenPort } from '../../features/wallet/port';
import { fakePort } from '../../features/wallet/test/fake-port';
import { DEV_ONLY as BUILD_DEV_ONLY } from '../../scripts/check-build.mjs';
import { read, sourceFiles, WEB } from '../ui/test/css';

// What the product's routes are built from, read from the imports themselves. Three rules:
//   1. nothing the product ships imports from a `dev`, `test` or `fixtures` folder;
//   2. the product's routes do not reach the wallet adapter, whose button renders one thing on the
//      server and another in the browser, nor the bar and the providers of the pages not yet rebuilt;
//   3. no screen can reach a key except through the executor of packages/sdk, which runs the guard on
//      the bytes first. The port a screen is handed has no signing member, the whole port and the
//      wallet libraries are importable only inside the wallet's seam, and outside it no signing
//      member is so much as named. One file is let through, on purpose: the order runner
//      (features/order/run-order.ts), which hands the whole port to `execute` and nothing else, and
//      which only the order screen imports.

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
// His landing page (app/(marketing)) and the partner embed (app/(embed)) are held to the same rules as
// the product: they ship to the same people, and must reach no wallet library and no signing member
// either.
const product = routes.filter(
  (file) =>
    file.startsWith('app/(app)/') ||
    file.startsWith('app/(marketing)/') ||
    file.startsWith('app/(embed)/'),
);
const embed = routes.filter((file) => file.startsWith('app/(embed)/'));
const older = routes.filter((file) => file.startsWith('app/(structurer)/'));

describe('the routes of the app', () => {
  it('are the product’s, under one layout, and the pages not yet rebuilt, under theirs', () => {
    expect(product.sort()).toEqual([
      'app/(app)/analytics/[page]/loading.tsx',
      'app/(app)/analytics/[page]/page.tsx',
      'app/(app)/analytics/layout.tsx',
      'app/(app)/analytics/methodology/page.tsx',
      'app/(app)/analytics/page.tsx',
      'app/(app)/goal/page.tsx',
      'app/(app)/indexes/[slug]/buy/loading.tsx',
      'app/(app)/indexes/[slug]/buy/page.tsx',
      'app/(app)/indexes/[slug]/loading.tsx',
      'app/(app)/indexes/[slug]/page.tsx',
      'app/(app)/layout.tsx',
      'app/(app)/monitor/page.tsx',
      'app/(app)/orders/[id]/loading.tsx',
      'app/(app)/orders/[id]/page.tsx',
      'app/(app)/plan/[id]/buy/loading.tsx',
      'app/(app)/plan/[id]/buy/page.tsx',
      'app/(app)/plan/[id]/loading.tsx',
      'app/(app)/plan/[id]/page.tsx',
      'app/(app)/portfolio/exposure/loading.tsx',
      'app/(app)/portfolio/exposure/page.tsx',
      'app/(app)/portfolio/layout.tsx',
      'app/(app)/portfolio/loading.tsx',
      'app/(app)/portfolio/methodology/loading.tsx',
      'app/(app)/portfolio/methodology/page.tsx',
      'app/(app)/portfolio/page.tsx',
      'app/(app)/portfolio/plan/[chain]/[address]/loading.tsx',
      'app/(app)/portfolio/plan/[chain]/[address]/page.tsx',
      'app/(app)/portfolio/rebalancing/loading.tsx',
      'app/(app)/portfolio/rebalancing/page.tsx',
      'app/(app)/publish/page.tsx',
      'app/(app)/shelf/page.tsx',
      'app/(app)/sign-in/page.tsx',
      'app/(app)/vaults/[chain]/[address]/add/loading.tsx',
      'app/(app)/vaults/[chain]/[address]/add/page.tsx',
      'app/(app)/vaults/[chain]/[address]/loading.tsx',
      'app/(app)/vaults/[chain]/[address]/page.tsx',
      'app/(embed)/embed/[chain]/[address]/page.tsx',
      'app/(embed)/embed/page.tsx',
      'app/(embed)/layout.tsx',
      'app/(marketing)/layout.tsx',
      'app/(marketing)/page.tsx',
    ]);
    expect(older.sort()).toEqual([
      // an address no route answers: 404 inside this group's layout, as before there were two
      'app/(structurer)/[...missing]/page.tsx',
      'app/(structurer)/layout.tsx',
      'app/(structurer)/plans/[id]/page.tsx',
    ]);
    // every route is in one group or the other: there is no layout above the two
    expect(routes.filter((file) => !product.includes(file) && !older.includes(file))).toEqual([]);
    expect(files).not.toContain('app/layout.tsx');
  });

  it('give the partner embed a bare root that reaches no wallet, no bar and no font of ours', () => {
    const built = reach(embed);
    const reached = [...built.files];
    // embed-shell.md: no Nav, no wallet, no providers, no brand faces
    expect(reached.filter((file) => file.startsWith('features/wallet/'))).toEqual([
      // the API's address check, a plain function
      'features/wallet/api-url.ts',
    ]);
    for (const file of [
      'components/shell/AppNav.tsx',
      'components/shell/AppDocument.tsx',
      'components/ui/CompactNav.tsx',
      'features/account/AccountProvider.tsx',
      'app/fonts.ts',
      'app/fonts-mono.ts',
    ])
      expect(reached, file).not.toContain(file);
    expect([...built.packages.keys()].sort()).toEqual([
      '@colosseum/schemas',
      'next/headers',
      'next/navigation',
      'react',
    ]);
  });

  it('bites: the product’s own layout does reach the bar, the wallet and the faces', () => {
    const theirs = [...reach(product.filter((f) => f === 'app/(app)/layout.tsx')).files];
    expect(theirs).toContain('components/shell/AppNav.tsx');
    expect(theirs).toContain('app/fonts.ts');
    expect(theirs.some((file) => file.startsWith('features/wallet/'))).toBe(true);
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

  it('is every dev, test and fixtures folder of the app, at any depth, and no package’s', () => {
    for (const file of [
      'features/goal/fixtures/plans.ts',
      'features/goal/test/deep/plan.ts',
      'features/goal/parts/test/plan.ts',
      'components/ui/internal/test/x.tsx',
      'i18n/test/words.ts',
      'lib/test/server.ts',
      'lib/fixtures/answers.ts',
      'app/(app)/dev/wallet/page.dev.tsx',
    ])
      expect(BUILD_DEV_ONLY.test(`../../apps/web/${file}`), file).toBe(true);
    for (const file of [
      '../../node_modules/.pnpm/a@1.0.0/node_modules/a/lib/test/index.js',
      '../../node_modules/b/components/fixtures/x.js',
      '../../apps/web/i18n/tests.ts',
      '../../apps/web/lib/testing.ts',
      '../../apps/web/features/goal/fixtures.ts',
      '../../apps/web/app/(app)/developers/page.tsx',
    ])
      expect(BUILD_DEV_ONLY.test(file), file).toBe(false);
    // and it agrees with this test on every file the app has today
    for (const file of files)
      expect(BUILD_DEV_ONLY.test(`../../apps/web/${file}`), file).toBe(devOnly(file));
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
      'components/PlanView.tsx',
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

describe('rule 3: no screen can reach a key', () => {
  /**
   * The seam: the files of the wallet that hold the whole port, name a signing member, or import a
   * wallet library. Each is here for a reason, and nothing else the product's routes are built from
   * is: everything else is a screen, or serves one.
   */
  const SEAM = new Set([
    // the port: checks a transaction, hands the driver the bytes, checks what comes back
    'features/wallet/port.ts',
    // what a wallet provider has to do, as types
    'features/wallet/driver.ts',
    // the provider itself, and the only file that names it
    'features/wallet/privy-bridge.tsx',
    // holds the whole port, and hands every screen the one with no signing member
    'features/wallet/WalletProvider.tsx',
    // the whole port, for the files listed in SIGNERS below
    'features/wallet/signing.ts',
    // signing in with an outside wallet: it signs the provider's sign-in message, a line of text
    'features/wallet/sign-in-flows.ts',
    // the wallets a browser announces, each with its provider
    'features/wallet/found-wallets.ts',
    // the chains as a wallet library defines them
    'features/wallet/chains.ts',
    // reads the signers of a Solana transaction and checks a signature
    'features/wallet/bytes.ts',
  ]);
  const built = reach(product);
  const screens = [...built.files].filter((file) => !SEAM.has(file));

  /**
   * Who may import the whole port (features/wallet/signing.ts), among everything the app ships: the
   * order runner, which hands it to `execute()` of packages/sdk (AGT-1) as the signer and to nothing
   * else. The executor runs the guard on the bytes of every step before it asks the wallet.
   */
  const RUNNER = 'features/order/run-order.ts';
  const SIGNERS: readonly string[] = [RUNNER];
  const SIGNING = 'features/wallet/signing.ts';
  /** The one screen that imports the runner, and the one route built from it. */
  const ORDER_SCREEN = 'features/order/OrderScreen.tsx';
  const ORDER_ROUTE = 'app/(app)/orders/[id]/page.tsx';

  /** What a file outside the seam may take from a file of the seam, by name. Types are free. */
  const OPEN: Record<string, readonly string[]> = {
    'features/wallet/WalletProvider.tsx': ['useWalletPort', 'useApiFetch', 'WalletProvider'],
  };
  /** More that one file may take, and no other: the runner the whole port, and both the network table. */
  const OPEN_TO: Record<string, Record<string, readonly string[]>> = {
    // the hold says a run is open, so the wallet provider is not mounted again under it
    [RUNNER]: { [SIGNING]: ['useSigningPort', 'useSigningHold'] },
    'features/order/readiness.ts': {
      'features/wallet/chains.ts': ['publicWalletEnv', 'walletChains'],
    },
    // "Try again" for a slow sign-in mounts the wallet provider again: a function that takes and
    // returns nothing, open to the account alone.
    'features/account/AccountProvider.tsx': {
      'features/wallet/WalletProvider.tsx': ['useWalletRestart'],
    },
  };

  /**
   * The files that import packages/sdk: the runner, which calls `execute`; readiness.ts, which reads
   * the committed deployments. (order-view.ts takes the runner's answer types from run-order.ts.)
   */
  const SDK_FILES = [
    RUNNER,
    'features/order/readiness.ts',
    // this app's own node per chain, for the reads it makes itself (WEB-4)
    'features/order/chain-node.ts',
    // a shared portfolio read from that node, and a family's id worked out from its slug (WEB-4)
    'features/shared/chain-recipe.ts',
    // a vault's targets read from that node, which an add of money is held to (WEB-ADD-MONEY): a read
    // of the chain, with no wallet in it
    'features/portfolio/chain-vault.ts',
  ];
  const SDK = '@colosseum/sdk';

  /**
   * The packages a screen imports, all of them. A wallet or chain library is not one, and a new
   * package is added here by someone who looked at what it can do.
   */
  const PACKAGES = [
    '@colosseum/schemas',
    // the three faces, from files committed with the app: nothing is fetched at build (app/fonts.ts)
    'next/font/local',
    'next/headers',
    'next/link',
    'next/navigation',
    'react',
    // the landing's 3D joint (features/landing/joint-scene.ts): a renderer, with no network, storage or
    // wallet of its own; loaded only by the landing page, after its first paint. Its drawing takes
    // three's own line and geometry helpers, which are part of the same package.
    'three',
    'three/examples/jsm/lines/LineMaterial.js',
    'three/examples/jsm/lines/LineSegments2.js',
    'three/examples/jsm/lines/LineSegmentsGeometry.js',
    'three/examples/jsm/utils/BufferGeometryUtils.js',
  ];

  /**
   * What a file takes from the seam that it may not: a value by a name that is not open to it, the
   * whole module, or the module loaded at run time.
   */
  function takes(file: string, text: string): string[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found: string[] = [];
    const seam = (spec: ts.Expression | undefined) => {
      if (!spec || !ts.isStringLiteralLike(spec)) return null;
      const to = target(file, spec.text);
      return to !== null && SEAM.has(to) ? to : null;
    };
    const walk = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const to = seam(node.moduleSpecifier);
        const clause = node.importClause;
        if (to && clause && !clause.isTypeOnly) {
          const open = [...(OPEN[to] ?? []), ...(OPEN_TO[file]?.[to] ?? [])];
          if (clause.name) found.push(`${file} takes the default of ${to}`);
          const names = clause.namedBindings;
          if (names && ts.isNamespaceImport(names)) found.push(`${file} takes all of ${to}`);
          if (names && ts.isNamedImports(names))
            for (const el of names.elements) {
              const name = (el.propertyName ?? el.name).text;
              if (!el.isTypeOnly && !open.includes(name))
                found.push(`${file} takes ${name} from ${to}`);
            }
        }
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
        const to = seam(node.moduleSpecifier);
        if (to) {
          const open = [...(OPEN[to] ?? []), ...(OPEN_TO[file]?.[to] ?? [])];
          const names = node.exportClause;
          if (!names || !ts.isNamedExports(names)) found.push(`${file} hands on all of ${to}`);
          else
            for (const el of names.elements) {
              const name = (el.propertyName ?? el.name).text;
              if (!el.isTypeOnly && !open.includes(name))
                found.push(`${file} hands on ${name} from ${to}`);
            }
        }
      }
      // import('…') and require('…') give the whole module
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const to = seam(node.arguments[0]);
        if (to) found.push(`${file} loads all of ${to}`);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
    return found;
  }

  /**
   * The names of what signs, sends or shows a key: the port's own members, a driver's, a wallet's,
   * and the provider object a browser wallet sets with its one call. Outside the seam none is named
   * at all: not called, not read, not taken apart, not handed on, not written as a string.
   */
  const MEMBERS = new Set([
    'sign',
    'send',
    'signMessage',
    'exportKey',
    'signSolana',
    'signSolanaMessage',
    'signEvm',
    'signEvmMessage',
    'sendEvm',
    'signTransaction',
    'signAllTransactions',
    'signAndSendTransaction',
    'sendTransaction',
    'sendRawTransaction',
    'signTypedData',
    'exportWallet',
    'ethereum',
    'request',
  ]);
  /** A wallet's methods and features that sign or send, as the strings they are asked for by. */
  const ASKS = /^(eth_send|eth_sign|personal_sign|wallet_send|solana:sign)/;

  function names(file: string, text: string): string[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found: string[] = [];
    const named = (name: ts.Node | undefined) =>
      name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && MEMBERS.has(name.text)
        ? name.text
        : null;
    const walk = (node: ts.Node) => {
      // port.sign, port?.sign, port.sign.call(…), onConfirm={port.send}. The one `request` that is not
      // a wallet's is the browser's lock, `navigator.locks.request`, named as that and nothing else.
      if (
        ts.isPropertyAccessExpression(node) &&
        MEMBERS.has(node.name.text) &&
        !(node.name.text === 'request' && node.expression.getText() === 'navigator.locks')
      )
        found.push(`${file} names .${node.name.text}`);
      // a name written out as a string: port['sign'], const k = 'sign', { 'sign': go }, a wallet's
      // method asked for by name
      if (ts.isStringLiteralLike(node) && (MEMBERS.has(node.text) || ASKS.test(node.text)))
        found.push(`${file} writes '${node.text}'`);
      // const { sign } = port, const { send: later } = port
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = named(node.propertyName ?? node.name);
        if (key && !ts.isStringLiteralLike(node.propertyName ?? node.name))
          found.push(`${file} takes ${key}`);
      }
      // ({ sign: go } = port), { send }, { sign() {} }
      if (
        (ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node) ||
          ts.isMethodDeclaration(node)) &&
        ts.isObjectLiteralExpression(node.parent)
      ) {
        const key = named(node.name);
        if (key && !ts.isStringLiteralLike(node.name)) found.push(`${file} writes ${key}:`);
      }
      // <Buy send={…} />
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && MEMBERS.has(node.name.text))
        found.push(`${file} passes ${node.name.text}=`);
      ts.forEachChild(node, walk);
    };
    walk(source);
    return found;
  }

  it('reads every file a product route is built from, the screens among them', () => {
    for (const file of [
      'features/goal/GoalScreen.tsx',
      'features/account/SignInScreen.tsx',
      'features/account/ChainSwitch.tsx',
      'features/account/AccountProvider.tsx',
      'features/wallet/SignIn.tsx',
      'components/shell/AppNav.tsx',
      'components/ui/Composer.tsx',
      'i18n/en.ts',
    ])
      expect(screens).toContain(file);
    for (const file of SEAM) expect(files, file).toContain(file);
  });

  it('hands a screen a port that has no signing member: the object does not carry one', () => {
    const whole = fakePort({ status: 'ready', userId: 'did:privy:test' });
    const screen = screenPort(whole) as Record<string, unknown>;
    for (const member of SIGNING_MEMBERS) {
      expect(typeof whole[member]).toBe('function');
      expect(member in screen, member).toBe(false);
      expect(screen[member], member).toBeUndefined();
    }
    // and it is still the wallet a screen needs
    for (const member of ['status', 'userId', 'accounts', 'active', 'network', 'signIn', 'signOut'])
      expect(member in screen, member).toBe(true);
    // that this is what the provider hands out is seen with the provider mounted:
    // features/wallet/screen-port.events.test.ts
  });

  it('lets no file the app ships import the whole port, but the order runner', () => {
    const importers = shipped.filter((file) =>
      importsOf(file, read(file)).some((edge) => edge.file === SIGNING),
    );
    expect(importers).toEqual([...SIGNERS]);
    // the wallet check under /dev does, and is in no production build
    expect(
      importsOf(
        'features/wallet/dev/DevWallet.tsx',
        read('features/wallet/dev/DevWallet.tsx'),
      ).some((edge) => edge.file === SIGNING),
    ).toBe(true);
  });

  it('lets only the order screen import the runner, and only the order route reach the whole port', () => {
    // a value from the runner: the order screen alone
    const takesRunner = (file: string) => {
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
      return source.statements.some(
        (node) =>
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          target(file, node.moduleSpecifier.text) === RUNNER &&
          !node.importClause?.isTypeOnly,
      );
    };
    expect(shipped.filter(takesRunner)).toEqual([ORDER_SCREEN]);
    // anything else that names the runner takes its types only
    const naming = shipped.filter((file) =>
      importsOf(file, read(file)).some((edge) => edge.file === RUNNER),
    );
    expect(naming.filter((file) => file !== ORDER_SCREEN)).toEqual([
      'features/order/order-view.ts',
    ]);
    expect(takesRunner('features/order/order-view.ts')).toBe(false);
    // by any path: every product route but the order's is built without the whole port
    expect(product).toContain(ORDER_ROUTE);
    expect(reach(product.filter((r) => r !== ORDER_ROUTE)).files.has(SIGNING)).toBe(false);
    expect(reach(product.filter((r) => r !== ORDER_ROUTE)).files.has(RUNNER)).toBe(false);
    expect(reach([ORDER_ROUTE]).files.has(SIGNING)).toBe(true);
    expect(built.files.has(RUNNER)).toBe(true);
  });

  it('hands the whole port to execute() of packages/sdk, and to nothing else', () => {
    const text = read(RUNNER);
    // the port of useSigningPort() is the executor's signer, handed over by that name only
    expect(text).toMatch(/const port = useSigningPort\(\);/);
    expect(text).toMatch(/execute\(order, \{[\s\S]*signer: port,/);
    // every other mention of the port reads something that signs nothing: whether it is the throwaway
    // wallet or the mock (onMock), which account is active, and the hook's dependency list
    const rest = text
      .replace(/^\s*\/\/.*$|\/\*[\s\S]*?\*\//gm, '')
      .replace('const port = useSigningPort();', '')
      .replace('signer: port,', '')
      .replace('onMock(port, chain)', '')
      .replace('port.active(chainFamily(chain))', '')
      .replace('[port, apiFetch, hold]', '');
    expect(rest.match(/\bport\b/g) ?? []).toEqual([]);
    // what the executor is handed beside it is the README's list (features/wallet/README.md, item 3)
    for (const dep of [
      'api: createOrderApi(apiFetch)',
      'deployments,',
      // a plan's terms, or a shared portfolio's (planTermsOf, WEB-4)
      'plan: plan ?? {',
      // a plan's number: the order's, held to one this app works out (gate AGENT-LINK)
      'const basketId = input.terms ? null : planNumberOf(order.basketId, input.plan);',
      "basketId: basketId ?? '',",
      'consents: input.consents',
      'signed: localSigned',
      'chainRead: chainReadFor(',
      'navigator.locks.request(`order:',
    ])
      expect(text, dep).toContain(dep);
    // approvedAgain is handed over only when the screen was given one after needs_review
    expect(text).toMatch(
      /input\.approvedAgain \? \{ approvedAgain: input\.approvedAgain \} : \{\}/,
    );
  });

  it('lets a screen take from the seam only what is open to it, by name', () => {
    expect(screens.flatMap((file) => takes(file, read(file)))).toEqual([]);
  });

  it('keeps wallet and chain libraries inside the seam', () => {
    const used = new Set<string>();
    for (const file of screens)
      for (const edge of importsOf(file, read(file)))
        if (edge.file === null && !(edge.spec === SDK && SDK_FILES.includes(file)))
          used.add(edge.spec);
    expect([...used].sort()).toEqual(PACKAGES);
    // packages/sdk is imported by the runner and the deployment reader, and by order-view.ts for types
    const sdk = shipped.filter((file) =>
      importsOf(file, read(file)).some((edge) => edge.spec === SDK),
    );
    expect(sdk.sort()).toEqual([...SDK_FILES].sort());
    // the wallet provider is named in one file of everything the app ships
    const naming = shipped.filter((file) =>
      importsOf(file, read(file)).some((edge) => edge.spec.startsWith('@privy-io/')),
    );
    expect(naming).toEqual(['features/wallet/privy-bridge.tsx']);
  });

  it('finds no signing member named outside the seam', () => {
    expect(screens.flatMap((file) => names(file, read(file)))).toEqual([]);
  });

  it('bites: every way of getting at a signature that is written in the file', () => {
    const file = 'features/goal/GoalScreen.tsx';
    const caught: Record<string, string> = {
      'a call': "await port.sign('solana', [tx]);",
      'a call on the hook': 'await useWalletPort().send(chain, tx);',
      'an optional call': "await port.sign?.('solana', [tx]);",
      'an alias, called later': "const go = port.sign; await go('solana', [tx]);",
      '.call': "await port.sign.call(port, 'solana', [tx]);",
      '.bind': 'const go = port.send.bind(port); await go(chain, tx);',
      'Reflect.apply': "await Reflect.apply(port.exportKey, port, ['evm']);",
      'a key in brackets': "await port['sign'](chain, txs);",
      'a key in a variable': "const k = 'sign'; await port[k]('solana', [tx]);",
      'taken apart': 'const { sign, accounts } = port;',
      'taken apart under another name': 'const { send: later } = useWalletPort();',
      'taken apart by a string key': "const { 'sign': go } = port; await go('solana', [tx]);",
      'taken apart by assignment': "let go; ({ sign: go } = port); await go('solana', [tx]);",
      'handed on as a prop': 'const a = <Buy onConfirm={port.send} />;',
      'handed on under its own name': 'const a = <Buy send={go} />;',
      'put in an object': 'const tools = { signMessage: go };',
      'the provider’s own hook':
        'const { sendTransaction } = useSendTransaction(); await sendTransaction({ to, value });',
      'a wallet’s provider, asked directly':
        "await wallet.provider.request({ method: 'eth_sendTransaction', params: [tx] });",
      'the wallet a browser sets': 'await window.ethereum.enable();',
      'a Solana wallet’s feature': "wallet.features['solana:signTransaction'];",
    };
    for (const [how, code] of Object.entries(caught))
      expect(names(file, code).length, how).toBeGreaterThan(0);
    // signing in and out are not signing, and neither is the word in a sentence or a label
    for (const fine of [
      "await port.signIn('passkey'); await port.signOut();",
      "const label = t.shell.signIn; const said = 'Sign and send'; const { signedIn } = state;",
      'function send() { onSubmit(text); } send();',
    ])
      expect(names(file, fine), fine).toEqual([]);
  });

  it('bites: what is not written in the file is held by what a screen can reach', () => {
    const file = 'features/goal/GoalScreen.tsx';
    // A key built at run time, and the port handed to a helper: nothing in the text names a member.
    // The port a screen holds has none, so both come to nothing (the test above), and the typecheck
    // refuses both: the screen's port has no such member and takes no string as a key.
    for (const unseen of ["await port['si' + 'gn'](chain, txs);", 'await execute(port, order);'])
      expect(names(file, unseen), unseen).toEqual([]);
    // the browser's lock is not a wallet's request, and a wallet's request still is
    expect(names(file, "await navigator.locks.request('order:1', run);")).toEqual([]);
    expect(names(file, "await wallet.locks.request('order:1', run);")).toHaveLength(1);
    expect(names(file, "await navigator.request('eth_x');")).toHaveLength(1);
    expect(
      Object.keys(screenPort(fakePort())).filter((key) => /sign(?!In|Out)|send|export/i.test(key)),
    ).toEqual([]);
    // The helper itself has to come from somewhere, and each way in is closed:
    // the whole port,
    expect(takes(file, "import { useSigningPort } from '../wallet/signing';")).toEqual([
      `${file} takes useSigningPort from ${SIGNING}`,
    ]);
    // the provider's context, the port's maker, a wallet's own flows,
    expect(takes(file, "import { WalletContext } from '../wallet/WalletProvider';")).toHaveLength(
      1,
    );
    expect(takes(file, "import { createWalletPort } from '../wallet/port';")).toHaveLength(1);
    expect(takes(file, "import * as flows from '../wallet/sign-in-flows';")).toHaveLength(1);
    expect(takes(file, "export * from '../wallet/port';")).toHaveLength(1);
    expect(takes(file, "const seam = await import('../wallet/privy-bridge');")).toHaveLength(1);
    // while what is open stays open, and types are free
    expect(
      takes(
        file,
        "import { useApiFetch, useWalletPort } from '../wallet/WalletProvider'; import type { WebWalletPort } from '../wallet/port'; import { type ScreenPort } from '../wallet/port';",
      ),
    ).toEqual([]);
    // or a library, which a screen may not import
    for (const spec of ['@privy-io/react-auth', 'viem', '@solana/kit', '@colosseum/sdk'])
      expect(PACKAGES, spec).not.toContain(spec);
    // and what is open to the runner is open to it alone
    expect(takes(file, "import { useSigningPort } from '../wallet/signing';")).toHaveLength(1);
    expect(takes(RUNNER, "import { useSigningPort } from '../wallet/signing';")).toEqual([]);
    expect(takes(RUNNER, "import { WalletContext } from '../wallet/WalletProvider';")).toHaveLength(
      1,
    );
  });
});
