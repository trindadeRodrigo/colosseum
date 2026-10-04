import { describe, expect, it } from 'vitest';
import { exitPlan } from './test/cases';
import { all, byRole, classes, one, render, tag, text, ui } from './test/html';

describe('ExitPlanLine (exit-plan-line.md)', () => {
  const root = render(exitPlan.line);
  const line = one(root, ui('exit-plan-line'));

  it('has a 2px rule in the brand wood on its left and 12px of padding', () => {
    expect(classes(line)).toEqual(expect.arrayContaining(['border-l-2', 'border-primary', 'pl-3']));
  });

  it('names itself, then gives the tiers in time, parted by middle dots', () => {
    expect(text(line)).toContain(
      'Exit plan·up to $4,000 within a day·the rest within 7 days · cost ≤ 0.50%',
    );
  });

  it('draws the dovetail glyph, hidden, and no door or arrow', () => {
    const glyph = one(line, ui('exit-glyph'));
    expect(glyph.attrs['aria-hidden']).toBe('true');
    expect(glyph.attrs.width).toBe('16');
    expect(all(glyph, tag('path'))).toHaveLength(2); // the 16px cut drops the travel line
    expect(all(line, ui('icon'))).toHaveLength(0);
  });

  it('pins the cost, which is an estimate and says so', () => {
    const pin = one(line, ui('pin'));
    expect(pin.attrs['aria-label']).toBe('Source for ≤ 0.50%');
  });

  it('adds the caveat, and states withdrawing the tokens themselves on its own line', () => {
    const lines = all(line, tag('p')).map(text);
    expect(lines).toContain('Weekend exits are slower and cost more.');
    expect(lines).toContain(
      'You can also take the tokens themselves out of the vault at any time.',
    );
  });

  it('marks a mocked tier with the hatch band and the plate, and leaves the others alone', () => {
    const partly = one(render(exitPlan.partlyMock), ui('exit-plan-line'));
    expect(all(partly, ui('hatch-band'))).toHaveLength(1);
    expect(all(partly, ui('mock-plate'))).toHaveLength(1);
  });

  it('says a breach with the mark, the word and the reason', () => {
    const partly = render(exitPlan.partlyMock);
    const status = one(partly, ui('status'));
    expect(status.attrs['data-status']).toBe('off-track');
    expect(text(status)).toBe(
      'Off track: in the rate-shock case, cash within 7 days drops to $2,100.',
    );
  });

  it('shows no number before anything is sourced', () => {
    const bare = one(render(exitPlan.unsourced), ui('exit-plan-line'));
    expect(text(bare)).toBe('Exit plan·Yields and exit costs are sourced live after you connect.');
    expect(text(bare)).not.toMatch(/\d/);
    expect(all(bare, ui('pin'))).toHaveLength(0);
  });
});

describe('ExitPlanPanel (exit-plan-line.md)', () => {
  const root = render(exitPlan.panel);

  it('is a card headed "Access to cash", with the larger glyph and its dashed travel line', () => {
    const heading = one(root, (e) => e.tag === 'h3');
    expect(text(heading)).toBe('Access to cash');
    const glyph = one(heading, ui('exit-glyph'));
    expect(glyph.attrs.width).toBe('24');
    expect(all(glyph, (e) => 'stroke-dasharray' in e.attrs)).toHaveLength(1);
  });

  it('draws one dashed dimension line per tier, hidden from screen readers', () => {
    const drawing = one(root, ui('exit-dimension'));
    expect(drawing.attrs['aria-hidden']).toBe('true');
    const dashed = all(drawing, (e) => classes(e).includes('border-dashed'));
    expect(dashed).toHaveLength(2);
    expect(text(drawing)).toContain('today');
    expect(classes(drawing)).toEqual(expect.arrayContaining(['font-mono']));
  });

  it('carries the content in a table: tier, amount, time, estimated cost, route', () => {
    const table = one(root, tag('table'));
    expect(byRole(table, 'columnheader').map(text)).toEqual([
      'Tier',
      'Amount',
      'Within',
      'Estimated cost',
      'Route',
    ]);
    expect(all(table, ui('pin'))).toHaveLength(1);
    expect(text(table)).toContain('redeem the treasuries');
  });

  it('marks the mocked tier in the table', () => {
    const table = one(root, tag('table'));
    const row = one(table, (e) => e.tag === 'tr' && e.attrs['data-mock'] === 'true');
    expect(all(row, (e) => classes(e).includes('tf-hatch'))).toHaveLength(1);
    expect(all(row, ui('mock-plate')).length).toBeGreaterThanOrEqual(1);
  });
});
