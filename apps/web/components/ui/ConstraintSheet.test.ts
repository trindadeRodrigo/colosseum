import { describe, expect, it } from 'vitest';
import { sheet } from './test/cases';
import { all, byRole, classes, name, one, render, spoken, tag, text, ui } from './test/html';

describe('ConstraintSheet (constraint-sheet.md)', () => {
  describe('valid', () => {
    const root = render(sheet.valid);

    it('says how the goal was read: the heading, the parser line, the goal as written', () => {
      expect(text(one(root, tag('h3')))).toBe('How we read your goal');
      expect(text(root)).toContain('parser: sample-parser (no model) · 2026-10-01T14:02:11Z');
      expect(text(root)).toContain('“R$ 5.000 por mês a partir de 2029, posso precisar em 7 dias”');
    });

    it('marks a reading that came from a fixture with the hatch band and the MOCK plate', () => {
      const plate = one(root, ui('mock-plate'));
      expect(all(plate, ui('hatch-band'))).toHaveLength(1);
      expect(text(plate)).toBe('MOCK: sample data, not live');
    });

    it('groups the fields in fieldsets with legends', () => {
      const groups = byRole(root, 'group');
      expect(groups.map((g) => text(one(g, tag('legend'))))).toEqual([
        'Goal',
        'Profile and risk',
        'Time and cash',
      ]);
    });

    it('labels every field in human words and keeps the schema key to a tooltip', () => {
      const labels = all(root, tag('label'));
      expect(labels.map(text)).toEqual(
        expect.arrayContaining(['Kind', 'Amount (BRL)', 'Profile', 'Risk budget', 'Capital (USD)']),
      );
      for (const label of labels) expect(text(label)).not.toMatch(/[a-z][A-Z]|\.|_/); // no target.kind, fxStance
      expect(labels.find((l) => text(l) === 'Kind')?.attrs.title).toBe('target.kind');
      expect(all(root, tag('option')).map(text)).toContain('Monthly income');
      expect(all(root, tag('option')).map(text).join()).not.toMatch(/monthly_cashflow|high_risk/);
    });

    it('marks what the person changed, and notes that income plans hold no tokenized stocks', () => {
      expect(text(root)).toContain('Income plans don’t include tokenized stocks.');
      expect(text(root)).toContain('edited');
    });

    it('has no error summary and one primary button, ready', () => {
      expect(all(root, ui('sheet-errors'))).toHaveLength(0);
      const primary = all(root, (e) => e.attrs['data-variant'] === 'primary');
      expect(primary).toHaveLength(1);
      expect(spoken(primary[0] as never)).toBe('Build my plan');
      expect(primary[0]?.attrs['aria-disabled']).toBeUndefined();
    });

    it('shows no rate and no price: it holds limits, so it has no pins', () => {
      expect(all(root, ui('pin'))).toHaveLength(0);
      expect(text(root)).not.toMatch(/%/);
    });
  });

  describe('invalid', () => {
    const root = render(sheet.invalid);
    const summary = one(root, ui('sheet-errors'));

    it('lists what does not fit at the top, as an alert that can take focus', () => {
      expect(summary.attrs.role).toBe('alert');
      expect(summary.attrs.tabindex ?? summary.attrs.tabIndex).toBe('-1');
      // an empty field is missing; a wrong value and what belongs to no field do not fit
      expect(text(summary)).toContain(
        '1 thing is still missing. Fill it in to build the plan. 2 things don’t fit yet. Fix them to build the plan.',
      );
      expect(classes(summary)).toEqual(
        expect.arrayContaining(['border-destructive', 'bg-status-off-bg']),
      );
      expect(all(summary, ui('status-mark'))).toHaveLength(1); // a shape, not the colour alone
    });

    it('names each field, says what to change, and links to the field', () => {
      const items = all(summary, tag('li')).map(text);
      expect(items[0]).toBe('Profile: A monthly income goal needs the income profile. Go to field');
      expect(items[1]).toBe('Horizon (months): Enter how many months the plan runs. Go to field');
      expect(items[2]).toBe('The server could not read the sheet. Try again.');
      const links = all(summary, tag('a'));
      expect(links.map((a) => a.attrs.href)).toEqual(['#sheet-profile', '#sheet-horizon']);
      for (const a of links)
        expect(all(root, (e) => e.attrs.id === a.attrs.href?.slice(1))).toHaveLength(1);
    });

    it('marks each wrong field and puts its sentence under it', () => {
      const profile = one(root, (e) => e.attrs.id === 'sheet-profile');
      expect(profile.attrs['aria-invalid']).toBe('true');
      expect(classes(profile)).toContain('border-destructive');
      const described = profile.attrs['aria-describedby']?.split(' ') ?? [];
      const sentence = all(root, (e) => described.includes(e.attrs.id ?? '')).map(text);
      expect(sentence).toContain('A monthly income goal needs the income profile.');
      expect(one(root, (e) => e.attrs.id === 'sheet-risk').attrs['aria-invalid']).toBeUndefined();
    });

    it('blocks the build: the button is disabled, keeps its label and says why', () => {
      const primary = one(root, (e) => e.attrs['data-variant'] === 'primary');
      expect(spoken(primary)).toBe('Build my plan');
      expect(primary.attrs['aria-disabled']).toBe('true');
      const why = one(root, (e) => e.attrs.id === primary.attrs['aria-describedby']);
      expect(text(why)).toBe('Fix the 2 fields above to continue.');
    });

    it('never words an error as the validator would', () => {
      expect(text(root)).not.toMatch(/Expected|received|Invalid|required/i);
    });
  });

  it('can only be handed a parsed sheet: a type error otherwise', () => {
    // `unvalidated` in test/cases.tsx carries the `@ts-expect-error`; `pnpm typecheck` holds it.
    expect(render(sheet.unvalidated)).toBeDefined();
  });

  it('while the goal is read shows the still lattice and no button', () => {
    const root = render(sheet.parsing);
    expect(text(one(root, (e) => e.attrs.role === 'status'))).toBe('Reading your goal…');
    expect(all(root, ui('button'))).toHaveLength(0);
  });

  it('while solving can be read but not changed, and the button says what it is doing', () => {
    const root = render(sheet.solving);
    expect(one(root, ui('constraint-sheet')).attrs['aria-busy']).toBe('true');
    const controls = all(root, (e) => ['input', 'select', 'textarea'].includes(e.tag));
    expect(controls.length).toBeGreaterThan(5);
    for (const c of controls) expect('readOnly' in c.attrs || 'readonly' in c.attrs).toBe(true);
    expect(all(root, tag('select'))).toHaveLength(0);
    expect(controls.map((c) => c.attrs.value)).toContain('Monthly income'); // readable, in human words
    const primary = one(root, (e) => e.attrs['data-variant'] === 'primary');
    expect(primary.attrs['aria-busy']).toBe('true');
    expect(spoken(primary)).toBe('Building your plan…');
    expect(all(root, (e) => e.attrs.role === 'status').map(text)).toContain('Building your plan…');
  });

  it('says so under the sheet when no plan fits, without calling it an error', () => {
    const root = render(sheet.noPlan);
    const card = one(root, ui('sheet-no-plan'));
    expect(text(card)).toContain('No plan fits these limits.');
    expect(text(card)).toContain('The 7-day window binds');
    expect(text(card)).toContain('Edit sheet');
    expect(classes(card).join(' ')).not.toMatch(/destructive|status-off/);
    expect(all(root, ui('sheet-errors'))).toHaveLength(0);
    expect(card.attrs.role).toBeUndefined();
  });

  it('in read mode lists the same labels and values with no wells, and offers "Edit sheet"', () => {
    const root = render(sheet.read);
    expect(all(root, (e) => ['input', 'select', 'textarea'].includes(e.tag))).toHaveLength(0);
    const terms = all(root, tag('dt')).map(text);
    expect(terms).toEqual(expect.arrayContaining(['Kind', 'Amount (BRL)', 'Profile']));
    expect(all(root, tag('dd')).map(text)).toEqual(
      expect.arrayContaining(['Monthly income', '5.000', 'Income']),
    );
    const edit = one(root, ui('button'));
    expect(name(edit, root)).toBe('Edit sheet');
    expect(edit.attrs['data-variant']).toBe('secondary');
  });
});
