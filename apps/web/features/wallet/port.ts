import {
  type BasketTx,
  type Chain,
  type ChainId,
  type ChainStatus,
  chainFamily,
  normalizeAddress,
  type Provenance,
  RawAmount,
  type WalletAccount,
  type WalletCaps,
  type WalletPort,
} from '@colosseum/schemas';
import { isHex, parseTransaction, recoverTransactionAddress } from 'viem';
import {
  base58Decode,
  base58Encode,
  base64Decode,
  base64Encode,
  ed25519Valid,
  isZero,
  parseSolanaTx,
  type SolanaWire,
  sameBytes,
} from './bytes';
import { solanaCluster, type WalletChains } from './chains';
import type { EvmRequest, FoundWallet, SignInChoice, WalletDriver, WalletsOwed } from './driver';
import { fail, toWalletError, WalletPortError } from './errors';

/**
 * Why sign-in is off. `api`: the API did not answer, and is asked again. `setup`: this copy of the app
 * is not set up (a missing variable, networks that differ from the API's), which only the team can fix.
 */
export type ProblemKind = 'api' | 'setup';

/** A chain as this app and the API run it: for the name a screen shows, and the label beside it. */
export type ChainNetwork = {
  id: ChainId;
  /** "Solana", "Robinhood Chain". */
  name: string;
  /** "Solana devnet", "Robinhood Chain testnet". */
  networkName: string;
  /**
   * What a figure or a name from this chain is labelled: `mock` while the API runs the chain on the
   * mock, `sandbox` on a test network, `live` on mainnet. Anything but `live` is shown as not live.
   */
  provenance: Provenance;
  /**
   * False when the API has the chain switched off: nothing can be built there, so the chain is not
   * chosen in the switcher (ChainSwitch) and a plan is not asked for on it (GoalScreen).
   */
  on: boolean;
};

/** What the bridge knows beyond the driver: why sign-in is off, and the API's own account of its chains. */
export type PortContext = {
  problemKind?: ProblemKind;
  /** The chains of the API's GET /v1/config. Left out, the labels come from this app's own table. */
  api?: readonly ChainStatus[];
};

/** WalletPort, plus what the web needs and the interface does not have yet. */
export interface WebWalletPort extends WalletPort {
  /** Why sign-in cannot work here (a missing variable), or null. */
  readonly problem: string | null;
  /** What kind of problem that is, for the sentence a person reads. Null when there is none. */
  readonly problemKind: ProblemKind | null;
  /** True for the throwaway wallet of tests and mock mode. */
  readonly test: boolean;
  /** The outside wallets found in this browser, for the sign-in screen to list. */
  readonly found: FoundWallet[];
  /**
   * The same call as WalletPort's, with the choice a person made on the sign-in screen: create a
   * passkey or use one, and which wallet. With no choice a passkey is used, not created.
   */
  signIn(method: 'passkey' | 'wallet', choice?: SignInChoice): Promise<void>;
  /**
   * A passkey sign-in owes the person a wallet of each family, and they are not all there: `making`
   * while they are being made, `failed` when one could not be. The person is signed in (`userId` is
   * theirs) and the status is `loading`, never `ready`: the chain is not asked for with one wallet.
   */
  readonly walletsOwed: WalletsOwed | null;
  /** Makes the wallets a passkey sign-in owes the person, when making them failed the first time. */
  ensureWallets(): Promise<void>;
  /** The chain as it is run here, or null before the wallet has loaded. */
  network(chain: ChainId): ChainNetwork | null;
  /** Signs a line of text: base58 on Solana, 0x hex on EVM. Not in WalletPort; the dev page uses it. */
  signMessage(family: Chain, text: string): Promise<string>;
  /**
   * WalletPort's call, and with `fresh` after the API refused the sign-in: tokens newer than those
   * sent, if the wallet can get them.
   */
  authHeaders(options?: { fresh?: boolean }): Promise<Record<string, string>>;
}

/**
 * The members of the port that reach a key: they sign, send, or show one. A screen is never handed
 * them (`ScreenPort`). The whole port is behind `useSigningPort()` in signing.ts, and
 * components/shell/product-routes.test.ts holds who may import that.
 */
export const SIGNING_MEMBERS = ['sign', 'send', 'signMessage', 'exportKey'] as const;
export type SigningMember = (typeof SIGNING_MEMBERS)[number];

/** The wallet as a screen has it: who is signed in and with what, and no way to a signature. */
export type ScreenPort = Omit<WebWalletPort, SigningMember>;

/** The port without its signing members: a new object that does not have them at all. */
export function screenPort(port: WebWalletPort): ScreenPort {
  const {
    sign: _sign,
    send: _send,
    signMessage: _signMessage,
    exportKey: _exportKey,
    ...rest
  } = port;
  return rest;
}

/** One prompt signs up to three Solana transactions (DESIGN-VAULT section 9). */
const SOLANA_BATCH = 3;

/**
 * How far above the fee a transaction states the wallet may go. The wallet sets the fee itself, at
 * about twice the base fee with room on the gas, so the stated fee is a guide and not a limit.
 */
