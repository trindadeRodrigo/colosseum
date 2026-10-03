import { robinhood, robinhoodTestnet } from 'viem/chains';
import { describe, expect, it } from 'vitest';
import { evmChainsForProvider, solanaCluster, toViemChain, walletChains } from './chains';

describe('walletChains', () => {
  it('with nothing set, every chain is on its test network and labelled as one', () => {
    const chains = walletChains();
    expect(chains.solana.config.networkName).toBe('devnet');
    expect(chains.solana.rpcUrl).toBe('https://api.devnet.solana.com');
    expect(solanaCluster(chains.solana)).toBe('solana:devnet');
    expect(chains.robinhood.config.evmChainId).toBe(46630);
    expect(chains.base.config.evmChainId).toBe(84532);
    for (const chain of Object.values(chains)) {
      expect(chain.network).toBe('testnet');
      expect(chain.provenance).toBe('sandbox');
    }
    expect(walletChains({ NEXT_PUBLIC_CHAIN_NETWORK_SOLANA: '  ' })).toEqual(chains);
  });

  it('mainnet is there, per chain, when the variable says so', () => {
    const chains = walletChains({ NEXT_PUBLIC_CHAIN_NETWORK_ROBINHOOD: 'Mainnet' });
    expect(chains.robinhood.config.evmChainId).toBe(4663);
    expect(chains.robinhood.provenance).toBe('live');
    expect(chains.robinhood.rpcUrl).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(chains.solana.network).toBe('testnet');
    const solana = walletChains({ NEXT_PUBLIC_CHAIN_NETWORK_SOLANA: 'mainnet' }).solana;
    expect(solanaCluster(solana)).toBe('solana:mainnet');
  });

  it('refuses a value it does not know, and `local`, naming the variable and not the value', () => {
    for (const value of ['local', 'devnet', 'https://secret.example/key']) {
      const run = () => walletChains({ NEXT_PUBLIC_CHAIN_NETWORK_BASE: value });
      expect(run).toThrow('NEXT_PUBLIC_CHAIN_NETWORK_BASE: expected mainnet or testnet');
      expect(run).not.toThrow(value);
    }
  });

  it('no RPC URL carries a key or a query', () => {
    const tables = [
      walletChains(),
      walletChains({
        NEXT_PUBLIC_CHAIN_NETWORK_SOLANA: 'mainnet',
        NEXT_PUBLIC_CHAIN_NETWORK_ROBINHOOD: 'mainnet',
        NEXT_PUBLIC_CHAIN_NETWORK_BASE: 'mainnet',
      }),
    ];
    for (const chain of tables.flatMap((t) => Object.values(t))) {
      const url = new URL(chain.rpcUrl);
      expect([url.protocol, url.pathname, url.search, url.username]).toEqual([
        'https:',
        '/',
        '',
        '',
      ]);
    }
  });
});

describe('the chains a wallet provider is told about', () => {
  it('Robinhood Chain is defined from our config and agrees with the chain viem ships', () => {
    const test = toViemChain(walletChains().robinhood);
    expect(test.id).toBe(robinhoodTestnet.id);
    expect(test.rpcUrls.default.http).toEqual(robinhoodTestnet.rpcUrls.default.http);
    expect(test.blockExplorers?.default.url).toBe(robinhoodTestnet.blockExplorers.default.url);
    expect(test.nativeCurrency.decimals).toBe(robinhoodTestnet.nativeCurrency.decimals);
    expect(test.testnet).toBe(true);

    const main = toViemChain(
      walletChains({ NEXT_PUBLIC_CHAIN_NETWORK_ROBINHOOD: 'mainnet' }).robinhood,
    );
    expect(main.id).toBe(robinhood.id);
    expect(main.rpcUrls.default.http).toEqual(robinhood.rpcUrls.default.http);
    expect(main.testnet).toBe(false);
    expect(() => toViemChain(walletChains().solana)).toThrow('solana is not an EVM chain');
  });

  it('lists both networks of each EVM chain, with the test network as the default', () => {
    const { supportedChains, defaultChain } = evmChainsForProvider(walletChains());
    expect(supportedChains.map((c) => c.id)).toEqual([46630, 4663, 84532, 8453]);
    expect(defaultChain.id).toBe(46630);
  });

  it('makes mainnet the default only when the variable says so', () => {
    const chains = walletChains({ NEXT_PUBLIC_CHAIN_NETWORK_ROBINHOOD: 'mainnet' });
    const { supportedChains, defaultChain } = evmChainsForProvider(chains);
    expect(defaultChain.id).toBe(4663);
    expect(supportedChains.map((c) => c.id)).toEqual([46630, 4663, 84532, 8453]);
  });
});
