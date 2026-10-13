// Read-only: which Uniswap v4 pool against the dollar token each listed stock token trades in on
// Robinhood Chain mainnet, and what a deposit-sized trade costs there. Sends nothing and holds no key.
//
//   pnpm exec tsx packages/chain-evm/test/pool-quotes.ts [out.json]
//   RH_POOLS_BLOCK=<block> RH_POOLS_ONLY=NVDA,META pnpm exec tsx packages/chain-evm/test/pool-quotes.ts
//
// For each token it lists the hookless v4 pools against USDG (the PoolManager's Initialize events,
// then the four standard shapes in case the node cut the log range), reads each pool's price and
// liquidity in range from the StateView, and asks Uniswap's v4 Quoter what selling and buying $100,
// $1,000 and $10,000 pays. Cost is against the pool's own mid price at the same block, fee included.
// One block for everything, one call at a time with a pause: the chain's own node refuses bursts.
//
// Everything is read at one block, so the node has to keep that block's state for the minutes the run
// takes: RH_POOLS_RPC_URL (default https://robinhood.drpc.org, which does; the chain's own node drops
// a block's state within minutes). The pools are listed from RH_POOLS_LOGS_RPC_URL (default the
// chain's own node, which answers ten million blocks of logs at a time). A URL with a key in it is
// never printed: the output names the hosts only.

import { writeFileSync } from 'node:fs';
import {
  type Address,
  createPublicClient,
  encodeAbiParameters,
  type Hex,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
} from 'viem';

const URL_ = process.env.RH_POOLS_RPC_URL ?? 'https://robinhood.drpc.org';
const LOGS_URL = process.env.RH_POOLS_LOGS_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const PAUSE_MS = Number(process.env.RH_POOLS_PAUSE_MS ?? 600);

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;
// Uniswap v4 on Robinhood Chain (scripts/risk-evm/config.ts).
const QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as Address;
const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' as Address;
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/** The eleven tokens the test network models, with their Chainlink feeds (scripts/risk/universe/robinhood.json). */
const TOKENS: { symbol: string; token: Address; feed: Address }[] = [
  [
    'SPY',
    '0x117cc2133c37b721f49de2a7a74833232b3b4c0c',
    '0x319724394d3a0e3669269846abe664cd621f9f6a',
  ],
  [
    'QQQ',
    '0xd5f3879160bc7c32ebb4dc785f8a4f505888de68',
    '0x80901d846d5d7b030f26b480776ee3b29374c2ae',
  ],
  [
    'NVDA',
    '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
    '0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15',
  ],
  [
    'AAPL',
    '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9',
    '0x6b22a786baa607d76728168703a39ea9c99f2cd0',
  ],
  [
    'MSFT',
    '0xe93237c50d904957cf27e7b1133b510c669c2e74',
    '0x45c3c877c15e6ba2ebb19ea114ea508d14c1af2e',
  ],
  [
    'GOOGL',
    '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3',
    '0xf6f373a037c30f0e5010d854385ca89185ae638b',
  ],
  [
    'AMZN',
    '0x12f190a9f9d7d37a250758b26824b97ce941bf54',
    '0xd5a1508ced74c084ebf3cbe853e2c968fb2a651c',
  ],
  [
    'META',
    '0xc0d6457c16cc70d6790dd43521c899c87ce02f35',
    '0x7c38c00c30bee9378381e7b6135d7283356d71b1',
  ],
  [
    'TSLA',
    '0x322f0929c4625ed5bad873c95208d54e1c003b2d',
    '0x4a1166a659a55625345e9515b32adecea5547c38',
  ],
  [
    'GLD',
    '0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e',
    '0x470a51258068043bd43dc0a56245625c9fe86eb0',
  ],
  [
    'SGOV',
    '0x92fd66527192e3e61d4ddd13322aa222de86f9b5',
    '0xa0df4ee0fff975306345875e3548fcc519577a11',
  ],
].map(([symbol, token, feed]) => ({ symbol, token: token as Address, feed: feed as Address })) as {
  symbol: string;
  token: Address;
  feed: Address;
}[];

const STANDARD = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
];
/** RH_POOLS_SIZES=10000,50000,250000 asks other sizes, for the capacity of a pool. */
const SIZES_USD = process.env.RH_POOLS_SIZES?.split(',').map(Number) ?? [100, 1_000, 10_000];
/** 1%, in Uniswap's hundredths of a basis point: the dearest of the four standard fees. */
const MAX_FEE = 10_000;
/** For a second run of some tokens only: RH_POOLS_ONLY=NVDA,META. */
const ONLY = process.env.RH_POOLS_ONLY?.split(',').map((x) => x.trim().toUpperCase());
/** The block to read at; left out, a few blocks behind the head. */
const AT = process.env.RH_POOLS_BLOCK ? BigInt(process.env.RH_POOLS_BLOCK) : undefined;

const TOKEN_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function paused() view returns (bool)',
]);
const FEED_ABI = parseAbi([
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
]);
const STATE_ABI = parseAbi([
  'function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 id) view returns (uint128)',
]);
const QUOTER_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
const INITIALIZE = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);

