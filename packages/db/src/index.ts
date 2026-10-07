import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as basketSchema from './basket-schema';
import { poolOptions } from './pool';
import * as schema from './schema';

export * from './basket-schema';
export * from './executions';
export * from './pool';
export * from './risk-schema';
export * from './schema';
export * from './seed-chains';
export { basketSchema, schema };

export function createDb(
  url = process.env.DATABASE_URL ?? 'postgres://colosseum:colosseum@localhost:5433/colosseum',
) {
  // The pool's size and whether statements are prepared, from the environment (pool.ts).
  const client = postgres(url, poolOptions(process.env));
  // Both schemas, so db.query knows the vault tables as well as the structurer's.
  return { db: drizzle(client, { schema: { ...schema, ...basketSchema } }), client };
}
export type Db = ReturnType<typeof createDb>['db'];
