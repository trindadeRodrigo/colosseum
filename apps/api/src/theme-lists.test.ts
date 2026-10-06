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
  it('reads the Solana AI list from content/themes, and nothing for a chain with no folder', () => {
    const solana = loadThemeLists('solana');
    expect(solana.map((t) => [t.slug, t.status, t.members.length])).toEqual([
      ['ai', 'confirmed', 7],
    ]);
    expect(loadThemeLists('robinhood')).toEqual([]);
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
    expect(figures.themes?.map((t) => t.slug)).toEqual(['ai']);
    expect(
      (await bearingPlanInputs({ db: {} as never, chain: 'robinhood', assets: [] })).themes,
    ).toBeUndefined();
  });
});
