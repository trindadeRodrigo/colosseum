# The Solana adapter for vaults: read side

`import { createSolanaVaultReader } from '@colosseum/chain-solana/vault'`. The root entry does not re-export it.

It takes a `ChainConfig`, an RPC client the caller makes, and the asset list. It reads no environment and holds no key. The program id (`contracts.program`) and the price account come from the config; the cash mint, the price owner and the default keeper come from the program's own Config account. The builders are ADS-2.

It decodes the program's four accounts: Config, Vault, the asset list (`getAssetList`) and a shared portfolio (`getRecipe`). The asset list on chain holds mints, ceilings and price entries; the ids, classes and sheets of the assets still come from the caller's list, matched by mint.

## What other slots must know

**Vaults**

- `getVaults` is all or nothing. A vault with a target on a mint that is not in the asset list makes it refuse with `MintNotAccepted`, for that owner's whole list. So the API never drops an asset from the list: it flags it.
- A vault with a non-zero `loss_accum` refuses with `NotSupported`. SOL-3 (the keeper leg) teaches the reader that field in the same pull request that makes the program write it, or every vault that has it stops reading.
- A vault that follows a shared portfolio reports it in `recipeOnchainId` (the Recipe account's address) with the version it took in `acceptedVersion`. `pending` is what it has not applied: the version in effect if the vault took an earlier one, or else the version that waits, with `newAssets` naming the assets the vault has no target on. The recipe is read in the same call as the balances.
- A vault whose `recipe` is not a shared portfolio of this program refuses with `Unknown`: the program never writes one.
- Balances are the associated token account for (holder, mint, the mint's token program) and nothing else. `Position.tracked` is never read. A listed token a vault holds with no target on it is a position with `targetBps: 0`. A token that is not listed is not seen.
- A frozen token account's balance is reported as held: it is still the holder's and a vault's value includes it. `funding` does not count frozen cash, because it cannot be deposited.
- A holding of a mint whose issuer has scheduled a multiplier carries `scheduled { multiplier, effectiveAt }` until the cluster's clock reaches that time. From then on it is the multiplier in force and nothing is scheduled.

**Shared portfolios**

- `getRecipe(address)` answers the version in effect and the one that waits, by the cluster's clock: a version whose time has come is the active one with no transaction, as it is for the program (`versionsAt`). The account's `current` and `pending` fields alone do not say which is in effect.
- Anything that is not a Recipe account of this program is `RecipeNotFound`. A line on a mint the caller's list does not have is `MintNotAccepted`, and a vault that follows that portfolio refuses with it.
- A version number names one set of weights for good: a cancelled version keeps its number, so the version that waits can be the active one plus two.
- `onchainId` is the Recipe account's address: seeds `["recipe", creator, family id]` (`recipeAddress`). `familyId` and `metaHash` are 64 lower-case hex characters.
- `listAutoFollowVaults(recipe)` filters on the vault's `recipe` at byte 40.

**Prices**

- A stale price is returned, with its age and with `market: 'open'` if the session is open. Every price carries `maxAgeSeconds`, which is `Config.max_price_age_s` from the same read: `isStalePrice(price)` says whether the keeper would refuse it.
- A price stamped ahead of the cluster's clock by more than `Config.max_price_age_s` is refused with `AssetNotPriced`. Inside that bound it is clock skew and reads as zero seconds old.
- Cash has no price unless the list gives it a Scope index. An asset with `priceKind: 'none'` gets no entry in the answer.
- One bad entry refuses the whole call, and the message names the asset and the index. Ask per asset where a partial answer is wanted.
- `BasketAsset.priceRef` for `scope` is the entry's index, `"0"` to `"511"`, in the one price account of the config.

**Transaction status**

- `track` can answer `Custom:<n>` first and the program's own error name later: the name needs the transaction's logs, which the node may not have yet. A first answer for a reverted transaction is not final.
- `processed` is pending. Expired means the finalized block height is past `validUntil` and the status was asked for again after that.
- Behind a pool of nodes the status and the height can come from two of them. Expired is only as sure as the status node is close to the tip: `send.ts` (ADS-2) should track on the node it sent through.

**Gas**

- `funding` charges every leg a fee, plus the vault's rent for a new vault and the wallet's own rent floor. Token accounts: where the caller says how many the legs open (`FundingNeed.newAccounts`: the vault's cash account when the vault is new, and one per asset bought for the first time), that many are charged; where it does not, one per leg, which is a bound and not a quote. No priority fee is counted yet.

## The market rule the reader assumes (for SOL-3 to match)

A stock token is open when all of these hold, on the cluster's clock:

- Monday to Friday, UTC.
- `session_open_utc_s <= second of the day < session_close_utc_s`. A session whose close is not after its open (one that wraps past midnight) is never open.
- The day is not in `closed_days`. A zero there is an empty slot.
- `clock >= closed_until`: open at exactly `closed_until`.

## What TNET-4's price account must look like

- Owned by the program in `Config.price_owner`. Exactly 28,712 bytes.
- Entry `i` at byte `40 + 56·i`: value u64, exponent u64, slot u64, unix time u64, then 24 bytes the reader ignores. Price is value / 10^exponent, USD for one whole token. Exponent at most 30, value and time above zero.
- The time is the source's, in unix seconds, so a copied price ages as the real one does.
- The first 40 bytes are not checked on a test network yet (`// TNET-4:` in `reader.ts`). On mainnet the first eight must be Scope's discriminator. Start the test account with the same eight bytes (`SCOPE_PRICES_DISCRIMINATOR`) and the check can be turned on everywhere.
- Mainnet's indexes, read on Oct 2: SPYx 344, QQQx 347, NVDAx 332, TSLAx 338, USDC 13. Keeping them lets one asset list serve both networks.
- Test stock mints carry the scaled-UI-amount extension; decimals equal the asset list's.

## Tests

- `tests/solana-vault/`: against `fixtures/solana-vault/world.json`, account bytes the built program wrote in LiteSVM. `pnpm --dir programs/tests fixtures` rewrites it.
- The reader passes the adapter contract's own `reads` group (`adapterContract(name, setup, { groups: ['reads'] })` in `tests/solana-vault/reads.ts`), on the fixture and on a local validator. The groups left are `shared portfolios` (needs the registry, SOL-2), `quotes` and everything that builds (SOL-2, ADS-2): add each to the list as the chain gets it.
- `SOLANA_LOCAL_VALIDATOR=1 pnpm exec vitest run tests/solana-vault/local-validator.test.ts`: the same read cases on a local validator, with real transactions.
