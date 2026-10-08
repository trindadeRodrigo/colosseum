import { describe, expect, it } from 'vitest';
import { card } from './test/cases';
import { all, classes, one, render, role, text, ui } from './test/html';

const root = (node: Parameters<typeof render>[0]) => {
  const tree = render(node);
  return { tree, card: one(tree, ui('card'), 'card') };
};

describe('Card (card.md)', () => {
  it('is a planed face: raised surface, hairline, 10px corners, no shadow', () => {
    const list = classes(root(card.plain).card);
    expect(list).toEqual(
      expect.arrayContaining(['bg-card', 'border', 'border-border', 'rounded-lg']),
    );
    for (const node of Object.values(card))
      for (const el of all(render(node)))
        expect(classes(el).join(' ')).not.toMatch(
          /shadow|rounded-(md|xl|2xl|full|none)\b|backdrop|\b(bg|border)-[a-z0-9-]+\/\d+/,
        );
  });

  it('pads 24px, or 16px when dense, and parts its sections with full-width hairlines', () => {
    const { tree } = root(card.plain);
    expect(classes(one(tree, ui('card-header')))).toContain('p-6');
    expect(classes(one(tree, ui('card-body')))).toEqual(
      expect.arrayContaining(['p-6', 'not-first:border-t', 'not-first:border-border']),
    );
    expect(classes(one(root(card.dense).tree, ui('card-body')))).toContain('p-4');
  });

  it('puts the meta on the right of the header in muted caption text', () => {
    const header = one(root(card.plain).tree, ui('card-header'));
    expect(text(one(header, (e) => role(e) === 'heading'))).toBe('Policy check');
    expect(text(header)).toContain('as of 14:02 UTC');
  });

  it('deepens its hairline on hover and takes the focus ring, when it is a link', () => {
    const { tree, card: c } = root(card.interactive);
    expect(classes(c)).toEqual(
      expect.arrayContaining(['hover:border-input', 'focus-within:outline-2']),
    );
    const link = one(tree, (e) => e.tag === 'a');
    expect(classes(link)).toEqual(expect.arrayContaining(['after:absolute', 'after:inset-0']));
    expect(classes(root(card.plain).card)).not.toContain('hover:border-input');
  });

  it('shows selection with a 2px honey edge and says it', () => {
    const { card: c } = root(card.selected);
    expect(classes(c)).toEqual(expect.arrayContaining(['border-l-2', 'border-l-primary']));
    expect(c.attrs['aria-current']).toBe('page');
  });

  it('when mocked draws the hatch band on its edge and one quiet line, never the word MOCK', () => {
    const { tree, card: c } = root(card.mock);
    expect(all(c, ui('hatch-band'))).toHaveLength(1);
    const line = one(tree, ui('sample-note'));
    expect(text(line)).toBe('Sample figures');
    expect(classes(line)).toEqual(
      expect.arrayContaining(['text-sample-line', 'text-sample-foreground']),
    );
    expect(text(tree)).not.toContain('MOCK');
    expect(classes(c)).not.toContain('tf-hatch');
    expect(all(tree, (e) => classes(e).includes('tf-hatch') && text(e) !== '')).toHaveLength(0);
    // with nothing inside it but a body, and with nothing at all: the card needs no help
    for (const node of [card.mockBody, card.mockEmpty]) {
      const bare = root(node);
      expect(all(bare.card, ui('hatch-band'))).toHaveLength(1);
      expect(all(bare.card, ui('sample-note'))).toHaveLength(1);
    }
    // the line is at the foot: a body is still the first thing in the card
    const body = one(root(card.mockBody).tree, ui('card-body'));
    expect(body.parent?.children[0]).toBe(body);
    expect(body.parent?.parent?.children.at(-1)).toMatchObject({
      attrs: { 'data-ui': 'sample-note' },
    });
  });

  it('says its line in the language it is told, with the test network after it', () => {
    const told = root(card.mockNoted);
    expect(text(one(told.tree, ui('sample-note')))).toBe('Números de exemplo · rede de teste');
    expect(all(told.card, ui('hatch-band'))).toHaveLength(1);
    expect(all(told.tree, (e) => classes(e).includes('tf-hatch') && text(e) !== '')).toHaveLength(
      0,
    );
    // with no note, no note
    expect(text(one(root(card.mockTold).tree, ui('sample-note')))).toBe('Números de exemplo');
  });

  it('has the same 10px corners as a table panel', () => {
    expect(classes(root(card.table).card)).toContain('rounded-lg');
  });

  it('waits and stands empty in words, beside the still lattice', () => {
    const loading = one(render(card.loading), (e) => role(e) === 'status');
    expect(text(loading)).toBe('Loading the plan');
    expect(all(loading, ui('lattice'))).toHaveLength(1);
    const empty = one(render(card.empty), ui('card-empty'));
    expect(text(empty)).toContain('No plans yet.');
    expect(all(empty, ui('button'))).toHaveLength(1);
  });

  it('sets stat cells side by side with hairlines between, a muted label over a display-face value', () => {
    const tree = render(card.stats);
    const rowEl = one(tree, ui('stat-row'));
    expect(classes(rowEl)).toEqual(expect.arrayContaining(['divide-x', 'divide-border']));
    expect(classes(rowEl).join(' ')).not.toMatch(/\bgap-/);
    const stats = all(tree, ui('stat'));
    expect(stats).toHaveLength(2);
    expect(classes(one(stats[0] as never, (e) => e.tag === 'dd'))).toEqual(
      expect.arrayContaining(['font-display', 'font-semibold', 'tabular-nums']),
    );
    // a count has no pin; a rate has one
    expect(all(stats[0] as never, ui('pin'))).toHaveLength(0);
    expect(all(stats[1] as never, ui('pin'))).toHaveLength(1);
  });
});
