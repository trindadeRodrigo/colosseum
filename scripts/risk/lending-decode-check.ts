import 'dotenv/config';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  decodeJlPosition,
  decodeJlVaultConfig,
  decodeJlVaultState,
  decodeKaminoObligation,
  decodeKaminoReserve,
  decodeKvaultState,
  decodeLendingTx,
  discOf,
  EVENT_IX_TAG,
  flattenIxs,
  JL_FLASHLOAN_IX,
  JL_LENDING_IX,
  JL_LIQUIDITY_IX,
  JL_VAULTS_IX,
  KLEND_IX,
  KVAULT_IX,
  parseLogs,
  type RpcTx,
} from '@colosseum/risk';
import { LENDING_HISTORY_DIR, measureLog } from './lib-lending';

// Step 10b item 5 — the hand-written lending decoders against the protocol SDKs' own decoding (D11).
//   tx     every lending-program instruction in the fetched history (raw bodies, no RPC): instruction name, the
//          arguments the decoders read, and the Anchor events they read, against the SDK coders of the same bytes:
//          klend and kvault with Anchor's BorshCoder over the IDLs shipped in klend-sdk 12.0.1 (the Anchor that
//          klend-sdk depends on), Jupiter Lend vaults, liquidity and lending with the programs' coders in
//          @jup-ag/lend-read 0.0.14. The flashloan program has no SDK coder here; its names come from the
//          @jup-ag/lend IDL and its amounts are covered by the vault-balance check.
//   state  every live account in the collector's latest hourly raw bytes (no RPC): Kamino reserves, obligations
//          and curated vaults against klend-sdk's `decode`; Jupiter Lend configs, states and positions against
//          lend-read's account coders.
// Usage: tsx scripts/risk/lending-decode-check.ts tx|state [maxDays]
const mode = process.argv[2] ?? 'tx';
const MAX_DAYS = Number(process.argv[3] ?? 1e9);
const command = `pnpm risk:lending-decode-check ${process.argv.slice(2).join(' ')}`.trim();

const kRequire = createRequire(
  join(realpathSync('node_modules/@kamino-finance/klend-sdk'), 'package.json'),
);
type Coder = {
  instruction: { decode(b: Buffer): { name: string; data: Record<string, unknown> } | null };
  events: { decode(b64: string): { name: string; data: Record<string, unknown> } | null };
  accounts: { decode(name: string, b: Buffer): Record<string, unknown> };
};
const anchor = kRequire('@coral-xyz/anchor') as { BorshCoder: new (idl: unknown) => Coder };
const idlDir = join(realpathSync('node_modules/@kamino-finance/klend-sdk'), 'dist', 'idl');
const klendCoder = new anchor.BorshCoder(
  JSON.parse(readFileSync(join(idlDir, 'klend.json'), 'utf8')),
);
const kvaultCoder = new anchor.BorshCoder(
  JSON.parse(readFileSync(join(idlDir, 'kvault.json'), 'utf8')),
);
const { Client } = await import('@jup-ag/lend-read');
const client = new Client(process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899') as unknown as {
  vault: { program: { coder: Coder } };
  liquidity: { program: { coder: Coder } };
  lending: { program: { coder: Coder } };
};
const coders: Record<
  string,
  [string, Coder | null, Record<string, readonly [string, readonly string[]]>]
> = {
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD: ['klend', klendCoder, KLEND_IX],
  KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd: ['kvault', kvaultCoder, KVAULT_IX],
  jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi: [
    'jl_vaults',
    client.vault.program.coder,
    JL_VAULTS_IX,
  ],
  jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC: [
    'jl_liquidity',
    client.liquidity.program.coder,
    JL_LIQUIDITY_IX,
  ],
  jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9: [
    'jl_lending',
    client.lending.program.coder,
    JL_LENDING_IX,
  ],
  jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS: ['jl_flashloan', null, JL_FLASHLOAN_IX],
};

