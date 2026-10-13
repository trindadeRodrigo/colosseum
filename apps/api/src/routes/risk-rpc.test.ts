import { afterEach, describe, expect, it, vi } from 'vitest';

// The pools Bearing measures are mainnet's: a server whose chain runs on a test network reads them
// through RISK_SOLANA_RPC_URL, and through SOLANA_RPC_URL when that is not set.

const asked = vi.hoisted(() => [] as Array<string | undefined>);
vi.mock('@colosseum/chain-solana', async (real) => ({
  ...(await real<typeof import('@colosseum/chain-solana')>()),
  createRpc: (url?: string) => {
    asked.push(url);
    return {
      getMultipleAccounts: () => ({
        send: async () => ({ context: { slot: 7n }, value: [null] }),
      }),
    };
  },
}));
const { rpcChainReader } = await import('./risk-pool-liquidity');

afterEach(() => {
  asked.length = 0;
  vi.unstubAllEnvs();
});

describe('the RPC the liquidity route reads pools through', () => {
  it('is RISK_SOLANA_RPC_URL when it is set', async () => {
    vi.stubEnv('RISK_SOLANA_RPC_URL', ' https://mainnet.example/rpc ');
    vi.stubEnv('SOLANA_RPC_URL', 'https://devnet.example/rpc');
    await rpcChainReader().accounts(['11111111111111111111111111111111']);
    expect(asked).toEqual(['https://mainnet.example/rpc']);
  });

  it('is the server’s own (createRpc’s default, SOLANA_RPC_URL) when it is not, or is blank', async () => {
    vi.stubEnv('RISK_SOLANA_RPC_URL', '');
    await rpcChainReader().accounts(['11111111111111111111111111111111']);
    expect(asked).toEqual([undefined]);
  });
});
