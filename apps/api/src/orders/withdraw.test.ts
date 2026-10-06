import { mockAddress } from '@colosseum/chain-mock';
import {
  type ChainId,
  chainFamily,
  type Leg,
  type Principal,
  parseChainConfigs,
  parseFlags,
} from '@colosseum/schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import { type ChainEntry, type ChainRegistry, createChainRegistry } from './chains';
import { Refusal } from './errors';
import {
  buildWithdraw,
  planWithdraw,
  SELL_TO_CASH_NOT_OFFERED,
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
    const taken = plan.steps.flatMap((s) => s.withdrawals);
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
