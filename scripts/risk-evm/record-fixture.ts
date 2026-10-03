import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { decodeAggregate3, decodeSqrtPrice, encodeAggregate3, encodeGetSlot0, SEL } from './abi';
import { CHAINS } from './config';
import { buyAmounts, midUsd, sellAmounts } from './curve';
import { type PoolRef, readCache } from './pools';
import { createRpc } from './rpc';
import { quoteRequest } from './run';

// Records the fixture behind tests/risk-evm.test.ts: six read-only calls at one block for NVDA on
// Robinhood Chain (one v3 pool, one v4 pool, both sides). The expected values are produced by
// `cast`, not by this repo's code, so the test checks the hand-written ABI code against Foundry's.
// Needs cast and a pool list from an earlier `pnpm risk-evm:collect`:
//   pnpm exec tsx scripts/risk-evm/record-fixture.ts
const OUT = 'fixtures/risk-evm/robinhood-nvda-quotes.json';
const V3_POOL = '0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3';
const V4_POOL = '0xdf5c0bcd967d54774c139a4ef803ec994779736346fb4c21b50ed241b1fd2682';

const cast = (...args: string[]) =>
  execFileSync('cast', args, {
    encoding: 'utf8',
    env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' },
  }).trim();
const castJson = (sig: string, data: string) =>
  JSON.parse(cast('abi-decode', '--json', sig, data)) as string[];
const numbers = (list: string) => list.match(/\d+/g) ?? [];

const chain = CHAINS.find((c) => c.id === 'robinhood');
if (!chain?.v4) throw new Error('no robinhood chain in config.ts');
const { quoter, stateView } = chain.v4;
const token = chain.tokens.find((t) => t.symbol === 'NVDA');
const cache = readCache(`${process.env.RISK_EVM_DIR ?? 'data/risk-evm'}/pools-robinhood.json`);
const listed = cache?.tokens.NVDA?.pools ?? [];
const v3 = listed.find((p) => p.id === V3_POOL);
const v4 = listed.find((p) => p.id === V4_POOL);
if (!token || !v3 || !v4?.key) throw new Error('run pnpm risk-evm:collect first: pools not listed');

const rpc = createRpc(chain.rpcDefault);
const head = await rpc.call<{ number: string; timestamp: string }>('eth_getBlockByNumber', [
  'latest',
  false,
]);
const midCalls = [
  { target: v3.id, callData: `0x${SEL.slot0}` },
  { target: stateView, callData: encodeGetSlot0(v4.id) },
];
const mids = decodeAggregate3(
  await rpc.call<string>('eth_call', [
    { to: chain.multicall3, data: encodeAggregate3(midCalls) },
    head.number,
  ]),
);

const record = async (pool: PoolRef, slot0: string) => {
  const sqrtPriceX96 = decodeSqrtPrice(slot0);
  const mid = midUsd(sqrtPriceX96, pool.tokenIs0, token.decimals, chain.dollar.decimals);
  const sides = [];
  for (const side of ['sell', 'buy'] as const) {
    const amounts =
      side === 'sell' ? sellAmounts(mid, token.decimals) : buyAmounts(chain.dollar.decimals);
    const zeroForOne = side === 'sell' ? pool.tokenIs0 : !pool.tokenIs0;
    const request = quoteRequest(chain, pool, side, amounts, head.number);
    const result = await rpc.call<string>(request.method, request.params);
    const list = `[${amounts.join(',')}]`;
    let castCalldata: string;
    let expected: unknown;
    if (pool.kind === 'cl') {
      castCalldata = cast(
        'calldata',
        'quote(address,bool,uint256[],uint256)',
        pool.id,
        String(zeroForOne),
        list,
        '20000000',
      );
      const [ins, outs] = castJson('f()(uint256[],uint256[])', result);
      expected = { ins: numbers(ins ?? ''), outs: numbers(outs ?? '') };
    } else {
      const k = pool.key;
      if (!k) throw new Error('v4 pool without a key');
      const calls = amounts.map((a) => {
        const data = cast(
          'calldata',
          'quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))',
          `((${k.currency0},${k.currency1},${k.fee},${k.tickSpacing},${k.hooks}),${zeroForOne},${a},0x)`,
        );
        return `(${quoter},true,${data})`;
      });
      castCalldata = cast('calldata', 'aggregate3((address,bool,bytes)[])', `[${calls.join(',')}]`);
      const [items] = castJson('f()((bool,bytes)[])', result);
      expected = [...(items ?? '').matchAll(/\((true|false), (0x[0-9a-fA-F]*)\)/g)].map((m) => {
        const ok = m[1] === 'true' && (m[2] ?? '').length === 130;
        return {
          success: m[1] === 'true',
          amountOut: ok ? castJson('f()(uint256,uint256)', m[2] as string)[0] : null,
        };
      });
    }
    sides.push({
      side,
      zeroForOne,
      amountsIn: amounts.map(String),
      castCalldata,
      result,
      castDecoded: expected,
    });
  }
  return {
    pool,
    slot0,
    sqrtPriceX96: castJson('f()(uint160)', slot0.slice(0, 66))[0],
    sides,
  };
};

const fixture = {
  provenance: 'fixture',
  source: `eth_call at block ${Number(head.number)} on ${chain.name} (chain ${chain.chainId}) through ${chain.rpcDefault}`,
  method:
    'scripts/risk-evm/record-fixture.ts: raw responses, with calldata and decoded values from Foundry cast',
  fetchedAt: new Date(Number(head.timestamp) * 1000).toISOString(),
  block: Number(head.number),
  token,
  dollar: chain.dollar,
  v3: await record(v3, (mids[0] as { data: string }).data),
  v4: await record(v4, (mids[1] as { data: string }).data),
};
mkdirSync('fixtures/risk-evm', { recursive: true });
writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(JSON.stringify({ wrote: OUT, block: fixture.block, rpc: rpc.stats() }));
