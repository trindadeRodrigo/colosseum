import { basketSchema, chainRows, createDb, schema } from '@colosseum/db';
import {
  AssetKind,
  ExecutionKind,
  ExecutionStatus,
  MintPathKind,
  PolicyMechanism,
  Profile,
  Provenance,
  parseChainConfigs,
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
  it('names a vault in the keeper tables by chain and address, not by a row of the API cache', () => {
    for (const table of [basketSchema.keeperLegs, basketSchema.keeperVaults]) {
      const { columns, foreignKeys } = getTableConfig(table);
      expect(columns.map((c) => c.name)).toEqual(
        expect.arrayContaining(['chain_id', 'vault_address']),
      );
      expect(columns.map((c) => c.name)).not.toContain('vault_id');
      const referenced = foreignKeys.map((fk) => getTableName(fk.reference().foreignTable));
      expect(referenced).not.toContain('vaults');
    }
    const key = getTableConfig(basketSchema.keeperVaults).primaryKeys[0];
    expect(key?.columns.map((c) => c.name)).toEqual(['chain_id', 'vault_address']);
    const runKey = getTableConfig(basketSchema.keeperLegs).uniqueConstraints[0];
    expect(runKey?.columns.map((c) => c.name)).toEqual([
      'chain_id',
      'vault_address',
      'keeper_run_id',
      'seq',
    ]);
  });

  it('indexes what is looked up: an attempt by its hash, vaults by recipe, follows by family', () => {
    const indexed = (table: PgTable) =>
      getTableConfig(table).indexes.map((i) =>
        i.config.columns.map((c) => ('name' in c ? c.name : '')).join(','),
      );
    expect(indexed(basketSchema.legAttempts)).toContain('message_hash');
    expect(indexed(basketSchema.vaults)).toEqual(expect.arrayContaining(['owner', 'recipe_id']));
    expect(indexed(basketSchema.follows)).toContain('family_id');
    expect(indexed(basketSchema.keeperLegs)).toContain('keeper_run_id');
  });

  it('opens the database with both schemas, so db.query knows the vault tables', async () => {
    // Nothing connects until a query runs.
    const { db, client } = createDb('postgres://nobody:nothing@localhost:1/none');
    expect(db.query.orders).toBeDefined();
    expect(db.query.keeperLegs).toBeDefined();
    expect(db.query.plans).toBeDefined();
    await client.end();
  });

  it('seeds one chains row per chain, and refuses a database that belongs to another network', () => {
    const testnet = parseChainConfigs({});
    const rows = chainRows([], testnet);
    expect(rows.map((r) => [r.id, r.family, r.network, r.evmChainId])).toEqual([
      ['solana', 'solana', 'testnet', null],
      ['robinhood', 'evm', 'testnet', 46630],
      ['base', 'evm', 'testnet', 84532],
    ]);
    // Seeding again over its own rows changes nothing and is allowed.
    const seeded = rows.map((r) => ({ id: r.id, network: r.network }));
    expect(chainRows(seeded, testnet)).toEqual(rows);
    const mainnet = parseChainConfigs({ CHAIN_NETWORK_ROBINHOOD: 'mainnet' });
    expect(() => chainRows(seeded, mainnet)).toThrow(
      'chains.robinhood is testnet in this database and mainnet in the config: one database per network',
    );
  });
});
