import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockAdapter } from '@colosseum/chain-mock';
import {
  CHAIN_PRESETS,
  ChainId,
  ConfigResponse,
  chainProvenance,
  parseChainConfigs,
  parseFlags,
} from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { DEPLOYMENTS, readDeploymentFiles } from '../../scripts/sources';
import { refusalOf } from '../../test/bites';
import * as e from '../../test/evm';
import vectors from '../../test/fixtures/evm-vectors.json';
import * as s from '../../test/solana';
import {
  CHAIN_NUMBERS,
  DEPLOYMENT_NETWORKS,
  type DeploymentFile,
  deploymentsOf,
  isLoadedDeployment,
  readDeploymentFile,
} from './deployment';
import { evmVaultAddress } from './evm/addresses';
import { BASKET_PROGRAM } from './generated/basket-program';
import { guardTransaction, readDeploymentFile as offered } from './index';
import { configAddress, tokenAccountAddress, vaultAddress } from './solana/addresses';
import type { ApprovedStep, GuardDeployments } from './types';

vi.mock('./generated/deployment-files', () => import('../../test/deployments'));

// The files as the package carries them, past the module the tests put in their place.
const { DEPLOYMENT_FILES } = await vi.importActual<typeof import('./generated/deployment-files')>(
  './generated/deployment-files',
);

// Where a deployment comes from (the review of AGT-1, item 2). The guard derives every address from
// the deployment, so a deployment a server can write is a guard the server can switch off. These hold
// it to a file committed in this package, read by this package, and to nothing else.

const approveStep: ApprovedStep = {
  legId: 'leg-1',
  chain: 'robinhood',
  owner: e.OWNER,
  basketId: e.BASKET_ID,
  kind: 'approve',
  amountRaw: '1000',
};
const depositStep: ApprovedStep = {
  legId: 'leg-1',
  chain: 'solana',
  owner: s.OWNER,
  basketId: s.BASKET_ID,
  kind: 'deposit',
  amountRaw: '1000',
  trades: [],
};
const approval = (token: string, spender: string) =>
  e.evmTx(approveStep, { to: token, data: e.calls.approve(spender, 1000n) });

describe('the committed deployment files', () => {
  it('the package carries every file under packages/sdk/deployments, as committed', () => {
    const files = readDeploymentFiles();
    expect(DEPLOYMENT_FILES).toEqual(files);
    for (const [name, file] of Object.entries(files)) {
      // A file is its network's: mock.json says `mock`, and so on.
      expect((file as DeploymentFile).network, name).toBe(name);
      expect(Object.keys(readDeploymentFile(file)).length, name).toBeGreaterThan(0);
    }
    expect(Object.keys(files)).toContain('mock');
  });

  it("the mock's file names every chain, with the cash the mock itself uses and its decimals", async () => {
    const mock = deploymentsOf('mock');
    expect(Object.keys(mock).sort()).toEqual([...ChainId.options].sort());
    for (const chain of ChainId.options) {
      const adapter = createMockAdapter({ chain });
      const cash = (await adapter.listAssets()).find((a) => a.id === adapter.mock.cash);
      expect(mock[chain]).toEqual({
        family: 'mock',
        chain,
        cash: adapter.mock.cash,
        cashDecimals: cash?.decimals,
      });
      expect(isLoadedDeployment(mock[chain])).toBe(true);
    }
  });

  it("the test network's decimals are the devnet record's, for every mint, and the loaded deployment carries them", () => {
    const record = JSON.parse(
      readFileSync(
        join(DEPLOYMENTS, '..', '..', '..', 'deployments', 'solana-devnet.json'),
        'utf8',
      ),
    ) as {
      cash: { mint: string; decimals: number };
      assets: { mint: string; decimals: number }[];
      retired: { mint: string; decimals: number }[];
    };
    const byMint = new Map(
      [record.cash, ...record.assets, ...record.retired].map((t) => [t.mint, t.decimals]),
    );
    const solana = deploymentsOf('testnet').solana;
    if (solana?.family !== 'solana') throw new Error('no Solana on the test network');
    expect(Object.keys(solana.assets).length).toBeGreaterThan(1);
    for (const [id, asset] of Object.entries(solana.assets))
      expect(asset.decimals, id).toBe(byMint.get(asset.mint));
    // And every mint the record names is in the file: a listed token (tPAXG) or a retired one (tGLDx).
    expect(new Set(Object.values(solana.assets).map((a) => a.mint))).toEqual(
      new Set(byMint.keys()),
    );
    // What a screen turns the cash's raw units into dollars with: the file's, never a server's.
    expect(solana.assets[solana.cash]?.decimals).toBe(6);
  });

  it('a network with no committed file has no deployment', () => {
    const without = DEPLOYMENT_NETWORKS.filter((n) => !Object.hasOwn(DEPLOYMENT_FILES, n));
    for (const network of without) {
      const refusal = refusalOf(() => deploymentsOf(network));
      expect(refusal?.code, network).toBe('deployment');
      expect(refusal?.message).toContain(network);
    }
    expect(refusalOf(() => deploymentsOf('toString' as never))?.code).toBe('deployment');
  });

  it('the example of a local deployment reads as one', () => {
    const example = JSON.parse(readFileSync(join(DEPLOYMENTS, 'local.example.json'), 'utf8'));
    const local = readDeploymentFile(example);
    expect(local.solana).toMatchObject({ family: 'solana', provenance: 'sandbox' });
    expect(local.robinhood).toMatchObject({
      family: 'evm',
      provenance: 'sandbox',
      evmChainId: 31337,
      // Written with its checksum in the file, held in lower case.
      factory: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
    });
  });

  it("the numbers of each chain's networks are the shared presets'", () => {
    for (const chain of ChainId.options) {
      const { mainnet, testnet } = CHAIN_PRESETS[chain].networks;
      expect(CHAIN_NUMBERS[chain], chain).toEqual(
        mainnet.evmChainId === null
          ? null
          : { mainnet: mainnet.evmChainId, testnet: testnet.evmChainId },
      );
    }
  });
});

