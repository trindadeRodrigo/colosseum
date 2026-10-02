import type { BasketTx } from '@colosseum/schemas';
import { parseTransaction, serializeTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSolanaTx, withSolanaSignature } from './bytes';
import { walletChains } from './chains';
import { solanaSelfTransferBytes } from './dev/self-transfer';
import type { EvmRequest, WalletDriver } from './driver';
import { createWalletPort } from './port';
import {
  BLOCKHASH,
  chains,
  DEFAULT_EVM_FEE,
  evmTx,
  failure,
  OTHER_EVM,
  preview,
  signedIn,
  solanaTx,
} from './test/fixtures';
import { createTestDriver } from './test/test-driver';

// The port trusts neither side. What the API hands it is read strictly, and what the wallet hands back
// is checked against what was sent before anything is returned as signed. From the review of WAL-1.

/** The port over a driver that misbehaves in one way. */
const over = (driver: WalletDriver, wrong: Partial<WalletDriver>) =>
  createWalletPort({ ...driver, ...wrong }, chains);

const reasonOf = async (run: Promise<unknown>) => {
  const e = await failure(run);
  return [e.code, e.reason];
};

describe('Solana: what the wallet hands back is the transaction it was given', () => {
  it('refuses a signed transaction whose message is not the one that was sent', async () => {
    const { driver, solana } = await signedIn();
    // A wallet that rewrites before it signs: an added instruction, or another amount.
    const port = over(driver, {
      signSolana: (address, _sent, cluster) =>
        driver.signSolana(
          address,
          [solanaSelfTransferBytes(solana, BLOCKHASH, 999_999n).transaction],
          cluster,
        ),
    });
    expect(await reasonOf(port.sign('solana', [solanaTx(solana)]))).toEqual(['unknown', 'changed']);
  });

  it('refuses a batch that comes back in another order', async () => {
    const { driver, solana } = await signedIn();
    const port = over(driver, {
      signSolana: async (address, sent, cluster) =>
        (await driver.signSolana(address, sent, cluster)).reverse(),
    });
    const txs = [1n, 2n, 3n].map((lamports) => solanaTx(solana, {}, lamports));
    expect(await reasonOf(port.sign('solana', txs))).toEqual(['unknown', 'changed']);
  });

  it('refuses a batch that comes back shorter or longer', async () => {
    const { driver, solana } = await signedIn();
    const txs = [1n, 2n].map((lamports) => solanaTx(solana, {}, lamports));
    for (const resize of [
      (signed: Uint8Array[]) => signed.slice(0, 1),
      (signed: Uint8Array[]) => [...signed, ...signed.slice(0, 1)],
    ]) {
      const port = over(driver, {
        signSolana: async (address, sent, cluster) =>
          resize(await driver.signSolana(address, sent, cluster)),
      });
      expect(await reasonOf(port.sign('solana', txs))).toEqual(['unknown', 'changed']);
    }
  });

  it('refuses a transaction that comes back unsigned', async () => {
    const { driver, solana } = await signedIn();
    const port = over(driver, { signSolana: async (_address, sent) => sent });
    expect(await reasonOf(port.sign('solana', [solanaTx(solana)]))).toEqual(['unknown', 'changed']);
  });

  it("refuses a signature that is not this account's", async () => {
    const { driver, solana } = await signedIn();
    const stranger = await signedIn();
    // The slot is filled, by a key that is not the account's: the message as another wallet signed it.
    const port = over(driver, {
      signSolana: async (_address, sent, cluster) => {
        const theirs = solanaSelfTransferBytes(stranger.solana, BLOCKHASH, 1n).transaction;
        const [signed] = await stranger.driver.signSolana(stranger.solana, [theirs], cluster);
        const signature = parseSolanaTx(signed ?? theirs).signatures[0] ?? new Uint8Array(64);
        return sent.map((bytes) => withSolanaSignature(bytes, 0, signature));
      },
    });
    expect(await reasonOf(port.sign('solana', [solanaTx(solana)]))).toEqual([
      'unknown',
      'wrong_account',
    ]);
    // A slot that only starts with a zero is a signature, a wrong one, and not an empty slot.
    const startsWithZero = Uint8Array.from([0, ...new Uint8Array(63).fill(7)]);
    const filled = over(driver, {
      signSolana: async (_address, sent) =>
        sent.map((bytes) => withSolanaSignature(bytes, 0, startsWithZero)),
    });
    expect(await reasonOf(filled.sign('solana', [solanaTx(solana)]))).toEqual([
      'unknown',
      'wrong_account',
    ]);
  });

  it('refuses bytes that are not a transaction', async () => {
    const { driver, solana } = await signedIn();
    const port = over(driver, { signSolana: async () => [Uint8Array.from([1, 2, 3])] });
    expect(await reasonOf(port.sign('solana', [solanaTx(solana)]))).toEqual(['unknown', 'changed']);
  });

  describe('where the browser cannot check an Ed25519 signature', () => {
    afterEach(() => vi.restoreAllMocks());
    it('says so, and returns nothing as signed', async () => {
      const { port, solana } = await signedIn();
      const real = crypto.subtle.importKey.bind(crypto.subtle);
      // The throwaway wallet makes its key with generateKey, so only the check is affected.
      vi.spyOn(crypto.subtle, 'importKey').mockImplementation(((...args: unknown[]) =>
        args[2] === 'Ed25519'
          ? Promise.reject(new DOMException('Unrecognized name.', 'NotSupportedError'))
          : (real as (...a: unknown[]) => Promise<CryptoKey>)(...args)) as never);
      expect(await reasonOf(port.sign('solana', [solanaTx(solana)]))).toEqual([
        'unknown',
        'unsupported',
      ]);
    });
  });
});

