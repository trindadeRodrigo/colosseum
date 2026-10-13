import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fmtFor } from './format';

// Bearing speaks the reader's language: its sentences come from the dictionary, its figures and dates
// from the reader's locale. No file of the section, or of its routes, may set a language of its own.

const WEB = join(import.meta.dirname, '..', '..');
const DIRS = [join(WEB, 'features', 'bearing'), join(WEB, 'app', '(app)', 'analytics')];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : files(path);
    return /\.tsx?$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}
const shipped = DIRS.flatMap(files);

/** Every place a file fixes a language or a locale in place of the reader's. */
export function hardCodedLang(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\blang(?:uage)?\s*[=:]\s*\{?\s*(['"`])(en|pt)[^'"`]*\1/g))
    found.push(m[0]);
  for (const m of text.matchAll(/(['"`])(en-US|pt-BR)\1/g)) found.push(m[0]);
  for (const m of text.matchAll(/\b(dictionary|fmtFor)\(\s*(['"`])(en|pt)/g)) found.push(m[0]);
  return found;
}

describe('the language of Bearing', () => {
  it('reads every file of the section and its routes', () => {
    const names = shipped.map((f) => relative(WEB, f));
    expect(names).toContain('features/bearing/BearingShell.tsx');
    expect(names).toContain('app/(app)/analytics/methodology/page.tsx');
  });

  it('no file sets a language or a locale of its own, but those that choose the reader’s', () => {
    // format.ts holds the formats; parts.tsx picks the reader's; sim.ts falls back to
    // English for a caller that hands no words, which the pages never do; time.ts reads the New York
    // clock's parts to find the time of week, and shows none of them.
    const choosers = [
      'features/bearing/format.ts',
      'features/bearing/parts.tsx',
      'features/bearing/sim.ts',
      'features/bearing/time.ts',
    ];
    const found = shipped
      .filter((f) => !choosers.includes(relative(WEB, f)))
      .flatMap((f) =>
        hardCodedLang(readFileSync(f, 'utf8')).map((hit) => `${relative(WEB, f)}: ${hit}`),
      );
    expect(found).toEqual([]);
  });

  it('bites: a section pinned to English is caught', () => {
    expect(hardCodedLang('<div data-ui="bearing" lang="en">')).toEqual(['lang="en"']);
    expect(hardCodedLang('<Disclaimer lang="en" heading="Not advice" />')).toEqual(['lang="en"']);
    expect(hardCodedLang("const f = fmtFor('en-US');")).toEqual(["'en-US'", "fmtFor('en"]);
    expect(hardCodedLang('<Disclaimer lang={lang} />')).toEqual([]);
  });
});

describe('the figures and dates in the reader’s locale', () => {
  const en = fmtFor('en');
  const pt = fmtFor('pt');

  it('writes Rodrigo’s figures as he does in English', () => {
    expect(en.pct(0.0682)).toBe('6.82%');
    expect(en.usd1(2_570_000)).toBe('$2.6M');
    expect(en.usd(100_000)).toBe('$100,000');
    expect(en.capW(0)).toBe('< $100');
    expect(en.pct(-0.00001)).toBe('−0.00%');
    expect(en.minute('2026-10-03T15:07:00Z')).toBe('2026-10-03 15:07 UTC');
    expect(en.day('2026-10-03T15:07:00Z')).toBe('2026-10-03');
  });

  it('writes them as the app’s Portuguese screens do: pt-BR, comma decimals, US$, the app’s date', () => {
    const plain = (s: string) => s.replace(/ /g, ' ');
    expect(pt.pct(0.0682)).toBe('6,82%');
    expect(plain(pt.usd1(184_100))).toBe('US$ 184,1 mil');
    expect(plain(pt.usd(100_000))).toBe('US$ 100.000');
    expect(plain(pt.minute('2026-10-03T15:07:00Z'))).toBe('3 de out. de 2026, 15:07 UTC');
    expect(plain(pt.day('2026-10-03T15:07:00Z'))).toBe('3 de out. de 2026');
  });
});
