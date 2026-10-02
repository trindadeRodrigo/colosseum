# The Solana adapter for vaults: read side

`import { createSolanaVaultReader } from '@colosseum/chain-solana/vault'`. The root entry does not re-export it.

It takes a `ChainConfig`, an RPC client the caller makes, and the asset list. It reads no environment and holds no key. The program id (`contracts.program`) and the price account come from the config; the cash mint, the price owner and the default keeper come from the program's own Config account. The builders are ADS-2.

## What other slots must know

**Vaults**

- `getVaults` is all or nothing. A vault with a target on a mint that is not in the asset list makes it refuse with `MintNotAccepted`, for that owner's whole list. So the API never drops an asset from the list: it flags it.
- A vault with a non-zero `recipe` or a non-zero `loss_accum` refuses with `NotSupported`. SOL-2 (the registry) and SOL-3 (the keeper leg) teach the reader those two fields in the same pull request that makes the program write them, or every vault that has them stops reading.
- Balances are the associated token account for (holder, mint, the mint's token program) and nothing else. `Position.tracked` is never read. A listed token a vault holds with no target on it is a position with `targetBps: 0`. A token that is not listed is not seen.
- A frozen token account's balance is reported as held: it is still the holder's and a vault's value includes it. `funding` does not count frozen cash, because it cannot be deposited.

**Prices**

- A stale price is returned, with its age and with `market: 'open'` if the session is open. The caller compares `ageSeconds` with `Config.max_price_age_s` (`getConfig()`).
- A price stamped ahead of the cluster's clock by more than `Config.max_price_age_s` is refused with `AssetNotPriced`. Inside that bound it is clock skew and reads as zero seconds old.
- Cash has no price unless the list gives it a Scope index. An asset with `priceKind: 'none'` gets no entry in the answer.
- One bad entry refuses the whole call, and the message names the asset and the index. Ask per asset where a partial answer is wanted.
- `BasketAsset.priceRef` for `scope` is the entry's index, `"0"` to `"511"`, in the one price account of the config.

**Transaction status**

- `track` can answer `Custom:<n>` first and the program's own error name later: the name needs the transaction's logs, which the node may not have yet. A first answer for a reverted transaction is not final.
- `processed` is pending. Expired means the finalized block height is past `validUntil` and the status was asked for again after that.
- Behind a pool of nodes the status and the height can come from two of them. Expired is only as sure as the status node is close to the tip: `send.ts` (ADS-2) should track on the node it sent through.

**Gas**

- `funding` charges every leg a fee and the rent of one token account, plus the vault's rent for a new vault and the wallet's own rent floor. `FundingNeed` cannot say which legs open an account, so it is a bound, not a quote. No priority fee is counted yet.

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
- `SOLANA_LOCAL_VALIDATOR=1 pnpm exec vitest run tests/solana-vault/local-validator.test.ts`: the same read cases on a local validator, with real transactions.
