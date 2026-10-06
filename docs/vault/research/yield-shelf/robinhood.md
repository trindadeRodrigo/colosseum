# The yield shelf on Robinhood Chain: dollar fixed income for a test shelf

Oct 6, 2026. Research for `SHELF-YIELD` (`docs/vault/STATE-VAULT.md`), written from `docs/vault/PROMPT-YIELD-SHELF.md`. Rodrigo asked for the same screening as on Solana, with the same filters, on the list he mapped (`inputs/robinhood_chain_yield_assets.csv`, 30 rows; its yields are claims read on a date, not readings), and added two items to research and then ask about: Uniswap LP positions in dollar pairs, and Pendle PT-USDG. Two research threads ran in parallel, one agent each (the candidates; the pool share and the PT); the session that ran them read the decimals of four of the contracts and the PT's maturity again on chain, and they matched. Everything was read through public, read-only sources: `eth_call` on the chain's public RPC (chain id 4663), the sources the EVM depth collector uses (`scripts/risk-evm/`, read and not run), DexScreener, the lending protocol's and Pendle's public APIs, the issuers' pages. No transaction was sent and no key was used. The chain's explorer API refused requests that day, so no verified source code was read: transfer restrictions were tested on chain instead, by the contracts' getters and by simulating a transfer of nothing between two addresses on no list `[rpc]`. The code was read on `shelf/common` at `375720a`.

This note is the source of the rows in `packages/engine/src/personal/fixtures/shelves/robinhood-yield.json`, of their leg types in `leg-types.ts` and of their yields in `fixtures/yields-extended.json`. It lists nothing live: part (b), the rollout, is section 7.

Tags: `[n]` checked that day against source n. `[ns]` or `[ns n]` only a search-result snippet of source n was seen. `[rpc]` read on chain that day. `[api]` read from a public API that day, named. `[sheet]` only the input list says it; not verified. `[repo]` read in the code. `[run]` computed that day by the tests of this branch, on fixtures. `[own]` our reasoning, not from a source. Issuer and protocol names appear because the note is internal; what a person reads names the token only.

## 1. Bottom line

- **Three tokens are on the extended shelf and can be in a plan**: steakUSDG, syrupUSDG and spUSDG. Each passes the five filters with a caution. None is a rate leg: SGOV stays the chain's one rate token.
- **The PT is listed with its maturity and is in no plan**: PT-USDG, 25 March 2027. The engine has no maturity date; the model is section 5.2, for Rodrigo.
- **No pool share is listed.** The vault holds token balances only, Uniswap on this chain is v3 and v4, whose positions are not tokens a vault can hold, and no fungible wrapper over a dollar pair was found. The type question is section 5.1.
- **rUSDG goes to Rodrigo** (on hold; the recommendation is out). **mGLO and syrupUSDC are out.**
- **What it changes, on fixtures**: on the grid of 36 goals the share of a plan left in cash falls from 47.69% to 20.06%, the mean over the 39 candidates both shelves show `[run]`; the detail is in `comparison.md`. Two of the three tokens have no market route and take the thinnest tier, $1,500 a line, which is why a large plan still leaves a third in cash. These are MOCK figures from fixture yields and tier ceilings, not a reading of any market.

| Token | Issuer | Leg types | Tier | Verdict | The filter that decides |
|---|---|---|---|---|---|
| steakUSDG | Steakhouse, on Morpho | market_deposit | C | add with caution | 3: no market route, redemption only |
| syrupUSDG | Maple | credit, basis | A | add with caution | 3: one pool; the yield is the input list's |
| spUSDG | Spark | market_deposit | C | add with caution | 3: no market route, redemption only |
| PT-USDG-25MAR2027 | Pendle | rate, fixed to maturity | B | add with caution, held out | 3: a thin market; and the maturity |
| rUSDG | Mellow | none settled | C | hold, for Rodrigo | 5: a carry strategy with a cap that is not published |
| Uniswap dollar-pair LP | Uniswap | none fits | none | not listed | 1: the vault cannot hold it |
| mGLO | Midas | credit | none | out | 3: no pool, and redemption is for KYC'd addresses |
| syrupUSDC | Maple | credit, basis | none | out | 4: a contract with almost no supply on this chain |

## 2. The filters, and how the rows were made

1. A vault can hold it: no allowlist and no KYC on a transfer to a contract address.
2. It is a dollar asset.
3. It can be sold at a person's size. Depth is read from public, read-only sources. A thin market is not a reason to leave a token out; it is said, and the tier reflects it.
4. Live: not wound down, defunct or exploit-linked.
5. Low or medium risk: levered, algorithmic and junior tranches are out.

**The tier** is the launch shelf's rule, on the price impact of a sale into USDG: A, $50,000 at 35 bps or less; B, $10,000 at 35 bps or less; C, about $1,000 to $2,000 at 30 bps or less. One call was made here and is Rodrigo's to change `[own]`: **a token with no market route takes C, whatever its redemption allows.** steakUSDG and spUSDG both redeem $50,000 at once and at no price impact today, which by size would be A. They are C because the vault trades one token for one token through an allowed router (`contracts/src/BasketVault.sol`) and cannot call a vault's deposit or redeem yet, so redemption is not an exit a plan can count on. The tier is a fallback in any case: Bearing's measured exit replaces it at the rollout (gate `EXIT-SOURCE`).

**The fixture yields** are the dated figures of section 3, each with a haircut taken by hand, as the launch shelf's are: a quarter off a variable rate read from the protocol, half off a figure only the input list gives (syrupUSDG: no figure was read from the issuer). They are fixtures, plated MOCK wherever shown.

