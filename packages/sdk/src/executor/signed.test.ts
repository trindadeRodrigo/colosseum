import { describe, expect, it, vi } from 'vitest';
import * as e from '../../test/evm';
import vectors from '../../test/fixtures/evm-vectors.json';
import * as s from '../../test/solana';
import { base58Encode, base64Decode, base64Encode, hexDecode, hexEncode } from '../bytes';
import { BASKET_PROGRAM } from '../guard/generated/basket-program';
import type { Guarded } from '../guard/run';
import type { ApprovedStep } from '../guard/types';
import {
  chainReadOf,
  type RpcCall,
  rpcAt,
  SOLANA_MARGIN_BLOCKS,
  SOLANA_VALID_BLOCKS,
} from './chain-read';
import { heldToPass, signedEvm, signedSolana } from './signed';

vi.mock('../guard/generated/deployment-files', () => import('../../test/deployments'));

// What the executor reads from the bytes a wallet handed back, and the rule that says whether they can
// still land. The EVM transactions are viem's own serialization (test/fixtures/evm-vectors.json), with
// a signature made of fixed bytes; the Solana ones are @solana/kit's.

const depositStep: ApprovedStep = {
  legId: 'leg-1',
  chain: 'solana',
  owner: s.OWNER,
  basketId: s.BASKET_ID,
  kind: 'deposit',
  amountRaw: '1000',
  trades: [],
};
const SIGNATURE = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256);
/** The transaction with its one signature slot filled, as a wallet hands it back. */
const signedBy = (payload: string, signature = SIGNATURE) => {
  const bytes = base64Decode(payload);
  bytes.set(signature, 1);
  return base64Encode(bytes);
};
const built = async () => s.wire([await s.depositIx(BASKET_PROGRAM, '1000')]);
const passOf = (tx: unknown) => ({ tx, step: depositStep }) as Guarded;

describe('a signed Solana transaction, read from its bytes', () => {
  it('names its signature and the blockhash it is bound to', async () => {
    const { payload } = await built();
    const signed = signedSolana(signedBy(payload));
    expect(signed.signature).toBe(base58Encode(SIGNATURE));
    expect(signed.blockhash).toBe(s.someone('blockhash'));
    expect(hexEncode(signed.message)).toBe(hexEncode(base64Decode(payload).slice(65)));
  });

  it('refuses one nobody signed, and anything that is not a transaction', async () => {
    const { payload } = await built();
    expect(() => signedSolana(payload)).toThrow(/not signed/);
    expect(() => signedSolana(`${signedBy(payload)}AAAA`)).toThrow();
    expect(() => signedSolana('0x02')).toThrow();
    expect(() => signedSolana('')).toThrow();
  });

  it('is the transaction the guard passed only when its message is the same, byte for byte', async () => {
    const { payload } = await built();
    const pass = passOf(s.solanaTx(depositStep, { payload, messageHash: '' }));
    expect(() => heldToPass(pass, s.SOLANA, signedBy(payload))).not.toThrow();
    // The same instructions for another amount: a wallet that signed something else.
    const other = s.wire([await s.depositIx(BASKET_PROGRAM, '1001')]);
    expect(() => heldToPass(pass, s.SOLANA, signedBy(other.payload))).toThrow(/another message/);
    expect(() => heldToPass(pass, s.SOLANA, payload)).toThrow(/not signed/);
  });
});

