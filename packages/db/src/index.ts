import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as basketSchema from './basket-schema';
import * as schema from './schema';

export * from './basket-schema';
export * from './executions';
export * from './risk-schema';
export * from './schema';
export * from './seed-chains';
export { basketSchema, schema };

export function createDb(
  url = process.env.DATABASE_URL ?? 'postgres://colosseum:colosseum@localhost:5433/colosseum',
) {
  const client = postgres(url);
  // Both schemas, so db.query knows the vault tables as well as the structurer's.
  return { db: drizzle(client, { schema: { ...schema, ...basketSchema } }), client };
}
export type Db = ReturnType<typeof createDb>['db'];
