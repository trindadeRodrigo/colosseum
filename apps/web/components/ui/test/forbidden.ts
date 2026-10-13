import type { Declaration, Root } from 'postcss';
import ts from 'typescript';
import { BLUE_NAMES, colorsIn, isBlueOrViolet, parseColor } from './color';
import { context, resolve } from './css';

// What the design system forbids, as things a program can find (STYLE.md, "Never"):
//   hue       a blue or a violet, in any colour written anywhere (the range is in color.ts), but
//             chalk, by name, as a line: the focus ring, guides, "today" (CHALK)
//   shadow    a box-shadow, a drop-shadow or a text-shadow (a glow), but the popover's, by name
//   radius    a corner that is not 0, 6, 8, 10 or 16px or a pill, outside the composer (20px)
//   font      a typeface that is not Inter Tight, Inter or IBM Plex Mono, or one of the fallbacks
//             the spec lists after them
//   host      a stylesheet or a font fetched from another origin at run time
//   case      uppercase text (captions and column heads at 12px or less are excused by the test)
//   italic    italic or oblique text
//   weight    a font weight lighter than 400
//   gradient  a gradient, outside the hatch and the light (the glow and the curve fill, by name)
//   blur      a blur or a backdrop filter (glass)
//   align     centred or justified text; the test lists the two places a spec allows it
//
// What STYLE.md also forbids and nothing here finds: a second brand hue, white text on honey, honey
// as the watch colour, patterns behind text, a serif named by a partner, motion that bounces, the
// icons on the list, and anything about words. Those are for review.

export type Kind =
  | 'hue'
  | 'shadow'
  | 'radius'
  | 'font'
  | 'host'
  | 'case'
  | 'italic'
  | 'weight'
  | 'gradient'
  | 'blur'
  | 'align';
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

