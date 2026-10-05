import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAddress,
  BASKET_DISCRIMINATORS,
  COMPUTE_BUDGET_PROGRAM,
  type Composed,
  createTokenAccountInstruction,
  MAX_TRANSACTION_BYTES,
  pricedOut,
  TOKEN_PROGRAM,
  unlistedAssetId,
} from '@colosseum/chain-solana/vault';
import { type BuiltTx, ChainError } from '@colosseum/schemas';
import {
  type Address,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  lamports,
} from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAccount, freezeAccount, initMint, MINT_BYTES, priceAccountBytes } from './admin';
import {
  buildContractWorld,
  type ContractWorld,
  id,
  newKey,
  PRICED_SPREAD_BPS,
  priceEntries,
} from './contract-world';
import {
  BASKET_PROGRAM,
  createSvmNode,
  MOCK_ROUTER_PROGRAM,
  PROGRAMS_BUILT,
  type SvmNode,
} from './svm-node';

// The transactions the builders write, in LiteSVM with the real program: how large each one is and
// what it uses, at the most lines a vault takes, and the shape the guard (packages/sdk, DESIGN-VAULT
// section 9) holds an owner's step to. A creation with its first buys never shares a transaction on
// Solana (`tradesInCreate` is false): the create and its deposit are one step, each buy its own.

/** How many lines of each instruction the interface names: the rest are a route's or a hook's. */
const NAMED: Record<string, number> = {
  create_vault: 6,
  deposit: 7,
  owner_swap: 11,
  set_targets: 4,
  withdraw: 6,
  accept_version: 3,
  set_auto_follow: 2,
};
const nameOf = (data: ArrayLike<number>) =>
  Object.entries(BASKET_DISCRIMINATORS).find(([, d]) => d.every((b, i) => data[i] === b))?.[0];

/**
 * The guard's rules for an owner's step, as the bytes show them: the owner the one signer and fee
 * payer; only the vault program, "create if missing" and the compute budget; one limit and at most
 * one price; and every account an instruction of the vault program names for itself in the message,
 * never read through a lookup table.
 */
function holdsTheGuardShape(tx: BuiltTx, owner: string) {
  const wire = getTransactionDecoder().decode(new Uint8Array(Buffer.from(tx.payload, 'base64')));
  const message = getCompiledTransactionMessageDecoder().decode(wire.messageBytes);
  const keys = message.staticAccounts;
  expect(message.header.numSignerAccounts).toBe(1);
  expect(keys[0]).toBe(owner);
  const budget: number[] = [];
  for (const ix of message.instructions) {
    const program = keys[ix.programAddressIndex];
    expect([BASKET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM]).toContain(program);
    const data = ix.data ?? new Uint8Array();
    if (program === COMPUTE_BUDGET_PROGRAM) budget.push(data[0] ?? 0);
    if (program === ASSOCIATED_TOKEN_PROGRAM) expect([...data]).toEqual([1]);
    if (program === BASKET_PROGRAM) {
      const name = nameOf(data);
      expect(name && NAMED[name], `an owner step does not call ${name}`).toBeTruthy();
      const named = (ix.accountIndices ?? []).slice(0, NAMED[name ?? ''] ?? 0);
      for (const index of named) expect(index).toBeLessThan(keys.length);
      // What follows the named accounts is passed on: never a key that signed.
      for (const index of (ix.accountIndices ?? []).slice(NAMED[name ?? ''] ?? 0))
        expect(index).toBeGreaterThanOrEqual(1);
    }
  }
  expect(budget.filter((k) => k === 2)).toHaveLength(1);
  expect(budget.filter((k) => k === 3).length).toBeLessThanOrEqual(1);
  expect(budget.every((k) => k === 2 || k === 3)).toBe(true);
}

const composedOf = (tx: BuiltTx) => (tx as BuiltTx & { composed: Composed }).composed;

