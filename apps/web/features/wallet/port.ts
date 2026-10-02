import {
  type BasketTx,
  type Chain,
  type ChainId,
  chainFamily,
  normalizeAddress,
  type WalletAccount,
  type WalletCaps,
  type WalletPort,
} from '@colosseum/schemas';
import { isHex, parseTransaction } from 'viem';
import { base58Encode, base64Decode, base64Encode, parseSolanaTx } from './bytes';
import { solanaCluster, type WalletChains } from './chains';
import type { EvmRequest, WalletDriver } from './driver';
import { fail, toWalletError, WalletPortError } from './errors';

/** WalletPort, plus what the web needs and the interface does not have yet. */
export interface WebWalletPort extends WalletPort {
  /** Why sign-in cannot work here (a missing variable), or null. */
  readonly problem: string | null;
  /** True for the throwaway wallet of tests and mock mode. */
  readonly test: boolean;
  /** Signs a line of text: base58 on Solana, 0x hex on EVM. Not in WalletPort; the dev page uses it. */
  signMessage(family: Chain, text: string): Promise<string>;
}

/** One prompt signs up to three Solana transactions (DESIGN-VAULT section 9). */
const SOLANA_BATCH = 3;

/**
 * The provider-independent half of the wallet. It checks that a transaction is for this chain, this
 * network and this account, hands the driver the bytes it was given, and turns every failure into a
 * WalletError. It never builds a transaction and never changes one.
 */
