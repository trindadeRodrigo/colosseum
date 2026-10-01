import { getBase58Encoder } from '@solana/kit';
import { discOf, eventDisc, parseLogs } from '../events/logs';
import { EVENT_IX_TAG } from '../events/meteora-dlmm';
import { decoders, type RpcTx, txAccountKeys } from '../events/tx';
import { Reader } from '../pools/bytes';
import {
  type IxTable,
  JL_FLASHLOAN_IX,
  JL_LENDING_IX,
  JL_LIQUIDITY_IX,
  JL_VAULTS_IX,
  KLEND_CONFIG_MODES,
  KLEND_IX,
  KLEND_MARKET_MODES,
  KVAULT_CONFIG_FIELDS,
  KVAULT_IX,
} from './ix-names';
import {
  JL_LENDING_PROGRAM,
  JL_LIQUIDITY_PROGRAM,
  JL_ORACLE_PROGRAM,
  JL_VAULTS_PROGRAM,
} from './jupiter-lend';
import { KLEND_PROGRAM, KVAULT_PROGRAM } from './kamino';

/**
 * Step 10b item 5 — lending transaction decoders (Kamino klend, Kamino curated vaults, Jupiter Lend), hand-written
 * (D11). Instruction names and account positions come from `ix-names.ts` (generated from the SDKs' IDLs); every
 * decoded instruction, argument and event is checked against the SDKs' own coders by
 * `scripts/risk/lending-decode-check.ts`.
 *
 * Method:
 *  - The transaction's instructions are flattened in execution order (outer, then inner by `stackHeight`), so a
 *    lending instruction called by another program (leverage router, curated vault, liquidator) is found too.
 *  - Amounts come from the SPL Token / Token-2022 instructions executed inside each lending instruction, never from
 *    the requested amount (requests such as "all" are `u64::MAX`). Every token move that touches a protocol account
 *    (reserve supply, collateral and fee vaults, the curated vaults' token and cToken vaults, Jupiter Lend's
 *    liquidity vaults) is a `flow`, attributed to the innermost lending instruction around it (or `external`).
 *  - The test of the method: for every protocol account in a transaction, the sum of its flows equals its post
 *    minus pre token balance, exactly (`vaultBalanceCheck`).
 *  - klend logs no events (VL-7); Jupiter Lend logs Anchor events (`Program data:`) that are read here;
 *    kvault emits `emit_cpi` events (self-invocations), read as events of the enclosing instruction.
 * Refreshes are counted, not stored.
 */
const b58 = getBase58Encoder();
export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SPL_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export type LendingProgram =
  | 'klend'
  | 'kvault'
  | 'jl_vaults'
  | 'jl_liquidity'
  | 'jl_lending'
  | 'jl_flashloan';
export const JL_FLASHLOAN_PROGRAM = 'jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS';
const PROGRAMS: Record<string, [LendingProgram, IxTable]> = {
  [KLEND_PROGRAM]: ['klend', KLEND_IX],
  [KVAULT_PROGRAM]: ['kvault', KVAULT_IX],
  [JL_VAULTS_PROGRAM]: ['jl_vaults', JL_VAULTS_IX],
  [JL_LIQUIDITY_PROGRAM]: ['jl_liquidity', JL_LIQUIDITY_IX],
  [JL_LENDING_PROGRAM]: ['jl_lending', JL_LENDING_IX],
  [JL_FLASHLOAN_PROGRAM]: ['jl_flashloan', JL_FLASHLOAN_IX],
};
export const LENDING_PROGRAMS: ReadonlySet<string> = new Set(Object.keys(PROGRAMS));

// ---------------------------------------------------------------------------------------------------------------
// Instruction tree and token moves

export type FlatIx = {
  /** `i` for outer instruction i, `i.j` for its j-th inner instruction. */
  path: string;
  depth: number;
  program: string;
  accounts: string[];
  data: Uint8Array;
  /** Index (in the flat list) of the instruction that invoked this one; -1 for an outer instruction. */
  parent: number;
};

export function flattenIxs(tx: RpcTx): FlatIx[] {
  const keys = txAccountKeys(tx);
  const inner = new Map<number, RpcTx['transaction']['message']['instructions']>();
  for (const g of tx.meta?.innerInstructions ?? []) inner.set(g.index, g.instructions);
  const out: FlatIx[] = [];
  const mk = (
    ix: { programIdIndex: number; accounts: number[]; data: string },
    path: string,
    depth: number,
    parent: number,
  ): FlatIx => ({
    path,
    depth,
    program: keys[ix.programIdIndex] as string,
    accounts: ix.accounts.map((a) => keys[a] as string),
    data: new Uint8Array(b58.encode(ix.data)),
    parent,
  });
  tx.transaction.message.instructions.forEach((ix, i) => {
    const top = out.length;
    out.push(mk(ix, String(i), 1, -1));
    // stack of flat indexes by depth: stack[d] = the latest instruction at depth d
    const stack: number[] = [];
    stack[1] = top;
    (inner.get(i) ?? []).forEach((x, j) => {
      const h = (x as { stackHeight?: number | null }).stackHeight ?? 2;
      const parent = stack[h - 1] ?? top;
      stack[h] = out.length;
      stack.length = h + 1;
      out.push(mk(x, `${i}.${j}`, h, parent));
    });
  });
  return out;
}

export type TokenMove = {
  at: number;
  op: 'transfer' | 'mint' | 'burn';
  from?: string;
  to?: string;
  mint?: string;
  amount: bigint;
};

const u64le = (d: Uint8Array, o: number) =>
  new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);

/** SPL Token and Token-2022 instructions that move balances: Transfer(3), TransferChecked(12), MintTo(7),
 *  MintToChecked(14), Burn(8), BurnChecked(15). Other token instructions move no token balance, except
 *  Token-2022 transfer-fee instructions, which are reported (`unhandled`) so the balance check can name them. */
