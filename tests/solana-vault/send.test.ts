import {
  createSolanaProbe,
  messageHashOfWire,
  type VaultWriteRpc,
} from '@colosseum/chain-solana/vault';
import { ChainError, type ChainErrorCode } from '@colosseum/schemas';
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPair,
  getAddressDecoder,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Transaction,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';

// The probe (`send.ts`) against a node in memory: what it answers for each thing a node can say. The
// same calls run against a real validator in validator.test.ts; these are the answers a run there
// cannot be steered into (a node that is down, a blockhash that ran out, a landing between two looks).

const PROGRAM = getAddressDecoder().decode(new Uint8Array(32).fill(4));
const base58 = getBase58Decoder();

async function signedTx(n: number) {
  const pair = await generateKeyPair();
  const payer = await getAddressFromPublicKey(pair.publicKey);
  const tx = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(payer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: base58.decode(new Uint8Array(32).fill(9)) as never,
            lastValidBlockHeight: 500n,
          },
          m,
        ),
      (m) =>
        appendTransactionMessageInstructions(
          [{ programAddress: PROGRAM, data: new Uint8Array([n]) }],
          m,
        ),
    ),
  );
  const signed = await partiallySignTransaction([pair], tx);
  return { payer, unsigned: tx, signed, wire: getBase64EncodedWireTransaction(signed) };
}
const idOf = (tx: Transaction) => base58.decode(Object.values(tx.signatures)[0] as Uint8Array);

type Landed = { slot: bigint; wire: string; err: unknown };
function node() {
  const state = {
    landed: new Map<string, Landed>(),
    bySigner: new Map<string, string[]>(),
    height: 100n,
    sendFails: false,
    simulated: null as null | { err: unknown; logs: string[] },
    fetched: [] as string[],
    /** Runs before each answer: what lands on the chain between two questions. */
    before: (_method: string) => {},
  };
  const answer = <T>(method: string, work: () => T) => ({
    send: async () => {
      state.before(method);
      return work();
    },
  });
  const land = (tx: Transaction, payer: Address, slot: bigint) => {
    const id = idOf(tx);
    state.landed.set(id, { slot, wire: getBase64EncodedWireTransaction(tx), err: null });
    state.bySigner.set(payer, [id, ...(state.bySigner.get(payer) ?? [])]);
    return id;
  };
  const rpc = {
    sendTransaction: () =>
      answer('sendTransaction', () => {
        if (state.sendFails) throw new Error('node said no: https://rpc.example/?key=SECRET');
        return 'ok';
      }),
    simulateTransaction: () =>
      answer('simulateTransaction', () => ({
        context: { slot: 1n },
        value: {
          err: state.simulated?.err ?? null,
          logs: state.simulated?.logs ?? [],
          accounts: null,
        },
      })),
    getSignatureStatuses: (ids: string[]) =>
      answer('getSignatureStatuses', () => ({
        context: { slot: 1n },
        value: ids.map((id) =>
          state.landed.has(id)
            ? { slot: 1n, confirmations: null, err: null, confirmationStatus: 'confirmed' }
            : null,
        ),
      })),
    getTransaction: (id: string) =>
      answer('getTransaction', () => {
        state.fetched.push(id);
        const found = state.landed.get(id);
        return found
          ? { slot: found.slot, meta: { err: found.err }, transaction: [found.wire, 'base64'] }
          : null;
      }),
    getSignaturesForAddress: (address: string) =>
      answer('getSignaturesForAddress', () =>
        (state.bySigner.get(address) ?? []).map((signature) => ({
          signature,
          slot: state.landed.get(signature)?.slot ?? 0n,
          err: null,
        })),
      ),
    getBlockHeight: () => answer('getBlockHeight', () => state.height),
  } as unknown as VaultWriteRpc;
  return { state, rpc, land };
}

async function refused(work: Promise<unknown>, code: ChainErrorCode) {
  const outcome = await work.then(
    () => 'answered',
    (e: unknown) => e,
  );
  expect(outcome).toBeInstanceOf(ChainError);
  expect((outcome as ChainError).code).toBe(code);
  return outcome as ChainError;
}

