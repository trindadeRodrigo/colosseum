// @vitest-environment happy-dom
import { existsSync } from 'node:fs';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChainLogo } from './ChainLogo';
import { find, fire, mount, unmountAll } from './test/dom';

afterEach(unmountAll);

describe('ChainLogo', () => {
  it('standing alone, is a picture named for the chain, at the size asked', async () => {
    const host = await mount(createElement(ChainLogo, { chain: 'solana', size: 20 }));
    const mark = find(host, 'img[data-ui="chain-logo"]');
    expect(mark.getAttribute('alt')).toBe('Solana');
    expect(mark.hasAttribute('aria-hidden')).toBe(false);
    expect([mark.getAttribute('width'), mark.getAttribute('height')]).toEqual(['20', '20']);
    expect(existsSync(`apps/web/public${mark.getAttribute('src')}`)).toBe(true);
  });

  it('has a file for each chain a plan can be on', async () => {
    for (const [chain, name] of [
      ['solana', 'Solana'],
      ['robinhood', 'Robinhood Chain'],
    ] as const) {
      const host = await mount(createElement(ChainLogo, { chain }));
      const mark = find(host, 'img[data-ui="chain-logo"]');
      expect(mark.getAttribute('alt')).toBe(name);
      expect(existsSync(`apps/web/public${mark.getAttribute('src')}`)).toBe(true);
    }
  });

  it('beside the name, is hidden from a screen reader', async () => {
    const host = await mount(createElement(ChainLogo, { chain: 'solana', decorative: true }));
    const mark = find(host, 'img');
    expect(mark.getAttribute('alt')).toBe('');
    expect(mark.getAttribute('aria-hidden')).toBe('true');
  });

  it('with no file, writes the name when alone and draws nothing beside it', async () => {
    const alone = await mount(createElement(ChainLogo, { chain: 'base' }));
    expect(alone.querySelector('img')).toBeNull();
    expect(find(alone, '[data-ui="chain-logo"]').textContent).toBe('Base');
    const beside = await mount(createElement(ChainLogo, { chain: 'base', decorative: true }));
    expect(beside.innerHTML).toBe('');
  });

  it('falls back the same way when the file fails to load', async () => {
    const alone = await mount(createElement(ChainLogo, { chain: 'solana' }));
    await fire(find(alone, 'img'), new Event('error'));
    expect(alone.querySelector('img')).toBeNull();
    expect(find(alone, '[data-ui="chain-logo"]').textContent).toBe('Solana');
    const beside = await mount(createElement(ChainLogo, { chain: 'solana', decorative: true }));
    await fire(find(beside, 'img'), new Event('error'));
    expect(beside.innerHTML).toBe('');
  });
});
