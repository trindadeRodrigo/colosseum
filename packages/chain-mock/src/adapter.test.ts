import { BasketTx, BuiltTx, ChainError, type ChainId, stampTx } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { createMockAdapter } from './adapter';
import { displayAmount, fromScaled, valueScaled } from './amounts';
import { mockFixture } from './fixture';
import { mockAddress } from './ids';

// What the mock does beyond the adapter contract: it settles what it built, so a walking skeleton can
// run a whole order on it, and it does so the same way every time.

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'no error',
    (e) => (e instanceof ChainError ? e.code : `not a ChainError: ${e}`),
  );

async function funded(chain: ChainId) {
  const adapter = createMockAdapter({ chain });
  const owner = mockAddress(chain, 'owner');
  adapter.mock.fund(owner, {
    gasRaw: '1000000000000000000',
    assets: { [adapter.mock.cash]: '5000000000' },
  });
  const targets = [
    { asset: `${chain}:spy`, weightBps: 6000 },
    { asset: `${chain}:gold`, weightBps: 4000 },
  ];
  return { adapter, mock: adapter.mock, owner, targets };
}

describe('chain-mock', () => {
  it('matches the design vector: 8 decimals, raw 250,000,000, multiplier 1.02, price 100', async () => {
    expect(displayAmount('250000000', '1.02', 8)).toBe('2.55');
    expect(fromScaled(valueScaled(250_000_000n, '100', 8))).toBe('250');

    const { adapter, mock, owner } = await funded('solana');
    mock.fund(owner, { assets: { 'solana:spy': '250000000' } });
    mock.setMultiplier('solana:spy', '1.02');
    const held = (await adapter.getWalletHoldings(owner)).find((h) => h.asset === 'solana:spy');
    expect(held).toEqual({
      asset: 'solana:spy',
      raw: '250000000',
      multiplier: '1.02',
      display: '2.55',
    });
  });

  it('gives the same answers on every run', async () => {
    const run = async () => {
      const f = await mockFixture('robinhood');
      const tx = await f.adapter.buildDeposit({
        vault: f.vault,
        amountRaw: f.depositRaw,
        slippageBps: 50,
      });
      return JSON.stringify([
        await f.adapter.getVault(f.vault),
        await f.adapter.getPrices([`robinhood:spy`]),
        await f.adapter.getRecipe(f.recipeOnchainId),
        tx,
        await f.adapter.mock.send(tx),
      ]);
    };
    expect(await run()).toBe(await run());
  });

  it('stamps provenance mock on everything it returns', async () => {
    const f = await mockFixture('solana');
    const tx = await f.adapter.buildOwnerSwap({
      vault: f.vault,
      trades: [f.ownerTrade],
      slippageBps: 50,
    });
    const stamped = [
      ...(await f.adapter.listAssets()),
      ...(await f.adapter.getPrices(['solana:spy', 'solana:usdc'])),
      await f.adapter.quote(f.ownerTrade, f.owner),
      tx,
      tx.preview,
    ];
    for (const s of stamped) expect(s.provenance).toBe('mock');
    expect(f.adapter.capabilities.trade).toBe('mock');
    expect((await f.adapter.track(f.unknownTxId)).explorerUrl.startsWith('mock://')).toBe(true);
  });

  it('settles a buy on Solana: open the vault, then one trade a transaction', async () => {
    const { adapter, mock, owner, targets } = await funded('solana');
    const create = await adapter.buildCreateVault({
      owner,
      basketId: '42',
      targets,
      autoFollow: false,
      depositRaw: '1000000000',
      slippageBps: 50,
    });
    const { txId } = await mock.send(create);
    expect((await adapter.track(txId)).status).toBe('confirmed');
    const vault = (await adapter.getVaults(owner))[0];
    expect(vault?.basketId).toBe('42');
    expect(vault?.cash.raw).toBe('1000000000');

    const address = vault?.address ?? '';
    for (const [buy, amountInRaw] of [
      ['solana:spy', '600000000'],
      ['solana:gold', '400000000'],
    ] as const) {
      const trade = { sell: mock.cash, buy, amountInRaw };
      await mock.send(
        await adapter.buildOwnerSwap({ vault: address, trades: [trade], slippageBps: 50 }),
      );
    }
    const after = await adapter.getVault(address);
    expect(after?.cash.raw).toBe('0');
    // 600 USD at 100 a token, less the mock's 10 bps: 5.994 tokens of 8 decimals.
    expect(after?.positions.map((p) => [p.asset, p.raw, p.targetBps])).toEqual([
      ['solana:spy', '599400000', 6000],
      ['solana:gold', '199800000', 4000],
    ]);
    expect((await adapter.getWalletHoldings(owner))[0]?.raw).toBe('4000000000');
  });

  it('settles a buy on an EVM chain in one transaction, after an approval', async () => {
    const { adapter, mock, owner, targets } = await funded('robinhood');
    const args = {
      owner,
      basketId: '42',
      targets,
      autoFollow: false,
      depositRaw: '1000000000',
      trades: [
        { sell: mock.cash, buy: 'robinhood:spy', amountInRaw: '600000000' },
        { sell: mock.cash, buy: 'robinhood:gold', amountInRaw: '400000000' },
      ],
      slippageBps: 50,
    };
    expect(await code(adapter.buildCreateVault(args))).toBe('AllowanceTooLow');
    const spender = mock.addresses.factory;
    await mock.send(await adapter.buildApprove({ owner, spender, amountRaw: '1000000000' }));
    await mock.send(await adapter.buildCreateVault(args));
    const vault = (await adapter.getVaults(owner))[0];
    expect(vault?.cash.raw).toBe('0');
    // Stock tokens have 18 decimals on Robinhood Chain.
    expect(vault?.positions.map((p) => p.display)).toEqual(['5.994', '1.998']);
    // The approval is spent by what was deposited.
    const again = adapter.buildDeposit({
      vault: vault?.address ?? '',
      amountRaw: '1',
      slippageBps: 50,
    });
    expect(await code(again)).toBe('AllowanceTooLow');
  });

  it('follows the chain on how many trades fit, and where', async () => {
    const sol = await funded('solana');
    const base = { owner: sol.owner, basketId: '1', targets: sol.targets, autoFollow: false };
    const trade = { sell: sol.mock.cash, buy: 'solana:spy', amountInRaw: '1000000' };
    const inCreate = sol.adapter.buildCreateVault({
      ...base,
      depositRaw: '1000000',
      trades: [trade],
      slippageBps: 50,
    });
    expect(await code(inCreate)).toBe('NotSupported');
    await sol.mock.send(
      await sol.adapter.buildCreateVault({ ...base, depositRaw: '5000000', slippageBps: 50 }),
    );
    const vault = (await sol.adapter.getVaults(sol.owner))[0]?.address ?? '';
    const two = sol.adapter.buildOwnerSwap({ vault, trades: [trade, trade], slippageBps: 50 });
    expect(await code(two)).toBe('TooManyTrades');
  });

  it('only sends what it built, once', async () => {
    const f = await mockFixture('solana');
    const tx = await f.adapter.buildDeposit({
      vault: f.vault,
      amountRaw: '1000000',
      slippageBps: 50,
    });
    const forged: BuiltTx = { ...tx, messageHash: 'ff'.repeat(32) };
    expect(await code(f.adapter.mock.send(forged))).toBe('NotBuiltHere');

    const before = (await f.adapter.getVault(f.vault))?.cash.raw;
    const first = await f.adapter.mock.send(tx);
    const second = await f.adapter.mock.send(tx);
    expect(second).toEqual(first);
    const after = (await f.adapter.getVault(f.vault))?.cash.raw;
    expect(BigInt(after ?? 0) - BigInt(before ?? 0)).toBe(1_000_000n);
  });

  it('can make a transaction revert, and leaves the vault as it was', async () => {
    const f = await mockFixture('solana');
    const before = await f.adapter.getVault(f.vault);
    f.adapter.mock.revertNext({ code: 'ReceivedTooLittle', message: 'the price moved' });
    const tx = await f.adapter.buildOwnerSwap({
      vault: f.vault,
      trades: [f.ownerTrade],
      slippageBps: 50,
    });
    const { txId } = await f.adapter.mock.send(tx);
    expect(await f.adapter.track(txId)).toMatchObject({
      status: 'reverted',
      error: { code: 'ReceivedTooLittle' },
    });
    expect(await f.adapter.getVault(f.vault)).toEqual(before);
  });

  it('can drop a transaction: pending until its validity runs out, then expired', async () => {
    const f = await mockFixture('solana');
    const tx = await f.adapter.buildOwnerSwap({
      vault: f.vault,
      trades: [f.ownerTrade],
      slippageBps: 50,
    });
    f.adapter.mock.dropNext();
    const { txId, validUntil } = await f.adapter.mock.send(tx);
    expect(validUntil).toBe(String(tx.lastValidBlockHeight));
    expect((await f.adapter.track(txId, validUntil)).status).toBe('pending');
    f.adapter.mock.advance(61);
    expect((await f.adapter.track(txId, validUntil)).status).toBe('expired');
    // A transaction built too long ago is not sent either.
    const stale = await f.adapter.buildSetAutoFollow({ vault: f.vault, on: true });
    f.adapter.mock.advance(61);
    expect(await code(f.adapter.mock.send(stale))).toBe('Expired');
  });

  it('refuses to send when the wallet cannot pay the network fee', async () => {
    const adapter = createMockAdapter({ chain: 'solana' });
    const owner = mockAddress('solana', 'no gas');
    adapter.mock.fund(owner, { assets: { [adapter.mock.cash]: '1000000' } });
    expect((await adapter.funding(owner, { cashRaw: '1000000', legs: 1, newVault: true })).ok).toBe(
      false,
    );
    const tx = await adapter.buildCreateVault({
      owner,
      basketId: '1',
      targets: [{ asset: 'solana:spy', weightBps: 10_000 }],
      autoFollow: false,
      slippageBps: 50,
    });
    expect(await code(adapter.mock.send(tx))).toBe('NoGas');
  });

  it('withdraws every token to the owner and leaves the vault empty', async () => {
    const f = await mockFixture('solana');
    const before = await f.adapter.getVault(f.vault);
    const txs = await f.adapter.buildWithdrawInKind({ vault: f.vault });
    // One mint per call on Solana: cash and the one position bought.
    expect(txs).toHaveLength(2);
    for (const tx of txs) await f.adapter.mock.send(tx);
    const after = await f.adapter.getVault(f.vault);
    expect(after?.cash.raw).toBe('0');
    expect(after?.positions.every((p) => p.raw === '0')).toBe(true);
    const spy = before?.positions.find((p) => p.asset === 'solana:spy');
    const held = await f.adapter.getWalletHoldings(f.owner);
    expect(held.find((h) => h.asset === 'solana:spy')?.raw).toBe(spy?.raw);
    expect(await f.adapter.getWalletHoldings(f.stranger)).toEqual([]);
    expect(await f.adapter.buildWithdrawInKind({ vault: f.vault })).toEqual([]);
  });

  it('applies a new version after the delay: weights by anyone, a new asset only by the owner', async () => {
    const f = await mockFixture('solana', { newVersion: false });
    const { adapter } = f;
    const { mock } = adapter;
    expect(await code(adapter.buildAdoptVersion(f.vault))).toBe('VersionNotEffective');

    // Version 2 changes weights only.
    await mock.send(
      await adapter.buildPublishRecipe({ creator: f.owner, recipe: f.publishRecipe }),
    );
    const waiting = await adapter.getVault(f.vault);
    expect(waiting?.pending).toMatchObject({ version: 2, newAssets: [] });
    expect(waiting?.pending?.effectiveAt).toBe(mock.now() + 300);
    const early = { vault: f.vault, recipeOnchainId: f.recipeOnchainId, expectedVersion: 2 };
    expect(await code(adapter.buildAcceptVersion(early))).toBe('VersionNotEffective');
    expect(await code(adapter.buildAdoptVersion(f.vault))).toBe('VersionNotEffective');
    // One version at a time.
    const another = adapter.buildPublishRecipe({ creator: f.owner, recipe: f.publishRecipe });
    expect(await code(another)).toBe('CreatorLimit');

    mock.advance(300);
    await mock.send(await adapter.buildAdoptVersion(f.vault));
    const adopted = await adapter.getVault(f.vault);
    expect(adopted?.acceptedVersion).toBe(2);
    expect(adopted?.pending).toBeNull();
    expect(adopted?.positions.map((p) => p.targetBps)).toEqual([3000, 5000, 2000]);

    // Version 3 adds an asset, inside the author limits: 10% out of NVDA and into TSLA.
    const withTsla = {
      ...f.publishRecipe,
      components: [
        { kind: 'asset' as const, asset: 'solana:spy', weightBps: 3000 },
        { kind: 'asset' as const, asset: 'solana:nvda', weightBps: 4000 },
        { kind: 'asset' as const, asset: 'solana:gold', weightBps: 2000 },
        { kind: 'asset' as const, asset: 'solana:tsla', weightBps: 1000 },
      ],
    };
    await mock.send(await adapter.buildPublishRecipe({ creator: f.owner, recipe: withTsla }));
    mock.advance(300);
    expect((await adapter.getVault(f.vault))?.pending?.newAssets).toEqual(['solana:tsla']);
    expect(await code(adapter.buildAdoptVersion(f.vault))).toBe('NewAssetNeedsOwner');
    const stale = { vault: f.vault, recipeOnchainId: f.recipeOnchainId, expectedVersion: 2 };
    expect(await code(adapter.buildAcceptVersion(stale))).toBe('VersionMismatch');
    await mock.send(await adapter.buildAcceptVersion({ ...stale, expectedVersion: 3 }));
    expect((await adapter.getVault(f.vault))?.acceptedVersion).toBe(3);
  });

  it('lets the keeper trade only with auto-follow on, and only toward a target', async () => {
    const f = await mockFixture('solana');
    const { adapter } = f;
    // SPY is under its target, so selling it moves away.
    const away = { sell: 'solana:spy', buy: adapter.mock.cash, amountInRaw: '1000000' };
    expect(await code(adapter.buildKeeperLeg(f.vault, away))).toBe('NotTowardTarget');
    const offList = { sell: adapter.mock.cash, buy: 'solana:tsla', amountInRaw: '1000000' };
    expect(await code(adapter.buildKeeperLeg(f.vault, offList))).toBe('MintNotAccepted');

    const { txId } = await adapter.mock.send(await adapter.buildKeeperLeg(f.vault, f.keeperTrade));
    expect((await adapter.track(txId)).status).toBe('confirmed');
    const nvda = (await adapter.getVault(f.vault))?.positions.find(
      (p) => p.asset === 'solana:nvda',
    );
    expect(nvda?.lastKeeperAt).toBe(adapter.mock.now());

    // Setting targets by hand stops following and switches auto-follow off.
    const targets = [{ asset: 'solana:spy', weightBps: 10_000 }];
    await adapter.mock.send(await adapter.buildSetTargets({ vault: f.vault, targets }));
    const vault = await adapter.getVault(f.vault);
    expect([vault?.autoFollow, vault?.recipeOnchainId]).toEqual([false, null]);
    expect(await adapter.listAutoFollowVaults()).not.toContain(f.vault);
    expect(await code(adapter.buildKeeperLeg(f.vault, f.keeperTrade))).toBe('AutoFollowOff');
  });

  it('opens and closes the stock market by the mock clock', async () => {
    // The default clock starts on a Monday at 15:00 UTC.
    const adapter = createMockAdapter({ chain: 'solana' });
    const market = async () =>
      (await adapter.getPrices(['solana:spy', 'solana:gold'])).map((p) => p.market);
    expect(await market()).toEqual(['open', 'open']);
    adapter.mock.advance(6 * 3600);
    expect(await market()).toEqual(['closed', 'open']);
    adapter.mock.setPrice('solana:spy', '101.5');
    expect((await adapter.getPrices(['solana:spy']))[0]?.usdPerToken).toBe('101.5');
    expect(await code(adapter.getPrices(['solana:nope']))).toBe('MintNotAccepted');
  });
  it('returns a transaction with no leg id; the order layer stamps both ids', async () => {
    const f = await mockFixture('robinhood');
    const built = await f.adapter.buildDeposit({
      vault: f.vault,
      amountRaw: '1000000',
      slippageBps: 50,
    });
    expect(BuiltTx.parse(built)).toEqual(built);
    expect(Object.keys(built)).not.toContain('legId');
    expect(BasketTx.safeParse(built).success).toBe(false);
    const stamped = stampTx(built, { legId: 'leg-1', attemptId: 'attempt-1' });
    expect(BasketTx.parse(stamped)).toEqual(stamped);
    // Stamping does not change the bytes, so the mock still knows it.
    expect((await f.adapter.mock.send(stamped)).txId.startsWith('0x')).toBe(true);
  });

  it('refuses bad arguments as BadInput, never as another kind of error', async () => {
    const { adapter, mock, owner, targets } = await funded('robinhood');
    const spender = mock.addresses.factory;
    expect(await code(adapter.buildApprove({ owner, spender, amountRaw: '1.5' }))).toBe('BadInput');
    expect(await code(adapter.buildApprove({ owner, spender, amountRaw: '-5' }))).toBe('BadInput');
    const create = { owner, basketId: '1', targets, autoFollow: false, slippageBps: 50 };
    expect(await code(adapter.buildCreateVault({ ...create, owner: 'nobody' }))).toBe('BadInput');
    expect(await code(adapter.buildCreateVault({ ...create, depositRaw: '1.5' }))).toBe('BadInput');
    expect(await code(adapter.buildCreateVault({ ...create, slippageBps: 20_000 }))).toBe(
      'BadInput',
    );
    const twice = [targets[0], targets[0]].flatMap((t) => (t ? [{ ...t, weightBps: 5000 }] : []));
    expect(await code(adapter.buildCreateVault({ ...create, targets: twice }))).toBe('BadInput');
    const zero = { sell: mock.cash, buy: 'robinhood:spy', amountInRaw: '0' };
    expect(await code(adapter.quote(zero, owner))).toBe('BadTrade');
    expect(await code(adapter.getPrices(['robinhood:doge']))).toBe('MintNotAccepted');
    expect(() => mock.setPrice('robinhood:gold', '0')).toThrow(ChainError);
    expect(() => mock.fund(owner, { assets: { [mock.cash]: '-5' } })).toThrow(ChainError);
    // Cash is what a vault holds between trades, not something a shared portfolio lists.
    const f = await mockFixture('robinhood');
    const withCash = {
      ...f.publishRecipe,
      components: [
        { kind: 'asset' as const, asset: 'robinhood:usdc', weightBps: 5000 },
        { kind: 'asset' as const, asset: 'robinhood:spy', weightBps: 5000 },
      ],
    };
    const publish = f.adapter.buildPublishRecipe({ creator: f.owner, recipe: withCash });
    expect(await code(publish)).toBe('MintNotAccepted');
    const unknown = f.adapter.buildWithdrawInKind({ vault: f.vault, assets: ['robinhood:doge'] });
    expect(await code(unknown)).toBe('MintNotAccepted');
  });

  it('holds a trade to its slippage: a price that moves past it reverts the transaction', async () => {
    const f = await mockFixture('solana');
    const { adapter } = f;
    const sellSpy = { sell: 'solana:spy', buy: adapter.mock.cash, amountInRaw: '100000000' };
    const before = await adapter.getVault(f.vault);
    const tight = await adapter.buildOwnerSwap({
      vault: f.vault,
      trades: [sellSpy],
      slippageBps: 100,
    });
    const loose = await adapter.buildOwnerSwap({
      vault: f.vault,
      trades: [sellSpy],
      slippageBps: 6000,
    });
    adapter.mock.setPrice('solana:spy', '50');
    const reverted = await adapter.track((await adapter.mock.send(tight)).txId);
    expect(reverted).toMatchObject({ status: 'reverted', error: { code: 'ReceivedTooLittle' } });
    expect(await adapter.getVault(f.vault)).toEqual(before);
    expect((await adapter.track((await adapter.mock.send(loose)).txId)).status).toBe('confirmed');
    // Half the price, less the mock's 10 bps: 49.95 dollars for one token.
    const after = await adapter.getVault(f.vault);
    expect(BigInt(after?.cash.raw ?? 0) - BigInt(before?.cash.raw ?? 0)).toBe(49_950_000n);
  });

  it('spends an EVM approval by what is deposited, not all at once', async () => {
    const { adapter, mock, owner, targets } = await funded('robinhood');
    const spender = mock.addresses.factory;
    await mock.send(await adapter.buildApprove({ owner, spender, amountRaw: '1000' }));
    const create = { owner, basketId: '1', targets, autoFollow: false, slippageBps: 50 };
    await mock.send(await adapter.buildCreateVault({ ...create, depositRaw: '1000' }));
    const vault = (await adapter.getVaults(owner))[0]?.address ?? '';
    await mock.send(await adapter.buildApprove({ owner, spender, amountRaw: '10' }));
    const deposit = (amountRaw: string) =>
      adapter.buildDeposit({ vault, amountRaw, slippageBps: 50 });
    await mock.send(await deposit('4'));
    await mock.send(await deposit('4'));
    expect(await code(deposit('4'))).toBe('AllowanceTooLow');
    await mock.send(await deposit('2'));
    expect((await adapter.getVault(vault))?.cash.raw).toBe('1010');
  });

  it('never repeats a transaction id across restarts when given a seed', async () => {
    const first = async (seed?: string) => {
      const adapter = createMockAdapter({ chain: 'robinhood', seed });
      const owner = mockAddress('robinhood', 'owner');
      adapter.mock.fund(owner, { gasRaw: '1000000000000000000' });
      const spender = adapter.mock.addresses.factory;
      const tx = await adapter.buildApprove({ owner, spender, amountRaw: '1000000' });
      return (await adapter.mock.send(tx)).txId;
    };
    expect(await first('start-1')).not.toBe(await first('start-2'));
    expect(await first('start-1')).toBe(await first('start-1'));
    expect(await first()).toBe(await first());
  });

  it('stops the keeper at the target, and outside the stock session', async () => {
    const f = await mockFixture('solana');
    const { adapter } = f;
    const { mock } = adapter;
    // SPY is near 30% against a target of 50%: all the cash into it would overshoot.
    const allIn = { sell: mock.cash, buy: 'solana:spy', amountInRaw: '700000000' };
    expect(await code(adapter.buildKeeperLeg(f.vault, allIn))).toBe('PastTarget');
    const bothStocks = { sell: 'solana:spy', buy: 'solana:nvda', amountInRaw: '1000' };
    expect(await code(adapter.buildKeeperLeg(f.vault, bothStocks))).toBe('BadTrade');
    mock.advance(6 * 3600);
    expect(await code(adapter.buildKeeperLeg(f.vault, f.keeperTrade))).toBe('MarketClosed');
    // Gold trades at any hour, and the owner at any hour in anything.
    const gold = { sell: mock.cash, buy: 'solana:gold', amountInRaw: '100000000' };
    expect((await adapter.buildKeeperLeg(f.vault, gold)).legKind).toBe('keeper_leg');
    const owner = adapter.buildOwnerSwap({
      vault: f.vault,
      trades: [f.ownerTrade],
      slippageBps: 50,
    });
    expect((await owner).legKind).toBe('swap');
  });

  it('treats an asset the owner only holds as new when a version adds it', async () => {
    const f = await mockFixture('solana', { newVersion: false });
    const { adapter } = f;
    const buyTsla = { sell: adapter.mock.cash, buy: 'solana:tsla', amountInRaw: '1000000' };
    await adapter.mock.send(
      await adapter.buildOwnerSwap({ vault: f.vault, trades: [buyTsla], slippageBps: 50 }),
    );
    // Inside the author limits: 10% out of NVDA and into TSLA.
    const withTsla = {
      ...f.publishRecipe,
      components: [
        { kind: 'asset' as const, asset: 'solana:spy', weightBps: 5000 },
        { kind: 'asset' as const, asset: 'solana:nvda', weightBps: 2000 },
        { kind: 'asset' as const, asset: 'solana:gold', weightBps: 2000 },
        { kind: 'asset' as const, asset: 'solana:tsla', weightBps: 1000 },
      ],
    };
    await adapter.mock.send(
      await adapter.buildPublishRecipe({ creator: f.owner, recipe: withTsla }),
    );
    adapter.mock.advance(300);
    expect((await adapter.getVault(f.vault))?.pending?.newAssets).toEqual(['solana:tsla']);
    expect(await code(adapter.buildAdoptVersion(f.vault))).toBe('NewAssetNeedsOwner');
  });
});
