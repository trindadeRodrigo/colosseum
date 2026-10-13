import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { utcMinute } from './ExecutionList';
import { shorten } from './format';
import { executions, table } from './test/cases';
import { all, byRole, classes, closest, name, one, render, role, tag, text, ui } from './test/html';

describe('DataTable (data-table.md)', () => {
  const root = render(table.drift);
  const region = one(root, (e) => e.tag === 'section');
  const tableEl = one(region, tag('table'));

  it('sits in a labelled scroll region the keyboard can reach', () => {
    expect(role(region) ?? 'region').toBe('region');
    expect(classes(region)).toContain('overflow-x-auto');
    expect(region.attrs.tabindex ?? region.attrs.tabIndex).toBe('0');
    expect(name(region, root)).toBe('Drift against the plan');
    expect(classes(region)).toEqual(expect.arrayContaining(['focus-visible:outline-2']));
  });

  it('has a caption, shown or only read out', () => {
    const caption = one(tableEl, tag('caption'));
    expect(text(caption)).toBe('Drift against the plan');
    expect(classes(caption)).not.toContain('sr-only');
    const hidden = one(render(table.narrow), tag('caption'));
    expect(classes(hidden)).toContain('sr-only');
  });

  it('scopes every header: columns in a muted head, one row header per row', () => {
    const heads = all(one(tableEl, tag('thead')), tag('th'));
    expect(heads.map(text)).toEqual(['Leg', 'Weight', 'Target', 'Drift', 'Price', 'Status']);
    for (const th of heads) expect(th.attrs.scope).toBe('col');
    expect(
      classes(one(tableEl, (e) => e.tag === 'tr' && closest(e, tag('thead')) !== null)),
    ).toContain('bg-muted');
    const rows = all(one(tableEl, tag('tbody')), tag('tr'));
    expect(rows).toHaveLength(3);
    for (const tr of rows) expect(byRole(tr, 'rowheader')).toHaveLength(1);
  });

  it('sets figures on the right in tabular lining figures of the UI face (mono is for sources)', () => {
    const cells = all(one(tableEl, tag('tbody')), tag('td')).filter((td) =>
      text(td).startsWith('48.0'),
    );
    expect(classes(cells[0] as never)).toEqual(
      expect.arrayContaining(['text-right', 'tabular-nums']),
    );
    expect(classes(cells[0] as never)).not.toContain('font-mono');
    const dash = all(tableEl, tag('td')).find((td) => text(td).includes('6.0%'));
    expect(text(dash as never)).toBe('−6.0%'); // a true minus, from the caller's formatter
  });

  it('gives every priced figure its own pin', () => {
    expect(all(tableEl, ui('pin'))).toHaveLength(3);
  });

  it('never tints a row without the mark and the word', () => {
    const rows = all(one(tableEl, tag('tbody')), tag('tr'));
    const tinted = rows.filter((tr) => classes(tr).some((c) => c.startsWith('bg-status-')));
    expect(tinted).toHaveLength(1);
    const status = one(tinted[0] as never, ui('status'));
    expect(text(status)).toBe('Out of band');
    expect(all(status, ui('status-mark'))[0]?.attrs['data-status']).toBe('watch');
    for (const tr of rows.filter((r) => !tinted.includes(r)))
      expect(all(tr, ui('status'))).toHaveLength(0);
  });

  it('marks a mock row with a hatch band on its edge and the named glyph in its first cell', () => {
    const row = one(tableEl, (e) => e.tag === 'tr' && e.attrs['data-mock'] === 'true');
    const first = one(row, (e) => e.tag === 'th');
    expect(
      all(first, (e) => classes(e).includes('tf-hatch') && e.attrs['data-ui'] !== 'sample-glyph'),
    ).toHaveLength(1);
    expect(all(first, ui('sample-glyph'))).toHaveLength(1);
    expect(text(row)).not.toContain('MOCK');
  });

  it('keeps rows 44px, or 36px dense at the 13px cell, with hairlines between', () => {
    expect(classes(all(tableEl, tag('td'))[0] as never)).toContain('h-(--tf-row-comfortable)');
    const dense = render(table.narrow);
    expect(classes(all(dense, tag('td'))[0] as never)).toContain('h-(--tf-row-dense)');
    expect(classes(one(dense, tag('table')))).toEqual(expect.arrayContaining(['text-b-cell']));
    expect(classes(all(one(tableEl, tag('tbody')), tag('tr'))[0] as never)).toEqual(
      expect.arrayContaining(['border-b', 'border-border']),
    );
  });

  it('says "projected" in the head of a projected column and mutes its values', () => {
    const dense = render(table.narrow);
    expect(all(dense, tag('th')).map(text)).toContain('Terminal balance (projected)');
    expect(classes(all(dense, tag('td')).at(-1) as never)).toContain('text-muted-foreground');
  });

  it('stacks rows as definition lists on a phone, only when there are more than four columns', () => {
    const stacked = one(root, ui('data-table-stacked'));
    expect(classes(stacked)).toContain('sm:hidden');
    expect(classes(region)).toContain('max-sm:hidden');
    expect(all(stacked, tag('dl'))).toHaveLength(3);
    expect(text(stacked)).toContain('Out of band');
    expect(all(stacked, ui('sample-glyph')).length).toBeGreaterThan(0);
    const narrow = render(table.narrow);
    expect(all(narrow, ui('data-table-stacked'))).toHaveLength(0);
    expect(classes(one(narrow, (e) => e.tag === 'section'))).not.toContain('max-sm:hidden');
  });

  it('refuses a row status with no word: it throws instead of tinting the row', () => {
    expect(() => render(createElement(table.wordless))).toThrow(/A status needs its word/);
  });
});