describe('a deployment is only what the loader read from a file', () => {
  it('a loaded deployment passes, and it cannot be changed afterwards', () => {
    const tx = approval(e.tokenOf('robinhood:usdc'), e.VAULT);
    expect(
      refusalOf(() => guardTransaction({ step: approveStep, tx, deployment: e.EVM })),
    ).toBeNull();
    expect(
      Object.isFrozen(e.EVM) && Object.isFrozen(e.EVM.assets) && Object.isFrozen(e.EVM.routers),
    ).toBe(true);
    expect(() => {
      (e.EVM as { factory: string }).factory = e.anyone('attacker factory');
    }).toThrow(TypeError);
    expect(e.EVM.factory).toBe(e.FACTORY);
  });

  it('Solana: a copy with a program of its own is not a deployment, to the type or to the guard', async () => {
    const evil = s.someone('attacker program');
    const table = { ...BASKET_PROGRAM, address: evil };
    const cash = s.mintOf('solana:usdc');
    const vault = vaultAddress(evil, s.OWNER, s.BASKET_ID);
    const ix = s.vaultIx(
      table,
      'deposit',
      {
        owner: s.OWNER,
        vault,
        config: configAddress(evil),
        mint: cash,
        vault_token_account: tokenAccountAddress(vault, cash, s.TOKEN),
        source: tokenAccountAddress(s.OWNER, cash, s.TOKEN),
        token_program: s.TOKEN,
      },
      s.u64('1000'),
    );
    const tx = s.solanaTx(depositStep, s.wire([ix]));
    const copy = { ...s.SOLANA, program: evil };
    // @ts-expect-error a copy of a loaded deployment does not carry the loader's mark
    const refusal = refusalOf(() => guardTransaction({ step: depositStep, tx, deployment: copy }));
    expect(refusal?.code).toBe('deployment');
    // And the real deployment refuses the same bytes for what they are: another program's.
    expect(
      refusalOf(() => guardTransaction({ step: depositStep, tx, deployment: s.SOLANA }))?.code,
    ).toBe('program');
  });

  it('EVM: a copy with a factory and a beacon of its own is not a deployment', () => {
    const copy = {
      ...e.EVM,
      factory: e.anyone('attacker factory'),
      beacon: e.anyone('attacker beacon'),
    };
    const spender = evmVaultAddress(copy, e.OWNER, e.BASKET_ID);
    expect(spender).not.toBe(e.VAULT);
    const tx = approval(e.tokenOf('robinhood:usdc'), spender);
    // @ts-expect-error a copy of a loaded deployment does not carry the loader's mark
    const refusal = refusalOf(() => guardTransaction({ step: approveStep, tx, deployment: copy }));
    expect(refusal?.code).toBe('deployment');
    expect(
      refusalOf(() => guardTransaction({ step: approveStep, tx, deployment: e.EVM }))?.code,
    ).toBe('spender');
  });

  it('EVM: a copy with an asset list of its own is not a deployment', () => {
    const token = e.anyone('another token the person holds');
    const copy = { ...e.EVM, assets: { ...e.EVM.assets, 'robinhood:usdc': { token } } };
    const tx = approval(token, e.VAULT);
    // @ts-expect-error a copy of a loaded deployment does not carry the loader's mark
    const refusal = refusalOf(() => guardTransaction({ step: approveStep, tx, deployment: copy }));
    expect(refusal?.code).toBe('deployment');
    expect(
      refusalOf(() => guardTransaction({ step: approveStep, tx, deployment: e.EVM }))?.code,
    ).toBe('target');
  });

  it('what GET /v1/config answers is not a deployment: not as it is, not shaped by hand, not through the loader', () => {
    // The answer as apps/api builds it (routes/v1/config.ts), for a deployed test network.
    const flags = parseFlags({ CHAIN_MODE_ROBINHOOD: 'live' });
    const configs = parseChainConfigs(
      { CHAIN_ROUTER_ROBINHOOD: e.ROUTER },
      { robinhood: { factory: e.FACTORY, registry: e.anyone('registry'), beacon: e.EVM.beacon } },
    );
    const config = ConfigResponse.parse({
      flags,
      chains: ChainId.options.map((id) => ({
        ...configs[id],
        mode: flags.chainMode[id],
        provenance: chainProvenance(configs[id].network, flags.chainMode[id]),
      })),
    });
    const chain = config.chains.find((c) => c.id === 'robinhood');
    if (!chain?.router || !chain.evmChainId) throw new Error('the config has no robinhood chain');
    const tx = approval(e.tokenOf('robinhood:usdc'), e.VAULT);

    // @ts-expect-error a chain of the config is not a deployment
    const asItIs = refusalOf(() => guardTransaction({ step: approveStep, tx, deployment: chain }));
    expect(asItIs?.code).toBe('deployment');

    // Every field of a deployment, each with the right value, put together by hand from the answer.
    const byHand = {
      family: 'evm' as const,
      chain: 'robinhood' as const,
      provenance: 'sandbox' as const,
      evmChainId: chain.evmChainId,
      factory: chain.contracts.factory as string,
      beacon: chain.contracts.beacon as string,
      routers: [chain.router],
      cash: 'robinhood:usdc',
      assets: { ...e.EVM.assets },
    };
    expect(byHand).toEqual({ ...e.EVM });
    // @ts-expect-error an object written by hand does not carry the loader's mark
    const shaped = refusalOf(() => guardTransaction({ step: approveStep, tx, deployment: byHand }));
    expect(shaped?.code).toBe('deployment');
    // @ts-expect-error and so it is no entry of the executor's `deployments` either
    const forExecutor: GuardDeployments = { robinhood: byHand };
    expect(isLoadedDeployment(forExecutor.robinhood)).toBe(false);

    // The loader reads a deployment file, and the answer is not one.
    for (const fetched of [config, chain, { robinhood: byHand }, byHand])
      expect(refusalOf(() => readDeploymentFile(fetched))?.code).toBe('deployment');
  });

  it('a file of the right shape from anywhere but the package is read, and is still no deployment', () => {
    // What a server could answer, written as a deployment file for mainnet, with a factory of its own.
    const fromApi = {
      format: 'guard-deployment/1',
      network: 'mainnet',
      chains: {
        robinhood: {
          family: 'evm',
          evmChainId: 4663,
          factory: e.anyone('evil factory'),
          beacon: e.anyone('evil beacon'),
          routers: [],
          cash: 'robinhood:usdc',
          assets: { 'robinhood:usdc': { address: e.anyone('evil usdc'), decimals: 6 } },
        },
      },
    };
    // The package offers the reader, for a deploy to check its file with.
    expect(offered).toBe(readDeploymentFile);
    const read = readDeploymentFile(fromApi).robinhood;
    expect(read).toMatchObject({ provenance: 'live', factory: e.anyone('evil factory') });
    expect(isLoadedDeployment(read)).toBe(false);
    const tx = approval(e.tokenOf('robinhood:usdc'), e.VAULT);
    expect(
      // @ts-expect-error what the file reader answers is not a deployment
      refusalOf(() => guardTransaction({ step: approveStep, tx, deployment: read }))?.code,
    ).toBe('deployment');
    // The one way to a deployment reads only the files the package carries, which cannot be added to.
    for (const network of ['mainnet', '__proto__', 'constructor', 'toString'])
      expect(refusalOf(() => deploymentsOf(network as never))?.code, network).toBe('deployment');
    expect(Object.isFrozen(DEPLOYMENT_FILES) && Object.isFrozen(DEPLOYMENT_FILES.mock)).toBe(true);
    expect(() => {
      (DEPLOYMENT_FILES as Record<string, unknown>).mainnet = fromApi;
    }).toThrow(TypeError);
    expect(Object.hasOwn(DEPLOYMENT_FILES, 'mainnet')).toBe(false);
  });
});

