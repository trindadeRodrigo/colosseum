// Which token shows which picture, by the token's name as `tokenName` gives it, in lower case: a test
// token and the token it stands in for share one. The files, their sources and their hashes are in
// public/assets/tokens/README.md (Thom, 2026-10-09: the issuer's own artwork, else the company's or
// fund's official mark, unaltered, used to identify the asset). A token with no entry in either list
// fails asset-logos.test.ts, so a new asset cannot go without a decision.

const file = (name: string) => `/assets/tokens/${name}.png`;

/** The xStocks tokens, each with the issuer's own image for it. */
const XSTOCKS = [
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
  ['jup', file('jup')],
  ['sol', file('sol')],
  ...XSTOCKS.map((name) => [name, file(name)] as const),
]);

const COMPANY_FORBIDS = "the company's trademark rules allow its logo only under a licence";
const NO_KIT = 'no brand kit found that offers the mark for this use';

/** Tokens that keep their ticker, each with why. A token leaves this list when a file is added for it. */
export const NO_ARTWORK: ReadonlyMap<string, string> = new Map([
  ['usdc', "Circle's brand policy allows no commercial use, and its kit is a zip"],
  ['jitosol', 'no brand kit found; the on-chain image is not on a host of the issuer'],
  ['cbbtc', "Coinbase's terms ask for consent before its marks are used"],
  ['cbeth', "Coinbase's terms ask for consent before its marks are used"],
  // Robinhood Chain's stock tokens have no artwork of their own, so each would take the company's mark.
  ['aapl', COMPANY_FORBIDS],
  ['msft', COMPANY_FORBIDS],
  ['nvda', COMPANY_FORBIDS],
  ['googl', COMPANY_FORBIDS],
  ['amzn', COMPANY_FORBIDS],
  ['meta', COMPANY_FORBIDS],
  ['crcl', COMPANY_FORBIDS],
  ['tsla', NO_KIT],
  ['mstr', NO_KIT],
  ['spcx', NO_KIT],
  ['spy', NO_KIT],
  ['qqq', NO_KIT],
  ['gld', NO_KIT],
  ['sgov', NO_KIT],
  ['tsm', NO_KIT],
]);