**The issuer** on a row is the name that groups tokens for the 50% issuer cap (gate `SOLVER-CAPS`): syrupUSDG carries "Maple", as syrupUSDC does on Solana.

**Geo-blocks**: no list was read for any of the tokens, so every row's `blockedCountries` is empty because it is unknown, and each row says so (`unverified`).

## 3. The tokens


### 3.1 The candidates

Read on chain between 15:33 and 15:37 UTC (blocks 81739082 to 81741059) `[rpc]`.

#### steakUSDG (Steakhouse Financial, on Morpho)

- **Verdict**: add with caution. Deciding filter 3: the only exit is redemption, and a fully borrowed market can block it [own].
- **Issuer and backing**: a Morpho Vault V2 named "Steakhouse USDG"; curator 0x9023…D2Fb, owner 0xCa50…db73, fees 0 [api Morpho, 2]. It holds 531.77M USDG of assets [rpc].
- **Mechanism and leg types**: one adapter (Morpho Market V1, 0x44AB…79c2) lends the USDG into four markets, all at 91.5% LLTV: USDe collateral $351.4M (66%), syrupUSDG $133.0M (25%), mGLO $32.3M (6%), spUSDG $13.2M (2.5%) [api Morpho, 2]. Leg: `market_deposit`. The collateral is basis (USDe) and credit (syrupUSDG, mGLO); the holder meets it only as bad debt if a liquidation fails, and mGLO can be redeemed only by greenlisted addresses [6], which narrows who can liquidate it [own]. The engine cannot express "market_deposit over basis/credit collateral" today [own].
- **Address**: 0xBeEff033F34C046626B8D0A041844C5d1A5409dd, 18 decimals, ERC-4626 with `asset()` = USDG [rpc]. Share price 1.009188 USDG (block 81740675) [rpc].
- **Transfer restrictions**: none active. The four gates (`receiveSharesGate`, `sendSharesGate`, `receiveAssetsGate`, `sendAssetsGate`) are the zero address; the simulated transfer passes; there is no `paused()` [rpc]. A curator can set gates later; the timelock was not read.
- **Redemption**: `withdraw` / `redeem` to USDG in one transaction, no KYC [rpc, own]. Idle USDG 2.34M [rpc]; withdrawable now $36.2M [api Morpho, 2]. The markets sit at 90% utilisation (USDe 90.4%, syrupUSDG 89.6%, mGLO 90.3%, spUSDG 90.1%) [api Morpho, 2]; at 100% a withdrawal waits. `maxWithdraw()` returns 0 and is not the live limit [rpc].
- **Geo-blocks**: none in the contract [rpc]. Front-end terms not checked.
- **Depth**: no DEX pool [api DexScreener, 3]. A $1k, $10k or $50k exit is a redemption at share price with no price impact, covered now by the $36.2M above (15:34 UTC).
- **Tier**: C with a caution, by the rule for "no DEX route". By size alone the redemption liquidity would carry A; the rule has no line for instant redemption [own].
- **Yield**: 3.99% net at the time of reading, 3.75% average net [api Morpho `netApy`, `avgNetApy`, 2026-10-06, 2]; the sheet's 3.69% was the app's figure the same day [sheet]. Variable. Live: the same API fields, or `convertToAssets(1e18)` sampled over time.
- **Incidents**: none found (not searched).
- **Not verified**: Morpho's docs on Vault V2 withdrawals and `forceDeallocate`; timelocks; audits; verified source.

#### syrupUSDG (Maple Finance)

