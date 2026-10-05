import { mockAssets, mockCashId } from '@colosseum/chain-mock';
import { describe, expect, it } from 'vitest';
import { MOCK_CASH, unitsFor } from '../apps/web/features/order/units';

// The order screen reads the mock's dollar with units of its own (apps/web may not import the mock).
// They are the mock's, on every chain it runs.

describe('the web’s units for the mock’s cash token', () => {
  it.each(['solana', 'robinhood', 'base'] as const)('are packages/chain-mock’s on %s', (chain) => {
    const cash = mockAssets(chain).find((a) => a.id === mockCashId(chain));
    expect({ symbol: cash?.symbol, decimals: cash?.decimals }).toEqual(MOCK_CASH);
    expect(unitsFor(chain, true)?.cash).toBe(mockCashId(chain));
  });
});
