import { mockAddress } from '@colosseum/chain-mock';
import {
  ChainError,
  type ChainId,
  chainFamily,
  type Leg,
  type Principal,
  parseChainConfigs,
  parseFlags,
} from '@colosseum/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChainEntry, type ChainRegistry, createChainRegistry } from './chains';
import { Refusal } from './errors';
import {
  buildWithdraw,
  planWithdraw,
  SELL_TO_CASH_NOT_OFFERED,
  SkippedStep,
  WHOLE_TOKEN_ONLY,
  type WithdrawRequest,
} from './withdraw';

// A withdrawal, planned and built against the mock chain with no database: whose vault it may be, what
// it may take, and what becomes of an order once the vault has changed under it. The same cases run on
// both chain families: Solana takes a token per step, an EVM vault all of them in one.

const usd = (dollars: number) => (BigInt(dollars) * 1_000_000n).toString();
const CHAINS: ChainId[] = ['solana', 'robinhood'];

type World = {
  chain: ChainId;
  chains: ChainRegistry;
  entry: ChainEntry;
  owner: string;
  stranger: string;
  vault: string;
  cash: string;
  spy: string;
  me: Principal;
  them: Principal;
};

const person = (chain: ChainId, address: string): Principal => ({
  kind: 'user',
  userId: `did:test:${address}`,
  wallets: [{ family: chainFamily(chain), address, kind: 'external' }],
  ip: '127.0.0.1',
});

/** A vault of `owner` holding $600 of cash and $400 worth of one stock token, and a stranger. */
async function world(chain: ChainId): Promise<World> {
  const chains = createChainRegistry(parseFlags({}), parseChainConfigs({}), { seed: 'withdraw' });
  const entry = chains.get(chain);
  const { adapter, mock } = entry;
  if (!mock) throw new Error('the registry is not on the mock');
  const owner = mockAddress(chain, 'withdraw owner');
  const stranger = mockAddress(chain, 'withdraw stranger');
  const spy = `${chain}:spy`;
  for (const who of [owner, stranger])
    mock.fund(who, { gasRaw: '1000000000000000000', assets: { [mock.cash]: usd(10_000) } });

  if (adapter.capabilities.needsApprove)
    await mock.send(await adapter.buildApprove({ owner, basketId: '7', amountRaw: usd(1_000) }));
  await mock.send(
    await adapter.buildCreateVault({
      owner,
      basketId: '7',
      targets: [{ asset: spy, weightBps: 4_000 }],
      autoFollow: false,
      depositRaw: usd(1_000),
      slippageBps: 100,
    }),
  );
  const [state] = await adapter.getVaults(owner);
  if (!state) throw new Error('no vault was opened');
  await mock.send(
    await adapter.buildOwnerSwap({
      vault: state.address,
      trades: [{ sell: mock.cash, buy: spy, amountInRaw: usd(400) }],
      slippageBps: 100,
    }),
  );
  return {
    chain,
    chains,
    entry,
    owner,
    stranger,
    vault: state.address,
    cash: mock.cash,
    spy,
    me: person(chain, owner),
    them: person(chain, stranger),
  };
}

const everything = (w: World): WithdrawRequest => ({
  type: 'withdraw',
  vaults: [w.vault],
  sellToCash: false,
});

const refusal = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Refusal);
  return err as Refusal;
};

/** A planned step as a stored leg, as far as a build reads it. */
const legOf = (step: Awaited<ReturnType<typeof planWithdraw>>['steps'][number]): Leg =>
  ({ id: 'leg', kind: step.kind, chain: step.chain, withdrawals: step.withdrawals }) as Leg;

const holds = async (w: World, who: string, asset: string) =>
  BigInt((await w.entry.adapter.getWalletHoldings(who)).find((h) => h.asset === asset)?.raw ?? 0);
const inVault = async (w: World, asset: string) => {
  const v = await w.entry.adapter.getVault(w.vault);
  return BigInt([v?.cash, ...(v?.positions ?? [])].find((h) => h?.asset === asset)?.raw ?? '0');
};

