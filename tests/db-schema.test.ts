import { basketSchema, schema } from '@colosseum/db';
import {
  AssetKind,
  ExecutionKind,
  ExecutionStatus,
  MintPathKind,
  PolicyMechanism,
  Profile,
  Provenance,
} from '@colosseum/schemas';
import { getTableName, isTable } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

const EXPECTED = [
  'goals',
  'constraint_sheets',
  'assets',
  'yield_observations',
  'fx_observations',
  'depth_observations',
  'plans',
  'plan_legs',
  'schedules',
  'stress_cases',
  'risk_sheets',
  'policies',
  'positions',
  'executions',
  'rebalances',
];

describe('db schema', () => {
  it('declares the 15 core tables', () => {
    const names = (Object.values(schema) as unknown[]).filter(isTable).map((t) => getTableName(t));
    expect(names.sort()).toEqual([...EXPECTED].sort());
  });
  it('keeps pg enums in sync with zod enums', () => {
    expect(schema.profileEnum.enumValues).toEqual(Profile.options);
    expect(schema.assetKindEnum.enumValues).toEqual(AssetKind.options);
    expect(schema.provenanceEnum.enumValues).toEqual(Provenance.options);
    expect(schema.mintPathEnum.enumValues).toEqual(MintPathKind.options);
    expect(schema.executionStatusEnum.enumValues).toEqual(ExecutionStatus.options);
    expect(schema.executionKindEnum.enumValues).toEqual(ExecutionKind.options);
    expect(schema.policyMechanismEnum.enumValues).toEqual(PolicyMechanism.options);
  });
});

// DESIGN-VAULT section 4, migration 0006.
const EXPECTED_VAULT = [
  'chains',
  'users',
  'user_wallets',
  'consents',
  'basket_assets',
  'index_families',
  'recipes',
  'recipe_versions',
  'baskets',
  'proposals',
  'vaults',
  'follows',
  'orders',
  'legs',
  'leg_attempts',
  'keeper_runs',
  'keeper_legs',
  'keeper_vaults',
  'price_observations',
  'idempotency_keys',
];

describe('db schema: vault tables', () => {
  const tables = (Object.values(basketSchema) as unknown[]).filter(isTable) as PgTable[];

  it('declares the 20 vault tables, and none that the core schema already has', () => {
    const names = tables.map((t) => getTableName(t));
    expect([...names].sort()).toEqual([...EXPECTED_VAULT].sort());
    expect(names.filter((n) => EXPECTED.includes(n))).toEqual([]);
  });

  it('keeps every chain_id as text with a foreign key to chains', () => {
    const withChain = tables.filter((t) =>
      getTableConfig(t).columns.some((c) => c.name === 'chain_id'),
    );
    expect(withChain.length).toBeGreaterThan(5);
    for (const t of withChain) {
      const { columns, foreignKeys } = getTableConfig(t);
      expect(columns.find((c) => c.name === 'chain_id')?.getSQLType()).toBe('text');
      const toChains = foreignKeys.some((fk) => {
        const ref = fk.reference();
        return (
          getTableName(ref.foreignTable) === 'chains' &&
          ref.columns.map((c) => c.name).join() === 'chain_id'
        );
      });
      expect(toChains, getTableName(t)).toBe(true);
    }
  });

  it('allows one open keeper run per chain, and one tx id per chain across attempts', () => {
    const open = getTableConfig(basketSchema.keeperRuns).indexes.map((i) => i.config);
    expect(open).toHaveLength(1);
    expect(open[0]?.unique).toBe(true);
    expect(open[0]?.where).toBeDefined();
    const attempts = getTableConfig(basketSchema.legAttempts);
    expect(attempts.uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toContainEqual([
      'chain_id',
      'tx_id',
    ]);
    expect(attempts.checks.map((c) => c.name)).toEqual(['leg_attempts_one_leg']);
  });

  it('reuses the existing provenance enum instead of a second one', () => {
    const provenance = tables.flatMap((t) =>
      getTableConfig(t).columns.filter((c) => c.name === 'provenance'),
    );
    expect(provenance.length).toBeGreaterThan(4);
    for (const c of provenance) expect(c.getSQLType()).toBe('provenance');
  });
});
