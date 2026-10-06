import { getAddress } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { base64Decode } from './bytes';
import { toWalletError, type WalletPortError } from './errors';
import { foundWallets, onePerName, readAnnouncement, watchEvmWallets } from './found-wallets';
import { createWalletPort, idleDriver } from './port';
import {
  clientType,
  inBrowser,
  missingWallets,
  signInWithEvmWallet,
  signInWithSolanaWallet,
  walletAlreadyThere,
} from './sign-in-flows';
import { offersNewPasskey, type SignInAttempt, signInFailure, walletChoices } from './sign-in-view';
import { buildConfigForTest } from './test/api-config';
import { chains, failure } from './test/fixtures';
import { createTestDriver, TEST_WALLETS } from './test/test-driver';

// Sign-in with no window of the wallet provider's: what each failure is called, which sentence it
// gets, how an outside wallet signs in, and which wallets a passkey sign-in owes a person.

const read = (e: unknown) => {
  const error = toWalletError(e) as WalletPortError;
  return [error.code, error.reason];
};
/** An error as Privy's API client throws one. */
const privy = (code: string, message: string) =>
  Object.assign(new Error(message), {
    privyErrorCode: code,
  });

describe('what a failed sign-in is called', () => {
  it('names a way in that the provider has switched off: Privy’s 403', () => {
    expect(read(privy('disallowed_login_method', 'Login with passkey not allowed'))).toEqual([
      'unsupported',
      'method_off',
    ]);
    // the words alone, with no code, are the same failure
    expect(read(new Error('Login with passkey not allowed'))).toEqual([
      'unsupported',
      'method_off',
    ]);
    expect(read(new Error('Login with wallet not allowed'))).toEqual(['unsupported', 'method_off']);
  });

  it('names a passkey prompt that was closed or timed out, in each form it comes in', () => {
    for (const e of [
      privy('passkey_not_allowed', 'Passkey request timed out or rejected by user.'),
      new Error('Passkey request timed out or rejected by user.'),
      new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'),
    ])
      expect(read(e)).toEqual(['rejected', 'passkey_cancelled']);
  });

  it('names a passkey nobody is known by, a browser without passkeys, a full queue and no network', () => {
    expect(read(privy('user_does_not_exist', 'User does not exist'))).toEqual([
      'unknown',
      'passkey_unknown',
    ]);
    expect(read(new Error('WebAuthn is not supported in this browser'))).toEqual([
      'unsupported',
      'passkey_unsupported',
    ]);
    expect(read(privy('too_many_requests', 'Too many requests'))).toEqual(['unknown', 'too_many']);
    expect(read(Object.assign(new Error('HTTP 429'), { status: 429 }))).toEqual([
      'unknown',
      'too_many',
    ]);
    expect(read(new TypeError('Failed to fetch'))).toEqual(['unknown', 'offline']);
    expect(read(privy('client_request_timeout', 'Request timed out'))).toEqual([
      'unknown',
      'offline',
    ]);
  });

  it('names a passkey not registered here, and the provider’s other refusals of a sign-in', () => {
    expect(read(privy('passkey_not_registered', 'Passkey not registered'))).toEqual([
      'unknown',
      'passkey_not_registered',
    ]);
    // the words alone, with no code
    expect(read(new Error('This passkey has not been registered'))).toEqual([
      'unknown',
      'passkey_not_registered',
    ]);
    expect(read(privy('max_accounts_reached', 'x'))).toEqual(['unknown', 'accounts_full']);
    expect(read(privy('allowlist_rejected', 'x'))).toEqual(['unknown', 'not_invited']);
    expect(read(privy('session_storage_unavailable', 'x'))).toEqual(['unsupported', 'no_storage']);
  });

  it('still calls a wallet’s refusal a refusal, with nothing about a passkey in it', () => {
    expect(read(Object.assign(new Error('User denied'), { code: 4001 }))).toEqual([
      'rejected',
      null,
    ]);
    expect(read(new Error('User rejected the request.'))).toEqual(['rejected', null]);
    expect(read(new Error('something else'))).toEqual(['unknown', null]);
  });
});