describe('the network a transaction is labelled for', () => {
  const live = { provenance: 'live', preview: { ...preview, provenance: 'live' } } as const;

  it('on the test network, refuses a transaction the API labels live', async () => {
    const { port, solana, evm, approve } = await signedIn();
    expect(chains.solana.provenance).toBe('sandbox');
    // Solana has no chain id in its bytes: the label is all that tells devnet from mainnet.
    expect((await failure(port.sign('solana', [solanaTx(solana, live)]))).code).toBe('wrong_chain');
    expect((await failure(port.sign('robinhood', [evmTx(evm, 'robinhood', live)]))).code).toBe(
      'wrong_chain',
    );
    expect(approve).not.toHaveBeenCalled();
  });

  it('on mainnet, refuses a transaction the API labels sandbox, and signs one labelled live', async () => {
    const { driver, solana, approve } = await signedIn();
    const main = createWalletPort(
      driver,
      walletChains({ NEXT_PUBLIC_CHAIN_NETWORK_SOLANA: 'mainnet' }),
    );
    expect((await failure(main.sign('solana', [solanaTx(solana)]))).code).toBe('wrong_chain');
    expect(approve).not.toHaveBeenCalled();
    expect(await main.sign('solana', [solanaTx(solana, live)])).toHaveLength(1);
  });

  it('refuses a fixture and a prior dataset, whatever the wallet', async () => {
    const { driver, port, solana, approve } = await signedIn();
    for (const provenance of ['fixture', 'prior_dataset'] as const) {
      const tx = solanaTx(solana, { provenance });
      expect((await failure(port.sign('solana', [tx]))).code).toBe('wrong_chain');
      const real = createWalletPort({ ...driver, test: false }, chains);
      expect((await failure(real.sign('solana', [tx]))).code).toBe('wrong_chain');
    }
    expect(approve).not.toHaveBeenCalled();
  });

  it('an outside EVM wallet is refused the same way before it is asked to send', async () => {
    const { port, evm, approve } = await signedIn({
      kind: 'external',
      broadcastEvm: async () => '0x00',
    });
    expect((await failure(port.send('robinhood', evmTx(evm, 'robinhood', live)))).code).toBe(
      'wrong_chain',
    );
    expect(approve).not.toHaveBeenCalled();
  });
});

