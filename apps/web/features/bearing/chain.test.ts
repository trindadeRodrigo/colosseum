import { describe, expect, it } from 'vitest';
import { chainInSearch, onChain, pickChain, readKey, withChain } from './chain';
import { R } from './data';

// Which chain Bearing reads: the address first, then the app's bar, then this browser, then Solana.

describe('the chain Bearing reads', () => {
  it('is the one the address names, whatever the bar or the browser say', () => {
    expect(pickChain('?chain=robinhood', 'solana', 'solana')).toBe('robinhood');
    expect(pickChain('?asset=TSLAx&chain=solana', 'robinhood', 'robinhood')).toBe('solana');
  });

  it('follows the bar where the address names none, then this browser, then Solana', () => {
    expect(pickChain('', 'robinhood', 'solana')).toBe('robinhood');
    expect(pickChain('', null, 'robinhood')).toBe('robinhood');
    expect(pickChain('', undefined, null)).toBe('solana');
  });

  it('ignores a chain Bearing does not measure, from any of them', () => {
    expect(chainInSearch('?chain=base')).toBeNull();
    expect(pickChain('?chain=base', 'base', 'base')).toBe('solana');
    expect(pickChain('?chain=ROBINHOOD', null, 'nonsense')).toBe('solana');
  });
});

describe('the address of a chain', () => {
  it('names the chain and keeps the rest of the query', () => {
    expect(withChain('/analytics/stocks', '?asset=NVDA', 'robinhood')).toBe(
      '/analytics/stocks?asset=NVDA&chain=robinhood',
    );
    expect(withChain('/analytics/stocks', '?chain=robinhood', 'solana')).toBe(
      '/analytics/stocks?chain=solana',
    );
    expect(onChain('/analytics/lending', 'robinhood')).toBe('/analytics/lending?chain=robinhood');
    expect(onChain('/analytics/simulation?asset=GLD', 'robinhood')).toBe(
      '/analytics/simulation?asset=GLD&chain=robinhood',
    );
  });

  it('leaves Solana’s reads as the prototype made them, and names Robinhood Chain in its own', () => {
    expect(R.assets(0.01)).toBe('/risk/assets?tau=0.01');
    expect(R.assets(0.01, 'solana')).toBe('/risk/assets?tau=0.01');
    expect(R.assets(0.01, 'robinhood')).toBe('/risk/assets?tau=0.01&chain=robinhood');
    expect(R.pools('solana')).toBe('/risk/pools');
    expect(R.pools('robinhood')).toBe('/risk/pools?chain=robinhood');
    expect(R.poolsOf('TSLAx')).toBe('/risk/pools?asset=TSLAx');
  });

  it('reads a Robinhood Chain stock by its address and a Solana one by its symbol', () => {
    const nvda = { symbol: 'NVDA', assetMint: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' };
    expect(readKey({ ...nvda, chain: 'robinhood' }, 'NVDA')).toBe(nvda.assetMint);
    expect(readKey({ symbol: 'TSLAx', assetMint: 'XsDo', chain: 'solana' }, 'TSLAx')).toBe('TSLAx');
    // an API from before chains says none: Solana
    expect(readKey({ symbol: 'TSLAx', assetMint: 'XsDo' }, 'TSLAx')).toBe('TSLAx');
    expect(readKey(undefined, 'TSLAx')).toBe('TSLAx');
  });
});
