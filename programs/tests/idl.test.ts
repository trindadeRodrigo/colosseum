import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountRole,
  generateKeyPairSigner,
  type Instruction,
  isSignerRole,
  isWritableRole,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  acceptAdminInstruction,
  acceptVersionInstruction,
  addClosedDayInstruction,
  adoptVersionInstruction,
  cancelPendingInstruction,
  createVaultInstruction,
  DEFAULT_PARAMS,
  depositInstruction,
  extendClosedUntilInstruction,
  FROZEN_ERRORS,
  familyId,
  initAssetsInstruction,
  initConfigInstruction,
  keeperLegInstruction,
  launchInstruction,
  ownerSwapInstruction,
  pauseKeeperInstruction,
  proposeAdminInstruction,
  publishRecipeInstruction,
  setAutoFollowInstruction,
  setCashMintInstruction,
  setClosedDayInstruction,
  setClosedUntilInstruction,
  setDefaultKeeperInstruction,
  setGuardianInstruction,
  setParamsInstruction,
  setPriceAccountInstruction,
  setPriceOwnerInstruction,
  setRouterInstruction,
  setTargetsInstruction,
  syncBalancesInstruction,
  unpauseKeeperInstruction,
  updateRecipeInstruction,
  upsertAssetInstruction,
  vaultAddress,
  withdrawInstruction,
} from './src/basket';
import { BASKET_PROGRAM, MOCK_ROUTER_PROGRAM, REPO_ROOT, SYSTEM_PROGRAM } from './src/env';
import {
  initPairInstruction,
  initPricedPairInstruction,
  initPricesInstruction,
  initRouterInstruction,
  routeInstruction,
  setPricedPairInstruction,
  setPriceInstruction,
  setPriceWriterInstruction,
  writePriceInstruction,
} from './src/mock-router';
import { type TestMint, TOKEN_PROGRAM } from './src/tokens';

type IdlAccount = { name: string; writable?: boolean; signer?: boolean; address?: string };
type Idl = {
  address: string;
  instructions: { name: string; discriminator: number[]; accounts: IdlAccount[] }[];
  errors: { code: number; name: string }[];
  types: {
    name: string;
    repr?: { kind: string; packed?: boolean };
    type: { fields: { name: string }[] };
  }[];
};

const readIdl = (name: string): Idl =>
  JSON.parse(readFileSync(join(REPO_ROOT, 'idl', `${name}.json`), 'utf8'));

/** The instruction, as the tests build it, against what the committed IDL says it is. */
function expectMatchesIdl(idl: Idl, name: string, instruction: Instruction): void {
  const spec = idl.instructions.find((i) => i.name === name);
  if (!spec) throw new Error(`the IDL has no instruction ${name}`);
  expect(instruction.programAddress).toBe(idl.address);
  expect([...(instruction.data ?? []).slice(0, 8)]).toEqual(spec.discriminator);

  const accounts = instruction.accounts ?? [];
  expect(accounts.length).toBe(spec.accounts.length);
  spec.accounts.forEach((expected, i) => {
    const role = accounts[i]?.role ?? AccountRole.READONLY;
    expect([expected.name, isWritableRole(role)]).toEqual([expected.name, !!expected.writable]);
    expect([expected.name, isSignerRole(role)]).toEqual([expected.name, !!expected.signer]);
    if (expected.address) expect(accounts[i]?.address).toBe(expected.address);
  });
}

