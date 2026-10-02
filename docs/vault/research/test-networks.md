# Test networks: what exists there and what we bring

Checked Fri Oct 2, 2026, about 14:00 to 15:00 UTC (US market open). Read-only: no account, faucet request, transaction or install.
Tags: `[S n]` a source read today, `[R n]` a chain read made today (calls listed at the end), `[repo]` this repo, `[memory]` not checked.

## Bottom line

- Robinhood Chain has a live public test network, chain id 46630. It carries Uniswap v4 (same pool manager code as mainnet), Permit2 and Robinhood's own test stock tokens. It has no Universal Router 2.1.2, no Uniswap v3 and no Chainlink feeds [S1][R2][S7].
- Base Sepolia runs the real stock-token standard (B20), and creating a B20 token is switched on there. Coinbase's stock tokens, their price feeds and Aerodrome are not there. Uniswap v3, v4 and Universal Router 2.1.2 are [R6][R7][S6][S9].
- Solana devnet has none of the mainnet stack. Jupiter's address is a plain wallet account, the SPYx mint does not exist, Kamino's devnet Scope is dead, and Pyth sponsors no SPY, QQQ, NVDA or TSLA feed [R9][R12][S14].
- So on every chain we bring a test price source, and on Solana also a test exchange. On the two EVM chains the test exchange can be real Uniswap contracts with our own pool.
- The vault code can stay identical if three things are config: the router id (Solana), the owner of the price account (Solana), and the pool factory the Base adapter accepts.
- Devnet SOL is the scarce input: about 5 to 7 SOL for programs plus headroom, and the official faucet allows 2 requests per 8 hours and asks agents not to use it [R8][S11].
- Nothing in Privy's free tier blocks test networks. Devnet and both EVM test chains are config only [S15].
- Proofs about the real tokens, real routes and real feeds stay on the mainnet-copy rigs in `spikes/`. A test network cannot show them.

## 1. Robinhood Chain test network

- It exists. Chain id 46630, gas token ETH, settles to Ethereum Sepolia. RPC `https://rpc.testnet.chain.robinhood.com` (rate limited), Alchemy `https://robinhood-testnet.g.alchemy.com/v2/{key}`, explorer `explorer.testnet.chain.robinhood.com` (Blockscout) [S1][S2]. The RPC answered `0xb626`; the latest block was seconds old; base fee 0.01 gwei [R1].
- It is busy: 127.6M blocks, 291M transactions, 24M addresses [R4]. Robinhood says it "remains available for development and testing" [S4].
- Faucet: `faucet.testnet.chain.robinhood.com` gives test ETH and test stock tokens (Tesla, Amazon, Palantir, Netflix, AMD) [S4]. It sits behind a browser check, so I could not read its limits. A secondary source says 0.05 ETH and 5 of each token per 24 hours [S5]. Other faucets named there: Alchemy (0.1 ETH a day, needs 0.001 ETH on mainnet), QuickNode, Chainstack, Chainlink (LINK only) [S5]. Not confirmed by me.
- Bridge for gas: the Arbitrum bridge from Ethereum Sepolia, about 10 minutes [S5]; the bridge contracts are listed [S2]. At 0.01 gwei a full deploy costs well under 0.001 ETH, so one faucet claim is enough.
- Test stock tokens are real issuer contracts: TSLA `0xC9f9…Bd4E`, AMZN `0x5884…9E02`, AMD `0x7117…778d`, PLTR `0x1FBE…98d0`, NFLX `0x3b82…8C93` [R4]. TSLA is a beacon proxy like mainnet NVDA, 18 decimals as the docs say for stock tokens [S3], and answers `uiMultiplier()`, `newUIMultiplier()`, `effectiveAt()` and `paused()`. Its implementation is a different build from mainnet's (10,992 against 11,614 bytes) [R3].
- Uniswap: v4 PoolManager, Quoter and StateView sit at the mainnet addresses with identical code hashes. PositionManager and the older Universal Router (`0x8876…0904`) are there too, and that router points at the testnet PoolManager [R2][R5]. Universal Router 2.1.2 (`0x204F…0498`) has no code. Uniswap v3 has no code at the mainnet addresses [R2]. Uniswap's own docs do not list this network [S6].
- There is third-party liquidity: the PoolManager holds about 350 TSLA, 386 AMZN and 122 WETH [R5]. I did not find which pools, or whether any is hookless against a dollar token.
- Permit2 and Multicall3 are at the usual addresses [S2][R2].
- Chainlink: no data feeds. Chainlink's config lists only Robinhood Chain mainnet (58 feeds, 33 equities), and the testnet feed file returns 404 [S7]. Mainnet feed and token addresses have no code on testnet [R2].
- Test dollar token: several tokens call themselves USDG or USDC [R4]. Could not confirm an official one.
- No stand-in chain is needed. Arbitrum Sepolia and a local fork stay as fallbacks only.

