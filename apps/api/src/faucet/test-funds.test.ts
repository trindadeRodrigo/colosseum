import { createMockAdapter } from '@colosseum/chain-mock';
import {
  type ChainId,
  type FundingResponse,
  parseChainConfigs,
  parseFlags,
  TEST_FUNDS_LOW,
} from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { type ChainEntry, type ChainRegistry, createChainRegistry } from '../orders/chains';
import { Refusal } from '../orders/errors';
import {
  createTestFunds,
  faucetKeysFrom,
  TEST_FUNDS,
  type TestFundsSend,
  type TestFundsSender,
} from './test-funds';

// The test faucet's rules, without a chain or a database: what it refuses (mainnet, the mock, a person
// or the faucet over its daily count, a buy that needs more than one send gives, a send its float
// cannot cover), what it sends (what is missing with a small margin), and that a server with no key
// loads no sender at all.

const WALLET = 'So11111111111111111111111111111111111111112';

/** A chain on its real adapter, as the registry makes one: a test network unless said otherwise. */
function entryOn(chain: ChainId, network: 'testnet' | 'mainnet' | 'local' = 'testnet'): ChainEntry {
  const config = parseChainConfigs({ [`CHAIN_NETWORK_${chain.toUpperCase()}`]: network })[chain];
  return {
    chain,
    mode: 'live',
    provenance: network === 'mainnet' ? 'live' : 'sandbox',
    source: 'a node of the test network',
    config,
    // Only its asset list is read: the faucet's cash token, by id.
    adapter: createMockAdapter({ chain }),
  };
}

/** What GET /v1/funding read: `cash` and `gas` missing, in raw units. */
function funding(
  entry: ChainEntry,
  missing: { cash: string; gas: string },
  provenance: FundingResponse['provenance'] = entry.provenance,
): FundingResponse {
  const stamp = { source: 's', fetchedAt: '2026-10-06T12:00:00.000Z', method: 'm', provenance };
  return {
    chain: entry.chain,
    name: entry.config.name,
    mode: 'live',
    provenance,
    wallet: WALLET,
    cash: {
      ...stamp,
      asset: `${entry.chain}:usdc`,
      symbol: 'tUSDC',
      decimals: 6,
      haveRaw: '0',
      needRaw: missing.cash,
      missingRaw: missing.cash,
    },
    gas: {
      ...stamp,
      symbol: 'SOL',
      decimals: 9,
      haveRaw: '0',
      needRaw: missing.gas,
      missingRaw: missing.gas,
    },
    steps: 3,
    newVault: true,
    ok: missing.cash === '0' && missing.gas === '0',
  };
}

/** The gas a Solana float keeps for the faucet's own fees. */
const RESERVE = TEST_FUNDS.gasReserveRaw.solana ?? 0n;
/** A float that covers anything these tests ask. */
const PLENTY = async () => ({ cashRaw: 10n ** 15n, gasRaw: 10n ** 20n });

function faucet(
  chain: ChainId = 'solana',
  now = () => new Date('2026-10-06T12:00:00Z'),
  float: TestFundsSender['float'] = PLENTY,
) {
  const sent: TestFundsSend[] = [];
  const sender: TestFundsSender = {
    chain,
    float: vi.fn(float),
    send: vi.fn(async (order: TestFundsSend) => {
      sent.push(order);
      return [`tx${sent.length}`];
    }),
  };
  return { sent, sender, funds: createTestFunds({ senders: [sender], now }) };
}

const refusal = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Refusal);
  return err as Refusal;
};

