import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// features/wallet/dev/ and features/wallet/test/ hold the dev page, its RPC calls and the throwaway
// wallet. Nothing the product ships may import from them. The build check (scripts/check-build.mjs)
// looks at what was built; this reads the imports themselves, which also covers code that is loaded
// with `ssr: false` and so leaves no trace in the server's source maps.
//
// It is not a row of tests/boundaries.test.ts: that table is keyed by workspace folder, and this rule
// is about two folders inside one.

const WEB = join(import.meta.dirname, '..', '..');
const DEV_ONLY = ['features/wallet/dev', 'features/wallet/test'];
/**
 * The one way in: the provider loads the throwaway wallet's bridge when NODE_ENV is not production.
 * `next build` drops that branch, and the build check fails the build if it ever does not.
 */
const ALLOWED = [
  { from: 'features/wallet/WalletProvider.tsx', to: 'features/wallet/test/test-bridge' },
];

const inside = (file: string, folders: string[]) =>
  folders.some((folder) => file === folder || file.startsWith(`${folder}/`));
/** Files that are not shipped: tests, and a route that exists under `next dev` only. */
const notShipped = (file: string) =>
  /\.test\.tsx?$/.test(file) || /\.dev\.tsx$/.test(file) || inside(file, DEV_ONLY);

/** Every import of one file that reaches a dev-only folder, as `from -> to`. */
export function devOnlyImports(file: string, text: string): string[] {
  const found = ts.preProcessFile(text, true, true).importedFiles.map((i) => i.fileName);
  return found.flatMap((spec) => {
    const target = spec.startsWith('@/')
      ? spec.slice(2)
      : spec.startsWith('.')
        ? relative(WEB, resolve(WEB, dirname(file), spec))
            .split(sep)
            .join('/')
        : null;
    if (target === null || !inside(target, DEV_ONLY)) return [];
    if (ALLOWED.some((edge) => edge.from === file && edge.to === target)) return [];
    return [`${file} -> ${target}`];
  });
}

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.(tsx?|mjs|jsx?)$/.test(name)) yield relative(WEB, path).split(sep).join('/');
  }
}

describe('nothing the product ships imports the dev page or the throwaway wallet', () => {
  const shipped = [...sourceFiles(WEB)].filter((file) => !notShipped(file));

  it('reads the files of the app, the provider among them', () => {
    expect(shipped).toContain('features/wallet/WalletProvider.tsx');
    expect(shipped).toContain('app/(app)/layout.tsx');
    expect(shipped).toContain('app/(structurer)/layout.tsx');
    expect(shipped).toContain('components/Nav.tsx');
    expect(shipped).not.toContain('features/wallet/dev/rpc.ts');
    expect(shipped).not.toContain('app/(app)/dev/wallet/page.dev.tsx');
  });

  it('finds no such import', () => {
    const found = shipped.flatMap((file) =>
      devOnlyImports(file, readFileSync(join(WEB, file), 'utf8')),
    );
    expect(found).toEqual([]);
  });

  it('the one allowed import is there, and only behind the check on NODE_ENV', () => {
    const text = readFileSync(join(WEB, ALLOWED[0]?.from ?? ''), 'utf8');
    const imports = ts.preProcessFile(text, true, true).importedFiles.map((i) => i.fileName);
    expect(imports.filter((spec) => spec.includes('/test/') || spec.includes('/dev/'))).toEqual([
      './test/test-bridge',
    ]);
    expect(text.replace(/\s+/g, ' ')).toContain(
      "process.env.NODE_ENV !== 'production' ? dynamic(() => import('./test/test-bridge'), { ssr: false }) : null",
    );
  });

  it('bites: each way of importing is seen, from any folder', () => {
    const cases: Array<[string, string, string[]]> = [
      // What the review shipped unnoticed: a product page that reads a balance with the dev page's RPC.
      [
        'app/(structurer)/monitor/page.tsx',
        "import { evmRpc } from '@/features/wallet/dev/rpc';",
        ['app/(structurer)/monitor/page.tsx -> features/wallet/dev/rpc'],
      ],
      [
        'features/wallet/SignIn.tsx',
        "import { createTestDriver } from './test/test-driver';",
        ['features/wallet/SignIn.tsx -> features/wallet/test/test-driver'],
      ],
      [
        'components/Nav.tsx',
        "const load = () => import('../features/wallet/dev/DevWallet');",
        ['components/Nav.tsx -> features/wallet/dev/DevWallet'],
      ],
      [
        'features/wallet/index.ts',
        "export { DevWallet } from './dev/DevWallet';",
        ['features/wallet/index.ts -> features/wallet/dev/DevWallet'],
      ],
      [
        'lib/api.ts',
        "const rpc = require('@/features/wallet/dev/rpc');",
        ['lib/api.ts -> features/wallet/dev/rpc'],
      ],
      // The allowed import is allowed from the provider alone.
      [
        'features/wallet/privy-bridge.tsx',
        "const T = dynamic(() => import('./test/test-bridge'));",
        ['features/wallet/privy-bridge.tsx -> features/wallet/test/test-bridge'],
      ],
      ['features/wallet/WalletProvider.tsx', "import('./test/test-bridge');", []],
      [
        'features/wallet/WalletProvider.tsx',
        "import './test/test-driver';",
        ['features/wallet/WalletProvider.tsx -> features/wallet/test/test-driver'],
      ],
      // Names that only look alike are not the folders.
      ['features/wallet/port.ts', "import x from './developer'; import y from './testing/z';", []],
      [
        'app/(app)/goal/page.tsx',
        "import { viem } from 'viem'; import t from '@/lib/test/api';",
        [],
      ],
    ];
    for (const [file, text, expected] of cases)
      expect(devOnlyImports(file, text), text).toEqual(expected);
  });
});
