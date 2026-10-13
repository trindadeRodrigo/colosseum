import { DISCLAIMER } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { embed } from './test/cases';
import { all, classes, html, one, render, role, tag, text, ui } from './test/html';

describe('EmbedShell (embed-shell.md)', () => {
  const root = render(embed.ready);
  const shell = one(root, ui('embed-shell'));

  it('is a labelled section in the plan’s language, not a main: the host owns the landmarks', () => {
    expect(shell.tag).toBe('section');
    expect(shell.attrs['aria-label']).toBe('Plan by tenonfi');
    expect(shell.attrs.lang).toBe('en');
    expect(all(root, (e) => ['main', 'nav', 'header'].includes(e.tag))).toHaveLength(0);
  });

  it('takes the partner skin through the tf-embed scope', () => {
    expect(classes(shell)).toContain('tf-embed');
  });

  it('has no navigation, no wallet and nothing to sign', () => {
    expect(all(root, (e) => role(e) === 'navigation')).toHaveLength(0);
    const buttons = all(root, tag('button')).filter(
      // a pin, what its popover holds (its details, a copy of the source or of an address), and the
      // tooltip of a signature cut short
      (b) =>
        ![
          'pin',
          'copy-button',
          'pin-details',
          'pin-copy',
          'pin-copy-address',
          'hint-trigger',
        ].includes(b.attrs['data-ui'] ?? ''),
    );
    expect(buttons).toHaveLength(0);
    expect(html(embed.ready)).not.toMatch(/wallet|Sign in|Connect/i);
  });

  it('sets the title and the lead in em of the partner’s text, never in the serif', () => {
    const title = one(shell, tag('h2'));
    expect(text(title)).toBe('Apartment fund');
    expect(classes(title)).toEqual(
      expect.arrayContaining([
        'text-[length:var(--tf-e-title)]',
        '@max-[359px]:text-[length:var(--tf-e-lead)]',
      ]),
    );
    expect(html(embed.ready)).not.toMatch(/font-display|Inter Tight/);
    for (const el of all(shell))
      expect(classes(el).join(' ')).not.toMatch(/text-(display|h1|h2|h3)\b/);
  });

  it('keeps what survives: pins, the hatch with its named glyph, the disclaimer in full, explorer links', () => {
    expect(all(shell, ui('pin')).length).toBeGreaterThan(0);
    expect(all(shell, ui('sample-glyph')).length).toBeGreaterThan(0);
    expect(text(shell)).not.toContain('MOCK');
    expect(text(one(shell, ui('disclaimer')))).toBe(DISCLAIMER.en);
    expect(all(shell, ui('explorer-link')).length).toBeGreaterThan(0);
  });

  it('makes the credit a target a finger can hit: 24px tall at least (WCAG 2.5.8)', () => {
    const credit = one(render(embed.ready), ui('embed-credit'));
    expect(classes(credit)).toEqual(expect.arrayContaining(['inline-flex', 'min-h-6']));
  });

  it('credits the brand at the foot, in the partner’s muted colour, linking to the public plan', () => {
    const credit = one(shell, ui('embed-credit'));
    expect(text(credit)).toBe('Powered bytenonfi');
    expect(credit.attrs).toMatchObject({ target: '_blank', rel: 'noopener' });
    const line = credit.parent;
    expect(classes(line as never)).toEqual(
      expect.arrayContaining(['text-[length:var(--tf-e-credit)]', 'text-muted-foreground']),
    );
    expect(shell.children.at(-1)).toBe(line);
  });

  it('puts the schedule beside the plan when wide, and behind a disclosure when very narrow', () => {
    const beside = one(shell, ui('embed-schedule'));
    expect(classes(beside)).toContain('@max-[359px]:hidden');
    const disclosure = one(shell, ui('embed-schedule-disclosure'));
    expect(disclosure.tag).toBe('details');
    expect(classes(disclosure)).toContain('@min-[360px]:hidden');
    expect(text(one(disclosure, tag('summary')))).toBe('Show schedule');
    expect(classes(beside.parent as never)).toContain('@min-[560px]:grid-cols-2');
  });

  it('drops the hatch but keeps the quiet line when the partner’s muted colour is too faint', () => {
    const faint = one(render(embed.faint), ui('embed-shell'));
    expect(faint.attrs.style).toContain('--tf-hatch:transparent');
    expect(text(one(faint, ui('sample-note')))).toBe('Sample figures');
    expect(shell.attrs.style).toBeUndefined();
  });

  it('says it is loading in words, with no lattice', () => {
    const loading = render(embed.loading);
    expect(text(one(loading, (e) => e.attrs.role === 'status'))).toBe('Loading plan…');
    expect(all(loading, tag('svg'))).toHaveLength(0);
  });

  it('keeps still boxes while it loads, busy, and after a few seconds says the service may be waking', () => {
    const loading = render(embed.loading);
    const section = one(loading, (e) => e.attrs['data-ui'] === 'embed-shell');
    expect(section.attrs['aria-busy']).toBe('true');
    expect(all(loading, ui('skeleton'))).toHaveLength(3);
    expect(all(loading, ui('embed-slow'))).toHaveLength(0);
    const slow = render(embed.slow);
    expect(text(one(slow, (e) => e.attrs.role === 'status'))).toBe(
      'Loading plan…Still loading. The server may be waking up.',
    );
  });

  it('says one sentence and nothing else when the plan is not available', () => {
    const gone = one(render(embed.unavailable), ui('embed-shell'));
    expect(text(gone)).toBe('This plan isn’t available.');
    expect(all(gone)).toHaveLength(1);
  });
});
