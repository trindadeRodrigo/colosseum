import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WEB } from './css';

// A reader for working-brand.yml, the source of truth of the design system. It is not a YAML parser:
// it reads the few shapes that file uses (nested keys by indentation, `key: "value"`, one-line maps
// and lists), which is all the token tests need, and keeps a YAML library out of the app.

export const SPEC_DIR = join(WEB, '..', '..', '.design', 'branding', 'working-brand', 'patterns');
const YML = readFileSync(join(SPEC_DIR, 'working-brand.yml'), 'utf8').split('\n');

const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string) => line.trim() === '' || line.trim().startsWith('#');

/** The lines under a path of keys (`['tokens', 'color']`), without the key lines themselves. */
export function block(path: readonly string[]): string[] {
  let from = 0;
  let to = YML.length;
  let depth = -1;
  for (const key of path) {
    let found = -1;
    for (let i = from; i < to; i++) {
      const line = YML[i] as string;
      if (isBlank(line) || indentOf(line) <= depth) continue;
      if (line.trim().startsWith(`${key}:`)) {
        found = i;
        break;
      }
    }
    if (found < 0) throw new Error(`working-brand.yml has no ${path.join('.')}`);
    depth = indentOf(YML[found] as string);
    from = found + 1;
    let end = to;
    for (let i = from; i < to; i++) {
      const line = YML[i] as string;
      if (!isBlank(line) && indentOf(line) <= depth) {
        end = i;
        break;
      }
    }
    to = end;
  }
  return YML.slice(from, to).filter((line) => !isBlank(line));
}

const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
/** Cuts a value at its trailing comment, respecting quotes. */
function bare(value: string): string {
  let quote = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string;
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(value[i - 1] as string))) return value.slice(0, i);
  }
  return value;
}

/** `key: value` pairs directly under a path, values unquoted and without their comments. */
export function scalars(path: readonly string[]): Record<string, string> {
  const lines = block(path);
  const depth = Math.min(...lines.map(indentOf));
  const out: Record<string, string> = {};
  for (const line of lines) {
    if (indentOf(line) !== depth) continue;
    const m = /^\s*([\w-]+):\s*(.*)$/.exec(line);
    if (m && bare(m[2] as string).trim() !== '')
      out[m[1] as string] = unquote(bare(m[2] as string));
  }
  return out;
}

/** A one-line map: `{ face: display, size: "clamp(a, b, c)" }`. */
export function inlineMap(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  const inner = value.trim().replace(/^\{|\}$/g, '');
  for (const m of inner.matchAll(/([\w-]+):\s*("[^"]*"|'[^']*'|[^,]+)/g))
    out[m[1] as string] = unquote(m[2] as string);
  return out;
}

/** A one-line list: `[4, 8, 12]` or `["#fff", "#000"]`. */
export const inlineList = (value: string): string[] =>
  value
    .trim()
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(unquote);

/** Numbers written the same way whoever formatted them: `2.9820rem` and `2.982rem` are equal. */
export const normal = (value: string): string =>
  value
    .replace(/-?\d*\.?\d+/g, (n) => String(Number.parseFloat(n)))
    .replace(/\s+/g, '')
    .toLowerCase();
