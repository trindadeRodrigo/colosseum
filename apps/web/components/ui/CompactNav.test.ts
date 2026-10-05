import { describe, expect, it } from 'vitest';
import { nav } from './test/cases';
import { all, byRole, classes, name, one, render, role, tag, text, ui } from './test/html';

describe('CompactNav (compact-nav.md)', () => {
  const full = render(nav.full);
  const compact = render(nav.compact);
  const bar = (root: typeof full) => one(root, ui('compact-nav-bar'));
  const menu = (root: typeof full) => one(root, (e) => role(e) === 'navigation');

  it('is a header holding a navigation named "Main", with the skip link first', () => {
    const header = one(compact, ui('compact-nav'));
    expect(header.tag).toBe('header');
    expect(name(menu(compact), compact)).toBe('Main');
    const first = header.children[0];
    expect(typeof first === 'object' && first.tag === 'a' && first.attrs.href === '#content').toBe(
      true,
    );
    expect(text(first as never)).toBe('Skip to content');
  });

  it('is fixed and centred, clear of the top edge', () => {
    for (const root of [full, compact])
      expect(classes(bar(root))).toEqual(
        expect.arrayContaining([
          'fixed',
          'left-1/2',
          '-translate-x-1/2',
          'top-[calc(env(safe-area-inset-top,0px)+12px)]',
        ]),
      );
  });

  it('starts as a quiet full-width bar: no fill, no edge, and a menu that cannot be reached', () => {
    const list = classes(bar(full));
    expect(list).toEqual(
      expect.arrayContaining(['bg-transparent', 'border-transparent', 'max-w-page']),
    );
    expect(classes(menu(full))).toEqual(expect.arrayContaining(['invisible', 'opacity-0']));
    expect(one(full, ui('compact-nav')).attrs['data-compact']).toBe('false');
  });

  it('is compact at once when the page has no stage', () => {
    expect(one(compact, ui('compact-nav')).attrs['data-compact']).toBe('true');
    expect(classes(menu(compact))).toContain('visible');
  });

  it('when compact is solid with a hairline and 2px corners: no glass, no blur', () => {
    const list = classes(bar(compact));
    expect(list).toEqual(
      expect.arrayContaining([
        'bg-card',
        'border',
        'border-border',
        'rounded-md',
        'max-w-[min(860px,calc(100%-32px))]',
      ]),
    );
    for (const el of all(compact))
      expect(classes(el).join(' ')).not.toMatch(/blur|backdrop|shadow|\/\d\d\b/);
    expect(list.join(' ')).not.toMatch(/overflow-hidden/); // the focus ring is not clipped
  });

  it('sets the wordmark in the serif, lowercase, smaller when compact, with the mark in the brand wood', () => {
    const word = (root: typeof full) => one(root, (e) => text(e) === 'tenonfi' && e.tag === 'span');
    expect(classes(word(full))).toEqual(
      expect.arrayContaining(['font-display', 'font-normal', 'text-[24px]']),
    );
    expect(classes(word(compact))).toContain('text-[20px]');
    const home = one(compact, (e) => e.attrs['aria-label'] === 'tenonfi home');
    expect(all(home, (e) => classes(e).includes('text-primary'))).toHaveLength(1);
  });

  it('has one filled button, the call to action', () => {
    const filled = all(compact, (e) => e.attrs['data-variant'] === 'primary');
    expect(filled).toHaveLength(1);
    expect(text(filled[0] as never)).toBe('Open app');
    expect(filled[0]?.tag).toBe('a');
  });

  it('marks the section in view and underlines it in the brand wood', () => {
    const current = all(menu(compact), (e) => e.attrs['aria-current'] === 'true');
    expect(current.map(text)).toEqual(['Invest']);
    expect(classes(current[0] as never)).toEqual(
      expect.arrayContaining([
        'aria-[current=true]:decoration-primary',
        'aria-[current=true]:underline-offset-[6px]',
        'hover:bg-accent',
      ]),
    );
  });

  it('below 820px moves the links into a sheet opened by a menu button', () => {
    const button = one(menu(compact), tag('button'));
    expect(button.attrs['aria-label']).toBe('Menu');
    expect(button.attrs['aria-expanded']).toBe('false');
    expect(classes(button)).toEqual(expect.arrayContaining(['size-10', 'min-[820px]:hidden']));
    const sheet = one(compact, ui('compact-nav-sheet'));
    expect(button.attrs['aria-controls']).toBe(sheet.attrs.id);
    expect('hidden' in sheet.attrs).toBe(true);
    expect(classes(sheet)).toEqual(
      expect.arrayContaining(['bg-card', 'border', 'border-border', 'rounded-md']),
    );
    expect(byRole(sheet, 'link')).toHaveLength(3);
    for (const link of all(menu(compact), tag('a')).filter(
      (a) => a.attrs['data-variant'] !== 'primary',
    ))
      expect(classes(link)).toContain('max-[819px]:hidden');
  });

  it('moves only with the seat easing, and not at all under reduced motion', () => {
    const list = classes(bar(compact));
    expect(list).toEqual(
      expect.arrayContaining(['duration-[480ms]', 'ease-seat', 'motion-reduce:transition-none']),
    );
  });
});
