import { WalletError } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { fail, WalletPortError } from './errors';
import { accountLines, failureSentence, shortAddress } from './view';

const SOLANA = 'So11111111111111111111111111111111111111112';
const EVM = '0x204faca1764b154221e35c0d20abb3c525710498';

describe('what the sign-in control shows', () => {
  it('shortens an address so it can be recognised', () => {
    expect(shortAddress(SOLANA)).toBe('So11…1112');
    expect(shortAddress(EVM)).toBe('0x204f…0498');
    expect(shortAddress('short')).toBe('short');
  });

  it('shows one line per family: the active account, Solana first', () => {
    const lines = accountLines([
      { family: 'evm', address: EVM, kind: 'embedded' },
      { family: 'evm', address: `0x${'11'.repeat(20)}`, kind: 'external' },
      { family: 'solana', address: SOLANA, kind: 'embedded' },
    ]);
    expect(lines.map((l) => l.label)).toEqual(['Solana So11…1112', 'EVM 0x204f…0498']);
    expect(accountLines([{ family: 'solana', address: SOLANA, kind: 'external' }])).toHaveLength(1);
    expect(accountLines([])).toEqual([]);
  });

  it('says nothing when the person refused, and a plain sentence otherwise', () => {
    expect(failureSentence(new WalletError('rejected'))).toBeNull();
    expect(failureSentence(fail('not_configured', 'NEXT_PUBLIC_PRIVY_APP_ID is not set'))).toBe(
      'Sign-in is not set up here: NEXT_PUBLIC_PRIVY_APP_ID is not set.',
    );
    expect(failureSentence(new WalletPortError('no_gas', 'insufficient funds'))).toBe(
      'This account has no funds for the network fee.',
    );
    // Anything else that was thrown still gets a sentence.
    expect(failureSentence(new Error('getBalance: HTTP 429'))).toBe(
      'That did not work: getBalance: HTTP 429.',
    );
    expect(failureSentence('a string')).toBe('That did not work: no reason given.');
    for (const code of ['wrong_chain', 'expired', 'unknown'] as const) {
      const sentence = failureSentence(new WalletError(code, 'detail'));
      expect(sentence).toMatch(/\.$/);
      expect(sentence).not.toMatch(/!/);
    }
  });
});