const client = createPublicClient({ transport: http(URL_, { retryCount: 0, timeout: 30_000 }) });
const logsClient = createPublicClient({
  transport: http(LOGS_URL, { retryCount: 0, timeout: 60_000 }),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One call, after a pause; a busy node is asked again after 5, 15, 30 and 60 seconds. */
async function slow<T>(what: string, f: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await sleep(PAUSE_MS + [0, 5_000, 15_000, 30_000, 60_000][attempt]!);
    try {
      return await f();
    } catch (e) {
      last = e;
      const text = e instanceof Error ? e.message : String(e);
      if (process.env.RH_POOLS_VERBOSE)
        console.error(
          `${what}, attempt ${attempt + 1}: ${text
            .split('\n')
            .slice(0, 3)
            .join(' | ')
            .replace(/https?:\/\/\S+/g, '<url>')}`,
        );
      if (/revert|narrow the block range/i.test(text) && !/429|rate limit/i.test(text)) throw e;
    }
  }
  throw new Error(`${what}: ${last instanceof Error ? last.message.split('\n')[0] : 'no answer'}`);
}

const sorted = (a: Address, b: Address): [Address, Address] =>
  BigInt(a) < BigInt(b) ? [a, b] : [b, a];
const poolId = (c0: Address, c1: Address, fee: number, tickSpacing: number): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [c0, c1, fee, tickSpacing, ZERO],
    ),
  );

