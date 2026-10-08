import { DISCLAIMER } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { disclaimer } from './test/cases';
import { all, classes, one, render, role, tag, text, ui } from './test/html';

describe('Disclaimer (disclaimer-block.md)', () => {
  it('renders the DISCLAIMER constant verbatim, in the language of the view', () => {
    const paragraphs = all(render(disclaimer.en), tag('p')).filter((p) => p.attrs.lang);
    expect(paragraphs).toHaveLength(1);
    expect(text(paragraphs[0] as never)).toBe(DISCLAIMER.en);
    expect(paragraphs[0]?.attrs.lang).toBe('en');
    const pt = one(render(disclaimer.pt), tag('p'));
    expect(text(pt)).toBe(DISCLAIMER.pt);
    expect(pt.attrs.lang).toBe('pt');
  });

  it('renders both, each in its own marked paragraph, when the view is bilingual', () => {
    const paragraphs = all(render(disclaimer.both), tag('p'));
    expect(paragraphs.map(text)).toEqual([DISCLAIMER.pt, DISCLAIMER.en]);
    expect(paragraphs.map((p) => p.attrs.lang)).toEqual(['pt', 'en']);
  });

  it('takes no other text', () => {
    // `reworded` in test/cases.tsx is a type error; forced through, the children are ignored.
    const forced = text(render(disclaimer.reworded));
    expect(forced).toBe(DISCLAIMER.en);
    expect(forced).not.toContain('Simulation');
  });

  it('is at body size, in the foreground colour, in a 10px hairline box with no fill and no icon', () => {
    const block = one(render(disclaimer.en), ui('disclaimer'));
    expect(classes(block)).toEqual(
      expect.arrayContaining(['border', 'border-border', 'rounded-lg', 'text-foreground']),
    );
    expect(classes(block).join(' ')).not.toMatch(/\bbg-|muted|text-(caption|source|xs|sm)/);
    const body = all(block, tag('p')).filter((p) => p.attrs.lang)[0];
    // 1rem in the app; inside the embed the shell sets --tf-e-body to 1em. Never smaller than that.
    expect(classes(body as never)).toContain('text-[length:var(--tf-e-body,1rem)]');
    expect(all(block, tag('svg'))).toHaveLength(0);
  });

  it('is a labelled note, and cannot be collapsed or dismissed', () => {
    const block = one(render(disclaimer.en), ui('disclaimer'));
    expect(role(block)).toBe('complementary');
    expect(block.attrs['aria-label']).toBe('Disclaimer');
    expect(all(block, (e) => ['button', 'details', 'summary', 'a'].includes(e.tag))).toHaveLength(
      0,
    );
  });
});
