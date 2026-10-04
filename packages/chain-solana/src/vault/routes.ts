import { ChainError } from '@colosseum/schemas';
import {
  AccountRole,
  type Address,
  type Commitment,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type IAccountMeta,
} from '@solana/kit';
import { z } from 'zod';
import type { ForwardedRoute, TokenRef } from './program';
import { getAccounts, type VaultRpc } from './rpc';
import { SCOPE_ENTRY_BYTES, SCOPE_HEADER_BYTES } from './scope';
import { associatedTokenAddress, decodeMint, decodeTokenAccount } from './tokens';

// Where a trade is priced and routed, one source per router (DESIGN-VAULT 3.2, gate ROUTING). Which one
// an adapter uses follows the chain's config: Jupiter's program is routed by Jupiter's build endpoint;
// any other router is taken to be the test exchange of programs/mock-router, priced from its accounts.
// Either way the route is the router's own instruction, which the vault forwards with only its own
// signature; the vault holds the trade to what it spends and receives, whatever the route says.

export const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' as Address;
export const JUPITER_BUILD_URL = 'https://api.jup.ag/swap/v2';

/**
 * The four selectors the vault forwards (programs/basket `owner_swap`): direct and shared-accounts
 * routes, first and second versions. Anchor's sha256("global:<name>")[0..8]. An exact-out route, or
 * anything else, is refused before it reaches the vault, which would refuse it too.
 */
export const ROUTE_SELECTORS: Record<string, string> = {
  e517cb977ae3ad2a: 'route',
  c1209b3341d69c81: 'shared_accounts_route',
  bb64facc31c4af14: 'route_v2',
  d19853937cfed8e9: 'shared_accounts_route_v2',
};

export type RouteRequest = {
  input: TokenRef;
  output: TokenRef;
  amountIn: bigint;
  /** Who trades: the vault, whose program signs for it inside the swap. */
  taker: Address;
  takerInput: Address;
  takerOutput: Address;
  /** The least the trade accepts, as a share of the quote: the route is asked for no less. */
  slippageBps: number;
};

export type Routed = {
  /** What the route pays out for `amountIn`, as quoted. */
  outRaw: bigint;
  route: ForwardedRoute;
  /** Lookup tables the route's own accounts may be read through. Their contents are read from the chain. */
  lookupTables: Address[];
  venue: string;
  source: string;
  method: string;
  fetchedAt: string;
};

export interface RouteSource {
  readonly venue: string;
  route(request: RouteRequest): Promise<Routed>;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** The selector of a route's instruction, by the name the vault knows it under, or null. */
export function routeSelector(data: Uint8Array): string | null {
  return ROUTE_SELECTORS[hex(data.subarray(0, 8))] ?? null;
}

// ---- the test exchange ----

/**
 * `Pair` of programs/mock-router: discriminator, mint in, mint out, price num, price den, bump (89
 * bytes on `staging`), then, from TNET-4 on (95 bytes), kind (0 fixed, 1 priced), whether the input is
 * the asset, the asset's price entry, and the spread the exchange keeps.
 */
const PAIR_DISCRIMINATOR = new Uint8Array([85, 72, 49, 176, 182, 228, 141, 82]);
const PAIR_BYTES = 89;
const PRICED_PAIR_BYTES = 95;
/** `Router`: discriminator, admin, bump, then, from TNET-4 on, its price account and price writer. */
const ROUTER_DISCRIMINATOR = new Uint8Array([94, 226, 217, 169, 186, 4, 198, 7]);
const ROUTER_PRICES_OFFSET = 8 + 32 + 1;
const ROUTER_BYTES = ROUTER_PRICES_OFFSET + 32 + 32;
const ROUTE_V2 = new Uint8Array([187, 100, 250, 204, 49, 196, 175, 20]);
const BPS = 10_000n;
const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

export type ExchangePair =
  | { address: Address; kind: 'fixed'; priceNum: bigint; priceDen: bigint }
  | {
      address: Address;
      kind: 'priced';
      /** True when the asset goes in and the dollar token comes out. */
      assetIsInput: boolean;
      priceIndex: number;
      spreadBps: number;
    };

/** The test exchange's own account, which owns its reserves: seeds ["router"]. */
export async function exchangeAddress(router: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: router, seeds: ['router'] });
  return pda;
}

/** One direction of a pair: seeds ["pair", mint in, mint out]. */
export async function pairAddress(router: Address, mintIn: Address, mintOut: Address) {
  const [pda] = await getProgramDerivedAddress({
    programAddress: router,
    seeds: ['pair', addressEncoder.encode(mintIn), addressEncoder.encode(mintOut)],
  });
  return pda;
}