/** SDK values to plain strings: BN, PublicKey, byte arrays, Anchor enums ({ variantName: {} }). */
function plain(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  const o = v as Record<string, unknown> & {
    toBase58?: () => string;
    constructor?: { name?: string };
  };
  if (typeof o.toBase58 === 'function') return o.toBase58();
  if (o.constructor?.name === 'BN') return (o as { toString(): string }).toString();
  if (Array.isArray(v)) return v.map(plain);
  const keys = Object.keys(o);
  if (
    keys.length === 1 &&
    o[keys[0] as string] &&
    typeof o[keys[0] as string] === 'object' &&
    !Object.keys(o[keys[0] as string] as object).length
  )
    return keys[0];
  return Object.fromEntries(keys.map((k) => [k, plain(o[k])]));
}
const norm = (s: string) => s.replace(/_/g, '').toLowerCase();
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

type Tally = { checked: number; mismatches: number; examples: unknown[] };
const tally = (): Tally => ({ checked: 0, mismatches: 0, examples: [] });
const cmp = (t: Tally, ok: boolean, ex: () => unknown) => {
  t.checked++;
  if (!ok) {
    t.mismatches++;
    if (t.examples.length < 10) t.examples.push(ex());
  }
};

async function txCheck() {
  const raw = join(LENDING_HISTORY_DIR, 'raw');
  const days = readdirSync(raw)
    .filter((f) => f.endsWith('.done'))
    .map((f) => f.slice(0, 10))
    .sort()
    .reverse()
    .slice(0, MAX_DAYS);
  const names = tally();
  const args = tally();
  const events = tally();
  const sdkUndecoded: Record<string, number> = {};
  let txs = 0;
  for (const day of days) {
    for (const line of gunzipSync(readFileSync(join(raw, `${day}.jsonl.gz`)))
      .toString('utf8')
      .split('\n')) {
      if (!line) continue;
      const { s, tx } = JSON.parse(line) as { s: string; tx: RpcTx };
      txs++;
      const flat = flattenIxs(tx);
      const d = decodeLendingTx(tx);
      const byPath = new Map(d.events.map((e) => [e.path, e]));
      const { frames } = parseLogs(tx.meta?.logMessages ?? []);
      flat.forEach((ix, i) => {
        const c = coders[ix.program];
        if (!c) return;
        const [program, coder, table] = c;
        const disc = discOf(ix.data);
        if (disc === EVENT_IX_TAG) {
          // kvault emit_cpi event: SDK event coder vs the fields read onto the parent's event
          if (program !== 'kvault' || !coder) return;
          const sdk = coder.events.decode(Buffer.from(ix.data.subarray(8)).toString('base64'));
          const parentPath = flat[ix.parent]?.path;
          const mine = parentPath ? byPath.get(parentPath)?.events : undefined;
          if (!sdk) return;
          const m = mine?.find((x) => x.name === sdk.name);
          const sp = plain(sdk.data) as Record<string, string>;
          cmp(
            events,
            !!m && Object.entries(m.fields).every(([k, v]) => sp[k] === String(v)),
            () => ({ s, program, event: sdk.name, sdk: sp, mine: m?.fields }),
          );
          return;
        }
        const mineName = table[disc]?.[0];
        if (!coder) return;
        let sdk: ReturnType<Coder['instruction']['decode']> = null;
        try {
          sdk = coder.instruction.decode(Buffer.from(ix.data));
        } catch {
          sdk = null;
        }
        if (!sdk) {
          sdkUndecoded[`${program}:${mineName ?? disc}`] =
            (sdkUndecoded[`${program}:${mineName ?? disc}`] ?? 0) + 1;
          return;
        }
        cmp(names, !!mineName && norm(mineName) === norm(sdk.name), () => ({
          s,
          program,
          sdk: sdk?.name,
          mine: mineName,
        }));
        const e = byPath.get(ix.path);
        if (!e) return;
        const sp = plain(sdk.data) as Record<string, unknown>;
        // the arguments the decoders read, by their SDK names
        const pairs: Array<[unknown, unknown]> = [];
        const a = e.args ?? {};
        if (program === 'klend') {
          if (a.amount !== undefined)
            pairs.push([
              a.amount,
              sp.liquidityAmount ?? sp.collateralAmount ?? sp.repayAmount ?? sp.amount,
            ]);
          if (a.withdrawCollateralAmount !== undefined)
            pairs.push([a.withdrawCollateralAmount, sp.withdrawCollateralAmount]);
          if (e.ix === 'updateReserveConfig') {
            pairs.push([norm(e.config?.[0]?.param ?? ''), norm(String(sp.mode))]);
            const hex = String(sp.value);
            const want =
              hex.length > 0 && hex.length <= 16
                ? BigInt(`0x${Buffer.from(hex, 'hex').reverse().toString('hex') || '0'}`).toString()
                : hex;
            pairs.push([e.config?.[0]?.value, want]);
          }
          if (a.borrowInstructionIndex !== undefined)
            pairs.push([a.borrowInstructionIndex, sp.borrowInstructionIndex]);
        } else if (program === 'kvault') {
          if (a.weight !== undefined) pairs.push([a.weight, sp.weight], [a.cap, sp.cap]);
          if (a.ctokenAllocationCap !== undefined)
            pairs.push([a.ctokenAllocationCap, sp.ctokenAllocationCap]);
          if (a.field !== undefined)
            pairs.push([norm(e.config?.[0]?.param ?? ''), norm(String(sp.entry))]);
          if (a.amount !== undefined && a.weight === undefined)
            pairs.push([a.amount, sp.maxAmount ?? sp.sharesAmount ?? sp.amount]);
        } else if (program === 'jl_vaults') {
          if (a.newCol !== undefined)
            pairs.push([a.newCol, sp.newCol ?? sp.new_col], [a.newDebt, sp.newDebt ?? sp.new_debt]);
          if (a.debtAmt !== undefined) pairs.push([a.debtAmt, sp.debtAmt ?? sp.debt_amt]);
        } else if (program === 'jl_liquidity') {
          if (a.supplyAmount !== undefined)
            pairs.push(
              [a.supplyAmount, sp.supplyAmount ?? sp.supply_amount],
              [a.borrowAmount, sp.borrowAmount ?? sp.borrow_amount],
              [a.withdrawTo, sp.withdrawTo ?? sp.withdraw_to],
              [a.borrowTo, sp.borrowTo ?? sp.borrow_to],
            );
        } else if (program === 'jl_lending') {
          if (a.amount !== undefined) pairs.push([a.amount, sp.assets ?? sp.shares ?? sp.amount]);
        }
        for (const [x, y] of pairs)
          cmp(args, String(x) === String(y), () => ({ s, program, ix: e.ix, mine: x, sdk: y }));
        // Jupiter Lend events logged by this instruction
        if (program.startsWith('jl_') && frames[i]?.program === ix.program)
          for (const payload of frames[i]?.data ?? []) {
            let se: ReturnType<Coder['events']['decode']> = null;
            try {
              se = coder.events.decode(Buffer.from(payload).toString('base64'));
            } catch {
              se = null;
            }
            if (!se) continue;
            const m = e.events?.find((x) => x.name === se?.name);
            if (!m) continue; // events the decoder ignores on purpose (exchange prices, ticks, admin)
            const ss = plain(se.data) as Record<string, string>;
            cmp(
              events,
              Object.entries(m.fields).every(([k, v]) => {
                const sv =
                  ss[k] ?? ss[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] ?? ss[camel(k)];
                return String(sv) === String(v);
              }),
              () => ({ s, event: se?.name, sdk: ss, mine: m.fields }),
            );
          }
      });
    }
  }
  const value = {
    days: days.length,
    from: days.at(-1),
    to: days[0],
    txs,
    instructionNames: names,
    arguments: args,
    events,
    sdkCouldNotDecode: sdkUndecoded,
  };
  measureLog({ check: 'R10b.5 decoders vs SDK (transactions)', command, value });
}

