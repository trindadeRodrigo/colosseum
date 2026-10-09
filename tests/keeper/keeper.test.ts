import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  associatedTokenAddress,
  pairAddress,
  type SolanaVaultAdapter,
} from '@colosseum/chain-solana/vault';
import { type BuiltTx, ChainError } from '@colosseum/schemas';
import { type Address, getBase58Decoder, getTransactionDecoder, lamports } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { legKey, loadMemory, saveMemory } from '../../apps/keeper/src/memory';
import { runRound, type VaultLine } from '../../apps/keeper/src/round';
import { priceAccountBytes, upsertAsset } from '../solana-vault/admin';
import {
  buildContractWorld,
  type ContractWorld,
  id,
  newKey,
  PARAMS,
  PRICE_ENTRIES,
  SHELF,
} from '../solana-vault/contract-world';
import {
  createSvmNode,
  MOCK_ROUTER_PROGRAM,
  PROGRAMS_BUILT,
  type SvmNode,
} from '../solana-vault/svm-node';

// The keeper's round against the real program and the test exchange in LiteSVM: a version of a shared
// portfolio adopted and the vault moved toward it by a leg; records that differ from the accounts
// synced or, where the policy refuses, skipped with an alert; a leg that reverted not sent again, in
// the same run or the next; a leg whose fate is not known holding its vault until it is.

type Setup = {
  w: ContractWorld;
  node: SvmNode;
  writePrices: (at: bigint, entries?: typeof PRICE_ENTRIES) => void;
};

async function world(): Promise<Setup> {
  const deployer = await newKey();
  const start = BigInt(Math.floor(Date.now() / 1000));
  const node = await createSvmNode(deployer.address, start);
  node.svm.airdrop(deployer.address, lamports(1_000_000_000_000n));
  const priceAccount = (await newKey()).address;
  const writePrices = (at: bigint, entries = PRICE_ENTRIES, header = true) => {
    const data = priceAccountBytes(entries, at, node.svm.getClock().slot, header);
    node.svm.setAccount({
      address: priceAccount,
      data,
      executable: false,
      lamports: lamports(node.svm.minimumBalanceForRentExemption(BigInt(data.length))),
      programAddress: MOCK_ROUTER_PROGRAM,
      space: BigInt(data.length),
    });
  };
  writePrices(start, PRICE_ENTRIES, false);
  const w = await buildContractWorld(
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
      refreshPrices: (at) => writePrices(at),
    },
    {
      deployer,
      priceAccount,
      pendingVersion: false,
      network: 'testnet',
      notBefore: new Date().toISOString(),
    },
  );
  return { w, node, writePrices: (at, entries) => writePrices(at, entries) };
}

/** Signs as the world's keeper: the signed bytes and the transaction's id, the keeper's signature. */
const keeperSign = (s: Setup) => async (tx: BuiltTx) => {
  const wire = await s.w.sign(tx);
  const decoded = getTransactionDecoder().decode(new Uint8Array(Buffer.from(wire, 'base64')));
  const signature = decoded.signatures[tx.signer as Address];
  if (!signature) throw new Error('not signed by the keeper');
  return { wire, txId: getBase58Decoder().decode(signature) };
};
const lands = (s: Setup, wire: string) =>
  s.node.land(getTransactionDecoder().decode(new Uint8Array(Buffer.from(wire, 'base64'))));

/** The keeper's round on the world: signed with the world's keeper key, the vaults in address order. */
function round(s: Setup) {
  return runRound({
    adapter: s.w.adapter as SolanaVaultAdapter,
    sign: keeperSign(s),
    shuffle: (items) => [...items].sort(),
    settleMs: 5_000,
  });
}
const of = (lines: VaultLine[], vault: string) => lines.find((l) => l.vault === vault);

/**
 * A send after which the leg reverts: the exchange pays 3% less between the build and the landing,
 * past the vault's tolerance, and the leg lands without a preflight. The pair is written directly, so
 * LiteSVM's one blockhash, which the built leg carries, stays good. `bought` gets what each leg bought,
 * by its signature.
 */
