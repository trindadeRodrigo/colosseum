# The author limits, as test vectors

`vectors.json` is the one list of cases for the four limits on a shared portfolio (`docs/vault/DESIGN-VAULT.md`, section 6). The TypeScript check (`checkCreatorLimits` in `packages/basket`), the Solana program and the EVM registry are each tested against this file, so the three cannot drift apart. Change a rule here first, then in the three places.

Integers and strings only: no floats, no booleans, no nulls. A yes or no is `1` or `0`.

Cases keep their place: a new case goes at the end, so `cases[38]` stays the case it was. The first 71 are the first issue of this file; 72 onward were added after its review.

## The rules

| # | Reason | Refused when |
|---|---|---|
| 1 | `FeeNotZero` | `maxFeeBps` is not 0 |
| 2 | `FlagsNotZero` | `flags` is not 0 |
| 3 | `TooFewAssets` | the list has fewer than 3 entries |
| 4 | `TooManyAssets` | the list has more than 12 entries |
| 5 | `AssetNotListed` | an asset is not on the platform list |
| 6 | `DuplicateAsset` | an asset appears more than once |
| 7 | `WeightBelowMin` | a weight is under 200 bps |
| 8 | `WeightOffStep` | a weight is not a multiple of 50 bps |
| 9 | `WeightAboveCeiling` | a weight is over `min(5000, the asset's ceiling)` |
| 10 | `WeightSum` | the weights do not add up to exactly 10,000 |
| 11 | `VersionPending` | a version is published and not yet in effect |
| 12 | `VersionTooSoon` | `now < lastPublishAt + publishDelay` |
| 13 | `TurnoverTooHigh` | the absolute weight changes against the previous version add up to more than 4,000 |
| 14 | `CashNotAllowed` | the chain's cash token is a component |

- **Every version** is held to rules 3 to 10 and 14, whether a weight changed or not: a weight left as it was is still checked against today's ceiling.
- **The first version** takes effect at once (`effectiveAt = now`) and is exempt from rules 11 to 13: there is nothing before it to wait for or to be measured against.
- **One delay, not two.** `publishDelay` is both the notice a follower gets (a later version takes effect at `now + publishDelay`) and the least time between two versions (rule 12). There is no separate interval.
- **Turnover without division.** Add up `|next − prev|` over every asset in either version; an asset that is added counts from 0 and one that is removed counts to 0. The limit is on that sum: at most 4,000, which is twice `limits.maxTurnoverBps`. The figure reported, `turnoverBps`, is half of it; both versions add up to 10,000, so the sum is even.
- **The previous version** is the one in effect at `now`. A version that was waiting and whose time has come (`now >= its effectiveAt`) is in effect, with no transaction, and is what the next one is measured against. The `matured` cases fail an implementation that still measures against the version before it.
- A version is on time when `now >= lastPublishAt + publishDelay`. `lastPublishAt` is the time of the last publish, whether or not that version was later cancelled: a cancel does not give the slot back.
- Rules 1 and 2 are checked where the call takes those two values, which is the first publish. Every case that sets them has no previous version.
- The order of the entries carries no meaning. A chain that wants its list sorted sorts it after mapping the names.
- The numbers are in `limits`. The delay is per case, in `ctx.publishDelay`.

## The file

- `platform.assets[i]` has the ceiling `platform.ceilingsBps[i]`: this is the platform list for every case. The names are placeholders; map each to an address or a mint of your own. `platform.unlisted` names what must not be on the list.
- `platform.cash` names the chain's cash token. Map it to the cash token your deployment is configured with. It is on the list with a ceiling of 5,000, so the only thing against it is that it is cash; an implementation whose asset list can never hold the cash token refuses the same cases as `AssetNotListed`.
- `count` is the number of cases, for a language that cannot ask an array for its length.

Each case:

