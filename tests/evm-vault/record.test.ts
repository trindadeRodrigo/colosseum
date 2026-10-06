import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deploymentAssets, EvmDeploymentRecord } from '@colosseum/chain-evm/vault';
import { deploymentsOf } from '@colosseum/sdk';
import { describe, expect, it } from 'vitest';

// The guard's deployment for Robinhood Chain's test network is the deploy's record, address for
// address: the guard derives every contract it holds a transaction to from it, so it may say nothing
// the deploy did not.

const ROOT = join(import.meta.dirname, '..', '..');
const record = EvmDeploymentRecord.parse(
  JSON.parse(readFileSync(join(ROOT, 'deployments', 'robinhood-testnet.json'), 'utf8')),
);

describe("the guard's Robinhood Chain test network", () => {
  it('is the record: chain id, factory, beacon, router, cash and every token with its decimals', () => {
    const guard = deploymentsOf('testnet').robinhood;
    if (guard?.family !== 'evm') throw new Error('the guard has no EVM entry for robinhood');
    expect(guard.evmChainId).toBe(record.evmChainId);
    expect(guard.factory.toLowerCase()).toBe(record.contracts.factory);
    expect(guard.beacon.toLowerCase()).toBe(record.contracts.beacon);
    expect(guard.routers.map((r) => r.toLowerCase())).toEqual(record.routers.map((r) => r.address));
    expect(guard.cash).toBe(record.cash.id);
    expect(
      Object.fromEntries(
        Object.entries(guard.assets).map(([id, a]) => [id, [a.token.toLowerCase(), a.decimals]]),
      ),
    ).toEqual(
      Object.fromEntries(deploymentAssets(record).map((a) => [a.id, [a.address, a.decimals]])),
    );
  });
});
