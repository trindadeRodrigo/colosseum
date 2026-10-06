import { mockAssets, mockCashId } from '@colosseum/chain-mock';
import { describe, expect, it } from 'vitest';
import { MOCK_CASH_SYMBOL, unitsFor } from '../apps/web/features/order/units';

// The order screen reads the mock's dollar from the mock's deployment file (apps/web may not import the
// mock): its decimals are the file's `cashDecimals`, and they and the name are the mock's own, on every
// chain it runs.

describe('the web’s units for the mock’s cash token', () => {
  it.each(['solana', 'robinhood', 'base'] as const)('are packages/chain-mock’s on %s', (chain) => {
    const cash = mockAssets(chain).find((a) => a.id === mockCashId(chain));
    const units = unitsFor(chain, true);
    expect(units?.cash).toBe(mockCashId(chain));
    expect(units?.tokens[mockCashId(chain)]).toEqual({
      symbol: cash?.symbol,
      decimals: cash?.decimals,
    });
    expect(cash?.symbol).toBe(MOCK_CASH_SYMBOL[chain]);
  });
});
