import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseThemeList, type ThemeList } from '@colosseum/engine/personal';
import type { ChainId } from '@colosseum/schemas';

// The curated theme lists (gate THEMES), as `content/themes/<chain>/<slug>.json` holds them: what a
// theme sleeve of a plan on that chain is made from. Read here, outside the /v1 route table, because
// it reads files (apps/api/src/orders/orders.test.ts); `bearingPlanInputs` hands them to the route.

/** The folder of the lists, at the root of the repository. */
export const THEMES_DIR = join(import.meta.dirname, '../../../content/themes');

/**
 * Every list for one chain, validated, in the order of their slugs. A file that does not validate,
 * or whose chain and slug are not its folder and name, stops the request: a list is never half read.
 */
export function loadThemeLists(chain: ChainId, dir: string = THEMES_DIR): ThemeList[] {
  const here = join(dir, chain);
  if (!existsSync(here)) return [];
  return readdirSync(here)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const where = `content/themes/${chain}/${file}`;
      const list = parseThemeList(JSON.parse(readFileSync(join(here, file), 'utf8')), where);
      if (list.chain !== chain || `${list.slug}.json` !== file)
        throw new Error(`${where} holds the list ${list.chain}/${list.slug}`);
      return list;
    });
}
