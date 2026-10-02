// Per-chain settings of the EVM depth collector. Addresses were read on chain or from the sources named
// beside them on 2026-10-02; nothing here is a price or a yield.

export type TokenConfig = { symbol: string; address: string; decimals: number };

export type ChainConfig = {
  id: string;
  name: string;
  chainId: number;
  /** Off = `pnpm risk-evm:collect` skips the chain unless it is named with --chain. */
  enabled: boolean;
  /** Env variable that replaces the free public RPC. Its value is never written to a row or a log. */
  rpcEnv: string;
  rpcDefault: string;
  /** Chain name in DexScreener's URLs. */
  dexscreener: string;
  /** The cash token pools are quoted against. Counted as one US dollar. */
  dollar: TokenConfig;
  multicall3: string;
  /**
   * Factories of Uniswap-v3-style pools the vault's swap path reaches. A pool is quoted only if one of
   * them names it for its pair: getPool(token0, token1, fee) on Uniswap v3, (…, tickSpacing) on Slipstream.
   */
  clFactories: Array<{ address: string; getPoolBy: 'fee' | 'tickSpacing' }>;
  /** Uniswap v4 periphery; null where the vault does not swap through v4. Only hookless pools are quoted. */
  v4: { quoter: string; stateView: string; positionManager: string } | null;
  tokens: TokenConfig[];
};

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** Stock tokens in the launch recipes: docs/vault/research/open-questions/launch-shelf.md. */
const rh = (symbol: string, address: string): TokenConfig => ({ symbol, address, decimals: 18 });
const base = (symbol: string, address: string): TokenConfig => ({ symbol, address, decimals: 8 });

export const CHAINS: ChainConfig[] = [
  {
    id: 'robinhood',
    name: 'Robinhood Chain',
    chainId: 4663,
    enabled: true,
    rpcEnv: 'RISK_EVM_RH_RPC_URL',
    rpcDefault: 'https://rpc.mainnet.chain.robinhood.com',
    dexscreener: 'robinhood',
    dollar: { symbol: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6 },
    multicall3: MULTICALL3,
    // Uniswap v3 factory: factory() of the NVDA/USDG pool 0xd4EB…14a3.
    clFactories: [{ address: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA', getPoolBy: 'fee' }],
    // https://developers.uniswap.org/contracts/v4/deployments; the Quoter's poolManager() and the
    // StateView's poolManager() both return 0x8366…0951.
    v4: {
      quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
      stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
      positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
    },
    tokens: [
      rh('SPY', '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C'),
      rh('NVDA', '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'),
      rh('GLD', '0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e'),
      rh('META', '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35'),
      rh('MSTR', '0xec262a75e413fAfD0dF80480274532C79D42da09'),
      rh('CRCL', '0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5'),
      rh('SGOV', '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5'),
      rh('GOOGL', '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3'),
      rh('USO', '0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344'),
      rh('TSLA', '0x322F0929c4625eD5bAd873c95208D54E1c003b2d'),
      rh('AAPL', '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9'),
      rh('COIN', '0x6330D8C3178a418788dF01a47479c0ce7CCF450b'),
      rh('MU', '0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD'),
      rh('INTC', '0xc72b96e0E48ecd4DC75E1e45396e26300BC39681'),
      rh('AMZN', '0x12f190a9F9d7D37a250758b26824B97CE941bF54'),
      rh('MSFT', '0xe93237C50D904957Cf27E7B1133b510C669c2e74'),
      rh('AMD', '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC'),
      rh('SLV', '0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f'),
      rh('SNDK', '0xB90A19fF0Af67f7779afF50A882A9CfF42446400'),
      rh('TSM', '0x58FfE4a942d3885bAa22D7520691F611EF09e7AA'),
      rh('DELL', '0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd'),
    ],
  },
  {
    // Switched off until Base is built. A dry run on 2026-10-02 (--chain base) wrote a row for each token;
    // the public RPC refuses calls for rate, so a run waits and asks again.
    id: 'base',
    name: 'Base',
    chainId: 8453,
    enabled: false,
    rpcEnv: 'RISK_EVM_BASE_RPC_URL',
    rpcDefault: 'https://mainnet.base.org',
    dexscreener: 'base',
    dollar: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    multicall3: MULTICALL3,
    // Aerodrome Slipstream: factory() of the NVDAc/USDC pool 0x853F…7ab9.
    clFactories: [
      { address: '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef', getPoolBy: 'tickSpacing' },
    ],
    v4: null,
    tokens: [
      base('NVDAc', '0xb20000000000000000000078ee7ce2fE4908108C'),
      base('AAPLc', '0xb200000000000000000000C2e324d24d7eEcd1fb'),
      base('METAc', '0xb2000000000000000000008bC8786B856E61707C'),
      base('GOOGLc', '0xb2000000000000000000002D0BA3164cc74f58B7'),
      base('AMZNc', '0xb200000000000000000000d9192b6B456483C2E8'),
      base('MSFTc', '0xB200000000000000000000Ab99cFa739E253872B'),
      base('TSLAc', '0xb2000000000000000000001e800a7f5189430cD0'),
    ],
  },
];

/** The RPC URL to call, and a name for it that is safe to store: a URL from the environment may carry a key. */
export function rpcFor(chain: ChainConfig, env: Record<string, string | undefined> = process.env) {
  const custom = env[chain.rpcEnv];
  return custom
    ? { url: custom, label: `the RPC in ${chain.rpcEnv}` }
    : { url: chain.rpcDefault, label: chain.rpcDefault };
}
