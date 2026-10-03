# Orders: what this folder does, and what it does not do yet

The order layer behind `/v1/orders` (DESIGN-VAULT 3.3). It plans the legs of an order, builds one unsigned transaction per leg, and settles a leg when the chain says its transaction landed. It holds no key and signs nothing. Today it runs on `packages/chain-mock` only.

| File | What it holds |
|---|---|
| `prepare.ts` | `prepareIntent`: a buy of a stored plan becomes legs. The policy numbers (`ORDER_POLICY`) |
| `legs.ts` | Build, report, cancel, and the read that tracks sent legs again |
| `store.ts` | The tables, through Drizzle. Every writer locks the leg row first, then its attempts |
| `chains.ts` | The adapter registry by chain mode |
| `errors.ts` | A refusal (its body is the shared `OrderError`); a chain's refusal mapped onto the order codes |

## The rules a leg follows

- A leg is not built again while the transaction built before can still land. On Solana that is until the chain is past the attempt's `validUntil`. On an EVM chain nothing expires, so the attempt stays open until it is reported or the person cancels it (`POST .../cancel`).
- A report, by id or by signed bytes, is matched against every attempt of the leg. The leg settles on the attempt that landed, whatever that attempt was labelled.
- An attempt that the chain has confirmed or reverted is never rewritten. Anything else (`built`, `sent`, `expired`) can still be corrected by what the chain says.
- Signed bytes are relayed once, and only for an attempt that is `built`.
- The first transaction the chain has seen keeps an open order open for 24 hours. A transaction that is only claimed does not, and nothing reopens an order that expired.

## What moved into the shared packages

The local workarounds of API-1 are gone (FRAME-1b). The response shapes (`OrderDetail`, `PortfolioResponse`, `OrderError` with the chain's code and `retryable` in `details`) and the four adapter calls behind a report are in `packages/schemas`. `Leg.expected` has one figure per trade. The amount ceiling and the slippage cap are `ORDER_LIMITS`, held by the request's schema; `ORDER_POLICY.slippageBps` is only the figure a buy gets when it names none.

## Before a real chain

None of this is built. Each item is a way to lose money or trust once a chain is `live`.

1. **Idempotency keys on order creation.** Two identical buys sent at once make two orders, and both can settle. `POST /v1/orders` has to take a key and answer the second request with the first order (`idempotency_keys` exists).
2. **The EVM nonce: what is wired and what is not.** Wired: the nonce a build states is stored on the attempt (`leg_attempts.nonce`), handed to `fate`, and given to the rebuild of a step whose earlier attempt can still land, so only one of the two can. Not wired, for API-2:
   - The nonce of record. An outside wallet may sign with another nonce than the build stated. `adapter.nonceOf` reads it from signed bytes or from a seen transaction, and nothing calls it yet: the attempt keeps the stated nonce.
   - Two open orders of one wallet on one EVM chain. Each build states the signer's next nonce, so the first step of both is built on the same one, and only one can land. If the two steps are the same call they are the same transaction, and the second report is refused as already recorded. A build has to see the other order's open attempt and either wait for it or state the nonce after it.
   - A failed attempt's rebuild takes a fresh nonce (the revert used the old one). A dropped one that was never cancelled blocks the step until it is reported or cancelled, as before.
3. **Relay and "carries" through the real adapters.** The four calls are part of `ChainAdapter` now (`TxProbe`: `messageHashOf`, `relay`, `carries`, `fate`), and the mock is the only adapter that has them. A real adapter has to hash signed bytes back to the message it built, broadcast them, and fetch a reported transaction and match signer, target and call data to the attempt (on Solana, our instruction's accounts and data). The contract's "signed bytes" cases hold it to that.
4. **Finding a landing nobody reported.** The mock can be asked about an attempt by its message, because its transaction ids are derived from it. A real chain cannot: on Solana the adapter has to search the signer's signatures, on EVM compare the account's nonce. `fate` is handed the signer and the nonce for that. Without it, a transaction that landed and was never reported is found only when its id arrives.
5. **Two EVM attempts at one leg can share a message hash.** On EVM the hash is of the call alone, so a leg built twice with nothing changed (an approval, a deposit) gives the same hash both times, and after a cancel the same nonce too: the two attempts are one transaction. The mock does the same. A report then matches the first attempt with that hash, which is right for the leg and wrong for the attempt it names: choosing among attempts that share a hash is not done.
6. **`users` and `user_wallets`.** Nothing writes them. `orders.user_id` is null, and an order is tied to wallets only.
7. **Rate limits on `/v1`.** None. The design asks for 60 a minute anonymous, 120 signed in, 30 on the builders.
8. **Any signed-in person can buy any stored plan by its id.** `proposals.user_id` is not checked. Ids are random, and a plan holds no secret, but a plan should belong to someone before real money follows it.
9. **The legacy server-signing route.** `routes/monitor.ts` still loads a keypair and is registered whatever `LEGACY_STRUCTURER` says. It goes behind the flag in API-2. Until then the API must not be hosted with a key file present.
10. **One real Privy identity token, read by a person.** The field names this code expects in `linked_accounts` (`type`, `address`, `chain_type`, `wallet_client_type`) and the `sid` claim of the access token come from Privy's documentation, not from a token. Decode one of each from the real app before sign-in is trusted.
11. **The consent route, the service key for the MCP server, and keyless order creation for agents** (design section 10).