describe('the Solana probe', () => {
  it('reads the message hash back from signed bytes, the same as from the bytes before signing', async () => {
    const { rpc } = node();
    const probe = createSolanaProbe({ rpc, program: PROGRAM });
    const t = await signedTx(1);
    const unsigned = getTransactionEncoder().encode(t.unsigned);
    expect(await probe.messageHashOf(t.wire)).toBe(
      await messageHashOfWire(new Uint8Array(unsigned)),
    );
    await refused(probe.messageHashOf('not base64 at all!'), 'BadInput');
    await refused(probe.messageHashOf(Buffer.from([1, 2, 3]).toString('base64')), 'BadInput');
    // A transaction with bytes after it is not one transaction.
    const longer = Buffer.concat([Buffer.from(t.wire, 'base64'), Buffer.from([0])]).toString(
      'base64',
    );
    await refused(probe.messageHashOf(longer), 'BadInput');
  });

  it('relays only bytes every signer signed, and answers the id', async () => {
    const { rpc, state, land } = node();
    const probe = createSolanaProbe({ rpc, program: PROGRAM });
    const t = await signedTx(2);
    expect(await probe.relay(t.wire)).toEqual({ txId: idOf(t.signed) });
    land(t.signed, t.payer, 60n);
    await refused(probe.relay(getBase64EncodedWireTransaction(t.unsigned)), 'BadInput');
    const other = await signedTx(3);
    // The other transaction's signature over these bytes.
    const forged = {
      ...t.signed,
      signatures: { [t.payer]: Object.values(other.signed.signatures)[0] },
    };
    await refused(probe.relay(getBase64EncodedWireTransaction(forged as Transaction)), 'BadInput');
    // Sent twice: the node has them, and the same id comes back.
    state.sendFails = true;
    expect(await probe.relay(t.wire)).toEqual({ txId: idOf(t.signed) });
  });

  it("refuses bytes the chain will not take, in the program's words, and hides the node's", async () => {
    const { rpc, state } = node();
    const probe = createSolanaProbe({ rpc, program: PROGRAM });
    const t = await signedTx(4);
    state.sendFails = true;
    state.simulated = {
      err: { InstructionError: [0, { Custom: 6006 }] },
      logs: [
        `Program ${PROGRAM} invoke [1]`,
        `Program ${PROGRAM} failed: custom program error: 0x1776`,
      ],
    };
    expect((await refused(probe.relay(t.wire), 'ReceivedTooLittle')).retryable).toBe(true);
    state.simulated = null;
    const e = await refused(probe.relay(t.wire), 'Unavailable');
    expect(e.message).not.toMatch(/SECRET|rpc\.example/);
  });

  it('says of an id: this message, another one, or one the node has not seen', async () => {
    const { rpc, land } = node();
    const probe = createSolanaProbe({ rpc, program: PROGRAM });
    const [one, other] = [await signedTx(5), await signedTx(6)];
    const id = land(one.signed, one.payer, 50n);
    const hash = await probe.messageHashOf(one.wire);
    expect(await probe.carries(id, hash)).toBe('this');
    expect(await probe.carries(id, await probe.messageHashOf(other.wire))).toBe('another');
    expect(await probe.carries(idOf(other.signed), hash)).toBe('unseen');
    await refused(probe.carries('nope', hash), 'BadInput');
  });

  it("finds an attempt nobody reported among its signer's transactions; open until its blockhash runs out, then gone", async () => {
    const { rpc, state, land } = node();
    const probe = createSolanaProbe({ rpc, program: PROGRAM });
    const t = await signedTx(7);
    const attempt = {
      messageHash: await probe.messageHashOf(t.wire),
      signer: t.payer,
      validUntil: '500',
      nonce: null,
    };
    expect(await probe.fate(attempt)).toEqual({ state: 'open' });
    state.height = 501n;
    expect(await probe.fate(attempt)).toEqual({ state: 'gone' });
    // It lands between the two looks: found on the second, never called gone.
    state.before = (method) => {
      if (method === 'getBlockHeight' && !state.landed.has(idOf(t.signed)))
        land(t.signed, t.payer, 450n);
    };
    expect(await probe.fate(attempt)).toEqual({ state: 'landed', txId: idOf(t.signed) });
    await refused(probe.fate({ ...attempt, signer: 'x' }), 'BadInput');
  });

  it('does not look through transactions from before the attempt could have landed', async () => {
    const { rpc, state, land } = node();
    const probe = createSolanaProbe({ rpc, program: PROGRAM });
    const [old, newer] = [await signedTx(8), await signedTx(9)];
    land(old.signed, old.payer, 100n);
    // The same signer's later transaction, in a slot the attempt's blockhash still reaches.
    state.bySigner.set(old.payer, [idOf(newer.signed), ...(state.bySigner.get(old.payer) ?? [])]);
    state.landed.set(idOf(newer.signed), { slot: 900n, wire: newer.wire, err: null });
    const attempt = {
      messageHash: await probe.messageHashOf(old.wire),
      signer: old.payer,
      validUntil: '1000',
      nonce: null,
    };
    state.height = 900n;
    expect(await probe.fate(attempt)).toEqual({ state: 'open' });
    expect(state.fetched).toEqual([idOf(newer.signed)]);
  });

  it('has no nonce to report: Solana has none', async () => {
    const { rpc } = node();
    const probe = createSolanaProbe({ rpc, program: PROGRAM });
    const t = await signedTx(10);
    expect(await probe.nonceOf({ signedTx: t.wire })).toBeNull();
    expect(await probe.nonceOf({ txId: idOf(t.signed) })).toBeNull();
    await refused(probe.nonceOf({ signedTx: 'AAAA' }), 'BadInput');
  });
});
