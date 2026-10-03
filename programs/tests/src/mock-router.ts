import {
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
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

const u64 = getU64Encoder();
const addressEncoder = getAddressEncoder();

/** The mock's own errors, in the order of its `MockRouterError` enum. */
export const MOCK_ROUTER_ERR = {
  ZeroDenominator: 6000,
  Overflow: 6001,
  BelowMinOut: 6002,
  NotUpgradeAuthority: 6003,
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
    ],
    data: concat(discriminator('route_v2'), u64.encode(input.amountIn), u64.encode(input.minOut)),
  };
}