## 2. Base Sepolia

- Chain id 84532, RPC `https://sepolia.base.org`, explorer `sepolia.basescan.org` [S8]. Gas price read today: 0.006 gwei [R6].
- Faucets. Coinbase Developer Platform: 0.0001 ETH per claim, 1,000 claims per 24 hours, also 1 USDC ×10; needs a CDP account [S10]. Alchemy: 0.1 ETH per 24 hours; needs 0.001 ETH and history on Ethereum mainnet, no login [S10]. Chainlink's faucet lists Base Sepolia; terms not confirmed [S10]. Circle's faucet gives test USDC (`0x036C…CF7e`, 6 decimals) [S10][R6].
- Uniswap is deployed: v3 factory `0x4752…aD24`, SwapRouter02, position manager; v4 PoolManager `0x05E7…3408`; Universal Router 2.1.2 `0x8702…2650` (24,380 bytes, the same size as Robinhood mainnet's); Permit2 [S6][R6].
- Aerodrome is not deployed: its mainnet addresses have no code, and its repos carry constants for Base only [R6][S17]. Could not find any official test deployment.
- Chainlink: 9 feeds, all crypto or stablecoin (ETH, BTC, LINK, USDC, USDT, DAI, cbETH). No equity feed. ETH/USD was 90 seconds old [S7][R6]. No sequencer uptime feed on any test network; Chainlink has stopped adding them [S7].
- Coinbase stock tokens are not there. The public API lists one chain, 8453, and 58 tokens; the 20 I printed have 8 decimals [S9]; the NVDAc address is empty on Sepolia [R6].
- The standard itself is there. B20 tokens are precompiles (built into the node). The docs say the addresses are identical on mainnet and Base Sepolia [S8]. The activation registry on Sepolia returns true for asset creation and for policy writes, and the factory answers `getB20Address` [R7]. The docs name no caller restriction on `createB20` [S8]. Not tested: we send nothing.
- B20 asset tokens take 6 to 18 decimals, a scheduled multiplier (`uiMultiplier`, `effectiveAt`), pause per feature, allow and block lists, and seizure [S8]. A test token can match Coinbase's 8 decimals.
- Foundry. Plain `forge script`, `forge test` and `anvil` work for contracts that never touch a B20 address. Anything that runs a B20 call locally fails; Base's docs say to use their build (`base-forge`, `base-cast`, `base-anvil`) [S8], which is what the rig saw on mainnet [repo]. Sending with `cast send` or `forge create` runs on the real node, so it should work; the rig only dry-ran it [repo].

## 3. Solana devnet

**SOL for a deploy.** Rent is (bytes + 128) × 5,080 lamports, the same on devnet and mainnet [R8].

| Program size | Rent locked |
|---|---|
| 248,904 bytes (the rig) | 1.265 SOL |
| 300 KB | 1.52 SOL |
| 400 KB | 2.03 SOL |
| 500 KB | 2.54 SOL |

- The first deploy needs about the rent plus fees: the loader returns the buffer's SOL to the payer before it funds the program data [S11]. Each upgrade needs the rent again for a few minutes, then returns it [S11]. So hold about twice the rent. The CLI no longer doubles the allocation by default [memory].
- The vault program, a test program of about 250 KB, headroom for one upgrade and the accounts come to about 4.5 SOL if the vault program is 300 KB and about 6.5 SOL if it is 500 KB. Closing a program returns its rent; the id cannot be reused [S11].

**Getting SOL for free.**
- `faucet.solana.com`: at most 2 requests every 8 hours; GitHub sign-in raises the limit; the page says agents should not use it [S11]. A secondary source says 5 SOL per request [S11]; not confirmed.
- `solana airdrop 2` against the public RPC: rate limited, no published numbers [S11].
- Provider faucets: Helius needs a paid tier [S11]. Coinbase's gives 0.00125 SOL ×10 a day, useless here [S10].
- Proof-of-work faucet: `cargo install devnet-pow`, kept by Ellipsis Labs [S11]. It is an install.

**Resets.** The docs say devnet "may be subject to ledger resets", with no schedule [S11]. The genesis hash is the long-standing one, `EtWTRABZ…` [R8], so there has been no reset in years [memory]. Keep the deploy scripts re-runnable anyway.

**What is and is not there** [R9]:

| Thing | Devnet |
|---|---|
| Jupiter v6 (`JUP6Lkb…`) | Not a program: a wallet account with 4.5 SOL. We cannot deploy at that address |
| SPYx mint | Does not exist. Could not find any xStocks mint on devnet |
| Kamino Scope, mainnet id and price account | Do not exist |
| Kamino Scope, devnet id (`3Vw8Ngkh…`) [S13] | A program with 8 price accounts; the newest update is 16 days old, the rest years old [R12] |
| Pyth receiver and push oracle | Programs exist |
| Token-2022 | Exists, but a different build from mainnet's (hashes differ; devnet's was redeployed recently) [R11] |
| Orca Whirlpools (same id as mainnet), Circle test USDC (`4zMMC9…`) | Exist [R9][S10] |