async function stateCheck() {
  const { Obligation, Reserve, VaultState } = await import('@kamino-finance/klend-sdk');
  const home = join(homedir(), '.colosseum', 'risk');
  const posDay = readdirSync(join(home, 'lending-positions')).sort().at(-1) as string;
  const posHour = readdirSync(join(home, 'lending-positions', posDay))
    .filter((h) => existsSync(join(home, 'lending-positions', posDay, h, '.done')))
    .sort()
    .at(-1) as string;
  const posDir = join(home, 'lending-positions', posDay, posHour);
  const rawDay = readdirSync(join(home, 'raw-lending')).sort().at(-1) as string;
  const rawFile = readdirSync(join(home, 'raw-lending', rawDay))
    .sort()
    .at(-1) as string;
  const state = JSON.parse(
    gunzipSync(readFileSync(join(home, 'raw-lending', rawDay, rawFile))).toString('utf8'),
  ) as {
    fetchedAt: string;
    accounts: Record<string, { owner: string; b64: string }>;
  };
  const t = {
    reserves: tally(),
    obligations: tally(),
    kvaults: tally(),
    jlConfigs: tally(),
    jlStates: tally(),
    jlPositions: tally(),
  };
  const eq = (tl: Tally, account: string, pairs: Array<[string, unknown, unknown]>) => {
    const bad = pairs.filter(([, x, y]) => String(x) !== String(y));
    cmp(tl, bad.length === 0, () => ({ account, bad: bad.slice(0, 5) }));
  };
  const s = (x: unknown) => String(plain(x));
  for (const [addr, a] of Object.entries(state.accounts)) {
    const b = Buffer.from(a.b64, 'base64');
    if (a.owner === 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD' && b.length === 8624) {
      const m = decodeKaminoReserve(b);
      const r = Reserve.decode(b);
      eq(t.reserves, addr, [
        ['lendingMarket', m.lendingMarket, s(r.lendingMarket)],
        ['availableAmount', m.availableAmount, s(r.liquidity.totalAvailableAmount)],
        ['borrowedAmountSf', m.borrowedAmountSf, s(r.liquidity.borrowedAmountSf)],
        ['marketPriceSf', m.marketPriceSf, s(r.liquidity.marketPriceSf)],
        ['collateralMintTotalSupply', m.collateralMintTotalSupply, s(r.collateral.mintTotalSupply)],
        [
          'accumulatedProtocolFeesSf',
          m.accumulatedProtocolFeesSf,
          s(r.liquidity.accumulatedProtocolFeesSf),
        ],
        ['loanToValuePct', m.config.loanToValuePct, s(r.config.loanToValuePct)],
        [
          'liquidationThresholdPct',
          m.config.liquidationThresholdPct,
          s(r.config.liquidationThresholdPct),
        ],
        ['depositLimit', m.config.depositLimit, s(r.config.depositLimit)],
        ['borrowLimit', m.config.borrowLimit, s(r.config.borrowLimit)],
        // fields the item-7 reconstruction accrues with
        ['lastUpdateSlot', m.lastUpdateSlot, s(r.lastUpdate.slot)],
        ['lastUpdateTimestamp', m.lastUpdateTimestamp, s(r.lastUpdate.timestamp)],
        [
          'cumulativeBorrowRateBsf',
          m.cumulativeBorrowRateBsf,
          (r.liquidity.cumulativeBorrowRateBsf.value as unknown[])
            .map((x) => BigInt(s(x)))
            .reduce((acc, x, i) => acc + (x << BigInt(64 * i)), 0n),
        ],
        ['interestRateBasis', m.config.interestRateBasis, s(r.config.interestRateBasis)],
        ['protocolTakeRatePct', m.config.protocolTakeRatePct, s(r.config.protocolTakeRatePct)],
        [
          'hostFixedInterestRateBps',
          m.config.hostFixedInterestRateBps,
          s(r.config.hostFixedInterestRateBps),
        ],
        [
          'borrowRateCurve',
          JSON.stringify(m.config.borrowRateCurve.map((p) => [p.utilizationBps, p.borrowRateBps])),
          JSON.stringify(
            r.config.borrowRateCurve.points.map((p) => [
              Number(s(p.utilizationRateBps)),
              Number(s(p.borrowRateBps)),
            ]),
          ),
        ],
        [
          'withdrawQueueCollateral',
          m.withdrawQueueCollateral,
          s(
            (r as unknown as { withdrawQueue: { queuedCollateralAmount: unknown } }).withdrawQueue
              .queuedCollateralAmount,
          ),
        ],
      ]);
    } else if (a.owner === 'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd' && b.length === 62552) {
      const m = decodeKvaultState(b);
      const v = VaultState.decode(b);
      const allocs = v.vaultAllocationStrategy.filter(
        (x: { reserve: unknown }) => s(x.reserve) !== '11111111111111111111111111111111',
      );
      eq(t.kvaults, addr, [
        ['tokenMint', m.tokenMint, s(v.tokenMint)],
        ['tokenVault', m.tokenVault, s(v.tokenVault)],
        ['tokenAvailable', m.tokenAvailable, s(v.tokenAvailable)],
        ['sharesIssued', m.sharesIssued, s(v.sharesIssued)],
        ['prevAumSf', m.prevAumSf, s(v.prevAumSf)],
        ['allocations', m.allocations.length, allocs.length],
        ...m.allocations.flatMap(
          (x, k): Array<[string, unknown, unknown]> => [
            [`alloc${k}.reserve`, x.reserve, s(allocs[k]?.reserve)],
            [`alloc${k}.ctokenAllocation`, x.ctokenAllocation, s(allocs[k]?.ctokenAllocation)],
            [`alloc${k}.weight`, x.targetAllocationWeight, s(allocs[k]?.targetAllocationWeight)],
          ],
        ),
      ]);
    } else if (a.owner === 'jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi') {
      const c = client.vault.program.coder;
      if (b.length === 219) {
        const m = decodeJlVaultConfig(b);
        const v = plain(c.accounts.decode('vaultConfig', b)) as Record<string, string>;
        eq(t.jlConfigs, addr, [
          ['vaultId', m.vaultId, v.vaultId ?? v.vault_id],
          ['collateralFactor', m.collateralFactor, v.collateralFactor ?? v.collateral_factor],
          [
            'liquidationThreshold',
            m.liquidationThreshold,
            v.liquidationThreshold ?? v.liquidation_threshold,
          ],
          [
            'liquidationPenalty',
            m.liquidationPenalty,
            v.liquidationPenalty ?? v.liquidation_penalty,
          ],
          ['oracle', m.oracle, v.oracle],
          ['supplyToken', m.supplyToken, v.supplyToken ?? v.supply_token],
          ['borrowToken', m.borrowToken, v.borrowToken ?? v.borrow_token],
        ]);
      } else {
        let v: Record<string, string> | null = null;
        try {
          v = plain(c.accounts.decode('vaultState', b)) as Record<string, string>;
        } catch {
          v = null;
        }
        if (!v) continue;
        const m = decodeJlVaultState(b);
        eq(t.jlStates, addr, [
          ['vaultId', m.vaultId, v.vaultId ?? v.vault_id],
          ['totalSupply', m.totalSupply, v.totalSupply ?? v.total_supply],
          ['totalBorrow', m.totalBorrow, v.totalBorrow ?? v.total_borrow],
          ['topmostTick', m.topmostTick, v.topmostTick ?? v.topmost_tick],
          ['totalPositions', m.totalPositions, v.totalPositions ?? v.total_positions],
          [
            'vaultSupplyExchangePrice',
            m.vaultSupplyExchangePrice,
            v.vaultSupplyExchangePrice ?? v.vault_supply_exchange_price,
          ],
        ]);
      }
    }
  }
  for (const f of readdirSync(posDir).filter((x) => x.endsWith('.raw.json.gz'))) {
    const pos = JSON.parse(gunzipSync(readFileSync(join(posDir, f))).toString('utf8')) as {
      accounts: Record<string, string>;
    };
    for (const [addr, b64] of Object.entries(pos.accounts)) {
      const b = Buffer.from(b64, 'base64');
      if (f.startsWith('kamino-')) {
        const m = decodeKaminoObligation(b);
        const o = Obligation.decode(b);
        const deps = o.deposits.filter(
          (d: { depositReserve: unknown }) =>
            s(d.depositReserve) !== '11111111111111111111111111111111',
        );
        const bors = o.borrows.filter(
          (x: { borrowReserve: unknown }) =>
            s(x.borrowReserve) !== '11111111111111111111111111111111',
        );
        eq(t.obligations, addr, [
          ['lendingMarket', m.lendingMarket, s(o.lendingMarket)],
          ['owner', m.owner, s(o.owner)],
          ['deposits', m.deposits.length, deps.length],
          ['borrows', m.borrows.length, bors.length],
          ...m.deposits.flatMap(
            (x, k): Array<[string, unknown, unknown]> => [
              [`dep${k}.reserve`, x.reserve, s(deps[k]?.depositReserve)],
              [`dep${k}.amount`, x.depositedAmount, s(deps[k]?.depositedAmount)],
              [`dep${k}.value`, x.marketValueSf, s(deps[k]?.marketValueSf)],
            ],
          ),
          ...m.borrows.flatMap(
            (x, k): Array<[string, unknown, unknown]> => [
              [`bor${k}.reserve`, x.reserve, s(bors[k]?.borrowReserve)],
              [`bor${k}.amountSf`, x.borrowedAmountSf, s(bors[k]?.borrowedAmountSf)],
              [`bor${k}.value`, x.marketValueSf, s(bors[k]?.marketValueSf)],
              [
                `bor${k}.cumRate`,
                x.cumulativeBorrowRateBsf,
                (bors[k]?.cumulativeBorrowRateBsf.value as unknown[] | undefined)
                  ?.map((w) => BigInt(s(w)))
                  .reduce((acc, w, j) => acc + (w << BigInt(64 * j)), 0n),
              ],
            ],
          ),
          ['depositedValueSf', m.depositedValueSf, s(o.depositedValueSf)],
          [
            'borrowFactorAdjustedDebtValueSf',
            m.borrowFactorAdjustedDebtValueSf,
            s(o.borrowFactorAdjustedDebtValueSf),
          ],
          ['allowedBorrowValueSf', m.allowedBorrowValueSf, s(o.allowedBorrowValueSf)],
          ['unhealthyBorrowValueSf', m.unhealthyBorrowValueSf, s(o.unhealthyBorrowValueSf)],
          ['elevationGroup', m.elevationGroup, s(o.elevationGroup)],
        ]);
      } else if (f.startsWith('jupiter_lend-')) {
        const m = decodeJlPosition(b);
        const v = plain(client.vault.program.coder.accounts.decode('position', b)) as Record<
          string,
          string
        >;
        eq(t.jlPositions, addr, [
          ['vaultId', m.vaultId, v.vaultId ?? v.vault_id],
          ['nftId', m.nftId, v.nftId ?? v.nft_id],
          ['tick', m.tick, v.tick],
          ['tickId', m.tickId, v.tickId ?? v.tick_id],
          ['supplyAmount', m.supplyAmount, v.supplyAmount ?? v.supply_amount],
          ['dustDebtAmount', m.dustDebtAmount, v.dustDebtAmount ?? v.dust_debt_amount],
        ]);
      }
    }
  }
  const value = { stateAt: state.fetchedAt, positionsAt: `${posDay} ${posHour}h`, ...t };
  measureLog({ check: 'R10b.5 state readers vs SDK (every live account)', command, value });
}

if (mode === 'tx') await txCheck();
else if (mode === 'state') await stateCheck();
else throw new Error(`unknown mode ${mode}`);
