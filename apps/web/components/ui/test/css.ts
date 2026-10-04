import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import tailwind from '@tailwindcss/postcss';
import postcss, { type Declaration, type Root } from 'postcss';

// The stylesheet the app is built from, compiled the way the build compiles it: PostCSS with
// Tailwind's plugin, scanning apps/web for class names. The tests read rules and declarations from it.

export const WEB = join(import.meta.dirname, '..', '..', '..');
export const GLOBALS = join(WEB, 'app', 'globals.css');

let compiled: Promise<Root> | undefined;

/** globals.css as the build emits it (unminified), with every utility the app's source uses. */
export function builtCss(): Promise<Root> {
  compiled ??= postcss([tailwind({ base: WEB, optimize: false })])
    .process(readFileSync(GLOBALS, 'utf8'), { from: GLOBALS })
    .then((result) => result.root);
  return compiled;
}

/** globals.css as written, parsed and not compiled. */
export function sourceCss(): Root {
  return postcss.parse(readFileSync(GLOBALS, 'utf8'), { from: GLOBALS });
}

/** The selectors and at-rules a declaration sits under, outermost first: `@media (…) > .dark`. */
export function context(decl: Declaration): string[] {
  const path: string[] = [];
  for (let at = decl.parent; at && at.type !== 'root'; at = at.parent as typeof at) {
    if (at.type === 'rule') path.unshift((at as postcss.Rule).selector);
    else if (at.type === 'atrule') {
      const rule = at as postcss.AtRule;
      path.unshift(`@${rule.name} ${rule.params}`.trim());
    }
  }
  return path;
}

/** The custom properties declared under a selector, in the stylesheet as written. */
export function variables(root: Root, selector: (s: string) => boolean): Map<string, string> {
  const found = new Map<string, string>();
  root.walkDecls(/^--/, (decl) => {
    const parent = decl.parent;
    if (parent?.type !== 'rule') return;
    const selectors = (parent as postcss.Rule).selectors.map((s) => s.trim());
    if (selectors.some(selector)) found.set(decl.prop, decl.value.replace(/\s+/g, ' ').trim());
  });
  return found;
}

/** Replaces every `var(--x)` it can, from the map, a few levels deep. */
export function resolve(value: string, vars: Map<string, string>): string {
  let out = value;
  for (let depth = 0; depth < 8 && out.includes('var('); depth++) {
    const next = out.replace(
      /var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g,
      (whole, name: string, fallback?: string) => vars.get(name) ?? fallback ?? whole,
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

const SKIP = new Set(['node_modules', '.next', '.turbo']);

/** Every source file of the web app, as a path from apps/web. */
export function* sourceFiles(dir = WEB): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.(tsx?|jsx?|mjs|css)$/.test(name)) yield relative(WEB, path).split(sep).join('/');
  }
}

export const read = (file: string) => readFileSync(join(WEB, file), 'utf8');