const FEE_FACTOR = 10n;

/**
 * The provider-independent half of the wallet. It checks that a transaction is for this chain, this
 * network and this account, hands the driver the bytes it was given, and turns every failure into a
 * WalletError. It never builds a transaction and never changes one.
 */
export function createWalletPort(
  driver: WalletDriver,
  chains: WalletChains,
  problem: string | null = null,
  context: PortContext = {},
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
      throw fail('wrong_account', 'the transaction is for another account');
    // What the mock builds is not a transaction, so no real key signs it.
    if (tx.provenance === 'mock') {
      if (!driver.test)
        throw fail('unsupported', 'a mock transaction is not signed by a real wallet');
      return;
    }
    // Solana's bytes do not name a network, so the label is what tells devnet from mainnet. A
    // transaction labelled for the other network, or as a fixture, is not for this wallet.
    if (tx.provenance !== chains[chain].provenance)
      throw new WalletPortError(
        'wrong_chain',
        `the transaction is labelled ${tx.provenance}; this app is on ${chains[chain].config.networkName}`,
      );
  };

  type Sent = { bytes: Uint8Array; wire: SolanaWire };
  const solanaBytes = (account: WalletAccount, tx: BasketTx): Sent => {
    let bytes: Uint8Array;
    let wire: SolanaWire;
    try {
      bytes = base64Decode(tx.payload);
      wire = parseSolanaTx(bytes);
    } catch {
      throw fail('bad_transaction', 'the payload is not a Solana transaction');
    }
    if (!wire.signers.includes(account.address))
      throw fail('wrong_account', 'the transaction does not ask this account to sign');
    if (wire.feePayer !== (tx.feePayer ?? tx.signer))
      throw fail('bad_transaction', 'the fee payer in the bytes is not the one stated');
    return { bytes, wire };
  };

  /** What came back is what was sent, with this account's signature on it and nothing else changed. */
  const sameTransaction = async (account: WalletAccount, sent: Sent, back: Uint8Array) => {
    let wire: SolanaWire;
    try {
      wire = parseSolanaTx(back);
    } catch {
      throw fail('changed', 'the wallet did not return a transaction');
    }
    if (!sameBytes(wire.message, sent.wire.message))
      throw fail('changed', 'the wallet signed a different transaction from the one it was given');
    // The message is the one sent, so the account is among its signers as it was there.
    const signature = wire.signatures[wire.signers.indexOf(account.address)] as Uint8Array;
    if (isZero(signature)) throw fail('changed', 'the wallet returned the transaction unsigned');
    let valid: boolean;
    try {
      valid = await ed25519Valid(base58Decode(account.address), signature, wire.message);
    } catch {
      throw fail('unsupported', 'this browser cannot check an Ed25519 signature');
    }
    if (!valid) throw fail('wrong_account', "the signature is not this account's");
  };

  const evmRequest = (chain: ChainId, tx: BasketTx): EvmRequest => {
    const expected = chains[chain].config.evmChainId;
    if (!tx.evm) throw fail('bad_transaction', 'an EVM transaction names its target');
    if (tx.evm.chainId !== expected)
      throw new WalletPortError(
        'wrong_chain',
        `the transaction is for chain ${tx.evm.chainId}; this app is on ${chains[chain].config.networkName}`,
      );
    let to: string;
    let value: bigint;
    try {
      to = normalizeAddress('evm', tx.evm.to);
      // Raw units as a decimal string and nothing else: BigInt alone reads '' as 0 and ' 7 ' as 7.
      value = BigInt(RawAmount.parse(tx.evm.value));
    } catch {
      throw fail('bad_transaction', 'the target or the value cannot be read');
    }
    if (!isHex(tx.payload, { strict: true }) || tx.payload.length % 2 !== 0)
      throw fail('bad_transaction', 'the call data is not whole bytes of hex');
    const call = { to: to as `0x${string}`, data: tx.payload, value, chainId: tx.evm.chainId };
    // The server states the nonce, the gas and the whole fee (the gas at its price per gas): the price
    // per gas is that fee over the gas, with no tip, which keeps gas times price at the stated fee.
    const fee = RawAmount.safeParse(tx.preview.feeNativeRaw);
    const { nonce, gas } = tx.evm;
    if (nonce === undefined || gas === undefined || !fee.success || BigInt(fee.data) === 0n)
      return call;
    return {
      ...call,
      nonce,
      gas: BigInt(gas),
      maxFeePerGas: BigInt(fee.data) / BigInt(gas),
      maxPriorityFeePerGas: 0n,
    };
  };

  /** The most the wallet may commit to fees on this transaction. */
  const feeCeiling = (chain: ChainId, tx: BasketTx): bigint => {
    const stated = RawAmount.safeParse(tx.preview.feeNativeRaw);
    if (!stated.success) throw fail('bad_transaction', 'the stated fee cannot be read');
    if (BigInt(stated.data) > 0n) return BigInt(stated.data) * FEE_FACTOR;
    // A chain with no ceiling of its own allows no fee at all here.
    return chains[chain].feeCeilingRaw ?? 0n;
  };

  /**
   * The signed transaction is the call that was asked, in a form this app signs, with a fee under the
   * ceiling, signed by this account. The wallet is handed the nonce, gas and fee the server stated and
   * may sign with others, so on EVM this is the only place the whole of what was signed is seen.
   */
  const sameCall = async (
    account: WalletAccount,
    signed: `0x${string}`,
    request: EvmRequest,
    ceiling: bigint,
  ) => {
    let parsed: ReturnType<typeof parseTransaction>;
    try {
      parsed = parseTransaction(signed);
    } catch {
      throw fail('changed', 'the wallet did not return a signed transaction');
    }
    // An access list is refused as well as the types built on one: nothing here asks for either, and
    // an authorization list (EIP-7702) would hand the account's code to another contract.
    if (parsed.type !== 'legacy' && parsed.type !== 'eip1559')
      throw fail('changed', `the wallet returned a transaction of a type this app does not sign`);
    if (parsed.accessList?.length)
      throw fail('changed', 'the wallet added an access list to the transaction');
    const same =
      parsed.to?.toLowerCase() === request.to &&
      (parsed.data ?? '0x').toLowerCase() === request.data.toLowerCase() &&
      (parsed.value ?? 0n) === request.value &&
      parsed.chainId === request.chainId;
    if (!same)
      throw fail('changed', 'the wallet signed a different call from the one it was given');
    const perGas = parsed.type === 'legacy' ? parsed.gasPrice : parsed.maxFeePerGas;
    if (parsed.gas === undefined || perGas === undefined || parsed.gas * perGas > ceiling)
      throw fail(
        'changed',
        `the wallet set a fee above the ${ceiling} allowed for this transaction`,
      );
    let from: string;
    try {
      from = await recoverTransactionAddress({
        serializedTransaction: signed as Parameters<
          typeof recoverTransactionAddress
        >[0]['serializedTransaction'],
      });
    } catch {
      throw fail('changed', 'the wallet returned the transaction unsigned');
    }
    if (from.toLowerCase() !== account.address)
      throw fail('wrong_account', "the signature is not this account's");
  };

  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      throw toWalletError(e);
    }
  };

  const network = (chain: ChainId): ChainNetwork => {
    const mine = chains[chain];
    const theirs = context.api?.find((c) => c.id === chain);
    return {
      id: chain,
      name: mine.config.name,
      networkName: mine.config.networkName,
      // The API's label wins: it alone knows that a chain runs on the mock. A chain it has off has
      // no label there, and keeps this app's.
      provenance: driver.test ? 'mock' : (theirs?.provenance ?? mine.provenance),
      on: theirs ? theirs.mode !== 'off' : true,
    };
  };

  return {
    status: problem ? 'signed-out' : driver.status,
    userId: driver.userId,
    accounts,
    problem,
    problemKind: problem ? (context.problemKind ?? 'setup') : null,
    test: driver.test,
    found: driver.found ?? [],
    walletsOwed: problem ? null : (driver.walletsOwed ?? null),
    active,
    caps,
    network,

    signIn: (method, choice) =>
      guard(async () => {
        if (problem) throw fail('not_configured', problem);
        await driver.signIn(method, choice);
      }),
    signOut: () => guard(() => driver.signOut()),
    ensureWallets: () =>
      guard(async () => {
        if (problem) throw fail('not_configured', problem);
        if (driver.status === 'signed-out') throw fail('not_connected', 'not signed in');
        await driver.ensureWallets?.();
      }),

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
          const sent = txs.map((tx) => solanaBytes(account, tx));
          const cluster = solanaCluster(chains[chain]);
          const signed = await driver.signSolana(
            rawOf(account),
            sent.map((s) => s.bytes),
            cluster,
          );
          if (signed.length !== sent.length)
            throw fail('changed', 'the wallet returned a different number of transactions');
          // One for one and in order: the first that came back is checked against the first sent.
          for (const [i, back] of signed.entries())
            await sameTransaction(account, sent[i] as Sent, back);
          return signed.map(base64Encode);
        }
        const tx = txs[0] as BasketTx; // one at a time on EVM, and an empty call has returned above
        const request = evmRequest(chain, tx);
        const ceiling = feeCeiling(chain, tx);
        const signed = await driver.signEvm(rawOf(account), request);
        await sameCall(account, signed, request, ceiling);
        return [signed];
      }),

    send: (chain, tx) =>
      guard(async () => {
        const account = need(chain);
        // Every Solana wallet, and an EVM wallet made at sign-in, hands the signed bytes back.
        if (caps(chain).signOnly)
          throw fail('unsupported', 'this wallet signs and hands the bytes back: use sign()');
        check(chain, account, tx);
        // The mock builds for chain id 0, which is no network: there is nowhere to send it.
        if (tx.provenance === 'mock')
          throw fail('unsupported', 'a mock transaction is not sent: report it as it was built');
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

    authHeaders: (options) =>
      guard(async () => {
        // Signed out is not a failure: a route that needs no sign-in takes the same call.
        if (driver.status !== 'ready') return {};
        const tokens = await driver.tokens(options);
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