export function createWalletPort(
  driver: WalletDriver,
  chains: WalletChains,
  problem: string | null = null,
): WebWalletPort {
  const raw = new Map<string, string>();
  const accounts: WalletAccount[] = [];
  for (const a of driver.accounts) {
    let address: string;
    try {
      address = normalizeAddress(a.family, a.address);
    } catch {
      continue; // not an address of its family: it cannot own or sign anything here
    }
    const key = `${a.family}:${address}`;
    if (raw.has(key)) continue;
    raw.set(key, a.address);
    accounts.push({ family: a.family, address, kind: a.kind });
  }

  const active = (family: Chain) => accounts.find((a) => a.family === family) ?? null;

  const caps = (chain: ChainId): WalletCaps => {
    const family = chainFamily(chain);
    const embedded = active(family)?.kind === 'embedded';
    // An EVM wallet numbers each transaction from the chain, so the second is signed after the first
    // is sent. An external EVM wallet cannot sign without sending.
    return family === 'solana'
      ? { silent: embedded, batchSign: SOLANA_BATCH, signOnly: true }
      : { silent: embedded, batchSign: 1, signOnly: embedded };
  };

  const need = (chain: ChainId): WalletAccount => {
    if (problem) throw fail('not_configured', problem);
    if (driver.status !== 'ready') throw fail('not_connected', 'not signed in');
    const family = chainFamily(chain);
    const account = active(family);
    if (!account) throw fail('not_connected', `no ${family} wallet is connected`);
    return account;
  };
  const rawOf = (a: WalletAccount) => raw.get(`${a.family}:${a.address}`) ?? a.address;

  /** Is this transaction for this chain, this network and this account? */
  const check = (chain: ChainId, account: WalletAccount, tx: BasketTx) => {
    if (tx.chainId !== chain || tx.chain !== account.family)
      throw new WalletPortError(
        'wrong_chain',
        `the transaction is for ${tx.chainId}, not ${chain}`,
      );
    if (tx.signer !== account.address)
      throw fail('wrong_signer', 'the transaction is for another account');
    // What the mock builds is not a transaction, so no real key signs it.
    if (tx.provenance === 'mock' && !driver.test)
      throw fail('unsupported', 'a mock transaction is not signed by a real wallet');
  };

  const solanaBytes = (account: WalletAccount, tx: BasketTx): Uint8Array => {
    let bytes: Uint8Array;
    let wire: ReturnType<typeof parseSolanaTx>;
    try {
      bytes = base64Decode(tx.payload);
      wire = parseSolanaTx(bytes);
    } catch {
      throw fail('bad_transaction', 'the payload is not a Solana transaction');
    }
    if (!wire.signers.includes(account.address))
      throw fail('wrong_signer', 'the transaction does not ask this account to sign');
    if (wire.feePayer !== (tx.feePayer ?? tx.signer))
      throw fail('bad_transaction', 'the fee payer in the bytes is not the one stated');
    return bytes;
  };

  const evmRequest = (chain: ChainId, tx: BasketTx): EvmRequest => {
    const expected = chains[chain].config.evmChainId;
    if (!tx.evm) throw fail('bad_transaction', 'an EVM transaction names its target');
    const mock = tx.provenance === 'mock';
    // The mock builds for chain id 0, which is no network.
    if (!mock && tx.evm.chainId !== expected)
      throw new WalletPortError(
        'wrong_chain',
        `the transaction is for chain ${tx.evm.chainId}; this app is on ${chains[chain].config.networkName}`,
      );
    let to: string;
    let value: bigint;
    try {
      to = normalizeAddress('evm', tx.evm.to);
      value = BigInt(tx.evm.value);
    } catch {
      throw fail('bad_transaction', 'the target or the value cannot be read');
    }
    if (!isHex(tx.payload, { strict: true }) || value < 0n)
      throw fail('bad_transaction', 'the call data is not hex');
    return { to: to as `0x${string}`, data: tx.payload, value, chainId: tx.evm.chainId };
  };

  /** The signed transaction calls what was asked: same target, data, value and chain. */
  const sameCall = (signed: `0x${string}`, request: EvmRequest) => {
    let parsed: ReturnType<typeof parseTransaction>;
    try {
      parsed = parseTransaction(signed);
    } catch {
      throw fail('changed', 'the wallet did not return a signed transaction');
    }
    const same =
      parsed.to?.toLowerCase() === request.to &&
      (parsed.data ?? '0x').toLowerCase() === request.data.toLowerCase() &&
      (parsed.value ?? 0n) === request.value &&
      parsed.chainId === request.chainId;
    if (!same)
      throw fail('changed', 'the wallet signed a different call from the one it was given');
  };

  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      throw toWalletError(e);
    }
  };

  return {
    status: problem ? 'signed-out' : driver.status,
    userId: driver.userId,
    accounts,
    problem,
    test: driver.test,
    active,
    caps,

    signIn: (method) =>
      guard(async () => {
        if (problem) throw fail('not_configured', problem);
        await driver.signIn(method);
      }),
    signOut: () => guard(() => driver.signOut()),

    sign: (chain, txs) =>
      guard(async () => {
        const account = need(chain);
        const limits = caps(chain);
        if (!limits.signOnly)
          throw fail('unsupported', 'this wallet sends what it signs: use send()');
        if (txs.length > limits.batchSign)
          throw fail('unsupported', `this wallet signs ${limits.batchSign} at a time on ${chain}`);
        for (const tx of txs) check(chain, account, tx);
        // A mock transaction is not signed: the throwaway wallet hands it back as it came.
        if (txs.every((tx) => tx.provenance === 'mock')) return txs.map((tx) => tx.payload);
        if (account.family === 'solana') {
          const unsigned = txs.map((tx) => solanaBytes(account, tx));
          const cluster = solanaCluster(chains[chain]);
          const signed = await driver.signSolana(rawOf(account), unsigned, cluster);
          if (signed.length !== unsigned.length)
            throw fail('changed', 'the wallet returned a different number of transactions');
          return signed.map(base64Encode);
        }
        const [tx] = txs;
        if (!tx) return [];
        const request = evmRequest(chain, tx);
        const signed = await driver.signEvm(rawOf(account), request);
        sameCall(signed, request);
        return [signed];
      }),

    send: (chain, tx) =>
      guard(async () => {
        const account = need(chain);
        if (account.family !== 'evm' || caps(chain).signOnly)
          throw fail('unsupported', 'this wallet signs and hands the bytes back: use sign()');
        check(chain, account, tx);
        const txId = await driver.sendEvm(rawOf(account), evmRequest(chain, tx));
        return { txId };
      }),

    exportKey: (family) =>
      guard(async () => {
        if (driver.status !== 'ready') throw fail('not_connected', 'not signed in');
        const account = active(family);
        if (!account) throw fail('not_connected', `no ${family} wallet is connected`);
        if (account.kind !== 'embedded')
          throw fail('unsupported', 'the key of an outside wallet is exported from that wallet');
        await driver.exportKey(family, rawOf(account));
      }),

    authHeaders: () =>
      guard(async () => {
        // Signed out is not a failure: a route that needs no sign-in takes the same call.
        if (driver.status !== 'ready') return {};
        const tokens = await driver.tokens();
        if (!tokens) return {};
        if (!tokens.access) throw new WalletPortError('expired', 'the session has ended: sign in');
        const headers: Record<string, string> = { authorization: `Bearer ${tokens.access}` };
        if (tokens.identity) headers['privy-id-token'] = tokens.identity;
        return headers;
      }),

    signMessage: (family, text) =>
      guard(async () => {
        if (problem) throw fail('not_configured', problem);
        if (driver.status !== 'ready') throw fail('not_connected', 'not signed in');
        const account = active(family);
        if (!account) throw fail('not_connected', `no ${family} wallet is connected`);
        if (family === 'evm') return driver.signEvmMessage(rawOf(account), text);
        const bytes = new TextEncoder().encode(text);
        return base58Encode(await driver.signSolanaMessage(rawOf(account), bytes));
      }),
  };
}

const never = () => Promise.reject(fail('not_connected', 'not signed in'));

/** A driver with nothing behind it and nobody signed in. */
export function idleDriver(): WalletDriver {
  return {
    test: false,
    status: 'signed-out',
    userId: null,
    accounts: [],
    signIn: never,
    signOut: () => Promise.resolve(),
    signSolana: never,
    signSolanaMessage: never,
    signEvm: never,
    sendEvm: never,
    signEvmMessage: never,
    exportKey: never,
    tokens: () => Promise.resolve(null),
  };
}
