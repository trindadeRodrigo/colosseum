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
function fakeMainnet(entries: Record<number, Entry>, jl: { rate: bigint; time: bigint }): Source {
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
  lending.set(encoder.encode(address('9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D')), 40);
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
  const options = (last = new Map<string, Entry>()): CopyOptions => ({
    dryRun: false,
    maxJumpBps: 1000,
    last,
    log: () => {},
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
    setClock(svm, SESSION);
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
    // GLDx has no source: its placeholder stays, and the round says so.
    expect(result.unchanged.some((line) => line === 'tGLDx (no source)')).toBe(true);
    // A stock whose source entry holds nothing is refused, never written as a zero.
    expect(result.refused.find((r) => r.id === 'tQQQx')?.why).toBe('the source holds no price');
  });

  it('skips an entry no newer than the one held, and refuses a value outside the range or past a jump', async () => {
    const t = SESSION + 200n;
    setClock(svm, t + 5n);
    const spyx = asset('solana:spyx');
    const before = read(spyx.priceIndex);
    const last = new Map<string, Entry>([
      ['solana:tslax:price', p15('400', t - 600n)],
      ['solana:tslax:twap', p15('400', t - 600n)],
    ]);
    const readings: Reading[] = [
      // Older than what the account holds.
      {
        id: 'solana:spyx',
        price: { ...before, unixTimestamp: before.unixTimestamp - 1n },
        twap: { ...before, unixTimestamp: before.unixTimestamp - 1n },
        method: 'scope_entry',
      },
      // AAPLx's range is 187.5 to 325.
      {
        id: 'solana:aaplx',
        price: p15('335.24', t),
        twap: p15('335.01', t),
        method: 'scope_entry',
      },
      // TSLAx last copied at 400: 470 is in its range and 17.5% away.
      { id: 'solana:tslax', price: p15('470', t), twap: p15('468', t), method: 'scope_entry' },
      {
        id: 'solana:nvdax',
        price: p15('237.42', t),
        twap: p15('237.20', t),
        method: 'scope_entry',
      },
    ];
    const result = await copyRound(liteChain(svm), writer, deployment, readings, options(last));
    expect(result.unchanged).toEqual(['tSPYx']);
    expect(result.refused).toEqual([
      { id: 'tAAPLx', why: 'price 335.24 is outside the keeper range 187.5 to 325' },
      { id: 'tTSLAx', why: 'price 470 is more than 1000 bps from the last copied 400' },
    ]);
    expect(result.written).toEqual(['tNVDAx']);
    expect(read(spyx.priceIndex)).toEqual(before);
    expect(read(asset('solana:aaplx').priceIndex).value).not.toBe(p15('335.24', t).value);
  });

  it('signs with the price writer only: the deploy key is refused', async () => {
    await expect(copyRound(liteChain(svm), admin, deployment, [], options())).rejects.toThrow(
      /the deploy key is the exchange's admin/,
    );
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
});