describe('a signed EVM transaction, read from its bytes', () => {
  it("reads every field of viem's own serialization: legacy, type 1 and type 2", () => {
    expect(vectors.signed.length).toBeGreaterThan(20);
    expect(new Set(vectors.signed.map((v) => v.type))).toEqual(
      new Set(['legacy', 'eip2930', 'eip1559']),
    );
    for (const v of vectors.signed) {
      const signed = signedEvm(v.raw);
      expect(
        {
          hash: signed.hash,
          type: ['legacy', 'eip2930', 'eip1559'][signed.type],
          chainId: signed.chainId === null ? null : signed.chainId.toString(),
          nonce: signed.nonce,
          to: signed.to,
          value: signed.value.toString(),
          data: `0x${hexEncode(signed.data)}`,
          accessList: signed.accessList,
        },
        v.raw.slice(0, 40),
      ).toEqual({
        hash: v.hash,
        type: v.type,
        chainId: v.chainId,
        nonce: v.nonce,
        to: v.to,
        value: v.value,
        data: v.data,
        accessList: v.accessList,
      });
    }
  });

  it('reads no transaction that carries an authorization list, and nothing that is nearly a transaction', () => {
    expect(() => signedEvm(vectors.delegating)).toThrow(/type the executor does not read/);
    const [first] = vectors.signed;
    if (!first) throw new Error('no vector');
    const raw = hexDecode(first.raw);
    const hex = (bytes: Uint8Array) => `0x${hexEncode(bytes)}`;
    expect(() => signedEvm('0x')).toThrow(/empty/);
    expect(() => signedEvm(hex(raw.slice(0, -1)))).toThrow(/ends early/);
    expect(() => signedEvm(`${first.raw}00`)).toThrow(/left over/);
    // Type 3 (blobs), and a type nobody has defined.
    expect(() => signedEvm(hex(Uint8Array.of(3, ...raw.slice(1))))).toThrow(/type/);
    expect(() => signedEvm(hex(Uint8Array.of(0x7f, ...raw.slice(1))))).toThrow(/type/);
    // The body of a type 2 transaction under the type 1 byte: one field too many.
    expect(() => signedEvm(hex(Uint8Array.of(1, ...raw.slice(1))))).toThrow(/number of fields/);
    // A list where the nonce is, and bytes where the whole is a list.
    expect(() => signedEvm('0x02c3c0c0c0')).toThrow(/number of fields/);
    expect(() => signedEvm('0x0283010203')).toThrow(/not a list/);
    // Lengths written the long way.
    expect(() => signedEvm('0x02b80180')).toThrow(/long way/);
    expect(() => signedEvm('0x028105')).toThrow(/long way/);
    expect(() => signedEvm('0x02f800')).toThrow(/long way/);
    expect(() => signedEvm('0x02f90001c0')).toThrow(/long way/);
  });

  it('refuses a transaction with no signature in it', () => {
    // Twelve fields, the last two empty: r and s are zero.
    const unsigned = `0x02${'cc'}${'80'.repeat(8)}${'c0'}${'80'.repeat(3)}`;
    expect(() => signedEvm(unsigned)).toThrow(/not signed/);
  });

  it('is the call the guard passed only on its chain, to its target, with no value, its data and no access list', () => {
    const plain = vectors.signed.filter(
      (v) => v.chainId === String(e.CHAIN_ID) && v.to && v.value === '0' && v.accessList === 0,
    );
    expect(plain.map((v) => v.type)).toEqual(
      expect.arrayContaining(['legacy', 'eip2930', 'eip1559']),
    );
    const callOf = (v: (typeof plain)[number], change: Record<string, unknown> = {}) =>
      passOf({ payload: v.data, evm: { to: v.to, value: '0', chainId: e.CHAIN_ID }, ...change });
    for (const v of plain) {
      expect(() => heldToPass(callOf(v), e.EVM, v.raw), v.type).not.toThrow();
      // A target in upper case is the same target.
      const upper = {
        to: `0x${(v.to as string).slice(2).toUpperCase()}`,
        value: '0',
        chainId: e.CHAIN_ID,
      };
      expect(() => heldToPass(callOf(v, { evm: upper }), e.EVM, v.raw)).not.toThrow();
      const another = { to: e.STRANGER, value: '0', chainId: e.CHAIN_ID };
      expect(() => heldToPass(callOf(v, { evm: another }), e.EVM, v.raw)).toThrow(
        /another transaction/,
      );
      expect(() => heldToPass(callOf(v, { payload: `${v.data}00` }), e.EVM, v.raw)).toThrow(
        /another transaction/,
      );
    }
    const [one] = plain;
    if (!one) throw new Error('no vector');
    // Signed for another chain, for no chain, with value, with an access list, or creating a contract.
    const wrong = vectors.signed.filter(
      (v) => v.chainId !== String(e.CHAIN_ID) || !v.to || v.value !== '0' || v.accessList !== 0,
    );
    expect(wrong.some((v) => v.chainId === null)).toBe(true);
    expect(wrong.some((v) => v.value !== '0')).toBe(true);
    expect(wrong.some((v) => v.accessList > 0 && v.chainId === String(e.CHAIN_ID))).toBe(true);
    expect(wrong.some((v) => v.to === null)).toBe(true);
    for (const v of wrong) {
      const pass = passOf({
        payload: v.data,
        evm: { to: v.to ?? one.to, value: '0', chainId: e.CHAIN_ID },
      });
      expect(() => heldToPass(pass, e.EVM, v.raw), v.raw.slice(0, 30)).toThrow(
        /another transaction/,
      );
    }
    expect(() => heldToPass(callOf(one), e.EVM, vectors.delegating)).toThrow(/type/);
  });
});