const startsWith = (data: Uint8Array, tag: Uint8Array) => tag.every((byte, i) => data[i] === byte);
const notRead = (what: string) =>
  new ChainError(
    'Unavailable',
    `the test exchange's ${what} is not in a layout this adapter reads`,
    false,
  );

/**
 * Decodes a pair as programs/mock-router writes it: the fixed pair of `staging`, and the fixed or priced
 * pair of TNET-4. Throws on any other bytes, and on a kind it does not know.
 */
export function decodePair(address: Address, data: Uint8Array): ExchangePair {
  if (
    (data.length !== PAIR_BYTES && data.length !== PRICED_PAIR_BYTES) ||
    !startsWith(data, PAIR_DISCRIMINATOR)
  )
    throw notRead(`pair ${address}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const kind = data.length === PAIR_BYTES ? 0 : data[89];
  if (kind === 0)
    return {
      address,
      kind: 'fixed',
      priceNum: view.getBigUint64(72, true),
      priceDen: view.getBigUint64(80, true),
    };
  if (kind !== 1) throw notRead(`pair ${address} (kind ${kind})`);
  return {
    address,
    kind: 'priced',
    assetIsInput: data[90] === 1,
    priceIndex: view.getUint16(91, true),
    spreadBps: view.getUint16(93, true),
  };
}

/** The price account the exchange's own account names, or null where it names none (as on `staging`). */
export function exchangePrices(data: Uint8Array): Address | null {
  if (!startsWith(data, ROUTER_DISCRIMINATOR)) throw notRead('router account');
  if (data.length < ROUTER_BYTES) return null;
  const prices = data.subarray(ROUTER_PRICES_OFFSET, ROUTER_PRICES_OFFSET + 32);
  return prices.some((byte) => byte !== 0) ? addressDecoder.decode(prices) : null;
}

/**
 * What a priced pair pays, as programs/mock-router computes it (`priced_out`): one raw unit of the asset
 * is `value / 10^(exponent + asset decimals)` dollars, a dollar is `10^cash decimals` raw units of the
 * dollar token, each division rounded down, then the spread taken off, rounded down. Null when the
 * program would overflow.
 */
export function pricedOut(a: {
  amountIn: bigint;
  value: bigint;
  exponent: bigint;
  assetDecimals: number;
  cashDecimals: number;
  assetIsInput: boolean;
  spreadBps: number;
}): bigint | null {
  const down = a.exponent + BigInt(a.assetDecimals);
  const up = BigInt(a.cashDecimals);
  const gross = a.assetIsInput
    ? up >= down
      ? a.amountIn * a.value * 10n ** (up - down)
      : (a.amountIn * a.value) / 10n ** (down - up)
    : down >= up
      ? (a.amountIn * 10n ** (down - up)) / a.value
      : a.amountIn / (a.value * 10n ** (up - down));
  const net = (gross * (BPS - BigInt(a.spreadBps))) / BPS;
  return net > 0xffff_ffff_ffff_ffffn ? null : net;
}

/**
 * The test exchange. A fixed pair pays `amount_in * price_num / price_den` raw units, rounded down,
 * with no fee. A priced pair (TNET-4) pays at the asset's entry in the exchange's price account, the
 * dollar token at one dollar, less its spread, and takes that account after its own eleven; the
 * exchange reads neither the entry's age nor a mint's multiplier. Either way the route is `route_v2`.
 */
export function testExchange(options: {
  rpc: VaultRpc;
  router: Address;
  commitment?: Commitment;
  now?: () => Date;
}): RouteSource {
  const { rpc, router } = options;
  const commitment = options.commitment ?? 'confirmed';
  const now = options.now ?? (() => new Date());
  return {
    venue: 'test-exchange',
    async route(r) {
      const exchange = await exchangeAddress(router);
      const [pairAt, reserveIn, reserveOut] = await Promise.all([
        pairAddress(router, r.input.mint, r.output.mint),
        associatedTokenAddress(exchange, r.input.mint, r.input.tokenProgram),
        associatedTokenAddress(exchange, r.output.mint, r.output.tokenProgram),
      ]);
      const [account, exchangeAccount, reserve] = await getAccounts(
        rpc,
        [pairAt, exchange, reserveOut],
        commitment,
      );
      if (!account || account.owner !== router)
        throw new ChainError(
          'BadTrade',
          `the test exchange lists no pair from ${r.input.mint} to ${r.output.mint}`,
        );
      const pair = decodePair(pairAt, account.data);

      let outRaw: bigint;
      let method: string;
      let prices: Address | null = null;
      if (pair.kind === 'fixed') {
        if (pair.priceDen === 0n)
          throw new ChainError('BadTrade', `the test exchange's pair ${pairAt} has no price`);
        outRaw = (r.amountIn * pair.priceNum) / pair.priceDen;
        method = `amount in × ${pair.priceNum} / ${pair.priceDen}, rounded down, read from the pair account; no fee`;
      } else {
        prices =
          exchangeAccount && exchangeAccount.owner === router
            ? exchangePrices(exchangeAccount.data)
            : null;
        if (!prices)
          throw new ChainError(
            'BadTrade',
            `the test exchange's pair ${pairAt} is priced, and it names no price account`,
          );
        const [priceAccount, mintIn, mintOut] = await getAccounts(
          rpc,
          [prices, r.input.mint, r.output.mint],
          commitment,
        );
        const at = SCOPE_HEADER_BYTES + SCOPE_ENTRY_BYTES * pair.priceIndex;
        if (!priceAccount || priceAccount.data.length < at + 16 || !mintIn || !mintOut)
          throw new ChainError(
            'BadTrade',
            `the test exchange cannot read the price of pair ${pairAt}`,
          );
        const view = new DataView(
          priceAccount.data.buffer,
          priceAccount.data.byteOffset,
          priceAccount.data.byteLength,
        );
        const value = view.getBigUint64(at, true);
        // The program reads the exponent's word as a u32, saturating.
        const word = view.getBigUint64(at + 8, true);
        const exponent = word > 0xffff_ffffn ? 0xffff_ffffn : word;
        if (value === 0n)
          throw new ChainError(
            'BadTrade',
            `the test exchange has no price at entry ${pair.priceIndex}`,
          );
        const decimalsIn = decodeMint(mintIn.owner, mintIn.data).decimals;
        const decimalsOut = decodeMint(mintOut.owner, mintOut.data).decimals;
        const out = pricedOut({
          amountIn: r.amountIn,
          value,
          exponent,
          assetDecimals: pair.assetIsInput ? decimalsIn : decimalsOut,
          cashDecimals: pair.assetIsInput ? decimalsOut : decimalsIn,
          assetIsInput: pair.assetIsInput,
          spreadBps: pair.spreadBps,
        });
        if (out === null)
          throw new ChainError('BadTrade', 'the trade is too large for the test exchange');
        outRaw = out;
        method = `at entry ${pair.priceIndex} of the exchange's price account ${prices} (value / 10^exponent dollars for a whole token, the dollar token at one dollar), less ${pair.spreadBps} bps of spread, rounded down as the exchange does`;
      }
      // The exchange pays from its reserve: a reserve that cannot pay is a trade it refuses.
      const held =
        reserve && reserve.owner === r.output.tokenProgram
          ? decodeTokenAccount(reserve.data).amount
          : 0n;
      if (held < outRaw)
        throw new ChainError(
          'BadTrade',
          `the test exchange's reserve of ${r.output.mint} cannot pay ${outRaw}`,
        );

      const meta = (address: Address, role: AccountRole): IAccountMeta => ({ address, role });
      const data = new Uint8Array(24);
      data.set(ROUTE_V2, 0);
      const view = new DataView(data.buffer);
      view.setBigUint64(8, r.amountIn, true);
      // The exchange's own minimum stays zero: the vault holds the trade to its minimum, and its
      // refusal names the vault's rule (`ReceivedTooLittle`) where the exchange's would not.
      view.setBigUint64(16, 0n, true);
      return {
        outRaw,
        route: {
          router,
          data,
          accounts: [
            meta(r.taker, AccountRole.READONLY_SIGNER),
            meta(exchange, AccountRole.READONLY),
            meta(pairAt, AccountRole.READONLY),
            meta(r.input.mint, AccountRole.READONLY),
            meta(r.output.mint, AccountRole.READONLY),
            meta(r.takerInput, AccountRole.WRITABLE),
            meta(r.takerOutput, AccountRole.WRITABLE),
            meta(reserveIn, AccountRole.WRITABLE),
            meta(reserveOut, AccountRole.WRITABLE),
            meta(r.input.tokenProgram, AccountRole.READONLY),
            meta(r.output.tokenProgram, AccountRole.READONLY),
            ...(prices ? [meta(prices, AccountRole.READONLY)] : []),
          ],
        },
        lookupTables: [],
        venue: 'test-exchange',
        source: `test exchange ${router}, pair ${pairAt}`,
        method,
        fetchedAt: now().toISOString(),
      };
    },
  };
}