- Jupiter's API docs give one base URL and no cluster option; every endpoint now needs an API key [S12]. Could not find a sentence saying "mainnet only", but with no program on devnet the answer is the same.
- The CPI depth limit is the same as mainnet: SIMD-0296 is inactive on both [R13].
- Pyth: the sponsored feed list covers mainnet and devnet, 64 feeds, and its only US equity is GLXY [S14]. Anyone may post an update, but the data comes from Hermes, which needs an API key since Aug 26 [S14]. Could not confirm that key is free. Reading Pyth means a `PriceUpdateV2` account and `get_price_no_older_than` [S14]: a different code path from Scope.
- Scope's layout, re-read on mainnet: 28,712 bytes, a 40-byte header, 512 entries of 56 bytes (value, exponent, slot, unix time). 440 entries had updated in the last 10 minutes [R12]. This matches the design [repo].

**SPYx on mainnet** (8 decimals, mint and freeze authorities set) [R10]:

| Extension | State on SPYx | Matters to a vault? |
|---|---|---|
| Transfer fee | Absent | Yes if present: the amount received would differ from the amount sent. The test token has none |
| Transfer hook | Authority set, program null | Yes: if a program is set, transfers need extra accounts and a CPI level. `upsert_asset` rejects it [repo] |
| Pausable | Not paused | Yes: every transfer of that mint fails while paused, withdraw included |
| Permanent delegate | Set | Yes: the issuer can move or burn the vault's balance; `tracked` is a hint [repo] |
| Scaled UI amount | 1.003909, new 1.005715 already in effect | Display only. Raw amounts and prices are unchanged; the 24-hour window before a change is check 10 [repo] |
| Default account state | Initialized | Only if it were frozen: a new token account would need the issuer |
| Confidential transfer | Configured, no auto-approve | No: the vault uses plain transfers |
| Metadata pointer, token metadata | Set | No |

## 4. Sign-in (Privy, free tier)

- Solana clusters are config: `config.solana.rpcs` with a `solana:devnet` entry, and a `chain` field on each sign-and-send call [S15]. That config is only needed for Privy's own wallet screens [S15]; we hide them and broadcast ourselves [repo], so the web only needs our devnet RPC.
- EVM: any chain through `supportedChains`; a custom chain is a viem `defineChain` with its RPC URL [S15]. viem 2.56.0 already ships `robinhoodTestnet` (46630) and `baseSepolia` [S15].
- Free tier: up to 499 monthly users, 50,000 signatures and $1M volume a month, passkeys and embedded wallets included. Gas sponsorship is a paid add-on [S15]. Nothing mentions test networks.
- Passkeys bind to the web origin, not to a network [repo], so the origin decision is unchanged.
- Not tested: an actual passkey sign-in against devnet. It needs a person and a browser.