describe('whether a signed transaction can still land, by the chain itself', () => {
  /** One node, answering each method as it is told to, and writing down what it was asked. */
  const nodeOf = (answers: Record<string, unknown>) => {
    const asked: string[] = [];
    const rpc: RpcCall = async (method, params) => {
      asked.push(`${method} ${JSON.stringify(params)}`);
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return { asked, rpc };
  };
  const H = 1_000;
  const statuses = (found: boolean) => ({ context: { slot: 1 }, value: [found ? {} : null] });
  const valid = (yes: boolean) => ({ context: { slot: 1 }, value: yes });

  it('Solana, before signing: the height of a node that has the blockhash, and nothing from one that does not', async () => {
    const { payload } = await built();
    const knowing = nodeOf({ isBlockhashValid: valid(true), getBlockHeight: H });
    const read = chainReadOf({ solana: knowing.rpc });
    expect(await read.heightBefore({ chain: 'solana', payload })).toBe(H);
    // In this order, at `processed`: the node has the blockhash, so its height is at least the blockhash's.
    expect(knowing.asked).toEqual([
      `isBlockhashValid ${JSON.stringify([s.someone('blockhash'), { commitment: 'processed' }])}`,
      `getBlockHeight ${JSON.stringify([{ commitment: 'processed' }])}`,
    ]);
    const behind = nodeOf({ isBlockhashValid: valid(false), getBlockHeight: H });
    expect(
      await chainReadOf({ solana: behind.rpc }).heightBefore({ chain: 'solana', payload }),
    ).toBe(null);
    expect(behind.asked).toHaveLength(1);
    expect(await chainReadOf({}).heightBefore({ chain: 'solana', payload })).toBe(null);
    // An answer that is not a yes, or a height that is not one, is no height.
    for (const answers of [
      { isBlockhashValid: { value: 'yes' }, getBlockHeight: H },
      { isBlockhashValid: valid(true), getBlockHeight: '1000' },
      { isBlockhashValid: valid(true), getBlockHeight: -1 },
    ])
      await expect(
        chainReadOf({ solana: nodeOf(answers).rpc }).heightBefore({ chain: 'solana', payload }),
      ).rejects.toThrow();
    // An EVM call has no lifetime to bound, and nothing is asked.
    const evm = nodeOf({});
    expect(
      await chainReadOf({ evm: evm.rpc }).heightBefore({ chain: 'robinhood', payload: '0x' }),
    ).toBe(0);
    expect(evm.asked).toEqual([]);
  });

  it('Solana: gone only when the finalized height is past the height kept, plus 150 and the margin, and the chain has no such transaction', async () => {
    const signedTx = signedBy((await built()).payload);
    const fate = async (finalized: number, found: boolean, height: number | null = H) => {
      const node = nodeOf({ getBlockHeight: finalized, getSignatureStatuses: statuses(found) });
      const answer = await chainReadOf({ solana: node.rpc }).fateOf({
        chain: 'solana',
        owner: s.OWNER,
        proof: { signedTx },
        height,
      });
      return { answer, asked: node.asked };
    };
    const last = H + SOLANA_VALID_BLOCKS + SOLANA_MARGIN_BLOCKS;
    const gone = await fate(last + 1, false);
    expect(gone.answer).toBe('gone');
    // The finalized height first: past it, what is not there now cannot arrive. Validity is never asked.
    expect(gone.asked).toEqual([
      `getBlockHeight ${JSON.stringify([{ commitment: 'finalized' }])}`,
      `getSignatureStatuses ${JSON.stringify([[base58Encode(SIGNATURE)], { searchTransactionHistory: true }])}`,
    ]);
    expect((await fate(last, false)).answer).toBe('open');
    // The finalized block a few dozen blocks behind the tip, as it always is: not gone.
    expect((await fate(H - 32, false)).answer).toBe('open');
    expect((await fate(last + 1, true)).answer).toBe('landed');
    expect((await fate(H, true)).answer).toBe('landed');
    // Signed with no height kept: nothing says when it stops being good.
    expect((await fate(10 ** 9, false, null)).answer).toBe('unknown');
    await expect(fate(Number.NaN, false)).rejects.toThrow();
  });

  it('EVM: gone only when the finalized nonce has moved past it and the chain has no such transaction', async () => {
    const v = vectors.signed.find((x) => x.nonce === 128);
    if (!v) throw new Error('no vector');
    const fate = async (next: unknown, receipt: unknown) => {
      const node = nodeOf({ eth_getTransactionCount: next, eth_getTransactionReceipt: receipt });
      const answer = await chainReadOf({ evm: node.rpc }).fateOf({
        chain: 'robinhood',
        owner: e.OWNER,
        proof: { signedTx: v.raw },
        height: 0,
      });
      return { answer, asked: node.asked };
    };
    const gone = await fate('0x81', null);
    expect(gone.answer).toBe('gone');
    expect(gone.asked).toEqual([
      `eth_getTransactionCount ${JSON.stringify([e.OWNER, 'finalized'])}`,
      `eth_getTransactionReceipt ${JSON.stringify([v.hash])}`,
    ]);
    // Its own nonce is still the account's next: it never expires, so it can still land.
    expect((await fate('0x80', null)).answer).toBe('open');
    expect((await fate('0x5', null)).answer).toBe('open');
    expect((await fate('0x81', { status: '0x1' })).answer).toBe('landed');
    expect((await fate('0x80', { status: '0x0' })).answer).toBe('landed');
    for (const bad of ['129', '0x081', 81, null]) await expect(fate(bad, null)).rejects.toThrow();
    await expect(fate('0x81', 'no')).rejects.toThrow();
  });

  it('a transaction the wallet sent by itself is known by its id: landed, or nothing can be said', async () => {
    for (const [chain, rpcs, method] of [
      ['solana', 'solana', 'getSignatureStatuses'],
      ['robinhood', 'evm', 'eth_getTransactionReceipt'],
    ] as const) {
      const fate = (found: boolean) =>
        chainReadOf({
          [rpcs]: nodeOf({
            [method]: method === 'getSignatureStatuses' ? statuses(found) : found ? {} : null,
            getBlockHeight: 10 ** 9,
            eth_getTransactionCount: '0xffff',
          }).rpc,
        }).fateOf({ chain, owner: e.OWNER, proof: { txId: 'an id' }, height: 0 });
      expect(await fate(true), chain).toBe('landed');
      expect(await fate(false), chain).toBe('unknown');
    }
  });

  it('says nothing for a chain it was given no node of', async () => {
    const signedTx = signedBy((await built()).payload);
    expect(
      await chainReadOf({}).fateOf({
        chain: 'solana',
        owner: s.OWNER,
        proof: { signedTx },
        height: H,
      }),
    ).toBe('unknown');
    expect(
      await chainReadOf({}).fateOf({
        chain: 'base',
        owner: e.OWNER,
        proof: { txId: 'x' },
        height: 0,
      }),
    ).toBe('unknown');
  });

  it('throws on signed bytes it cannot read, which the executor takes as not knowing', async () => {
    const node = nodeOf({
      getBlockHeight: 10 ** 9,
      getSignatureStatuses: statuses(false),
      eth_getTransactionCount: '0x9',
      eth_getTransactionReceipt: null,
    });
    const read = chainReadOf({ solana: node.rpc, evm: node.rpc });
    await expect(
      read.fateOf({
        chain: 'solana',
        owner: s.OWNER,
        proof: { signedTx: 'not a transaction' },
        height: H,
      }),
    ).rejects.toThrow();
    await expect(
      read.fateOf({
        chain: 'robinhood',
        owner: e.OWNER,
        proof: { signedTx: vectors.delegating },
        height: 0,
      }),
    ).rejects.toThrow();
  });

  it('rpcAt: one URL, the result of the call, and a throw for anything else', async () => {
    const sent: { url: string; body: unknown }[] = [];
    const answering =
      (answer: (id: number) => unknown, ok = true): typeof fetch =>
      async (url, init) => {
        const body = JSON.parse(String(init?.body));
        sent.push({ url: String(url), body });
        return { ok, status: ok ? 200 : 502, json: async () => answer(body.id) } as Response;
      };
    const call = rpcAt(
      'http://node.test',
      answering((id) => ({ jsonrpc: '2.0', id, result: 7 })),
    );
    expect(await call('getBlockHeight', [{ commitment: 'finalized' }])).toBe(7);
    expect(sent[0]).toEqual({
      url: 'http://node.test',
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'getBlockHeight',
        params: [{ commitment: 'finalized' }],
      },
    });
    for (const f of [
      answering((id) => ({ jsonrpc: '2.0', id, error: { code: -1, message: 'no' } })),
      answering((id) => ({ jsonrpc: '2.0', id: id + 1, result: 7 })),
      answering((id) => ({ jsonrpc: '2.0', id })),
      answering((id) => ({ jsonrpc: '2.0', id, result: 7 }), false),
    ])
      await expect(rpcAt('http://node.test', f)('getBlockHeight', [])).rejects.toThrow();
  });
});
