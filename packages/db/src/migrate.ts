import './env';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL ?? 'postgres://colosseum:colosseum@localhost:5433/colosseum';
const sql = postgres(url, { max: 1 });
await migrate(drizzle(sql), {
  migrationsFolder: new URL('../migrations', import.meta.url).pathname,
});
await sql.end();
console.log('migrations applied to', url.replace(/:[^:@/]+@/, ':***@'));
