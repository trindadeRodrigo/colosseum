# The author limits, as test vectors

`vectors.json` is the one list of cases for the four limits on a shared portfolio (`docs/vault/DESIGN-VAULT.md`, section 6). The TypeScript check (`checkCreatorLimits` in `packages/basket`), the Solana program and the EVM registry are each tested against this file, so the three cannot drift apart. Change a rule here first, then in the three places.

Integers and strings only: no floats, no booleans, no nulls. A yes or no is `1` or `0`.

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
| 13 | `TurnoverTooHigh` | turnover against the previous version is over 2,000 bps |

- Rules 1 to 10 apply to every version. Rules 11 to 13 need a previous version, so the first version is exempt from them.
- Rules 1 and 2 are checked where the call takes those two values, which is the first publish. Every case that sets them has no previous version.
- Turnover is the sum of `|next − prev|` over every asset in either version, divided by 2. An asset that is added counts from 0 and one that is removed counts to 0. Both versions add up to 10,000, so the sum is even and the division is exact.
- A version is on time when `now >= lastPublishAt + publishDelay`. `lastPublishAt` is the time of the last publish, whether or not that version was later cancelled: a cancel does not give the slot back.
- The order of the entries carries no meaning. A chain that wants its list sorted sorts it after mapping the names.
- The numbers are in `limits`. The delay is per case, in `ctx.publishDelay`.

## The file

- `platform.assets[i]` has the ceiling `platform.ceilingsBps[i]`: this is the platform list for every case. The names are placeholders; map each to an address or a mint of your own. `platform.unlisted` names what must not be on the list.
- `count` is the number of cases, for a language that cannot ask an array for its length.

Each case:

| Field | Meaning |
|---|---|
| `name`, `group` | What the case shows |
| `scenario` | How a chain reaches this state. See below |
| `prev` | The version in effect. `exists` is 0 when there is none. `assets[i]` has the weight `weightsBps[i]`; `n` is how many |
| `next` | The version proposed, in the same form, with `flags` and `maxFeeBps` |
| `ctx` | `now` and `lastPublishAt` in unix seconds (`lastPublishAt` is 0 with no previous version), `publishDelay` in seconds, `hasPending` 1 or 0 |
| `expect.ok` | 1 accepted, 0 refused |
| `expect.error` | The error the chain returns: `CreatorLimit`, or empty when accepted |
| `expect.reason`, `expect.reasonId` | The lowest-numbered rule the version breaks, by name and by number; empty and 0 when accepted |
| `expect.breaks` | Every rule the version breaks, lowest first. Most cases break one |
| `expect.turnoverBps` | When accepted: the turnover, 0 for a first version |
| `expect.effectiveAt` | When accepted: `now` for a first version, `now + publishDelay` after it |

`scenario` is for a test that drives a real program or contract and has to build the state first. A test of a pure function ignores it.

| Scenario | The state |
|---|---|
| `first` | Nothing published yet |
| `next` | `prev` is in effect and was published at `lastPublishAt`; nothing is pending. Version 1 takes effect at once, so publish `prev` as version 1 |
| `pending` | `prev` is in effect; another version was published at `lastPublishAt` and is still waiting at `now` |
| `pending_delay_lowered` | As `pending`, and the delay was lowered after that version was published, so the interval has passed while it still waits |
| `cancelled` | `prev` is in effect; another version was published at `lastPublishAt` and then cancelled |

## What a test asserts

- Every implementation: `expect.ok`, and `expect.error` when refused.
- When accepted: `expect.turnoverBps` and `expect.effectiveAt`, where the implementation reports them.
- An implementation that says which rule was broken reports `expect.reason` (or `expect.reasonId`). If it checks the rules in another order, assert that its reason is one of `expect.breaks`.

TypeScript: `packages/basket/src/creator-limits.vectors.test.ts`.
