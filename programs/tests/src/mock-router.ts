import {
  type Address,
  fixDecoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getBooleanDecoder,
  getBytesDecoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getU8Decoder,
  getU16Decoder,
  getU16Encoder,
  getU64Decoder,
  getU64Encoder,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  concat,
  discriminator,
  MOCK_ROUTER_PROGRAM,
  programDataAddress,
  readonly,
  SYSTEM_PROGRAM,
  signer,
  writable,
  writableSigner,
} from './env';
import { ata, type TestMint } from './tokens';

const u16 = getU16Encoder();
const u64 = getU64Encoder();
const addressEncoder = getAddressEncoder();

/** A price account in Scope's layout: a 40-byte header and 512 entries of 56 bytes. */
export const PRICES_BYTES = 28_712n;

const routerDecoder = getStructDecoder([
  ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
  ['admin', getAddressDecoder()],
  ['bump', getU8Decoder()],
  ['prices', getAddressDecoder()],
  ['priceWriter', getAddressDecoder()],
]);
/** The exchange's one account, from its bytes. */
export const decodeRouter = (data: Uint8Array) => routerDecoder.decode(data);

const pairDecoder = getStructDecoder([
  ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
  ['mintIn', getAddressDecoder()],
  ['mintOut', getAddressDecoder()],
  ['priceNum', getU64Decoder()],
  ['priceDen', getU64Decoder()],
  ['bump', getU8Decoder()],
  ['kind', getU8Decoder()],
  ['assetIsInput', getBooleanDecoder()],
  ['priceIndex', getU16Decoder()],
  ['spreadBps', getU16Decoder()],
]);
/** A pair of the exchange, from its bytes. `kind` 1 pays the price account's price. */
export const decodePair = (data: Uint8Array) => pairDecoder.decode(data);

/** The mock's own errors, in the order of its `MockRouterError` enum. */
export const MOCK_ROUTER_ERR = {
  ZeroDenominator: 6000,
  Overflow: 6001,
  BelowMinOut: 6002,
  NotUpgradeAuthority: 6003,
  NotPriceAccount: 6004,
  PricesAlreadySet: 6005,
  NotPriceWriter: 6006,
  BadPriceIndex: 6007,
  NoPrice: 6008,
  SpreadTooWide: 6009,
} as const;

/** The router account. It also owns the reserve token accounts. */
export async function routerAddress(): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: MOCK_ROUTER_PROGRAM,
    seeds: ['router'],
  });
  return pda;
}

export async function pairAddress(mintIn: Address, mintOut: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: MOCK_ROUTER_PROGRAM,
    seeds: ['pair', addressEncoder.encode(mintIn), addressEncoder.encode(mintOut)],
  });
  return pda;
}

/** Accounts: admin (signer, pays; the program's upgrade authority), router, the program, its
 * program data, system program. */
export async function initRouterInstruction(
  admin: TransactionSigner,
  overrides: { program?: Address; programData?: Address } = {},
): Promise<Instruction> {
  return {
    programAddress: MOCK_ROUTER_PROGRAM,
    accounts: [
      writableSigner(admin),
      writable(await routerAddress()),
      readonly(overrides.program ?? MOCK_ROUTER_PROGRAM),
      readonly(overrides.programData ?? (await programDataAddress(MOCK_ROUTER_PROGRAM))),
      readonly(SYSTEM_PROGRAM),
    ],
    data: discriminator('init_router'),
  };
}

/** `amountIn * priceNum / priceDen` raw units of `mintOut` come out for `amountIn` of `mintIn`. */
export async function initPairInstruction(
  admin: TransactionSigner,
  mintIn: Address,
  mintOut: Address,
  priceNum: bigint,
  priceDen: bigint,
): Promise<Instruction> {
  return {
    programAddress: MOCK_ROUTER_PROGRAM,
    accounts: [
      writableSigner(admin),
      readonly(await routerAddress()),
      readonly(mintIn),
      readonly(mintOut),
      writable(await pairAddress(mintIn, mintOut)),
      readonly(SYSTEM_PROGRAM),
    ],
    data: concat(discriminator('init_pair'), u64.encode(priceNum), u64.encode(priceDen)),
  };
}

/** One entry of the price account: `value / 10^exponent` dollars for one whole token. */
export type PriceWrite = { value: bigint; exponent?: bigint; unixTimestamp: bigint };
/** One asset's price and its one-hour average, and where each sits in the price account. */
export type PriceArgs = {
  priceIndex: number;
  twapIndex: number;
  price: PriceWrite;
  twap: PriceWrite;
};

/** Makes the account the exchange takes as its price account: the system program creates it for
 * the exchange, at the size of a Scope price account, and `init_prices` takes it. One transaction.
 * `prices` signs for its own address; `rent` is what 28,712 bytes cost on the cluster. */