- **Verdict**: add with caution. Deciding filter 3: it sells well today, in one $1.8M pool.
- **Issuer and backing**: Maple's syrupUSDG, launched 2026-07-01 on Ethereum and Robinhood Chain; "borrower interest is the source of returns", from over-collateralised institutional loans [8].
- **Mechanism and leg types**: on this chain it is a bridged token, not the pool: `asset()` and `totalAssets()` revert, and it has `getCCIPAdmin()` [rpc]. Legs: `credit` + `basis`, as syrupUSDC is typed in the repo; the basis part was not checked against Maple's allocation today [own].
- **Address**: 0x40858070814a57FdF33a613ae84fE0a8b4a874f7, 6 decimals, ERC-20, not a proxy; supply 134.06M [rpc]. About $133M of USDG is lent against it on Morpho [api Morpho, 2].
- **Transfer restrictions**: none found: no `paused()`, the simulated transfer passes [rpc]. Source not read.
- **Redemption**: none on this chain. Exit here is the pool. The issuer route (bridge back, then Maple's withdrawal queue) is not on Maple's page and was not verified [8].
- **Geo-blocks**: "Not available in all jurisdictions; eligibility restrictions apply", no list given [8]. Nothing on chain.
- **Depth**: Uniswap v4 syrupUSDG/USDG, fee 0.08%, tick spacing 5, no hook (pool id 0xeda1…9ae2), $1.81M liquidity [api DexScreener, 3]. Quoted with the v4 Quoter at block 81741059, 15:36:41 UTC [4]: $1k 0.0 bps impact (9.7 bps all-in against the pool mid); $10k 0.3 bps (9.9); $50k 1.4 bps (11.1); $250k 7.2 bps (16.9). Impact is price at size against price at $100. The pool key was derived by matching the pool id, so the repo's collector can quote it [own].
- **Tier**: A.
- **Yield**: no figure verified. The sheet says about 4.6 to 5.0% (Sep 2026) [sheet]; Maple's page shows none [8]. The 3.64% on Morpho is what lenders against syrupUSDG earn, not the token's yield [api Morpho, 2]. Live: none on this chain; the pool price is 1.0127 USDG [rpc] and was not checked against Maple's NAV.
- **Incidents**: none found (not searched).
- **Not verified**: yield; excluded countries; NAV against pool price; the bridge and its limits; source code.

#### spUSDG (Spark, Sky ecosystem)

- **Verdict**: add with caution. Deciding filter 3: exit is redemption against the USDG left in the vault.
- **Issuer and backing**: "Spark Savings USDG" [rpc]. The rate is a number set by Spark (`vsr`), not a market rate; the deposited USDG may be taken by Spark's liquidity layer, which then owes it back [own, from the contract's getters]. Today almost nothing is taken: 14.668M USDG sits in the vault of 14.690M total assets, 22.4k outstanding [rpc].
- **Mechanism and leg types**: `market_deposit`, with a note. `rate` does not fit (the rate is administered, not passed through); what the holder depends on is Spark's balance sheet and the USDG left in the vault [own]. It is also 2.5% of steakUSDG's collateral [api Morpho, 2].
- **Address**: 0xde770c84FE66E063336b31737cFE9790f18c4087, 6 decimals, ERC-4626 with `asset()` = USDG, upgradeable proxy (implementation 0x797c…5f02); supply 14.54M shares; deposit cap 500M [rpc].
- **Transfer restrictions**: none found; the simulated transfer passes [rpc]. Source not read.
- **Redemption**: `withdraw` / `redeem` in one transaction, no KYC, up to the idle USDG (14.67M now): $10k and $50k are covered [rpc].
- **Geo-blocks**: none in the contract. Spark's front-end terms not checked.
- **Depth**: no DEX pool [api DexScreener, 3]. Redemption at share price 1.010103 USDG, no price impact (15:36 UTC) [rpc].
- **Tier**: C with a caution, by the "no DEX route" rule (same remark as steakUSDG).
- **Yield**: 3.50%, from `vsr()` = 1000000001090862085746321732 per second, compounded over a year, read 2026-10-06 [rpc]. The sheet's 2.7 to 3.2% is older [sheet]; 2.73% is what lenders against spUSDG earn on Morpho [api Morpho, 2]. Live: `vsr()` by `eth_call`.
- **Incidents**: none found (not searched).
- **Not verified**: Spark's docs on what funds the rate and who may take assets; the "Credora A" rating [sheet]; audits.

#### rUSDG (Mellow Finance)

- **Verdict**: hold, for Rodrigo. Deciding filter 5. Recommendation: out, unless the leverage cap is shown to be low.
- **Issuer and backing**: Mellow's "USDG Yield Vault", a Core Vault; "Mellow is appointed to provide curation services" [7].
- **Mechanism and leg types**: "a capped stablecoin carry strategy with Morpho markets underneath" [7]. A carry on Morpho borrows against one dollar asset to hold another: leverage [own]. No leg type fits (set to null); nearest is `market_deposit` plus the carried asset's leg. The positions and the cap were not read. One sub-vault, 0x9bc4…e046 [rpc].
- **Address**: the share token is **0xf04c58853D54f2445989108C29087F1A61C034cB** (symbol rUSDG, 18 decimals, supply 988,125) [rpc]. The sheet's 0xCe93…bD3B is the vault, which is not a token: its `shareManager()` returns the address above [rpc].
- **Transfer restrictions**: none active: `flags()` = 0, whitelist root zero, the simulated transfer passes [rpc]. The contract has whitelist, lock-up and pause switches an admin can turn on [own].
- **Redemption**: deposit is immediate (`SyncDepositQueue`); withdrawal is request then claim, "typically 2–3 days" [7]; the oracle's redeem interval is 172,800 s and the last report is from today, not flagged [rpc]. Idle USDG in the vault: 0 [rpc].
- **Geo-blocks**: not checked.
- **Depth**: no DEX pool for the share token or the vault address [api DexScreener, 3]. Vault value about $1.0M (share price 1.0163 USDG from the oracle report of 05:49 UTC) [rpc]; $50k is 5% of it, through the queue.
- **Tier**: C with a caution (queue only).
- **Yield**: not verified; none in the docs read.
- **Incidents**: none found. Audits by Sherlock, Nethermind, MixBytes are claimed [7].
- **Not verified**: positions, leverage cap, fees, yield.

#### mGLO (Midas, strategy by Fasanara Capital)

- **Verdict**: out. Deciding filter 3: a vault can receive it and cannot sell it.
- **Issuer and backing**: tracks Fasanara's diversified alternative debt strategy: short-term invoice financing, over 700,000 receivables, about 140 originators, 60+ countries; about 80% with first-loss capital, over-collateralisation, insurance or a guarantee (Steakhouse, July 2026) [6].
- **Mechanism and leg types**: `credit` (private debt), valued monthly [6].
- **Address**: 0xFEd493F38c1aAcb4EA4e6A11F8b9287849EE0096, 18 decimals, ERC-20 proxy (implementation 0xf29a…f650), access control 0xe5F0…3cb5; supply 35.84M [rpc].
- **Transfer restrictions**: pausable (`paused()` = false). No allowlist on transfer: the simulated transfer passes [rpc]; "secondary token holders can transfer freely" [6]. Blacklist not read.
- **Redemption**: Midas only, with KYC and a greenlisted address [6][9 ns]. Instant route 0.5% fee, finite capacity; standard route monthly at NAV, about 35 days after valuation [6].
- **Geo-blocks**: KYC/AML eligibility; country list not read (Midas pages returned 403).
- **Depth**: no DEX pool [api DexScreener, 3]. No exit for an unlisted contract.
- **Tier**: C with a caution (no route).
- **Yield**: "target net yield of approximately 7%", not guaranteed [6]; a target, so no fixture figure. The 4.96% on Morpho is the lenders' rate against mGLO [api Morpho, 2].
- **Incidents**: none found (one search).
- **Not verified**: Midas's own documents; the redemption vault and its greenlist flag on this chain.

