import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The primitives are tested as the HTML they render: React's own server renderer, read back into a
// small tree. No browser and no DOM library: the app has neither, and the things the specs make
// checkable (roles, labels, which words are on the page, what sits inside what) are all in the markup.

export type El = {
  tag: string;
  attrs: Record<string, string>;
  children: Array<El | string>;
  parent: El | null;
};

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith('#x')) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
    return ENTITIES[code] ?? whole;
  });
}

/** Reads the markup React's server renderer writes. The root is a fragment with tag ''. */
export function parse(html: string): El {
  const root: El = { tag: '', attrs: {}, children: [], parent: null };
  let at = root;
  const token = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g;
  let last = 0;
  for (let m = token.exec(html); m; m = token.exec(html)) {
    if (m.index > last) at.children.push(decode(html.slice(last, m.index)));
    last = token.lastIndex;
    const [, closing, name, rawAttrs, selfClosing] = m;
    if (!name) continue;
    if (closing) {
      if (at.tag !== name) throw new Error(`</${name}> closes <${at.tag}>`);
      at = at.parent ?? root;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (rawAttrs ?? '').matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g))
      attrs[a[1] as string] = decode(a[2] ?? '');
    const el: El = { tag: name, attrs, children: [], parent: at };
    at.children.push(el);
    if (!selfClosing && !VOID.has(name)) at = el;
  }
  if (last < html.length) at.children.push(decode(html.slice(last)));
  if (at !== root) throw new Error(`<${at.tag}> is never closed`);
  return root;
}

/** Renders to static markup and reads it back. */
export function render(node: ReactNode): El {
  return parse(renderToStaticMarkup(node));
}

export function html(node: ReactNode): string {
  return renderToStaticMarkup(node);
}

/** Every element under `root` (not `root` itself) that passes the test, in document order. */
export function all(root: El, test: (el: El) => boolean = () => true): El[] {
  const found: El[] = [];
  const walk = (el: El) => {
    for (const child of el.children) {
      if (typeof child === 'string') continue;
      if (test(child)) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

/** The one element that passes the test. Throws when there is none, or more than one. */
export function one(root: El, test: (el: El) => boolean, what = 'element'): El {
  const found = all(root, test);
  if (found.length !== 1) throw new Error(`expected one ${what}, found ${found.length}`);
  return found[0] as El;
}

/** The text a person reads, in order, without what is hidden from everyone (`hidden`). */
export function text(el: El | string): string {
  if (typeof el === 'string') return el;
  if ('hidden' in el.attrs) return '';
  return el.children.map(text).join('');
}

export const classes = (el: El): string[] => (el.attrs.class ?? '').split(/\s+/).filter(Boolean);
export const hasClass = (el: El, name: string): boolean => classes(el).includes(name);
export const tag = (name: string) => (el: El) => el.tag === name;
export const ui = (name: string) => (el: El) => el.attrs['data-ui'] === name;

const IMPLICIT: Record<string, string> = {
  article: 'article',
  aside: 'complementary',
  button: 'button',
  dialog: 'dialog',
  fieldset: 'group',
  form: 'form',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  header: 'banner',
  li: 'listitem',
  nav: 'navigation',
  ol: 'list',
  select: 'combobox',
  table: 'table',
  textarea: 'textbox',
  ul: 'list',
};

/** The ARIA role: the `role` attribute, or the one the element has by being what it is. */
export function role(el: El): string | null {
  if (el.attrs.role) return el.attrs.role;
  if (el.tag === 'a') return 'href' in el.attrs ? 'link' : null;
  if (el.tag === 'input') {
    const type = el.attrs.type ?? 'text';
    if (type === 'checkbox' || type === 'radio') return type;
    return type === 'hidden' ? null : 'textbox';
  }
  if (el.tag === 'th') return el.attrs.scope === 'row' ? 'rowheader' : 'columnheader';
  return IMPLICIT[el.tag] ?? null;
}

export const byRole = (root: El, name: string): El[] => all(root, (el) => role(el) === name);

/**
 * The accessible name, as far as markup alone gives it: aria-label, then aria-labelledby, then the
 * `<label for>` of a form control, then the text inside.
 */
export function name(el: El, root: El): string {
  if (el.attrs['aria-label']) return el.attrs['aria-label'];
  const ids = el.attrs['aria-labelledby'];
  if (ids)
    return ids
      .split(/\s+/)
      .map((id) => text(one(root, (e) => e.attrs.id === id, `#${id}`)))
      .join(' ');
  if (el.attrs.id) {
    const label = all(root, (e) => e.tag === 'label' && e.attrs.for === el.attrs.id)[0];
    if (label) return text(label);
  }
  return text(el).trim();
}

/** The nearest ancestor that passes the test, or null. */
export function closest(el: El, test: (el: El) => boolean): El | null {
  for (let at = el.parent; at; at = at.parent) if (test(at)) return at;
  return null;
}
