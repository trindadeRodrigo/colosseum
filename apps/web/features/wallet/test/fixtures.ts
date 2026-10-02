import { BasketTx, WalletError } from '@colosseum/schemas';
import { expect, vi } from 'vitest';
import { base64Encode } from '../bytes';
import { walletChains } from '../chains';
import { solanaSelfTransferBytes } from '../dev/self-transfer';
import type { WalletPortError } from '../errors';
import { createWalletPort } from '../port';
import { createTestDriver, type TestWalletOptions } from './test-driver';

// What the port's tests share: transactions as the API would build them, and a signed-in throwaway wallet.

export const NOW = '2026-10-02T15:00:00.000Z';
export const BLOCKHASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const OTHER_SOLANA = 'So11111111111111111111111111111111111111112';
export const OTHER_EVM = '0x204faca1764b154221e35c0d20abb3c525710498';
export const chains = walletChains();
export const TESTNET = { robinhood: 46630, base: 84532 } as const;

/** The throwaway wallet's default fee: 21,000 gas at 1 gwei. An EVM transaction here states that much. */
export const DEFAULT_EVM_FEE = '21000000000000';

export const preview: BasketTx['preview'] = {
  source: 'test',
  method: 'fixture',
  fetchedAt: NOW,
  provenance: 'sandbox',
  summary: 'a test transaction',
  simulated: false,
  feeNativeRaw: '5000',
  changes: [],
};
const ids = {
  legKind: 'deposit',
  legId: 'leg-1',
  attemptId: 'attempt-1',
  messageHash: 'ab'.repeat(32),
};

export function solanaTx(owner: string, over: Partial<BasketTx> = {}, lamports = 1n): BasketTx {
  const { transaction } = solanaSelfTransferBytes(owner, BLOCKHASH, lamports);
  return BasketTx.parse({
    ...ids,
    chain: 'solana',
    chainId: 'solana',
    payload: base64Encode(transaction),
    description: 'a test transaction',
    provenance: 'sandbox',
    lastValidBlockHeight: 1,
    signer: owner,
    feePayer: owner,
    preview,
    ...over,
  });
}

export function evmTx(
  owner: string,
  chain: 'robinhood' | 'base' = 'robinhood',
  over: Record<string, unknown> = {},
): BasketTx {
  return BasketTx.parse({
    ...ids,
    chain: 'evm',
    chainId: chain,
    payload: '0xa9059cbb',
    evm: { to: OTHER_EVM, value: '7', chainId: TESTNET[chain] },
    description: 'a test transaction',
    provenance: 'sandbox',
    signer: owner,
    preview: { ...preview, feeNativeRaw: DEFAULT_EVM_FEE },
    ...over,
  });
}

/** What a real wallet throws when the person says no, in three dialects. */
export const REFUSALS = {
  'an EIP-1193 wallet (code 4001)': () =>
    Object.assign(new Error('MetaMask Tx Signature: User denied transaction signature.'), {
      code: 4001,
    }),
  'a wallet-standard wallet (words only)': () => new Error('User rejected the request.'),
  'a dismissed passkey prompt (NotAllowedError)': () =>
    new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'),
};

export async function signedIn(options: TestWalletOptions = {}) {
  const approve = vi.fn<NonNullable<TestWalletOptions['approve']>>();
  const driver = await createTestDriver({ approve, ...options });
  await driver.signIn('passkey');
  const port = createWalletPort(driver, chains);
  const address = (family: 'solana' | 'evm') => {
    const account = port.active(family);
    if (!account) throw new Error(`no ${family} account`);
    return account.address;
  };
  return { driver, port, approve, solana: address('solana'), evm: address('evm') };
}

/** The WalletError a call failed with. A call that did not fail, or failed with anything else, fails the test. */
export async function failure(run: Promise<unknown>): Promise<WalletPortError> {
  const e = await run.then(
    () => null,
    (error: unknown) => error,
  );
  expect(e).toBeInstanceOf(WalletError);
  return e as WalletPortError;
}
