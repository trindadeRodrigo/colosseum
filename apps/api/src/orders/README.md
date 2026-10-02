# Orders: what this folder does, and what it does not do yet

The order layer behind `/v1/orders` (DESIGN-VAULT 3.3). It plans the legs of an order, builds one unsigned transaction per leg, and settles a leg when the chain says its transaction landed. It holds no key and signs nothing. Today it runs on `packages/chain-mock` only.

| File | What it holds |
|---|---|
| `prepare.ts` | `prepareIntent`: a buy of a stored plan becomes legs. The policy numbers (`ORDER_POLICY`) |
| `legs.ts` | Build, report, cancel, and the read that tracks sent legs again |
| `store.ts` | The tables, through Drizzle. Every writer locks the leg row first, then its attempts |
| `chains.ts` | The adapter registry by chain mode, and `TxProbe` |
| `view.ts` | Value, weight and drift, until `view()` exists in `packages/basket` |
| `errors.ts` | A refusal and its body; a chain's refusal mapped onto the order codes |

## The rules a leg follows

- A leg is not built again while the transaction built before can still land. On Solana that is until the chain is past the attempt's `validUntil`. On an EVM chain nothing expires, so the attempt stays open until it is reported or the person cancels it (`POST .../cancel`).
- A report, by id or by signed bytes, is matched against every attempt of the leg. The leg settles on the attempt that landed, whatever that attempt was labelled.
- An attempt that the chain has confirmed or reverted is never rewritten. Anything else (`built`, `sent`, `expired`) can still be corrected by what the chain says.
- Signed bytes are relayed once, and only for an attempt that is `built`.
- The first transaction the chain has seen keeps an open order open for 24 hours. A transaction that is only claimed does not, and nothing reopens an order that expired.

## Local workarounds, to move into the shared packages

Marked `WORKAROUND` in the code. They leave with the slot that changes `packages/schemas`.

- `TxProbe` in `chains.ts`: relay, "does this transaction carry this message", and the fate of an unreported attempt. `ChainAdapter` has none of the three.
- `mockTxId` in `chains.ts`: a copy of the mock's id function, which `chain-mock` does not export.
- The response shapes `OrderDetail`, `PortfolioResponse` and `RefusalBody`, defined in `routes/v1/` and here.
- `retryable` and the chain's code travel in `details`, because `OrderError` has no field for them.
- `Leg.expected` is null for a leg with several trades.
- `ORDER_POLICY.slippageBps` and `ORDER_POLICY.maxAmountUsd` are server constants, because `IntentRequest` carries neither.

## Before a real chain

None of this is built. Each item is a way to lose money or trust once a chain is `live`.

1. **Idempotency keys on order creation.** Two identical buys sent at once make two orders, and both can settle. `POST /v1/orders` has to take a key and answer the second request with the first order (`idempotency_keys` exists).
2. **The EVM nonce rule.** A cancelled or failed EVM attempt can still be sent by the wallet that signed it. The next attempt must be built with the same nonce, so only one of them can land. `leg_attempts.nonce` is there for it and is not written today. Until then a cancel on an EVM chain is only as good as the wallet's word.
3. **Relay and "carries" through the real adapters.** `TxProbe` is filled by the mock alone. A real adapter has to hash signed bytes back to the message it built, broadcast them, and fetch a reported transaction and match signer, target and call data to the attempt (on Solana, our instruction's accounts and data).
4. **Finding a landing nobody reported.** The mock can be asked about an attempt by its message, because its transaction ids are derived from it. A real chain cannot: on Solana the adapter has to search the vault's signatures, on EVM compare the account's nonce. Without it, a transaction that landed and was never reported is found only when its id arrives.
5. **`users` and `user_wallets`.** Nothing writes them. `orders.user_id` is null, and an order is tied to wallets only.
6. **Rate limits on `/v1`.** None. The design asks for 60 a minute anonymous, 120 signed in, 30 on the builders.
7. **Any signed-in person can buy any stored plan by its id.** `proposals.user_id` is not checked. Ids are random, and a plan holds no secret, but a plan should belong to someone before real money follows it.
8. **The legacy server-signing route.** `routes/monitor.ts` still loads a keypair and is registered whatever `LEGACY_STRUCTURER` says. It goes behind the flag in API-2. Until then the API must not be hosted with a key file present.
9. **One real Privy identity token, read by a person.** The field names this code expects in `linked_accounts` (`type`, `address`, `chain_type`, `wallet_client_type`) and the `sid` claim of the access token come from Privy's documentation, not from a token. Decode one of each from the real app before sign-in is trusted.
10. **The consent route, the service key for the MCP server, and keyless order creation for agents** (design section 10).
