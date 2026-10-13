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
    // The Solana AI list is confirmed by gate THEME-AI-SOLANA, and the stock labels of Solana and
    // Robinhood Chain by gate LABELS-CONFIRMED (Rodrigo, Oct 7): tests/stock-labels.test.ts holds
    // each by name, with its decision and its members. The confirmed lists the server hands in are
    // exactly these, each with this many names: a status flipped in a file, or a name added to one
    // or taken off it, fails here.
    const confirmed = (lists: typeof solana) =>
      lists.filter((t) => t.status === 'confirmed').map((t) => [t.slug, t.members.length]);
    expect(confirmed(solana)).toEqual([
      ['ai-infrastructure', 4],
      ['ai', 7],
      ['big-tech', 7],
      ['broad-market', 2],
      ['cloud-software', 4],
      ['commodities', 1],
      ['crypto-economy', 4],
      ['defense', 2],
      ['ev-autonomy', 2],
      ['fintech', 3],
      ['retail-favourites', 1],
      ['semiconductors', 1],
      ['social-media', 1],
      ['space', 1],
    ]);
    expect(solana.length).toBeGreaterThan(1);
    expect(solana.every((t) => t.chain === 'solana')).toBe(true);
    const robinhood = loadThemeLists('robinhood');
    expect(robinhood.length).toBeGreaterThan(1);
    expect(robinhood.every((t) => t.chain === 'robinhood')).toBe(true);
    expect(confirmed(robinhood)).toEqual([
      ['ai-infrastructure', 12],
      ['ai', 7],
      ['big-tech', 7],
      ['broad-market', 2],
      ['cloud-software', 5],
      ['commodities', 4],
      ['crypto-economy', 4],
      ['defense', 3],
      ['emerging-markets-asia', 3],
      ['ev-autonomy', 2],
      ['fintech', 2],
      ['health-care', 2],
      ['quantum-computing', 2],
      ['retail-favourites', 2],
      ['semiconductors', 7],
      ['social-media', 3],
      ['space', 2],
    ]);
    // Nothing for another chain (gate CHAINS-NOW).
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