describe.each(CHAINS)('a withdrawal on %s', (chain) => {
  let w: World;
  beforeEach(async () => {
    w = await world(chain);
  });

  it('plans everything the vault holds, for its owner’s own wallet, and builds nothing', async () => {
    const plan = await planWithdraw(everything(w), { principal: w.me, chains: w.chains });
    expect(plan.owner).toBe(w.owner);
    expect(plan.vault).toBe(w.vault);
    const taken = plan.steps.flatMap((s) => s.withdrawals ?? []);
    expect(taken.map((t) => [t.asset, t.amountRaw])).toEqual([
      [w.cash, null],
      [w.spy, null],
    ]);
    expect(taken[0]?.heldRaw).toBe(usd(600));
    // a token per step on Solana, all in one on an EVM chain
    expect(plan.steps).toHaveLength(chainFamily(chain) === 'solana' ? 2 : 1);
    for (const s of plan.steps) expect(s.description).toContain(w.owner);
    // nothing moved
    expect(await inVault(w, w.cash)).toBe(BigInt(usd(600)));
  });

  it('refuses a vault that is another person’s, as a vault that is not there', async () => {
    const theirs = await refusal(
      planWithdraw(everything(w), { principal: w.them, chains: w.chains }),
    );
    expect(theirs.status).toBe(404);
    const none = await refusal(
      planWithdraw(
        { ...everything(w), vaults: [mockAddress(chain, 'no such vault')] },
        { principal: w.me, chains: w.chains },
      ),
    );
    expect(none.status).toBe(404);
    expect(theirs.body().error).toBe(none.body().error);
  });

  it('refuses selling to cash, with the sentence the screen shows, and a second vault', async () => {
    const sell = await refusal(
      planWithdraw({ ...everything(w), sellToCash: true }, { principal: w.me, chains: w.chains }),
    );
    expect(sell.status).toBe(422);
    expect(sell.body().error).toBe(SELL_TO_CASH_NOT_OFFERED);
    const two = await refusal(
      planWithdraw(
        { ...everything(w), vaults: [w.vault, w.vault] },
        { principal: w.me, chains: w.chains },
      ),
    );
    expect(two.status).toBe(422);
  });

  it('refuses a token the vault does not hold, and one named twice', async () => {
    const ctx = { principal: w.me, chains: w.chains };
    const none = await refusal(
      planWithdraw({ ...everything(w), withdrawals: [{ asset: `${chain}:nvda` }] }, ctx),
    );
    expect(none.status).toBe(409);
    const twice = await refusal(
      planWithdraw({ ...everything(w), withdrawals: [{ asset: w.cash }, { asset: w.cash }] }, ctx),
    );
    expect(twice.status).toBe(422);
  });

  it('builds each step for the owner, and the tokens land in the owner’s wallet and nowhere else', async () => {
    const before = {
      cash: await holds(w, w.owner, w.cash),
      theirs: await holds(w, w.stranger, w.cash),
    };
    const request = everything(w);
    const plan = await planWithdraw(request, { principal: w.me, chains: w.chains });
    for (const step of plan.steps) {
      const tx = await buildWithdraw(request, legOf(step), w.entry, w.owner, undefined);
      expect(tx.signer).toBe(w.owner);
      await w.entry.mock?.send(tx);
    }
    expect(await inVault(w, w.cash)).toBe(0n);
    expect(await inVault(w, w.spy)).toBe(0n);
    expect((await holds(w, w.owner, w.cash)) - before.cash).toBe(BigInt(usd(600)));
    expect(await holds(w, w.owner, w.spy)).toBeGreaterThan(0n);
    expect(await holds(w, w.stranger, w.cash)).toBe(before.theirs);
    expect(await holds(w, w.stranger, w.spy)).toBe(0n);
  });

  it('builds nothing for an order whose owner is not the vault’s', async () => {
    const request = everything(w);
    const plan = await planWithdraw(request, { principal: w.me, chains: w.chains });
    const step = plan.steps[0];
    if (!step) throw new Error('no step');
    const no = await refusal(buildWithdraw(request, legOf(step), w.entry, w.stranger, undefined));
    expect(no.status).toBe(404);
  });

  it('takes part of the cash: that much leaves for the owner, the rest and the other tokens stay', async () => {
    const before = await holds(w, w.owner, w.cash);
    const spy = await inVault(w, w.spy);
    const request: WithdrawRequest = {
      ...everything(w),
      withdrawals: [{ asset: w.cash, amountRaw: usd(250) }],
    };
    const now = '2026-10-06T12:00:00.000Z';
    const plan = await planWithdraw(request, { principal: w.me, chains: w.chains, now });
    expect(plan.steps).toHaveLength(1);
    // valued as it is ordered: the dollar token at one dollar, and where that figure is from
    expect(plan.steps[0]?.withdrawals).toEqual([
      {
        asset: w.cash,
        amountRaw: usd(250),
        heldRaw: usd(600),
        valued: {
          usd: '250.00',
          source: w.entry.source,
          method: expect.stringContaining('one dollar'),
          fetchedAt: now,
          provenance: w.entry.provenance,
        },
      },
    ]);
    expect(plan.steps[0]?.description).toContain('250 ');
    const step = plan.steps[0];
    if (!step) throw new Error('no step');
    await w.entry.mock?.send(
      await buildWithdraw(request, legOf(step), w.entry, w.owner, undefined),
    );
    expect(await inVault(w, w.cash)).toBe(BigInt(usd(350)));
    expect(await inVault(w, w.spy)).toBe(spy);
    expect((await holds(w, w.owner, w.cash)) - before).toBe(BigInt(usd(250)));
    expect(await holds(w, w.stranger, w.spy)).toBe(0n);
  });

  it('values a token at the chain’s reference price as it is ordered, to the cent and never above, and gives no value where there is no price', async () => {
    const [price] = await w.entry.adapter.getPrices([w.spy]);
    if (!price) throw new Error('no price');
    const raw = (await inVault(w, w.spy)) / 3n;
    const request: WithdrawRequest = {
      ...everything(w),
      withdrawals: [{ asset: w.spy, amountRaw: raw.toString() }],
    };
    const plan = await planWithdraw(request, { principal: w.me, chains: w.chains });
    const valued = plan.steps.flatMap((s) => s.withdrawals ?? [])[0]?.valued;
    const decimals = (await w.entry.adapter.listAssets()).find((a) => a.id === w.spy)?.decimals;
    const exact = (Number(raw) / 10 ** (decimals ?? 0)) * Number(price.usdPerToken);
    expect(valued?.usd).toMatch(/^\d+\.\d{2}$/);
    expect(Number(valued?.usd)).toBeLessThanOrEqual(exact + 1e-9);
    expect(Number(valued?.usd)).toBeGreaterThan(exact - 0.011);
    expect(valued).toMatchObject({
      source: price.source,
      fetchedAt: price.fetchedAt,
      provenance: price.provenance,
    });

    // a chain whose prices do not answer: the withdrawal is still planned, with no figure made up
    vi.spyOn(w.entry.adapter, 'getPrices').mockRejectedValueOnce(
      new ChainError('Unavailable', 'no prices'),
    );
    const blind = await planWithdraw(request, { principal: w.me, chains: w.chains });
    expect(blind.steps.flatMap((s) => s.withdrawals ?? [])).toEqual([
      { asset: w.spy, amountRaw: raw.toString(), heldRaw: (await inVault(w, w.spy)).toString() },
    ]);
  });

  it('takes exactly the balance, and refuses one unit over it, and an amount of nothing', async () => {
    const ctx = { principal: w.me, chains: w.chains };
    const of = (raw: string): WithdrawRequest => ({
      ...everything(w),
      withdrawals: [{ asset: w.cash, amountRaw: raw }],
    });
    const over = await refusal(planWithdraw(of((BigInt(usd(600)) + 1n).toString()), ctx));
    expect(over.status).toBe(409);
    expect(over.body().error).toMatch(/^the vault holds 600 .*less than the 600\.000001 /);
    expect((await refusal(planWithdraw(of('0'), ctx))).status).toBe(422);
    // nothing left the vault for either
    expect(await inVault(w, w.cash)).toBe(BigInt(usd(600)));

    const exact = of(usd(600));
    const plan = await planWithdraw(exact, ctx);
    const step = plan.steps[0];
    if (!step) throw new Error('no step');
    await w.entry.mock?.send(await buildWithdraw(exact, legOf(step), w.entry, w.owner, undefined));
    expect(await inVault(w, w.cash)).toBe(0n);
    expect(await inVault(w, w.spy)).toBeGreaterThan(0n);
  });

  it('builds nothing for an amount the vault no longer holds when the step is built', async () => {
    const ctx = { principal: w.me, chains: w.chains };
    const of = (dollars: number): WithdrawRequest => ({
      ...everything(w),
      withdrawals: [{ asset: w.cash, amountRaw: usd(dollars) }],
    });
    // Two orders planned against the same $600: $500, and $200. Together they are more than is there.
    const [large, small] = await Promise.all([
      planWithdraw(of(500), ctx),
      planWithdraw(of(200), ctx),
    ]);
    const [a, b] = [large.steps[0], small.steps[0]];
    if (!a || !b) throw new Error('no step');
    await w.entry.mock?.send(await buildWithdraw(of(200), legOf(b), w.entry, w.owner, undefined));
    const late = await refusal(buildWithdraw(of(500), legOf(a), w.entry, w.owner, undefined));
    expect(late.status).toBe(409);
    expect(late.body().error).toMatch(/now holds 400 .*less than the 500 .*nothing was built/);
    expect(await inVault(w, w.cash)).toBe(BigInt(usd(400)));
  });

  it('switches auto-follow off first on a vault that has it on, whatever is withdrawn, and the keeper no longer visits it', async () => {
    const { adapter, mock } = w.entry;
    await mock?.send(await adapter.buildSetAutoFollow({ vault: w.vault, on: true }));
    expect(await adapter.listAutoFollowVaults()).toContain(w.vault);
    const ctx = { principal: w.me, chains: w.chains };
    for (const request of [
      everything(w),
      { ...everything(w), withdrawals: [{ asset: w.spy }] },
      { ...everything(w), withdrawals: [{ asset: w.cash, amountRaw: usd(1) }] },
    ] satisfies WithdrawRequest[]) {
      const plan = await planWithdraw(request, ctx);
      expect(plan.steps.map((s) => s.kind)).toEqual([
        'set_auto_follow',
        ...plan.steps.slice(1).map(() => 'withdraw'),
      ]);
      expect(plan.steps[0]?.withdrawals).toBeUndefined();
      expect(plan.steps[0]?.description).toMatch(/automatic following stops for this vault/);
    }
    // built as a switch off, for the owner, and never on; once it lands the keeper's list drops the vault
    const request = everything(w);
    const [off, ...rest] = (await planWithdraw(request, ctx)).steps;
    if (!off) throw new Error('no first step');
    const tx = await buildWithdraw(request, legOf(off), w.entry, w.owner, undefined);
    expect(tx.legKind).toBe('set_auto_follow');
    expect(tx.signer).toBe(w.owner);
    await mock?.send(tx);
    expect((await adapter.getVault(w.vault))?.autoFollow).toBe(false);
    expect(await adapter.listAutoFollowVaults()).not.toContain(w.vault);
    for (const step of rest)
      await mock?.send(await buildWithdraw(request, legOf(step), w.entry, w.owner, undefined));
    expect(await inVault(w, w.cash)).toBe(0n);
  });

  it('plans no switch for a vault with auto-follow off', async () => {
    const plan = await planWithdraw(everything(w), { principal: w.me, chains: w.chains });
    expect(plan.steps.every((s) => s.kind === 'withdraw')).toBe(true);
  });

  it('a token that cannot move: its step is a skip with the reason, never a failed order', async () => {
    // The stock token's account is frozen by its issuer, as a real adapter says it.
    const frozen = new ChainError(
      'BalanceUnreadable',
      "the vault's account of it is frozen by its issuer",
    );
    const stuck: ChainEntry = {
      ...w.entry,
      adapter: {
        ...w.entry.adapter,
        buildWithdrawInKind: async (a) => {
          if (a.assets?.includes(w.spy)) throw frozen;
          return w.entry.adapter.buildWithdrawInKind(a);
        },
      },
    };
    const request: WithdrawRequest = {
      ...everything(w),
      withdrawals: [{ asset: w.spy }, { asset: w.cash }],
    };
    const plan = await planWithdraw(request, { principal: w.me, chains: w.chains });
    if (chainFamily(chain) === 'solana') {
      const [spy, cash] = plan.steps;
      if (!spy || !cash) throw new Error('no steps');
      const skip = await buildWithdraw(request, legOf(spy), stuck, w.owner, undefined).catch(
        (e: unknown) => e,
      );
      expect(skip).toBeInstanceOf(SkippedStep);
      expect((skip as SkippedStep).code).toBe('BalanceUnreadable');
      expect((skip as SkippedStep).reason).toMatch(/frozen by its issuer/);
      expect((skip as SkippedStep).status).toBe(409);
      // the other token's step is built and lands
      await w.entry.mock?.send(
        await buildWithdraw(request, legOf(cash), stuck, w.owner, undefined),
      );
      expect(await inVault(w, w.cash)).toBe(0n);
      expect(await inVault(w, w.spy)).toBeGreaterThan(0n);
    } else {
      // One transaction for both: it is refused as a whole, and nothing is skipped behind the person.
      const [both] = plan.steps;
      if (!both) throw new Error('no step');
      const no = await buildWithdraw(request, legOf(both), stuck, w.owner, undefined).catch(
        (e: unknown) => e,
      );
      expect(no).toBe(frozen);
    }
  });

  /** What building the one-token step answers when the chain's builder refuses it with `code`. */
  const refusedWith = async (code: ChainError['code'], message: string) => {
    const refusing: ChainEntry = {
      ...w.entry,
      adapter: {
        ...w.entry.adapter,
        buildWithdrawInKind: async () => {
          throw new ChainError(code, message);
        },
      },
    };
    const request: WithdrawRequest = { ...everything(w), withdrawals: [{ asset: w.cash }] };
    const plan = await planWithdraw(request, { principal: w.me, chains: w.chains });
    const step = plan.steps[0];
    if (!step) throw new Error('no step');
    return buildWithdraw(request, legOf(step), refusing, w.owner, undefined).catch(
      (x: unknown) => x,
    );
  };

  it.each([
    ['NoGas', 'the wallet cannot pay the network fee'],
    ['Unknown', 'the simulation failed'],
    ['Unavailable', 'the node did not answer'],
    ['BadInput', 'a malformed amount'],
    ['VaultNotFound', 'no vault'],
    ['NotOwner', 'not the owner'],
    ['Expired', 'built too long ago'],
    ['GasTooLow', 'too little gas'],
  ] as const)(
    '%s is never a skip: the step is refused as it is, to be built again',
    async (code, message) => {
      const e = await refusedWith(code, message);
      expect(e).not.toBeInstanceOf(SkippedStep);
      expect(e).toBeInstanceOf(ChainError);
      expect((e as ChainError).code).toBe(code);
    },
  );

  it.each([
    ['BalanceUnreadable', "the vault's account of it is frozen by its issuer"],
    ['NotSupported', 'its issuer added a transfer hook program'],
  ] as const)(
    '%s is a skip, with its reason: the token itself cannot move',
    async (code, message) => {
      const e = await refusedWith(code, message);
      expect(e).toBeInstanceOf(SkippedStep);
      expect([(e as SkippedStep).code, (e as SkippedStep).reason]).toEqual([code, message]);
    },
  );

  it('takes no part of a token the app does not list: all of it or none, with the screen’s sentence', async () => {
    // The stock token as one the app's list does not have: its units are not known here.
    const unlisted: ChainRegistry = {
      ...w.chains,
      get: (c) => {
        const entry = w.chains.get(c);
        return {
          ...entry,
          adapter: {
            ...entry.adapter,
            listAssets: async () =>
              (await entry.adapter.listAssets()).filter((a) => a.id !== w.spy),
          },
        };
      },
    };
    const ctx = { principal: w.me, chains: unlisted };
    const part = await refusal(
      planWithdraw({ ...everything(w), withdrawals: [{ asset: w.spy, amountRaw: '1' }] }, ctx),
    );
    expect(part.status).toBe(422);
    expect(part.body().error).toBe(WHOLE_TOKEN_ONLY);
    const whole = await planWithdraw({ ...everything(w), withdrawals: [{ asset: w.spy }] }, ctx);
    expect(whole.steps.flatMap((s) => s.withdrawals ?? []).map((x) => x.amountRaw)).toEqual([null]);
  });

  it('two withdrawals racing: the first empties the vault, the second builds nothing and says so', async () => {
    const request = everything(w);
    const ctx = { principal: w.me, chains: w.chains };
    const [first, second] = await Promise.all([
      planWithdraw(request, ctx),
      planWithdraw(request, ctx),
    ]);
    for (const step of first.steps)
      await w.entry.mock?.send(
        await buildWithdraw(request, legOf(step), w.entry, w.owner, undefined),
      );
    for (const step of second.steps) {
      const late = await refusal(buildWithdraw(request, legOf(step), w.entry, w.owner, undefined));
      expect(late.status).toBe(409);
      expect(late.body().error).toMatch(/nothing was built/);
      expect(late.body().fix).toBe('Make the withdrawal again.');
    }
    // and a new order for an emptied vault is refused as plainly
    const empty = await refusal(planWithdraw(request, ctx));
    expect(empty.status).toBe(409);
    expect(empty.body().error).toBe('the vault holds nothing to withdraw');
  });
});
