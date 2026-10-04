import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeUnitLimitInstruction,
  createTokenAccountInstruction,
  decodePair,
  JUPITER_PROGRAM,
  JUPITER_SLIPPAGE_MARGIN_BPS,
  jupiter,
  lookupRouterAccounts,
  MAX_TRANSACTION_BYTES,
  ownerSwapInstruction,
  pairAddress,
  type RouteRequest,
  routeFromJupiter,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  testExchange,
} from '@colosseum/chain-solana/vault';
import { ChainError, type ChainErrorCode } from '@colosseum/schemas';
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getAddressDecoder,
  getTransactionEncoder,
  type IInstruction,
  isSignerRole,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { fakeNode, REPO_ROOT } from './world';

// The two route sources, against recorded answers: Jupiter's build endpoint as `programs/tests/
// jupiter-replay.ts` froze it on Oct 3 (a route this repo has already run through the vault on a
// validator), and the test exchange's pair account. Nothing here calls the network.

type Frozen = {
  taker: Address;
  inputMint: Address;
  outputMint: Address;
  takerInput: Address;
  takerOutput: Address;
  quote: { inAmount: string; outAmount: string; otherAmountThreshold: string; slippageBps: number };
  instruction: {
    programId: string;
    accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    data: string;
  };
  lookupTables: Record<string, string[]>;
};
const frozen: Frozen = JSON.parse(
  readFileSync(join(REPO_ROOT, 'fixtures', 'solana-vault', 'jupiter-route.json'), 'utf8'),
);
/** The answer of `GET /swap/v2/build` the fixture was made from, in the fields the adapter reads. */
const answer = () => ({
  inAmount: frozen.quote.inAmount,
  outAmount: frozen.quote.outAmount,
  otherAmountThreshold: frozen.quote.otherAmountThreshold,
  slippageBps: frozen.quote.slippageBps,
  swapInstruction: structuredClone(frozen.instruction),
  addressesByLookupTableAddress: structuredClone(frozen.lookupTables),
});
const request: RouteRequest = {
  input: { mint: frozen.inputMint, tokenProgram: TOKEN_PROGRAM },
  output: { mint: frozen.outputMint, tokenProgram: TOKEN_2022_PROGRAM },
  amountIn: BigInt(frozen.quote.inAmount),
  taker: frozen.taker,
  takerInput: frozen.takerInput,
  takerOutput: frozen.takerOutput,
  slippageBps: 100,
};
const stamp = { source: 'recorded', fetchedAt: '2026-10-03T16:11:59.027Z' };

async function refused(work: () => unknown, code: ChainErrorCode) {
  const outcome = await Promise.resolve()
    .then(work)
    .then(
      () => 'answered',
      (e: unknown) => e,
    );
  expect(outcome).toBeInstanceOf(ChainError);
  expect((outcome as ChainError).code).toBe(code);
  return outcome as ChainError;
}