/** The three faces, and the fallbacks the .yml lists after them. Lower case. No serif (IDENTITY-2). */
export const FACES = ['inter tight', 'inter', 'ibm plex mono'];
export const FALLBACKS = [
  // working-brand.yml, tokens.typography
  'system-ui',
  '-apple-system',
  'segoe ui',
  'arial',
  'sans-serif',
  'ui-monospace',
  'sfmono-regular',
  'menlo',
  'consolas',
  'monospace',
  // the metric-matched fallbacks beside each face (globals.css)
  'inter fallback',
  'inter tight fallback',
  'ibm plex mono fallback',
  // the first name in the variable next/font/local writes for each face: the name of its export in
  // app/fonts.ts, which is no face (each face keeps its own name, and follows it in the variable)
  'intertight',
  'plexmono',
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
/** The corners of the system: square, tags 6px, controls 8px, cards 10px, app tiles 16px, pills. */
export const CORNERS = new Set(['0', '0px', '6px', '8px', '10px', '16px', '9999px']);
const NO_SHADOW = new Set(['none', '0 0 #0000', '']);
const TW_SHADOWS = new Set([
  '--tw-shadow',
  '--tw-inset-shadow',
  '--tw-ring-shadow',
  '--tw-inset-ring-shadow',
  '--tw-drop-shadow',
]);
/** The one utility drawn with a gradient of its own: the 45° hatch (mock-plate.md). */
export const GRADIENT_UTILITY = 'tf-hatch';
/** Light as the only other gradient, by name (STYLE.md, bold bet 5): the glow and the curve fill. */
export const LIGHT = new Set(['--tf-glow', '--tf-glow-l', '--tf-curve-fill']);
/** Chalk, the one blue: a line only, by name (the ring, guides, "today"). Never a fill. */
export const CHALK = new Set([
  '--ring',
  '--sidebar-ring',
  '--info',
  '--tf-chalk',
  '--tf-chalk-tint',
]);
/** The one shadow, by name: popovers and the composer (`shadow-popover`). */
export const POPOVER_SHADOW = 'shadow-popover';

/** A font weight as a number, or null when the value is not one. */
function weightOf(value: string): number | null {
  if (value === 'lighter') return 100;
  const n = Number(value);
  return value !== '' && Number.isFinite(n) ? n : null;
}

/** The utility of the typing box, and the corner it may have (composer.md). */
export const COMPOSER_RADIUS: Record<string, string> = {
  'rounded-composer': '20px',
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

    // hue (chalk is a blue by the rule, and allowed by name)
    if (!CHALK.has(prop))
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
      if (!classesOf(selectors).includes(POPOVER_SHADOW)) add(decl, 'shadow', `${prop}: ${value}`);
    if (/drop-shadow\(/.test(value)) add(decl, 'shadow', `${prop}: ${value}`);
    if (prop === 'text-shadow' && !NO_SHADOW.has(value) && !KEYWORDS.has(value))
      if (!/^var\(--tw-/.test(value)) add(decl, 'shadow', `${prop}: ${value}`);

    const classes = classesOf(selectors);
    // An @font-face says what a file holds, not how text is set: a variable face lists its range.
    const face = parent?.type === 'atrule' && (parent as { name?: string }).name === 'font-face';

    // case: every uppercase is a finding; the test excuses captions and column heads by their size
    if (prop === 'text-transform' && /\buppercase\b/.test(value))
      add(decl, 'case', `${prop}: ${value}`);

    // italic
    if (!face && prop === 'font-style' && /\b(italic|oblique)\b/.test(value))
      add(decl, 'italic', `${prop}: ${value}`);
    if (prop === 'font' && /(^|\s)(italic|oblique)(\s|$)/.test(value))
      add(decl, 'italic', `${prop}: ${value}`);

    // weight: nothing lighter than 400
    if (!face && (prop === 'font-weight' || /^--font-weight-/.test(prop))) {
      const weight = weightOf(resolve(value, vars));
      if (weight !== null && weight < 400) add(decl, 'weight', `${prop}: ${value}`);
    }

    // gradient: only the hatch is drawn with one, and the light is one by name
    if (/gradient\(/.test(value) && !classes.includes(GRADIENT_UTILITY) && !LIGHT.has(prop))
      add(decl, 'gradient', `${prop}: ${value}`);

    // blur and glass
    if (/\bblur\(/.test(value)) add(decl, 'blur', `${prop}: ${value}`);
    else if (/^(-webkit-)?backdrop-filter$/.test(prop) && value !== 'none' && !KEYWORDS.has(value))
      add(decl, 'blur', `${prop}: ${value}`);

    // align
    if (prop === 'text-align' && /^(center|justify)$/.test(value))
      add(decl, 'align', `${prop}: ${value}`);

    // radius
    if (RADIUS.test(prop)) {
      const classes = classesOf(selectors);
      const allowed = classes.map((c) => COMPOSER_RADIUS[c]).find(Boolean);
      const resolved = resolve(value, vars);
      const corners = resolved.split(/[\s/]+/).filter(Boolean);
      // inside the embed a corner is the partner's (`--embed-radius`, and their buttons'
      // `--tf-embed-button-radius`, unset outside the embed): our corners recede there
      const ok =
        /^var\(--(embed-radius|tf-embed-button-radius)\b/.test(value) ||
        corners.every((c) => CORNERS.has(c) || KEYWORDS.has(c) || c === allowed);
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

/** The forbidden things as they read when CSS is written as text. */
const STYLE_TEXT: ReadonlyArray<readonly [Kind, RegExp]> = [
  ['gradient', /gradient\(/],
  ['blur', /\bblur\(|backdrop-filter\s*:\s*(?!none\b)\S/],
  ['case', /text-transform\s*:\s*uppercase/],
  ['italic', /font-style\s*:\s*(italic|oblique)/],
  ['weight', /font-weight\s*:\s*([123]00|lighter)\b/],
  ['align', /text-align\s*:\s*(center|justify)/],
];

/** Everything forbidden that is written straight into a TypeScript file: colours, inline styles, SVG attributes. */
export function scanSource(file: string, text: string): SourceFinding[] {
  const found: SourceFinding[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const walk = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      const value = node.text;
      // chalk is named by its variable (`var(--tf-chalk)`), never written as a colour
      for (const literal of colorsIn(value)) {
        const color = parseColor(literal);
        if (color && isBlueOrViolet(color)) found.push({ kind: 'hue', what: literal });
      }
      if (/\b(box-shadow|drop-shadow)\b/.test(value)) found.push({ kind: 'shadow', what: value });
      if (/\bborder-radius\b|\bfont-family\b/.test(value))
        found.push({ kind: /radius/.test(value) ? 'radius' : 'font', what: value });
      if (/https?:\/\/fonts\./.test(value)) found.push({ kind: 'host', what: value });
      // CSS written as text: a style element, an arbitrary property in a class name
      for (const [kind, written] of STYLE_TEXT)
        if (written.test(value)) found.push({ kind, what: value });
    }
    const named = (name: ts.PropertyName | ts.JsxAttributeName) =>
      ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText(source);
    if (ts.isPropertyAssignment(node) || ts.isJsxAttribute(node)) {
      const name = named(node.name);
      const value = node.initializer?.getText(source) ?? '';
      if (/^(boxShadow|dropShadow|textShadow)$/.test(name))
        found.push({ kind: 'shadow', what: `${name}: ${value}` });
      const bare = value.replace(/^[{"'`\s]+|[}"'`\s]+$/g, '');
      if (name === 'textTransform' && bare === 'uppercase')
        found.push({ kind: 'case', what: `${name}: ${value}` });
      if (name === 'fontStyle' && /^(italic|oblique)/.test(bare))
        found.push({ kind: 'italic', what: `${name}: ${value}` });
      if (name === 'fontWeight' && (weightOf(bare) ?? 400) < 400)
        found.push({ kind: 'weight', what: `${name}: ${value}` });
      if (/^(backdropFilter|WebkitBackdropFilter)$/.test(name) && bare !== 'none')
        found.push({ kind: 'blur', what: `${name}: ${value}` });
      if (name === 'filter' && /blur\(/.test(value))
        found.push({ kind: 'blur', what: `${name}: ${value}` });
      if (name === 'textAlign' && /^(center|justify)$/.test(bare))
        found.push({ kind: 'align', what: `${name}: ${value}` });
      if (
        /^border\w*Radius$/.test(name) &&
        !/^["'{]*(0|6|8|10|16|9999)(px)?["'}]*$/.test(value) &&
        !/var\(--(embed-radius|tf-radius-[a-z]+)\b/.test(value)
      )
        found.push({ kind: 'radius', what: `${name}: ${value}` });
      // a corner drawn in an SVG is a drawing's own geometry (the mark, the pin, a status glyph): it
      // is a finding, and the test excuses it by file (DRAWINGS)
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