describe('the sentence each failure gets', () => {
  const says = (e: unknown, attempt: SignInAttempt) => signInFailure(toWalletError(e), attempt);
  const off = privy('disallowed_login_method', 'Login with passkey not allowed');
  const closed = privy('passkey_not_allowed', 'Passkey request timed out or rejected by user.');
  const refused = Object.assign(new Error('User denied message signature.'), { code: 4001 });

  it('says passkeys are off, or wallet sign-in is off, by what was tried', () => {
    expect(says(off, 'passkey-create')).toBe('passkeyOff');
    expect(says(off, 'passkey-use')).toBe('passkeyOff');
    expect(says(off, 'wallet')).toBe('walletOff');
  });

  it('tells a passkey that was not made from one that was not used, and both from a wallet’s refusal', () => {
    expect(says(closed, 'passkey-create')).toBe('passkeyNotCreated');
    expect(says(closed, 'passkey-use')).toBe('passkeyNotUsed');
    expect(says(refused, 'wallet')).toBe('walletRefused');
    // a refusal with no word about passkeys, while a passkey was being asked for
    expect(says(refused, 'passkey-create')).toBe('passkeyNotCreated');
  });

  it('has a sentence for everything else, and never the text that was thrown', () => {
    expect(says(privy('user_does_not_exist', 'x'), 'passkey-use')).toBe('passkeyUnknown');
    expect(says(privy('passkey_not_registered', 'x'), 'passkey-use')).toBe('passkeyNotRegistered');
    expect(says(privy('max_accounts_reached', 'x'), 'passkey-create')).toBe('accountsFull');
    expect(says(privy('allowlist_rejected', 'x'), 'wallet')).toBe('notInvited');
    expect(says(privy('session_storage_unavailable', 'x'), 'passkey-use')).toBe('noStorage');
    expect(says(new Error('WebAuthn is not supported in this browser'), 'passkey-use')).toBe(
      'passkeyUnsupported',
    );
    expect(says(privy('too_many_requests', 'x'), 'wallet')).toBe('tooMany');
    expect(says(new TypeError('Failed to fetch'), 'wallet')).toBe('offline');
    expect(says(new Error('Blockhash not found'), 'wallet')).toBe('expired');
    expect(says(new Error('TypeError: cannot read properties of undefined'), 'wallet')).toBe(
      'other',
    );
    expect(says('a string', 'passkey-use')).toBe('other');
    expect(says(null, 'wallet')).toBe('other');
  });
});

