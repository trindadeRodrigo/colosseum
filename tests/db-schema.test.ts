import { schema } from '@colosseum/db';
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
