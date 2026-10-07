import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { dictionary } from '../../i18n';
import { CHAIN_NAMES, ChainBadge, ChainBadges } from './ChainBadge';
import { ExecutionList } from './ExecutionList';
import { GoalCard } from './GoalCard';
import { all, classes, one, render, tag, text, ui } from './test/html';

// The one label that says which chain something is on. The vault, plan, order and activity screens
// each show it; these are the rules of the label itself.

describe('ChainBadge', () => {
  it('names each chain, and says which in data-chain', () => {
    for (const chain of ['solana', 'robinhood', 'base'] as const) {
      const badge = one(render(createElement(ChainBadge, { chain })), ui('chain-badge'));
      expect(text(badge)).toBe(CHAIN_NAMES[chain]);
      expect(badge.attrs['data-chain']).toBe(chain);
    }
    expect(CHAIN_NAMES.robinhood).toBe('Robinhood Chain');
  });

  it('says the same name in English and Portuguese, the names every screen uses', () => {
    expect(dictionary('en').chain.names).toEqual(CHAIN_NAMES);
    expect(dictionary('pt').chain.names).toEqual(CHAIN_NAMES);
  });

  it('is text on a square hairline: no mark, no pill, no blue or violet', () => {
    const badge = one(render(createElement(ChainBadge, { chain: 'solana' })), ui('chain-badge'));
    expect(all(badge, tag('svg'))).toHaveLength(0);
    expect(all(badge, tag('img'))).toHaveLength(0);
    expect(classes(badge)).toContain('rounded-md');
    expect(classes(badge).join(' ')).not.toMatch(/rounded-(full|lg|xl)|blue|violet|indigo|purple/);
  });

  it('labels each chain once, in the order given', () => {
    const list = render(
      createElement(ChainBadges, { chains: ['robinhood', 'solana', 'robinhood'] }),
    );
    expect(all(list, ui('chain-badge')).map((b) => b.attrs['data-chain'])).toEqual([
      'robinhood',
      'solana',
    ]);
  });

  it('rides on a goal card and on an activity row', () => {
    const card = render(
      createElement(GoalCard, {
        sentence: 'Grow $40 over 36 months.',
        status: null,
        action: { label: 'See your plan', href: '/plan/1' },
        chain: 'robinhood',
      }),
    );
    expect(one(card, ui('chain-badge')).attrs['data-chain']).toBe('robinhood');
    const row = render(
      createElement(ExecutionList, {
        executions: [
          {
            id: 'a',
            verb: 'Approve',
            detail: '',
            status: 'confirmed',
            at: '2026-10-05T12:00:00Z',
            signature: '0xab',
            explorerUrl: 'https://explorer.testnet.chain.robinhood.com/tx/0xab',
            explorer: 'Robinhood explorer',
            chain: 'robinhood',
            provenance: 'sandbox',
          },
        ],
      }),
    );
    expect(text(one(row, ui('chain-badge')))).toBe('Robinhood Chain');
    expect(text(one(row, ui('explorer-name')))).toBe('Robinhood explorer');
  });

  it('is left off an activity row where the page already names the one chain', () => {
    const row = render(
      createElement(ExecutionList, {
        chainTags: false,
        executions: [
          {
            id: 'a',
            verb: 'Approve',
            detail: '',
            status: 'confirmed',
            at: '2026-10-05T12:00:00Z',
            signature: '0xab',
            explorerUrl: 'https://explorer.testnet.chain.robinhood.com/tx/0xab',
            explorer: 'Robinhood explorer',
            chain: 'robinhood',
            provenance: 'sandbox',
          },
        ],
      }),
    );
    expect(all(row, ui('chain-badge'))).toEqual([]);
    // the explorer's name stays: it is the link's, not the chain's tag
    expect(text(one(row, ui('explorer-name')))).toBe('Robinhood explorer');
  });
});