describe("Jupiter's build endpoint, on a recorded answer", () => {
  it('takes the route as Jupiter built it, with the signer flag taken off the vault', () => {
    const routed = routeFromJupiter(answer(), request, stamp);
    expect(routed.outRaw).toBe(1_290_137n);
    expect(routed.route.router).toBe(JUPITER_PROGRAM);
    expect(routed.route.accounts.map((a) => a.address)).toEqual(
      frozen.instruction.accounts.map((a) => a.pubkey),
    );
    expect(routed.route.accounts.some((a) => isSignerRole(a.role))).toBe(false);
    expect(routed.lookupTables).toEqual(Object.keys(frozen.lookupTables));
    expect(routed.method).toContain('route_v2');
    expect([routed.source, routed.fetchedAt]).toEqual([stamp.source, stamp.fetchedAt]);
  });

  it('refuses a route that is not one the vault forwards, or not for this trade', async () => {
    const wrongProgram = answer();
    wrongProgram.swapInstruction.programId = frozen.taker;
    await refused(() => routeFromJupiter(wrongProgram, request, stamp), 'BadTrade');

    // An exact-out route: the vault forwards none.
    const exactOut = answer();
    const data = Buffer.from(exactOut.swapInstruction.data, 'base64');
    data.set(Buffer.from('d033ef977b2bed5c', 'hex'), 0);
    exactOut.swapInstruction.data = data.toString('base64');
    await refused(() => routeFromJupiter(exactOut, request, stamp), 'BadTrade');

    await refused(
      () => routeFromJupiter(answer(), { ...request, amountIn: 1n }, stamp),
      'BadTrade',
    );
    // Built for somebody else's accounts.
    await refused(
      () =>
        routeFromJupiter(
          answer(),
          { ...request, takerOutput: getAddressDecoder().decode(new Uint8Array(32).fill(77)) },
          stamp,
        ),
      'BadTrade',
    );
    // A second signer: a key the transaction would have to carry.
    const signer = answer();
    const second = signer.swapInstruction.accounts[3];
    if (second) second.isSigner = true;
    await refused(() => routeFromJupiter(signer, request, stamp), 'BadTrade');
    const nothing = answer();
    nothing.outAmount = '0';
    await refused(() => routeFromJupiter(nothing, request, stamp), 'BadTrade');
  });

  it('asks for the route with the vault as taker, a slippage looser than its own, and the key only when given', async () => {
    const asked: { url: string; headers: Record<string, string> }[] = [];
    const fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
      asked.push({ url, headers: init?.headers ?? {} });
      return new Response(JSON.stringify(answer()), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const keyed = jupiter({ fetch, apiKey: 'k-test', now: () => new Date(stamp.fetchedAt) });
    const routed = await keyed.route(request);
    expect(routed.outRaw).toBe(1_290_137n);
    const url = new URL(asked[0]?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://api.jup.ag/swap/v2/build');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      inputMint: frozen.inputMint,
      outputMint: frozen.outputMint,
      amount: frozen.quote.inAmount,
      taker: frozen.taker,
      slippageBps: String(100 + JUPITER_SLIPPAGE_MARGIN_BPS),
      maxAccounts: '30',
    });
    expect(asked[0]?.headers).toEqual({ 'x-api-key': 'k-test' });
    await jupiter({ fetch }).route(request);
    expect(asked[1]?.headers).toEqual({});
  });

  it('says Unavailable when the endpoint fails, and never repeats its address or the key', async () => {
    const down = jupiter({
      fetch: (async () => {
        throw new Error('fetch failed: https://api.jup.ag/?key=SECRET');
      }) as unknown as typeof fetch,
    });
    const e = await refused(() => down.route(request), 'Unavailable');
    expect(e.message).not.toMatch(/SECRET|api\.jup/);
    const status = jupiter({
      fetch: (async () => new Response('', { status: 429 })) as unknown as typeof fetch,
    });
    expect((await refused(() => status.route(request), 'Unavailable')).retryable).toBe(true);
    const garbage = jupiter({
      fetch: (async () =>
        new Response('{"routePlan":[]}', { status: 200 })) as unknown as typeof fetch,
    });
    await refused(() => garbage.route(request), 'Unavailable');
  });

  it('fits the vault swap with its 29 accounts, the router accounts read through the lookup table and every named account in the message', () => {
    const routed = routeFromJupiter(answer(), request, stamp);
    const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
    const program = key(4);
    const p = { program, config: key(1), assets: key(2) };
    const owner = key(3);
    const sides = {
      input: request.input,
      output: request.output,
      vaultInput: frozen.takerInput,
      vaultOutput: frozen.takerOutput,
    };
    const swap = ownerSwapInstruction(p, {
      owner,
      vault: frozen.taker,
      sides,
      maxIn: request.amountIn,
      minOut: 1_277_236n,
      route: routed.route,
    });
    const head = createTokenAccountInstruction({
      payer: owner,
      account: frozen.takerOutput,
      holder: frozen.taker,
      token: request.output,
    });
    const named = new Set<Address>([
      owner,
      program,
      ...(head.accounts ?? []).map((a) => a.address),
      ...(swap.accounts ?? []).slice(0, 11).map((a) => a.address),
    ]);
    const tables = Object.entries(frozen.lookupTables).map(([address, addresses]) => ({
      address: address as Address,
      addresses: addresses as Address[],
    }));
    const compressed = lookupRouterAccounts(swap, 11, tables, named);
    const accounts = compressed.accounts ?? [];
    // The eleven the vault names are in the message; so is any router account the message names anyway.
    for (const [i, meta] of accounts.entries()) {
      const fromTable = 'lookupTableAddress' in meta;
      if (i < 11 || named.has(meta.address)) expect(fromTable, meta.address).toBe(false);
    }
    expect(accounts.filter((a) => 'lookupTableAddress' in a).length).toBeGreaterThan(5);
    const sizeOf = (instructions: IInstruction[]) =>
      getTransactionEncoder().encode(
        compileTransaction(
          pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayer(owner, m),
            (m) =>
              setTransactionMessageLifetimeUsingBlockhash(
                { blockhash: key(9) as never, lastValidBlockHeight: 0n },
                m,
              ),
            (m) => appendTransactionMessageInstructions(instructions, m),
          ),
        ),
      ).length;
    const bytes = sizeOf([computeUnitLimitInstruction(200_000), head, compressed]);
    expect(bytes).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    // Without the table the same transaction is larger: the route is why a swap carries one.
    expect(sizeOf([computeUnitLimitInstruction(200_000), head, swap])).toBeGreaterThan(bytes);
  });
});