function revertingSend(s: Setup, bought: Map<string, string | undefined>) {
  return async (signed: string, tx: BuiltTx) => {
    const into = tx.preview.changes.find(
      (c) => c.holder === 'vault' && BigInt(c.deltaRaw) > 0n,
    )?.asset;
    const name = (into ?? id('alpha')).slice('solana:'.length);
    const cash = s.w.mints.cash;
    const asset = s.w.mints[name];
    if (!cash || !asset) throw new Error('mints');
    const pair = await pairAddress(MOCK_ROUTER_PROGRAM, cash.address, asset.address);
    const account = s.node.svm.getAccount(pair);
    if (!account.exists) throw new Error('no pair');
    const original = new Uint8Array(account.data);
    const moved = new Uint8Array(original);
    const view = new DataView(moved.buffer);
    view.setBigUint64(72, (view.getBigUint64(72, true) * 97n) / 100n, true);
    s.node.svm.setAccount({ ...account, data: moved });
    const landed = lands(s, signed);
    s.node.svm.setAccount({ ...account, data: original });
    bought.set(landed.signature, into);
    return { txId: landed.signature };
  };
}
const stateFile = () => join(mkdtempSync(join(tmpdir(), 'keeper-state-')), 'solana-test.json');

/** What an issuer's clawback does: the vault's account holds less, unseen by the program. */
async function clawHalf(s: Setup, vault: string, name: string) {
  const m = s.w.mints[name];
  if (!m) throw new Error(name);
  const at = await associatedTokenAddress(vault as Address, m.address, m.tokenProgram);
  const account = s.node.svm.getAccount(at);
  if (!account.exists) throw new Error('no account');
  const data = new Uint8Array(account.data);
  const view = new DataView(data.buffer);
  view.setBigUint64(64, view.getBigUint64(64, true) / 2n, true);
  s.node.svm.setAccount({ ...account, data });
}