/** A file for a local deployment of both families, every address in place. */
const fileOf = (network: DeploymentFile['network'] = 'local') => ({
  format: 'guard-deployment/1',
  network,
  chains: {
    solana: {
      family: 'solana',
      program: BASKET_PROGRAM.address,
      router: s.ROUTER,
      cash: 'solana:usdc',
      assets: {
        'solana:usdc': { mint: s.someone('mint usdc'), tokenProgram: 'token', decimals: 6 },
        'solana:spy': { mint: s.someone('mint spy'), tokenProgram: 'token-2022', decimals: 8 },
      },
      fee: { maxFeeNativeRaw: '5000000' },
    } as Record<string, unknown>,
    robinhood: {
      family: 'evm',
      evmChainId: 46630,
      factory: e.FACTORY,
      beacon: e.BEACON,
      routers: [e.ROUTER],
      cash: 'robinhood:usdc',
      assets: {
        'robinhood:usdc': { address: e.anyone('token usdc'), decimals: 6 },
        'robinhood:spy': { address: e.anyone('token spy'), decimals: 18 },
      },
      fee: { maxFeeNativeRaw: '1000000000000000', maxGas: 5_000_000 },
    } as Record<string, unknown>,
  } as Record<string, Record<string, unknown>>,
});
type File = ReturnType<typeof fileOf>;
const sol = (f: File) => f.chains.solana as Record<string, unknown>;
const evm = (f: File) => f.chains.robinhood as Record<string, unknown>;

