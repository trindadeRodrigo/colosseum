import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ConstraintSheet, type ConstraintSheetProps } from './ConstraintSheet';
import { SHEET_CAPITAL, sheetGroups } from './fixtures/mock';
import { all, one, render, tag, text, ui } from './test/html';

// What the sheet states and the person does not set on it (the chain of their wallet), and what the
// build button points to when what blocks it is not a field.

type Parsed = { parsed: true };
const sheet = (over: Partial<ConstraintSheetProps<Parsed>> = {}) =>
  render(
    createElement(ConstraintSheet<Parsed>, {
      groups: sheetGroups(false),
      capital: SHEET_CAPITAL,
      valid: { parsed: true },
      onChange: () => {},
      onBuild: () => {},
      ...over,
    } as ConstraintSheetProps<Parsed>),
  );

const CHAIN = {
  label: 'Chain',
  value: 'Solana',
  note: 'The chain of your wallet. The plan, its vault and every trade stay there.',
};

describe('ConstraintSheet: what it states beside its fields', () => {
  it('says the fact under the title, with its note, and makes no control of it', () => {
    const root = sheet({ facts: [CHAIN] });
    const facts = one(root, ui('sheet-facts'));
    expect(facts.tag).toBe('dl');
    expect(text(one(facts, tag('dt')))).toBe('Chain');
    expect(all(facts, tag('dd')).map(text)).toEqual(['Solana', CHAIN.note]);
    expect(all(facts, (el) => ['input', 'select', 'textarea', 'button'].includes(el.tag))).toEqual(
      [],
    );
    // it is not among the fields: no label names it, and nothing in a fieldset holds it
    expect(all(root, tag('label')).map(text)).not.toContain('Chain');
    for (const group of all(root, tag('fieldset'))) expect(text(group)).not.toContain('Solana');
  });

  it('says it in read mode too, and draws nothing when there is none', () => {
    const read = render(
      createElement(ConstraintSheet, { mode: 'read', groups: sheetGroups(false), facts: [CHAIN] }),
    );
    expect(text(one(read, ui('sheet-facts')))).toContain('Solana');
    expect(all(sheet(), ui('sheet-facts'))).toEqual([]);
    expect(all(sheet({ facts: [] }), ui('sheet-facts'))).toEqual([]);
  });

  it('can be led to: the sheet takes an id', () => {
    expect(one(sheet({ id: 'limits' }), ui('constraint-sheet')).attrs.id).toBe('limits');
  });
});

describe('ConstraintSheet: blocked by something that is not a field', () => {
  const root = sheet({
    otherIssues: ['Sign in to build: a plan is built for the chain of your wallet.'],
  });
  const primary = one(root, (el) => el.attrs['data-variant'] === 'primary');
  const summary = one(root, ui('sheet-errors'));

  it('blocks the build and points the button at the list that says why', () => {
    expect(primary.attrs['aria-disabled']).toBe('true');
    expect(primary.attrs['aria-describedby']).toBe(summary.attrs.id);
    expect(text(summary)).toContain('Sign in to build');
  });

  it('does not tell the person to fix a field when no field is wrong', () => {
    expect(text(root)).not.toMatch(/Fix the (\d+ )?fields? above/);
  });

  it('still counts the fields that are wrong, and only those, under the button', () => {
    const both = sheet({
      groups: sheetGroups(true),
      valid: null,
      otherIssues: ['The server refused.'],
    });
    const button = one(both, (el) => el.attrs['data-variant'] === 'primary');
    const why = one(both, (el) => el.attrs.id === button.attrs['aria-describedby']);
    expect(text(why)).toBe('Fix the 2 fields above to continue.');
  });
});

describe('ConstraintSheet: the words it takes from the dictionary', () => {
  it('says "edited" and the hidden words after MOCK in the language it is handed', () => {
    const groups = sheetGroups(false).map((group) => ({
      ...group,
      fields: group.fields.map((field, i) => ({ ...field, edited: i === 0 })),
    }));
    const root = sheet({
      groups,
      labels: { edited: 'editado', mockAnnounce: ': dados de exemplo, não são reais' },
      source: {
        method: 'fixture',
        fetchedAt: '2026-10-04T12:00:00Z',
        provenance: 'fixture',
      },
    });
    expect(text(root)).toContain('· editado');
    expect(text(root)).not.toMatch(/· edited/);
    expect(text(one(root, ui('mock-plate')))).toBe('MOCK: dados de exemplo, não são reais');
  });
});
