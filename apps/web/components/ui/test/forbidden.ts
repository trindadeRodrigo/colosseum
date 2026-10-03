import type { Declaration, Root } from 'postcss';
import ts from 'typescript';
import { BLUE_NAMES, colorsIn, isBlueOrViolet, parseColor } from './color';
import { context, resolve } from './css';

// What the design system forbids, as things a program can find (STYLE.md, "Never"):
//   hue     a blue or a violet, in any colour written anywhere (the range is in color.ts)
//   shadow  a box-shadow or a drop-shadow
//   radius  a corner that is not 0 or 2px, outside the composer
//   font    a typeface that is not Newsreader, IBM Plex Sans (with its condensed width) or IBM Plex
//           Mono, or one of the fallbacks the spec lists after them
//   host    a stylesheet or a font fetched from another origin at run time

export type Kind = 'hue' | 'shadow' | 'radius' | 'font' | 'host';
export type Finding = {
  kind: Kind;
  /** What was found, as written. */
  what: string;
  /** For a stylesheet: the selector and at-rules it sits under. */
  where: string;
  /** For a stylesheet: the class names in that selector, without their escapes. */
  classes: string[];
  /** For a stylesheet: the custom property this is, when it is one. */
  variable?: string;
};

const KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

/** The three faces, and the fallbacks the .yml lists after them. Lower case. */
export const FACES = ['newsreader', 'ibm plex sans', 'ibm plex sans condensed', 'ibm plex mono'];
export const FALLBACKS = [
  // working-brand.yml, tokens.typography
  'newsreader variable',
  'newsreader fallback',
  'plex sans fallback',
  'system-ui',
  '-apple-system',
  'segoe ui',
  'arial',
  'arial narrow',
  'sans-serif',
  'georgia',
  'times new roman',
  'serif',
  'ui-monospace',
  'sfmono-regular',
  'menlo',
  'consolas',
  'monospace',
  // the metric-matched fallbacks next/font generates beside each face
  'ibm plex sans fallback',
  'ibm plex mono fallback',
];
const ALLOWED_FAMILIES = new Set([...FACES, ...FALLBACKS]);