describe('signing in with an EVM wallet the browser announced', () => {
  const ACCOUNT = '0x204faca1764b154221e35c0d20abb3c525710498';
  // the checksum form (EIP-55), which is what the provider's message carries
  const CHECKSUM = getAddress(ACCOUNT);
  const wallet = (answers: Record<string, unknown>) => {
    const asked: Array<{ method: string; params?: readonly unknown[] }> = [];
    return {
      asked,
      name: 'MetaMask',
      provider: {
        request: async (args: { method: string; params?: readonly unknown[] }) => {
          asked.push(args);
          const answer = answers[args.method];
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    };
  };
  const calls = () => ({
    generate: vi.fn(async () => 'localhost wants you to sign in'),
    login: vi.fn(async () => ({})),
  });

  it('asks for the account and the chain, has the wallet sign the provider’s message, and hands both over', async () => {
    const w = wallet({
      eth_requestAccounts: [ACCOUNT],
      eth_chainId: '0xb626',
      personal_sign: '0xsigned',
    });
    const c = calls();
    await signInWithEvmWallet(w, c);
    expect(w.asked.map((a) => a.method)).toEqual([
      'eth_requestAccounts',
      'eth_chainId',
      'personal_sign',
    ]);
    // the message is asked for the checksum form of the address, on the chain the wallet is on
    expect(CHECKSUM).not.toBe(ACCOUNT);
    expect(CHECKSUM.toLowerCase()).toBe(ACCOUNT);
    expect(c.generate).toHaveBeenCalledWith({ address: CHECKSUM, chainId: 'eip155:46630' });
    // and signed as text, by the account the wallet gave
    const [hex, by] = w.asked[2]?.params ?? [];
    expect(Buffer.from(String(hex).slice(2), 'hex').toString()).toBe(
      'localhost wants you to sign in',
    );
    expect(by).toBe(ACCOUNT);
    expect(c.login).toHaveBeenCalledWith({
      message: 'localhost wants you to sign in',
      signature: '0xsigned',
      walletClientType: 'metamask',
      connectorType: 'injected',
    });
  });

  it('signs nobody in when the wallet refuses, and says what the wallet said', async () => {
    const refused = Object.assign(new Error('User rejected the request.'), { code: 4001 });
    const atConnect = wallet({ eth_requestAccounts: refused });
    const atSign = wallet({
      eth_requestAccounts: [ACCOUNT],
      eth_chainId: '0x1',
      personal_sign: refused,
    });
    for (const w of [atConnect, atSign]) {
      const c = calls();
      const e = await signInWithEvmWallet(w, c).catch((error: unknown) => error);
      expect(read(e)).toEqual(['rejected', null]);
      expect(c.login).not.toHaveBeenCalled();
    }
  });

  it('signs nobody in when the wallet gives no account, no chain or no signature', async () => {
    for (const answers of [
      { eth_requestAccounts: [] },
      { eth_requestAccounts: ['not an address'] },
      { eth_requestAccounts: [ACCOUNT], eth_chainId: 'nonsense' },
      { eth_requestAccounts: [ACCOUNT], eth_chainId: '0x1', personal_sign: null },
    ]) {
      const c = calls();
      const e = await signInWithEvmWallet(wallet(answers), c).catch((error: unknown) => error);
      expect(read(e)).toEqual(['unknown', 'wallet_silent']);
      expect(c.login).not.toHaveBeenCalled();
    }
  });
});

describe('signing in with a Solana wallet of the wallet standard', () => {
  const ADDRESS = 'So11111111111111111111111111111111111111112';
  const SIGNATURE = Uint8Array.from({ length: 64 }, (_, i) => i);

  it('connects, has the wallet sign the provider’s message, and hands over the signature in base64', async () => {
    const signMessage = vi.fn(async () => [{ signature: SIGNATURE }]);
    const wallet = {
      name: 'Phantom',
      features: {
        'standard:connect': { connect: async () => ({ accounts: [{ address: ADDRESS }] }) },
        'solana:signMessage': { signMessage },
      },
    };
    const generate = vi.fn(async () => 'sign in with Solana');
    const login = vi.fn(async (_sent: unknown) => ({}));
    await signInWithSolanaWallet(wallet, { generate, login });
    expect(generate).toHaveBeenCalledWith({ address: ADDRESS });
    const [input] = signMessage.mock.calls[0] as unknown as [
      { account: { address: string }; message: Uint8Array },
    ];
    expect(input.account.address).toBe(ADDRESS);
    expect(new TextDecoder().decode(input.message)).toBe('sign in with Solana');
    const sent = login.mock.calls[0]?.[0] as unknown as {
      signature: string;
      walletClientType: string;
      connectorType: string;
    };
    expect([...base64Decode(sent.signature)]).toEqual([...SIGNATURE]);
    expect([sent.walletClientType, sent.connectorType]).toEqual(['phantom', 'solana_adapter']);
  });

  it('refuses a wallet that cannot sign a message, and one that gives no account', async () => {
    const calls = { generate: vi.fn(async () => 'm'), login: vi.fn(async () => ({})) };
    const noSign = {
      name: 'Old',
      features: { 'standard:connect': { connect: async () => ({ accounts: [] }) } },
    };
    expect(read(await signInWithSolanaWallet(noSign, calls).catch((e: unknown) => e))).toEqual([
      'unsupported',
      'unsupported',
    ]);
    const empty = {
      name: 'Locked',
      features: {
        'standard:connect': { connect: async () => ({ accounts: [] }) },
        'solana:signMessage': { signMessage: async () => [] },
      },
    };
    expect(read(await signInWithSolanaWallet(empty, calls).catch((e: unknown) => e))).toEqual([
      'unknown',
      'wallet_silent',
    ]);
    expect(calls.login).not.toHaveBeenCalled();
  });

  it('does not list WalletConnect, which is a window of its own and not a wallet in the browser', () => {
    expect(inBrowser({ name: 'Phantom' })).toBe(true);
    expect(inBrowser({ name: 'Solflare' })).toBe(true);
    for (const name of ['WalletConnect', 'walletconnect', ' Wallet Connect '])
      expect(inBrowser({ name }), name).toBe(false);
  });

  it('files a wallet under its name in lower case', () => {
    expect(clientType('MetaMask')).toBe('metamask');
    expect(clientType(' Coinbase Wallet ')).toBe('coinbase_wallet');
  });
});

describe('the wallets a passkey sign-in owes a person', () => {
  const passkey = { type: 'passkey' };
  const embedded = (chainType: string) => ({
    type: 'wallet',
    chainType,
    walletClientType: 'privy',
  });

  it('is one of each family for someone with a passkey and no wallet', () => {
    expect(missingWallets([passkey])).toEqual(['solana', 'evm']);
    expect(missingWallets([])).toEqual(['solana', 'evm']);
  });

  it('is only the family that is not there yet', () => {
    expect(missingWallets([passkey, embedded('solana')])).toEqual(['evm']);
    expect(missingWallets([passkey, embedded('ethereum')])).toEqual(['solana']);
    expect(missingWallets([passkey, embedded('solana'), embedded('ethereum')])).toEqual([]);
    expect(
      missingWallets([{ type: 'wallet', chainType: 'solana', walletClientType: 'privy-v2' }]),
    ).toEqual(['evm']);
  });

  it('is none for someone who connected an outside wallet: that wallet is theirs', () => {
    expect(
      missingWallets([{ type: 'wallet', chainType: 'solana', walletClientType: 'phantom' }]),
    ).toEqual([]);
    expect(
      missingWallets([{ type: 'wallet', chainType: 'ethereum', walletClientType: null }]),
    ).toEqual([]);
  });

  it('knows Privy’s answer that the wallet is there already, by the words it throws', () => {
    // Privy 3.46: a plain Error; the code goes to its own event, not onto the error.
    expect(walletAlreadyThere(new Error('User already has an embedded wallet.'))).toBe(true);
    expect(walletAlreadyThere({ privyErrorCode: 'embedded_wallet_already_exists' })).toBe(true);
    for (const other of [new Error('Failed to connect to wallet proxy'), null, 'already', {}])
      expect(walletAlreadyThere(other)).toBe(false);
  });
});

describe('the wallets as the sign-in screen offers them', () => {
  const ICON = 'data:image/png;base64,iVBORw0KGgo=';
  const provider = { request: async () => null };

  it('keeps a wallet’s own icon when it is an image inline, and nothing else', () => {
    const read = (icon: unknown) =>
      readAnnouncement({ info: { rdns: 'app.phantom', name: 'Phantom', icon }, provider })?.icon;
    expect(read(ICON)).toBe(ICON);
    expect(read('data:image/svg+xml;base64,PHN2Zy8+')).toBe('data:image/svg+xml;base64,PHN2Zy8+');
    for (const bad of ['https://evil.example/i.png', 'javascript:alert(1)', 'data:text/html,x', 7])
      expect(read(bad)).toBeUndefined();
    expect(foundWallets([{ name: 'Backpack', icon: ICON }], [])[0]?.icon).toBe(ICON);
  });

  it('offers one entry per wallet, with the family of each way in, and no chain in its name', () => {
    const choices = walletChoices(
      foundWallets(
        [{ name: 'Phantom', icon: ICON }, { name: 'Solflare' }],
        [
          { rdns: 'app.phantom', name: 'Phantom', provider },
          { rdns: 'io.metamask', name: 'MetaMask', provider },
        ],
      ),
    );
    expect(choices.map((c) => [c.name, c.ids])).toEqual([
      ['MetaMask', { evm: 'evm:io.metamask' }],
      ['Phantom', { solana: 'solana:Phantom', evm: 'evm:app.phantom' }],
      ['Solflare', { solana: 'solana:Solflare' }],
    ]);
    expect(choices.find((c) => c.name === 'Phantom')?.icon).toBe(ICON);
  });

  it('joins only the wallets known to sign on both, by id, and never by a name an announcer chose', () => {
    const FAKE = 'data:image/png;base64,ZmFrZQ==';
    const choices = walletChoices(
      foundWallets(
        [{ name: 'Phantom', icon: ICON }],
        [
          // an EVM wallet that calls itself "Phantom", announcing before the real one
          { rdns: 'com.fake', name: 'Phantom', provider, icon: FAKE },
          { rdns: 'app.phantom', name: 'Phantom', provider },
          { rdns: 'io.other', name: 'Phantom', provider },
        ],
      ),
    );
    expect(choices.map((c) => [c.name, c.ids])).toEqual([
      ['Phantom', { evm: 'evm:com.fake' }],
      ['Phantom', { evm: 'evm:io.other' }],
      ['Phantom', { solana: 'solana:Phantom', evm: 'evm:app.phantom' }],
    ]);
    // the real one keeps its own icon; the fake keeps its own, and lends it to nobody
    expect(choices.find((c) => c.ids.solana)?.icon).toBe(ICON);
    expect(choices.find((c) => c.ids.evm === 'evm:com.fake')?.icon).toBe(FAKE);
    expect(choices.find((c) => c.ids.evm === 'evm:io.other')?.icon).toBeUndefined();
    // with the real EVM side absent, the fake does not take its slot
    const alone = walletChoices(
      foundWallets([{ name: 'Phantom' }], [{ rdns: 'com.fake', name: 'Phantom', provider }]),
    );
    expect(alone.find((c) => c.ids.solana)?.ids).toEqual({ solana: 'solana:Phantom' });
  });

  it('lists one Solana wallet per name: a second one called "Phantom" is not listed or used', () => {
    const real = { name: 'Phantom', icon: ICON };
    const fake = { name: 'Phantom ', icon: 'data:image/png;base64,ZmFrZQ==' };
    const kept = onePerName([real, { name: 'Backpack' }, fake, { name: '' }]);
    expect(kept).toEqual([real, { name: 'Backpack' }]);
    // the one kept is the first to register, object and all: it is the one a choice signs with
    expect(kept[0]).toBe(real);
    expect(foundWallets(kept, []).map((w) => [w.id, w.icon])).toEqual([
      ['solana:Backpack', undefined],
      ['solana:Phantom', ICON],
    ]);
  });

  it('never makes a passkey on a failed use, and offers one wherever one can be made', () => {
    for (const key of [
      'passkeyNotUsed',
      'passkeyUnknown',
      'passkeyNotRegistered',
      'tooMany',
      'other',
    ] as const)
      expect(offersNewPasskey(key), key).toBe(true);
    for (const key of ['passkeyOff', 'passkeyUnsupported'] as const)
      expect(offersNewPasskey(key), key).toBe(false);
  });
});

describe('the wallets found in the browser', () => {
  const announce = (target: EventTarget, info: unknown, provider: unknown = { request() {} }) =>
    target.dispatchEvent(
      Object.assign(new Event('eip6963:announceProvider'), { detail: { info, provider } }),
    );

  it('asks the wallets to announce themselves and lists each one once', () => {
    const target = new EventTarget();
    const asked = vi.fn();
    target.addEventListener('eip6963:requestProvider', asked);
    const seen: string[][] = [];
    const stop = watchEvmWallets(target, (wallets) => seen.push(wallets.map((w) => w.name)));
    expect(asked).toHaveBeenCalledTimes(1);
    announce(target, { rdns: 'io.metamask', name: 'MetaMask' });
    announce(target, { rdns: 'io.metamask', name: 'MetaMask' });
    announce(target, { rdns: 'app.phantom', name: 'Phantom' });
    expect(seen).toEqual([['MetaMask'], ['MetaMask', 'Phantom']]);
    stop();
    announce(target, { rdns: 'io.rabby', name: 'Rabby' });
    expect(seen).toHaveLength(2);
  });

  it('takes nothing that is not an announcement', () => {
    const provider = { request: async () => null };
    expect(readAnnouncement({ info: { rdns: 'io.metamask', name: 'MetaMask' }, provider })).toEqual(
      { rdns: 'io.metamask', name: 'MetaMask', provider },
    );
    for (const detail of [
      null,
      'text',
      { info: { rdns: 'io.metamask', name: 'MetaMask' } },
      { info: { rdns: '', name: 'MetaMask' }, provider },
      { info: { rdns: 'x', name: 7 }, provider },
      { info: { rdns: 'x', name: 'X' }, provider: {} },
    ])
      expect(readAnnouncement(detail)).toBeNull();
    // a name is cut to what a button can show
    expect(
      readAnnouncement({ info: { rdns: 'x', name: 'N'.repeat(200) }, provider })?.name,
    ).toHaveLength(40);
  });

  it('lists Solana wallets, then EVM wallets, each by name, with an id of their own', () => {
    const provider = { request: async () => null };
    expect(
      foundWallets(
        [{ name: 'Solflare' }, { name: 'Phantom' }],
        [
          { rdns: 'io.metamask', name: 'MetaMask', provider },
          { rdns: 'app.phantom', name: 'Phantom', provider },
        ],
      ),
    ).toEqual([
      { id: 'solana:Phantom', name: 'Phantom', family: 'solana' },
      { id: 'solana:Solflare', name: 'Solflare', family: 'solana' },
      { id: 'evm:io.metamask', name: 'MetaMask', family: 'evm' },
      { id: 'evm:app.phantom', name: 'Phantom', family: 'evm' },
    ]);
  });
});

describe('the port, for the sign-in screen', () => {
  it('hands the choice a person made to the driver: create or use, and which wallet', async () => {
    const signIn = vi.fn(async () => {});
    const port = createWalletPort({ ...idleDriver(), signIn }, chains);
    await port.signIn('passkey', { create: true });
    await port.signIn('passkey');
    await port.signIn('wallet', { wallet: 'evm:io.metamask' });
    expect(signIn.mock.calls).toEqual([
      ['passkey', { create: true }],
      ['passkey', undefined],
      ['wallet', { wallet: 'evm:io.metamask' }],
    ]);
  });

  it('lists the wallets the driver found, and none when it finds none', () => {
    expect(createWalletPort(idleDriver(), chains).found).toEqual([]);
    const found = [{ id: 'solana:Phantom', name: 'Phantom', family: 'solana' as const }];
    expect(createWalletPort({ ...idleDriver(), found }, chains).found).toEqual(found);
  });

  it('says what kind of problem keeps sign-in off', async () => {
    expect(createWalletPort(idleDriver(), chains).problemKind).toBeNull();
    expect(createWalletPort(idleDriver(), chains, 'not set').problemKind).toBe('setup');
    const down = createWalletPort(idleDriver(), chains, 'the API cannot be reached', {
      problemKind: 'api',
    });
    expect(down.problemKind).toBe('api');
    expect((await failure(down.ensureWallets())).reason).toBe('not_configured');
  });

  it('labels a chain as the API runs it: on the mock, on a test network, or off', () => {
    const own = createWalletPort(idleDriver(), chains);
    expect(own.network('solana')).toEqual({
      id: 'solana',
      name: 'Solana',
      networkName: 'devnet',
      provenance: 'sandbox',
      on: true,
    });
    const api = buildConfigForTest({ robinhood: { mode: 'readonly', provenance: 'sandbox' } });
    const told = createWalletPort(idleDriver(), chains, null, { api: api.chains });
    // the API's word wins: it alone knows a chain runs on the mock
    expect(told.network('solana')?.provenance).toBe('mock');
    expect(told.network('robinhood')?.provenance).toBe('sandbox');
    expect(told.network('base')).toMatchObject({ on: false, provenance: 'sandbox' });
  });

  it('says when a wallet is still owed, and nothing when sign-in is off', () => {
    expect(createWalletPort(idleDriver(), chains).walletsOwed).toBeNull();
    const owed = { ...idleDriver(), status: 'loading' as const, walletsOwed: 'failed' as const };
    expect(createWalletPort(owed, chains).walletsOwed).toBe('failed');
    expect(createWalletPort(owed, chains, 'not set').walletsOwed).toBeNull();
  });

  it('makes no wallet when the driver has none to make, and none for nobody', async () => {
    const ready = createWalletPort({ ...idleDriver(), status: 'ready' }, chains);
    await expect(ready.ensureWallets()).resolves.toBeUndefined();
    const make = vi.fn(async () => {});
    await createWalletPort(
      { ...idleDriver(), status: 'ready', ensureWallets: make },
      chains,
    ).ensureWallets();
    expect(make).toHaveBeenCalledTimes(1);
    expect((await failure(createWalletPort(idleDriver(), chains).ensureWallets())).code).toBe(
      'not_connected',
    );
  });
});

describe('the throwaway wallet, walked through both ways in', () => {
  it('signed in with a passkey, is a wallet of each family made in the app', async () => {
    const driver = await createTestDriver();
    await driver.signIn('passkey', { create: true });
    expect(driver.accounts.map((a) => [a.family, a.kind])).toEqual([
      ['solana', 'embedded'],
      ['evm', 'embedded'],
    ]);
  });

  it('signed in as one of its outside wallets, is that one wallet', async () => {
    const driver = await createTestDriver();
    expect(driver.found).toEqual(TEST_WALLETS);
    await driver.signIn('wallet', { wallet: 'test:evm' });
    expect(driver.accounts.map((a) => [a.family, a.kind])).toEqual([['evm', 'external']]);
    await driver.signOut();
    await driver.signIn('wallet', { wallet: 'test:solana' });
    expect(driver.accounts.map((a) => [a.family, a.kind])).toEqual([['solana', 'external']]);
    // signed out, the next passkey sign-in is a wallet made in the app again
    await driver.signOut();
    await driver.signIn('passkey');
    expect(driver.accounts.every((a) => a.kind === 'embedded')).toBe(true);
    // the whole port labels it MOCK
    expect(createWalletPort(driver, chains).network('solana')?.provenance).toBe('mock');
  });

  it('knows no other wallet', async () => {
    const driver = await createTestDriver();
    await expect(driver.signIn('wallet', { wallet: 'evm:io.metamask' })).rejects.toThrow();
    expect(driver.status).toBe('signed-out');
  });
});
