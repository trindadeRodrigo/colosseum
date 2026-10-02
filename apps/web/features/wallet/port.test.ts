import { BasketTx, type ChainId, WalletAccount, WalletError } from '@colosseum/schemas';
import { getTransactionDecoder } from '@solana/kit';
import { parseTransaction, recoverTransactionAddress, verifyMessage } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base58Decode, base64Decode, base64Encode, parseSolanaTx, sameBytes } from './bytes';
import { walletChains } from './chains';
import { solanaSelfTransferBytes } from './dev/self-transfer';
import type { WalletDriver } from './driver';
import type { WalletPortError } from './errors';
import { createWalletPort, idleDriver, type WebWalletPort } from './port';
import { createTestDriver, type TestWalletOptions } from './test/test-driver';

// The contract every WalletPort keeps, run on the throwaway wallet. The Privy wallet goes through the
// same createWalletPort(), so everything here but the driver's own signing is the code the app runs.

const NOW = '2026-10-02T15:00:00.000Z';
const BLOCKHASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const OTHER_SOLANA = 'So11111111111111111111111111111111111111112';
const OTHER_EVM = '0x204faca1764b154221e35c0d20abb3c525710498';
const chains = walletChains();
const TESTNET = { robinhood: 46630, base: 84532 } as const;

const preview = {
  source: 'test',
  method: 'fixture',
  fetchedAt: NOW,
  provenance: 'sandbox',
  summary: 'a test transaction',
  simulated: false,
  feeNativeRaw: '5000',
  changes: [],
} as const;
const ids = {
  legKind: 'deposit',
  legId: 'leg-1',
  attemptId: 'attempt-1',
  messageHash: 'ab'.repeat(32),
};