// ---- Jupiter ----

/** How much looser than the vault's own minimum Jupiter's is asked to be, so the vault's binds first. */
export const JUPITER_SLIPPAGE_MARGIN_BPS = 50;

const Pubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Raw = z.string().regex(/^\d+$/);
/** The fields of `GET /swap/v2/build` this adapter reads. Anything else in the answer is ignored. */
export const JupiterBuild = z.object({
  inAmount: Raw,
  outAmount: Raw,
  swapInstruction: z.object({
    programId: Pubkey,
    accounts: z.array(z.object({ pubkey: Pubkey, isSigner: z.boolean(), isWritable: z.boolean() })),
    data: z.string().min(1),
  }),
  addressesByLookupTableAddress: z.record(Pubkey, z.array(Pubkey)).nullish(),
});
export type JupiterBuild = z.infer<typeof JupiterBuild>;

export type JupiterOptions = {
  /** The build endpoint's base, without `/build`. Default: Jupiter's public one. */
  baseUrl?: string;
  /** Sent as `x-api-key`. From the caller's own settings; never written anywhere by this code. */
  apiKey?: string;
  /** The most accounts a route may name: the vault's swap adds its own eleven. */
  maxAccounts?: number;
  fetch?: typeof fetch;
  now?: () => Date;
};

