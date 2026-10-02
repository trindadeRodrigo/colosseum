# Vaults, auto-follow and nesting: decision memo

Oct 1, 2026, for Thom and Rodrigo, from the six notes in `research/vaults/`. No stream ran a live trade, so the tests in section 5 come first.

## 1. The answers

1. **Q1.** Own vault per basket per chain. A community index is a public, versioned recipe that follower vaults copy. No shared pools, no hybrid.
2. **Q2.** Auto-follow is sound only if the vault itself checks every keeper trade: recipe assets only, proceeds land back in the vault, price within a set distance of a reference price, loss capped per week. "Swap only, never withdraw" on its own is not enough.
3. **Q3.** Nest by reference and flatten: a personal basket points at a community index and the vault holds only the underlying assets. One level deep, same chain.
4. **Q4.** One-tap, user-signed rebalance on all three chains is the baseline. Auto-follow goes live per chain only where its day-1 test passes, Solana first, off by default, with a deposit cap.
5. **Cost.** A small custom vault program on Solana and one Solidity vault shared by Base and Robinhood Chain, both unaudited. Off-the-shelf wallets (Swig roles, Safe, session keys) cannot do the price check.

## 2. Q1: own vaults, shared pool, or hybrid

"Hybrid" means own vaults plus an optional fixed index token, the only pooled form that is safe to ship fast.

| | Own vault per person | Shared pool, followers hold shares | Hybrid |
|---|---|---|---|
| Personalization | Full: exclusions, caps and eligibility per person | None, everyone holds the same thing | Only on the vault side |
| Convenience for followers | Every vault must be rebalanced, by a tap or by auto-follow | One rebalance covers everyone | A fixed token never changes |
| Cost | About $0.02 (Base) and $0.05 (Robinhood) in gas per 5-leg rebalance (estimate); one transaction per leg on Solana | Lowest per follower | Both |
| Safety | No share price to attack; a leaked keeper key is capped per vault; a freeze hits one person | Share price can be gamed; one bad rebalance or one freeze hits everyone | Pool risks return if the token ever rebalances |
| Legal | No share token, the usual fund trigger. Auto-follow still looks like portfolio management | Looks like a fund; mixes eligible and ineligible holders | Fund question returns for the token |
| Cross-chain | One vault per chain | One pool per chain anyway | Same |
| Build effort | One small contract per chain family | Timelocks, role splits, auctions, lockups, audits | A day to fork, but it is the clone category |

Precedents:

