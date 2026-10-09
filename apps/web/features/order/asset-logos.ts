// Which token shows which picture, by the token's name as `tokenName` gives it, in lower case: a test
// token and the token it stands in for share one. The files, their sources and their hashes are in
// public/assets/tokens/README.md (Thom, 2026-10-09: the issuer's own artwork, else the company's or
// fund's official mark, on both chains, unaltered, used to identify the asset). A token with no entry in
// either list fails asset-logos.test.ts, so a new asset cannot go without a decision.

const file = (name: string) => `/assets/tokens/${name}.png`;

/** The xStocks tokens, each with the issuer's own image for it. */
export const XSTOCKS = [
  'spyx',
  'qqqx',
  'nvdax',
  'tslax',
  'aaplx',
  'googlx',
  'metax',
  'msftx',
  'amznx',
  'spcxx',
  'mstrx',
  'crclx',
  'hoodx',
  'coinx',
  'pltrx',
  'gldx',
] as const;

/** Locally served, verified token artwork; unknown assets retain their ticker. */
export const ASSET_LOGOS: ReadonlyMap<string, string> = new Map([
  ['jlusdc', file('jlusdc')],
  ['syrupusdc', file('syrupusdc')],
  ['syrupusdt', file('syrupusdt')],
  ['syrupusdg', file('syrupusdg')],
  ['paxg', file('paxg')],
  ['usdg', file('usdg')],
  // Robinhood Chain's dollar on the test network is the same token's stand-in.
  ['tusdg', file('usdg')],
  ['usdy', file('usdy')],
  ['usdc', file('usdc')],
  // Robinhood Chain's stock and fund tokens have no artwork of their own: each takes the company's
  // or the fund's own mark, never the xStocks image of the same company.
  ['aapl', file('aapl')],
  ['msft', file('msft')],
  ['nvda', file('nvda')],
  ['googl', file('googl')],
  ['amzn', file('amzn')],
  ['meta', file('meta')],
  ['crcl', file('crcl')],
  ['qqq', file('qqq')],
  ['gld', file('gld')],
  // JUP is on no shelf today; an id that names it (`solana:jup`) shows it.
  ['jup', file('jup')],
  ['sol', file('sol')],
  ...XSTOCKS.map((name) => [name, file(name)] as const),
]);

const BLOCKED = "the company's site refuses automated fetches; a person can save its mark";
const WORDMARK = "the sponsor's only mark is a wide wordmark, unreadable in the round frame";

/** Tokens that keep their ticker, each with why. A token leaves this list when a file is added for it. */
export const NO_ARTWORK: ReadonlyMap<string, string> = new Map([
  ['jitosol', 'no brand kit found; the on-chain image is not on a host of the issuer'],
  ['cbbtc', "no token picture found on Coinbase's site, which refuses automated fetches"],
  ['cbeth', "no token picture found on Coinbase's site, which refuses automated fetches"],
  ['tsla', BLOCKED],
  ['mstr', BLOCKED],
  // listed on Robinhood Chain but not on the shelf yet: decided ahead of it
  ['tsm', BLOCKED],
  ['spcx', "SpaceX's site serves its mark only as an .ico and inline drawing"],
  ['spy', WORDMARK],
  ['sgov', WORDMARK],
]);
