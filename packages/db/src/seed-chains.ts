import type { ChainConfig, ChainId } from '@colosseum/schemas';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { chains } from './basket-schema';

export type ChainRow = typeof chains.$inferInsert;

/**
 * The rows `chains` should hold for these configs. Pure. Throws when a row already there names another
 * network: one database serves one network, so a database of test-network vaults is never read as
 * mainnet, or the other way round.
 */
export function chainRows(
  existing: { id: string; network: string }[],
  configs: Record<ChainId, ChainConfig>,
): ChainRow[] {
  return Object.values(configs).map((config) => {
    const row = existing.find((r) => r.id === config.id);
    if (row && row.network !== config.network)
      throw new Error(
        `chains.${config.id} is ${row.network} in this database and ${config.network} in the config: one database per network`,
      );
    return {
      id: config.id,
      family: config.family,
      name: config.name,
      network: config.network,
      networkName: config.networkName,
      evmChainId: config.evmChainId,
    };
  });
}

/**
 * Writes the chain rows every chain_id points at. Safe to run at every start and after every migrate:
 * a row that is there is updated in place.
 */
export async function seedChains(
  // Any drizzle Postgres database, whatever schema it was opened with.
  // biome-ignore lint/suspicious/noExplicitAny: the two schema parameters do not matter here
  db: PgDatabase<PgQueryResultHKT, any, any>,
  configs: Record<ChainId, ChainConfig>,
): Promise<void> {
  const existing = await db.select({ id: chains.id, network: chains.network }).from(chains);
  await db
    .insert(chains)
    .values(chainRows(existing, configs))
    .onConflictDoUpdate({
      target: chains.id,
      set: {
        family: sql`excluded.family`,
        name: sql`excluded.name`,
        networkName: sql`excluded.network_name`,
        evmChainId: sql`excluded.evm_chain_id`,
        updatedAt: sql`now()`,
      },
    });
}