## 5. RPC and hosting on free tiers

| Provider | Free limits | Test networks |
|---|---|---|
| Public devnet RPC | 100 requests per 10 s per IP, 40 for one method [S11] | Solana devnet |
| Helius free | 10 requests/s, `sendTransaction` 1/s, `getProgramAccounts` 5/s at 10 credits [S16] | Devnet RPC yes; its faucet is paid [S11] |
| Alchemy free | 30M compute units a month, 25 requests/s, "all mainnets & testnets" [S16] | Robinhood testnet is the documented endpoint [S1]; Base Sepolia |
| dRPC free | 210M units a month, 100 requests/s, public nodes [S16] | Robinhood testnet and Base Sepolia answer with no key; Solana devnet is paid only [R14] |
| Public EVM RPCs | Rate limited, no numbers [S1][S8] | Several dozen calls to the Robinhood testnet RPC today, none refused [R1] |

- The vault list on Solana uses `getProgramAccounts` [repo]: 10 credits and 5 a second on Helius free. Fine for a demo.
- Hosting is unchanged. One new always-on job: the price updater (below). It can run beside the keeper.

## Recommended setup: the smallest faithful one

**Robinhood testnet (46630).** Deploy the vault contracts, plus:
- Test stock tokens of our own: ERC-20, 18 decimals, with `uiMultiplier`, `newUIMultiplier`, `effectiveAt` and pause, so check 10 and the pause probe run and we can trigger them. Optionally also list Robinhood's own test TSLA to show the issuer's contract works.
- Test cash: our own 6-decimal token with a capped public mint.
- Test exchange: none of ours. A hookless Uniswap v4 pool per token on the existing PoolManager. For the router, deploy Universal Router 2.1.2 from Uniswap's repo so the keeper's call data builder is unchanged; the fallback is the older router already there and an older builder.
- Test prices: a small aggregator contract with `decimals()` and `latestRoundData()`, 8 decimals, the interface Robinhood's docs name [S3]. A script copies each round from the mainnet feed (answer and `updatedAt`), so the price moves in session and goes stale at the weekend exactly as mainnet does. Feeds for TSLA, AMZN, AMD, PLTR, NVDA, SPY and QQQ exist on mainnet [S7].

**Base Sepolia (84532).** The same contracts and aggregator, plus:
- Test stock tokens as real B20 asset tokens, 8 decimals, created through the factory, with us holding the pause and multiplier roles. Fallback if `createB20` refuses us: the plain test token above at 8 decimals.
- Test exchange: a Uniswap v3 pool per token. The `SlipstreamAdapter` calls `token0`, `token1`, `swap` and the v3 callback [repo]; a Uniswap v3 pool has the same shape. The factory it checks becomes config: Aerodrome's on mainnet, Uniswap v3's here.
- A test sequencer feed that reports "up", so the Base-only check runs.

**Solana devnet.** Deploy `programs/basket`, plus one small test program holding two things:
- `mock-router` (already in the design for LiteSVM [repo]). It accepts Jupiter's `route_v2` selector so the vault's selector check is unchanged, takes the input from the vault's token account (the vault signs), and pays out from its own reserve at the test price less a spread set in its config. Depth is 3, not 4.
- A price account with Scope's exact layout, written by an updater key. The script copies the entries we use (price and 1-hour average) from the mainnet Scope account, keeping the source's unix time and writing the devnet slot.
- Test tokens: Token-2022 mints with SPYx's extension set and 8 decimals, authorities ours. Test cash: our own mint, so the app can hand it out.

