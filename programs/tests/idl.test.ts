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
  createVaultInstruction,
  depositInstruction,
  FROZEN_ERRORS,
  initConfigInstruction,
  setPriceOwnerInstruction,
  setRouterInstruction,
  vaultAddress,
  withdrawInstruction,
} from './src/basket';
import { BASKET_PROGRAM, MOCK_ROUTER_PROGRAM, REPO_ROOT, SYSTEM_PROGRAM } from './src/env';
import {
  initPairInstruction,
  initRouterInstruction,
  routeInstruction,
  setPriceInstruction,
} from './src/mock-router';
import { type TestMint, TOKEN_PROGRAM } from './src/tokens';

type IdlAccount = { name: string; writable?: boolean; signer?: boolean; address?: string };
type Idl = {
  address: string;
  instructions: { name: string; discriminator: number[]; accounts: IdlAccount[] }[];
  errors: { code: number; name: string }[];
  types: { name: string; type: { fields: { name: string }[] } }[];
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
        params: {
          toleranceBps: 0,
          lossCapBps: 0,
          bandBps: 0,
          twapDevBps: 0,
          maxPriceAgeS: 0,
          assetCooldownS: 0,
          publishDelayS: 0,
          sessionOpenUtcS: 0,
          sessionCloseUtcS: 0,
        },
      }),
      set_router: await setRouterInstruction(signer, other),
      set_price_owner: await setPriceOwnerInstruction(signer, other),
      create_vault: await createVaultInstruction({ owner: signer, basketId: 1n }),
      deposit: await depositInstruction({ owner: signer, vault, mint, amount: 1n }),
      withdraw: await withdrawInstruction({ owner: signer, vault, mint, amount: 1n }),
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
      init_pair: await initPairInstruction(signer, mintIn.address, mintOut.address, 1n, 1n),
      set_price: await setPriceInstruction(signer, mintIn.address, mintOut.address, 1n, 1n),
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
        'reserved',
      ].map(snake),
    );
  });
});