describe.skipIf(!PROGRAMS_BUILT)('the keeper, in LiteSVM with the real program', () => {
  it('adopts a weights-only version of the shared portfolio and moves the vault toward it by a leg', async () => {
    const s = await world();
    const f = s.w.fixture;
    // The next version of the portfolio the vault follows: weights only. In effect a delay later.
    await s.w.must(
      await s.w.adapter.buildPublishRecipe({ creator: f.owner, recipe: f.publishRecipe }),
    );
    s.node.advance(PARAMS.publishDelayS + 1);
    s.writePrices(s.node.now());
    const before = await s.w.adapter.getVault(f.vault);
    const lines = await round(s);
    const line = of(lines, f.vault);
    expect(line?.outcome).toBe('acted');
    // The adoption and the leg, each its own transaction.
    expect(line?.txIds).toHaveLength(2);
    const after = await s.w.adapter.getVault(f.vault);
    expect([before?.acceptedVersion, after?.acceptedVersion]).toEqual([1, 2]);
    const target = (asset: string) => after?.positions.find((p) => p.asset === asset)?.targetBps;
    expect([target(id('alpha')), target(id('beta')), target(id('gamma'))]).toEqual([
      3_500, 3_000, 3_500,
    ]);
    // One position moved, and cash went into it: the vault is closer to its targets.
    expect(BigInt(after?.cash.raw ?? 0)).toBeLessThan(BigInt(before?.cash.raw ?? 0));
    // The vault that waits for a version adding an asset is left to its owner.
    expect(of(lines, f.newAssetVault)?.reason).toMatch(/adds .*the owner accepts it/);
  });

  it('syncs records that differ when every changed position can be valued, and leaves the vault with an alert when one cannot', async () => {
    const s = await world();
    const f = s.w.fixture;
    // Half the gamma leaves unseen by the program; gamma has a reference the program takes.
    await clawHalf(s, f.vault, 'gamma');
    const synced = of(await round(s), f.vault);
    expect(synced?.txIds.length).toBeGreaterThanOrEqual(1);
    expect((await s.w.adapter.getKeeperContext(f.vault))?.positions.some((p) => p.needsSync)).toBe(
      false,
    );

    const t = await world();
    const g = t.w.fixture;
    // Now the changed position's price is outside its range: a sync would record what the keeper
    // cannot value, and stop every leg. The keeper does not sync, and raises an alert.
    await clawHalf(t, g.vault, 'gamma');
    t.writePrices(
      t.node.now(),
      PRICE_ENTRIES.map((e) => (e.index === 30 ? { ...e, value: e.value * 2n } : e)),
    );
    const left = of(await round(t), g.vault);
    expect([left?.outcome, left?.alert, left?.txIds]).toEqual(['skipped', true, []]);
    expect(left?.reason).toMatch(/not synced/);
    expect((await t.w.adapter.getKeeperContext(g.vault))?.positions.some((p) => p.needsSync)).toBe(
      true,
    );
  });

  it('does not send again a leg that reverted, in the next run either', async () => {
    const s = await world();
    const f = s.w.fixture;
    const bought = new Map<string, string | undefined>();
    // Two runs of `--once`: each loads the memory from the state file and writes it back.
    const file = stateFile();
    const options = {
      adapter: s.w.adapter,
      sign: keeperSign(s),
      send: revertingSend(s, bought),
      save: (m: Parameters<typeof saveMemory>[1]) => saveMemory(file, m),
      shuffle: <T>(v: T[]) => [...v].sort(),
      settleMs: 5_000,
    };
    const first = of(await runRound(options, loadMemory(file)), f.vault);
    expect(first?.outcome).toBe('skipped');
    expect(first?.reason).toMatch(/reverted: ReceivedTooLittle; it is not sent again/);
    expect(first?.alert).toBe(true);
    const reverted = bought.get(first?.txIds.at(-1) ?? '');
    expect(reverted).toBe(id('alpha'));
    // The next run plans the same purchase again and does not send it; any leg it sends is another.
    const memory = loadMemory(file);
    const second = of(await runRound(options, memory), f.vault);
    const legs = second?.txIds.map((t) => bought.get(t)) ?? [];
    expect(legs.length).toBeGreaterThan(0);
    expect(legs).not.toContain(reverted);
    expect(
      [...memory.reverted].some((k) => k.startsWith(`${f.vault} `) && k.endsWith(`->${reverted}`)),
    ).toBe(true);
  });

  it('keeps a leg whose send failed after the bytes went out, and reads its fate before planning again', async () => {
    const s = await world();
    const f = s.w.fixture;
    const bought = new Map<string, string | undefined>();
    const reverting = revertingSend(s, bought);
    // The bytes land and revert, and the node's answer is lost.
    const send = async (signed: string, tx: BuiltTx) => {
      await reverting(signed, tx);
      throw new ChainError('Unavailable', 'the node did not answer');
    };
    const file = stateFile();
    const options = {
      adapter: s.w.adapter,
      sign: keeperSign(s),
      send,
      save: (m: Parameters<typeof saveMemory>[1]) => saveMemory(file, m),
      shuffle: <T>(v: T[]) => [...v].sort(),
      settleMs: 5_000,
    };
    const first = of(await runRound(options, loadMemory(file)), f.vault);
    expect([first?.outcome, first?.alert]).toEqual(['skipped', true]);
    expect(first?.reason).toMatch(/was sent and no answer settled it \(Unavailable\)/);
    const sent = first?.txIds.at(-1) ?? '';
    expect(bought.get(sent)).toBe(id('alpha'));
    expect(loadMemory(file).inFlight.get(f.vault)?.txId).toBe(sent);
    // The next run reads that it reverted, remembers it, and sends another leg, not that one.
    const memory = loadMemory(file);
    const second = of(await runRound(options, memory), f.vault);
    expect(second?.reason).toMatch(new RegExp(`leg ${sent} reverted: ReceivedTooLittle`));
    const version = (await s.w.adapter.getVault(f.vault))?.acceptedVersion ?? 0;
    expect([...memory.reverted]).toContain(legKey(f.vault, version, id('cash'), id('alpha')));
    const legs = second?.txIds.map((t) => bought.get(t)) ?? [];
    expect(legs.length).toBeGreaterThan(0);
    expect(legs).not.toContain(id('alpha'));
  });

  it('holds a vault while its leg is pending, and plans it again once the leg has expired', async () => {
    const s = await world();
    const f = s.w.fixture;
    // The node takes the bytes and the leg never lands.
    let sends = 0;
    const options = {
      adapter: s.w.adapter,
      sign: keeperSign(s),
      send: async () => {
        sends++;
      },
      shuffle: <T>(v: T[]) => [...v].sort(),
      settleMs: 2_000,
    };
    const memory = loadMemory(stateFile());
    const first = of(await runRound(options, memory), f.vault);
    expect(first?.reason).toMatch(
      /is still pending; its fate is read before the vault is planned again/,
    );
    const vaultSends = sends;
    expect(memory.inFlight.get(f.vault)?.txId).toBe(first?.txIds.at(-1));
    // Still within its last valid block: nothing more for the vault.
    const held = of(await runRound(options, memory), f.vault);
    expect([held?.outcome, held?.alert, held?.txIds]).toEqual(['skipped', true, []]);
    expect(held?.reason).toMatch(/is not settled yet/);
    // Past its last valid block it can no longer land: the vault is planned, and a leg sent, again.
    s.node.advance(120);
    s.writePrices(s.node.now());
    const again = of(await runRound(options, memory), f.vault);
    expect(again?.reason).toMatch(/expired/);
    expect(again?.txIds).toHaveLength(1);
    expect(sends).toBeGreaterThan(vaultSends);
  }, 30_000);

  it('leaves a vault that holds an asset switched off for the keeper, and sends nothing', async () => {
    const s = await world();
    const f = s.w.fixture;
    // Gate UNIVERSE: an asset with no oracle is the owner's to trade. The program values every
    // position a leg does not trade by its reference, so while the vault holds gamma no leg passes.
    const gamma = s.w.mints.gamma;
    if (!gamma) throw new Error('mints');
    await s.w.run(s.w.keys.deployer, [
      await upsertAsset(s.w.keys.deployer.address, gamma.address, {
        priceIndex: SHELF.gamma.index,
        twapIndex: SHELF.gamma.index + 1,
        keeperOn: false,
        minPrice: BigInt(SHELF.gamma.usd * 800_000),
        maxPrice: BigInt(SHELF.gamma.usd * 1_200_000),
      }),
    ]);
    // Work to do: the next version moves the weights.
    await s.w.must(
      await s.w.adapter.buildPublishRecipe({ creator: f.owner, recipe: f.publishRecipe }),
    );
    s.node.advance(PARAMS.publishDelayS + 1);
    s.writePrices(s.node.now());
    let built = 0;
    const adapter = {
      ...s.w.adapter,
      buildKeeperLeg: (...a: Parameters<SolanaVaultAdapter['buildKeeperLeg']>) => {
        built++;
        return s.w.adapter.buildKeeperLeg(...a);
      },
    } as SolanaVaultAdapter;
    const line = of(await round({ ...s, w: { ...s.w, adapter } }), f.vault);
    expect([line?.outcome, line?.reason, line?.alert]).toEqual([
      'adopted',
      'adopted version 2; no leg would pass: KeeperAssetOff',
      true,
    ]);
    expect(line?.txIds).toHaveLength(1);
    expect(built).toBe(0);
  });

  it('a withdrawal that lands between the plan and the leg: the real builder refuses the leg, and nothing is sent', async () => {
    const s = await world();
    const f = s.w.fixture;
    const real = s.w.adapter as SolanaVaultAdapter;
    let emptied: string | null = null;
    // The round has read the vault and planned a leg. Before the leg is built, the owner takes out
    // all of the token it would sell, with the real withdraw builder, and it lands.
    const adapter = {
      ...real,
      buildKeeperLeg: async (...args: Parameters<SolanaVaultAdapter['buildKeeperLeg']>) => {
        const [vault, trade] = args;
        if (vault === f.vault && emptied === null) {
          for (const tx of await real.buildWithdrawInKind({ vault, assets: [trade.sell] }))
            await s.w.must(tx);
          emptied = trade.sell;
        }
        return real.buildKeeperLeg(...args);
      },
    } as SolanaVaultAdapter;
    const lines = await runRound({
      adapter,
      sign: keeperSign(s),
      shuffle: (items) => [...items].sort(),
      settleMs: 5_000,
    });
    const line = of(lines, f.vault);
    expect(emptied).not.toBeNull();
    // The builder simulates the leg against the vault as it is now, and the program would refuse it.
    expect(line?.outcome).toBe('skipped');
    expect(line?.reason).toMatch(/would be refused: /);
    expect(line?.txIds).toEqual([]);
    // What the owner took out is out, and nothing came back in.
    const after = await real.getVault(f.vault);
    const left = [after?.cash, ...(after?.positions ?? [])].find((h) => h?.asset === emptied);
    expect(BigInt(left?.raw ?? '0')).toBe(0n);
  });

  it('plans and builds in a dry run, and sends nothing', async () => {
    const s = await world();
    const f = s.w.fixture;
    const before = await s.w.adapter.getVault(f.vault);
    let signed = 0;
    const lines = await runRound({
      adapter: s.w.adapter,
      dryRun: true,
      sign: async (tx) => {
        signed++;
        return keeperSign(s)(tx);
      },
      shuffle: (v) => [...v].sort(),
    });
    expect(of(lines, f.vault)?.outcome).toBe('would-act');
    expect(signed).toBe(0);
    expect((await s.w.adapter.getVault(f.vault))?.cash.raw).toBe(before?.cash.raw);
  });
});