- **Own accounts are what current stock-token products chose.** Glider creates one smart account per portfolio per chain ([docs](https://docs.glider.fi/guides/security-architecture)). Bitwise launched on Aug 25, 2026 with Coinbase stock tokens in each user's own account on Base, rebalanced by Glider ([CoinDesk](https://www.coindesk.com/business/2026/08/25/bitwise-turns-coinbase-s-tokenized-stocks-into-automated-ai-robotics-and-tech-portfolios)). Cesto keeps tokens in the main wallet ([docs](https://docs.cesto.co/llms-full.txt)), so overlapping baskets cannot be separated (inference).
- **Every pool that rebalances ended up with heavy machinery.** Enzyme answers share-price arbitrage and manager extraction with timelocks, entrance fees and a loss cap ([specs](https://specs.enzyme.finance/topics/known-risks-and-mitigations)). Indexed Finance lost about $16M in 2021 when its pool valuation was distorted during a re-index ([rekt](https://rekt.news/indexed-finance-rekt), secondary source).
- **The pools that shipped fast dropped rebalancing.** Robinhood Chain's reference dapp and Vimen are fixed, in-kind and manager-free ([repo](https://github.com/hummusonrails/robinhood-chain-dapp-example)). All index products there hold about $11k combined ([DefiLlama](https://defillama.com/protocols/indexes/robinhood-chain), search snippet).

Thin evidence: the legal row is inference, and the TVL figures are from search snippets.

## 3. Q2: auto-follow

### How it works

Turning on auto-follow for one basket lets our keeper call one function, `rebalance`, on that vault. The vault, not the keeper, decides whether each trade is allowed.

1. Both tokens are in the recipe version the owner accepted, or the cash token.
2. What was bought is in the vault afterwards. The vault measures its own balances and ignores what the router reports.
3. The vault received at least the reference (oracle) price minus a tolerance.
4. The trade moves the vault toward its target and no further.
5. Loss and turnover are capped per period, with a cooldown.
6. The owner can switch it off and withdraw the tokens themselves at any time. No pause, keeper or oracle can block that.

Rule 3 is what the original proposal lacked. No wallet framework reviewed checks price.

### How it gets abused

| Abuse | What stops it |
|---|---|
| A leaked keeper key trades vaults into a thin pool the attacker prepared. 3Commas, 2022: trade-only keys, $14.8M lost ([BleepingComputer](https://www.bleepingcomputer.com/news/security/crypto-platform-3commas-admits-hackers-stole-api-keys/)) | Price check plus a weekly loss budget, as dHEDGE and Enzyme added ([source](https://github.com/dhedge/V2-Public/blob/master/contracts/utils/SlippageAccumulator.sol)) |
| Keeper sends swap proceeds to its own account | The balance check. A Swig role cannot do this ([source](https://github.com/anagrambuild/swig-wallet)) |
| Keeper churns back and forth, losing the tolerance each time | Toward-target rule, cooldown, loss budget |
| Creator adds a thin token they hold, and follower vaults buy it | Platform asset list with liquidity floors; a new asset needs the follower's tap; cap on weight change per version; one version per day |
| Creator, or anyone, buys before followers and sells into them | The price check makes the vault wait instead of buying high. Reduced, not removed |
| Stale price at night or on weekends | Stock legs trade only in US regular hours, and not near a multiplier change |
| Something sent to the vault blocks the exit (a dHEDGE [audit finding](https://github.com/santipu03/santipu03/blob/main/private-audits/dHEDGE_GMX.md)) | In-kind withdraw that calls no router. Test it |
| Issuer pause, freeze or seizure | Nothing. Disclose it; every leg must leave the vault valid |

### Minimum guardrails for the MVP

The six rules, plus: a 12 to 24 hour delay between a new version and the first keeper trade, a pause switch that stops the keeper and cannot move funds, a deposit cap per vault, a keeper key that holds nothing else, and a visible "last synced" status.

Starting numbers, all uncalibrated: tolerance about 0.75% on Solana and 1 to 1.5% on EVM, a loss budget of about 2% per week, a one-hour cooldown. A hostile keeper can still take up to the budget, so the pitch says "no worse than X% from reference, at most Y% a week, revoke or withdraw any time", never "cannot lose funds".

### Many vaults trading at once

- One job per vault, in random order with a random delay, so early vaults don't get better prices than late ones.
- Skip legs under 1% of the vault or $5. Split orders that are large against pool depth.
- If the price check fails, wait, retry and alert: someone is leaning on the pool.
- Solana: one leg per transaction, not atomic, so the app shows "rebalancing 2 of 4". EVM: one transaction per rebalance.
- Cap the money that can follow an index relative to pool depth.
- Netting and auctions wait. In a recipe change every follower trades the same way, so netting saves little.

Not measured: what a popular index update costs on thin Solana pools (gold has about $0.9M of liquidity).

### Legal

ESMA and the FCA treat automatic execution with no client action per trade as portfolio management. ESMA names "auto-follow" buttons, and says limits or a veto window do not change it ([ESMA](https://www.esma.europa.eu/sites/default/files/2023-03/ESMA35-42-1428_Supervisory_Briefing_on_Copy_Trading.pdf), [FCA](https://www.fca.org.uk/firms/copy-trading)). CVM treats paid copy trading as securities analysis that needs a credential ([circular](https://conteudo.cvm.gov.br/export/sites/cvm/legislacao/oficios-circulares/sin/anexos/oc-sin-0325.pdf)). So the delay is a safety feature, not a legal fix. Keep auto-follow off by default, run no creator fees, and name a licensed partner for a real launch. This is a reading of the texts, not legal advice.

### Where the streams disagreed

- **Swig sub-account or custom program.** One stream proposed Swig as the vault, as Glider uses. Two others read Swig's source: a role checks which program is called and how much leaves, not where output goes or at what price. Custom program wins; Swig stays as the passkey wallet that owns the vault. Glider's own onchain scope is unpublished.
- **Tolerance.** One stream proposed 0.75%. Another found Chainlink stock feeds hours old in an open session, so EVM needs 1 to 1.5%.
- **Session keys on EVM.** Glider uses them. They filter calls and cap spend but cannot check a trade's result, so a small vault contract is simpler.
- **Which EVM chain first.** One stream said Base (Bitwise proves it); another said Robinhood Chain (testable without real money). The code is shared: build on Robinhood Chain, then deploy to Base.

## 4. Q3: baskets inside baskets

1. Two tiers. Community indexes hold assets only. Personal baskets hold assets and community indexes. Depth is one, so loops are impossible.
2. Store a reference (index, weight, follow or pinned). The vault holds only the underlying assets. No share token, no vault inside a vault; dHEDGE's nested path produced a withdrawal-blocking bug.
3. Flatten off-chain: multiply weights, merge duplicates, then apply the person's exclusions, caps and eligibility. Drop anything under 0.5% or $5. Cap at 15 positions.
4. Same chain only. An index is published per chain.
5. One net rebalance per vault. A new index version arrives through the normal follow path, prompt or auto-follow.
6. No fees in the MVP. Later, a creator fee applies only to that creator's slice, never fee on fee.
7. A retired index freezes at its last version.
8. Slices are computed numbers, not sub-accounts, so per-slice performance needs a written method.

M1 pies work this way ([help](https://help.m1.com/en/articles/9331915-what-is-a-pie)). No onchain product was found that does.

## 5. Per-chain reality

| | Solana | Base | Robinhood Chain |
|---|---|---|---|
| A vault is | An account owned by our small Anchor program, one per basket, with a token account per asset | A small Solidity contract per basket, created by a factory | The same Solidity contract |
| Confirmed | Kamino and Jupiter Lend hold xStocks in program accounts. Jupiter publishes a vault-swap example ([repo](https://github.com/jup-ag/jupiter-cpi-swap-example)). A swap leg uses 23 to 48 of the 64 accounts a transaction allows | Transfer policy is a deny-list today, so any address can hold the tokens (read from chain). Chainlink feeds for all 10. Bitwise is live on this model | Token has no per-address gate (function scan). Pools hold about $6M of NVDA. Testnet with a faucet |
| Uncertain | No swap was run from a program vault. Pyth's 24/7 token feed needs an API key (free trial, [docs](https://docs.pyth.network/price-feeds/core/upgrade/preparing)) and its price unit is unknown; the share-price feed runs 09:30 to 16:00 ET only. Program call depth is capped at four, which a vault-to-Jupiter swap already uses ([SIMD-0268](https://github.com/solana-foundation/solana-improvement-documents/pull/268) not active, search snippet) | Tokens are built into the chain, so a local fork may not run them. Coinbase can switch to an allowlist with no enforced delay. Swap router for the main Aerodrome pool not identified | Token source unread, so a transfer-time check is possible. Price feeds for only 36 of 195 tokens ([directory](https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json)). Aggregator support for a contract trader unverified |
| Cheap test | $10: vault buys SPYx through Jupiter; record accounts and compute; fetch a Pyth SPYx price and compare it with a Jupiter quote; repeat from a Swig wallet | Try a fork on day 1. Deploy the vault on mainnet, move $10 of NVDAc in and out, run one keeper swap | Deploy on testnet, then mainnet with $10: transfer in, swap, withdraw. Check the feed list on docs.chain.link |

If the Solana price test fails, Solana auto-follow runs in US hours against the share-price feed, or falls back to one-tap.

## 6. What changes in the MVP list

- **Item 1 (sign-in, vault).** The vault is our contract, one per basket per chain, owned by the user's wallet. Add in-kind withdraw.
- **Item 2 (indexes).** Indexes hold assets only. A multi-chain index is a set of per-chain recipes under one name. Rebalancing never moves value between chains.
- **Item 3 (personal basket).** May reference community indexes, one level. The flatten step is shared by all chains, about a day.
- **Item 6 (rebalance).** Solana shows progress per leg.
- **Item 7 (publish and follow).** Versions carry an effective time. The prompt stays the default. Add the auto-follow switch per basket, gated per chain.
- **New.** A platform asset list with liquidity floors, a US geofence (nothing onchain enforces it), and an "unaudited, capped" notice.
- **Moves up.** "Automatic rebalancing under limits you signed" enters the MVP, on chains that pass their tests and only on a new index version.

Should wait: creator fees, index of indexes, any pool or share token, drift-triggered keeper trades, netting and auctions, session keys and EIP-7702, off-hours stock trading, auto-follow for tokens with no price feed (159 on Robinhood Chain), anything cross-chain.

## 7. Open questions for the team

1. Is auto-follow worth two unaudited contracts holding user money in 11 days? If it stays post-MVP, as the brief had it, the vault can be a plain Swig sub-account or smart account and the build is much lighter. This memo assumes yes.
2. Deposit cap per vault during the hackathon.
3. Who is named as keeper operator, and which countries the live app serves.
4. Length of the publish-to-trade delay, and how to demo it given stock legs only trade in US hours.
5. New asset in a followed index: fresh tap (recommended), or pre-approve the platform list once.
6. Creator limits: weight change per version, versions per day, follower capacity.
7. Robinhood Chain: limit indexes to the 36 tokens with feeds, or allow the rest as one-tap only.
8. Who holds the upgrade keys for the vault code.
9. Who signs up for the Pyth key and a paid RPC endpoint.