describe('ExecutionList and ExplorerLink (data-table.md)', () => {
  const root = render(executions.list);
  const [confirmed, failed] = all(root, tag('li'));

  it('shows one line per execution and never drops one', () => {
    expect(all(root, tag('li'))).toHaveLength(2);
    expect(text(confirmed as never)).toContain('Swap5.00 USDC → USDY');
    expect(text(confirmed as never)).toContain('confirmed');
  });

  it('shows the time in UTC', () => {
    expect(utcMinute('2026-09-30T14:02:00Z')).toBe('2026-09-30 14:02 UTC');
    expect(utcMinute('2026-09-30T11:02:00-03:00')).toBe('2026-09-30 14:02 UTC');
    expect(text(confirmed as never)).toContain('2026-09-30 14:02 UTC');
  });

  it('shows a time with no zone as it was given, and never calls it UTC', () => {
    const [, , zoneless, vague] = all(render(executions.odd), tag('li'));
    expect(utcMinute('2026-09-30T14:02:00')).toBe('2026-09-30T14:02:00');
    const time = one(zoneless as never, tag('time'));
    expect(text(time)).toBe('2026-09-30T14:02:00');
    expect(text(zoneless as never)).not.toContain('UTC');
    expect('datetime' in time.attrs).toBe(false);
    expect(text(one(vague as never, tag('time')))).toBe('yesterday');
  });

  it('says a status it does not know in words, and never leaves it blank or calls it confirmed', () => {
    const [unknown, inherited] = all(render(executions.odd), tag('li'));
    for (const row of [unknown, inherited]) {
      expect(text(row as never)).toContain('·status unknown·');
      expect(text(row as never)).not.toMatch(/confirmed|failed/);
      expect(all(row as never, ui('status-mark'))).toHaveLength(0);
    }
    expect((unknown as { attrs: Record<string, string> }).attrs['data-status']).toBe('settled');
  });

  it('links the transaction as "Tx", the signature cut in the middle, then the explorer it opens', () => {
    const link = one(confirmed as never, ui('explorer-link'));
    expect(link.tag).toBe('a');
    expect(text(link)).toBe('Tx4kZ9…mX2pthe sample explorer');
    expect(text(one(link, ui('explorer-name')))).toBe('the sample explorer');
    expect(link.attrs).toMatchObject({ target: '_blank', rel: 'noopener' });
    expect(link.attrs['aria-label']).toBe('View transaction 4kZ9…mX2p on the sample explorer');
    expect(classes(link)).toEqual(
      expect.arrayContaining(['font-mono', 'text-honey-text', 'underline']),
    );
    expect(classes(link).join(' ')).not.toMatch(/blue/);
    expect(shorten('4kZ9sampleSignaturemX2p')).toBe('4kZ9…mX2p');
    const named = one(render(executions.link), tag('a'));
    expect(named.attrs['aria-label']).toBe('View transaction 4kZ9…mX2p on Solana Explorer');
  });

  it('says a failure in words with its shape, says it was not retried, and offers no retry', () => {
    expect(text(failed as never)).toContain('failed: slippage exceeded (not retried)');
    expect(all(failed as never, ui('status-mark'))[0]?.attrs['data-status']).toBe('off-track');
    // the only buttons copy a signature, or open the tooltip that shows one whole
    const buttons = all(root, tag('button')).filter((b) => b.attrs['data-ui'] !== 'hint-trigger');
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.attrs['aria-label']).toMatch(/^Copy /);
  });

  it('keeps the row and shows the signature when there is no explorer link', () => {
    const cell = one(failed as never, ui('explorer-link'));
    expect(cell.tag).toBe('span');
    expect(text(cell)).toBe('9aQ1…Lk7c link unavailable');
  });

  it('says "test network" after the glyph of a transaction on one, and not after a mock', () => {
    // EXECUTIONS: the swap is `sandbox`, the failed deposit is `mock`
    expect(text(one(confirmed as never, ui('execution-network')))).toBe('test network');
    expect(text(confirmed as never)).not.toContain('MOCK');
    expect(all(failed as never, ui('execution-network'))).toHaveLength(0);
  });

  it('puts the hatch band and the named glyph on a transaction that is not on mainnet', () => {
    for (const row of [confirmed, failed]) {
      expect(all(row as never, ui('sample-glyph'))).toHaveLength(1);
      expect(all(row as never, ui('hatch-band'))).toHaveLength(1);
      expect((row as { attrs: Record<string, string> }).attrs['data-mock']).toBe('true');
    }
  });

  it('copies the full signature, and announces it', () => {
    const copy = one(confirmed as never, ui('copy-button'));
    expect(copy.attrs['aria-label']).toBe('Copy signature');
    expect(all(confirmed as never, (e) => e.attrs.role === 'status')).toHaveLength(1);
  });
});
