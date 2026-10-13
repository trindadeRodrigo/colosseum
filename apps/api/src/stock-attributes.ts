import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStockAttributes, type StockAttributesFile } from '@colosseum/engine/personal';
import type { ChainId } from '@colosseum/schemas';

// The sourced attributes of the stocks tracked on a chain (gate THEME-MATCHED), as
// `content/stocks/<chain>.json` holds them: what a matched theme sleeve of a plan on that chain is
// filled from. Read here, outside the /v1 route table, because it reads a file
// (apps/api/src/orders/orders.test.ts); `bearingPlanInputs` hands them to the route.

/** The folder of the files, at the root of the repository. */
export const STOCKS_DIR = join(import.meta.dirname, '../../../content/stocks');

/**
 * The attributes of one chain, validated, or null when the chain has no file: a matched theme then
 * matches nothing, and the plan says so. A file that does not validate, or that holds another chain's
 * stocks, stops the request: the attributes are never half read.
 */
export function loadStockAttributes(
  chain: ChainId,
  dir: string = STOCKS_DIR,
): StockAttributesFile | null {
  const file = join(dir, `${chain}.json`);
  if (!existsSync(file)) return null;
  const where = `content/stocks/${chain}.json`;
  const read = parseStockAttributes(JSON.parse(readFileSync(file, 'utf8')), where);
  if (read.chain !== chain) throw new Error(`${where} holds the stocks of ${read.chain}`);
  return read;
}
