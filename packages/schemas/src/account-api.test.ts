import { describe, expect, it } from 'vitest';
import { FundingQuery, TestFundsRequest } from './account-api';

// What a funding read and a test-funds send may be asked about: one thing, a plan, a shared portfolio or
// a vault of the person's, and a vault always with its chain.

const plan = '6f1c1a52-6a55-4f0b-9a57-3f1f8f0f3a10';
const vault = '0x00000000000000000000000000000000000000a1';

describe('what a funding read names', () => {
  it('takes a vault with its chain, and nothing else beside it', () => {
    expect(FundingQuery.safeParse({ amountUsd: 50, vault, vaultChain: 'robinhood' }).success).toBe(
      true,
    );
    expect(FundingQuery.safeParse({ amountUsd: 50, vault }).success).toBe(false);
    expect(FundingQuery.safeParse({ amountUsd: 50, vaultChain: 'robinhood' }).success).toBe(false);
    expect(
      FundingQuery.safeParse({ amountUsd: 50, vault, vaultChain: 'robinhood', proposalId: plan })
        .success,
    ).toBe(false);
    expect(FundingQuery.safeParse({ vault, vaultChain: 'robinhood' }).success).toBe(false);
  });
});

describe('what a test-funds send names', () => {
  it('takes exactly one of a plan, a shared portfolio and a vault', () => {
    expect(TestFundsRequest.safeParse({ amountUsd: 50, proposalId: plan }).success).toBe(true);
    expect(
      TestFundsRequest.safeParse({ amountUsd: 50, vault, vaultChain: 'robinhood' }).success,
    ).toBe(true);
    expect(TestFundsRequest.safeParse({ amountUsd: 50 }).success).toBe(false);
    expect(TestFundsRequest.safeParse({ amountUsd: 50, vault }).success).toBe(false);
    expect(
      TestFundsRequest.safeParse({
        amountUsd: 50,
        vault,
        vaultChain: 'robinhood',
        proposalId: plan,
      }).success,
    ).toBe(false);
  });
});