#### syrupUSDC (Maple Finance)

- **Verdict**: out. Deciding filter 4: not live on this chain.
- **Issuer and backing**: Maple's Syrup USDC; credit + basis as typed in the repo [own].
- **Mechanism and leg types**: `credit` + `basis`; here only an empty bridged token.
- **Address**: 0xC6a4854eeB493224d5f9485E12Dd3A81f22EEE14, 6 decimals, same code size and CCIP admin as syrupUSDG [rpc]. `totalSupply()` = 18000 raw, that is 0.018 token [rpc].
- **Transfer restrictions**: none found [rpc].
- **Redemption**: none here.
- **Geo-blocks**: not checked.
- **Depth**: no pool [api DexScreener, 3]. No USDC with real liquidity was seen on the chain: two tokens called USDC, pools of $0.67 and $5.1k [api DexScreener, 3].
- **Tier**: C (no route).
- **Yield**: none.
- **Incidents**: none found.
- **Not verified**: whether an official USDC exists on Robinhood Chain.

### 3.2 The pool share and the PT

Chain reads at block 81739511, 15:34 UTC `[rpc]`.

#### Uniswap dollar-pair LP (Uniswap v3/v4 positions, as a class)

- **Verdict**: out, for now. Deciding filter 1: the vault cannot hold it. No LP row goes on the shelf.

- **Issuer and backing**: no issuer. A position is a share of a pool of two dollar tokens; its value is whatever mix of the two the pool leaves it with [own].

- **Mechanism and leg types**: earns swap fees, and on some venues emissions. It fits none of the four leg types: `legTypes: null`. Nearest for the budget: `credit`. See the proposal.

