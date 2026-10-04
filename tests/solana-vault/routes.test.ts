import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  associatedTokenAddress,
  computeUnitLimitInstruction,
  createTokenAccountInstruction,
  decodePair,
  exchangeAddress,
  JUPITER_PROGRAM,
  JUPITER_SLIPPAGE_MARGIN_BPS,
  jupiter,
  lookupRouterAccounts,
  MAX_TRANSACTION_BYTES,
  ownerSwapInstruction,
  pairAddress,
  pricedOut,
  type RawAccount,
  type RouteRequest,
  routeFromJupiter,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  testExchange,
} from '@colosseum/chain-solana/vault';
import { ChainError, type ChainErrorCode } from '@colosseum/schemas';
import {
  AccountRole,
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
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
  const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
  const [mintIn, mintOut, prices] = [key(5), key(6), key(12)];
  const pairBytes = (num: bigint, den: bigint) => {
    const data = new Uint8Array(89);
    data.set([85, 72, 49, 176, 182, 228, 141, 82], 0);
    const view = new DataView(data.buffer);
    view.setBigUint64(72, num, true);
    view.setBigUint64(80, den, true);
    return data;
  };
  /** TNET-4's pair: the same 89 bytes, then kind, asset is input, price index, spread. */
  const pricedBytes = (kind: number, assetIsInput: boolean, index: number, spread: number) => {
    const data = new Uint8Array(95);
    data.set(pairBytes(0n, 1n));
    const view = new DataView(data.buffer);
    data[89] = kind;
    data[90] = assetIsInput ? 1 : 0;
    view.setUint16(91, index, true);
    view.setUint16(93, spread, true);
    return data;
  };
  const routerBytes = (withPrices: boolean) => {
    const data = new Uint8Array(withPrices ? 105 : 41);
    data.set([94, 226, 217, 169, 186, 4, 198, 7], 0);
    if (withPrices) data.set(getAddressEncoder().encode(prices), 41);
    return data;
  };
  const mintBytes = (decimals: number) => {
    const data = new Uint8Array(82);
    data[44] = decimals;
    data[45] = 1;
    return data;
  };
  const tokenBytes = (mint: Address, owner: Address, amount: bigint) => {
    const data = new Uint8Array(165);
    data.set(getAddressEncoder().encode(mint), 0);
    data.set(getAddressEncoder().encode(owner), 32);
    new DataView(data.buffer).setBigUint64(64, amount, true);
    data[108] = 1;
    return data;
  };
  const r = (amountIn: bigint, input = mintIn, output = mintOut): RouteRequest => ({
    input: { mint: input, tokenProgram: TOKEN_PROGRAM },
    output: { mint: output, tokenProgram: TOKEN_PROGRAM },
    amountIn,
    taker: key(7),
    takerInput: key(8),
    takerOutput: key(9),
    slippageBps: 100,
  });
  /** A node with the exchange's accounts: a pair one way, its reserve of what it pays, and what else is given. */
  async function exchangeNode(a: {
    pair: Uint8Array;
    input?: Address;
    output?: Address;
    reserve?: bigint;
    router?: Uint8Array;
    more?: RawAccount[];
  }) {
    const [input, output] = [a.input ?? mintIn, a.output ?? mintOut];
    const exchange = await exchangeAddress(router);
    return fakeNode([
      {
        address: await pairAddress(router, input, output),
        owner: router,
        lamports: 1n,
        data: a.pair,
      },
      { address: exchange, owner: router, lamports: 1n, data: a.router ?? routerBytes(false) },
      {
        address: await associatedTokenAddress(exchange, output, TOKEN_PROGRAM),
        owner: TOKEN_PROGRAM,
        lamports: 1n,
        data: tokenBytes(output, exchange, a.reserve ?? 10n ** 18n),
      },
      ...(a.more ?? []),
    ]);
  }

  it('pays amount in × num / den on a fixed pair, rounded down, and routes through route_v2 with no minimum of its own', async () => {
    const node = await exchangeNode({ pair: pairBytes(2n, 3n) });
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
    // TNET-4's longer pair, of the fixed kind, pays the same.
    const longer = pricedBytes(0, false, 0, 0);
    new DataView(longer.buffer).setBigUint64(72, 2n, true);
    new DataView(longer.buffer).setBigUint64(80, 3n, true);
    const again = testExchange({
      rpc: (await exchangeNode({ pair: longer })).rpc as never,
      router,
    });
    expect((await again.route(r(1_000n))).outRaw).toBe(666n);
  });

  it('pays a priced pair (TNET-4) at the entry less its spread, as the exchange rounds, and passes the price account last', async () => {
    // $250 a token, at exponent 8, for an asset of 8 decimals; the dollar token has 6; 30 bps spread.
    const priceData = new Uint8Array(40 + 56 * 512);
    const view = new DataView(priceData.buffer);
    view.setBigUint64(40 + 56 * 7, 25_000_000_000n, true);
    view.setBigUint64(40 + 56 * 7 + 8, 8n, true);
    const asset = mintIn;
    const cash = mintOut;
    const more: RawAccount[] = [
      { address: prices, owner: router, lamports: 1n, data: priceData },
      { address: asset, owner: TOKEN_PROGRAM, lamports: 1n, data: mintBytes(8) },
      { address: cash, owner: TOKEN_PROGRAM, lamports: 1n, data: mintBytes(6) },
    ];
    const sell = await exchangeNode({
      pair: pricedBytes(1, true, 7, 30),
      router: routerBytes(true),
      more,
    });
    const selling = await testExchange({ rpc: sell.rpc as never, router }).route(r(200_000_000n));
    // 2 tokens: $500 gross, 498.5 after the spread.
    expect(selling.outRaw).toBe(498_500_000n);
    expect(selling.route.accounts).toHaveLength(12);
    expect(selling.route.accounts[11]).toEqual({ address: prices, role: AccountRole.READONLY });
    expect(selling.method).toContain('entry 7');
    const buy = await exchangeNode({
      pair: pricedBytes(1, false, 7, 30),
      input: cash,
      output: asset,
      router: routerBytes(true),
      more,
    });
    // $500 buys 2 tokens gross, 1.994 after the spread.
    const buying = await testExchange({ rpc: buy.rpc as never, router }).route(
      r(500_000_000n, cash, asset),
    );
    expect(buying.outRaw).toBe(199_400_000n);
    expect(
      pricedOut({
        amountIn: 1n,
        value: 25_000_000_000n,
        exponent: 8n,
        assetDecimals: 8,
        cashDecimals: 6,
        assetIsInput: true,
        spreadBps: 0,
      }),
    ).toBe(2n);
  });

  it('refuses what the exchange would refuse: no pair, no price, a reserve that cannot pay, a layout it does not know', async () => {
    const none = testExchange({ rpc: fakeNode([]).rpc as never, router });
    await refused(() => none.route(r(1n)), 'BadTrade');
    const short = await exchangeNode({ pair: pairBytes(1n, 1n), reserve: 5n });
    await refused(() => testExchange({ rpc: short.rpc as never, router }).route(r(6n)), 'BadTrade');
    // A priced pair on an exchange that names no price account, or an entry with no price.
    const noAccount = await exchangeNode({ pair: pricedBytes(1, true, 7, 30) });
    await refused(
      () => testExchange({ rpc: noAccount.rpc as never, router }).route(r(1n)),
      'BadTrade',
    );
    const empty = await exchangeNode({
      pair: pricedBytes(1, true, 7, 30),
      router: routerBytes(true),
      more: [
        { address: prices, owner: router, lamports: 1n, data: new Uint8Array(40 + 56 * 512) },
        { address: mintIn, owner: TOKEN_PROGRAM, lamports: 1n, data: mintBytes(8) },
        { address: mintOut, owner: TOKEN_PROGRAM, lamports: 1n, data: mintBytes(6) },
      ],
    });
    await refused(() => testExchange({ rpc: empty.rpc as never, router }).route(r(1n)), 'BadTrade');
    const pair = await pairAddress(router, mintIn, mintOut);
    expect(() => decodePair(pair, new Uint8Array(90))).toThrow(ChainError);
    expect(() => decodePair(pair, pricedBytes(2, true, 0, 0))).toThrow(ChainError);
    const foreign = fakeNode([
      { address: pair, owner: mintIn, lamports: 1n, data: pairBytes(1n, 1n) },
    ]);
    await refused(
      () => testExchange({ rpc: foreign.rpc as never, router }).route(r(1n)),
      'BadTrade',
    );
  });
});