describe('EVM: what the wallet hands back is checked before it is returned as signed', () => {
  const stranger = privateKeyToAccount(generatePrivateKey());
  const fees = { nonce: 0, gas: 21_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n };
  /** A driver whose wallet signs `request` changed by `change`, with the fees given. */
  const signing = (
    driver: WalletDriver,
    change: (request: EvmRequest) => Partial<EvmRequest>,
  ): Partial<WalletDriver> => ({
    signEvm: (address, request) => driver.signEvm(address, { ...request, ...change(request) }),
  });

  it('refuses each part of the call that differs: target, data, value, chain', async () => {
    const { driver, evm } = await signedIn();
    const changes: Array<(request: EvmRequest) => Partial<EvmRequest>> = [
      () => ({ to: evm as `0x${string}` }),
      () => ({ data: '0xa9059cbc' }),
      (request) => ({ value: request.value + 1n }),
      () => ({ chainId: 4663 }),
    ];
    for (const change of changes) {
      const port = over(driver, signing(driver, change));
      expect(await reasonOf(port.sign('robinhood', [evmTx(evm)]))).toEqual(['unknown', 'changed']);
    }
    // The same driver, changing nothing, is accepted.
    const same = over(
      driver,
      signing(driver, () => ({})),
    );
    expect(await same.sign('robinhood', [evmTx(evm)])).toHaveLength(1);
  });

  it('refuses a transaction that another key signed', async () => {
    const { driver, evm } = await signedIn();
    const port = over(driver, {
      signEvm: (_address, request) =>
        stranger.signTransaction({ type: 'eip1559', ...request, ...fees }),
    });
    expect(await reasonOf(port.sign('robinhood', [evmTx(evm)]))).toEqual([
      'unknown',
      'wrong_account',
    ]);
  });

  it('refuses what is not a signed transaction', async () => {
    const { driver, evm } = await signedIn();
    for (const back of ['0x', '0x1234', `0x${'ab'.repeat(32)}`] as const) {
      const port = over(driver, { signEvm: async () => back });
      expect(await reasonOf(port.sign('robinhood', [evmTx(evm)]))).toEqual(['unknown', 'changed']);
    }
  });

  it('refuses a transaction with no signature on it, and one with no gas or no fee', async () => {
    const { driver, evm } = await signedIn();
    const unsigned = over(driver, {
      signEvm: async (_address, request) =>
        serializeTransaction({ type: 'eip1559', ...request, ...fees }),
    });
    expect(await reasonOf(unsigned.sign('robinhood', [evmTx(evm)]))).toEqual([
      'unknown',
      'changed',
    ]);
    for (const none of [{ gas: 0n }, { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }]) {
      const { port, evm: own } = await signedIn({ prepareEvm: async () => ({ ...fees, ...none }) });
      expect(await reasonOf(port.sign('robinhood', [evmTx(own)]))).toEqual(['unknown', 'changed']);
    }
  });

  it('refuses a fee far above the one stated, and accepts one within ten times it', async () => {
    // The wallet fills the fee from an RPC. A hostile or broken one must not empty the account.
    const withFees = (gas: bigint, maxFeePerGas: bigint) =>
      signedIn({ prepareEvm: async () => ({ ...fees, gas, maxFeePerGas }) });
    const stated = BigInt(DEFAULT_EVM_FEE);

    const hostile = await withFees(30_000_000n, 10n ** 15n);
    expect(await reasonOf(hostile.port.sign('robinhood', [evmTx(hostile.evm)]))).toEqual([
      'unknown',
      'changed',
    ]);

    const atTheLimit = await withFees(21_000n, (stated * 10n) / 21_000n);
    const [signed] = await atTheLimit.port.sign('robinhood', [evmTx(atTheLimit.evm)]);
    const parsed = parseTransaction(signed as `0x${string}`);
    expect((parsed.gas ?? 0n) * (parsed.maxFeePerGas ?? 0n)).toBe(stated * 10n);

    const justOver = await withFees(21_000n, (stated * 10n) / 21_000n + 1n);
    expect(await reasonOf(justOver.port.sign('robinhood', [evmTx(justOver.evm)]))).toEqual([
      'unknown',
      'changed',
    ]);
  });

  it("with no fee stated, holds the fee under the chain's own ceiling", async () => {
    const ceiling = chains.robinhood.feeCeilingRaw;
    expect(ceiling).toBe(10n ** 15n);
    if (ceiling === null) throw new Error('an EVM chain has a ceiling');
    const unstated = { preview: { ...preview, feeNativeRaw: '0' } };
    const under = await signedIn({
      prepareEvm: async () => ({ ...fees, gas: 1n, maxFeePerGas: ceiling }),
    });
    expect(
      await under.port.sign('robinhood', [evmTx(under.evm, 'robinhood', unstated)]),
    ).toHaveLength(1);
    const above = await signedIn({
      prepareEvm: async () => ({ ...fees, gas: 1n, maxFeePerGas: ceiling + 1n }),
    });
    expect(
      await reasonOf(above.port.sign('robinhood', [evmTx(above.evm, 'robinhood', unstated)])),
    ).toEqual(['unknown', 'changed']);
    // Solana's fee is in the bytes the API built, so the chain has no ceiling of this kind.
    expect(chains.solana.feeCeilingRaw).toBeNull();
  });

  it('accepts a legacy transaction, and holds its fee the same way', async () => {
    const { driver, evm } = await signedIn();
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const legacy = (gasPrice: bigint): Partial<WalletDriver> => ({
      accounts: [{ family: 'evm', address: account.address, kind: 'embedded' }],
      signEvm: (_address, request) =>
        account.signTransaction({ type: 'legacy', ...request, nonce: 0, gas: 21_000n, gasPrice }),
    });
    const tx = evmTx(account.address.toLowerCase());
    const [signed] = await over(driver, legacy(1_000_000_000n)).sign('robinhood', [tx]);
    expect(parseTransaction(signed as `0x${string}`).type).toBe('legacy');
    expect(await reasonOf(over(driver, legacy(10n ** 15n)).sign('robinhood', [tx]))).toEqual([
      'unknown',
      'changed',
    ]);
    expect(evm).not.toBe(account.address.toLowerCase());
  });

  it('refuses any other type, an authorization list and an access list', async () => {
    const { driver } = await signedIn();
    const account = privateKeyToAccount(generatePrivateKey());
    const tx = evmTx(account.address.toLowerCase());
    const base = { nonce: 0, gas: 21_000n };
    const price = { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n };
    const accessList = [{ address: OTHER_EVM, storageKeys: [] }] as const;
    const signers: Array<(request: EvmRequest) => Promise<`0x${string}`>> = [
      // EIP-7702: the transaction would hand the account's code to another contract.
      (request) =>
        account.signTransaction({
          type: 'eip7702',
          ...request,
          ...base,
          ...price,
          authorizationList: [
            {
              address: OTHER_EVM,
              chainId: request.chainId,
              nonce: 0,
              r: `0x${'11'.repeat(32)}`,
              s: `0x${'22'.repeat(32)}`,
              yParity: 0,
            },
          ],
        }),
      (request) =>
        account.signTransaction({ type: 'eip2930', ...request, ...base, gasPrice: 1n, accessList }),
      (request) =>
        account.signTransaction({ type: 'eip1559', ...request, ...base, ...price, accessList }),
    ];
    for (const signEvm of signers) {
      const port = over(driver, {
        accounts: [{ family: 'evm', address: account.address, kind: 'embedded' }],
        signEvm: (_address, request) => signEvm(request),
      });
      expect(await reasonOf(port.sign('robinhood', [tx]))).toEqual(['unknown', 'changed']);
    }
  });
});

