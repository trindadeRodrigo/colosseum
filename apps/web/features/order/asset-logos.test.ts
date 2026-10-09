import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SYMBOLS, tokenName } from './amounts';
import { ASSET_LOGOS, NO_ARTWORK, XSTOCKS } from './asset-logos';

// Every token the app lists has had a decision: a file, or a reason it keeps its ticker.

const DIR = 'apps/web/public/assets/tokens';
const README = readFileSync(`${DIR}/README.md`, 'utf8');
const files = [...new Set(ASSET_LOGOS.values())].map((src) => src.replace('/assets/tokens/', ''));

type Deployment = { chains: Record<string, { assets: Record<string, unknown> }> };
const testnet = JSON.parse(
  readFileSync('packages/sdk/deployments/testnet.json', 'utf8'),
) as Deployment;
/** The shelf's symbols and every asset of the test-network deployment, by the name a screen writes. */
const catalog = [
  ...new Set([
    ...Object.keys(SYMBOLS),
    ...Object.values(testnet.chains)
      .flatMap((chain) => Object.keys(chain.assets))
      .map((id) => tokenName(id).toLowerCase()),
  ]),
];

describe('token artwork', () => {
  it.each(files)('%s is a square PNG no larger than 512, named in the README', (name) => {
    const bytes = readFileSync(`${DIR}/${name}`);
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const [width, height] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    expect(Math.max(width, height)).toBeLessThanOrEqual(512);
    // a company's own site icon is 180; nothing is drawn larger than 48
    expect(Math.min(width, height)).toBeGreaterThanOrEqual(180);
    // the Oct 7 jlUSDC file is 184 KB as its source serves it
    expect(bytes.length).toBeLessThanOrEqual(name === 'jlusdc.png' ? 200_000 : 100_000);
    // the USDG mark ships as 1000 by 1001
    expect(Math.abs(width - height)).toBeLessThanOrEqual(1);
    expect(README).toContain(`| ${name} |`);
    // the hash the README records is the hash of the bytes served
    expect(README).toContain(`- ${name}: ${createHash('sha256').update(bytes).digest('hex')}`);
  });

  it('points every name at the file of that name, the test dollar of Robinhood Chain apart', () => {
    for (const [name, src] of ASSET_LOGOS) {
      expect(src).toBe(`/assets/tokens/${name === 'tusdg' ? 'usdg' : name}.png`);
    }
  });

  it('never shows another issuer’s token image for a Robinhood Chain token', () => {
    const tiles = new Set<string>(XSTOCKS.map((name) => `/assets/tokens/${name}.png`));
    const ids = Object.keys(testnet.chains.robinhood?.assets ?? {});
    expect(ids.length).toBeGreaterThan(5);
    for (const id of [...ids, 'robinhood:aapl', 'robinhood:nvda', 'robinhood:crcl']) {
      const src = ASSET_LOGOS.get(tokenName(id).toLowerCase());
      expect(src === undefined || !tiles.has(src)).toBe(true);
    }
  });

  it('serves no picture the mapping does not name', () => {
    const served = readdirSync(DIR).filter((name) => name.endsWith('.png'));
    expect(served.sort()).toEqual([...files].sort());
  });

  it('keeps the source beside every picture drawn from an SVG', () => {
    for (const name of [
      'syrupusdc',
      'syrupusdt',
      'syrupusdg',
      'usdy',
      'sol',
      'usdc',
      'crcl',
      'nvda',
      'meta',
    ]) {
      const source = readFileSync(`${DIR}/${name}.svg`);
      expect(README).toContain(
        `- ${name}.svg (source): ${createHash('sha256').update(source).digest('hex')}`,
      );
    }
  });

  it.each(catalog)('%s has a picture or a reason it keeps its ticker', (name) => {
    expect(ASSET_LOGOS.has(name) !== NO_ARTWORK.has(name)).toBe(true);
  });

  it('gives a reason for every token left as a ticker', () => {
    for (const [name, reason] of NO_ARTWORK) {
      expect(ASSET_LOGOS.has(name)).toBe(false);
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});