describe('the loader reads a deployment file and nothing that is nearly one', () => {
  it('reads the file: the label from the network, EVM addresses in lower case', () => {
    const local = readDeploymentFile(fileOf());
    expect(local.solana).toEqual({
      family: 'solana',
      chain: 'solana',
      provenance: 'sandbox',
      router: s.ROUTER,
      cash: 'solana:usdc',
      assets: sol(fileOf()).assets,
      fee: { maxFeeNativeRaw: '5000000' },
    });
    expect(local.robinhood).toMatchObject({ provenance: 'sandbox', evmChainId: 46630 });
    // A local copy of mainnet runs under mainnet's number, and is never labelled live.
    const copy = fileOf();
    evm(copy).evmChainId = 4663;
    expect(readDeploymentFile(copy).robinhood).toMatchObject({ provenance: 'sandbox' });

    const mainnet = fileOf('mainnet');
    evm(mainnet).evmChainId = 4663;
    const live = readDeploymentFile(mainnet);
    expect(live.solana?.family === 'solana' && live.solana.provenance).toBe('live');
    expect(live.robinhood?.family === 'evm' && live.robinhood.provenance).toBe('live');
    expect(readDeploymentFile(fileOf('testnet')).robinhood).toMatchObject({
      provenance: 'sandbox',
    });
  });

  it('takes an address with its checksum as viem writes it, and refuses one whose checksum is off', () => {
    expect(vectors.checksums.length).toBeGreaterThan(10);
    for (const { lower, checksummed } of vectors.checksums) {
      const file = fileOf();
      evm(file).factory = checksummed;
      if (lower !== e.FACTORY) evm(file).beacon = e.FACTORY;
      const loaded = readDeploymentFile(file).robinhood;
      expect(loaded?.family === 'evm' && loaded.factory, checksummed).toBe(lower);

      // One letter in the other case: no longer the address's own checksum.
      const at = [...checksummed].findIndex((ch, i) => i > 1 && /[a-fA-F]/.test(ch));
      const ch = checksummed[at] as string;
      const flipped = `${checksummed.slice(0, at)}${ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()}${checksummed.slice(at + 1)}`;
      if (flipped === lower) continue;
      evm(file).factory = flipped;
      expect(refusalOf(() => readDeploymentFile(file))?.message, flipped).toMatch(/checksum/);
    }
  });

  type Entry = (f: File) => Record<string, unknown>;
  /** The file with one field of one entry set, or taken out. */
  const set = (entry: Entry, key: string, value: unknown) => (f: File) => {
    entry(f)[key] = value;
    return f;
  };
  const drop = (entry: Entry, key: string) => (f: File) => {
    delete entry(f)[key];
    return f;
  };
  /** The file with one asset of one entry set. */
  const asset = (entry: Entry, id: string, value: unknown) => (f: File) => {
    (entry(f).assets as Record<string, unknown>)[id] = value;
    return f;
  };
  const mockFile = (entry: unknown) => () => ({
    format: 'guard-deployment/1',
    network: 'mock',
    chains: { base: entry },
  });
  const upperCase = (address: string) => `0x${address.slice(2).toUpperCase()}`;
  const mint = (label: string, tokenProgram = 'token') => ({
    mint: s.someone(label),
    tokenProgram,
    decimals: 8,
  });

  const wrong: [string, (f: File) => unknown, RegExp][] = [
    ['nothing', () => null, /not an object/],
    ['a list', (f) => [f], /not an object/],
    ['text', (f) => JSON.stringify(f), /not an object/],
    ['a field nobody reads', (f) => ({ ...f, rpcUrl: 'https://rpc.invalid' }), /rpcUrl/],
    ['no format', (f) => ({ network: f.network, chains: f.chains }), /format/],
    ['another format', (f) => ({ ...f, format: 'guard-deployment/2' }), /format/],
    ['no network', (f) => ({ format: f.format, chains: f.chains }), /network/],
    ['a network nobody knows', (f) => ({ ...f, network: 'devnet' }), /network/],
    ['a network named as every object is', (f) => ({ ...f, network: 'toString' }), /network/],
    ['no chains', (f) => ({ format: f.format, network: f.network }), /chains is not an object/],
    ['an empty list of chains', (f) => ({ ...f, chains: {} }), /names no chain/],
    ['a chain nobody knows', (f) => ({ ...f, chains: { ethereum: evm(f) } }), /ethereum/],
    [
      'an entry that is not an object',
      (f) => ({ ...f, chains: { solana: 'x' } }),
      /solana: .*not an object/,
    ],
    ['a field nobody reads in an entry', set(sol, 'rpcUrl', 'x'), /rpcUrl/],
    ['a field nobody reads in an EVM entry', set(evm, 'keeper', e.STRANGER), /keeper/],
    ['a registry that is not an address', set(evm, 'registry', 'nowhere'), /registry/],
    ['a registry that is the factory', set(evm, 'registry', e.FACTORY), /the same/],
    // ---- families
    [
      'an EVM entry for Solana',
      (f) => ({ ...f, chains: { solana: evm(f) } }),
      /family is not solana/,
    ],
    [
      'a Solana entry for an EVM chain',
      (f) => ({ ...f, chains: { robinhood: sol(f) } }),
      /family is not evm/,
    ],
    ['no family', drop(sol, 'family'), /family is not solana/],
    [
      'a mock chain in a real network',
      (f) => ({
        ...f,
        chains: { ...f.chains, base: { family: 'mock', cash: 'base:usdc', cashDecimals: 6 } },
      }),
      /base: its family is not evm/,
    ],
    [
      'a real chain in the mock network',
      (f) => ({ ...f, network: 'mock' }),
      /mock's file is not a mock/,
    ],
    // ---- Solana
    ['another vault program', set(sol, 'program', s.someone('attacker program')), /vault program/],
    ['no router', drop(sol, 'router'), /router is not an address/],
    ['a router that is not an address', set(sol, 'router', 'router'), /router is not an address/],
    ['a router of 31 bytes', set(sol, 'router', '1'.repeat(31)), /router is not an address/],
    ['an EVM address as the router', set(sol, 'router', e.ROUTER), /router is not an address/],
    [
      'the router at the address of a mint',
      set(sol, 'router', s.someone('mint usdc')),
      /addresses are the same/,
    ],
    [
      'the vault program as the router',
      set(sol, 'router', BASKET_PROGRAM.address),
      /addresses are the same/,
    ],
    [
      'two assets with one mint',
      asset(sol, 'solana:spy', mint('mint usdc')),
      /addresses are the same/,
    ],
    [
      'a mint that is not an address',
      asset(sol, 'solana:spy', { mint: 'spy', tokenProgram: 'token', decimals: 6 }),
      /mint of solana:spy/,
    ],
    [
      'a token program nobody knows',
      asset(sol, 'solana:spy', mint('mint spy', 'token-2023')),
      /token program/,
    ],
    [
      'a field nobody reads in an asset',
      asset(sol, 'solana:spy', { ...mint('mint spy'), symbol: 'SPY' }),
      /symbol/,
    ],
    ['an asset that is not an object', asset(sol, 'solana:spy', 'spy'), /not an object/],
    ['no assets', drop(sol, 'assets'), /assets is not an object/],
    ['an empty list of assets', set(sol, 'assets', {}), /lists no asset/],
    [
      'an asset of another chain',
      asset(sol, 'robinhood:usdc', mint('m')),
      /not an asset of solana/,
    ],
    ['an asset with no name', asset(sol, 'solana:', mint('m')), /not an asset of solana/],
    ['cash that is not listed', set(sol, 'cash', 'solana:gold'), /cash is not one of its assets/],
    ['no cash', drop(sol, 'cash'), /cash is not one of its assets/],
    [
      'cash named as every object is',
      set(sol, 'cash', 'toString'),
      /cash is not one of its assets/,
    ],
    [
      'a fee ceiling that is not raw units',
      set(sol, 'fee', { maxFeeNativeRaw: '0.005' }),
      /not raw units/,
    ],
    ['a fee ceiling as a number', set(sol, 'fee', { maxFeeNativeRaw: 5000000 }), /not raw units/],
    [
      'a gas ceiling on Solana',
      set(sol, 'fee', { maxFeeNativeRaw: '5000000', maxGas: 1 }),
      /gas ceiling/,
    ],
    [
      'a field nobody reads in the fee',
      set(sol, 'fee', { maxFeeNativeRaw: '1', perByte: 1 }),
      /perByte/,
    ],
    // ---- EVM
    ['no chain id', drop(evm, 'evmChainId'), /chain id is not a number/],
    ['a chain id of zero', set(evm, 'evmChainId', 0), /chain id is not a number/],
    ['a chain id as text', set(evm, 'evmChainId', '46630'), /chain id is not a number/],
    [
      "mainnet under the test network's number",
      (f) => ({ ...f, network: 'mainnet' }),
      /not the one robinhood has on mainnet/,
    ],
    [
      "the test network under mainnet's number",
      (f) => ({ ...set(evm, 'evmChainId', 4663)(f), network: 'testnet' }),
      /not the one robinhood has on testnet/,
    ],
    [
      "the test network under another chain's number",
      (f) => ({ ...set(evm, 'evmChainId', 84532)(f), network: 'testnet' }),
      /not the one robinhood has on testnet/,
    ],
    ['no factory', drop(evm, 'factory'), /factory is not an address/],
    [
      'a factory of 19 bytes',
      set(evm, 'factory', e.FACTORY.slice(0, -2)),
      /factory is not an address/,
    ],
    ['a Solana address as the factory', set(evm, 'factory', s.ROUTER), /factory is not an address/],
    ['the zero address as the factory', set(evm, 'factory', `0x${'0'.repeat(40)}`), /zero address/],
    ['a factory in upper case', set(evm, 'factory', upperCase(e.FACTORY)), /checksum/],
    ['no beacon', drop(evm, 'beacon'), /beacon is not an address/],
    ['routers that are not a list', set(evm, 'routers', e.ROUTER), /list of routers/],
    [
      'a router that is not an address on EVM',
      set(evm, 'routers', [e.ROUTER, 'router']),
      /a router is not an address/,
    ],
    ['the factory as its own beacon', set(evm, 'beacon', e.FACTORY), /addresses are the same/],
    ['the factory as a router', set(evm, 'routers', [e.FACTORY]), /addresses are the same/],
    ['one router twice', set(evm, 'routers', [e.ROUTER, e.ROUTER]), /addresses are the same/],
    [
      'the factory as the cash token',
      asset(evm, 'robinhood:usdc', { address: e.FACTORY, decimals: 6 }),
      /addresses are the same/,
    ],
    [
      'a router as a token',
      asset(evm, 'robinhood:spy', { address: e.ROUTER, decimals: 6 }),
      /addresses are the same/,
    ],
    [
      'a token that is not an address',
      asset(evm, 'robinhood:spy', { address: 'spy', decimals: 6 }),
      /token of robinhood:spy/,
    ],
    [
      'a field nobody reads in a token',
      asset(evm, 'robinhood:spy', { address: e.anyone('t'), decimals: 6, symbol: 'SPY' }),
      /symbol/,
    ],
    [
      'an asset of another chain on EVM',
      asset(evm, 'base:usdc', { address: e.anyone('t'), decimals: 6 }),
      /not an asset of robinhood/,
    ],
    [
      'cash that is not listed on EVM',
      set(evm, 'cash', 'robinhood:gold'),
      /cash is not one of its assets/,
    ],
    [
      'no decimals for a token',
      asset(evm, 'robinhood:spy', { address: e.anyone('t') }),
      /decimals of robinhood:spy/,
    ],
    [
      'decimals as text',
      asset(evm, 'robinhood:spy', { address: e.anyone('t'), decimals: '18' }),
      /decimals/,
    ],
    [
      'decimals past a byte',
      asset(evm, 'robinhood:spy', { address: e.anyone('t'), decimals: 256 }),
      /decimals/,
    ],
    [
      'decimals below zero',
      asset(sol, 'solana:spy', { ...mint('mint spy', 'token-2022'), decimals: -1 }),
      /decimals of solana:spy/,
    ],
    [
      'decimals of a fraction',
      asset(sol, 'solana:spy', { ...mint('mint spy', 'token-2022'), decimals: 1.5 }),
      /decimals/,
    ],
    [
      'no decimals for a mint',
      asset(sol, 'solana:usdc', { mint: s.someone('mint usdc'), tokenProgram: 'token' }),
      /decimals of solana:usdc/,
    ],
    ["a proxy's code that is not hex", set(evm, 'proxyCreationCode', '0xzz'), /hex/],
    [
      "a proxy's code that is not text",
      set(evm, 'proxyCreationCode', 60),
      /creation code is not hex/,
    ],
    ["a proxy's code that is empty", set(evm, 'proxyCreationCode', '0x'), /creation code is empty/],
    ['a gas ceiling of zero', set(evm, 'fee', { maxFeeNativeRaw: '1', maxGas: 0 }), /gas ceiling/],
    // ---- the mock
    [
      "a mock chain with another chain's cash",
      mockFile({ family: 'mock', cash: 'solana:usdc' }),
      /cash is not an asset of base/,
    ],
    ['a mock chain with no cash', mockFile({ family: 'mock' }), /cash is not an asset of base/],
    [
      'a mock chain with no decimals for its cash',
      mockFile({ family: 'mock', cash: 'base:usdc' }),
      /cashDecimals of base:usdc/,
    ],
    [
      'a mock chain with decimals that are no number',
      mockFile({ family: 'mock', cash: 'base:usdc', cashDecimals: 6.5 }),
      /cashDecimals of base:usdc/,
    ],
    [
      'a mock chain with cash of no name',
      mockFile({ family: 'mock', cash: 'base:' }),
      /cash is not an asset of base/,
    ],
    [
      'a mock chain with an address',
      mockFile({ family: 'mock', cash: 'base:usdc', factory: e.FACTORY }),
      /factory/,
    ],
  ];

  it.each(wrong)('refuses %s', (_name, change, message) => {
    expect(refusalOf(() => readDeploymentFile(fileOf()))).toBeNull();
    const refusal = refusalOf(() => readDeploymentFile(change(fileOf())));
    expect(refusal?.code).toBe('deployment');
    expect(refusal?.message).toMatch(message);
  });

  it("carries a proxy's creation code the file states, and derives the vault from it", () => {
    const [v] = vectors.vaults;
    if (!v) throw new Error('no vault vector');
    const file = fileOf();
    Object.assign(evm(file), {
      factory: v.factory,
      beacon: v.beacon,
      proxyCreationCode: `0x${v.proxyCreationCode.slice(2).toUpperCase()}`,
    });
    const loaded = readDeploymentFile(file).robinhood;
    if (loaded?.family !== 'evm') throw new Error('not an EVM deployment');
    expect(loaded.proxyCreationCode).toBe(v.proxyCreationCode);
    expect(evmVaultAddress(loaded, v.owner, v.basketId)).toBe(v.vault);
  });
});
