import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, address, getAddressEncoder, type KeyPairSigner } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token-2022';
import type { LiteSVM } from 'litesvm';
import { beforeAll, describe, expect, it } from 'vitest';
import { ERR, forwarded, keeperLegInstruction } from './src/basket';
import {
  createWorld,
  expectError,
  expectOk,
  fundedSigner,
  programSigner,
  REPO_ROOT,
  send,
  setClock,
} from './src/env';
import { SESSION } from './src/keeper';
import { routeInstruction } from './src/mock-router';
import { liteChain } from './src/testnet/chain';
import { planOf } from './src/testnet/config';
import { lifecycle } from './src/testnet/lifecycle';
import {
  type CopyOptions,
  copyRound,
  type Entry,
  HINT,
  loadSources,
  type Reading,
  readPrices,
  type Source,
} from './src/testnet/prices';
import { type DeployedAsset, type Deployment, setUp } from './src/testnet/setup';
import { ata, type TestMint, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './src/tokens';

const CONFIG_FILE = join(REPO_ROOT, 'scripts', 'testnet', 'solana', 'devnet.config.json');
const sources = loadSources();
const SCOPE = address(sources.scope.account);
const LENDING = address('2vVYHYM8VYnvZqQWpTJSj8o8DBf1wM8pVs3bsTgYZiqJ');

/** Mainnet as the copier sees it: Scope's account and Jupiter Lend's lending account, made by hand. */
function fakeMainnet(
  entries: Record<number, Entry>,
  jl: { rate: bigint; time: bigint; fToken?: string },
): Source {
  const scope = new Uint8Array(28_712);
  const view = new DataView(scope.buffer);
  for (const [index, e] of Object.entries(entries)) {
    const at = 40 + 56 * Number(index);
    view.setBigUint64(at, e.value, true);
    view.setBigUint64(at + 8, e.exponent, true);
    view.setBigUint64(at + 16, 999n, true);
    view.setBigUint64(at + 24, e.unixTimestamp, true);
  }
  const lending = new Uint8Array(196);
  const lv = new DataView(lending.buffer);
  const encoder = getAddressEncoder();
  lending.set(encoder.encode(address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')), 8);
  lending.set(
    encoder.encode(address(jl.fToken ?? '9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D')),
    40,
  );
  lv.setBigUint64(115, jl.rate, true);
  lv.setBigUint64(123, jl.time, true);
  const accounts: Record<string, { data: Uint8Array; owner: Address }> = {
    [SCOPE]: { data: scope, owner: address(sources.scope.owner) },
    [LENDING]: { data: lending, owner: address('jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9') },
  };
  return {
    account: async (target) => {
      const found = accounts[target];
      return found ? { ...found, lamports: 1n } : null;
    },
  };
}

/** A real-looking Scope value with 15 decimal places, as the stock entries carry. */
const p15 = (dollars: string, unixTimestamp: bigint): Entry => {
  const [whole = '0', frac = ''] = dollars.split('.');
  return { value: BigInt(whole + frac.padEnd(15, '0')), exponent: 15n, unixTimestamp };
};

describe('the price copier', () => {
  let svm: LiteSVM;
  let admin: KeyPairSigner;
  let keeper: KeyPairSigner;
  let writer: KeyPairSigner;
  let deployment: Deployment;
  const options = (dryRun = false, log: (line: string) => void = () => {}): CopyOptions => ({
    dryRun,
    maxJumpBps: 1000,
    log,
  });
  const asset = (id: string) => deployment.assets.find((a) => a.id === id) as DeployedAsset;
  const held = (index: number) => {
    const account = svm.getAccount(deployment.accounts.priceAccount);
    if (!account.exists) throw new Error('no price account');
    return new Uint8Array(account.data).slice(40 + 56 * index, 40 + 56 * index + 32);
  };
  const bytesOf = (e: Entry) => {
    const out = new Uint8Array(32);
    const view = new DataView(out.buffer);
    view.setBigUint64(0, e.value, true);
    view.setBigUint64(8, e.exponent, true);
    view.setBigUint64(16, svm.getClock().slot, true);
    view.setBigUint64(24, e.unixTimestamp, true);
    return out;
  };

  const read = (index: number): Entry => {
    const bytes = held(index);
    const view = new DataView(bytes.buffer);
    return {
      value: view.getBigUint64(0, true),
      exponent: view.getBigUint64(8, true),
      unixTimestamp: view.getBigUint64(24, true),
    };
  };

  beforeAll(async () => {
    ({ svm, deployer: admin } = await createWorld());
    keeper = await fundedSigner(svm);
    writer = await fundedSigner(svm);
    // The set-up's first prices are stamped half a day before the tests run, as on devnet, where
    // they are days old: a real price is then copied however far it is from the placeholder.
    setClock(svm, SESSION - 12n * 3600n);
    const file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    file.roles = {
      guardian: admin.address,
      defaultKeeper: keeper.address,
      priceWriter: writer.address,
    };
    ({ deployment } = await setUp(liteChain(svm), admin, planOf(file), {
      dryRun: false,
      log: () => {},
      withLookupTable: false,
    }));
    setClock(svm, SESSION);
  });

  it("lands each copied entry byte for byte with the source's value, exponent and time", async () => {
    const t = SESSION + 100n;
    setClock(svm, t + 5n);
    const source = fakeMainnet(
      {
        344: p15('776.6479834626554', t),
        279: p15('776.2004278890778', t - 1n),
        314: { value: 118_649_713n, exponent: 8n, unixTimestamp: t },
        13: { value: 99_991_995n, exponent: 8n, unixTimestamp: t - 3n },
        504: { value: 118_649_183n, exponent: 8n, unixTimestamp: t },
        456: { value: 99_992_340n, exponent: 8n, unixTimestamp: t },
      },
      { rate: 1_062_999_156_547n, time: t - 7n },
    );
    const readings = await readPrices(source, sources);
    const result = await copyRound(liteChain(svm), writer, deployment, readings, options());
    expect(result.written).toEqual(expect.arrayContaining(['tSPYx', 'tsyrupUSDC', 'tjlUSDC']));
    const spyx = asset('solana:spyx');
    expect(held(spyx.priceIndex)).toEqual(bytesOf(p15('776.6479834626554', t)));
    expect(held(spyx.twapIndex)).toEqual(bytesOf(p15('776.2004278890778', t - 1n)));
    // A chain is the product of its entries, stamped with the oldest of their times.
    const syrup = asset('solana:syrupusdc');
    expect(read(syrup.priceIndex)).toEqual({
      value: 118_649_713n * 99_991_995n,
      exponent: 16n,
      unixTimestamp: t - 3n,
    });
    // jlUSDC: USDC's price times the rate, stamped with the older of the two.
    const jl = asset('solana:jlusdc');
    expect(read(jl.priceIndex)).toEqual({
      value: (99_991_995n * 1_062_999_156_547n) / 100n,
      exponent: 18n,
      unixTimestamp: t - 7n,
    });
    // This source has no entry 454: tPAXG is refused, never written as a zero.
    expect(result.refused.find((r) => r.id === 'tPAXG')?.why).toBe('the source holds no price');
    // A stock whose source entry holds nothing is refused, never written as a zero.
    expect(result.refused.find((r) => r.id === 'tQQQx')?.why).toBe('the source holds no price');
  });

  it('skips an entry no newer than the one held, and refuses a value outside the range or past a jump', async () => {
    const t = SESSION + 200n;
    setClock(svm, t + 5n);
    const spyx = asset('solana:spyx');
    const before = read(spyx.priceIndex);
    const readings: Reading[] = [
      // Older than what the account holds.
      {
        id: 'solana:spyx',
        price: { ...before, unixTimestamp: before.unixTimestamp - 1n },
        twap: { ...before, unixTimestamp: before.unixTimestamp - 1n },
        method: 'scope_entry',
      },
      // AAPLx's range is 259.53 to 418.6.
      {
        id: 'solana:aaplx',
        price: p15('450', t),
        twap: p15('449', t),
        method: 'scope_entry',
      },
      // Devnet holds TSLAx at 380, copied 100 s ago: 470 is in its range and 24% away.
      { id: 'solana:tslax', price: p15('470', t), twap: p15('468', t), method: 'scope_entry' },
      {
        id: 'solana:nvdax',
        price: p15('237.42', t),
        twap: p15('237.20', t),
        method: 'scope_entry',
      },
    ];
    const tsla = (price: string, at: bigint): Reading => ({
      id: 'solana:tslax',
      price: p15(price, at),
      twap: p15(price, at),
      method: 'scope_entry',
    });
    expect(
      (await copyRound(liteChain(svm), writer, deployment, [tsla('380', t - 100n)], options()))
        .written,
    ).toEqual(['tTSLAx']);
    const result = await copyRound(liteChain(svm), writer, deployment, readings, options());
    expect(result.unchanged).toEqual(['tSPYx']);

    expect(result.refused).toEqual([
      { id: 'tAAPLx', why: `price 450 is outside the keeper range 259.53 to 418.6; ${HINT.range}` },
      {
        id: 'tTSLAx',
        why: `price 470 is more than 1000 bps from the 380 devnet holds; ${HINT.jump}`,
      },
    ]);
    expect(result.written).toEqual(['tNVDAx']);
    expect(read(spyx.priceIndex)).toEqual(before);
    expect(read(asset('solana:aaplx').priceIndex).value).not.toBe(p15('450', t).value);
  });

  it('signs with the price writer only: the deploy key and any other key are refused', async () => {
    await expect(copyRound(liteChain(svm), admin, deployment, [], options())).rejects.toThrow(
      /the deploy key is the exchange's admin/,
    );
    const stranger = await fundedSigner(svm);
    await expect(copyRound(liteChain(svm), stranger, deployment, [], options())).rejects.toThrow(
      `the exchange's price writer is ${writer.address}, not ${stranger.address}`,
    );
  });

  it('sends nothing in a dry run, and refuses a time more than a minute ahead of the cluster', async () => {
    const t = SESSION + 260n;
    setClock(svm, t);
    const nvdax = asset('solana:nvdax');
    const before = held(nvdax.priceIndex);
    const printed: string[] = [];
    const dry = await copyRound(
      liteChain(svm),
      writer,
      deployment,
      [
        {
          id: 'solana:nvdax',
          price: p15('237.5', t),
          twap: p15('237.4', t),
          method: 'scope_entry',
        },
      ],
      options(true, (line) => printed.push(line)),
    );
    expect(dry.written).toEqual(['tNVDAx']);
    expect(dry.signatures).toEqual([]);
    expect(printed[0]).toMatch(/^ {4}would write tNVDAx: entry 332 237\.5 at /);
    expect(held(nvdax.priceIndex)).toEqual(before);
    const ahead = await copyRound(
      liteChain(svm),
      writer,
      deployment,
      [
        {
          id: 'solana:nvdax',
          price: p15('237.5', t + 120n),
          twap: p15('237.4', t),
          method: 'scope_entry',
        },
      ],
      options(),
    );
    expect(ahead.refused).toEqual([
      { id: 'tNVDAx', why: "price is stamped 120 s ahead of the cluster's clock" },
    ]);
  });

  it('gives no reading from a lending account of another token', async () => {
    const only = (id: string) => ({ ...sources, assets: { [id]: sources.assets[id] as never } });
    const usdc = { 13: p15('1', 5n), 456: p15('1', 5n) };
    const [jl] = await readPrices(
      fakeMainnet(usdc, {
        rate: 10n ** 12n,
        time: 5n,
        fToken: 'So11111111111111111111111111111111111111112',
      }),
      only('solana:jlusdc'),
    );
    expect(jl).toMatchObject({
      id: 'solana:jlusdc',
      none: expect.stringMatching(/not jlUSDC over USDC$/),
    });
  });

  it('turns a keeper leg that fails for stale prices into one that passes', async () => {
    const owner = await fundedSigner(svm);
    const creator = await fundedSigner(svm);
    setClock(svm, SESSION + 300n);
    // A vault holding tSPYx and tjlUSDC and following a portfolio with tQQQx at 30%.
    const lived = await lifecycle(
      liteChain(svm),
      deployment,
      { admin, owner, keeper, creator },
      () => {},
    );
    const qqqx = asset('solana:qqqx');
    const mintOf = (token: DeployedAsset | Deployment['cash']): TestMint => ({
      address: token.mint,
      program: token.tokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
      decimals: token.decimals,
      issuer: admin,
    });
    const cash = mintOf(deployment.cash);
    const out = mintOf(qqqx);
    const leg = async () =>
      keeperLegInstruction({
        keeper,
        vault: lived.vault,
        inputMint: cash,
        outputMint: out,
        amountIn: 50_000_000n,
        priceAccount: deployment.accounts.priceAccount,
        ...forwarded(
          await routeInstruction({
            trader: programSigner(lived.vault),
            mintIn: cash,
            mintOut: out,
            traderIn: await ata(lived.vault, cash),
            destination: await ata(lived.vault, out),
            amountIn: 50_000_000n,
            minOut: 1n,
            prices: deployment.accounts.priceAccount,
          }),
        ),
      });
    expectOk(
      await send(svm, keeper, [
        getCreateAssociatedTokenIdempotentInstruction({
          payer: keeper,
          ata: await ata(lived.vault, out),
          owner: lived.vault,
          mint: out.address,
          tokenProgram: out.program,
        }),
      ]),
    );
    // Two hours on, still in the session: nothing has moved the prices.
    const now = SESSION + 7_500n;
    setClock(svm, now);
    expectError(await send(svm, keeper, [await leg()]), ERR.PriceStale);

    // The copier writes every held asset's entries with a time from a minute ago.
    const fresh = (id: string): Reading => {
      const a = asset(id);
      const price = read(a.priceIndex);
      return {
        id,
        price: { ...price, unixTimestamp: now - 60n },
        twap: { ...read(a.twapIndex), unixTimestamp: now - 60n },
        method: 'scope_entry',
      };
    };
    const result = await copyRound(
      liteChain(svm),
      writer,
      deployment,
      ['solana:spyx', 'solana:qqqx', 'solana:jlusdc'].map(fresh),
      options(),
    );
    expect(result.written).toEqual(['tSPYx', 'tQQQx', 'tjlUSDC']);
    expectOk(await send(svm, keeper, [await leg()]));
  });
  it('copies a move after a long gap, and refuses the same move one round later', async () => {
    const metax = asset('solana:metax');
    const heldAt = read(metax.priceIndex);
    // Twelve hours after devnet's entry: a 15% rise is inside twelve hours' worth of 10%, capped at 50%.
    const later = heldAt.unixTimestamp + 12n * 3600n;
    setClock(svm, later + 10n);
    const up = (micros: bigint, at: bigint): Reading => ({
      id: 'solana:metax',
      price: { value: micros * 10n ** 9n, exponent: 15n, unixTimestamp: at },
      twap: { value: micros * 10n ** 9n, exponent: 15n, unixTimestamp: at },
      method: 'scope_entry',
    });
    const before = (heldAt.value * 1_000_000n) / 10n ** heldAt.exponent;
    const risen = (before * 115n) / 100n;
    const first = await copyRound(
      liteChain(svm),
      writer,
      deployment,
      [up(risen, later)],
      options(),
    );
    expect(first.written).toEqual(['tMETAx']);
    // Thirty seconds on, 15% back down is more than one hour's worth.
    setClock(svm, later + 40n);
    const second = await copyRound(
      liteChain(svm),
      writer,
      deployment,
      [up((risen * 85n) / 100n, later + 30n)],
      options(),
    );
    expect(second.refused).toHaveLength(1);
    expect(second.refused[0]?.why).toMatch(
      /^price .* is more than 1000 bps from the .* devnet holds; if it persists/,
    );
  });
  it('reaches the 5,000 bps cap after a long gap, and then points at the range, not at --max-jump-bps', async () => {
    const crclx = asset('solana:crclx');
    const at = read(crclx.priceIndex).unixTimestamp + 24n * 3600n;
    const quote = (dollars: string, when: bigint): Reading => ({
      id: 'solana:crclx',
      price: p15(dollars, when),
      twap: p15(dollars, when),
      method: 'scope_entry',
    });
    // Down to 66, near the floor of 65.20: a day's gap allows it.
    setClock(svm, at + 5n);
    expect(
      (await copyRound(liteChain(svm), writer, deployment, [quote('66', at)], options())).written,
    ).toEqual(['tCRCLx']);
    // Six hours on, 105 is inside the range (to 105.16) and 59% away: six hours' worth is capped at 5,000.
    setClock(svm, at + 6n * 3600n + 5n);
    const capped = await copyRound(
      liteChain(svm),
      writer,
      deployment,
      [quote('105', at + 6n * 3600n)],
      options(),
    );
    expect(capped.refused).toEqual([
      {
        id: 'tCRCLx',
        why: `price 105 is more than 5000 bps from the 66 devnet holds; ${HINT.capped}`,
      },
    ]);
    expect(HINT.capped).not.toContain('--max-jump-bps');
  });

  it('reads every other asset when the lending account cannot be read', async () => {
    const t = SESSION + 50n;
    const base = fakeMainnet(
      { 344: p15('776.6', t), 279: p15('776.2', t), 13: p15('1', t), 456: p15('1', t) },
      { rate: 10n ** 12n, time: t },
    );
    const failing: Source = {
      account: (target) =>
        target === LENDING ? Promise.reject(new Error('the node timed out')) : base.account(target),
    };
    const readings = await readPrices(failing, sources);
    expect(readings.find((r) => r.id === 'solana:jlusdc')).toEqual({
      id: 'solana:jlusdc',
      none: 'the node timed out',
    });
    expect(readings.find((r) => r.id === 'solana:spyx')).toMatchObject({
      price: p15('776.6', t),
      method: 'scope_entry',
    });
    expect(readings).toHaveLength(Object.keys(sources.assets).length);
  });
});