const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// The committed IDL is what other code builds against. Regenerate it when the program
// changes (programs/README.md); these tests fail until it is.
describe('the committed IDL', () => {
  const basket = readIdl('basket');
  const mockRouter = readIdl('mock_router');

  it('carries the program ids of Anchor.toml', () => {
    expect(basket.address).toBe(BASKET_PROGRAM);
    expect(mockRouter.address).toBe(MOCK_ROUTER_PROGRAM);
  });

  it('describes every vault instruction the way the tests build it', async () => {
    const signer = await generateKeyPairSigner();
    const other = (await generateKeyPairSigner()).address;
    const mint: TestMint = { address: other, program: TOKEN_PROGRAM, decimals: 6, issuer: signer };
    const vault = await vaultAddress(signer.address, 1n);
    const built: Record<string, Instruction> = {
      init_config: await initConfigInstruction(signer, {
        guardian: other,
        defaultKeeper: other,
        routerProgram: other,
        priceOwner: other,
        cashMint: other,
        params: DEFAULT_PARAMS,
      }),
      set_router: await setRouterInstruction(signer, other),
      set_price_owner: await setPriceOwnerInstruction(signer, other),
      set_cash_mint: await setCashMintInstruction(signer, other),
      set_params: await setParamsInstruction(signer, DEFAULT_PARAMS),
      launch: await launchInstruction(signer),
      propose_admin: await proposeAdminInstruction(signer, other),
      accept_admin: await acceptAdminInstruction(signer),
      pause_keeper: await pauseKeeperInstruction(signer),
      unpause_keeper: await unpauseKeeperInstruction(signer),
      init_assets: await initAssetsInstruction(signer),
      upsert_asset: await upsertAssetInstruction(signer, other),
      publish_recipe: await publishRecipeInstruction({
        creator: signer,
        familyId: familyId('one'),
        components: [],
      }),
      update_recipe: await updateRecipeInstruction({
        creator: signer,
        recipe: other,
        components: [],
      }),
      cancel_pending: await cancelPendingInstruction({ signer, recipe: other }),
      create_vault: await createVaultInstruction({ owner: signer, basketId: 1n }),
      set_targets: await setTargetsInstruction({ owner: signer, vault, targets: [] }),
      deposit: await depositInstruction({ owner: signer, vault, mint, amount: 1n }),
      owner_swap: await ownerSwapInstruction({
        owner: signer,
        vault,
        inputMint: mint,
        outputMint: { ...mint, address: vault },
        maxIn: 1n,
        minOut: 1n,
        router: other,
        data: new Uint8Array(8),
        routerAccounts: [],
      }),
      withdraw: await withdrawInstruction({ owner: signer, vault, mint, amount: 1n }),
      set_guardian: await setGuardianInstruction(signer, other),
      set_default_keeper: await setDefaultKeeperInstruction(signer, other),
      set_closed_until: await setClosedUntilInstruction(signer, 1n),
      set_closed_day: await setClosedDayInstruction(signer, 1, true),
      extend_closed_until: await extendClosedUntilInstruction(signer, 1n),
      add_closed_day: await addClosedDayInstruction(signer, 1),
      set_price_account: await setPriceAccountInstruction(signer, 0, other),
      accept_version: await acceptVersionInstruction({
        owner: signer,
        vault,
        recipe: other,
        expectedVersion: 1,
      }),
      set_auto_follow: await setAutoFollowInstruction({ owner: signer, vault, on: true }),
      adopt_version: await adoptVersionInstruction({ vault, recipe: other }),
      sync_balances: await syncBalancesInstruction({ signer, vault, tokenAccounts: [] }),
      keeper_leg: await keeperLegInstruction({
        keeper: signer,
        vault,
        inputMint: mint,
        outputMint: { ...mint, address: vault },
        amountIn: 1n,
        router: other,
        data: new Uint8Array(8),
        routerAccounts: [],
        priceAccount: other,
      }),
    };
    expect(Object.keys(built).sort()).toEqual(basket.instructions.map((i) => i.name).sort());
    for (const [name, instruction] of Object.entries(built)) {
      expectMatchesIdl(basket, name, instruction);
    }
  });

  it('describes every test-exchange instruction the way the tests build it', async () => {
    const signer = await generateKeyPairSigner();
    const mintIn: TestMint = {
      address: SYSTEM_PROGRAM,
      program: TOKEN_PROGRAM,
      decimals: 6,
      issuer: signer,
    };
    const mintOut: TestMint = { ...mintIn, address: signer.address };
    const built: Record<string, Instruction> = {
      init_router: await initRouterInstruction(signer),
      init_prices: await initPricesInstruction(signer, signer.address),
      set_price_writer: await setPriceWriterInstruction(signer, signer.address),
      write_price: await writePriceInstruction(signer, signer.address, {
        priceIndex: 1,
        twapIndex: 2,
        price: { value: 1n, unixTimestamp: 1n },
        twap: { value: 1n, unixTimestamp: 1n },
      }),
      init_pair: await initPairInstruction(signer, mintIn.address, mintOut.address, 1n, 1n),
      set_price: await setPriceInstruction(signer, mintIn.address, mintOut.address, 1n, 1n),
      init_priced_pair: await initPricedPairInstruction(signer, mintIn.address, mintOut.address, {
        assetIsInput: false,
        priceIndex: 1,
        spreadBps: 0,
      }),
      set_priced_pair: await setPricedPairInstruction(signer, mintIn.address, mintOut.address, {
        assetIsInput: false,
        priceIndex: 1,
        spreadBps: 0,
      }),
      route_v2: await routeInstruction({
        trader: signer,
        mintIn,
        mintOut,
        traderIn: signer.address,
        destination: signer.address,
        amountIn: 1n,
        minOut: 0n,
      }),
    };
    expect(Object.keys(built).sort()).toEqual(mockRouter.instructions.map((i) => i.name).sort());
    for (const [name, instruction] of Object.entries(built)) {
      expectMatchesIdl(mockRouter, name, instruction);
    }
  });

  it('numbers the errors in the frozen order', () => {
    const names = basket.errors.map((e) => e.name);
    expect(names.slice(0, FROZEN_ERRORS.length)).toEqual([...FROZEN_ERRORS]);
    expect(basket.errors.map((e) => e.code)).toEqual(names.map((_, i) => 6000 + i));
  });

  it('lays the asset list and a shared portfolio out in the order the tests decode', () => {
    const type = (name: string) => basket.types.find((t) => t.name === name);
    const fields = (name: string) => type(name)?.type.fields.map((f) => f.name);
    expect(fields('AssetRegistry')).toEqual(['priceAccounts', 'count', 'assets'].map(snake));
    expect(fields('AssetEntry')).toEqual(
      [
        'mint',
        'priceSlot',
        'priceIndex',
        'twapIndex',
        'decimals',
        'priceKind',
        'session',
        'maxWeightBps',
        'flags',
        'sourceCheck',
        'minPrice',
        'maxPrice',
        'reserved',
      ].map(snake),
    );
    // Packed: no padding between the fields, so the offsets are the sizes added up.
    for (const name of ['AssetRegistry', 'AssetEntry'])
      expect([name, type(name)?.repr]).toEqual([name, { kind: 'rust', packed: true }]);
    expect(fields('Recipe')).toEqual(
      [
        'creator',
        'familyId',
        'current',
        'pending',
        'lastPublishTs',
        'maxFeeBps',
        'flags',
        'vetoed',
        'lastVersion',
        'reserved',
      ].map(snake),
    );
    expect(fields('RecipeVersion')).toEqual(
      ['version', 'effectiveAt', 'metaHash', 'count', 'components'].map(snake),
    );
    expect(fields('Component')).toEqual(['mint', 'weightBps'].map(snake));
  });

  it('lays Vault and Config out in the order the tests decode', () => {
    const fields = (name: string) =>
      basket.types.find((t) => t.name === name)?.type.fields.map((f) => f.name);
    expect(fields('Vault')).toEqual(
      [
        'owner',
        'recipe',
        'acceptedVersion',
        'autoFollow',
        'basketId',
        'bump',
        'keeper',
        'count',
        'positions',
        'lossAccum',
        'lossTs',
        'reserved',
      ].map(snake),
    );
    expect(fields('Position')).toEqual(['mint', 'targetBps', 'tracked', 'lastKeeperTs'].map(snake));
    expect(fields('Config')).toEqual(
      [
        'admin',
        'pendingAdmin',
        'guardian',
        'defaultKeeper',
        'routerProgram',
        'priceOwner',
        'cashMint',
        'keeperPaused',
        'launched',
        'toleranceBps',
        'lossCapBps',
        'bandBps',
        'twapDevBps',
        'maxPriceAgeS',
        'assetCooldownS',
        'publishDelayS',
        'sessionOpenUtcS',
        'sessionCloseUtcS',
        'closedUntil',
        'closedDays',
        'bump',
        'reserved',
      ].map(snake),
    );
  });
});
