import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bearingPlanInputs } from './plan-inputs';
import { loadThemeLists } from './theme-lists';

// The theme lists the server hands the engine: the files of the person's chain, validated.

const scratch = mkdtempSync(join(tmpdir(), 'themes-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('loadThemeLists', () => {
  it('reads the lists of a chain from content/themes, and nothing for a chain with no folder', () => {
    const solana = loadThemeLists('solana');
    // The Solana AI list is confirmed (gate THEME-AI-SOLANA). The stock labels beside it are proposed
    // until a person confirms each (gate THEMES); tests/stock-labels.test.ts holds what they contain.
    // Exactly one list is confirmed, as before the labels: a status flipped in a file fails here.
    expect(
      solana.filter((t) => t.status === 'confirmed').map((t) => [t.slug, t.members.length]),
    ).toEqual([['ai', 7]]);
    expect(solana.length).toBeGreaterThan(1);
    expect(solana.every((t) => t.chain === 'solana')).toBe(true);
    const robinhood = loadThemeLists('robinhood');
    expect(robinhood.length).toBeGreaterThan(1);
    expect(robinhood.every((t) => t.chain === 'robinhood')).toBe(true);
    expect(robinhood.filter((t) => t.status === 'confirmed')).toEqual([]);
    expect(loadThemeLists('base')).toEqual([]);
  });

  it('refuses a file that does not validate, or that sits under another chain or name', () => {
    const [ai] = loadThemeLists('solana');
    mkdirSync(join(scratch, 'solana'), { recursive: true });
    writeFileSync(join(scratch, 'solana', 'ai.json'), JSON.stringify({ ...ai, members: [] }));
    expect(() => loadThemeLists('solana', scratch)).toThrow(/content\/themes\/solana\/ai\.json/);
    writeFileSync(join(scratch, 'solana', 'ai.json'), JSON.stringify({ ...ai, slug: 'chips' }));
    expect(() => loadThemeLists('solana', scratch)).toThrow('holds the list solana/chips');
  });

  it('is what the server hands the route for the chain, even with no token to measure', async () => {
    const figures = await bearingPlanInputs({ db: {} as never, chain: 'solana', assets: [] });
    expect(figures.themes?.map((t) => t.slug)).toEqual(loadThemeLists('solana').map((t) => t.slug));
    expect(figures.themes?.map((t) => t.slug)).toContain('ai');
    // A chain with no list hands none.
    expect(
      (await bearingPlanInputs({ db: {} as never, chain: 'base', assets: [] })).themes,
    ).toBeUndefined();
  });
});
