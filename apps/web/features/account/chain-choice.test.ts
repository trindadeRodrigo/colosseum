import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { all, one, render, text, ui } from '../../components/ui/test/html';
import { dictionary } from '../../i18n';
import { ChainChoice, type ChainChoiceOption } from './ChainChoice';

// How a chain option says the chain is not live: in words under its name, never with the hatched
// glyph, which marks a sample figure (Thom, 2026-10-09). A test network must still never read as live.

const en = dictionary('en');
const option = (provenance: ChainChoiceOption['provenance']): ChainChoiceOption => ({
  chain: 'solana',
  name: 'Solana',
  address: null,
  provenance,
});
const drawn = (provenance: ChainChoiceOption['provenance']) =>
  render(
    createElement(ChainChoice, {
      legend: en.chain.choice.legend,
      options: [option(provenance)],
      value: 'solana',
      onChange: () => {},
      labels: {
        testNetwork: en.shell.testNetworkLine,
        sample: en.shell.sample,
        wallet: en.chain.choice.wallet,
        saving: en.chain.switch.saving,
      },
    }),
  );

describe('a chain option', () => {
  it('says "Test network" under the name on a test network, read as "Solana, test network"', () => {
    const tree = drawn('sandbox');
    expect(text(one(tree, ui('chain-how')))).toBe('Test network');
    expect(text(one(tree, (el) => el.tag === 'label'))).toContain('Solana, test network');
    expect(all(tree, ui('sample-glyph'))).toHaveLength(0);
  });

  it('says "Sample" on the sample chain', () => {
    const tree = drawn('mock');
    expect(text(one(tree, ui('chain-how')))).toBe('Sample');
    expect(text(one(tree, (el) => el.tag === 'label'))).toContain('Solana, sample');
    expect(all(tree, ui('sample-glyph'))).toHaveLength(0);
  });

  it('says nothing on a live network', () => {
    const tree = drawn('live');
    expect(all(tree, ui('chain-how'))).toHaveLength(0);
    expect(text(one(tree, (el) => el.tag === 'label'))).toBe('Solana');
  });

  it('draws the chain’s logo beside the name, hidden from a screen reader', () => {
    const logo = one(drawn('sandbox'), ui('chain-logo'));
    expect(logo.attrs.alt).toBe('');
    expect(logo.attrs['aria-hidden']).toBe('true');
  });
});
