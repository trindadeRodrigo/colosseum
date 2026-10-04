import {
  createSolanaVaultReader,
  getAccounts,
  type RawAccount,
  RECIPE_SIZE,
  type SolanaVaultReader,
  TOKEN_ACCOUNT_BYTES_BOUND,
  toBase58,
  unlistedAssetId,
  unlistedMint,
  VAULT_SIZE,
} from '@colosseum/chain-solana/vault';
import { ChainError, type ChainErrorCode, isStalePrice } from '@colosseum/schemas';
import { type Address, getAddressEncoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { readCases } from './reads';
import {
  accountOf,
  assetId,
  assetsOf,
  configOf,
  type FakeNode,
  fakeNode,
  fixtureNode,
  loadFixture,
  patched,
} from './world';

// The reader against a node in memory that serves the committed account bytes. No network.

const fixture = loadFixture();
const { names } = fixture;
const NOW = '2026-10-05T15:00:07.000Z';
const signature = (fill: number) => toBase58(new Uint8Array(64).fill(fill)) as string;
const UNKNOWN = signature(1);
const LANDED = signature(2);
const REVERTED = signature(3);

function statuses(node: FakeNode) {
  node.statuses.set(LANDED, { confirmationStatus: 'finalized', err: null });
  node.statuses.set(REVERTED, {
    confirmationStatus: 'confirmed',
    err: { InstructionError: [2, { Custom: 6026 }] },
  });
  node.logs.set(REVERTED, [
    `Program ${names.program} invoke [1]`,
    'Program log: Instruction: Deposit',
    'Program log: AnchorError thrown in programs/basket/src/instructions/deposit.rs:44. Error Code: NotCashMint. Error Number: 6026. Error Message: a vault takes deposits in the cash mint only.',
    `Program ${names.program} consumed 9000 of 200000 compute units`,
    `Program ${names.program} failed: custom program error: 0x178a`,
  ]);
}

function world(
  options: {
    network?: 'mainnet' | 'testnet' | 'local';
    edit?: (node: FakeNode) => void;
    assets?: ReturnType<typeof assetsOf>;
    priceAccount?: string | null;
  } = {},
): { node: FakeNode; reader: SolanaVaultReader } {
  const node = fixtureNode(fixture);
  statuses(node);
  options.edit?.(node);
  const config = configOf(fixture, options.network ?? 'testnet');
  if (options.priceAccount !== undefined) config.priceSource.address = options.priceAccount;
  const reader = createSolanaVaultReader({
    config,
    rpc: node.rpc,
    assets: options.assets ?? assetsOf(fixture),
    now: () => new Date(NOW),
  });
  return { node, reader };
}

async function refusal(work: Promise<unknown>, code: ChainErrorCode): Promise<ChainError> {
  const outcome = await work.then(
    () => 'answered' as const,
    (e: unknown) => e,
  );
  expect(outcome, `expected a refusal with ${code}`).toBeInstanceOf(ChainError);
  expect((outcome as ChainError).code).toBe(code);
  return outcome as ChainError;
}

readCases('the committed fixture, on a test network', async () => ({
  reader: world().reader,
  world: fixture,
  provenance: 'sandbox',
  notBefore: NOW,
  exactAges: true,
  explorer: true,
  unknownTxId: UNKNOWN,
  landedTxId: LANDED,
  revertedTx: { txId: REVERTED, code: 'NotCashMint' },
}));

readCases('the committed fixture, as a local copy with no explorer', async () => ({
  reader: world({ network: 'local' }).reader,
  world: fixture,
  provenance: 'sandbox',
  notBefore: NOW,
  exactAges: true,
  explorer: false,
  unknownTxId: UNKNOWN,
  landedTxId: LANDED,
  revertedTx: { txId: REVERTED, code: 'NotCashMint' },
}));

describe('Solana reader: what the config decides', () => {
  it('labels everything live on mainnet and sandbox anywhere else', async () => {
    const live = world({ network: 'mainnet' }).reader;
    expect(live.provenance).toBe('live');
    expect((await live.listAssets()).every((a) => a.provenance === 'live')).toBe(true);
    expect((await live.getPrices([assetId('spyx')]))[0]?.provenance).toBe('live');
    expect((await live.track(UNKNOWN)).explorerUrl).toBe(`https://solscan.io/tx/${UNKNOWN}`);
    expect(world({ network: 'local' }).reader.provenance).toBe('sandbox');
    expect((await world().reader.track(UNKNOWN)).explorerUrl).toContain('cluster=devnet');
  });

  it('is read-only with auto-follow off until it is told otherwise', () => {
    expect(world().reader.capabilities).toMatchObject({ trade: 'readonly', autoFollow: false });
    const config = configOf(fixture);
    const { rpc } = fixtureNode(fixture);
    const live = createSolanaVaultReader({
      config,
      rpc,
      assets: assetsOf(fixture),
      trade: 'live',
      autoFollow: true,
    });
    expect(live.capabilities).toMatchObject({ trade: 'live', autoFollow: true });
  });

  it('will not start on a config or an asset list that cannot be right', () => {
    const { rpc } = fixtureNode(fixture);
    const config = configOf(fixture);
    const assets = assetsOf(fixture);
    const make = (over: Partial<Parameters<typeof createSolanaVaultReader>[0]>) => () =>
      createSolanaVaultReader({ config, rpc, assets, ...over });
    expect(make({ config: { ...config, contracts: {} } })).toThrow(/program is not set/);
    expect(make({ config: { ...config, id: 'base' } })).toThrow(/config of base/);
    expect(
      make({ assets: assets.map((a) => ({ ...a, address: `0x${'ab'.repeat(20)}` })) }),
    ).toThrow();
    expect(
      make({ assets: assets.map((a) => ({ ...a, id: a.id.replace('solana:', 'base:') })) }),
    ).toThrow();
    expect(make({ assets: assets.filter((a) => a.cls !== 'cash') })).toThrow(/one cash token/);
    expect(make({ assets: [...assets, { ...assets[1], id: 'solana:twin' } as never] })).toThrow(
      /twice/,
    );
    expect(
      make({ assets: assets.map((a) => ({ ...a, priceRef: a.priceRef && 'mock:spy' })) }),
    ).toThrow(/Scope entry index/);
    expect(
      make({ assets: assets.map((a) => ({ ...a, priceKind: 'chainlink' as const })) }),
    ).toThrow(/Chainlink/);
  });

  it("reads the program's Config as it is now", async () => {
    const { reader } = world();
    expect(await reader.getConfig()).toMatchObject({
      cashMint: names.mints.usdc,
      priceOwner: names.priceOwner,
      routerProgram: names.router,
      defaultKeeper: names.keeper,
    });
  });
});

describe('Solana reader: a multiplier that is scheduled', () => {
  it('shows it on every holding of that mint, in a vault and in a wallet, and on no other', async () => {
    const { reader } = world();
    const want = fixture.expected.mints.nvdax.scheduled;
    if (!want) throw new Error('the fixture schedules no multiplier for nvdax');
    const scheduled = {
      multiplier: String(want.multiplier),
      effectiveAt: Number(want.effectiveAt),
    };
    // Later than the fixture's clock: it is not in force yet.
    expect(scheduled.effectiveAt).toBeGreaterThan(Number(fixture.clock.unixTimestamp));
    const vault = await reader.getVault(names.vaults.following);
    const nvdax = vault?.positions.find((p) => p.asset === assetId('nvdax'));
    expect(nvdax?.scheduled).toEqual(scheduled);
    // The one in force is still the mint's own.
    expect(nvdax?.multiplier).toBe(String(fixture.expected.mints.nvdax.multiplier));
    for (const p of vault?.positions ?? [])
      if (p.asset !== assetId('nvdax')) expect(p).not.toHaveProperty('scheduled');
    expect(vault?.cash).not.toHaveProperty('scheduled');
    for (const h of await reader.getWalletHoldings(names.owner))
      if (h.asset === assetId('nvdax')) expect(h.scheduled).toEqual(scheduled);
      else expect(h).not.toHaveProperty('scheduled');
  });

  it('shows nothing scheduled once its time has passed: it is the multiplier in force', async () => {
    const want = fixture.expected.mints.nvdax.scheduled;
    if (!want) throw new Error('the fixture schedules no multiplier for nvdax');
    const at = accountOf(fixture, 'clock');
    const clock = new Uint8Array(at.data);
    new DataView(clock.buffer).setBigInt64(32, BigInt(want.effectiveAt), true);
    const { reader } = world({
      edit: (node) => node.accounts.set(at.address, { ...at, data: clock }),
    });
    const vault = await reader.getVault(names.vaults.following);
    const nvdax = vault?.positions.find((p) => p.asset === assetId('nvdax'));
    expect(nvdax?.multiplier).toBe(String(want.multiplier));
    expect(nvdax).not.toHaveProperty('scheduled');
  });
});

describe('Solana reader: prices', () => {
  it('reads the price account and the clock in one call, and nothing at all for no priced asset', async () => {
    const { node, reader } = world();
    const prices = await reader.getPrices([assetId('spyx'), assetId('gold'), assetId('usdc')]);
    expect(node.calls).toEqual(['getMultipleAccounts']);
    expect(
      prices.map((p) => [p.asset, p.usdPerToken, p.ageSeconds, p.market, p.fetchedAt]),
    ).toEqual([
      [assetId('spyx'), '100', 30, 'open', NOW],
      // Older than the keeper accepts. It is reported with its age, not hidden and not refreshed.
      [assetId('gold'), '200.5', 400, 'open', NOW],
    ]);
    node.calls.length = 0;
    expect(await reader.getPrices([assetId('usdc')])).toEqual([]);
    expect(await reader.getPrices([])).toEqual([]);
    expect(node.calls).toEqual([]);
  });

  it("gives every price the age the program's Config allows, so a price says whether it is stale", async () => {
    const { reader } = world();
    const config = await reader.getConfig();
    const prices = await reader.getPrices([assetId('spyx'), assetId('gold')]);
    expect(prices.map((p) => p.maxAgeSeconds)).toEqual([config.maxPriceAgeS, config.maxPriceAgeS]);
    expect(config.maxPriceAgeS).toBe(120);
    // 30 seconds old is fresh; 400 is older than the keeper accepts, and the price says so itself.
    expect(prices.map((p) => [p.ageSeconds, isStalePrice(p)])).toEqual([
      [30, false],
      [400, true],
    ]);
  });

  it('prices the cash token only when the list gives it a source', async () => {
    const assets = assetsOf(fixture).map((a) =>
      a.cls === 'cash'
        ? { ...a, priceKind: 'scope' as const, priceRef: String(fixture.prices.entries.usdc.index) }
        : a,
    );
    const [cash] = await world({ assets }).reader.getPrices([assetId('usdc')]);
    expect(cash).toMatchObject({ asset: assetId('usdc'), usdPerToken: '1', ageSeconds: 20 });
  });

  it("says a stock token's market is closed outside the session the program keeps", async () => {
    // The Saturday after the entries were written: five days on from the fixture's own clock.
    const saturday = BigInt(fixture.clock.unixTimestamp) + 5n * 86_400n;
    expect(new Date(Number(saturday) * 1000).getUTCDay()).toBe(6);
    const clock = new Uint8Array(40);
    new DataView(clock.buffer).setBigInt64(32, saturday, true);
    const { reader } = world({
      edit: (node) => {
        const at = accountOf(fixture, 'clock');
        node.accounts.set(at.address, { ...at, data: clock });
      },
    });
    const prices = await reader.getPrices([assetId('spyx'), assetId('gold')]);
    expect(prices.map((p) => [p.asset, p.market])).toEqual([
      [assetId('spyx'), 'closed'],
      [assetId('gold'), 'open'],
    ]);
    // Five days on, the price is still handed over, with its age: the caller decides what is too old.
    expect(prices.map((p) => p.ageSeconds)).toEqual([5 * 86_400 + 30, 5 * 86_400 + 400]);
  });

  it('refuses a price stamped further ahead of the clock than Config allows a price to be old', async () => {
    const at = accountOf(fixture, 'clock');
    const config = await world().reader.getConfig();
    expect(config.maxPriceAgeS).toBe(120);
    const behind = (seconds: bigint) => {
      const clock = new Uint8Array(at.data);
      new DataView(clock.buffer).setBigInt64(
        32,
        BigInt(fixture.clock.unixTimestamp) - seconds,
        true,
      );
      return world({ edit: (node) => node.accounts.set(at.address, { ...at, data: clock }) })
        .reader;
    };
    const age = BigInt(fixture.prices.entries.spyx.ageSeconds);
    // Inside the bound it is skew between two clocks: fresh, and never a negative age.
    const [skewed] = await behind(age + 120n).getPrices([assetId('spyx')]);
    expect(skewed?.ageSeconds).toBe(0);
    const e = await refusal(behind(age + 121n).getPrices([assetId('spyx')]), 'AssetNotPriced');
    expect(e.message).toContain('ahead of the cluster');
    expect(e.message).toContain(assetId('spyx'));
  });

  it("checks the first bytes of the price account on every network: Scope's, and the test exchange's", async () => {
    const price = accountOf(fixture, 'price');
    const other = patched(price, [{ at: 0, bytes: new Uint8Array(8).fill(7) }]);
    const edit = (node: FakeNode) => node.accounts.set(price.address, other);
    for (const network of ['mainnet', 'testnet', 'local'] as const) {
      const e = await refusal(
        world({ network, edit }).reader.getPrices([assetId('spyx')]),
        'AssetNotPriced',
      );
      expect(e.message).toMatch(/discriminator/);
    }
    expect(await world({ network: 'mainnet' }).reader.getPrices([assetId('spyx')])).toHaveLength(1);
  });

  it("refuses a price account the program's Config does not vouch for", async () => {
    const price = accountOf(fixture, 'price');
    const cases: [string, (node: FakeNode) => void, RegExp][] = [
      [
        'another owner',
        (node) => node.accounts.set(price.address, { ...price, owner: names.program as Address }),
        /not by the price program/,
      ],
      ['no account', (node) => node.accounts.delete(price.address), /does not exist/],
      [
        'another size',
        (node) => node.accounts.set(price.address, { ...price, data: price.data.subarray(0, 400) }),
        /layout/,
      ],
    ];
    for (const [, edit, message] of cases) {
      const e = await refusal(
        world({ edit }).reader.getPrices([assetId('spyx')]),
        'AssetNotPriced',
      );
      expect(e.message).toMatch(message);
    }
    // The owner that counts is the one in Config: change it there and the same account is refused.
    const config = accountOf(fixture, 'config');
    const priceOwnerAt = 8 + 32 * 5;
    const moved = patched(config, [
      { at: priceOwnerAt, bytes: getAddressEncoder().encode(names.guardian as Address) },
    ]);
    await refusal(
      world({ edit: (node) => node.accounts.set(config.address, moved) }).reader.getPrices([
        assetId('spyx'),
      ]),
      'AssetNotPriced',
    );
  });

  it('refuses an entry nobody wrote, an asset that is not listed, and an id that is not one', async () => {
    const assets = assetsOf(fixture).map((a) =>
      a.id === assetId('tslax') ? { ...a, priceRef: String(fixture.prices.emptyIndex) } : a,
    );
    const { reader } = world({ assets });
    const e = await refusal(
      reader.getPrices([assetId('spyx'), assetId('tslax')]),
      'AssetNotPriced',
    );
    expect(e.message).toContain(`entry ${fixture.prices.emptyIndex}`);
    expect(e.message).toContain(assetId('tslax'));
    await refusal(reader.getPrices(['solana:msftx']), 'MintNotAccepted');
    await refusal(reader.getPrices(['SPYx']), 'BadInput');
  });

  it('refuses to price anything when the network has no price account set', async () => {
    const { node, reader } = world({ priceAccount: null });
    await refusal(reader.getPrices([assetId('spyx')]), 'AssetNotPriced');
    expect(node.calls).toEqual([]);
  });
});

describe('Solana reader: vaults', () => {
  it("finds an owner's vaults with one filtered query, and their balances in two batched calls", async () => {
    const { node, reader } = world();
    await reader.getVaults(names.owner);
    expect([...node.calls].sort()).toEqual([
      'getMultipleAccounts',
      'getMultipleAccounts',
      'getProgramAccounts',
    ]);
  });

  it('does not take a vault-shaped account of another program for a vault', async () => {
    const vault = accountOf(fixture, 'vault:following');
    const foreign = { ...vault, owner: names.router as Address };
    const { reader } = world({ edit: (node) => node.accounts.set(vault.address, foreign) });
    expect(await reader.getVault(vault.address)).toBeNull();
    // The same bytes under the vault program are a vault.
    expect((await world().reader.getVault(vault.address))?.address).toBe(vault.address);
    // And a Config the vault program does not own is no Config.
    const config = accountOf(fixture, 'config');
    const stolen = { ...config, owner: names.router as Address };
    await refusal(
      world({ edit: (node) => node.accounts.set(config.address, stolen) }).reader.getConfig(),
      'Unavailable',
    );
  });

  it('drops what a node hands back from the vault query under another owner', async () => {
    const manual = accountOf(fixture, 'vault:manual');
    const stray = { ...manual, address: names.stranger as Address, owner: names.router as Address };
    const { node, reader } = world({ edit: (n) => n.strays.push(stray) });
    const mine = await reader.getVaults(names.owner);
    expect(mine.map((v) => v.address)).not.toContain(stray.address);
    expect(mine).toHaveLength(3);
    // The stray has auto-follow off; one with it on is not listed for the keeper either.
    node.strays.push({
      ...accountOf(fixture, 'vault:following'),
      address: stray.address,
      owner: stray.owner,
    });
    expect(await reader.listAutoFollowVaults()).not.toContain(stray.address);
    expect(await reader.listAutoFollowVaults()).toHaveLength(2);
  });

  it('reports a frozen balance as held, and does not count frozen cash as cash to pay with', async () => {
    const frozen = (role: string) => patched(accountOf(fixture, role), [{ at: 108, bytes: [2] }]);
    const { reader } = world({
      edit: (node) => {
        // The owner's cash account, and the vault's SPYx.
        for (const held of ['owner/usdc', 'following/spyx']) {
          const account = frozen(`token:${held}`);
          node.accounts.set(account.address, account);
        }
      },
    });
    // The issuer froze them; they are still the holder's, and a vault's value still includes them.
    const { held } = fixture.expected.vaults.following;
    const vault = await reader.getVault(names.vaults.following);
    expect(vault?.positions.find((p) => p.asset === assetId('spyx'))?.raw).toBe(held.spyx);
    const wallet = await reader.getWalletHoldings(names.owner);
    expect(wallet.find((h) => h.asset === assetId('usdc'))?.raw).toBe(
      fixture.expected.wallets.owner.usdc,
    );
    // A frozen account cannot send: there is no cash to deposit until the issuer thaws it.
    const need = { cashRaw: '1', legs: 1, newVault: false };
    expect(await reader.funding(names.owner, need)).toMatchObject({ cashHaveRaw: '0', ok: false });
    expect(await world().reader.funding(names.owner, need)).toMatchObject({
      cashHaveRaw: fixture.expected.wallets.owner.usdc,
      ok: true,
    });
  });

  it('counts lamports sitting where a token account would be as no tokens', async () => {
    const { vault, mint, address } = fixture.strayLamports;
    const { node, reader } = world();
    expect(node.accounts.get(address)?.data.length).toBe(0);
    const state = await reader.getVault(names.vaults[vault]);
    expect(state?.positions.find((p) => p.asset === assetId(mint))?.raw).toBe('0');
  });

  it("counts a token account that is no longer the holder's as no tokens", async () => {
    const token = accountOf(fixture, 'token:owner/usdc');
    const handedOver = patched(token, [
      { at: 32, bytes: getAddressEncoder().encode(names.other as Address) },
    ]);
    const { reader } = world({ edit: (node) => node.accounts.set(token.address, handedOver) });
    const holdings = await reader.getWalletHoldings(names.owner);
    expect(holdings.map((h) => h.asset)).toEqual([assetId('spyx')]);
    expect((await reader.funding(names.owner, { cashRaw: '1', legs: 1, newVault: false })).ok).toBe(
      false,
    );
  });

  it('applies a new multiplier from the second it takes effect', async () => {
    const mint = accountOf(fixture, 'mint:spyx');
    // The extension's value follows its 4-byte header; the effective time and the new multiplier are
    // its last 16 bytes. Found by content, so the test does not repeat the decoder's offsets.
    const current = new Uint8Array(8);
    new DataView(current.buffer).setFloat64(0, 1.003909, true);
    const at = mint.data.findIndex((_, i) => current.every((b, j) => mint.data[i + j] === b));
    expect(at).toBeGreaterThan(165);
    const effective = new Uint8Array(8);
    const scheduled = new Uint8Array(8);
    const clock = BigInt(fixture.clock.unixTimestamp);
    new DataView(scheduled.buffer).setFloat64(0, 1.25, true);
    const read = async (effectiveAt: bigint) => {
      new DataView(effective.buffer).setBigInt64(0, effectiveAt, true);
      const edited = patched(mint, [
        { at: at + 8, bytes: effective },
        { at: at + 16, bytes: scheduled },
      ]);
      const { reader } = world({ edit: (node) => node.accounts.set(mint.address, edited) });
      const state = await reader.getVault(names.vaults.following);
      return state?.positions.find((p) => p.asset === assetId('spyx'));
    };
    expect(await read(clock + 1n)).toMatchObject({ multiplier: '1.003909', display: '2.3089907' });
    expect(await read(clock)).toMatchObject({ multiplier: '1.25', display: '2.875' });
  });

  it('finds the followers of a shared portfolio by the recipe at its frozen offset', async () => {
    const { reader } = world();
    expect(await reader.listAutoFollowVaults(names.recipes.core)).toEqual([names.vaults.following]);
    expect(await reader.listAutoFollowVaults(names.stranger)).toEqual([]);
    expect(await reader.listAutoFollowVaults()).toHaveLength(2);
  });

  describe('a vault that follows a shared portfolio', () => {
    // Where the waiting version sits in a Recipe account: after the discriminator, the creator, the
    // family id and the 453 bytes of the version in effect.
    const PENDING = 8 + 32 + 32 + 453;
    const recipe = accountOf(fixture, 'recipe:core');
    const clock = BigInt(fixture.clock.unixTimestamp);
    const i64 = (value: bigint) => {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigInt64(0, value, true);
      return bytes;
    };
    const u16 = (value: number) => new Uint8Array([value & 0xff, value >> 8]);
    /** The fixture with some bytes of the shared portfolio changed, read through the reader. */
    const read = async (edits: { at: number; bytes: ArrayLike<number> }[]) => {
      const edited = patched(recipe, edits);
      const { reader } = world({ edit: (node) => node.accounts.set(recipe.address, edited) });
      return {
        portfolio: await reader.getRecipe(names.recipes.core),
        vault: await reader.getVault(names.vaults.following),
      };
    };

    it('reads the recipe in the same call as the balances', async () => {
      const { node, reader } = world();
      const state = await reader.getVault(names.vaults.following);
      expect(state?.recipeOnchainId).toBe(names.recipes.core);
      expect(node.calls).toEqual(['getMultipleAccounts', 'getMultipleAccounts']);
    });

    it("a version whose time has come is the one in effect, with no transaction, by the cluster's clock", async () => {
      const waiting = await read([{ at: PENDING + 4, bytes: i64(clock + 1n) }]);
      expect([waiting.portfolio.active.version, waiting.portfolio.pending?.version]).toEqual([
        1, 2,
      ]);
      expect(waiting.vault?.pending).toEqual({
        version: 2,
        effectiveAt: Number(clock + 1n),
        newAssets: [assetId('tslax')],
      });

      const inEffect = await read([{ at: PENDING + 4, bytes: i64(clock) }]);
      expect([inEffect.portfolio.active.version, inEffect.portfolio.pending]).toEqual([2, null]);
      expect(inEffect.portfolio.active.components).toHaveLength(4);
      // The vault still holds the weights of version 1: version 2 is what it has not applied.
      expect(inEffect.vault?.acceptedVersion).toBe(1);
      expect(inEffect.vault?.pending).toEqual({
        version: 2,
        effectiveAt: Number(clock),
        newAssets: [assetId('tslax')],
      });
    });

    it('has nothing pending when no version waits and the vault took the one in effect', async () => {
      const none = await read([{ at: PENDING, bytes: [0, 0, 0, 0] }]);
      expect(none.portfolio.pending).toBeNull();
      expect(none.vault?.pending).toBeNull();
    });

    it('names no new asset for a version that only moves weights', async () => {
      // The waiting version cut to its first three lines, which the vault already has, adding up
      // to the whole again. Set by hand; the version the script published adds a fourth.
      const weightsOnly = await read([
        { at: PENDING + 44, bytes: [3] },
        { at: PENDING + 45 + 32, bytes: u16(5_000) },
      ]);
      expect(weightsOnly.portfolio.pending?.components).toHaveLength(3);
      expect(weightsOnly.vault?.pending).toMatchObject({ version: 2, newAssets: [] });
    });

    it('shows a mint the asset list does not have under its own id, and refuses nothing for it', async () => {
      // An author can put in a shared portfolio a token this app does not list. Every follower would
      // otherwise be refused for it: the vault reads, and the token shows under its mint.
      const withoutTsla = assetsOf(fixture).filter((a) => a.id !== assetId('tslax'));
      const { reader } = world({ assets: withoutTsla });
      const unlisted = unlistedAssetId(names.mints.tslax as Address);
      expect(unlistedMint(unlisted)).toBe(names.mints.tslax);
      const portfolio = await reader.getRecipe(names.recipes.core);
      expect(
        portfolio.pending?.components.map((c) => (c.kind === 'asset' ? c.asset : null)),
      ).toContain(unlisted);
      const following = await reader.getVault(names.vaults.following);
      expect(following?.pending?.newAssets).toEqual([unlisted]);
      expect((await reader.getVault(names.vaults.manual))?.pending).toBeNull();
      expect(await reader.getVaults(names.owner)).toHaveLength(3);
    });

    it('refuses a vault whose shared portfolio is not there, or is not one', async () => {
      const gone = world({ edit: (node) => node.accounts.delete(recipe.address) }).reader;
      const e = await refusal(gone.getVault(names.vaults.following), 'Unknown');
      expect(e.message).toContain(names.recipes.core);
      await refusal(gone.getVaults(names.owner), 'Unknown');
      await refusal(gone.getRecipe(names.recipes.core), 'RecipeNotFound');

      // The same bytes under another program are not a shared portfolio.
      const foreign = world({
        edit: (node) =>
          node.accounts.set(recipe.address, { ...recipe, owner: names.router as Address }),
      }).reader;
      await refusal(foreign.getRecipe(names.recipes.core), 'RecipeNotFound');
      await refusal(foreign.getVault(names.vaults.following), 'Unknown');
    });

    it('refuses a shared portfolio that carries a fee or flags, which the program never stores', async () => {
      const feeAt = RECIPE_SIZE - 32 - 1 - 1 - 2;
      for (const edit of [
        { at: feeAt, bytes: u16(1) },
        { at: feeAt + 2, bytes: [1] },
      ]) {
        const edited = patched(recipe, [edit]);
        const { reader } = world({ edit: (node) => node.accounts.set(recipe.address, edited) });
        await refusal(reader.getRecipe(names.recipes.core), 'Unknown');
      }
    });
  });

  it("reads the program's own asset list: the mints a vault may hold, and each one's entry", async () => {
    const { reader } = world();
    const list = await reader.getAssetList();
    expect(list.count).toBe(4);
    expect(list.assets.map((a) => [a.mint, a.decimals, a.maxWeightBps])).toEqual(
      (['spyx', 'nvdax', 'gold', 'tslax'] as const).map((name) => [
        names.mints[name],
        fixture.expected.mints[name].decimals,
        5_000,
      ]),
    );
    // Cash is never on it.
    expect(list.assets.map((a) => a.mint)).not.toContain(names.mints.usdc);
    const none = world({ edit: (node) => node.accounts.delete(names.assets) }).reader;
    expect((await refusal(none.getAssetList(), 'Unavailable')).retryable).toBe(false);
  });

  it("uses the vault's own keeper when it has one", async () => {
    const vault = accountOf(fixture, 'vault:manual');
    const keeperAt = 8 + 32 + 32 + 4 + 1 + 8 + 1;
    const own = patched(vault, [
      { at: keeperAt, bytes: getAddressEncoder().encode(names.guardian as Address) },
    ]);
    const { reader } = world({ edit: (node) => node.accounts.set(vault.address, own) });
    expect((await reader.getVault(vault.address))?.keeper).toBe(names.guardian);
  });

  it('reads a target on a mint that is not listed under its mint, and refuses one on the cash token', async () => {
    const withoutGold = assetsOf(fixture).filter((a) => a.id !== assetId('gold'));
    const { reader } = world({ assets: withoutGold });
    const manual = await reader.getVault(names.vaults.manual);
    const unlisted = unlistedAssetId(names.mints.gold as Address);
    // Its line, with the weight the vault holds it to, its balance and the decimals of its mint.
    expect(manual?.positions.find((p) => p.asset === unlisted)).toMatchObject({
      targetBps: 4_000,
      raw: '0',
      display: '0',
    });
    const following = await reader.getVault(names.vaults.following);
    expect(following?.positions.find((p) => p.asset === unlisted)).toMatchObject({
      raw: fixture.expected.vaults.following.held.gold,
      display: '1.25',
    });
    // The whole owner still reads.
    expect(await reader.getVaults(names.owner)).toHaveLength(3);
    expect((await reader.getVault(names.vaults.partial))?.positions).toHaveLength(2);

    const vault = accountOf(fixture, 'vault:others');
    const firstMintAt = 8 + 32 + 32 + 4 + 1 + 8 + 1 + 32 + 1;
    const onCash = patched(vault, [
      { at: firstMintAt, bytes: getAddressEncoder().encode(names.mints.usdc as Address) },
    ]);
    const cashTarget = world({ edit: (node) => node.accounts.set(vault.address, onCash) }).reader;
    // The program refuses the cash mint as a target, so a vault with one is not one it wrote.
    expect((await refusal(cashTarget.getVault(vault.address), 'Unknown')).message).toContain(
      'cash',
    );
  });
});

describe('Solana reader: a list that does not match the chain', () => {
  it("refuses when the listed cash token is not the program's cash mint", async () => {
    const assets = assetsOf(fixture).map((a) => {
      if (a.cls === 'cash') return { ...a, cls: 'gold' as const };
      return a.id === assetId('gold')
        ? { ...a, cls: 'cash' as const, priceKind: 'none' as const, priceRef: '' }
        : a;
    });
    const e = await refusal(world({ assets }).reader.getVaults(names.owner), 'Unknown');
    expect(e.message).toMatch(/cash mint in the program's Config/);
  });

  it("refuses listed decimals that are not the mint's, and a listed mint that does not exist", async () => {
    const wrong = assetsOf(fixture).map((a) =>
      a.id === assetId('spyx') ? { ...a, decimals: 6 } : a,
    );
    const e = await refusal(
      world({ assets: wrong }).reader.getWalletHoldings(names.owner),
      'Unknown',
    );
    expect(e.message).toMatch(/6 decimals; its mint has 8/);
    const missing = world({ edit: (node) => node.accounts.delete(names.mints.tslax) }).reader;
    expect((await refusal(missing.getVault(names.vaults.manual), 'Unknown')).message).toMatch(
      /no mint at its address/,
    );
  });

  it('says so when the program is not there', async () => {
    const { reader } = world({ edit: (node) => node.accounts.delete(names.config) });
    const e = await refusal(reader.getVaults(names.owner), 'Unavailable');
    expect(e.message).toMatch(/no Config on devnet/);
    // Asking again does not deploy a program.
    expect(e.retryable).toBe(false);
    await refusal(reader.getPrices([assetId('spyx')]), 'Unavailable');
  });
});

describe('Solana reader: gas', () => {
  it("needs a fee and one token account's rent for each transaction, a new vault's rent, and the wallet's own floor", async () => {
    const { reader } = world();
    const rent = (bytes: number) => BigInt(bytes + 128) * 6_960n;
    const need = { cashRaw: '0', legs: 3, newVault: true };
    const funding = await reader.funding(names.owner, need);
    expect(BigInt(funding.gasNeedRaw)).toBe(
      rent(0) + 3n * 5_000n + rent(VAULT_SIZE) + 3n * rent(TOKEN_ACCOUNT_BYTES_BOUND),
    );
    // An existing vault may open a position's account in each trade too: the same per transaction,
    // without the vault's own rent.
    const existing = await reader.funding(names.owner, { ...need, newVault: false });
    expect(BigInt(existing.gasNeedRaw)).toBe(
      rent(0) + 3n * 5_000n + 3n * rent(TOKEN_ACCOUNT_BYTES_BOUND),
    );
    // A wallet with its floor and the fee alone cannot pay for a trade that opens an account.
    const bare = world({
      edit: (node) => {
        const wallet = accountOf(fixture, 'wallet:owner');
        node.accounts.set(wallet.address, { ...wallet, lamports: rent(0) + 5_000n });
      },
    }).reader;
    expect((await bare.funding(names.owner, { cashRaw: '1', legs: 1, newVault: false })).ok).toBe(
      false,
    );
    expect(funding.gasHaveRaw).toBe(accountOf(fixture, 'wallet:owner').lamports.toString());
    // Nothing to send needs nothing, even from a wallet that does not exist. A new vault is one
    // transaction at the least.
    const nothing = { cashRaw: '0', legs: 0, newVault: false };
    expect(await reader.funding(names.stranger, nothing)).toMatchObject({
      gasNeedRaw: '0',
      ok: true,
    });
    expect(
      BigInt((await reader.funding(names.owner, { ...nothing, newVault: true })).gasNeedRaw),
    ).toBe(rent(0) + 5_000n + rent(VAULT_SIZE) + rent(TOKEN_ACCOUNT_BYTES_BOUND));
    // The bound covers the largest token account in the fixture: a stock token's, under Token-2022.
    const largest = Math.max(
      ...fixture.accounts
        .filter((a) => a.role.startsWith('token:'))
        .map((a) => accountOf(fixture, a.role).data.length),
    );
    expect(largest).toBe(179);
    expect(TOKEN_ACCOUNT_BYTES_BOUND).toBeGreaterThanOrEqual(largest);
  });

  it('charges rent for as many token accounts as the caller says the steps open, where it says', async () => {
    const { reader } = world();
    const rent = (bytes: number) => BigInt(bytes + 128) * 6_960n;
    const need = { cashRaw: '0', legs: 3, newVault: true };
    const gas = async (newAccounts?: number) =>
      BigInt(
        (
          await reader.funding(names.owner, {
            ...need,
            ...(newAccounts === undefined ? {} : { newAccounts }),
          })
        ).gasNeedRaw,
      );
    const base = rent(0) + 3n * 5_000n + rent(VAULT_SIZE);
    // Left out, every step is taken to open one: the bound of before.
    expect(await gas()).toBe(base + 3n * rent(TOKEN_ACCOUNT_BYTES_BOUND));
    // The vault's cash account and one new position: two accounts, whatever the number of steps.
    expect(await gas(2)).toBe(base + 2n * rent(TOKEN_ACCOUNT_BYTES_BOUND));
    // A deposit into positions that all exist opens none.
    expect(await gas(0)).toBe(base);
    expect(await gas(5)).toBe(base + 5n * rent(TOKEN_ACCOUNT_BYTES_BOUND));
    await refusal(reader.funding(names.owner, { ...need, newAccounts: -1 }), 'BadInput');
    // Nothing to send needs nothing, however many accounts are named.
    const nothing = { cashRaw: '0', legs: 0, newVault: false, newAccounts: 4 };
    expect((await reader.funding(names.owner, nothing)).gasNeedRaw).toBe('0');
  });

  it('asks for the rent figures once', async () => {
    const { node, reader } = world();
    const need = { cashRaw: '0', legs: 1, newVault: true };
    await reader.funding(names.owner, need);
    await reader.funding(names.other, need);
    expect(node.calls.filter((c) => c === 'getMinimumBalanceForRentExemption')).toHaveLength(3);
  });
});

describe('Solana reader: transaction status', () => {
  const custom = (code: number) => ({ InstructionError: [0, { Custom: code }] });

  it('waits for a confirmed block before it calls anything landed or failed', async () => {
    const [seen, failing] = [signature(4), signature(5)];
    const { reader } = world({
      edit: (node) => {
        node.statuses.set(seen, { confirmationStatus: 'processed', err: null });
        node.statuses.set(failing, { confirmationStatus: 'processed', err: custom(6026) });
      },
    });
    // Seen by the node, so it is not expired whatever the block height.
    expect((await reader.track(seen, '0')).status).toBe('pending');
    expect(await reader.track(failing)).toMatchObject({ status: 'pending' });
  });

  it('reads the block height at finalized, whatever the reader is set to', async () => {
    const lost = signature(12);
    for (const commitment of ['processed', 'confirmed', 'finalized'] as const) {
      const node = fixtureNode(fixture);
      // A fork that is ahead and not finalized: past the last valid block. The finalized chain is not.
      node.heights = { processed: 1_000n, confirmed: 900n, finalized: 4n };
      const reader = createSolanaVaultReader({
        config: configOf(fixture),
        rpc: node.rpc,
        assets: assetsOf(fixture),
        commitment,
      });
      // The fork can be dropped and the transaction still land at height 5: it is not expired yet.
      expect((await reader.track(lost, '5')).status).toBe('pending');
      expect(node.heightsAsked).toEqual(['finalized']);
      node.heights.finalized = 6n;
      expect((await reader.track(lost, '5')).status).toBe('expired');
    }
  });

  it('answers with a number when the logs are not there yet, and with the name once they are', async () => {
    const failed = signature(13);
    const { node, reader } = world({
      edit: (n) =>
        n.statuses.set(failed, {
          confirmationStatus: 'confirmed',
          err: { InstructionError: [0, { Custom: 6026 }] },
        }),
    });
    expect((await reader.track(failed)).error?.code).toBe('Custom:6026');
    node.logs.set(failed, [`Program ${names.program} failed: custom program error: 0x178a`]);
    expect((await reader.track(failed)).error?.code).toBe('NotCashMint');
  });

  it('does not call a transaction expired when it landed while the block height was being read', async () => {
    const late = signature(10);
    const { node, reader } = world();
    node.before = (method) => {
      if (method === 'getBlockHeight')
        node.statuses.set(late, { confirmationStatus: 'confirmed', err: null });
    };
    // Unknown at the first question, past its last block at the second, landed by the third.
    expect((await reader.track(late, '5')).status).toBe('confirmed');
    expect(node.calls).toEqual(['getSignatureStatuses', 'getBlockHeight', 'getSignatureStatuses']);
    // One that really never landed is expired, after the same three questions.
    node.calls.length = 0;
    expect((await reader.track(signature(11), '5')).status).toBe('expired');
    expect(node.calls).toHaveLength(3);
    // Still inside its window: pending, and no third question.
    node.calls.length = 0;
    expect((await reader.track(signature(11), '1000')).status).toBe('pending');
    expect(node.calls).toEqual(['getSignatureStatuses', 'getBlockHeight']);
  });

  it("names a custom error as the vault's own only when the vault program raised it", async () => {
    const [router, noLogs, token, runtime] = [6, 7, 8, 9].map(signature) as [
      string,
      string,
      string,
      string,
    ];
    const { reader } = world({
      edit: (node) => {
        // The test exchange numbers its errors from 6000 as well.
        node.statuses.set(router, { confirmationStatus: 'confirmed', err: custom(6002) });
        node.logs.set(router, [
          `Program ${names.program} invoke [1]`,
          `Program ${names.router} invoke [2]`,
          `Program ${names.router} failed: custom program error: 0x1772`,
          `Program ${names.program} failed: custom program error: 0x1772`,
        ]);
        node.statuses.set(noLogs, { confirmationStatus: 'confirmed', err: custom(6026) });
        node.statuses.set(token, { confirmationStatus: 'finalized', err: custom(1) });
        node.logs.set(token, [
          'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]',
          'Program log: Error: insufficient funds',
          'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1',
        ]);
        node.statuses.set(runtime, {
          confirmationStatus: 'confirmed',
          err: { InsufficientFundsForRent: { account_index: 0 } },
        });
      },
    });
    // The vault logs the same failure after the exchange it called. The exchange raised it: not ReceivedTooLittle.
    expect((await reader.track(router)).error).toEqual({
      code: 'Custom:6002',
      message: `program ${names.router}: custom program error: 0x1772`,
    });
    expect((await reader.track(noLogs)).error).toEqual({
      code: 'Custom:6026',
      message: 'a program failed with 6026',
    });
    expect((await reader.track(token)).error).toEqual({
      code: 'Custom:1',
      message: 'program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: custom program error: 0x1',
    });
    expect((await reader.track(runtime)).error?.code).toBe('InsufficientFundsForRent');
    expect(await reader.track(REVERTED)).toMatchObject({
      status: 'reverted',
      error: {
        code: 'NotCashMint',
        message: 'NotCashMint: a vault takes deposits in the cash mint only',
      },
    });
  });
});

describe('Solana reader: the node', () => {
  it('reports a node that does not answer as Unavailable, and never repeats what the transport said', async () => {
    for (const [method, work] of [
      ['getMultipleAccounts', (r: SolanaVaultReader) => r.getVault(names.vaults.manual)],
      ['getProgramAccounts', (r: SolanaVaultReader) => r.getVaults(names.owner)],
      ['getProgramAccounts', (r: SolanaVaultReader) => r.listAutoFollowVaults()],
      [
        'getBalance',
        (r: SolanaVaultReader) => r.funding(names.owner, { cashRaw: '1', legs: 1, newVault: true }),
      ],
      ['getSignatureStatuses', (r: SolanaVaultReader) => r.track(UNKNOWN)],
      ['getBlockHeight', (r: SolanaVaultReader) => r.track(UNKNOWN, '5')],
      ['getTransaction', (r: SolanaVaultReader) => r.track(REVERTED)],
    ] as const) {
      const { reader } = world({ edit: (node) => node.down.add(method) });
      const e = await refusal(work(reader), 'Unavailable');
      expect(e.retryable).toBe(true);
      expect(e.message).toContain(method);
      expect(JSON.stringify(e)).not.toMatch(/SECRET|rpc\.example/);
    }
  });

  it('asks for a rent figure again after a failed call', async () => {
    const { node, reader } = world();
    const need = { cashRaw: '0', legs: 1, newVault: true };
    node.down.add('getMinimumBalanceForRentExemption');
    await refusal(reader.funding(names.owner, need), 'Unavailable');
    node.down.clear();
    expect((await reader.funding(names.owner, need)).ok).toBe(true);
  });

  it('asks for accounts a hundred at a time, and keeps their order', async () => {
    const accounts: RawAccount[] = Array.from({ length: 250 }, (_, i) => ({
      address: toBase58(new Uint8Array(32).fill(1).fill(i, 31)) as string as Address,
      owner: names.program as Address,
      lamports: BigInt(i),
      data: new Uint8Array([i]),
    }));
    const node = fakeNode(accounts.filter((_, i) => i % 7 !== 0));
    const found = await getAccounts(
      node.rpc,
      accounts.map((a) => a.address),
      'confirmed',
    );
    expect(node.calls).toHaveLength(3);
    expect(found.map((a) => a?.lamports ?? null)).toEqual(
      accounts.map((a, i) => (i % 7 === 0 ? null : a.lamports)),
    );
    expect(found[249]?.data).toEqual(new Uint8Array([249]));
  });
});

const u64 = (value: bigint) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return bytes;
};
const CLOCK = BigInt(fixture.clock.unixTimestamp);
/** In a vault: positions start at byte 119 and are 50 bytes each; then the loss counter and its time. */
const TRACKED_AT = (position: number) => 119 + 50 * position + 34;
const LAST_KEEPER_AT = (position: number) => 119 + 50 * position + 42;
const LOSS_ACCUM_AT = VAULT_SIZE - 128 - 8 - 8;
const LOSS_TS_AT = LOSS_ACCUM_AT + 8;

describe('Solana reader: the weekly loss counter', () => {
  const vault = accountOf(fixture, 'vault:following');
  // 1,000 dollars of cash, 2.3 SPYx at 100 dollars and 1.25 gold at 200.5: 1,480.625 dollars.
  const VALUE = 1_480_625_000n;
  const WEEK = 604_800n;
  const lost = (amount: bigint, ago: bigint, edit?: (node: FakeNode) => void) => {
    const account = patched(vault, [
      { at: LOSS_ACCUM_AT, bytes: u64(amount) },
      { at: LOSS_TS_AT, bytes: u64(CLOCK - ago) },
    ]);
    return world({
      edit: (node) => {
        node.accounts.set(vault.address, account);
        edit?.(node);
      },
    });
  };
  const used = async (amount: bigint, ago: bigint, edit?: (node: FakeNode) => void) =>
    (await lost(amount, ago, edit).reader.getVault(vault.address))?.lossUsedBps;

  it('is nothing for a vault that never lost', async () => {
    expect((await world().reader.getVault(vault.address))?.lossUsedBps).toBe(0);
  });

  it('is what is left of the counter, as a share of what the vault holds now', async () => {
    expect(await used(VALUE / 100n, 0n)).toBe(100);
    expect(await used(VALUE / 50n, 0n)).toBe(200);
  });

  it('falls in a straight line to nothing over seven days', async () => {
    expect(await used(VALUE / 100n, WEEK / 2n)).toBe(50);
    expect(await used(VALUE / 100n, WEEK - 1n)).toBe(0);
    expect(await used(VALUE / 100n, WEEK)).toBe(0);
    expect(await used(VALUE / 100n, 2n * WEEK)).toBe(0);
  });

  it('reads no more accounts for it than the vault takes anyway', async () => {
    const plain = world();
    await plain.reader.getVault(vault.address);
    const counting = lost(VALUE / 100n, 0n);
    await counting.reader.getVault(vault.address);
    expect(counting.node.calls).toEqual(plain.node.calls);
  });

  it('counts a position whose price cannot be read for nothing: the share only gets larger', async () => {
    // Without the price account the vault is its 1,000 dollars of cash.
    const price = fixture.prices.account;
    expect(await used(VALUE / 100n, 0n, (node) => node.accounts.delete(price))).toBe(148);
  });

  it('never reports more than the whole', async () => {
    expect(await used(VALUE * 3n, 0n)).toBe(10_000);
  });

  it('shows on every read of the vault, by its owner too', async () => {
    const { reader } = lost(VALUE / 100n, 0n);
    const states = await reader.getVaults(names.owner);
    expect(states.map((s) => s.lossUsedBps)).toEqual([100, 0, 0]);
  });
});

describe('Solana reader: what a keeper needs to plan a leg', () => {
  const following = accountOf(fixture, 'vault:following');
  const config = accountOf(fixture, 'config');
  const clock = accountOf(fixture, 'clock');
  const context = async (
    vault: string = names.vaults.following,
    edit?: (node: FakeNode) => void,
  ) => {
    const { reader, node } = world({ edit });
    const found = await reader.getKeeperContext(vault);
    if (!found) throw new Error('no vault');
    return { ...found, calls: node.calls };
  };

  it('gives the rules, the price account and each position as a leg would find it, in two calls', async () => {
    const found = await context();
    expect(found.calls).toEqual(['getMultipleAccounts', 'getMultipleAccounts']);
    expect(found.vault).toEqual(await world().reader.getVault(names.vaults.following));
    expect(found.rules).toEqual({
      paused: false,
      toleranceBps: 75,
      lossCapBps: 100,
      bandBps: 50,
      twapDevBps: 200,
      maxPriceAgeSeconds: 120,
      maxTwapAgeSeconds: 3_600,
      cooldownSeconds: 3_600,
    });
    expect(found.priceAccount).toBe(fixture.prices.account);
    expect(found.blocked).toBeNull();
    expect(found.positions).toEqual([
      {
        asset: assetId('spyx'),
        mint: names.mints.spyx,
        targetBps: 5_000,
        // More arrived after the program last looked.
        raw: '230000000',
        trackedRaw: '200000000',
        needsSync: true,
        keeperOn: true,
        price: { usdPerToken: '100', ageSeconds: 30 },
        twap: { usdPerToken: '100', ageSeconds: 30 },
        reference: null,
        trade: null,
        cooldownUntil: null,
      },
      {
        asset: assetId('nvdax'),
        mint: names.mints.nvdax,
        targetBps: 3_000,
        raw: '0',
        trackedRaw: '0',
        needsSync: false,
        keeperOn: true,
        price: { usdPerToken: '50', ageSeconds: 45 },
        twap: { usdPerToken: '50', ageSeconds: 45 },
        reference: null,
        // Its multiplier changes in 2100: no window is near.
        trade: null,
        cooldownUntil: null,
      },
      {
        asset: assetId('gold'),
        mint: names.mints.gold,
        targetBps: 2_000,
        raw: '125000000',
        trackedRaw: '0',
        needsSync: true,
        keeperOn: true,
        // 400 s old, where the program takes 120: the price is shown and the asset is refused.
        price: { usdPerToken: '200.5', ageSeconds: 400 },
        twap: null,
        reference: 'PriceStale',
        trade: null,
        cooldownUntil: null,
      },
    ]);
  });

  it('says an asset the admin has not switched on cannot be valued', async () => {
    const found = await context(names.vaults.partial);
    expect(found.positions.map((p) => [p.asset, p.keeperOn, p.reference])).toEqual([
      [assetId('spyx'), true, null],
      [assetId('tslax'), false, 'KeeperAssetOff'],
    ]);
    // The vault holds none of it, so a leg in SPYx is not stopped.
    expect(found.blocked).toBeNull();
  });

  it('names what stops every leg: auto-follow off, the pause, a held asset that cannot be valued', async () => {
    expect((await context(names.vaults.manual)).blocked).toBe('AutoFollowOff');
    // Config's `keeper_paused` is the byte after its seven addresses.
    const paused = patched(config, [{ at: 8 + 32 * 7, bytes: [1] }]);
    const whilePaused = await context(names.vaults.following, (node) =>
      node.accounts.set(config.address, paused),
    );
    expect([whilePaused.blocked, whilePaused.rules.paused]).toEqual(['KeeperPaused', true]);
    // Once the program has recorded the gold the vault holds, its stale price stops every leg.
    const recorded = patched(following, [{ at: TRACKED_AT(2), bytes: u64(125_000_000n) }]);
    const withGold = await context(names.vaults.following, (node) =>
      node.accounts.set(following.address, recorded),
    );
    expect(withGold.blocked).toBe('PriceStale');
    expect(withGold.positions[2]?.needsSync).toBe(false);
  });

  it('says when the cooldown of an asset ends', async () => {
    const traded = patched(following, [{ at: LAST_KEEPER_AT(0), bytes: u64(CLOCK - 100n) }]);
    const found = await context(names.vaults.following, (node) =>
      node.accounts.set(following.address, traded),
    );
    expect([found.positions[0]?.trade, found.positions[0]?.cooldownUntil]).toEqual([
      'Cooldown',
      Number(CLOCK) - 100 + 3_600,
    ]);
    const longAgo = patched(following, [{ at: LAST_KEEPER_AT(0), bytes: u64(CLOCK - 3_600n) }]);
    const later = await context(names.vaults.following, (node) =>
      node.accounts.set(following.address, longAgo),
    );
    expect(later.positions[0]?.trade).toBeNull();
  });

  it('says a stock cannot be traded on a Saturday, and an asset with no session can', async () => {
    const saturday = new Uint8Array(clock.data);
    new DataView(saturday.buffer).setBigInt64(32, CLOCK + 5n * 86_400n, true);
    const found = await context(names.vaults.following, (node) =>
      node.accounts.set(clock.address, { ...clock, data: saturday }),
    );
    expect(found.positions.map((p) => p.trade)).toEqual(['MarketClosed', 'MarketClosed', null]);
    // Five days on, every price is stale too.
    expect(found.positions.map((p) => p.reference)).toEqual([
      'PriceStale',
      'PriceStale',
      'PriceStale',
    ]);
  });

  it('gives no one price account when the asset list names none', async () => {
    const assets = accountOf(fixture, 'assets');
    const unnamed = patched(assets, [{ at: 8, bytes: new Uint8Array(32) }]);
    const found = await context(names.vaults.following, (node) =>
      node.accounts.set(assets.address, unnamed),
    );
    expect(found.priceAccount).toBeNull();
    expect(found.positions.map((p) => p.reference)).toEqual([
      'AssetNotPriced',
      'AssetNotPriced',
      'AssetNotPriced',
    ]);
  });

  it('is null for an address with no vault', async () => {
    expect(await world().reader.getKeeperContext(names.stranger)).toBeNull();
    await refusal(world().reader.getKeeperContext('not an address'), 'BadInput');
  });
});
