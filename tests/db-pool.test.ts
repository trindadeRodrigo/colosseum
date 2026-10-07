import { POOL_MAX_LIMIT, poolOptions } from '@colosseum/db';
import { describe, expect, it } from 'vitest';

// How the database client is opened (packages/db/src/pool.ts): the pool's size and whether statements
// are prepared, set from the environment so a hosted pooler's mode needs no change of code.

describe('the database pool, from the environment', () => {
  it('is ten connections with prepared statements when nothing is set, as it always was', () => {
    expect(poolOptions({})).toEqual({ max: 10, prepare: true });
    expect(poolOptions({ DB_POOL_MAX: ' ', DB_PGBOUNCER: '' })).toEqual({ max: 10, prepare: true });
  });

  it('takes the size a deployment names', () => {
    expect(poolOptions({ DB_POOL_MAX: '4' }).max).toBe(4);
    expect(poolOptions({ DB_POOL_MAX: String(POOL_MAX_LIMIT) }).max).toBe(POOL_MAX_LIMIT);
  });

  it('prepares no statement behind a pooler in transaction mode, and only there', () => {
    expect(poolOptions({ DB_PGBOUNCER: 'transaction' })).toEqual({ max: 10, prepare: false });
    expect(poolOptions({ DB_PGBOUNCER: 'Transaction ' }).prepare).toBe(false);
    expect(poolOptions({ DB_PGBOUNCER: 'session' }).prepare).toBe(true);
  });

  it('stops on a value it cannot read, naming the variable and never guessing', () => {
    for (const value of ['0', '-1', '2.5', 'ten', String(POOL_MAX_LIMIT + 1)])
      expect(() => poolOptions({ DB_POOL_MAX: value }), value).toThrow(/DB_POOL_MAX/);
    for (const value of ['true', '1', 'statement', 'yes'])
      expect(() => poolOptions({ DB_PGBOUNCER: value }), value).toThrow(/DB_PGBOUNCER/);
  });
});
