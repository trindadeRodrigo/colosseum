import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TRUST_STATUS } from './trust';

// The trust notice states the admin key and the keeper's limits in numbers. They are the deploy's, and
// the deploy's record is the one place they are written: the constant is held to it.

const devnet = JSON.parse(
  readFileSync(new URL('../../../deployments/solana-devnet.json', import.meta.url), 'utf8'),
) as { roles: { admin: string }; params: { toleranceBps: number; lossCapBps: number } };

describe('TRUST_STATUS', () => {
  it('names the admin of the Solana deployment, as its deploy recorded it', () => {
    expect(TRUST_STATUS.admin.solana).toBe(devnet.roles.admin);
  });

  it('states the keeper’s limits on Solana as the deploy set them', () => {
    expect(TRUST_STATUS.keeper.solana).toEqual({
      toleranceBps: devnet.params.toleranceBps,
      weeklyLossCapBps: devnet.params.lossCapBps,
    });
  });

  it('says the code is unaudited and the team holds the upgrade keys', () => {
    expect(TRUST_STATUS.audited).toBe(false);
    expect(TRUST_STATUS.upgradeKeys).toBe('team');
    expect(TRUST_STATUS.textVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