function solanaTx(owner: string, over: Partial<BasketTx> = {}): BasketTx {
  const { transaction } = solanaSelfTransferBytes(owner, BLOCKHASH, 1n);
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

function evmTx(owner: string, chain: 'robinhood' | 'base' = 'robinhood', over = {}): BasketTx {
  return BasketTx.parse({
    ...ids,
    chain: 'evm',
    chainId: chain,
    payload: '0xa9059cbb',
    evm: { to: OTHER_EVM, value: '7', chainId: TESTNET[chain] },
    description: 'a test transaction',
    provenance: 'sandbox',
    signer: owner,
    preview,
    ...over,
  });
}

/** What a real wallet throws when the person says no, in three dialects. */
const REFUSALS = {
  'an EIP-1193 wallet (code 4001)': () =>
    Object.assign(new Error('MetaMask Tx Signature: User denied transaction signature.'), {
      code: 4001,
    }),
  'a wallet-standard wallet (words only)': () => new Error('User rejected the request.'),
  'a dismissed passkey prompt (NotAllowedError)': () =>
    new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'),
};

async function signedIn(options: TestWalletOptions = {}) {
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

async function failure(run: Promise<unknown>): Promise<WalletPortError> {
  const e = await run.then(
    () => null,
    (error: unknown) => error,
  );
  expect(e).toBeInstanceOf(WalletError);
  return e as WalletPortError;
}

describe('WalletPort: accounts and capabilities', () => {
  it('is signed out with no accounts until someone signs in, and signs nothing', async () => {
    const driver = await createTestDriver();
    const port = createWalletPort(driver, chains);
    expect(port.status).toBe('signed-out');
    expect(port.accounts).toEqual([]);
    expect(port.active('solana')).toBeNull();
    const e = await failure(port.sign('solana', [solanaTx(OTHER_SOLANA)]));
    expect([e.code, e.reason]).toEqual(['unknown', 'not_connected']);
  });

  it("returns each family's address in its canonical form", async () => {
    const { driver, port } = await signedIn();
    expect(port.status).toBe('ready');
    expect(port.userId).toMatch(/^test:/);
    expect(port.accounts.map((a) => a.family).sort()).toEqual(['evm', 'solana']);
    for (const account of port.accounts) expect(WalletAccount.parse(account)).toEqual(account);

    const solana = port.active('solana');
    expect(base58Decode(solana?.address ?? '')).toHaveLength(32);

    // The driver reports the checksum form, as a provider does; the port stores lower case.
    const reported = driver.accounts.find((a) => a.family === 'evm')?.address ?? '';
    expect(reported).toMatch(/[A-F]/);
    expect(port.active('evm')?.address).toBe(reported.toLowerCase());
    expect(port.active('evm')?.address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('leaves out an account whose address is not in the form of its family', () => {
    const driver: WalletDriver = {
      ...idleDriver(),
      status: 'ready',
      accounts: [
        { family: 'solana', address: OTHER_EVM, kind: 'external' },
        { family: 'evm', address: 'not an address', kind: 'external' },
        { family: 'evm', address: OTHER_EVM.toUpperCase().replace('0X', '0x'), kind: 'external' },
        { family: 'evm', address: OTHER_EVM, kind: 'embedded' },
      ],
    };
    expect(createWalletPort(driver, chains).accounts).toEqual([
      { family: 'evm', address: OTHER_EVM, kind: 'external' },
    ]);
  });

  it('says what each wallet can do', async () => {
    const embedded = (await signedIn()).port;
    expect(embedded.caps('solana')).toEqual({ silent: true, batchSign: 3, signOnly: true });
    expect(embedded.caps('robinhood')).toEqual({ silent: true, batchSign: 1, signOnly: true });
    expect(embedded.caps('base')).toEqual(embedded.caps('robinhood'));

    const external = (await signedIn({ kind: 'external' })).port;
    expect(external.caps('solana')).toEqual({ silent: false, batchSign: 3, signOnly: true });
    // An outside EVM wallet cannot sign without sending.
    expect(external.caps('robinhood')).toEqual({ silent: false, batchSign: 1, signOnly: false });
  });
});

describe('WalletPort: signing the bytes it is given', () => {
  it('Solana: the message comes back byte for byte, with a valid signature in the signer slot', async () => {
    const { port, solana } = await signedIn();
    const tx = solanaTx(solana);
    const [signed] = await port.sign('solana', [tx]);

    const before = parseSolanaTx(base64Decode(tx.payload));
    const after = parseSolanaTx(base64Decode(signed ?? ''));
    expect(sameBytes(after.message, before.message)).toBe(true);
    expect(after.feePayer).toBe(solana);
    expect(after.signers).toEqual([solana]);

    const key = await crypto.subtle.importKey(
      'raw',
      base58Decode(solana) as BufferSource,
      'Ed25519',
      false,
      ['verify'],
    );
    const signature = after.signatures[0] as BufferSource;
    expect(
      await crypto.subtle.verify('Ed25519', key, signature, after.message as BufferSource),
    ).toBe(true);

    // @solana/kit reads the same signed transaction and finds the signature under the same address.
    const decoded = getTransactionDecoder().decode(base64Decode(signed ?? ''));
    expect(Object.keys(decoded.signatures)).toEqual([solana]);
    expect(decoded.signatures[solana as keyof typeof decoded.signatures]).not.toBeNull();
  });

  it('Solana: one call signs up to three, in order, and refuses a fourth', async () => {
    const { port, solana, approve } = await signedIn();
    const txs = [1, 2, 3].map((n) => solanaTx(solana, { lastValidBlockHeight: n }));
    const signed = await port.sign('solana', txs);
    expect(signed).toHaveLength(3);
    expect(approve).toHaveBeenCalledTimes(1);

    const e = await failure(port.sign('solana', [...txs, solanaTx(solana)]));
    expect([e.code, e.reason]).toEqual(['unknown', 'unsupported']);
  });

  it('EVM: the signed transaction calls what was asked, on the chain asked, from this account', async () => {
    const { port, evm } = await signedIn();
    const tx = evmTx(evm);
    const [signed] = await port.sign('robinhood', [tx]);
    const parsed = parseTransaction(signed as `0x${string}`);
    expect(parsed.to?.toLowerCase()).toBe(OTHER_EVM);
    expect(parsed.data).toBe('0xa9059cbb');
    expect(parsed.value).toBe(7n);
    expect(parsed.chainId).toBe(46630);
    const from = await recoverTransactionAddress({
      serializedTransaction: signed as `0x02${string}`,
    });
    expect(from.toLowerCase()).toBe(evm);
  });

  it('EVM: refuses what a wallet returns when it signed another call', async () => {
    const { driver, evm } = await signedIn();
    const swapped: WalletDriver = {
      ...driver,
      signEvm: (address, request) =>
        driver.signEvm(address, { ...request, to: evm as `0x${string}` }),
    };
    const e = await failure(createWalletPort(swapped, chains).sign('robinhood', [evmTx(evm)]));
    expect([e.code, e.reason]).toEqual(['unknown', 'changed']);
  });

  it('signs a line of text on each family', async () => {
    const { port, solana, evm } = await signedIn();
    const text = 'Tenonfi wallet check';
    const evmSignature = await port.signMessage('evm', text);
    expect(
      await verifyMessage({
        address: evm as `0x${string}`,
        message: text,
        signature: evmSignature as `0x${string}`,
      }),
    ).toBe(true);

    const key = await crypto.subtle.importKey(
      'raw',
      base58Decode(solana) as BufferSource,
      'Ed25519',
      false,
      ['verify'],
    );
    const signature = base58Decode(await port.signMessage('solana', text));
    expect(
      await crypto.subtle.verify(
        'Ed25519',
        key,
        signature as BufferSource,
        new TextEncoder().encode(text),
      ),
    ).toBe(true);
  });
});

describe('WalletPort: what it refuses before any key is touched', () => {
  it('a transaction for another chain', async () => {
    const { port, solana, evm, approve } = await signedIn();
    const cases: Array<[ChainId, BasketTx]> = [
      ['robinhood', solanaTx(solana)],
      ['solana', evmTx(evm)],
      ['robinhood', evmTx(evm, 'base')],
    ];
    for (const [chain, tx] of cases) {
      const e = await failure(port.sign(chain, [tx]));
      expect(e.code).toBe('wrong_chain');
    }
    expect(approve).not.toHaveBeenCalled();
  });

  it("an EVM transaction for the chain's other network", async () => {
    const { port, evm, approve } = await signedIn();
    // The app is on the test network (46630). 4663 is Robinhood Chain mainnet.
    const mainnet = evmTx(evm, 'robinhood', { evm: { to: OTHER_EVM, value: '7', chainId: 4663 } });
    expect((await failure(port.sign('robinhood', [mainnet]))).code).toBe('wrong_chain');
    expect(approve).not.toHaveBeenCalled();

    // The same transaction is signed once the app is set to mainnet.
    const { driver } = await signedIn();
    const onMainnet = createWalletPort(
      driver,
      walletChains({ NEXT_PUBLIC_CHAIN_NETWORK_ROBINHOOD: 'mainnet' }),
    );
    const own = onMainnet.active('evm')?.address ?? '';
    const [signed] = await onMainnet.sign('robinhood', [{ ...mainnet, signer: own }]);
    expect(parseTransaction(signed as `0x${string}`).chainId).toBe(4663);
  });

  it('a transaction for another account', async () => {
    const { port, solana, evm, approve } = await signedIn();
    const cases = [
      port.sign('solana', [solanaTx(OTHER_SOLANA)]),
      port.sign('robinhood', [evmTx(OTHER_EVM)]),
      // The fields name this account, but the bytes ask another key to sign.
      port.sign('solana', [solanaTx(solana, { payload: solanaTx(OTHER_SOLANA).payload })]),
    ];
    for (const run of cases) {
      const e = await failure(run);
      expect([e.code, e.reason]).toEqual(['unknown', 'wrong_signer']);
    }
    expect(evm).not.toBe(OTHER_EVM);
    expect(approve).not.toHaveBeenCalled();
  });

  it('bytes that are not a transaction, or whose fee payer is not the one stated', async () => {
    const { port, solana, evm, approve } = await signedIn();
    const cases = [
      port.sign('solana', [solanaTx(solana, { payload: 'bm90IGEgdHJhbnNhY3Rpb24=' })]),
      port.sign('solana', [solanaTx(solana, { payload: 'not base64 !' })]),
      port.sign('solana', [solanaTx(solana, { feePayer: OTHER_SOLANA })]),
      port.sign('robinhood', [evmTx(evm, 'robinhood', { payload: 'a9059cbb' })]),
      port.sign('robinhood', [
        evmTx(evm, 'robinhood', { evm: { to: 'nowhere', value: '7', chainId: 46630 } }),
      ]),
    ];
    for (const run of cases) {
      const e = await failure(run);
      expect([e.code, e.reason]).toEqual(['unknown', 'bad_transaction']);
    }
    expect(approve).not.toHaveBeenCalled();
  });

  it('a mock transaction, unless the wallet is the throwaway one', async () => {
    const { driver, port, solana, approve } = await signedIn();
    // What packages/chain-mock builds: JSON in base64, not a transaction.
    const mock = solanaTx(solana, {
      payload: base64Encode(new TextEncoder().encode('{"mock":true}')),
      provenance: 'mock',
    });
    // The throwaway wallet hands it back as it came, and signs nothing.
    expect(await port.sign('solana', [mock])).toEqual([mock.payload]);
    expect(approve).not.toHaveBeenCalled();

    const real = createWalletPort({ ...driver, test: false }, chains);
    const e = await failure(real.sign('solana', [mock]));
    expect([e.code, e.reason]).toEqual(['unknown', 'unsupported']);

    // The mock's EVM transactions name chain id 0. They come back the same way, and are never sent.
    const evm = port.active('evm')?.address ?? '';
    const mockEvm = evmTx(evm, 'robinhood', {
      evm: { to: OTHER_EVM, value: '0', chainId: 0 },
      provenance: 'mock',
    });
    expect(await port.sign('robinhood', [mockEvm])).toEqual([mockEvm.payload]);
    const outside = await signedIn({ kind: 'external', broadcastEvm: async () => '0x00' });
    const sent = await failure(outside.port.send('robinhood', { ...mockEvm, signer: outside.evm }));
    expect([sent.code, sent.reason]).toEqual(['unknown', 'unsupported']);
    // A transaction that is not mock and names chain id 0 is for no chain this app is on.
    const zero = { ...mockEvm, provenance: 'sandbox' as const };
    expect((await failure(port.sign('robinhood', [zero]))).code).toBe('wrong_chain');
  });
});

describe('WalletPort: failures are WalletErrors', () => {
  for (const [who, refusal] of Object.entries(REFUSALS)) {
    it(`a refusal by ${who} is "rejected"`, async () => {
      const { port, solana, evm, approve } = await signedIn();
      approve.mockImplementation(() => {
        throw refusal();
      });
      for (const run of [
        port.sign('solana', [solanaTx(solana)]),
        port.sign('robinhood', [evmTx(evm)]),
        port.signMessage('evm', 'hello'),
      ]) {
        const e = await failure(run);
        expect(e.code).toBe('rejected');
      }
      expect(approve).toHaveBeenCalledTimes(3);
    });
  }

  it('an outside EVM wallet sends, and does not sign alone', async () => {
    const sent: string[] = [];
    const { driver, port, evm, approve } = await signedIn({
      kind: 'external',
      broadcastEvm: async (signed) => {
        sent.push(signed);
        return `0x${'cd'.repeat(32)}`;
      },
    });
    const tx = evmTx(evm);
    // The port refuses by itself: the driver is not asked, whatever it would have answered.
    const signEvm = vi.fn<WalletDriver['signEvm']>();
    const asked = createWalletPort({ ...driver, signEvm }, chains);
    const unsupported = await failure(asked.sign('robinhood', [tx]));
    expect([unsupported.code, unsupported.reason]).toEqual(['unknown', 'unsupported']);
    expect(signEvm).not.toHaveBeenCalled();

    expect(await port.send('robinhood', tx)).toEqual({ txId: `0x${'cd'.repeat(32)}` });
    const parsed = parseTransaction(sent[0] as `0x${string}`);
    expect([parsed.to?.toLowerCase(), parsed.value, parsed.chainId]).toEqual([
      OTHER_EVM,
      7n,
      46630,
    ]);

    approve.mockImplementation(() => {
      throw REFUSALS['an EIP-1193 wallet (code 4001)']();
    });
    expect((await failure(port.send('robinhood', tx))).code).toBe('rejected');
    expect(sent).toHaveLength(1);

    // send() is for an outside EVM wallet only: Solana, and a wallet that signs alone, use sign().
    const embedded = await signedIn();
    for (const run of [
      embedded.port.send('solana', solanaTx(embedded.solana)),
      embedded.port.send('robinhood', evmTx(embedded.evm)),
    ])
      expect((await failure(run)).reason).toBe('unsupported');
  });

  it('send() refuses another chain and another account as sign() does', async () => {
    const { port, evm } = await signedIn({ kind: 'external', broadcastEvm: async () => '0x00' });
    expect((await failure(port.send('robinhood', evmTx(evm, 'base')))).code).toBe('wrong_chain');
    expect((await failure(port.send('robinhood', evmTx(OTHER_EVM)))).reason).toBe('wrong_signer');
  });

  it('a wallet with no gas, a stale blockhash and an unknown chain keep their codes', async () => {
    const { port, evm, approve } = await signedIn();
    const says = async (error: unknown) => {
      approve.mockImplementationOnce(() => {
        throw error;
      });
      return (await failure(port.sign('robinhood', [evmTx(evm)]))).code;
    };
    expect(await says(new Error('insufficient funds for gas * price + value'))).toBe('no_gas');
    expect(await says(new Error('Blockhash not found'))).toBe('expired');
    expect(
      await says(Object.assign(new Error('Unrecognized chain ID "0xb626"'), { code: 4902 })),
    ).toBe('wrong_chain');
    expect(await says({ privyErrorCode: 'exited_auth_flow' })).toBe('rejected');
    // A wrapper that says nothing of its own: the wallet's error is in `cause`.
    expect(await says(new Error('RPC failed', { cause: { code: 4001 } }))).toBe('rejected');
    expect(await says(new Error('something else'))).toBe('unknown');
    expect(await says('a string, not an Error')).toBe('unknown');
  });

  it('the key of a throwaway or an outside wallet is not exported by the app', async () => {
    const embedded = await failure((await signedIn()).port.exportKey('evm'));
    expect(embedded.reason).toBe('unsupported');
    const external = await failure((await signedIn({ kind: 'external' })).port.exportKey('solana'));
    expect(external.reason).toBe('unsupported');
  });
});

describe('WalletPort: sign-in state and the API headers', () => {
  it('sends no header when signed out, and none for the throwaway wallet', async () => {
    expect(await createWalletPort(idleDriver(), chains).authHeaders()).toEqual({});
    expect(await (await signedIn()).port.authHeaders()).toEqual({});
  });

  it('sends the access token as a Bearer token, and the identity token when there is one', async () => {
    const { driver } = await signedIn();
    const withTokens = (tokens: Awaited<ReturnType<WalletDriver['tokens']>>): WebWalletPort =>
      createWalletPort({ ...driver, test: false, tokens: async () => tokens }, chains);

    expect(await withTokens({ access: 'aaa', identity: 'iii' }).authHeaders()).toEqual({
      authorization: 'Bearer aaa',
      'privy-id-token': 'iii',
    });
    expect(await withTokens({ access: 'aaa', identity: null }).authHeaders()).toEqual({
      authorization: 'Bearer aaa',
    });
    // Signed in, but the session can no longer be refreshed.
    const e = await failure(withTokens({ access: null, identity: null }).authHeaders());
    expect(e.code).toBe('expired');
  });

  it('signs out', async () => {
    const { driver, port } = await signedIn();
    await port.signOut();
    const after = createWalletPort(driver, chains);
    expect([after.status, after.userId, after.accounts]).toEqual(['signed-out', null, []]);
  });

  it('says why when sign-in is not set up, and stays signed out', async () => {
    const port = createWalletPort(idleDriver(), chains, 'NEXT_PUBLIC_PRIVY_APP_ID is not set');
    expect(port.status).toBe('signed-out');
    const e = await failure(port.signIn('passkey'));
    expect([e.code, e.reason, e.message]).toEqual([
      'unknown',
      'not_configured',
      'NEXT_PUBLIC_PRIVY_APP_ID is not set',
    ]);
  });
});

describe('the throwaway wallet', () => {
  beforeEach(() => vi.stubEnv('NODE_ENV', 'production'));
  afterEach(() => vi.unstubAllEnvs());

  it('refuses to exist in a production build', async () => {
    await expect(createTestDriver()).rejects.toThrow(/not available in a production build/);
  });
});
