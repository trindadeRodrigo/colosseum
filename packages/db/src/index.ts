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

let shared: ReturnType<typeof createDb> | undefined;
/**
 * The one database client of a process that serves requests: every part of the API reads through it,
 * so the process holds one pool (`DB_POOL_MAX`) and not one for each part. A hosted pooler in session
 * mode caps the clients of a whole project, and each pool counts in full. Opens no connection until
 * the first query, and lives as long as the process: an app that closes does not end it, since
 * another app of the same process may be reading through it. A script that runs and ends uses
 * `createDb` and ends its own.
 */
export function sharedDb(): ReturnType<typeof createDb> {
  shared ??= createDb();
  return shared;
}
