import { type Db, riskPriceObservations } from '@colosseum/db';
import { type OracleRow, toObservation } from './oracle';

/**
 * Oracle rows into risk_price_observations (chain and price_source as the row says: 'robinhood',
 * 'chainlink'). The table's key is (price_source, ref, mint, observed_at, slot, price) and a row that is
 * there is left as it is, so a second import of the same file inserts nothing. A row with no price is
 * not a price observation: it is counted and stays in the file.
 */
export async function insertOracleRows(
  db: Pick<Db, 'insert'>,
  rows: OracleRow[],
): Promise<{ inserted: number; noPrice: number }> {
  const values = rows.flatMap((r) => toObservation(r) ?? []);
  let inserted = 0;
  for (let i = 0; i < values.length; i += 500) {
    const res = await db
      .insert(riskPriceObservations)
      .values(values.slice(i, i + 500))
      .onConflictDoNothing()
      .returning({ m: riskPriceObservations.mint });
    inserted += res.length;
  }
  return { inserted, noPrice: rows.length - values.length };
}
