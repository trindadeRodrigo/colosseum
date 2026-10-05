import {
  associatedTokenAddress,
  pairAddress,
  type SolanaVaultAdapter,
} from '@colosseum/chain-solana/vault';
import type { BuiltTx } from '@colosseum/schemas';
import { type Address, getTransactionDecoder, lamports } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { newMemory, runRound, type VaultLine } from '../../apps/keeper/src/round';
import { priceAccountBytes } from '../solana-vault/admin';
import {
  buildContractWorld,
  type ContractWorld,
  id,
  newKey,
  PARAMS,
  PRICE_ENTRIES,
} from '../solana-vault/contract-world';
import {
  createSvmNode,
  MOCK_ROUTER_PROGRAM,
  PROGRAMS_BUILT,
  type SvmNode,
} from '../solana-vault/svm-node';

// The keeper's round against the real program and the test exchange in LiteSVM: a version of a shared
// portfolio adopted and the vault moved toward it by a leg; records that differ from the accounts
// synced or, where the policy refuses, skipped with an alert; a leg that reverted not sent again.

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

/** The keeper's round on the world: signed with the world's keeper key, the vaults in address order. */
function round(s: Setup) {
  return runRound({
    adapter: s.w.adapter as SolanaVaultAdapter,
    sign: (tx: BuiltTx) => s.w.sign(tx),
    shuffle: (items) => [...items].sort(),
    settleMs: 5_000,
    // The chain's clock, which LiteSVM moves at will.
    now: () => new Date(Number(s.node.now()) * 1000),
  });
}
const of = (lines: VaultLine[], vault: string) => lines.find((l) => l.vault === vault);

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

  it('does not send again a leg that reverted', async () => {
    const s = await world();
    const f = s.w.fixture;
    // What each sent leg bought, by its signature: a line's signatures say what its vault was sent.
    const bought = new Map<string, string | undefined>();
    // The exchange pays 3% less between the build and the landing, past the vault's tolerance: the leg
    // lands without a preflight and reverts. The pair is written directly, so LiteSVM's one blockhash,
    // which the built leg carries, stays good.
    const send = async (signed: string, tx: BuiltTx) => {
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
      const landed = s.node.land(
        getTransactionDecoder().decode(new Uint8Array(Buffer.from(signed, 'base64'))),
      );
      s.node.svm.setAccount({ ...account, data: original });
      bought.set(landed.signature, into);
      return { txId: landed.signature };
    };
    const memory = newMemory();
    const options = {
      adapter: s.w.adapter,
      sign: (tx: BuiltTx) => s.w.sign(tx),
      send,
      shuffle: <T>(v: T[]) => [...v].sort(),
      settleMs: 5_000,
      now: () => new Date(Number(s.node.now()) * 1000),
    };
    const first = of(await runRound(options, memory), f.vault);
    expect(first?.outcome).toBe('skipped');
    expect(first?.reason).toMatch(/reverted: ReceivedTooLittle; it is not sent again/);
    expect(first?.alert).toBe(true);
    const reverted = bought.get(first?.txIds.at(-1) ?? '');
    expect(reverted).toBe(id('alpha'));
    // The next round plans the same purchase again and does not send it; any leg it sends is another.
    const second = of(await runRound(options, memory), f.vault);
    const legs = second?.txIds.map((t) => bought.get(t)) ?? [];
    expect(legs.length).toBeGreaterThan(0);
    expect(legs).not.toContain(reverted);
    expect(
      [...memory.reverted].some((k) => k.startsWith(`${f.vault} `) && k.endsWith(`->${reverted}`)),
    ).toBe(true);
  });

  it('plans and builds in a dry run, and sends nothing', async () => {
    const s = await world();
    const f = s.w.fixture;
    const before = await s.w.adapter.getVault(f.vault);
    let signed = 0;
    const lines = await runRound({
      adapter: s.w.adapter,
      dryRun: true,
      now: () => new Date(Number(s.node.now()) * 1000),
      sign: async (tx) => {
        signed++;
        return s.w.sign(tx);
      },
      shuffle: (v) => [...v].sort(),
    });
    expect(of(lines, f.vault)?.outcome).toBe('would-act');
    expect(signed).toBe(0);
    expect((await s.w.adapter.getVault(f.vault))?.cash.raw).toBe(before?.cash.raw);
  });
});