describe('what the API hands over is read strictly', () => {
  const asked = (driver: WalletDriver) => {
    const signEvm = vi.fn(driver.signEvm);
    return { signEvm, port: over(driver, { signEvm }) };
  };

  for (const value of ['', ' 7 ', '0x10', '1e3', '-1', '007', '7.0']) {
    it(`refuses the value ${JSON.stringify(value)} and does not ask the wallet`, async () => {
      const { driver, evm } = await signedIn();
      const { port, signEvm } = asked(driver);
      const tx = evmTx(evm, 'robinhood', { evm: { to: OTHER_EVM, value, chainId: 46630 } });
      expect(await reasonOf(port.sign('robinhood', [tx]))).toEqual(['unknown', 'bad_transaction']);
      expect(signEvm).not.toHaveBeenCalled();
    });
  }

  it('refuses call data with an odd number of hex digits, or none of the prefix', async () => {
    const { driver, evm } = await signedIn();
    const { port, signEvm } = asked(driver);
    for (const payload of ['0xabc', 'abcd', '0xzz', '0XABCD']) {
      const tx = evmTx(evm, 'robinhood', { payload });
      expect(await reasonOf(port.sign('robinhood', [tx]))).toEqual(['unknown', 'bad_transaction']);
    }
    expect(signEvm).not.toHaveBeenCalled();
    // Empty call data is a plain transfer, and is fine.
    expect(await port.sign('robinhood', [evmTx(evm, 'robinhood', { payload: '0x' })])).toHaveLength(
      1,
    );
  });

  it('refuses an EVM transaction with no target, and one whose two chain fields disagree', async () => {
    const { driver, evm } = await signedIn();
    const { port, signEvm } = asked(driver);
    const { evm: _target, ...noTarget } = evmTx(evm);
    expect(await reasonOf(port.sign('robinhood', [noTarget]))).toEqual([
      'unknown',
      'bad_transaction',
    ]);
    // Named for Base, with Robinhood Chain's id inside: the schema refuses neither field alone.
    const mixed = evmTx(evm, 'base', { evm: { to: OTHER_EVM, value: '7', chainId: 46630 } });
    expect((await failure(port.sign('robinhood', [mixed]))).code).toBe('wrong_chain');
    expect(signEvm).not.toHaveBeenCalled();
  });

  it('refuses a stated fee that is not a raw amount', async () => {
    const { driver, evm } = await signedIn();
    const { port, signEvm } = asked(driver);
    const tx: BasketTx = { ...evmTx(evm), preview: { ...preview, feeNativeRaw: '1e9' } };
    expect(await reasonOf(port.sign('robinhood', [tx]))).toEqual(['unknown', 'bad_transaction']);
    expect(signEvm).not.toHaveBeenCalled();
  });
});

