import type postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { read, sourceCss } from '../ui/test/css';

// Light and dark with nothing to flash. A person's choice is a cookie the server reads, and it writes
// `light` or `dark` on <html>. With no choice it writes `tf-auto`, and the stylesheet makes the page
// dark when the system is, with the declarations of `.dark` said once more under a media query. The
// two must never differ: a token that is one colour under `.dark` and another under `tf-auto` would
// make the same page look different to two people who both see it dark.

const css = sourceCss();

/** Every declaration under a selector, in order: `prop: value`. */
function declarations(match: (rule: postcss.Rule) => boolean): string[] {
  const found: string[] = [];
  css.walkRules((rule) => {
    if (!match(rule)) return;
    rule.walkDecls((decl) => {
      if (decl.parent === rule) found.push(`${decl.prop}: ${decl.value.replace(/\s+/g, ' ')}`);
    });
  });
  return found;
}

const inMedia = (rule: postcss.Rule, params: string) =>
  rule.parent?.type === 'atrule' && (rule.parent as postcss.AtRule).params === params;
const inLayer = (rule: postcss.Rule) =>
  rule.parent?.type === 'atrule' && (rule.parent as postcss.AtRule).name === 'layer';

describe('the page that follows the system', () => {
  const dark = declarations((rule) => rule.selector === '.dark');
  const auto = declarations(
    (rule) => rule.selector === '.tf-auto' && inMedia(rule, '(prefers-color-scheme: dark)'),
  );

  it('reads both: the dark tokens, and the same under the media query', () => {
    expect(dark.length).toBeGreaterThan(55);
    expect(dark).toContain('color-scheme: dark');
    expect(dark.some((d) => d.startsWith('--background: '))).toBe(true);
    expect(dark.some((d) => d.startsWith('--tf-pin: '))).toBe(true);
    expect(auto.length).toBeGreaterThan(55);
  });

  it('says under `tf-auto` exactly what `.dark` says, token for token', () => {
    expect(auto).toEqual(dark);
  });

  it('is dark only when the system is: `tf-auto` sets nothing outside the media query', () => {
    expect(
      declarations(
        (rule) =>
          /\.tf-auto\b/.test(rule.selector) && !inMedia(rule, '(prefers-color-scheme: dark)'),
      ),
    ).toEqual([]);
    // and the one rule that is in a layer is the smoothing of type, said in both places
    expect(declarations((rule) => rule.selector === '.dark' && inLayer(rule))).toEqual(
      dark.slice(-2),
    );
  });

  it('has no script decide the theme: the document’s class comes from the request', () => {
    const document = read('components/shell/AppDocument.tsx');
    expect(document).toContain('THEME_CLASS[theme]');
    expect(document).toContain('readPreferences()');
    for (const file of [
      'components/shell/AppDocument.tsx',
      'components/shell/AppShell.tsx',
      'app/(app)/layout.tsx',
    ])
      expect(read(file), file).not.toMatch(/dangerouslySetInnerHTML|<script/);
    // the switch changes the class in the page and stores the choice; it reads no storage of its own
    const control = read('components/shell/ThemeSwitch.tsx');
    expect(control).toContain('remember(THEME_COOKIE');
    expect(control).not.toMatch(/localStorage|matchMedia|useEffect/);
  });
});
