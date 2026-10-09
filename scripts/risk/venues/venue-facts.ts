// PLAN-UNIVERSE RU.13 — what each program we do not read is, and whether a decoder could reproduce its price from
// its accounts at all. A venue is told apart by the program that owns the pool account Jupiter's route names; the
// name is Jupiter's own label for that program (https://lite-api.jup.ag/swap/v1/program-id-to-label, read with the
// pools: fixtures/risk/venues). `basis` says where each statement comes from; every page was opened on 2026-10-07.
// A venue no page describes is `not_established`: nothing is inferred from a name.

export type VenueFact = {
  name: string;
  /** A few words for the table. */
  kind: string;
  /**
   * - `from_accounts`: a published program or layout whose price is a function of the state in its accounts, so a
   *   decoder can be validated as PLAN-RISK D4 asks (an invariant read from the accounts, and Jupiter's own quote
   *   through the same pool).
   * - `maker_quotes`: the accounts and the arithmetic are published, but what they hold is a quote its maker rewrites
   *   at will: a read gives that instant's quote and nothing about the next, and there is no invariant to check.
   * - `not_from_accounts`: a market maker's own program, its pricing not published: no decoder can be written from a
   *   specification or validated, whatever its volume.
   * - `not_established`: no page says.
   */
  decodable: 'from_accounts' | 'maker_quotes' | 'not_from_accounts' | 'not_established';
  basis: string;
};

/** The venues grouped as proprietary market makers: a page names each as one. Kipseli and Obsidian are not in it. */
export const PROPRIETARY_MARKET_MAKERS: readonly string[] = [
  'goonuddtQRrWqqn5nFyczVKaie28f3kDkHWkHtURSLE',
  'BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi',
  'TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH',
  'HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8',
  'FW6zUqn4iKRaeopwwhwsquTY6ABWLLgjxtrC3VPnaWBf',
];