describe.skipIf(!PROGRAMS_BUILT)('the Solana builders, in LiteSVM with the real program', () => {
  let w: ContractWorld;
  let node: SvmNode;
  const sizes: string[] = [];
  const measure = (label: string, tx: BuiltTx) => {
    const c = composedOf(tx);
    sizes.push(
      `${label}: ${c.bytes} bytes, ${c.unitsConsumed} units used, limit ${c.computeUnitLimit}`,
    );
    expect(c.bytes).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES);
    // The budget is what the simulation used and a fifth more.
    expect(c.computeUnitLimit).toBe(Math.ceil(c.unitsConsumed * 1.2));
    return c;
  };
  // Sixteen positions: the four of the shelf and twelve more.
  const EXTRA = 13;
  const sixteen = () => [
    ...['alpha', 'beta', 'gamma', 'delta'].map((n) => id(n)),
    ...Array.from({ length: 12 }, (_, i) => id(`x${i + 1}`)),
  ];

  beforeAll(async () => {
    const deployer = await newKey();
    const start = BigInt(Math.floor(Date.now() / 1000));
    node = await createSvmNode(deployer.address, start);
    node.svm.airdrop(deployer.address, lamports(1_000_000_000_000n));
    const priceAccount = (await newKey()).address;
    const writePrices = (at: bigint, header = true) => {
      const data = priceAccountBytes(priceEntries(EXTRA), at, node.svm.getClock().slot, header);
      node.svm.setAccount({
        address: priceAccount,
        data,
        executable: false,
        lamports: lamports(node.svm.minimumBalanceForRentExemption(BigInt(data.length))),
        programAddress: MOCK_ROUTER_PROGRAM,
        space: BigInt(data.length),
      });
    };
    // Header-less: the test exchange takes it as its own price account first (`init_prices`).
    writePrices(start, false);
    w = await buildContractWorld(
      {
        rpc: node.rpc,
        land: async (tx) => {
          const landed = node.land(tx);
          return { signature: landed.signature, failed: landed.err !== null, logs: landed.logs };
        },
        advance: async (seconds) => {
          node.advance(seconds);
        },
        now: async () => node.now(),
        refreshPrices: writePrices,
      },
      {
        deployer,
        priceAccount,
        pendingVersion: false,
        network: 'testnet',
        notBefore: new Date().toISOString(),
        extraAssets: EXTRA,
      },
    );
  }, 120_000);

  it('opens a vault with its own targets and a deposit in one transaction, at every size up to sixteen lines', async () => {
    const owner = w.fixture.owner;
    for (const n of [1, 7, 12, 16]) {
      const targets = sixteen()
        .slice(0, n)
        .map((asset) => ({ asset, weightBps: Math.floor(10_000 / n) }));
      const tx = await w.adapter.buildCreateVault({
        owner,
        basketId: `${200 + n}`,
        targets,
        autoFollow: false,
        depositRaw: '1000000',
        slippageBps: 100,
      });
      measure(`create with ${n} own targets and a deposit`, tx);
      holdsTheGuardShape(tx, owner);
    }
    const follow = await w.adapter.buildCreateVault({
      owner,
      basketId: '230',
      targets: [],
      recipeOnchainId: w.fixture.recipeOnchainId,
      autoFollow: true,
      depositRaw: '1000000',
      slippageBps: 100,
    });
    measure('create following a shared portfolio, and a deposit', follow);
    holdsTheGuardShape(follow, owner);
  });

  it('writes every other owner step in the shape the guard takes', async () => {
    const f = w.fixture;
    const a = w.adapter;
    const steps: [string, BuiltTx][] = [
      ['deposit', await a.buildDeposit({ vault: f.vault, amountRaw: '1000000', slippageBps: 100 })],
      [
        'swap, buying',
        await a.buildOwnerSwap({ vault: f.vault, trades: [f.ownerTrade], slippageBps: 100 }),
      ],
      [
        'swap, selling',
        await a.buildOwnerSwap({
          vault: f.vault,
          trades: [{ sell: id('alpha'), buy: id('cash'), amountInRaw: '1000000' }],
          slippageBps: 100,
        }),
      ],
      [
        'swap, opening the account it buys into',
        await a.buildOwnerSwap({
          vault: f.vault,
          trades: [{ sell: id('cash'), buy: id('delta'), amountInRaw: '1000000' }],
          slippageBps: 100,
        }),
      ],
      [
        'set targets',
        await a.buildSetTargets({
          vault: f.manualVault,
          targets: [{ asset: id('alpha'), weightBps: 10_000 }],
        }),
      ],
      [
        'accept a version',
        await a.buildAcceptVersion({
          vault: f.newAssetVault,
          recipeOnchainId: f.newAssetRecipeId,
          expectedVersion: 2,
        }),
      ],
      ['auto-follow on', await a.buildSetAutoFollow({ vault: f.manualVault, on: true })],
      ...(await a.buildWithdrawInKind({ vault: f.vault })).map((tx): [string, BuiltTx] => [
        `withdraw ${tx.preview.changes[0]?.asset}`,
        tx,
      ]),
    ];
    for (const [label, tx] of steps) {
      measure(label, tx);
      holdsTheGuardShape(tx, f.owner);
    }
    // The one that opens the account it buys into does it before the swap, in the same transaction.
    const opening = steps.find(([label]) => label.includes('opening'))?.[1];
    const message = getCompiledTransactionMessageDecoder().decode(
      getTransactionDecoder().decode(new Uint8Array(Buffer.from(opening?.payload ?? '', 'base64')))
        .messageBytes,
    );
    expect(
      message.instructions.map((ix) => message.staticAccounts[ix.programAddressIndex]),
    ).toEqual([COMPUTE_BUDGET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, BASKET_PROGRAM]);
  });

  it("quotes and swaps through a priced pair (TNET-4's kind 1) at the entry less its spread, both ways", async () => {
    const f = w.fixture;
    // Delta is $10 at its entry, 8 decimals; the dollar token has 6; the pair keeps 30 bps.
    const buy = { sell: id('cash'), buy: id('delta'), amountInRaw: '1000000' };
    const quote = await w.adapter.quote(buy, f.owner);
    expect(quote.outRaw).toBe(
      String(
        pricedOut({
          amountIn: 1_000_000n,
          value: 1_000_000_000n,
          exponent: 8n,
          assetDecimals: 8,
          cashDecimals: 6,
          assetIsInput: false,
          spreadBps: PRICED_SPREAD_BPS,
        }),
      ),
    );
    expect(quote.outRaw).toBe('9970000');
    const before = await w.adapter.getVault(f.vault);
    const tx = await w.adapter.buildOwnerSwap({ vault: f.vault, trades: [buy], slippageBps: 100 });
    holdsTheGuardShape(tx, f.owner);
    await w.must(tx);
    const after = await w.adapter.getVault(f.vault);
    const held = (v: typeof after) =>
      BigInt(v?.positions.find((p) => p.asset === id('delta'))?.raw ?? 0);
    expect(held(after) - held(before)).toBe(9_970_000n);
    // And back: what a sale of it pays is the entry less the spread again.
    const sell = { sell: id('delta'), buy: id('cash'), amountInRaw: '9970000' };
    expect((await w.adapter.quote(sell, f.owner)).outRaw).toBe(
      String((997_000n * 9_970n) / 10_000n),
    );
    await w.must(
      await w.adapter.buildOwnerSwap({ vault: f.vault, trades: [sell], slippageBps: 100 }),
    );
  });

  it('sizes the budget of a keeper leg in a vault of sixteen positions from its simulation', async () => {
    const owner = w.fixture.owner;
    const lines = sixteen();
    await w.must(
      await w.adapter.buildCreateVault({
        owner,
        basketId: '300',
        targets: lines.map((asset) => ({ asset, weightBps: 600 })),
        autoFollow: true,
        depositRaw: '400000000',
        slippageBps: 100,
      }),
    );
    const vault = (await w.adapter.getVaults(owner)).find((v) => v.basketId === '300')?.address;
    if (!vault) throw new Error('no vault');
    // Something of every line, short of its target.
    for (const asset of lines)
      await w.must(
        await w.adapter.buildOwnerSwap({
          vault,
          trades: [{ sell: id('cash'), buy: asset, amountInRaw: '10000000' }],
          slippageBps: 100,
        }),
      );
    const leg = await w.adapter.buildKeeperLeg(vault, {
      sell: id('cash'),
      buy: id('alpha'),
      amountInRaw: '5000000',
    });
    const c = measure('keeper leg, 16 positions, through the test exchange', leg);
    // Every position the vault holds is valued: more than the same leg in a vault of three.
    const three = measure(
      'keeper leg, 3 positions, through the test exchange',
      await w.adapter.buildKeeperLeg(w.fixture.vault, w.fixture.keeperTrade),
    );
    // Each run makes new keys, and finding an address's bump costs more for some than for others: the
    // two legs differ by a few thousand units either way, so only the order is held.
    expect(c.unitsConsumed).toBeGreaterThan(three.unitsConsumed);
    const sync = await w.adapter.buildSyncBalances(vault);
    measure('sync of 16 balances, by the keeper', sync);
  });

  it('never buys a token the app does not list into a vault, nor quotes it', async () => {
    const f = w.fixture;
    // A real mint the app does not list.
    const mint = await newKey();
    const { deployer } = w.keys;
    await w.run(
      deployer,
      [
        createAccount({
          payer: deployer.address,
          account: mint.address,
          lamports: 10_000_000n,
          space: MINT_BYTES,
          owner: TOKEN_PROGRAM,
        }),
        initMint({
          mint: mint.address,
          tokenProgram: TOKEN_PROGRAM,
          decimals: 6,
          authority: deployer.address,
        }),
      ],
      [mint],
    );
    const unlisted = unlistedAssetId(mint.address);
    const buy = { sell: id('cash'), buy: unlisted, amountInRaw: '1000000' };
    for (const work of [
      w.adapter.buildOwnerSwap({ vault: f.vault, trades: [buy], slippageBps: 100 }),
      w.adapter.quote(buy, f.owner),
    ]) {
      const outcome = await work.then(
        () => 'built',
        (e: unknown) => e,
      );
      expect((outcome as ChainError).code).toBe('MintNotAccepted');
    }
  });

  it("refuses a keeper leg while the program's records of the vault are not what it holds", async () => {
    const owner = w.fixture.owner;
    // 45% alpha, 50% gamma, 5% cash against targets of 50/50; auto-follow on once it is bought.
    await w.must(
      await w.adapter.buildCreateVault({
        owner,
        basketId: '320',
        targets: [
          { asset: id('alpha'), weightBps: 5_000 },
          { asset: id('gamma'), weightBps: 5_000 },
        ],
        autoFollow: false,
        depositRaw: '1000000000',
        slippageBps: 100,
      }),
    );
    const vault = (await w.adapter.getVaults(owner)).find((v) => v.basketId === '320')?.address;
    if (!vault) throw new Error('no vault');
    for (const [name, dollars] of [
      ['alpha', 450],
      ['gamma', 500],
    ] as const)
      await w.must(
        await w.adapter.buildOwnerSwap({
          vault,
          trades: [{ sell: id('cash'), buy: id(name), amountInRaw: String(dollars * 1_000_000) }],
          slippageBps: 100,
        }),
      );
    await w.must(await w.adapter.buildSetAutoFollow({ vault, on: true }));
    // Half the gamma leaves unseen by the program, as an issuer's clawback through a permanent
    // delegate does. Alpha is then truly 60% of the vault, over its target; the records say 47%.
    const gamma = w.mints.gamma;
    if (!gamma) throw new Error('no gamma');
    const at = await associatedTokenAddress(vault as Address, gamma.address, gamma.tokenProgram);
    const account = node.svm.getAccount(at);
    if (!account.exists) throw new Error('no gamma account');
    const data = new Uint8Array(account.data);
    const view = new DataView(data.buffer);
    view.setBigUint64(64, view.getBigUint64(64, true) / 2n, true);
    node.svm.setAccount({ ...account, data });

    const buy = { sell: id('cash'), buy: id('alpha'), amountInRaw: '45000000' };
    expect((await w.adapter.getKeeperContext(vault))?.positions.map((p) => p.needsSync)).toEqual([
      false,
      true,
    ]);
    const stale = await w.adapter.buildKeeperLeg(vault, buy).then(
      () => 'built',
      (e: unknown) => e,
    );
    expect((stale as ChainError).code).toBe('AccountTampered');
    expect((stale as ChainError).message).toMatch(/Sync its balances first/);
    // Once the keeper syncs, the leg is held to the truth: a buy of an asset over its target.
    await w.must(await w.adapter.buildSyncBalances(vault));
    const synced = await w.adapter.buildKeeperLeg(vault, buy).then(
      () => 'built',
      (e: unknown) => e,
    );
    expect((synced as ChainError).code).toBe('NotTowardTarget');
  });

  it('withdraws every token it can when one cannot move, and says why for that one', async () => {
    const f = w.fixture;
    const gamma = w.mints.gamma;
    if (!gamma) throw new Error('no gamma');
    // The issuer freezes the owner's account of one token the vault holds.
    const owner = f.owner as Address;
    const account = await associatedTokenAddress(owner, gamma.address, gamma.tokenProgram);
    await w.run(w.keys.deployer, [
      createTokenAccountInstruction({
        payer: w.keys.deployer.address,
        account,
        holder: owner,
        token: { mint: gamma.address, tokenProgram: gamma.tokenProgram },
      }),
      freezeAccount({
        account,
        mint: gamma.address,
        tokenProgram: gamma.tokenProgram,
        authority: w.keys.deployer.address,
      }),
    ]);
    const each = await w.adapter.buildWithdrawEach({ vault: f.vault });
    const moved = each.txs.map((tx) => tx.preview.changes[0]?.asset).sort();
    expect(moved).toEqual(
      [id('alpha'), id('beta'), id('cash'), id('delta')].filter((a) => moved.includes(a)),
    );
    expect(moved).toContain(id('cash'));
    expect(moved).not.toContain(id('gamma'));
    expect(each.notBuilt).toEqual([
      { asset: id('gamma'), code: 'BalanceUnreadable', message: expect.stringContaining('frozen') },
    ]);
    // The shared builder hands back what it could build.
    expect((await w.adapter.buildWithdrawInKind({ vault: f.vault })).length).toBe(each.txs.length);
    // Asked for that token alone, it says why.
    const alone = await w.adapter
      .buildWithdrawInKind({ vault: f.vault, assets: [id('gamma')] })
      .then(
        () => 'built',
        (e: unknown) => e,
      );
    expect((alone as ChainError).code).toBe('BalanceUnreadable');
  });

  it('refuses an accept whose version and leftovers pass sixteen lines, and says to clear a leftover first', async () => {
    const owner = w.fixture.owner;
    // Fourteen lines held, none of them in the shared portfolio's three: seventeen once accepted.
    const lines = Array.from({ length: 13 }, (_, i) => id(`x${i + 1}`)).concat(id('delta'));
    await w.must(
      await w.adapter.buildCreateVault({
        owner,
        basketId: '310',
        targets: lines.map((asset) => ({ asset, weightBps: 700 })),
        autoFollow: false,
        depositRaw: '200000000',
        slippageBps: 100,
      }),
    );
    const vault = (await w.adapter.getVaults(owner)).find((v) => v.basketId === '310')?.address;
    if (!vault) throw new Error('no vault');
    for (const asset of lines)
      await w.must(
        await w.adapter.buildOwnerSwap({
          vault,
          trades: [{ sell: id('cash'), buy: asset, amountInRaw: '5000000' }],
          slippageBps: 100,
        }),
      );
    const outcome = await w.adapter
      .buildAcceptVersion({ vault, recipeOnchainId: w.fixture.recipeOnchainId, expectedVersion: 1 })
      .then(
        () => 'built',
        (e: unknown) => e,
      );
    expect(outcome).toBeInstanceOf(ChainError);
    expect((outcome as ChainError).code).toBe('InvalidTargets');
    expect((outcome as ChainError).message).toMatch(/sell or withdraw a leftover first/);
    console.log(sizes.join('\n'));
  });
});