**What must be config for the same code to run.**
- Solana: `Config` in section 3.7 has no router field today [repo]. It needs the router program id (and the selector list if the mock does not reuse Jupiter's). If the program checks who owns the price account, that owner is config too. `source_check` stays zero on devnet.
- EVM: nothing new in the vault. Routers are already an allowlist and feeds are per asset [repo]. The Base adapter's factory is the one new parameter.
- Off-chain: reading vault state and prices is the same code. Building a swap is not: mainnet asks Jupiter's API, devnet needs a second `LiquidityProvider` that quotes from the test price and builds the mock instruction. On EVM the builders are unchanged; only addresses differ.

**What a test-network demo cannot show.** These stay on the mainnet-copy rigs:
- Real Jupiter bytes and account lists through the vault, depth 4, transaction size with lookup tables, compute units.
- The real stock tokens: SPYx on mainnet's Token-2022 build, Robinhood's mainnet implementation, Coinbase's B20 tokens with Coinbase's policies.
- The real price sources: Scope index remapping and off-hours behaviour, Chainlink's pause during corporate actions, the Base sequencer feed.
- Real pools: choosing a hookless pool among hooked ones, the Aerodrome pool, real depth and exit cost.
- Landing a transaction under mainnet load, and Jupiter's rate limits.

**Effort, in agent-half-days.**

| Piece | Half-days |
|---|---|
| EVM test stock token, test cash, aggregator, sequencer stub, with tests | 1 |
| Robinhood testnet: Universal Router 2.1.2 deploy, v4 pools, liquidity script | 1 |
| Base Sepolia: B20 creation script, v3 pools, adapter factory as config | 1 |
| Solana test program: `mock-router` reserves and pricing, Scope-layout account | 1.5 (0.5 is already in SOL-1) |
| Solana test mints with SPYx's extensions, test cash, seeding | 0.5 |
| Price updater for three chains, with provenance labels | 1 |
| Test-exchange `LiquidityProvider` for devnet | 0.5 to 1 |
| Chain config, deploy scripts with dry runs, explorer verification | 1 |
| Test cash and gas hand-out for new users (see open questions) | 0.5 |
| Total | about 8 to 8.5 |

**Needs a person.**
- Devnet SOL: `faucet.solana.com` with a GitHub sign-in, twice per 8 hours. Start a day early.
- Robinhood testnet ETH (and test stock tokens if we list one): the official faucet, in a browser.
- Base Sepolia ETH: a CDP account, or Alchemy's faucet with a mainnet wallet.
- Accounts: Alchemy (free app for Robinhood testnet), and the Privy dashboard for the test origin.
- Installs, if wanted: Base's Foundry build for local B20 tests; `devnet-pow`.
- Every deploy and every funded key, as on mainnet.

## Open questions

1. Who pays gas for a new person on a test network? A passkey wallet starts empty and Privy's gas sponsorship is paid [S15]. The cheapest answer is a rate-limited hand-out of test cash and a little gas from our own key. On Solana that draws on the scarce SOL: a 12-asset vault locks 0.027 SOL [repo].
2. Is `createB20` open to any caller on Base Sepolia? The docs imply it; only a transaction will tell. Send one before building on it.
3. Does the Robinhood faucet give enough test stock tokens to seed a pool, or do we rely only on our own tokens?
4. Does `programs/basket` check the owner of the price account? If so, add it to config in SOL-1.
5. Is a Hermes key free? Only matters if we ever want Pyth as a second price kind.
6. The 120-second freshness limit on Solana: the updater adds its own delay, so it must run every 30 seconds or less in session, or devnet config sets a looser limit.

## Sources

- [S1] docs.robinhood.com/chain/connecting, /add-network-to-wallet, /deploy-smart-contracts
- [S2] docs.robinhood.com/chain/protocol-contracts, /bridging
- [S3] docs.robinhood.com/chain/building-with-stock-tokens, /stock-tokens, /oracles-and-price-feeds, /stock-token-apis
- [S4] blog.arbitrum.io/robinhood-chain-testnet (Feb 11, 2026); robinhood.com/us/en/support/articles/robinhood-chain-mainnet
- [S5] datawallet.com/crypto/get-robinhood-chain-testnet-tokens (secondary, updated Sep 5, 2026), and a web search summary for the faucet amounts
- [S6] developers.uniswap.org/docs/protocols/v4/deployments, /v3/deployments/v3-base-deployments, /v3/deployments/v3-robinhood-chain-deployments
- [S7] docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood, /data-feeds/l2-sequencer-feeds; github.com/smartcontractkit/documentation `src/features/data/chains.ts`; reference-data-directory.vercel.app `feeds-robinhood-mainnet.json`, `feeds-ethereum-testnet-sepolia-base-1.json`
- [S8] docs.base.org: /get-started/connect-to-base, /get-started/get-funds, /specifications/reference/smart-contracts, /sdks/base-anvil, /upgrades/beryl/b20, /upgrades/cobalt/overview, /specifications/b20/reference/constants, /build-on-base/issue-rwa/create-an-asset-token, /build-on-base/integrate-defi/list-tokenized-stocks; github.com/base/base-std interfaces
- [S9] api.coinbase.com/v1/tokenized-stocks and /chains
- [S10] docs.cdp.coinbase.com/faucets/introduction/welcome; alchemy.com/faucets/base-sepolia; faucets.chain.link; faucet.circle.com; developers.circle.com/stablecoins/usdc-contract-addresses
- [S11] solana.com/docs/references/clusters; solana.com/developers/guides/getstarted/solana-token-airdrop-and-faucets; faucet.solana.com; helius.dev/docs/rpc/devnet-sol; helius.dev blog on Anchor (the 5 SOL figure); github.com/anza-xyz/agave `programs/bpf_loader/src/lib.rs`
- [S12] developers.jup.ag/docs/swap
- [S13] github.com/Kamino-Finance/scope `programs/scope/src/program_id.rs`, `lib.rs`
- [S14] docs.pyth.network/price-feeds/core/push-feeds/solana, /use-real-time-data/pull-integration/solana, and the Hermes notice on the API reference page
- [S15] docs.privy.io/basics/react/advanced/configuring-solana-networks, /configuring-evm-networks, /wallets/using-wallets/solana/send-a-transaction; privy.io/pricing; viem 2.56.0 `chains/definitions/robinhoodTestnet.ts`
- [S16] helius.dev/docs/billing (through the Helius docs tool); alchemy.com/pricing; drpc.org/pricing
- [S17] github.com/aerodrome-finance/slipstream and /contracts, `script/constants`

Chain reads, all today:
- [R1] Robinhood testnet RPC: `eth_chainId`, `eth_getBlockByNumber latest`
- [R2] `eth_getCode` on Robinhood testnet and mainnet for PoolManager `0x8366…0951`, PositionManager, Quoter, StateView, both Universal Routers, Permit2, Multicall3, the v3 contracts, mainnet NVDA, USDG and feed addresses; hashes compared
- [R3] test TSLA: `name`, `decimals`, `uiMultiplier`, `newUIMultiplier`, `effectiveAt`, `paused`, the beacon slot, the beacon's `implementation()`; the same for mainnet NVDA
- [R4] testnet Blockscout API: `/api/v2/stats`, `/api/v2/tokens?type=ERC-20`
- [R5] `balanceOf(PoolManager)` on test TSLA, AMZN, WETH; `poolManager()` on the testnet router
- [R6] Base Sepolia: `eth_chainId`, gas price, `eth_getCode` for the Uniswap addresses, Permit2, Multicall3, Circle USDC, Aerodrome's mainnet addresses, NVDAc and its feed; `latestRoundData` on ETH/USD and USDC/USD
- [R7] Base Sepolia: `isActivated(bytes32)` on `0x8453…0001` for the two feature ids in Base's docs; `getB20Address` on the factory; on mainnet, `isB20(NVDAc)`
- [R8] devnet and mainnet: `getMinimumBalanceForRentExemption` at five sizes, `getGenesisHash`, `getVersion` (4.3.0 on both)
- [R9] `getAccountInfo` on devnet and mainnet for Jupiter v6, the SPYx mint, Scope's program and price accounts, Pyth's two programs, Raydium, Orca, Token-2022, Circle USDC
- [R10] mainnet `getAccountInfo` (jsonParsed) on `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W`, slot 452,638,284
- [R11] the Token-2022 program data account on both clusters: deploy slot and SHA-256 of the program bytes
- [R12] devnet `getProgramAccounts` on `3Vw8Ngkh…` with `dataSize 28712`; mainnet `getAccountInfo` on `3t4JZcue…`, entries parsed
- [R13] `solana feature status -ud` and `-um`
- [R14] `eth_chainId` on `robinhood-testnet.drpc.org` and `base-sepolia.drpc.org`; `getSlot` on `solana-devnet.drpc.org` (refused: paid only)
