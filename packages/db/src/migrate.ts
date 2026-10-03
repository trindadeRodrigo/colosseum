import './env';
import { fileURLToPath } from 'node:url';
import { parseChainConfigs } from '@colosseum/schemas';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { seedChains } from './seed-chains';

const url = process.env.DATABASE_URL ?? 'postgres://colosseum:colosseum@localhost:5433/colosseum';
const sql = postgres(url, { max: 1 });
const db = drizzle(sql);
await migrate(db, {
  migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
});
// Every chain_id points at a row of `chains`. Stops here if this database belongs to another network.
await seedChains(db, parseChainConfigs(process.env));
await sql.end();
console.log('migrations applied to', url.replace(/:[^:@/]+@/, ':***@'));