export function tokenMove(ix: FlatIx, at: number): TokenMove | 'unhandled' | null {
  if (ix.program !== SPL_TOKEN_PROGRAM && ix.program !== SPL_TOKEN_2022_PROGRAM) return null;
  const d = ix.data;
  const a = ix.accounts;
  switch (d[0]) {
    case 3:
      return { at, op: 'transfer', from: a[0], to: a[1], amount: u64le(d, 1) };
    case 12:
      return { at, op: 'transfer', from: a[0], mint: a[1], to: a[2], amount: u64le(d, 1) };
    case 7:
    case 14:
      return { at, op: 'mint', mint: a[0], to: a[1], amount: u64le(d, 1) };
    case 8:
    case 15:
      return { at, op: 'burn', from: a[0], mint: a[1], amount: u64le(d, 1) };
    case 26: // TransferFeeExtension (TransferCheckedWithFee, WithdrawWithheld…)
      return 'unhandled';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Account roles

export type VaultRole =
  | 'liquidity_supply'
  | 'collateral_supply'
  | 'fee_vault'
  | 'withdraw_queue'
  | 'kvault_token'
  | 'kvault_ctoken'
  | 'jl_liquidity_vault';
export type MintRole = 'ctoken_mint' | 'kvault_shares_mint' | 'jl_ftoken_mint';

const leaf = (n: string) => n.slice(n.lastIndexOf('.') + 1);
const ROLE: Record<LendingProgram, Record<string, VaultRole | MintRole>> = {
  klend: {
    reserveLiquiditySupply: 'liquidity_supply',
    reserveSupplyLiquidity: 'liquidity_supply',
    reserveSourceLiquidity: 'liquidity_supply',
    reserveDestinationLiquidity: 'liquidity_supply',
    repayReserveLiquiditySupply: 'liquidity_supply',
    withdrawReserveLiquiditySupply: 'liquidity_supply',
    sourceBorrowReserveLiquidity: 'liquidity_supply',
    targetBorrowReserveLiquidity: 'liquidity_supply',
    reserveCollateralSupply: 'collateral_supply',
    reserveDestinationCollateral: 'collateral_supply',
    reserveSourceCollateral: 'collateral_supply',
    reserveDestinationDepositCollateral: 'collateral_supply',
    withdrawReserveCollateralSupply: 'collateral_supply',
    feeReceiver: 'fee_vault',
    feeVault: 'fee_vault',
    reserveLiquidityFeeReceiver: 'fee_vault',
    borrowReserveLiquidityFeeReceiver: 'fee_vault',
    withdrawReserveLiquidityFeeReceiver: 'fee_vault',
    ownerQueuedCollateralVault: 'withdraw_queue',
    reserveCollateralMint: 'ctoken_mint',
    withdrawReserveCollateralMint: 'ctoken_mint',
  },
  kvault: {
    tokenVault: 'kvault_token',
    ctokenVault: 'kvault_ctoken',
    sharesMint: 'kvault_shares_mint',
  },
  // the vaults program passes the liquidity layer's token vaults as these accounts
  jl_vaults: {
    vault_supply_token_account: 'jl_liquidity_vault',
    vault_borrow_token_account: 'jl_liquidity_vault',
  },
  jl_liquidity: { vault: 'jl_liquidity_vault' },
  jl_lending: { vault: 'jl_liquidity_vault', f_token_mint: 'jl_ftoken_mint' },
  jl_flashloan: { vault: 'jl_liquidity_vault' },
};
const MINT_ROLES = new Set<string>(['ctoken_mint', 'kvault_shares_mint', 'jl_ftoken_mint']);

/** Accounts kept on an event (others are dropped to keep history rows small). */
const KEEP = new Set([
  'lendingMarket',
  'reserve',
  'depositReserve',
  'withdrawReserve',
  'borrowReserve',
  'repayReserve',
  'sourceBorrowReserve',
  'targetBorrowReserve',
  'obligation',
  'liquidator',
  'vaultState',
  'vault_config',
  'vault_state',
  'position',
  'supply_token',
  'borrow_token',
  'token_reserve',
  'mint',
  'protocol',
  'lending',
  'signer',
]);

// ---------------------------------------------------------------------------------------------------------------
// Event kinds

export type LendingKind =
  | 'lender_deposit'
  | 'lender_redeem'
  | 'collateral_deposit'
  | 'collateral_withdraw'
  | 'borrow'
  | 'repay'
  | 'repay_and_withdraw'
  | 'deposit_and_withdraw'
  | 'liquidation'
  | 'flash_borrow'
  | 'flash_repay'
  | 'config'
  | 'market_config'
  | 'socialize_loss'
  | 'fee_withdraw'
  | 'reserve_init'
  | 'rewards_topup'
  | 'withdraw_enqueue'
  | 'withdraw_queued'
  | 'withdraw_cancel'
  | 'borrow_rollover'
  | 'vault_deposit'
  | 'vault_withdraw'
  | 'vault_invest'
  | 'vault_allocation_config'
  | 'vault_config'
  | 'operate'
  | 'liquidity_operate'
  | 'rebalance'
  | 'claim'
  | 'refresh'
  | 'admin';

const KIND: Record<LendingProgram, Record<string, LendingKind>> = {
  klend: {
    depositReserveLiquidity: 'lender_deposit',
    redeemReserveCollateral: 'lender_redeem',
    depositReserveLiquidityAndObligationCollateral: 'collateral_deposit',
    depositReserveLiquidityAndObligationCollateralV2: 'collateral_deposit',
    depositObligationCollateral: 'collateral_deposit',
    depositObligationCollateralV2: 'collateral_deposit',
    withdrawObligationCollateral: 'collateral_withdraw',
    withdrawObligationCollateralV2: 'collateral_withdraw',
    withdrawObligationCollateralAndRedeemReserveCollateral: 'collateral_withdraw',
    withdrawObligationCollateralAndRedeemReserveCollateralV2: 'collateral_withdraw',
    borrowObligationLiquidity: 'borrow',
    borrowObligationLiquidityV2: 'borrow',
    fillBorrowOrder: 'borrow',
    fillBorrowOrderV2: 'borrow',
    repayObligationLiquidity: 'repay',
    repayObligationLiquidityV2: 'repay',
    repayAndWithdrawAndRedeem: 'repay_and_withdraw',
    depositAndWithdraw: 'deposit_and_withdraw',
    liquidateObligationAndRedeemReserveCollateral: 'liquidation',
    liquidateObligationAndRedeemReserveCollateralV2: 'liquidation',
    flashBorrowReserveLiquidity: 'flash_borrow',
    flashRepayReserveLiquidity: 'flash_repay',
    updateReserveConfig: 'config',
    cloneReserveConfig: 'config',
    updateLendingMarket: 'market_config',
    socializeLoss: 'socialize_loss',
    socializeLossV2: 'socialize_loss',
    redeemFees: 'fee_withdraw',
    withdrawProtocolFee: 'fee_withdraw',
    withdrawReferrerFees: 'fee_withdraw',
    initReserve: 'reserve_init',
    seedDepositOnInitReserve: 'reserve_init',
    topupReserveRewards: 'rewards_topup',
    enqueueToWithdraw: 'withdraw_enqueue',
    withdrawQueuedLiquidity: 'withdraw_queued',
    cancelWithdrawTicket: 'withdraw_cancel',
    recoverInvalidTicketCollateral: 'withdraw_cancel',
    rolloverFixedTermBorrow: 'borrow_rollover',
    refreshReserve: 'refresh',
    refreshReservesBatch: 'refresh',
    refreshObligation: 'refresh',
    refreshObligationFarmsForReserve: 'refresh',
    calculateCtokenExchangeRate: 'refresh',
  },
  kvault: {
    deposit: 'vault_deposit',
    depositWithMinSharesOut: 'vault_deposit',
    buy: 'vault_deposit',
    buyWithMinSharesOut: 'vault_deposit',
    withdraw: 'vault_withdraw',
    sell: 'vault_withdraw',
    withdrawFromAvailable: 'vault_withdraw',
    redeemInKind: 'vault_withdraw',
    invest: 'vault_invest',
    investWithMaxAmount: 'vault_invest',
    updateReserveAllocation: 'vault_allocation_config',
    updateReserveAllocationV2: 'vault_allocation_config',
    removeAllocation: 'vault_allocation_config',
    updateVaultConfig: 'vault_config',
    withdrawPendingFees: 'fee_withdraw',
  },
  jl_vaults: {
    operate: 'operate',
    operate_dex: 'operate',
    operate_perfect_dex: 'operate',
    liquidate: 'liquidation',
    liquidate_dex: 'liquidation',
    liquidate_perfect_dex: 'liquidation',
    rebalance: 'rebalance',
    rebalance_dex: 'rebalance',
    rebalance_dex_with_amounts: 'rebalance',
    rebalance_with_amounts: 'rebalance',
    get_exchange_prices: 'refresh',
    update_exchange_prices: 'refresh',
  },
  jl_liquidity: {
    operate: 'liquidity_operate',
    pre_operate: 'refresh',
    claim: 'claim',
    collect_revenue: 'fee_withdraw',
  },
  jl_lending: {
    deposit: 'lender_deposit',
    deposit_with_min_amount_out: 'lender_deposit',
    mint: 'lender_deposit',
    mint_with_max_assets: 'lender_deposit',
    withdraw: 'lender_redeem',
    withdraw_with_max_shares_burn: 'lender_redeem',
    redeem: 'lender_redeem',
    redeem_with_min_amount_out: 'lender_redeem',
    rebalance: 'rebalance',
    rebalance_with_amounts: 'rebalance',
    update_rate: 'refresh',
  },
  jl_flashloan: { flashloan_borrow: 'flash_borrow', flashloan_payback: 'flash_repay' },
};
const kindOf = (p: LendingProgram, name: string): LendingKind =>
  KIND[p][name] ??
  (/^update_|^set_|^change_/.test(name) && p !== 'klend' && p !== 'kvault' ? 'config' : 'admin');

// ---------------------------------------------------------------------------------------------------------------
// Arguments (only those the risk layer uses; the rest stay in `argsHex`)

export type ConfigChange = {
  /** Parameter name (klend `UpdateConfigMode` variant, kvault `VaultConfigField`, or the Jupiter Lend event). */
  param: string;
  /** New value: an integer for values of 8 bytes or fewer, else hex. */
  value: string;
  /** Previous value, filled by the decode pass from the previous change of the same parameter (null if none). */
  old?: string | null;
};

const intLe = (b: Uint8Array) => {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) + BigInt(b[i] as number);
  return v.toString();
};
const configValue = (b: Uint8Array) =>
  b.length > 0 && b.length <= 8 ? intLe(b) : Buffer.from(b).toString('hex');

type Args = Record<string, string | number | boolean>;
/** Instructions whose first argument is a u64 amount (a request: the moved amount comes from the token moves). */
const KLEND_AMOUNT_IX = new Set([
  'depositReserveLiquidity',
  'redeemReserveCollateral',
  'depositObligationCollateral',
  'depositObligationCollateralV2',
  'withdrawObligationCollateral',
  'withdrawObligationCollateralV2',
  'borrowObligationLiquidity',
  'borrowObligationLiquidityV2',
  'repayObligationLiquidity',
  'repayObligationLiquidityV2',
  'depositReserveLiquidityAndObligationCollateral',
  'depositReserveLiquidityAndObligationCollateralV2',
  'withdrawObligationCollateralAndRedeemReserveCollateral',
  'withdrawObligationCollateralAndRedeemReserveCollateralV2',
  'liquidateObligationAndRedeemReserveCollateral',
  'liquidateObligationAndRedeemReserveCollateralV2',
  'flashBorrowReserveLiquidity',
  'socializeLoss',
  'socializeLossV2',
  'withdrawProtocolFee',
  'topupReserveRewards',
  'enqueueToWithdraw',
]);
const KVAULT_AMOUNT_IX = new Set([
  'deposit',
  'depositWithMinSharesOut',
  'buy',
  'buyWithMinSharesOut',
  'withdraw',
  'sell',
  'withdrawFromAvailable',
  'redeemInKind',
  'investWithMaxAmount',
  'giveUpPendingFees',
  'topupRewards',
  'withdrawRewards',
]);
const i128 = (r: Reader, o: number) => r.i128(o).toString();

function decodeArgs(
  p: LendingProgram,
  name: string,
  d: Uint8Array,
): { args?: Args; config?: ConfigChange[] } {
  const r = new Reader(d);
  const has = (n: number) => d.length >= n;
  if (p === 'klend') {
    if (name === 'updateReserveConfig' && has(14)) {
      const mode = r.u8(8);
      const len = r.u32(9);
      const value = d.subarray(13, 13 + len);
      return {
        args: { mode, skipValidation: d[13 + len] === 1 },
        config: [{ param: KLEND_CONFIG_MODES[mode] ?? `mode${mode}`, value: configValue(value) }],
      };
    }
    if (name === 'updateLendingMarket' && has(88))
      return {
        args: { mode: Number(r.u64(8)) },
        config: [
          {
            param: `market:${KLEND_MARKET_MODES[Number(r.u64(8))] ?? r.u64(8)}`,
            value: Buffer.from(d.subarray(16, 88)).toString('hex'),
          },
        ],
      };
    if (name === 'flashRepayReserveLiquidity' && has(17))
      return { args: { amount: r.u64(8).toString(), borrowInstructionIndex: r.u8(16) } };
    if ((name === 'repayAndWithdrawAndRedeem' || name === 'depositAndWithdraw') && has(24))
      return {
        args: { amount: r.u64(8).toString(), withdrawCollateralAmount: r.u64(16).toString() },
      };
    if (KLEND_AMOUNT_IX.has(name) && has(16)) return { args: { amount: r.u64(8).toString() } };
    return {};
  }
  if (p === 'kvault') {
    if ((name === 'updateReserveAllocation' || name === 'updateReserveAllocationV2') && has(24)) {
      const args: Args = { weight: r.u64(8).toString(), cap: r.u64(16).toString() };
      if (has(32)) args.ctokenAllocationCap = r.u64(24).toString();
      return { args };
    }
    if (name === 'updateVaultConfig' && has(13)) {
      const field = r.u8(8);
      const len = r.u32(9);
      return {
        args: { field },
        config: [
          {
            param: KVAULT_CONFIG_FIELDS[field] ?? `field${field}`,
            value: configValue(d.subarray(13, 13 + len)),
          },
        ],
      };
    }
    if (KVAULT_AMOUNT_IX.has(name) && has(16)) return { args: { amount: r.u64(8).toString() } };
    return {};
  }
  if (p === 'jl_vaults') {
    if (name === 'operate' && has(40))
      return { args: { newCol: i128(r, 8), newDebt: i128(r, 24) } };
    if (name.startsWith('liquidate') && has(16)) return { args: { debtAmt: r.u64(8).toString() } };
    return {};
  }
  if (p === 'jl_liquidity') {
    if (name === 'operate' && has(105))
      return {
        args: {
          supplyAmount: i128(r, 8),
          borrowAmount: i128(r, 24),
          withdrawTo: r.pubkey(40),
          borrowTo: r.pubkey(72),
          transferType: r.u8(104),
        },
      };
    return {};
  }
  if (
    p === 'jl_lending' &&
    KIND.jl_lending[name] &&
    name !== 'update_rate' &&
    !name.startsWith('rebalance') &&
    has(16)
  )
    return { args: { amount: r.u64(8).toString() } };
  return {};
}

// ---------------------------------------------------------------------------------------------------------------
// Events (Jupiter Lend `emit!` in logs; kvault `emit_cpi`)

export type DecodedEvent = { name: string; fields: Record<string, string | number> };

const ev = (n: string) => eventDisc(n);
type F = DecodedEvent['fields'];
const JL_EVENT_DECODERS: Record<
  string,
  [string, (r: Reader, n: number) => DecodedEvent['fields'] | null]
> = {
  // jl_vaults
  [ev('LogOperate')]: [
    'LogOperate',
    (r, n): F | null =>
      n === 108
        ? {
            signer: r.pubkey(8),
            nftId: r.u32(40),
            newCol: i128(r, 44),
            newDebt: i128(r, 60),
            to: r.pubkey(76),
          }
        : n === 184
          ? {
              user: r.pubkey(8),
              token: r.pubkey(40),
              supplyAmount: i128(r, 72),
              borrowAmount: i128(r, 88),
              withdrawTo: r.pubkey(104),
              borrowTo: r.pubkey(136),
              supplyExchangePrice: r.u64(168).toString(),
              borrowExchangePrice: r.u64(176).toString(),
            }
          : null,
  ],
  [ev('LogUserPosition')]: [
    'LogUserPosition',
    (r, n): F | null =>
      n === 98
        ? {
            user: r.pubkey(8),
            nftId: r.u32(40),
            vaultId: r.u16(44),
            positionMint: r.pubkey(46),
            tick: r.i32(78),
            col: r.u64(82).toString(),
            borrow: r.u64(90).toString(),
          }
        : null,
  ],
  [ev('LogLiquidate')]: [
    'LogLiquidate',
    (r, n): F | null =>
      n === 88
        ? {
            signer: r.pubkey(8),
            colAmount: r.u64(40).toString(),
            debtAmount: r.u64(48).toString(),
            to: r.pubkey(56),
          }
        : null,
  ],
  [ev('LogLiquidateInfo')]: [
    'LogLiquidateInfo',
    (r, n): F | null =>
      n === 18 ? { vaultId: r.u16(8), startTick: r.i32(10), endTick: r.i32(14) } : null,
  ],
  [ev('LogAbsorb')]: [
    'LogAbsorb',
    (r, n): F | null =>
      n === 24 ? { colAmount: r.u64(8).toString(), debtAmount: r.u64(16).toString() } : null,
  ],
  [ev('LogRebalance')]: [
    'LogRebalance',
    (r, n): F | null =>
      n === 40
        ? { supplyAmt: i128(r, 8), borrowAmt: i128(r, 24) }
        : n === 16
          ? { assets: r.u64(8).toString() }
          : null,
  ],
  [ev('LogClosePosition')]: [
    'LogClosePosition',
    (r, n): F | null => (n === 78 ? { positionId: r.u32(40), vaultId: r.u16(44) } : null),
  ],
  // jl_lending
  [ev('LogDeposit')]: [
    'LogDeposit',
    (r, n): F | null =>
      n === 88
        ? {
            sender: r.pubkey(8),
            receiver: r.pubkey(40),
            assets: r.u64(72).toString(),
            shares: r.u64(80).toString(),
          }
        : null,
  ],
  [ev('LogWithdraw')]: [
    'LogWithdraw',
    (r, n): F | null =>
      n === 120
        ? {
            sender: r.pubkey(8),
            receiver: r.pubkey(40),
            owner: r.pubkey(72),
            assets: r.u64(104).toString(),
            shares: r.u64(112).toString(),
          }
        : null,
  ],
  [ev('LogClaim')]: [
    'LogClaim',
    (r, n): F | null =>
      n === 112 ? { user: r.pubkey(8), token: r.pubkey(40), amount: r.u64(104).toString() } : null,
  ],
};

/** Jupiter Lend vault configuration events: parameter name and value. */
const JL_CONFIG_EVENTS: Record<string, [string, (r: Reader) => Array<[string, number | string]>]> =
  {
    [ev('LogUpdateCollateralFactor')]: [
      'collateral_factor',
      (r) => [['collateral_factor', r.u16(8)]],
    ],
    [ev('LogUpdateLiquidationThreshold')]: [
      'liquidation_threshold',
      (r) => [['liquidation_threshold', r.u16(8)]],
    ],
    [ev('LogUpdateLiquidationPenalty')]: [
      'liquidation_penalty',
      (r) => [['liquidation_penalty', r.u16(8)]],
    ],
    [ev('LogUpdateLiquidationMaxLimit')]: [
      'liquidation_max_limit',
      (r) => [['liquidation_max_limit', r.u16(8)]],
    ],
    [ev('LogUpdateWithdrawGap')]: ['withdraw_gap', (r) => [['withdraw_gap', r.u16(8)]]],
    [ev('LogUpdateBorrowFee')]: ['borrow_fee', (r) => [['borrow_fee', r.u8(8)]]],
    [ev('LogUpdateSupplyRateMagnifier')]: [
      'supply_rate_magnifier',
      (r) => [['supply_rate_magnifier', (r.u16(8) << 16) >> 16]],
    ],
    [ev('LogUpdateBorrowRateMagnifier')]: [
      'borrow_rate_magnifier',
      (r) => [['borrow_rate_magnifier', (r.u16(8) << 16) >> 16]],
    ],
    [ev('LogUpdateOracle')]: ['oracle', (r) => [['oracle', r.pubkey(8)]]],
    [ev('LogUpdateCoreSettings')]: [
      'core_settings',
      (r) => [
        ['supply_rate_magnifier', (r.u16(8) << 16) >> 16],
        ['borrow_rate_magnifier', (r.u16(10) << 16) >> 16],
        ['collateral_factor', r.u16(12)],
        ['liquidation_threshold', r.u16(14)],
        ['liquidation_max_limit', r.u16(16)],
        ['withdraw_gap', r.u16(18)],
        ['liquidation_penalty', r.u16(20)],
        ['borrow_fee', r.u8(22)],
      ],
    ],
  };

/** Events that change no balance or parameter we track (exchange-price updates, ticks, branches, admin). */
const JL_IGNORED_EVENTS = new Set(
  [
    'LogUpdateExchangePrices',
    'LogInitTick',
    'LogInitTickIdLiquidation',
    'LogInitBranch',
    'LogInitTickHasDebtArray',
    'LogLiquidationRoundingDiff',
    'LogUpdateRates',
    'LogUpdateRewards',
    'LogBorrowRateCap',
    'LogUpdateRateDataV1',
    'LogUpdateRateDataV2',
    'LogUpdateTokenConfigs',
    'LogUpdateUserSupplyConfigs',
    'LogUpdateUserBorrowConfigs',
    'LogUpdateUserWithdrawalLimit',
    'LogUpdateAuthority',
    'LogUpdateAuths',
    'LogUpdateRebalancer',
    'LogUpdateLookupTable',
    'LogInitVaultConfig',
    'LogInitVaultState',
    'LogCollectRevenue',
    'LogUpdateUserClass',
    'LogUpdateGuardians',
    'LogUpdateRevenueCollector',
    'LogChangeStatus',
    'LogPauseUser',
    'LogUnpauseUser',
    'LogTokenLockdown',
  ].map(ev),
);

const KVAULT_EVENTS: Record<string, [string, string[]]> = {
  [ev('DepositResultEvent')]: [
    'DepositResultEvent',
    ['sharesToMint', 'tokenToDeposit', 'crankFundsToDeposit'],
  ],
  [ev('DepositUserAtaBalanceEvent')]: ['DepositUserAtaBalanceEvent', ['userAtaBalance']],
  [ev('RedeemInKindResultEvent')]: [
    'RedeemInKindResultEvent',
    ['sharesToBurn', 'ctokensToSendToUser'],
  ],
  [ev('SharesToWithdrawEvent')]: ['SharesToWithdrawEvent', ['sharesAmount', 'userSharesBefore']],
  [ev('WithdrawResultEvent')]: [
    'WithdrawResultEvent',
    [
      'sharesToBurn',
      'availableToSendToUser',
      'investedToDisinvestCtokens',
      'investedLiquidityToSendToUser',
    ],
  ],
};

// ---------------------------------------------------------------------------------------------------------------
// The decoded transaction

export type LendingFlow = {
  account: string;
  role: VaultRole;
  /** Signed raw-unit change of the account's token balance caused by this instruction. */
  delta: string;
  mint?: string;
};

export type LendingEvent = {
  program: LendingProgram;
  ix: string;
  kind: LendingKind;
  path: string;
  /** Path of the enclosing lending instruction (a klend deposit inside a kvault invest). */
  parentPath?: string;
  /** Program that invoked this instruction, when it was called by another program. */
  caller?: string;
  accounts: Record<string, string>;
  args?: Args;
  flows: LendingFlow[];
  /** Supply changes of protocol mints (cTokens, vault shares, fTokens), raw units. */
  supply?: Array<{ mint: string; role: MintRole; delta: string }>;
  events?: DecodedEvent[];
  config?: ConfigChange[];
  liquidation?: LiquidationDetail;
  ok: boolean;
};

export type DexSwap = {
  pool: string;
  venue: string;
  mintIn: string;
  mintOut: string;
  amountIn: string;
  amountOut: string;
  /** mintOut per mintIn, in whole tokens (decimals from the transaction's token balances). */
  realisedPrice?: number;
  path: string;
};

export type LiquidationDetail = {
  venue: 'kamino' | 'jupiter_lend';
  market?: string;
  /** Kamino obligation or Jupiter Lend vault (positions are liquidated by tick range, not one by one). */
  position?: string;
  liquidator?: string;
  debtMint?: string;
  collateralMint?: string;
  /** Raw units of the debt token paid into the debt reserve (Kamino) or the liquidity layer (Jupiter Lend). */
  debtRepaid: string;
  /** Raw units of collateral that left the protocol (to the liquidator and the protocol fee). */
  collateralSeized: string;
  /** Part of the seized collateral kept by the protocol as liquidation fee. */
  protocolFee?: string;
  /** Kamino cTokens taken from the collateral vault when the liquidator received cTokens instead of liquidity. */
  collateralCTokens?: string;
  /** Liquidation bonus stated by the program (Kamino logs it), basis points. */
  statedBonusBps?: number;
  /** Prices the program used: Kamino's refresh logs in the same transaction (USD per token); Jupiter Lend's
   *  liquidation oracle return (collateral in debt tokens, `priceUnit: 'debt_token'`, debt price 1). */
  collateralPrice?: number;
  debtPrice?: number;
  priceUnit?: 'usd' | 'debt_token';
  /** seized × collateral price ÷ (repaid × debt price) − 1, when both prices are known. */
  impliedBonus?: number | null;
  /** Swaps of the seized collateral in registry DEX pools within the same transaction. */
  sales: DexSwap[];
  /** Other programs invoked in the transaction after the liquidation (aggregators, unsupported venues). */
  otherPrograms: string[];
};

export type LendingTx = {
  events: LendingEvent[];
  /** Refresh instructions, counted (not stored). */
  refreshes: number;
  /** Flows on protocol accounts outside any lending instruction (direct transfers into a vault). */
  external: LendingFlow[];
  /** Pre and post raw balances of every protocol token account the transaction touches. */
  vaults: Record<
    string,
    { role: VaultRole; mint?: string; decimals?: number; pre: string | null; post: string | null }
  >;
  /** Lending-program instructions or events no decoder recognised: `program:disc/len:base64`. */
  unknown: string[];
  /** Token-2022 fee instructions inside a lending instruction (amount effects not modelled). */
  unhandledTokenIx: number;
  truncated: boolean;
  /** Log frames could not be aligned with the instruction list (events then come from instructions only). */
  logsMisaligned: boolean;
};

export type LendingDecodeContext = {
  /** Kamino reserve → token symbol as it appears in klend's refresh logs ("Token: SPYx Price: …"). */
  reserveSymbols?: ReadonlyMap<string, string>;
  /** Registry DEX pools, to find the sale of seized collateral. */
  pools?: ReadonlyMap<string, { venue: string; mint0: string; mint1: string }>;
  /** Extra protocol token accounts (from the lending registry) to catch transfers outside lending instructions. */
  vaults?: ReadonlyMap<string, VaultRole>;
};

const named = (names: readonly string[], accounts: readonly string[]) => {
  const m: Record<string, string> = {};
  names.forEach((n, i) => {
    const a = accounts[i];
    if (a !== undefined && m[n] === undefined) m[n] = a;
  });
  return m;
};

export function decodeLendingTx(tx: RpcTx, ctx: LendingDecodeContext = {}): LendingTx {
  const flat = flattenIxs(tx);
  const { frames, truncated } = parseLogs(tx.meta?.logMessages ?? []);
  // log frames are pushed on every invoke, in execution order, as the flat list is
  const aligned =
    !truncated &&
    frames.length === flat.length &&
    frames.every((f, i) => f.program === flat[i]?.program);

  // 1. lending instructions: name, accounts, roles
  type Node = {
    i: number;
    program: LendingProgram;
    name: string;
    acc: Record<string, string>;
    ev?: LendingEvent;
  };
  const nodes = new Map<number, Node>();
  const roleOf = new Map<string, { role: VaultRole | MintRole; program: LendingProgram }>();
  for (const [a, role] of ctx.vaults ?? []) roleOf.set(a, { role, program: 'klend' });
  const unknown: string[] = [];
  flat.forEach((ix, i) => {
    const p = PROGRAMS[ix.program];
    if (!p) return;
    const [program, table] = p;
    const disc = discOf(ix.data);
    if (disc === EVENT_IX_TAG) return; // emit_cpi event, read with its parent below
    const entry = table[disc];
    if (!entry) {
      unknown.push(
        `${program}:${disc}/${ix.data.length}:${Buffer.from(ix.data).toString('base64')}`,
      );
      return;
    }
    const [name, accNames] = entry;
    const acc = named(accNames, ix.accounts);
    accNames.forEach((n, k) => {
      const role = ROLE[program][leaf(n)];
      const a = ix.accounts[k];
      if (role && a && !roleOf.has(a)) roleOf.set(a, { role, program });
    });
    nodes.set(i, { i, program, name, acc });
  });

  const lendingAncestor = (i: number): number => {
    for (let p = flat[i]?.parent ?? -1; p >= 0; p = flat[p]?.parent ?? -1)
      if (nodes.has(p)) return p;
    return -1;
  };

  // 2. events per node
  const keys = txAccountKeys(tx);
  let refreshes = 0;
  const events: LendingEvent[] = [];
  for (const n of [...nodes.values()].sort((a, b) => a.i - b.i)) {
    const ix = flat[n.i] as FlatIx;
    const kind = kindOf(n.program, n.name);
    if (kind === 'refresh') {
      refreshes++;
      continue;
    }
    const accounts: Record<string, string> = {};
    for (const [k, v] of Object.entries(n.acc)) if (KEEP.has(k)) accounts[k] = v;
    const { args, config } = decodeArgs(n.program, n.name, ix.data);
    const parent = lendingAncestor(n.i);
    const callerIx = ix.parent >= 0 ? flat[ix.parent] : undefined;
    const e: LendingEvent = {
      program: n.program,
      ix: n.name,
      kind,
      path: ix.path,
      ...(parent >= 0 ? { parentPath: flat[parent]?.path } : {}),
      ...(callerIx ? { caller: callerIx.program } : {}),
      accounts,
      ...(args ? { args } : {}),
      flows: [],
      ...(config ? { config } : {}),
      ok: aligned ? (frames[n.i]?.ok ?? true) : true,
    };
    n.ev = e;
    events.push(e);
  }

  // 3. Anchor events: Jupiter Lend logs (own frame only), kvault emit_cpi (child self-invocations)
  if (aligned)
    for (const n of nodes.values()) {
      if (
        !n.ev ||
        (n.program !== 'jl_vaults' && n.program !== 'jl_liquidity' && n.program !== 'jl_lending')
      )
        continue;
      for (const d of frames[n.i]?.data ?? []) {
        const k = discOf(d);
        const r = new Reader(d);
        const dec = JL_EVENT_DECODERS[k];
        const fields = dec?.[1](r, d.length);
        if (dec && fields) {
          n.ev.events = [...(n.ev.events ?? []), { name: dec[0], fields }];
          continue;
        }
        const cfg = JL_CONFIG_EVENTS[k];
        if (cfg) {
          n.ev.kind = 'config';
          n.ev.config = [
            ...(n.ev.config ?? []),
            ...cfg[1](r).map(([param, value]) => ({ param, value: String(value) })),
          ];
          continue;
        }
        if (JL_IGNORED_EVENTS.has(k)) continue;
        unknown.push(`${n.program}.event:${k}/${d.length}:${Buffer.from(d).toString('base64')}`);
      }
    }
  flat.forEach((ix) => {
    if (ix.program !== KVAULT_PROGRAM || discOf(ix.data) !== EVENT_IX_TAG) return;
    const owner = nodes.get(ix.parent)?.ev;
    const d = ix.data.subarray(8);
    const k = discOf(d);
    const spec = KVAULT_EVENTS[k];
    if (!spec || !owner || d.length !== 8 + 8 * spec[1].length) {
      unknown.push(`kvault.event:${k}/${d.length}:${Buffer.from(d).toString('base64')}`);
      return;
    }
    const r = new Reader(d);
    const fields: DecodedEvent['fields'] = {};
    spec[1].forEach((f, j) => {
      fields[f] = r.u64(8 + 8 * j).toString();
    });
    owner.events = [...(owner.events ?? []), { name: spec[0], fields }];
  });

  // 4. token moves → flows on protocol accounts, attributed to the innermost lending instruction
  const external: LendingFlow[] = [];
  let unhandledTokenIx = 0;
  const flowsOf = new Map<string, Map<string, bigint>>(); // event path → account → delta
  const supplyOf = new Map<string, Map<string, bigint>>();
  const add = (m: Map<string, Map<string, bigint>>, k: string, a: string, d: bigint) => {
    const x = m.get(k) ?? new Map<string, bigint>();
    x.set(a, (x.get(a) ?? 0n) + d);
    m.set(k, x);
  };
  const EXT = '-';
  flat.forEach((ix, i) => {
    const mv = tokenMove(ix, i);
    if (!mv) return;
    const owner = lendingAncestor(i);
    const ownerEv = owner >= 0 ? nodes.get(owner)?.ev : undefined;
    // refresh instructions move no tokens; a move under one would be attributed to its nearest stored ancestor
    const key = ownerEv?.path ?? EXT;
    if (mv === 'unhandled') {
      if (owner >= 0) unhandledTokenIx++;
      return;
    }
    const touch = (a: string | undefined, d: bigint) => {
      if (!a) return;
      const r = roleOf.get(a);
      if (r && !MINT_ROLES.has(r.role)) add(flowsOf, key, a, d);
    };
    if (mv.op === 'transfer') {
      touch(mv.from, -mv.amount);
      touch(mv.to, mv.amount);
    } else if (mv.op === 'mint') {
      touch(mv.to, mv.amount);
      const r = mv.mint ? roleOf.get(mv.mint) : undefined;
      if (r && MINT_ROLES.has(r.role)) add(supplyOf, key, mv.mint as string, mv.amount);
    } else {
      touch(mv.from, -mv.amount);
      const r = mv.mint ? roleOf.get(mv.mint) : undefined;
      if (r && MINT_ROLES.has(r.role)) add(supplyOf, key, mv.mint as string, -mv.amount);
    }
  });

  // token balances of protocol accounts (mints and decimals from the tx meta)
  const meta = new Map<number, { mint: string; decimals: number }>();
  for (const b of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) {
    const x = b as { accountIndex: number; mint?: string; uiTokenAmount: { decimals?: number } };
    if (x.mint) meta.set(x.accountIndex, { mint: x.mint, decimals: x.uiTokenAmount.decimals ?? 0 });
  }
  const balance = (
    rows: RpcTx['meta'] extends infer M ? M : never,
    which: 'pre' | 'post',
    a: string,
  ) => {
    const i = keys.indexOf(a);
    const list = which === 'pre' ? rows?.preTokenBalances : rows?.postTokenBalances;
    return list?.find((r) => r.accountIndex === i)?.uiTokenAmount.amount ?? null;
  };
  const mintOf = (a: string) => meta.get(keys.indexOf(a))?.mint;
  const flowList = (m: Map<string, bigint> | undefined): LendingFlow[] =>
    [...(m ?? [])]
      .filter(([, d]) => d !== 0n)
      .map(([account, d]) => {
        const mint = mintOf(account);
        return {
          account,
          role: roleOf.get(account)?.role as VaultRole,
          delta: d.toString(),
          ...(mint ? { mint } : {}),
        };
      });
  for (const e of events) {
    e.flows = flowList(flowsOf.get(e.path));
    const s = supplyOf.get(e.path);
    if (s?.size)
      e.supply = [...s].map(([mint, d]) => ({
        mint,
        role: roleOf.get(mint)?.role as MintRole,
        delta: d.toString(),
      }));
  }
  external.push(...flowList(flowsOf.get(EXT)));

  const vaults: LendingTx['vaults'] = {};
  for (const [a, r] of roleOf) {
    if (MINT_ROLES.has(r.role)) continue;
    const i = keys.indexOf(a);
    if (i < 0) continue;
    const pre = balance(tx.meta, 'pre', a);
    const post = balance(tx.meta, 'post', a);
    if (pre === null && post === null) continue;
    const m = meta.get(i);
    vaults[a] = {
      role: r.role as VaultRole,
      ...(m ? { mint: m.mint, decimals: m.decimals } : {}),
      pre,
      post,
    };
  }

  // 5. liquidation rows
  for (const e of events)
    if (e.kind === 'liquidation')
      e.liquidation =
        e.program === 'klend'
          ? kaminoLiquidation(e, tx, flat, aligned, nodes, ctx, vaults)
          : jlLiquidation(e, tx, flat, nodes, ctx, vaults, events);

  return {
    events,
    refreshes,
    external,
    vaults,
    unknown,
    unhandledTokenIx,
    truncated,
    logsMisaligned: !aligned,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Liquidations

function dexSales(
  tx: RpcTx,
  ctx: LendingDecodeContext,
  sellMint?: string,
): { sales: DexSwap[]; other: string[] } {
  const keys = txAccountKeys(tx);
  const sales: DexSwap[] = [];
  const decimals = new Map<string, number>();
  for (const b of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) {
    const x = b as { mint?: string; uiTokenAmount: { decimals?: number } };
    if (x.mint && x.uiTokenAmount.decimals !== undefined)
      decimals.set(x.mint, x.uiTokenAmount.decimals);
  }
  for (const k of new Set(keys)) {
    const p = ctx.pools?.get(k);
    const dec = p ? decoders[p.venue] : undefined;
    if (!p || !dec) continue;
    for (const s of dec(tx, k, { mint0: p.mint0 }).events) {
      if (s.kind !== 'swap') continue;
      const mintIn = s.zeroForOne ? p.mint0 : p.mint1;
      if (sellMint && mintIn !== sellMint) continue;
      const mintOut = s.zeroForOne ? p.mint1 : p.mint0;
      const amountIn = s.zeroForOne ? s.amount0 : s.amount1;
      const amountOut = s.zeroForOne ? s.amount1 : s.amount0;
      const di = decimals.get(mintIn);
      const dout = decimals.get(mintOut);
      sales.push({
        pool: k,
        venue: p.venue,
        mintIn,
        mintOut,
        amountIn,
        amountOut,
        ...(di !== undefined && dout !== undefined && amountIn !== '0'
          ? { realisedPrice: Number(amountOut) / 10 ** dout / (Number(amountIn) / 10 ** di) }
          : {}),
        path: String(s.ixIndex),
      });
    }
  }
  const known = new Set([...LENDING_PROGRAMS, SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM]);
  const other = [
    ...new Set(
      parseLogs(tx.meta?.logMessages ?? [])
        .frames.map((f) => f.program)
        .filter(
          (p) =>
            !known.has(p) &&
            !/^(11111111111111111111111111111111|ComputeBudget111111111111111111111111111111|ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL)$/.test(
              p,
            ),
        ),
    ),
  ];
  return { sales, other };
}

const sumRole = (e: LendingEvent, acc: string | undefined) =>
  acc ? e.flows.filter((f) => f.account === acc).reduce((s, f) => s + BigInt(f.delta), 0n) : 0n;

function kaminoLiquidation(
  e: LendingEvent,
  tx: RpcTx,
  flat: FlatIx[],
  aligned: boolean,
  nodes: Map<number, { i: number; acc: Record<string, string> }>,
  ctx: LendingDecodeContext,
  vaults: LendingTx['vaults'],
): LiquidationDetail {
  const i = flat.findIndex((x) => x.path === e.path);
  const acc = nodes.get(i)?.acc ?? {};
  const repaid = sumRole(e, acc.repayReserveLiquiditySupply);
  const seized = -sumRole(e, acc.withdrawReserveLiquiditySupply);
  const fee = sumRole(e, acc.withdrawReserveLiquidityFeeReceiver);
  const ctokens = -sumRole(e, acc.withdrawReserveCollateralSupply);
  const debtV = acc.repayReserveLiquiditySupply
    ? vaults[acc.repayReserveLiquiditySupply]
    : undefined;
  const collV = acc.withdrawReserveLiquiditySupply
    ? vaults[acc.withdrawReserveLiquiditySupply]
    : undefined;
  const debtMint = acc.repayReserveLiquidityMint ?? debtV?.mint;
  const collMint = acc.withdrawReserveLiquidityMint ?? collV?.mint;
  // logs: stated bonus in the liquidation frame; prices from the refresh logs of the same transaction
  const logs = aligned ? frameLogs(tx, i) : [];
  const bonus = logs.map((l) => /liquidation bonus: (\d+) ?bps/.exec(l)).find(Boolean);
  const prices = new Map<string, number>();
  for (const l of tx.meta?.logMessages ?? []) {
    const m = /^Program log: Token: (\S+) Price: ([\d.]+)/.exec(l);
    if (m) prices.set(m[1] as string, Number(m[2]));
  }
  const sym = (r?: string) => (r ? ctx.reserveSymbols?.get(r) : undefined);
  const pc = prices.get(sym(acc.withdrawReserve) ?? '');
  const pd = prices.get(sym(acc.repayReserve) ?? '');
  const dc = collV?.decimals;
  const dd = debtV?.decimals;
  const implied =
    pc !== undefined &&
    pd !== undefined &&
    dc !== undefined &&
    dd !== undefined &&
    repaid > 0n &&
    seized > 0n
      ? ((Number(seized) / 10 ** dc) * pc) / ((Number(repaid) / 10 ** dd) * pd) - 1
      : null;
  const { sales, other } = dexSales(tx, ctx, collMint);
  return {
    venue: 'kamino',
    market: acc.lendingMarket,
    position: acc.obligation,
    liquidator: acc.liquidator,
    ...(debtMint ? { debtMint } : {}),
    ...(collMint ? { collateralMint: collMint } : {}),
    debtRepaid: repaid.toString(),
    collateralSeized: seized.toString(),
    protocolFee: fee.toString(),
    collateralCTokens: ctokens.toString(),
    ...(bonus ? { statedBonusBps: Number(bonus[1]) } : {}),
    ...(pc !== undefined ? { collateralPrice: pc, priceUnit: 'usd' as const } : {}),
    ...(pd !== undefined ? { debtPrice: pd } : {}),
    impliedBonus: implied,
    sales,
    otherPrograms: other,
  };
}

function jlLiquidation(
  e: LendingEvent,
  tx: RpcTx,
  flat: FlatIx[],
  nodes: Map<number, { i: number; acc: Record<string, string> }>,
  ctx: LendingDecodeContext,
  vaults: LendingTx['vaults'],
  events: LendingEvent[],
): LiquidationDetail {
  const i = flat.findIndex((x) => x.path === e.path);
  const acc = nodes.get(i)?.acc ?? {};
  const log = e.events?.find((x) => x.name === 'LogLiquidate')?.fields;
  // amounts: flows on the liquidity layer's vaults made by this liquidation's own subtree (its jl_liquidity
  // operates); the program's LogLiquidate amounts are the fallback when no flow is seen
  const debtMint = acc.borrow_token;
  const collMint = acc.supply_token;
  const flows = subtreeFlows(events, e.path);
  const byMint = (m?: string) =>
    flows
      .filter((f) => f.role === 'jl_liquidity_vault' && f.mint === m)
      .reduce((s, f) => s + BigInt(f.delta), 0n);
  const repaid = byMint(debtMint);
  const seized = -byMint(collMint);
  // the oracle's return value for the liquidation (GetExchangeRateLiquidate): collateral price in debt tokens
  // × 1e15 (both sides in the vault's 9-decimal internal units, so the ratio is per whole token)
  const oracleIx = flat.findIndex(
    (x, k) => x.parent === i && x.program === JL_ORACLE_PROGRAM && k > i,
  );
  const ret =
    oracleIx >= 0
      ? frameLogs(tx, oracleIx).find((l) => l.startsWith('Program return: '))
      : undefined;
  const rate = ret ? leU128(Buffer.from(ret.slice(ret.lastIndexOf(' ') + 1), 'base64')) : null;
  const price = rate !== null ? Number(rate) / 1e15 : undefined;
  const dc = collMint
    ? Object.values(vaults).find((v) => v.mint === collMint)?.decimals
    : undefined;
  const dd = debtMint
    ? Object.values(vaults).find((v) => v.mint === debtMint)?.decimals
    : undefined;
  const implied =
    price !== undefined && dc !== undefined && dd !== undefined && repaid > 0n && seized > 0n
      ? ((Number(seized) / 10 ** dc) * price) / (Number(repaid) / 10 ** dd) - 1
      : null;
  const { sales, other } = dexSales(tx, ctx, collMint);
  return {
    venue: 'jupiter_lend',
    position: acc.vault_state,
    liquidator: acc.signer,
    ...(debtMint ? { debtMint } : {}),
    ...(collMint ? { collateralMint: collMint } : {}),
    debtRepaid: (repaid > 0n ? repaid : BigInt(String(log?.debtAmount ?? 0))).toString(),
    collateralSeized: (seized > 0n ? seized : BigInt(String(log?.colAmount ?? 0))).toString(),
    ...(price !== undefined
      ? { collateralPrice: price, debtPrice: 1, priceUnit: 'debt_token' as const }
      : {}),
    impliedBonus: implied,
    sales,
    otherPrograms: other,
  };
}

const leU128 = (b: Uint8Array) => {
  let v = 0n;
  for (let k = Math.min(16, b.length) - 1; k >= 0; k--) v = (v << 8n) + BigInt(b[k] as number);
  return v;
};

/** Flows of an event and of every lending event nested under it. */
export function subtreeFlows(events: readonly LendingEvent[], path: string): LendingFlow[] {
  const inside = new Set([path]);
  const out: LendingFlow[] = [];
  for (const e of events) {
    if (e.path === path || (e.parentPath && inside.has(e.parentPath))) {
      inside.add(e.path);
      out.push(...e.flows);
    }
  }
  return out;
}

/** Log lines of one invocation (its own lines, not those of programs it calls). */
function frameLogs(tx: RpcTx, index: number): string[] {
  const out: string[] = [];
  let n = -1;
  let depth = 0;
  let target = -1;
  for (const l of tx.meta?.logMessages ?? []) {
    const inv = /^Program \w+ invoke \[(\d+)\]/.exec(l);
    if (inv) {
      n++;
      depth = Number(inv[1]);
      if (n === index) target = depth;
      continue;
    }
    if (/^Program \w+ (success|failed)/.test(l)) {
      if (target >= 0 && depth === target) break;
      depth--;
      continue;
    }
    if (target >= 0 && depth === target) out.push(l);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The check

/** For every protocol token account: sum of decoded flows (events + external) vs post − pre balance. */
export function vaultBalanceCheck(d: LendingTx) {
  const sum = new Map<string, bigint>();
  for (const f of [...d.events.flatMap((e) => e.flows), ...d.external])
    sum.set(f.account, (sum.get(f.account) ?? 0n) + BigInt(f.delta));
  const rows = Object.entries(d.vaults).map(([account, v]) => {
    const change = BigInt(v.post ?? '0') - BigInt(v.pre ?? '0');
    const decoded = sum.get(account) ?? 0n;
    return {
      account,
      role: v.role,
      change: change.toString(),
      decoded: decoded.toString(),
      ok: change === decoded,
    };
  });
  return { ok: rows.every((r) => r.ok), rows };
}

/** Curated-vault reallocation in one transaction: per reserve, liquidity moved in (+) or out (−) by the vault's
 *  invest instructions (the klend deposits and redeems they make), with the largest source and destination. */
export function kvaultReallocation(d: LendingTx) {
  const invests = d.events.filter((e) => e.kind === 'vault_invest');
  if (!invests.length) return null;
  const byReserve = new Map<string, bigint>();
  let vault: string | undefined;
  for (const inv of invests) {
    vault ??= inv.accounts.vaultState;
    for (const k of d.events.filter((x) => x.parentPath === inv.path && x.program === 'klend')) {
      const reserve = k.accounts.reserve;
      if (!reserve) continue;
      const liq = k.flows
        .filter((f) => f.role === 'liquidity_supply')
        .reduce((s, f) => s + BigInt(f.delta), 0n);
      byReserve.set(reserve, (byReserve.get(reserve) ?? 0n) + liq);
    }
  }
  const legs = [...byReserve].map(([reserve, delta]) => ({ reserve, delta: delta.toString() }));
  const from = legs
    .filter((l) => BigInt(l.delta) < 0n)
    .sort((a, b) => Number(BigInt(a.delta) - BigInt(b.delta)))[0];
  const to = legs
    .filter((l) => BigInt(l.delta) > 0n)
    .sort((a, b) => Number(BigInt(b.delta) - BigInt(a.delta)))[0];
  return { vault, legs, from: from?.reserve ?? null, to: to?.reserve ?? null };
}