async function main() {
  const out = process.argv[2];
  const blockNumber = await slow('eth_blockNumber', () => client.getBlockNumber());
  // A few blocks back, so a node that lags the head still has the state.
  const at = AT ?? blockNumber - 5n;
  const block = await slow('eth_getBlockByNumber', () => client.getBlock({ blockNumber: at }));
  const chainId = await slow('eth_chainId', () => client.getChainId());
  if (chainId !== 4663) throw new Error(`the node answers chain id ${chainId}, not 4663`);
  const usdgDecimals = await slow('USDG decimals', () =>
    client.readContract({
      address: USDG,
      abi: TOKEN_ABI,
      functionName: 'decimals',
      blockNumber: at,
    }),
  );

  const rows = [];
  for (const t of TOKENS.filter((x) => !ONLY || ONLY.includes(x.symbol))) {
    const read = <T>(address: Address, abi: typeof TOKEN_ABI | typeof FEED_ABI, fn: string) =>
      slow(`${t.symbol} ${fn}`, () =>
        client.readContract({
          address,
          abi: abi as typeof TOKEN_ABI,
          functionName: fn as 'symbol',
          blockNumber: at,
        }),
      ) as Promise<T>;
    const symbol = await read<string>(t.token, TOKEN_ABI, 'symbol');
    const decimals = await read<number>(t.token, TOKEN_ABI, 'decimals');
    const paused = await read<boolean>(t.token, TOKEN_ABI, 'paused').catch(() => null);
    const description = await read<string>(t.feed, FEED_ABI, 'description');
    const feedDecimals = await read<number>(t.feed, FEED_ABI, 'decimals');
    const round = await read<readonly [bigint, bigint, bigint, bigint, bigint]>(
      t.feed,
      FEED_ABI,
      'latestRoundData',
    );
    const feedUsd = Number(round[1]) / 10 ** feedDecimals;
    const feedAgeSeconds = Number(block.timestamp - round[3]);

    const [c0, c1] = sorted(USDG, t.token);
    // Every pool of the pair the PoolManager ever initialised, hooked or not.
    let fromLogs: { fee: number; tickSpacing: number; hooks: Address }[] | null = null;
    try {
      // The chain's node answers ten million blocks of logs at a time.
      const SPAN = 10_000_000n;
      fromLogs = [];
      for (let from = 0n; from <= at; from += SPAN) {
        const to = from + SPAN - 1n < at ? from + SPAN - 1n : at;
        const logs = await slow(`${t.symbol} Initialize logs`, () =>
          logsClient.getLogs({
            address: POOL_MANAGER,
            event: INITIALIZE,
            args: { currency0: c0, currency1: c1 },
            fromBlock: from,
            toBlock: to,
          }),
        );
        for (const l of logs)
          fromLogs.push({
            fee: Number(l.args.fee),
            tickSpacing: Number(l.args.tickSpacing),
            hooks: (l.args.hooks as Address).toLowerCase() as Address,
          });
      }
    } catch {
      fromLogs = null;
    }
    const hooked = (fromLogs ?? []).filter((p) => p.hooks !== ZERO).length;
    const shapes = new Map<string, { fee: number; tickSpacing: number }>();
    for (const p of [...STANDARD, ...(fromLogs ?? []).filter((p) => p.hooks === ZERO)])
      shapes.set(`${p.fee}/${p.tickSpacing}`, { fee: p.fee, tickSpacing: p.tickSpacing });

    const stockIs0 = c0.toLowerCase() === t.token.toLowerCase();
    const pools = [];
    for (const shape of shapes.values()) {
      const id = poolId(c0, c1, shape.fee, shape.tickSpacing);
      const slot0 = await slow(`${t.symbol} getSlot0`, () =>
        client.readContract({
          address: STATE_VIEW,
          abi: STATE_ABI,
          functionName: 'getSlot0',
          args: [id],
          blockNumber: at,
        }),
      );
      const sqrtPriceX96 = slot0[0];
      if (sqrtPriceX96 === 0n) continue;
      const liquidity = await slow(`${t.symbol} getLiquidity`, () =>
        client.readContract({
          address: STATE_VIEW,
          abi: STATE_ABI,
          functionName: 'getLiquidity',
          args: [id],
          blockNumber: at,
        }),
      );
      // currency1 per currency0, in raw units, then dollars per whole stock token.
      const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
      const midUsd = stockIs0
        ? ratio * 10 ** (decimals - usdgDecimals)
        : (1 / ratio) * 10 ** (decimals - usdgDecimals);
      const key = { currency0: c0, currency1: c1, ...shape, hooks: ZERO };
      const quote = async (tokenIn: Address, amountIn: bigint) => {
        try {
          const { result } = await slow(`${t.symbol} quote`, () =>
            client.simulateContract({
              address: QUOTER,
              abi: QUOTER_ABI,
              functionName: 'quoteExactInputSingle',
              args: [
                {
                  poolKey: key,
                  zeroForOne: tokenIn.toLowerCase() === c0.toLowerCase(),
                  exactAmount: amountIn,
                  hookData: '0x',
                },
              ],
              blockNumber: at,
            }),
          );
          return result[0];
        } catch {
          return null;
        }
      };
      const quotes = [];
      // A pool that takes more than MAX_FEE of every trade is nobody's route: its price and liquidity
      // are recorded, and it is not quoted.
      if (liquidity > 0n && shape.fee <= MAX_FEE)
        for (const usd of SIZES_USD) {
          const usdgIn = BigInt(usd) * 10n ** BigInt(usdgDecimals);
          const stockIn = BigInt(Math.round((usd / midUsd) * 1e9)) * 10n ** BigInt(decimals - 9);
          const bought = await quote(USDG, usdgIn);
          const sold = await quote(t.token, stockIn);
          // Against the pool's own mid, fee included: what the trade gives up, in basis points.
          const buyBps =
            bought === null
              ? null
              : (1 - ((Number(bought) / 10 ** decimals) * midUsd) / usd) * 10_000;
          const sellBps =
            sold === null ? null : (1 - Number(sold) / 10 ** usdgDecimals / usd) * 10_000;
          quotes.push({
            usd,
            buyBps: buyBps === null ? null : Math.round(buyBps * 10) / 10,
            sellBps: sellBps === null ? null : Math.round(sellBps * 10) / 10,
            buyOutRaw: bought?.toString() ?? null,
            sellInRaw: stockIn.toString(),
            sellOutRaw: sold?.toString() ?? null,
          });
        }
      pools.push({
        ...shape,
        poolId: id,
        liquidity: liquidity.toString(),
        midUsd: Math.round(midUsd * 1e4) / 1e4,
        midVsFeedBps: Math.round((midUsd / feedUsd - 1) * 100_000) / 10,
        quotes,
      });
    }
    pools.sort((a, b) => (BigInt(b.liquidity) > BigInt(a.liquidity) ? 1 : -1));
    const row = {
      symbol,
      asked: t.symbol,
      token: t.token,
      decimals,
      paused,
      feed: t.feed,
      feedDescription: description,
      feedDecimals,
      feedUsd,
      feedAgeSeconds,
      poolsFrom:
        fromLogs === null
          ? 'the four standard shapes'
          : 'Initialize events and the four standard shapes',
      hookedPoolsSkipped: hooked,
      pools,
    };
    rows.push(row);
    console.log(
      `${symbol.padEnd(6)} ${description.padEnd(22)} feed $${feedUsd.toFixed(2)} age ${feedAgeSeconds}s  pools: ${
        pools.length === 0 ? 'none' : ''
      }`,
    );
    for (const p of pools)
      console.log(
        `   ${String(p.fee).padStart(5)}/${String(p.tickSpacing).padEnd(3)} L=${p.liquidity.padStart(24)} mid $${p.midUsd} (${p.midVsFeedBps} bps vs feed)  ${p.quotes
          .map((q) => `$${q.usd}: buy ${q.buyBps ?? 'x'} sell ${q.sellBps ?? 'x'}`)
          .join(' | ')}`,
      );
  }
  const result = {
    source: `Uniswap v4 StateView ${STATE_VIEW} and Quoter ${QUOTER} on Robinhood Chain (4663) through ${new URL(URL_).host}; pools listed through ${new URL(LOGS_URL).host}`,
    method: `pool-quotes-0.1: hookless v4 pools against USDG; quoteExactInputSingle for ${SIZES_USD.map((x) => `$${x.toLocaleString('en-US')}`).join(', ')} each way; cost in bps against the pool mid of the same block, fee included; pools of a fee above 1% listed and not quoted`,
    fetchedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    blockNumber: Number(at),
    provenance: 'live',
    rows,
  };
  if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
