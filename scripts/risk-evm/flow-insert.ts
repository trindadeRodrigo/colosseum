import { type Db, riskPoolFlow } from '@colosseum/db';
import type { FlowRow } from './history-flow';

/**
 * Flow rows into risk_pool_flow, 500 a statement (6,405 rows of 20 columns in one would pass the
 * parameter limit). The table's key is (pool, regime, window, data_to) and a row that is there is left
 * as it is, so a second import of the same walk inserts nothing.
 */
export async function insertFlowRows(
  db: Pick<Db, 'insert'>,
  rows: FlowRow[],
): Promise<{ inserted: number }> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const res = await db
      .insert(riskPoolFlow)
      .values(rows.slice(i, i + 500))
      .onConflictDoNothing()
      .returning({ p: riskPoolFlow.pool });
    inserted += res.length;
  }
  return { inserted };
}
