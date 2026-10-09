import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { dictionary } from '../../i18n';
import { MarketNote } from './MarketNote';
import { all, one, render, tag, text, ui } from './test/html';

const label = dictionary('en').shell.marketClosed;
const note = (market: 'open' | 'closed' | 'unknown' | undefined) =>
  render(createElement('p', null, createElement(MarketNote, { market, label })));

describe('MarketNote', () => {
  it('says a closed market in words, with no glyph', () => {
    const said = one(note('closed'), ui('market-closed'));
    expect(text(said)).toBe('Market closed · last close');
    expect(all(said, tag('svg'))).toHaveLength(0);
  });

  it('says nothing while the market is open, which is also what an asset with no session answers', () => {
    expect(all(note('open'), ui('market-closed'))).toHaveLength(0);
  });

  it('says nothing where the server does not know, or serves no market at all', () => {
    expect(all(note('unknown'), ui('market-closed'))).toHaveLength(0);
    expect(all(note(undefined), ui('market-closed'))).toHaveLength(0);
  });
});
