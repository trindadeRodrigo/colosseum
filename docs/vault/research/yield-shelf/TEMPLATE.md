# TEMPLATE: a yield-shelf research note, one per chain

Copy this file to `<chain>.md` and fill it. It is the format of `solana.md` and `robinhood.md`, in the house style of `../portfolio-method.md`: plain sentences, numbered sources, each dated, and what could not be verified said plainly. The note is the source of the chain's rows in `packages/engine/src/personal/fixtures/shelves/<chain>-yield.json`, of their leg types in `leg-types.ts` and of their yields in `fixtures/yields-extended.json`. A fact the note could not verify stays marked unverified, and the fixture row says so (`unverified`).

The first line of the note gives the date, the brief (`docs/vault/PROMPT-YIELD-SHELF.md`), who decided the list (Rodrigo, 2026-10-06), the inputs (`inputs/`) and how the research ran.

Tags: `[n]` checked that day against source n. `[ns]` only a search-result snippet of source n was seen. `[rpc]` read on chain that day. `[api]` read from a public API that day, named. `[sheet]` only the input spreadsheet says it; not verified. `[repo]` read in the code. `[own]` our reasoning, not from a source. Issuer and protocol names appear because the note is internal; what a person reads names the token only.

## 1. Bottom line

The list in one table, then three to six sentences: what is added, what waits for a person, what is out.

| Token | Issuer | Leg types | Tier | Verdict | The filter that decides |
|---|---|---|---|---|---|

## 2. The filters

1. A vault can hold it: no allowlist and no KYC on a transfer to a program or contract address.
2. It is a dollar asset, or, for the Etherfuse bonds, a local-currency bond.
3. It can be sold at a person's size. Depth is read from public, read-only sources. A thin market is not a reason to leave a token out; it is said, and the tier reflects it.
4. Live: not wound down, defunct or exploit-linked.
5. Low or medium risk: levered, algorithmic and junior tranches are out.

The tier is the launch shelf's rule, on the measured price impact of a sale into the chain's dollar token: A, $50,000 at 35 bps or less; B, $10,000 at 35 bps or less; C, about $1,000 to $2,000 at 30 bps or less, and anything thinner, said. It is a fallback: Bearing's measured exit replaces it at the rollout (gate `EXIT-SOURCE`).

## 3. The tokens

One section per candidate, the lines in this order.

### SYMBOL (issuer)

- **Verdict:** add / add with caution / hold / out, and the filter that decides.
- **Issuer and backing:** who issues it and what pays the yield.
- **Mechanism and leg types:** how the yield reaches the holder; which of `rate`, `credit`, `basis`, `market_deposit` it carries, or that it fits none.
- **Address:** the mint or contract, decimals, token program or standard.
- **Transfer restrictions:** freeze authority, allowlist, transfer hook, pause, blacklist; whether a program or contract can hold it.
- **Redemption:** the path, who may use it, the delay.
- **Geo-blocks:** the countries the issuer's terms exclude; they become `blockedCountries`.
- **Depth:** the price impact of selling $1,000, $10,000 and $50,000, the route, the time read.
- **Tier:** A, B or C, from the depth.
- **Yield:** the dated figure the fixture carries and its source; how it can be read live, for the rollout.
- **Incidents:** exploits, depegs, pauses, defaults; or none found.
- **Not verified:** each fact the row carries unverified.

## 4. Out, and why

One line per token left out, with the filter.

## 5. For Rodrigo

Each item that needs a person, with the options, a recommendation and the trade-offs: a verdict the filters do not settle, a token that fits no leg type, an engine change.

## 6. What could not be verified

## 7. Rollout (b)

Not done here. Per token added, what is left and who does it: the mint or contract, decimals and token program checked on mainnet; a live yield source with its method; Bearing's exit measurement (the collectors are not edited before Oct 12, so the tier fallback stands until then, labelled); the vault's on-chain asset list (a deploy: a person's word, Thom's); the production registry row; a `/decide` entry under gate `UNIVERSE` for the final list.

## 8. Sources

`[n] Author or site, "Title", URL, the page's date if it gives one, read YYYY-MM-DD.`