export const VENUE_FACTS: Record<string, VenueFact> = {
  REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2: {
    name: 'Byreal',
    kind: 'concentrated liquidity: Raydium’s pool account, a second kind of tick array',
    decodable: 'from_accounts',
    basis:
      'Source published (github.com/byreal-git/byreal-clmm, Apache-2.0; not a verified build): `states/dyn_tick_array.rs` defines `DynTickArrayState`, a 216-byte header with a 60-slot table and then one 168-byte tick for each slot allocated, which is what the probe read on chain. `states/pool.rs` keeps the pool at 1,544 bytes and adds a fee of its own: a per-pool rate that overrides the config’s, a fee that decays with time, and a dynamic fee that reads two Pyth feeds.',
  },
  HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq: {
    name: 'PancakeSwap',
    kind: 'concentrated liquidity: Raydium’s pool account',
    decodable: 'from_accounts',
    basis:
      'Its pool accounts are 1,544 bytes and Raydium’s header gives vaults that hold the pool’s two mints (the chain read of the route pools). Its own SDK says it "is derived from raydium-io/raydium-sdk-V2" (unpkg.com/@pancakeswap/solana-core-sdk). The program’s source was not found and no tick array of it was read.',
  },
  goonuddtQRrWqqn5nFyczVKaie28f3kDkHWkHtURSLE: {
    name: 'GoonFi V2',
    kind: 'proprietary market maker',
    decodable: 'not_from_accounts',
    basis:
      'Helius names GoonFi among Solana’s proprietary AMMs, whose "swap logic is not publicly disclosed" (helius.dev/blog/solanas-proprietary-amm-revolution); DefiLlama’s GoonFi adapter lists this program with 2,048-byte markets, the size read on chain (github.com/DefiLlama/DefiLlama-Adapters, projects/goonfi).',
  },
  BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi: {
    name: 'BisonFi',
    kind: 'proprietary market maker',
    decodable: 'not_from_accounts',
    basis:
      'Jump Crypto, 2026-04-15: "the PropAMMs competing today, including our own, BisonFi", each reflecting "its operator’s own proprietary logic" (jumpcrypto.com/resources/propamms-and-the-next-chapter-of-permissionless-market-structure).',
  },
  TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH: {
    name: 'TesseraV',
    kind: 'proprietary market maker',
    decodable: 'not_from_accounts',
    basis:
      'Helius: "Tessera V is operated by Wintermute", one of the proprietary AMMs whose "swap logic is not publicly disclosed" (helius.dev/blog/solanas-proprietary-amm-revolution).',
  },
  HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8: {
    name: 'Hadron',
    kind: 'proprietary market makers’ platform: one maker a pool',
    decodable: 'maker_quotes',
    basis:
      'Its own documents: "The maker that creates the pool is the sole authority of that pool"; the maker sets the mid price, the spread and the curves (docs.hadron.fi/core-design.md). A published SDK decodes its accounts (npm @hadron-fi/sdk-v2); the program’s source was not found.',
  },
  FW6zUqn4iKRaeopwwhwsquTY6ABWLLgjxtrC3VPnaWBf: {
    name: 'WhaleStreet',
    kind: 'proprietary market maker, by one line of one page',
    decodable: 'not_from_accounts',
    basis:
      'DefiLlama: "Whalestreet is a Prop AMM on Solana" (api.llama.fi/summary/dexs/whalestreet). Nothing else was found: neither its operator nor its program.',
  },
  '3TK9D8aoBFYjYZtKCjciPrVrRStsnvo7KmpcJqDavpaU': {
    name: 'Kipseli',
    kind: 'not established',
    decodable: 'not_established',
    basis:
      'No page describes this Solana program. A firm of the same name describes a "PropAMM … deployed on Base, BNB Chain and Robinhood Chain" (docs.kipseli.capital) and does not mention Solana.',
  },
  HBVw6bZtcCaezhcBrmfyXBSBRWCdv72271xQ4GPvms2z: {
    name: 'Obsidian',
    kind: 'not established',
    decodable: 'not_established',
    basis: 'No page describing this program was found.',
  },
  MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms: {
    name: 'Manifest',
    kind: 'order book',
    decodable: 'from_accounts',
    basis:
      'Source published under GPL-3.0, with this program id: a "permissionless orderbook" (github.com/Bonasa-Tech/manifest). What it offers at a size is the orders resting in the market account at that slot.',
  },
  Archer8kgiavM61GyusMzaaS2ft5sALtNsD1HxkUPMhy: {
    name: 'Archer',
    kind: 'order books, one a maker, each priced off a mid its maker moves',
    decodable: 'maker_quotes',
    basis:
      'Its own documents: "each market maker gets their own dedicated on-chain order book", at most 16 bid and 16 ask levels, each "an offset from that defined mid price", which the maker "can constantly update" (docs.archer.exchange/architecture/maker-book.md). A published SDK gives the layouts (github.com/ballista-tech/archer-sdk).',
  },
  DRVSpZ2YUYYKgZP8XtLhAGtT1zYSCKzeHfb4DgRnrgqD: {
    name: 'Deriverse',
    kind: 'constant-product pool and order book in one market',
    decodable: 'from_accounts',
    basis:
      'Its whitepaper: "Traders access an AMM’s continuous liquidity up to existing orderbook quotes, then consume on-chain limit orders, and finally resume against the AMM" (github.com/deriverse/Whitepaper). Its quoting code is published (github.com/deriverse/jupiter-deriverse); the program’s source was not found.',
  },
  DEXYosS6oEGvk8uCDayvwEZz4qEyDJRf9nFgYCaqPMTm: {
    name: '1DEX',
    kind: 'weighted pool, by one third party’s reading',
    decodable: 'not_established',
    basis:
      'DefiLlama’s 1INTRO adapter carries an interface named "1dex" at this address, whose pool holds up to four tokens with a balance and a weight each (github.com/DefiLlama/DefiLlama-Adapters, projects/1intro). The project’s own documents could not be opened.',
  },
  jupZ4m2GqUCJ5iueMfzQf8khFfH31d4XAQt3RzCT9Vd: {
    name: 'JupLend AMM',
    kind: 'concentrated liquidity on lending liquidity, around a centre price',
    decodable: 'from_accounts',
    basis:
      'Jupiter’s documents: "a concentrated-liquidity AMM that runs on top of the Jupiter Lend Liquidity Layer"; "The optional `center_price_address` field points at an external price source" (developers.jup.ag/docs/lend/dex.md). Its interface is published; the program’s source was not found.',
  },
  SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ: {
    name: 'Saber',
    kind: 'stable-swap pool',
    decodable: 'from_accounts',
    basis:
      'Source published under Apache-2.0: "An automated market maker for mean-reverting trading pairs" (github.com/saber-hq/stable-swap).',
  },
  Dooar9JkhdZ7J3LHN3A7YCuoGRUggXhQaG4kijfLGU2j: {
    name: 'StepN',
    kind: 'the exchange of the STEPN app (DOOAR)',
    decodable: 'not_established',
    basis:
      'STEPN’s whitepaper gives this address for its exchange DOOAR, with a 1% fee (whitepaper.stepn.com/other-modules/decentralized-exchange). Its pool accounts are 324 bytes, the size of an SPL token-swap pool; no page says which curve they use.',
  },
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: {
    name: 'Meteora DAMM v2',
    kind: 'constant-product pool with a price range',
    decodable: 'from_accounts',
    basis:
      'Source published with this program id: "the pool is constant-product but has a price range"; "dynamic fee is based on volatility" (github.com/MeteoraAg/damm-v2).',
  },
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: {
    name: 'Dynamic Bonding Curve',
    kind: 'bonding curve of a token launch',
    decodable: 'from_accounts',
    basis:
      'Source published with this program id: "a launch pool protocol" with "customizable virtual curves"; a token that reaches its threshold moves to a Meteora pool (github.com/MeteoraAg/dynamic-bonding-curve).',
  },
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': {
    name: 'Pump.fun',
    kind: 'bonding curve of a token launch',
    decodable: 'from_accounts',
    basis:
      'Its published documents, with this program id: "The bonding curve formula is based on Uniswap V2 and uses synthetic x and y reserves" (github.com/pump-fun/pump-public-docs, docs/PUMP_PROGRAM_README.md).',
  },
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: {
    name: 'Pump.fun Amm',
    kind: 'constant-product pool',
    decodable: 'from_accounts',
    basis:
      'Its published documents: "PumpSwap program is a constant-product AMM deployed at address pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA" (github.com/pump-fun/pump-public-docs, docs/PUMP_SWAP_README.md).',
  },
  FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X: {
    name: 'FluxBeam',
    kind: 'constant-product pool in the SPL token-swap layout',
    decodable: 'from_accounts',
    basis:
      'Its own API returns each pool with SPL token-swap’s fields and `curveType: 0`, the constant product (api.fluxbeam.xyz/v1/pools). The program’s source was not found.',
  },
};