describe('the test faucet', () => {
  it('sends what is missing for the buy, with a small margin, to the wallet the funding names', async () => {
    const entry = entryOn('solana');
    const { funds, sent } = faucet();
    const answer = await funds.send(
      'user-1',
      entry,
      funding(entry, { cash: '200000000', gas: '10100000' }),
    );
    // $200 of the test dollar and 1% over it; 0.0101 SOL and 25% over it, rounded up.
    expect(sent).toEqual([
      {
        to: WALLET,
        cashAddress: expect.any(String),
        cashRaw: 202_000_000n,
        gasRaw: 12_625_000n,
      },
    ]);
    expect(answer).toEqual({
      chain: 'solana',
      provenance: 'sandbox',
      wallet: WALLET,
      cash: { symbol: 'tUSDC', decimals: 6, raw: '202000000' },
      gas: { symbol: 'SOL', decimals: 9, raw: '12625000' },
      txIds: ['tx1'],
      left: TEST_FUNDS.perPerson - 1,
    });
    // The cash token's address is the chain's, read from its asset list, never from the request.
    const listed = await entry.adapter.listAssets();
    expect(sent[0]?.cashAddress).toBe(listed.find((a) => a.id === 'solana:usdc')?.address);
  });

  it('sends only gas when only gas is missing, and nothing when nothing is', async () => {
    const entry = entryOn('solana');
    const { funds, sent } = faucet();
    await funds.send('user-1', entry, funding(entry, { cash: '0', gas: '1000' }));
    expect(sent.map((s) => [s.cashRaw, s.gasRaw])).toEqual([[0n, 1250n]]);
    const none = await refusal(
      funds.send('user-1', entry, funding(entry, { cash: '0', gas: '0' })),
    );
    expect(none.status).toBe(409);
    expect(sent).toHaveLength(1);
  });

  it('refuses on mainnet in code, whatever the sender would do, and sends nothing', async () => {
    for (const network of ['mainnet', 'local'] as const) {
      const entry = entryOn('solana', network);
      const { funds, sender } = faucet();
      const no = await refusal(
        funds.send('user-1', entry, funding(entry, { cash: '1000000', gas: '1000' })),
      );
      expect(no.status).toBe(403);
      expect(no.body().error).toMatch(/test network only/);
      expect(sender.send).not.toHaveBeenCalled();
      expect(funds.offered(entry)).toBe(false);
    }
    // A test network's chain whose figures say they are live is refused too.
    const entry = entryOn('solana');
    const { funds, sender } = faucet();
    const live = await refusal(
      funds.send('user-1', entry, funding(entry, { cash: '1000000', gas: '1000' }, 'live')),
    );
    expect(live.status).toBe(403);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('refuses on the mock, which has its own MOCK funding route', async () => {
    const registry = createChainRegistry(parseFlags({}), parseChainConfigs({}), { seed: 't' });
    const mock = registry.get('solana');
    const { funds, sender } = faucet();
    expect(funds.offered(mock)).toBe(false);
    const no = await refusal(
      funds.send('user-1', mock, funding(mock, { cash: '1000000', gas: '1000' })),
    );
    expect(no.status).toBe(403);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('refuses a buy that needs more than one send gives, and counts nothing for it', async () => {
    const entry = entryOn('solana');
    const { funds, sender } = faucet();
    // $5,000 is the most; with its 1% margin, $4,951 is over it.
    const cash = String(4_951 * 1_000_000);
    const big = await refusal(funds.send('user-1', entry, funding(entry, { cash, gas: '0' })));
    expect(big.status).toBe(422);
    expect(big.body().error).toMatch(/\$5,000/);
    const gas = await refusal(
      funds.send('user-1', entry, funding(entry, { cash: '0', gas: '100000000' })),
    );
    expect(gas.status).toBe(422);
    expect(sender.send).not.toHaveBeenCalled();
    // Under the ceiling it sends, and the refusals above did not use up the person's three.
    for (let i = 0; i < TEST_FUNDS.perPerson; i += 1)
      await funds.send(
        'user-1',
        entry,
        funding(entry, { cash: String(4_950 * 1_000_000), gas: '0' }),
      );
    expect(sender.send).toHaveBeenCalledTimes(TEST_FUNDS.perPerson);
  });

  it('lets a person ask three times a day, then refuses until the day has passed', async () => {
    let at = new Date('2026-10-06T12:00:00Z').getTime();
    const entry = entryOn('solana');
    const { funds, sender } = faucet('solana', () => new Date(at));
    const ask = (who: string) =>
      funds.send(who, entry, funding(entry, { cash: '1000000', gas: '1000' }));
    expect((await ask('user-1')).left).toBe(2);
    expect((await ask('user-1')).left).toBe(1);
    expect((await ask('user-1')).left).toBe(0);
    const fourth = await refusal(ask('user-1'));
    expect(fourth.status).toBe(429);
    expect(fourth.body()).toMatchObject({ code: 'RATE_LIMITED', fix: 'Try again in 24 hours.' });
    expect(sender.send).toHaveBeenCalledTimes(3);
    // Somebody else still may.
    expect((await ask('user-2')).left).toBe(2);
    // A day later, the first person may again.
    at += 86_400_000;
    expect((await ask('user-1')).left).toBe(2);
  });

  it('sends nothing the float cannot cover, says which is low, and counts nothing for it', async () => {
    const entry = entryOn('solana');
    // $1 of test dollars and 0.0101 SOL missing: with margins, 1,010,000 and 12,625,000 raw
    const ask = (funds: ReturnType<typeof faucet>['funds']) =>
      funds.send('user-1', entry, funding(entry, { cash: '1000000', gas: '10100000' }));
    // Gas: what is sent plus the faucet's own fee reserve (0.005 SOL).
    const thin = faucet('solana', undefined, async () => ({
      cashRaw: 10n ** 12n,
      gasRaw: 12_625_000n + RESERVE - 1n,
    }));
    const gas = await refusal(ask(thin.funds));
    expect(gas.status).toBe(409);
    expect(gas.body().error).toBe(TEST_FUNDS_LOW.gas);
    expect(thin.sender.send).not.toHaveBeenCalled();
    // Cash: the float's test dollars.
    const poor = faucet('solana', undefined, async () => ({
      cashRaw: 1_009_999n,
      gasRaw: 10n ** 12n,
    }));
    const cash = await refusal(ask(poor.funds));
    expect(cash.status).toBe(409);
    expect(cash.body().error).toBe(TEST_FUNDS_LOW.cash);
    expect(poor.sender.send).not.toHaveBeenCalled();
    // Just enough: it sends, and the refusals above used none of the person's three.
    const enough = faucet('solana', undefined, async () => ({
      cashRaw: 1_010_000n,
      gasRaw: 12_625_000n + RESERVE,
    }));
    expect((await ask(enough.funds)).left).toBe(TEST_FUNDS.perPerson - 1);
  });

  it('sends one at a time: two people at once never both pass a float that covers one', async () => {
    const entry = entryOn('solana');
    // A float of exactly one send's worth, which each send spends.
    let float = { cashRaw: 1_010_000n, gasRaw: 12_625_000n + RESERVE };
    const sender: TestFundsSender = {
      chain: 'solana',
      float: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return float;
      },
      send: vi.fn(async (order: TestFundsSend) => {
        await new Promise((r) => setTimeout(r, 5));
        float = { cashRaw: float.cashRaw - order.cashRaw, gasRaw: float.gasRaw - order.gasRaw };
        return ['tx'];
      }),
    };
    const funds = createTestFunds({ senders: [sender] });
    const ask = (who: string) =>
      funds.send(who, entry, funding(entry, { cash: '1000000', gas: '10100000' }));
    const [a, b] = await Promise.allSettled([ask('user-a'), ask('user-b')]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    const refused = (
      a.status === 'rejected' ? a.reason : (b as PromiseRejectedResult).reason
    ) as Refusal;
    expect(refused.status).toBe(409);
    expect(sender.send).toHaveBeenCalledOnce();
    // and a refusal does not stop the next send in line
    float = { cashRaw: 10n ** 12n, gasRaw: 10n ** 12n };
    await expect(ask('user-c')).resolves.toMatchObject({ txIds: ['tx'] });
  });

  it('caps the gas of one send hard: at most 0.0005 ETH on Robinhood Chain', async () => {
    expect(TEST_FUNDS.maxGasRaw.robinhood).toBe(500_000_000_000_000n);
    const entry = entryOn('robinhood');
    const { funds, sender } = faucet('robinhood');
    // 0.0004 ETH missing is 0.0005 with its margin: sent; a wei more is not.
    await funds.send('user-1', entry, funding(entry, { cash: '0', gas: '400000000000000' }));
    const over = await refusal(
      funds.send('user-1', entry, funding(entry, { cash: '0', gas: '400000000000001' })),
    );
    expect(over.status).toBe(422);
    expect(sender.send).toHaveBeenCalledOnce();
  });

  it('stops everybody once the faucet has sent its daily count', async () => {
    const entry = entryOn('solana');
    const sender: TestFundsSender = {
      chain: 'solana',
      float: PLENTY,
      send: vi.fn(async () => ['tx']),
    };
    const funds = createTestFunds({
      senders: [sender],
      limits: { ...TEST_FUNDS, perDay: 2 },
      now: () => new Date('2026-10-06T12:00:00Z'),
    });
    const ask = (who: string) =>
      funds.send(who, entry, funding(entry, { cash: '1000000', gas: '1000' }));
    await ask('a');
    await ask('b');
    const third = await refusal(ask('c'));
    expect(third.status).toBe(429);
    expect(third.body().error).toMatch(/sent all it may today/);
    expect(sender.send).toHaveBeenCalledTimes(2);
  });

  it('answers a failed send with a fixed sentence, never what the node or the sender said', async () => {
    const entry = entryOn('solana');
    const log = vi.fn();
    const funds = createTestFunds({
      senders: [
        {
          chain: 'solana',
          float: PLENTY,
          send: async () => {
            throw new Error('POST https://devnet.example/?api-key=SECRET failed');
          },
        },
      ],
      log,
    });
    const failed = await refusal(
      funds.send('user-1', entry, funding(entry, { cash: '1000000', gas: '1000' })),
    );
    expect(failed.status).toBe(502);
    expect(JSON.stringify(failed.body())).not.toMatch(/SECRET|https?:/);
    // and writes the chain and the error's kind, never its message
    expect(log).toHaveBeenCalledWith({ chain: 'solana', error: 'Error' });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET|https?:/);
  });

  it('is not offered on a chain it holds no key for', async () => {
    const { funds } = faucet('robinhood');
    expect(funds.offered(entryOn('robinhood'))).toBe(true);
    expect(funds.offered(entryOn('solana'))).toBe(false);
    const no = await refusal(
      funds.send('user-1', entryOn('solana'), funding(entryOn('solana'), { cash: '1', gas: '1' })),
    );
    expect(no.status).toBe(404);
  });
});

describe('the faucet keys', () => {
  const registry = (entries: ChainEntry[]): ChainRegistry =>
    ({ active: () => entries }) as unknown as ChainRegistry;

  it('are none without a variable, so the signing file is never loaded', () => {
    expect(faucetKeysFrom({}, registry([entryOn('solana'), entryOn('robinhood')]))).toBeNull();
  });

  it('are taken only for a chain on a test network, never mainnet, a local copy or the mock', () => {
    const env = { TESTNET_FAUCET_SOLANA_KEY: ' [1,2] ', TESTNET_FAUCET_ROBINHOOD_KEY: '0xab' };
    expect(faucetKeysFrom(env, registry([entryOn('solana'), entryOn('robinhood')]))).toEqual({
      solana: '[1,2]',
      robinhood: '0xab',
    });
    expect(
      faucetKeysFrom(env, registry([entryOn('solana', 'mainnet'), entryOn('robinhood', 'local')])),
    ).toBeNull();
    const mock = createChainRegistry(parseFlags({}), parseChainConfigs({}), { seed: 't' });
    expect(faucetKeysFrom(env, mock)).toBeNull();
  });
});