- **Address**: there is no token. Uniswap on this chain is v3 (factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`) and v4 (position manager `0x58daec3116aae6d93017baaea7749052e8a04fa7`) [112]. A v3 position is an ERC-721; a v4 position is an entry in the position manager. DexScreener labels every Uniswap pair on the chain v3 or v4; no v2 pair was seen `[api: DexScreener]` [106].

| Pool | Version, fee | Address or pool id | Liquidity | 24h volume | Fungible? |
|---|---|---|---|---|---|
| USDe/USDG | Uniswap v4, 0.003% (lpFee 30) `[rpc]` | `0x85e97c42570003d5746ad75cb61f0f3c544c2938215a741b6b364e518eadf1d5` | $5,948 | $35,782 | no |
| USDT/USDG | Uniswap v4, lpFee reads 0 `[rpc]` | `0x6839d418eb38756bd905db1563caf0e3d46e43bd16c45b013e2aad6541182693` | $2,040 | $52 | no |
| "USDC"/USDG | Uniswap v4, lpFee 90%: a junk pool `[rpc]` | `0x4f9c68c484ec8903ef05f29794239daa9a50e44154e2fde1a6ac99e814b4bffe` | $0.67 | $0.01 | no |
| USDe/USDG | Uniswap v3, 0.01% | `0x5206FF70B86D5e293f1A776A94687707f655CF74` | dust (under $1) `[rpc]` | none | no |
| USDe/USDG | Uniswap v3, 0.05% | `0xe2791642E15cd8c6974C5a49eeB5F9385447Fc62` | dust `[rpc]` | none | no |
| USDe/USDG | Uniswap v3, 1% | `0xfC866B80A1FEE10ECC9436DBa521D4Ace8D34229` | dust `[rpc]` | none | no |
| USDe/USDG (context, not Uniswap) | Alandale | `0x00e7c2cC7A9e92425C9A995b11B2eE85645C2010` | $32,244 | $46,423 | not checked |
| USDe/USDG (context, not Uniswap) | Giga v3 | `0x1156162C2170DcAd64979F575ba91f23A47150Af` | $35,666 | $16,421 | no (v3) |

Liquidity and volume are `[api: DexScreener]` [106], read 15:35 UTC. USDe on this chain is `0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34`, 18 decimals, supply 361.6m `[rpc]`. The "USDT" (`0x5B5448Bb4101a136127CA8Bf60A9f669F93FC09b`, 18 decimals, supply exactly 1bn) and the "USDC" (`0x11D04a2491AB485a54dA3817C10C2A9178c7991e`) are not confirmed as the issuers' tokens.

- **Transfer restrictions**: not the question here. The vault holds ERC-20 balances only: it imports `IERC20` alone (`contracts/src/BasketVault.sol:5`), reads what it holds with `balanceOf` (`:907-910`, `:915`), withdraws with `IERC20.safeTransfer` (`:311-312`), and has no `onERC721Received` and no ERC-721/1155 code anywhere in `contracts/src`, `packages/chain-evm/src` or `packages/sdk/src` (grep: no match) [109]. The reader does the same (`packages/chain-evm/src/vault/reader.ts:60`, `:463`). A trade is one token in and one token out through an allowed router (`BasketVault.sol:291-292`), and any other held token that falls fails `OtherTokenDebited` (`:604`): adding two tokens to a pool is not a shape it accepts.

- **Fungible routes**: none found. (1) No Uniswap v2 dollar pool. (2) ERC-20 wrappers: one third-party guide says Arrakis, Gamma and UNILIQUID are deployed on the chain, with no address and no dollar-pair vault named [108]; DefiLlama's yield list for "Robinhood Chain" shows no Arrakis, Gamma, Steer or Ichi pool, and its only USDe-USDG LP is Alandale's ($31k) `[api: DefiLlama]` [107]. Steer and Ichi: nothing found.

- **Redemption**: burn the position for both tokens, then swap the USDe to USDG.

- **Geo-blocks**: none at the contracts; not researched further.

- **Depth** (the exit): all USDe/USDG liquidity on the chain is about $76k across five pools [106]. A $10k position returns about $5k of USDE to sell; a $50k position about $25k, which is a third of everything there is, and far more in a depeg, when the position is all USDe [own]. No executable quote was taken: not measured.

- **Tier**: none (not listed).

- **Yield**: is it real? On Uniswap v4 USDe/USDG: $35,782 of volume at 0.003% is $1.07 a day, about 6.6% a year on $5,948 of liquidity [own, from 104 and 106]. It is real fee income, but on a pool so small that a $10k deposit would cut it to about 2.5%. No Uniswap emissions or points on these pools were seen (not verified). On Alandale the same pair shows fee yield 0 and reward yield 66.8% [107]: emissions, not fees. No fixture figure is given.

- **Incidents**: none searched for the pools. USDe is a basis-trade dollar (Ethena); a depeg leaves the LP holding USDe [own].

- **Not verified**: an on-chain address for any Arrakis/Gamma/UNILIQUID vault on 4663; whether Alandale's pool token is an ERC-20; the USDT and USDC tokens' issuers; USDe's issuer on this chain; any swap quote for USDe to USDG.

#### PT-USDG-25MAR2027 (Pendle)

- **Verdict**: add with caution, on the extended shelf only and out of every plan until the engine counts a maturity. Deciding filter 3 (thin market).

- **Issuer and backing**: Pendle splits a deposit of USDG into PT (the principal) and YT (the yield). One PT is a claim on 1 USDG at maturity. SY-USDG wraps raw USDG 1:1: `yieldToken` = USDG, `exchangeRate` = 1e18, tokens in and out = [USDG], and it holds 107,477.84 USDG against a supply of 107,477.84 `[rpc]`. Not steakUSDG, not spUSDG. USDG is Paxos's dollar, backed by reserves that include short Treasury bills [105].

- **Mechanism and leg types**: a zero-coupon dollar: bought below 1, worth 1 USDG on 2027-03-25. `rate`, with the caveat that the rate is fixed by the market, not passed through. Why a discount exists on a token with no on-chain yield: YT buyers pay for a reward on USDG that the API reports at 3.3% (`underlyingInterestApy` 0, `underlyingRewardApy` 0.033) `[api: Pendle]` [102]; SY has no reward token on chain `[rpc]`, so that reward is paid elsewhere. YT is out: it is worth nothing at maturity.

- **Address**: PT `0x6982e39521a070a3c40782548bfbed6dc8f566ef`, 6 decimals, ERC-20, symbol `PT-USDG-25MAR2027` `[rpc]`. YT `0xf35ee6bd9a93fe42bc7e628bfc4ddbdc6de1f615` (6). SY `0x8d3127aabf76f95fe2970a0480b8662b4ad4c286` (6). Market (LP token `PLP-USDG-25MAR2027`, 18 decimals) `0xc2b89e6eca583e2c232201ac557e9be58af55f4c`. Maturity: `expiry()` = 1805932800 = 2027-03-25T00:00:00Z on PT and market `[rpc]`, 169 days from today. PT's `SY()` and `YT()` and the market's `readTokens()` agree with the API [101].

- **Transfer restrictions**: none seen on PT; SY `paused()` is false `[rpc]`. Source not read on an explorer. USDG under it can be frozen by its issuer (not verified today).

- **Redemption**: from maturity, PT redeems 1:1 into SY-USDG and SY pays USDG 1:1; no swap, no KYC, no minimum seen `[rpc]` [own]. Before maturity: sell on Pendle's market only. After maturity the market no longer trades.

- **Geo-blocks**: not verified (Pendle's terms not read today).

- **Depth** (selling PT to USDG, 15:36 UTC): $1k about 2 bps [own, from the market's state]; $10k 21 bps (9,827.50 USDG; the API's own impact 0.24%); $50k 100 bps (48,748.82 USDG; API 1.03%) `[api: Pendle convert]` [103]. The pool holds 27,561 PT and 79,785 SY, about $107k, and traded $28 in the last day [102]. Nearly all PT in existence (27,692) sits in the pool `[rpc]`.

- **Tier**: B.

- **Yield**: 3.28% a year fixed to maturity for a buyer today (`impliedApy` 0.03279, API time 2026-10-06T15:00Z) [102]. Live method: the market's `readState()` field `lastLnImpliedRate` = 0.032263, and exp(x) - 1 = 3.279% `[rpc]`; the two agree. PT price today 0.9851 USDG [own].

- **Incidents**: none found. Created on chain 2026-09-23 `[api]` [101]; announced live 2026-09-30 [105] [111s], which matches the sheet.

- **Not verified**: contract source, audits, Pendle's incident history, its terms and geo-blocks, who pays the USDG reward, whether Pendle's router is on the vault's allowed list.

## 4. Out, and why

Rodrigo's decisions of 2026-10-06, each confirmed in one line. mGLO and syrupUSDC, out by this research, are in section 3.1.

| Item | Deciding filter | Why, in one line | Source |
|---|---|---|---|
| USDG | not a yield asset | Cash token; reserve yield goes to partners, 0% to holders. 715.5M on chain. | [sheet], supply [rpc] |
| USDe | no base yield | Pays nothing unstaked; incentives only. It is the collateral of 66% of steakUSDG. | [sheet], [api Morpho, 2] |
| wstETH, weETH | 2 | ETH staking tokens, not dollar assets. | [sheet] |
| DEX LPs: up, Ramses X, Fables, Ekubo, PancakeSwap | 5 (and no leg type) | Fee and emission income with price risk; small or unverified. | [sheet] |
| Pendle YT; PT/YT-sNET | 5; 4 | YT is a levered claim on yield; the sNET market matured 2026-09-17. wsNET lenders earn 35% on Morpho, a sign of its risk. | [sheet], [api Morpho, 2] |
| Permissioned funds (BUIDL, OUSG, BENJI, USTB, USYC, VBILL, WTGXX) | 4 (and 1) | None deployed on this chain. | [sheet] |
| sUSDe, sUSDS, USDtb, USD0++, USDY | 4 | Not deployed on this chain. | [sheet] |
| Robinhood Earn | 1 | An app account for eligible users, not a token; it sits inside steakUSDG. | [sheet] |

## 5. For Rodrigo

### 5.1 The Uniswap pool share: not listed; a type to record for later

The holdability answer is no, so nothing is listed (section 3.2). The modelling choice, for the day a fungible dollar-pair token exists on this chain, is in the proposal below: the nearest existing type (`credit`, or `market_deposit`) or a new one (`pool_share`). **Recommendation: a new type, and build nothing now.**

#### Proposal: Uniswap LP

**Found.** The vault holds ERC-20 balances and trades one token for one token. Uniswap here is v3/v4 only. No fungible LP token over a dollar pair exists on the chain. Holdability is **no** for every route today.

**Options for the leg type, for the day a fungible one appears.**
1. `market_deposit` (nearest by name: "a deposit that can be hard to leave"). Wrong risk: a market deposit keeps its dollar value; an LP ends up holding the token that fell. Its 60% cap is far too loose.
2. `credit`. Right budget (it counts against `creditShareBps`, cap 40%), wrong word: there is no borrower.
3. A new type `pool_share`. Cap proposed at 2000 bps per asset, to be tuned like C8: mark the pair's other token down and count the months still paid, with the position counted as all in the fallen token. It always counts against the credit budget. The pair's other token also brings its own types (USDe brings `basis`).

**Recommendation: option 3, and build nothing now.** Keep the LP off the shelf (gate rule: no listing until it can be held). Record the type decision so the next fungible candidate has a home.

**Trade-offs.** A fifth type touches every table keyed by leg type and the words shown to a person; it is not worth it for zero listable assets. Option 2 would cost nothing but mislabels the risk in the plan's own text.

**What would change (later).** `packages/engine/src/personal/leg-types.ts` (`LegType`, `CREDIT_LEG_TYPES`); `params.ts` `capPerAssetBps.byLegType` plus its status row; the C8 test gets a pair-depeg case; a test that every `LegType` has a cap. Vault side: a single-token-in router for the wrapper on the config's allowed list (`BasketVault.sol:291`), or the two-token add fails at `:604`.

### 5.2 Pendle PT-USDG: listed, held out; the model for a maturity

The PT is on the extended shelf with its maturity (`maturity: 2027-03-25` on its row) and the reason it is in no plan. Nothing in the engine was changed: the row is held out by the loader, not by `buildWorld`. **Recommendation: build the model below as one slice, after Rodrigo's word; type it `rate`.** YT is out: it is a claim on the yield alone and is worth nothing at maturity.

#### Proposal: Pendle PT-USDG

**Found.** A live, plain ERC-20 that pays 1 USDG on 2027-03-25. The engine has no date on an asset: `ScheduleInputs` (`schedule.ts:32-55`) has `nowMonth`, `months`, `atPar` and per-asset yields, and nothing that changes an asset in a given month. `BasketAsset` (`packages/schemas/src/basket-asset.ts:25-60`) has no maturity field and is shared.

**Smallest honest model.**
1. Type: `rate` in `LEG_TYPES`, with the source note "fixed to maturity; SY wraps raw USDG".
2. The date: an engine-local table beside `LEG_TYPES`, e.g. `MATURITIES: Record<symbol, { maturesAt, redeemsInto, source, readAt }>` (new `packages/engine/src/personal/maturity.ts`). No edit to `BasketAsset` now. Flag for Thom: an optional `maturesAt` on the shared type, with the slice-2 schema commit that moves leg types.
3. Price and exit before maturity: the line is worth its market price, and a sale costs what Bearing measures on Pendle's market (a decoder in `packages/risk` reading `readState()`); until that exists it is unmeasured and takes the tier ceiling (`ceilingUsdOf`) and `unmeasuredCost`, labelled a fallback (gate `EXIT-SOURCE`).
4. Schedule: `scheduleOf` gets `maturityOf?: (asset) => string | null`. In the maturity month the `Held` line becomes cash at par (kind `cash`, no sale cost, no yield after). Before it, it is drawn like any dollar-yield line at the measured cost. `yields_fall` does not touch it (the rate is fixed).
5. Eligibility in `buildWorld` (`world.ts:221`): leave the PT out, with the reason, when it matures after the date the money is needed, or when it has already matured. `byLiquidity`/`placeSetAside` (`set-aside.ts:57`, `:69`) may use it for a withdrawal only in or after its maturity month.
6. Yield row: `method: "pt_implied_to_maturity"`, source the market's `lastLnImpliedRate`, with `fetched_at`. No literal in code.

**Interim.** List the PT on the extended shelf with its row in `MATURITIES` and no plan weight: `buildWorld` leaves out any asset that has a maturity row, with the reason "matures on 2027-03-25; the schedule does not count a maturity yet".

**Recommendation: do the interim now, the model (steps 1 to 6) as one slice later.** Trade-offs: the side table keeps Thom's type untouched but is a second place to look; a PT that matures becomes idle cash until a rebalance; the pool is thin, so real plans could hold only small lines (tier B).

**Tests that pin it.** A PT line is cash at par from its maturity month and never before; a goal ending before maturity leaves it out with the reason; an expired PT is refused; `yields_fall` leaves its income unchanged; every `MATURITIES` symbol has a `LEG_TYPES` row; the interim test: a shelf with the PT yields plans with no PT line and the reason shown.

### 5.3 A verdict the filters do not settle: rUSDG

On hold, listed and in no plan. **Recommendation: out, on filter 5.** The issuer's documents call it a capped stablecoin carry strategy with lending markets underneath, which is leverage; the positions and the cap are not published in what was read. It holds about $1.0M, keeps no idle USDG, and redeems by request and claim, typically in 2 to 3 days `[7]`. The input list's address is the vault, not a token: the share token is `0xf04c58853D54f2445989108C29087F1A61C034cB` `[rpc]`. Revisit only if the cap is shown to be low.

### 5.4 Calls made here, for Rodrigo to overturn

- **The tier of a token that only redeems** (steakUSDG, spUSDG): C today, for the reason in section 2. On the grid this is the difference between 20% and nearly nothing left in cash. If the vault gains a deposit and redeem leg, tier them by the liquidity free to withdraw, which Bearing would measure (steakUSDG: $36.2M withdrawable at about 90% utilisation `[api: 2]`; spUSDG: 14.67M of 14.69M USDG idle `[rpc]`).
- **steakUSDG is typed `market_deposit`, which does not say all of it.** It lends USDG against four tokens at 91.5% loan-to-value: USDe 66%, syrupUSDG 25%, mGLO 6%, spUSDG 2.5% `[api: 2]`. Its borrowers' collateral is basis and credit, so a fall in those tokens reaches the vault through bad debt, and the four leg types have no way to say so. It does not count against the credit budget. Rodrigo may prefer to count it there.
- **spUSDG is typed `market_deposit`, not `rate`.** Its rate is set by the issuer's governance and paid from lending deployments, not passed through from a sovereign rate; `market_deposit` is the nearest of the four. Typed `rate` it would enter the safe-yield sleeve, which this note does not think it has earned.
- **mGLO is out on secondary sources.** That redemption needs a greenlisted, KYC'd address comes from the curator's write-up of July 2026 and a search snippet; the issuer's own pages refused the reader. A contract can receive the token (a transfer between unlisted addresses passes `[rpc]`), but with no pool and a permissioned redemption a vault cannot leave it. Say if it should be held instead.
- **syrupUSDG's yield is the input list's**: the low end of 4.6 to 5.0%, with half taken off. No figure was read from the issuer.

## 6. What could not be verified

- **Verified source code** for every contract: the explorer's API refused. Restrictions were tested on chain by getters and a simulated transfer of nothing, which passed for all six candidates.
- **Geo-blocks** for every token: the front-ends' terms were not read.
- **Maple**: syrupUSDG's yield, the excluded countries, the bridge route and withdrawal timing, and whether the pool price (1.0127 USDG) equals the net asset value.
- **Spark**: what funds the rate and who may take the assets; the rating the input list cites.
- **Morpho**: the vault's withdrawal rules and curator timelocks, audits. `maxWithdraw()` returns 0 on the vault, so it cannot be the live limit.
- **Mellow**: positions, the leverage cap, fees, a yield.
- **Midas**: the redemption vault and greenlist on this chain, from the issuer's own documents.
- **Pendle**: source code, audits, incidents, terms; who pays the reward behind the PT's rate and whether it can stop; whether Pendle's router is on the vault's allowed list.
- **The pool share**: an address for any wrapper vault on the chain; the issuers of the tokens called USDC and USDT here, and of USDe on this chain; no swap quote was taken for USDe into USDG.
- **Incidents** were searched for mGLO only.

## 7. Rollout (b)

Not done here. Nothing below is started. Per token added to plans, what is left and who does it:

| Step | What | Who |
|---|---|---|
| The contract on mainnet | Read again the address, decimals and standard of each token on the day of listing: steakUSDG (ERC-4626, 18 decimals), syrupUSDG (ERC-20, bridged, 6), spUSDG (ERC-4626, 6), in section 3 | Rodrigo's session, read-only |
| A live yield source | steakUSDG: the vault's net rate from the lending protocol's public API. spUSDG: the vault's rate by `eth_call`, annualised. syrupUSDG: none read; the issuer's figure, or the token's price over time. Each with `source`, `fetched_at` and `method` | Rodrigo (feeds) |
| How the vault enters and leaves | steakUSDG and spUSDG have no pool: the EVM vault needs a deposit and redeem leg for an ERC-4626 vault, or a router on its allowed list that does it in one call. syrupUSDG trades on one Uniswap v4 pool the collector can already quote | Thom |
| Bearing's exit measurement | The collectors are not edited before Oct 12 (`CLAUDE.md`). Until then each added token takes its tier ceiling, labelled a fallback. After: syrupUSDG's pool in the EVM collector's universe; a free-liquidity reading for the two vaults | Rodrigo, after Oct 12 |
| The vault's on-chain asset list | The EVM registry entry for each token, with its price reference (none of the three has a Chainlink feed that was verified). A deploy: it needs a person's word | Thom |
| The production registry row | One row per token with its class, issuer, tier or measured cap, `blockedCountries` once the terms are read, and its leg types on the shelf row when the schema commit moves them there | Rodrigo, Thom for the schema |
| The decision | A `/decide` entry under gate `UNIVERSE` for the final list, with the answers to section 5 | Rodrigo |

The PT needs section 5.2 decided and built first; rUSDG needs section 5.3.

## 8. Sources

[1] Robinhood Chain public RPC, `eth_call` / `eth_getStorageAt`, https://rpc.mainnet.chain.robinhood.com, blocks 81739082 to 81741059, read 2026-10-06 15:33 to 15:37 UTC.
[2] Morpho, public GraphQL API (`vaultV2ByAddress`, `markets` with chainId 4663), https://api.morpho.org/graphql, read 2026-10-06 15:34 UTC.
[3] DexScreener, token pairs API, https://api.dexscreener.com/latest/dex/tokens/<address> and /latest/dex/search, read 2026-10-06.
[4] Uniswap v4 Quoter 0x8dc178efb8111bb0973dd9d722ebeff267c98f94 and StateView 0xf3334192d15450cdd385c8b70e03f9a6bd9e673b on Robinhood Chain (addresses from the repo's `scripts/risk-evm/config.ts`), `eth_call` at block 81741059, read 2026-10-06.
[5] Rodrigo's spreadsheet, `docs/vault/research/yield-shelf/inputs/robinhood_chain_yield_assets.csv`, read 2026-10-06.
[6] Steakhouse Financial, "Midas Fasanara mGLO in Morpho Onchain Repo", https://kitchen.steakhouse.financial/p/midas-fasanara-mglo-in-morpho-onchain, read 2026-10-06 (dated July 2026).
[7] Mellow Finance docs, "USDG Yield Vault: Overview", https://raw.githubusercontent.com/mellow-finance/docs/HEAD/usdg-vault/overview.mdx, read 2026-10-06 (docs pull request #12, 2026-09-29).
[8] Maple Finance, "syrupUSDG", https://maple.finance/insights/syrupusdg, read 2026-10-06 (launch dated 2026-07-01).
[9] TipRanks, "Midas Aligns mGLO Strategy With Launch of Robinhood Chain", https://www.tipranks.com/news/private-companies/midas-aligns-mglo-strategy-with-launch-of-robinhood-chain, search snippet only, 2026-10-06.
[101] Pendle, API "markets/active", https://api-v2.pendle.finance/core/v1/4663/markets/active, read 2026-10-06
[102] Pendle, API market data, https://api-v2.pendle.finance/core/v2/4663/markets/0xc2b89e6eca583e2c232201ac557e9be58af55f4c/data, read 2026-10-06 (its timestamp: 2026-10-06T15:00Z)
[103] Pendle, API "convert" quote (enableAggregator=false), https://api-v2.pendle.finance/core/v2/sdk/4663/convert, read 2026-10-06
[104] Robinhood Chain public RPC, `eth_call` reads at block 81739511, https://rpc.mainnet.chain.robinhood.com, read 2026-10-06
[105] Crypto Briefing, "Pendle brings fixed yield to Robinhood's USDG stablecoin with March 2027 market", https://cryptobriefing.com/pendle-fixed-yield-usdg-robinhood-chain/, read 2026-10-06 (dated 2026-09-30)
[106] DexScreener, API token and search, https://api.dexscreener.com/latest/dex/search?q=USDG%20USDe, read 2026-10-06
[107] DefiLlama, yields API, https://yields.llama.fi/pools, read 2026-10-06
[108] Lore Research, "Robinhood Chain Liquidity Farming & LP Yield Guide (2026)", https://loreresearch.xyz/c/liquidity/, read 2026-10-06 (third party, no date shown)
[109] This repository (read on `shelf/common`), `contracts/src/BasketVault.sol`, `contracts/src/interfaces/IBasketVault.sol`, `packages/chain-evm/src/vault/reader.ts`, read 2026-10-06
[110] This repository, `packages/engine/src/personal/{leg-types,params,schedule,world,set-aside}.ts`, `packages/schemas/src/basket-asset.ts`, read 2026-10-06
[111] TradingView / CoinMarketCal, "Pendle: USDG fixed yield goes live on Robinhood Chain - 30 Sep 2026", https://www.tradingview.com/news/coinmarketcal:32db4e92f094b:0-pendle-usdg-fixed-yield-goes-live-on-robinhood-chain-30-sep-2026/, snippet only, 2026-10-06
[112] This repository, `scripts/risk-evm/config.ts` (RPC, v3 factory, v4 quoter, state view, position manager), read 2026-10-06