export async function createPricesInstructions(
  admin: TransactionSigner,
  prices: KeyPairSigner,
  rent: bigint,
): Promise<Instruction[]> {
  return [
    getCreateAccountInstruction({
      payer: admin,
      newAccount: prices,
      lamports: rent,
      space: PRICES_BYTES,
      programAddress: MOCK_ROUTER_PROGRAM,
    }),
    await initPricesInstruction(admin, prices.address),
  ];
}

/** Accounts: admin (signer), router, the account that becomes the price account. */
export async function initPricesInstruction(
  admin: TransactionSigner,
  prices: Address,
): Promise<Instruction> {
  return {
    programAddress: MOCK_ROUTER_PROGRAM,
    accounts: [signer(admin), writable(await routerAddress()), writable(prices)],
    data: discriminator('init_prices'),
  };
}

/** Accounts: admin (signer), router. The zero address takes the role away. */
export async function setPriceWriterInstruction(
  admin: TransactionSigner,
  priceWriter: Address,
): Promise<Instruction> {
  return {
    programAddress: MOCK_ROUTER_PROGRAM,
    accounts: [signer(admin), writable(await routerAddress())],
    data: concat(discriminator('set_price_writer'), addressEncoder.encode(priceWriter)),
  };
}

const priceWrite = (entry: PriceWrite) =>
  concat(
    u64.encode(entry.value),
    u64.encode(entry.exponent ?? 8n),
    u64.encode(entry.unixTimestamp),
  );

/** Accounts: the admin or the price writer (signer), router, the price account. */
export async function writePriceInstruction(
  writer: TransactionSigner,
  prices: Address,
  args: PriceArgs,
): Promise<Instruction> {
  return {
    programAddress: MOCK_ROUTER_PROGRAM,
    accounts: [signer(writer), readonly(await routerAddress()), writable(prices)],
    data: concat(
      discriminator('write_price'),
      u16.encode(args.priceIndex),
      u16.encode(args.twapIndex),
      priceWrite(args.price),
      priceWrite(args.twap),
    ),
  };
}

/** A pair that pays the price account's price less a spread. */
export type PricedPair = { assetIsInput: boolean; priceIndex: number; spreadBps: number };
const pricedPair = (pair: PricedPair) =>
  concat([pair.assetIsInput ? 1 : 0], u16.encode(pair.priceIndex), u16.encode(pair.spreadBps));

export async function initPricedPairInstruction(
  admin: TransactionSigner,
  mintIn: Address,
  mintOut: Address,
  pair: PricedPair,
): Promise<Instruction> {
  return {
    programAddress: MOCK_ROUTER_PROGRAM,
    accounts: [
      writableSigner(admin),
      readonly(await routerAddress()),
      readonly(mintIn),
      readonly(mintOut),
      writable(await pairAddress(mintIn, mintOut)),
      readonly(SYSTEM_PROGRAM),
    ],
    data: concat(discriminator('init_priced_pair'), pricedPair(pair)),
  };
}

export async function setPricedPairInstruction(
  admin: TransactionSigner,
  mintIn: Address,
  mintOut: Address,
  pair: PricedPair,
): Promise<Instruction> {
  return {
    programAddress: MOCK_ROUTER_PROGRAM,
    accounts: [
      signer(admin),
      readonly(await routerAddress()),
      writable(await pairAddress(mintIn, mintOut)),
    ],
    data: concat(discriminator('set_priced_pair'), pricedPair(pair)),
  };
}

export async function setPriceInstruction(
  admin: TransactionSigner,
  mintIn: Address,
  mintOut: Address,
  priceNum: bigint,
  priceDen: bigint,
): Promise<Instruction> {
  return {
    programAddress: MOCK_ROUTER_PROGRAM,
    accounts: [
      signer(admin),
      readonly(await routerAddress()),
      writable(await pairAddress(mintIn, mintOut)),
    ],
    data: concat(discriminator('set_price'), u64.encode(priceNum), u64.encode(priceDen)),
  };
}

export async function routeInstruction(input: {
  trader: TransactionSigner;
  mintIn: TestMint;
  mintOut: TestMint;
  traderIn: Address;
  destination: Address;
  amountIn: bigint;
  minOut: bigint;
  /** The exchange's price account: what a pair that pays its price takes as one more account. */
  prices?: Address;
}): Promise<Instruction> {
  const router = await routerAddress();
  return {
    programAddress: MOCK_ROUTER_PROGRAM,
    accounts: [
      signer(input.trader),
      readonly(router),
      readonly(await pairAddress(input.mintIn.address, input.mintOut.address)),
      readonly(input.mintIn.address),
      readonly(input.mintOut.address),
      writable(input.traderIn),
      writable(input.destination),
      writable(await ata(router, input.mintIn)),
      writable(await ata(router, input.mintOut)),
      readonly(input.mintIn.program),
      readonly(input.mintOut.program),
      ...(input.prices ? [readonly(input.prices)] : []),
    ],
    data: concat(discriminator('route_v2'), u64.encode(input.amountIn), u64.encode(input.minOut)),
  };
}