/** A comma-separated list, cut at the top level only. */
function list(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let from = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(value.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(value.slice(from));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const family = (name: string) =>
  name
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim()
    .toLowerCase();

/** The families of a `font-family` value that are not allowed. */
export function strangeFamilies(value: string): string[] {
  return list(value)
    .map(family)
    .filter(
      (name) => !ALLOWED_FAMILIES.has(name) && !KEYWORDS.has(name) && !name.startsWith('var('),
    );
}

/** The family part of a `font` shorthand, or null when the value names none. */
function shorthandFamilies(value: string): string | null {
  const m = /(?:^|\s)(?:[\d.]+(?:px|rem|em|%)|var\([^()]*\))(?:\s*\/\s*[^\s]+)?\s+(.+)$/.exec(
    value,
  );
  return m ? (m[1] as string) : null;
}

const RADIUS = /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/;
const SQUARE = new Set(['0', '0px', '2px']);
const NO_SHADOW = new Set(['none', '0 0 #0000', '']);
const TW_SHADOWS = new Set([
  '--tw-shadow',
  '--tw-inset-shadow',
  '--tw-ring-shadow',
  '--tw-inset-ring-shadow',
  '--tw-drop-shadow',
]);
/** The two utilities of the typing box, and the corners they may have (composer.md). */
export const COMPOSER_RADIUS: Record<string, string> = {
  'rounded-composer': '20px',
  'rounded-round': '9999px',
};

const classesOf = (selector: string): string[] =>
  [...selector.matchAll(/\.((?:\\.|[\w-])+)/g)].map((m) =>
    (m[1] as string).replace(/\\(.)/g, '$1'),
  );

/** Everything forbidden in a stylesheet. `vars` resolves `var()` in radius and font values. */
export function scanCss(root: Root, vars: Map<string, string>): Finding[] {
  const found: Finding[] = [];
  const add = (decl: Declaration, kind: Kind, what: string) => {
    const path = context(decl);
    found.push({
      kind,
      what,
      where: path.join(' > ') || '(top level)',
      classes: path.flatMap(classesOf),
      variable: decl.prop.startsWith('--') ? decl.prop : undefined,
    });
  };

  root.walkAtRules('import', (rule) => {
    if (/https?:\/\//.test(rule.params))
      found.push({
        kind: 'host',
        what: `@import ${rule.params}`,
        where: '(top level)',
        classes: [],
      });
  });

  root.walkDecls((decl) => {
    const parent = decl.parent;
    if (parent?.type === 'atrule' && (parent as { name?: string }).name === 'property') return;
    const prop = decl.prop.toLowerCase();
    const value = decl.value.replace(/\s+/g, ' ').trim();
    const selectors = context(decl).join(' ');

    for (const url of value.matchAll(/url\(\s*["']?(https?:\/\/[^"')\s]+)/g))
      add(decl, 'host', `${prop}: ${url[1]}`);

    // hue
    for (const literal of colorsIn(value)) {
      const color = parseColor(literal);
      if (color && isBlueOrViolet(color)) add(decl, 'hue', `${prop}: ${literal}`);
    }
    if (!prop.startsWith('--') || /colou?r|fill|stroke|background/.test(prop))
      for (const word of value.toLowerCase().match(/[a-z]+/g) ?? [])
        if (BLUE_NAMES.has(word) && !/var\(|url\(/.test(value))
          add(decl, 'hue', `${prop}: ${word}`);

    // shadow
    if (prop === 'box-shadow' && !NO_SHADOW.has(value) && !KEYWORDS.has(value)) {
      // Tailwind composes box-shadow from its own variables: the rule that sets one is the finding.
      if (!/^var\(--tw-/.test(value)) add(decl, 'shadow', `${prop}: ${value}`);
    }
    if (TW_SHADOWS.has(prop) && !NO_SHADOW.has(value) && !KEYWORDS.has(value))
      add(decl, 'shadow', `${prop}: ${value}`);
    if (/drop-shadow\(/.test(value)) add(decl, 'shadow', `${prop}: ${value}`);

    // radius
    if (RADIUS.test(prop)) {
      const classes = classesOf(selectors);
      const composer = classes.map((c) => COMPOSER_RADIUS[c]).find(Boolean);
      const resolved = resolve(value, vars);
      const corners = resolved.split(/[\s/]+/).filter(Boolean);
      // inside the embed a corner is the partner's (`--embed-radius`): our 2px recedes there
      const ok =
        /^var\(--embed-radius\b/.test(value) ||
        corners.every((c) => SQUARE.has(c) || KEYWORDS.has(c) || c === composer);
      if (!ok)
        add(decl, 'radius', `${prop}: ${value}${resolved === value ? '' : ` (${resolved})`}`);
    }

    // font
    const families =
      prop === 'font-family' ||
      /^--(tf-)?font-(sans|mono|display|condensed)$/.test(prop) ||
      /^--default-(mono-)?font-family$/.test(prop)
        ? value
        : prop === 'font'
          ? shorthandFamilies(value)
          : null;
    if (families !== null) {
      // the embed takes the partner's faces: its fallbacks are theirs to set
      const partner = /var\(--embed-(font|mono)\b/.test(families);
      const strange = partner ? [] : strangeFamilies(resolve(families, vars));
      if (strange.length) add(decl, 'font', `${prop}: ${strange.join(', ')}`);
    }
  });
  return found;
}

/** Every piece of text in a TypeScript file that is code, not comment: string and template literals. */
export function stringsOf(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const out: string[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node))
      out.push(node.text);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return out;
}

/** The class names a TypeScript file can put on an element: the words of its strings. */
export function classTokens(file: string, text: string): Set<string> {
  return new Set(
    stringsOf(file, text)
      .flatMap((s) => s.split(/\s+/))
      .filter(Boolean),
  );
}

type SourceFinding = { kind: Kind; what: string };

/** Everything forbidden that is written straight into a TypeScript file: colours, inline styles, SVG attributes. */
export function scanSource(file: string, text: string): SourceFinding[] {
  const found: SourceFinding[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const walk = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      const value = node.text;
      for (const literal of colorsIn(value)) {
        const color = parseColor(literal);
        if (color && isBlueOrViolet(color)) found.push({ kind: 'hue', what: literal });
      }
      if (/\b(box-shadow|drop-shadow)\b/.test(value)) found.push({ kind: 'shadow', what: value });
      if (/\bborder-radius\b|\bfont-family\b/.test(value))
        found.push({ kind: /radius/.test(value) ? 'radius' : 'font', what: value });
      if (/https?:\/\/fonts\./.test(value)) found.push({ kind: 'host', what: value });
    }
    const named = (name: ts.PropertyName | ts.JsxAttributeName) =>
      ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText(source);
    if (ts.isPropertyAssignment(node) || ts.isJsxAttribute(node)) {
      const name = named(node.name);
      const value = node.initializer?.getText(source) ?? '';
      if (/^(boxShadow|dropShadow|textShadow)$/.test(name))
        found.push({ kind: 'shadow', what: `${name}: ${value}` });
      if (
        /^border\w*Radius$/.test(name) &&
        !/^["'{]*(0|0px|2|2px)["'}]*$/.test(value) &&
        !/var\(--embed-radius\b/.test(value)
      )
        found.push({ kind: 'radius', what: `${name}: ${value}` });
      if (/^(rx|ry)$/.test(name) && !/^["'{]*0["'}]*$/.test(value))
        found.push({ kind: 'radius', what: `${name}=${value}` });
      if (
        /^(fontFamily|font-family)$/.test(name) &&
        !/var\(--(tf-|embed-)?font|inherit/.test(value)
      )
        found.push({ kind: 'font', what: `${name}: ${value}` });
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}