describe('guards that had no test of their own', () => {
  it('signs nothing while the wallet is not ready, even with accounts in hand', async () => {
    const { driver, solana, evm } = await signedIn();
    const signSolana = vi.fn(driver.signSolana);
    const signEvmMessage = vi.fn(driver.signEvmMessage);
    for (const status of ['loading', 'signed-out'] as const) {
      const port = over(driver, { status, signSolana, signEvmMessage });
      expect(port.accounts).toHaveLength(2);
      expect(await reasonOf(port.sign('solana', [solanaTx(solana)]))).toEqual([
        'unknown',
        'not_connected',
      ]);
      expect(await reasonOf(port.send('robinhood', evmTx(evm)))).toEqual([
        'unknown',
        'not_connected',
      ]);
      expect(await reasonOf(port.signMessage('evm', 'hello'))).toEqual([
        'unknown',
        'not_connected',
      ]);
      expect(await reasonOf(port.exportKey('evm'))).toEqual(['unknown', 'not_connected']);
    }
    expect(signSolana).not.toHaveBeenCalled();
    expect(signEvmMessage).not.toHaveBeenCalled();
  });

  it('a person with a wallet of one family has no account in the other, and is told so', async () => {
    // Someone who signed in with a Solana wallet: Privy makes no EVM wallet for them.
    const driver = await createTestDriver({ families: ['solana'], kind: 'external' });
    await driver.signIn('wallet');
    const signEvm = vi.fn(driver.signEvm);
    const sendEvm = vi.fn(driver.sendEvm);
    const signEvmMessage = vi.fn(driver.signEvmMessage);
    const exportKey = vi.fn(driver.exportKey);
    const port = over(driver, { signEvm, sendEvm, signEvmMessage, exportKey });
    expect(port.active('evm')).toBeNull();
    for (const run of [
      port.sign('robinhood', [evmTx(OTHER_EVM)]),
      port.send('robinhood', evmTx(OTHER_EVM)),
      port.signMessage('evm', 'hello'),
      port.exportKey('evm'),
    ])
      expect(await reasonOf(run)).toEqual(['unknown', 'not_connected']);
    for (const spy of [signEvm, sendEvm, signEvmMessage, exportKey])
      expect(spy).not.toHaveBeenCalled();
  });

  it('an empty call signs nothing and asks nobody', async () => {
    const { driver } = await signedIn();
    const signSolana = vi.fn(driver.signSolana);
    const signEvm = vi.fn(driver.signEvm);
    const port = over(driver, { signSolana, signEvm });
    expect(await port.sign('solana', [])).toEqual([]);
    expect(await port.sign('robinhood', [])).toEqual([]);
    expect(signSolana).not.toHaveBeenCalled();
    expect(signEvm).not.toHaveBeenCalled();
  });

  it('sign-in itself is refused when it is not set up, and a failure of the wallet is a WalletError', async () => {
    const { driver } = await signedIn();
    const signIn = vi.fn(async () => {});
    const off = createWalletPort({ ...driver, signIn }, chains, 'not set');
    expect(off.status).toBe('signed-out');
    expect(await reasonOf(off.signIn('passkey'))).toEqual(['unknown', 'not_configured']);
    expect(signIn).not.toHaveBeenCalled();
    // The wallet provider throws what it likes; the port hands on a WalletError.
    const broken = over(driver, {
      signIn: async () => {
        throw Object.assign(new Error('closed'), { privyErrorCode: 'exited_auth_flow' });
      },
      signOut: async () => {
        throw new Error('network');
      },
    });
    expect((await failure(broken.signIn('wallet'))).code).toBe('rejected');
    expect((await failure(broken.signOut())).code).toBe('unknown');
  });

  it('signs nothing when sign-in is not set up', async () => {
    const { driver, solana } = await signedIn();
    const signSolana = vi.fn(driver.signSolana);
    const signSolanaMessage = vi.fn(driver.signSolanaMessage);
    const port = createWalletPort({ ...driver, signSolana, signSolanaMessage }, chains, 'not set');
    expect(await reasonOf(port.sign('solana', [solanaTx(solana)]))).toEqual([
      'unknown',
      'not_configured',
    ]);
    expect(await reasonOf(port.signMessage('solana', 'hello'))).toEqual([
      'unknown',
      'not_configured',
    ]);
    expect(signSolana).not.toHaveBeenCalled();
    expect(signSolanaMessage).not.toHaveBeenCalled();
  });

  it('asks for no token when signed out, and sends no header', async () => {
    const { driver } = await signedIn();
    const tokens = vi.fn(async () => ({ access: 'aaa', identity: 'iii' }));
    for (const status of ['loading', 'signed-out'] as const)
      expect(await over(driver, { test: false, status, tokens }).authHeaders()).toEqual({});
    expect(tokens).not.toHaveBeenCalled();
    expect(await over(driver, { test: false, tokens }).authHeaders()).toEqual({
      authorization: 'Bearer aaa',
      'privy-id-token': 'iii',
    });
  });

  it('exports the key of a wallet made at sign-in, and of no other', async () => {
    const exportKey = vi.fn(async () => {});
    const embedded = await signedIn();
    await over(embedded.driver, { exportKey }).exportKey('evm');
    // The driver is given the address as the provider reported it, not our lower-case form.
    const reported = embedded.driver.accounts.find((a) => a.family === 'evm')?.address;
    expect(exportKey.mock.calls).toEqual([['evm', reported]]);

    const outside = await signedIn({ kind: 'external' });
    const port = over(outside.driver, { exportKey });
    expect(await reasonOf(port.exportKey('solana'))).toEqual(['unknown', 'unsupported']);
    expect(exportKey).toHaveBeenCalledTimes(1);
  });

  it('counts an account once, however the provider spells or repeats it', async () => {
    const { driver } = await signedIn();
    const evm = driver.accounts.find((a) => a.family === 'evm');
    if (!evm) throw new Error('no EVM account');
    const port = over(driver, {
      accounts: [evm, { ...evm, address: evm.address.toLowerCase(), kind: 'external' }],
    });
    expect(port.accounts).toEqual([
      { family: 'evm', address: evm.address.toLowerCase(), kind: 'embedded' },
    ]);
  });

  it('a transaction on the right chain id but the other family is refused', async () => {
    const { port, solana } = await signedIn();
    // Fields that disagree with each other never pass the schema; the port does not rely on that.
    const tx = { ...solanaTx(solana), chainId: 'robinhood' } as BasketTx;
    expect((await failure(port.sign('robinhood', [tx]))).code).toBe('wrong_chain');
  });
});