describe('the test exchange, from its pair account', () => {
  const router = 'Route11111111111111111111111111111111111111' as Address;
  const mintIn = getAddressDecoder().decode(new Uint8Array(32).fill(5));
  const mintOut = getAddressDecoder().decode(new Uint8Array(32).fill(6));
  const pairBytes = (num: bigint, den: bigint, extra = 0) => {
    const data = new Uint8Array(89 + extra);
    data.set([85, 72, 49, 176, 182, 228, 141, 82], 0);
    const view = new DataView(data.buffer);
    view.setBigUint64(72, num, true);
    view.setBigUint64(80, den, true);
    return data;
  };
  const r = (amountIn: bigint): RouteRequest => ({
    input: { mint: mintIn, tokenProgram: TOKEN_PROGRAM },
    output: { mint: mintOut, tokenProgram: TOKEN_PROGRAM },
    amountIn,
    taker: getAddressDecoder().decode(new Uint8Array(32).fill(7)),
    takerInput: getAddressDecoder().decode(new Uint8Array(32).fill(8)),
    takerOutput: getAddressDecoder().decode(new Uint8Array(32).fill(9)),
    slippageBps: 100,
  });

  it('pays amount in × num / den, rounded down, and routes through route_v2 with no minimum of its own', async () => {
    const pair = await pairAddress(router, mintIn, mintOut);
    const node = fakeNode([
      { address: pair, owner: router, lamports: 1n, data: pairBytes(2n, 3n) },
    ]);
    const source = testExchange({
      rpc: node.rpc as never,
      router,
      now: () => new Date(stamp.fetchedAt),
    });
    const routed = await source.route(r(1_000n));
    expect(routed.outRaw).toBe(666n);
    expect(routed.route.accounts).toHaveLength(11);
    expect(routed.route.accounts[0]?.address).toBe(r(1n).taker);
    const view = new DataView(routed.route.data.buffer);
    expect([view.getBigUint64(8, true), view.getBigUint64(16, true)]).toEqual([1_000n, 0n]);
    expect(routed.method).toContain('2 / 3');
    expect(routed.fetchedAt).toBe(stamp.fetchedAt);
  });

  it('refuses a pair it does not list, and one in a layout it does not read', async () => {
    const pair = await pairAddress(router, mintIn, mintOut);
    const none = testExchange({ rpc: fakeNode([]).rpc as never, router });
    await refused(() => none.route(r(1n)), 'BadTrade');
    // The priced pairs of tnet/solana-devnet are longer: read as another layout until this reader knows it.
    expect(() => decodePair(pair, pairBytes(1n, 1n, 6))).toThrow(ChainError);
    const foreign = testExchange({
      rpc: fakeNode([{ address: pair, owner: mintIn, lamports: 1n, data: pairBytes(1n, 1n) }])
        .rpc as never,
      router,
    });
    await refused(() => foreign.route(r(1n)), 'BadTrade');
  });
});