| Field | Meaning |
|---|---|
| `name`, `group` | What the case shows |
| `scenario` | How a chain reaches this state. See below |
| `prev` | The version in effect at `now`. `exists` is 0 when there is none. `assets[i]` has the weight `weightsBps[i]`; `n` is how many |
| `next` | The version proposed, in the same form, with `flags` and `maxFeeBps` |
| `older` | In a `matured` case, the version that was in effect before `prev`. `exists` is 0 elsewhere |
| `waiting` | In a `pending` case, the version that is waiting; in a `cancelled` case, the one that was cancelled. `exists` is 0 elsewhere |
| `ctx` | `now` and `lastPublishAt` in unix seconds (`lastPublishAt` is 0 with no previous version), `publishDelay` in seconds, `hasPending` 1 or 0 |
| `expect.ok` | 1 accepted, 0 refused |
| `expect.error` | The error the chain returns: `CreatorLimit`, or empty when accepted |
| `expect.reason`, `expect.reasonId` | The lowest-numbered rule the version breaks, by name and by number; empty and 0 when accepted |
| `expect.breaks` | Every rule the version breaks, lowest first. Most cases break one |
| `expect.turnoverBps` | When accepted: the turnover, 0 for a first version |
| `expect.effectiveAt` | When accepted: `now` for a first version, `now + publishDelay` after it |

`scenario` is for a test that drives a real program or contract and has to build the state first. A test of a pure function ignores it, and ignores `older` and `waiting`.

| Scenario | The state |
|---|---|
| `first` | Nothing published yet |
| `next` | `prev` is in effect and was published at `lastPublishAt`; nothing is pending. Version 1 takes effect at once, so publish `prev` as version 1 |
| `pending` | `prev` is in effect; `waiting` was published at `lastPublishAt` and has not taken effect at `now` |
| `pending_delay_lowered` | As `pending`, and the delay was lowered after `waiting` was published, so the interval has passed while it still waits |
| `cancelled` | `prev` is in effect; `waiting` was published at `lastPublishAt` and then cancelled |
| `matured` | `older` was in effect; `prev` was published at `lastPublishAt`, waited, and is in effect at `now`. Publish `older` as version 1 one delay before `lastPublishAt`, then `prev` at `lastPublishAt` |
| `next_ceiling_lowered` | As `next`, and `prev` holds an asset over the ceiling `platform` gives it: publish `prev` with that ceiling at 5,000, then set the ceiling to the one in `platform` |

## What a test asserts

- Every implementation: `expect.ok`, and `expect.error` when refused.
- When accepted: `expect.turnoverBps` and `expect.effectiveAt`, where the implementation reports them.
- An implementation that says which rule was broken reports `expect.reason` (or `expect.reasonId`). If it checks the rules in another order, assert that its reason is one of `expect.breaks`.

TypeScript: `packages/basket/src/creator-limits.vectors.test.ts`, and through the mock registry in `packages/chain-mock/src/limits.test.ts`.

## The meta hash

A shared portfolio's name and copy stay off-chain. The registry stores their hash, so anyone can check the text against the chain. `meta-hash.json` has worked cases: the fields (`meta`), the exact text that is hashed (`canonical`), that text's bytes in hex (`utf8Hex`) and the hash (`sha256`).

`metaHash` covers five fields: `familyId`, `slug`, `name`, `copy` and `kind`. It does not cover the chains a portfolio is on, so publishing on one more chain later does not change it. It is the SHA-256 of this text:

1. Each of the five values is a string, normalised to Unicode NFC, so a letter typed with a combining mark and the same letter typed as one character give one hash.
2. One JSON object with exactly these members, in this order: `copy`, `familyId`, `kind`, `name`, `slug`.
3. No whitespace outside the strings.
4. Strings as `JSON.stringify` writes them (RFC 8785, 3.2.2.2): `"` and `\` take a backslash; U+0008, U+0009, U+000A, U+000C and U+000D are `\b`, `\t`, `\n`, `\f`, `\r`; any other character under U+0020 is `\u00xx` in lower-case hex; everything else, `/`, U+007F, U+2028 and non-ASCII included, is written as itself.
5. UTF-8, no byte-order mark.
6. The hash is 64 lower-case hex characters with no prefix. Onchain it is the same 32 bytes in the same order.

A value that is missing or is not a string is refused, and so is half of a surrogate pair.

In `meta-hash.json` itself, a character an editor would not show (U+007F, a combining mark, U+2028, U+2029) is written as a JSON escape. That is how the file spells it; the text it stands for, and `utf8Hex`, have the character itself.

A program or a contract stores the 32 bytes and never builds the text. Its test takes `utf8Hex` as bytes and checks that SHA-256 of them is `sha256` (`sha256(bytes)` in Solidity, `hash::hash(&bytes)` in Rust). TypeScript builds the text: `metaHash` in `packages/basket`, tested in `packages/basket/src/meta-hash.test.ts`. In Python the same text is `json.dumps(fields, sort_keys=True, separators=(',', ':'), ensure_ascii=False)` over the five values after `unicodedata.normalize('NFC', value)`.