/**
 * Jupiter's build endpoint (`GET /swap/v2/build`, the one `programs/tests/jupiter-replay.ts` replayed
 * through the vault on Oct 3), asked for a route with the vault as the taker. Only its swap
 * instruction is used: the vault's builder opens its own token accounts and sets its own budget.
 */
export function jupiter(options: JupiterOptions = {}): RouteSource {
  const base = (options.baseUrl ?? JUPITER_BUILD_URL).replace(/\/+$/, '');
  const get = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  return {
    venue: 'jupiter',
    async route(r) {
      const query = new URLSearchParams({
        inputMint: r.input.mint,
        outputMint: r.output.mint,
        amount: r.amountIn.toString(),
        taker: r.taker,
        slippageBps: String(Math.min(10_000, r.slippageBps + JUPITER_SLIPPAGE_MARGIN_BPS)),
        maxAccounts: String(options.maxAccounts ?? 30),
      });
      const source = `${base}/build`;
      let body: unknown;
      try {
        const answer = await get(`${source}?${query}`, {
          headers: options.apiKey ? { 'x-api-key': options.apiKey } : {},
        });
        if (!answer.ok)
          throw new ChainError('Unavailable', `Jupiter's build endpoint answered ${answer.status}`);
        body = await answer.json();
      } catch (e) {
        if (e instanceof ChainError) throw e;
        const error = new ChainError('Unavailable', "Jupiter's build endpoint did not answer");
        error.cause = e;
        throw error;
      }
      const parsed = JupiterBuild.safeParse(body);
      if (!parsed.success)
        throw new ChainError('Unavailable', "Jupiter's answer is not a route this adapter reads");
      return routeFromJupiter(parsed.data, r, { source, fetchedAt: now().toISOString() });
    },
  };
}

/** Checks a Jupiter build against the request and turns it into the route the vault forwards. */
export function routeFromJupiter(
  build: JupiterBuild,
  r: RouteRequest,
  stamp: { source: string; fetchedAt: string },
): Routed {
  const ix = build.swapInstruction;
  const refuse = (why: string): never => {
    throw new ChainError('BadTrade', `Jupiter's route ${why}`);
  };
  if (ix.programId !== JUPITER_PROGRAM) refuse(`calls ${ix.programId}, not Jupiter's program`);
  const data = new Uint8Array(Buffer.from(ix.data, 'base64'));
  const selector = routeSelector(data);
  if (!selector)
    refuse('is not a direct or shared-accounts route, which is all the vault forwards');
  if (BigInt(build.inAmount) !== r.amountIn)
    refuse(`spends ${build.inAmount}, and the trade ${r.amountIn}`);
  const named = new Set(ix.accounts.map((a) => a.pubkey));
  if (!named.has(r.taker) || !named.has(r.takerInput) || !named.has(r.takerOutput))
    refuse("does not name the vault and the vault's two token accounts");
  // The vault signs for itself inside the swap. A route that wants another signer would need that key
  // on the transaction, and the owner's own key is never passed on.
  if (ix.accounts.some((a) => a.isSigner && a.pubkey !== r.taker))
    refuse("asks for a signature other than the vault's");
  const out = BigInt(build.outAmount);
  if (out === 0n) refuse('pays nothing');
  return {
    outRaw: out,
    route: {
      router: JUPITER_PROGRAM,
      data,
      accounts: ix.accounts.map((a) => ({
        address: a.pubkey as Address,
        role: a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
      })),
    },
    lookupTables: Object.keys(build.addressesByLookupTableAddress ?? {}) as Address[],
    venue: 'jupiter',
    source: stamp.source,
    method: `GET /swap/v2/build with the vault as taker; ${selector}; out amount as quoted`,
    fetchedAt: stamp.fetchedAt,
  };
}
